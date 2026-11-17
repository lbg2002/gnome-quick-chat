import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

import {registerGiMocks} from './helpers/giMockLoader.js';

registerGiMocks();

const {TurnController} = await import('../core/turnController.js');
const {SessionStore} = await import('../core/sessionStore.js');
const {OpenAIAdapter, readSoupResponseBytesBoundedAsync} = await import('../backends/openaiAdapter.js');
const {ZCodeAdapter} = await import('../backends/zcodeAdapter.js');
const {CodexAdapter} = await import('../backends/codexAdapter.js');
const {spawnManagedCliTurn} = await import('../runtime/processManager.js');
const {buildAskUserModifiedInput} = await import('../protocol.js');
const {
    buildFakeCodexCliScriptSource,
    buildFakeZCodeCliScriptSource,
    buildMockOpenAiDualOriginServerScriptSource,
} = await import('./fixtures/productionAdapterFixtures.js');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        if (stat.includes(') Z ')) return false;
        return true;
    } catch (_) {
        return false;
    }
}

async function waitForEvent(events, predicate, timeoutMs = 5000) {
    const stepMs = 15;
    const maxSteps = Math.ceil(timeoutMs / stepMs);
    for (let i = 0; i < maxSteps; i++) {
        const match = events.find(predicate);
        if (match) return match;
        await sleep(stepMs);
    }
    throw new Error(`Timed out waiting for event (${timeoutMs}ms)`);
}

test('R10.1: Shared dual-origin mock HTTP server + real OpenAIAdapter production path (SSE stream, finish_reason=length, truncated EOF, HTTP 400 diagnostic, cross-origin 307 redirect, cancel, /models cap)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-r10-http-'));
    const statsFile = path.join(tmpDir, 'http_stats.json');
    const serverScript = path.join(tmpDir, 'mock_openai_server.cjs');
    fs.writeFileSync(
        serverScript,
        buildMockOpenAiDualOriginServerScriptSource({statsFile}),
        {mode: 0o755}
    );

    const serverChild = spawn(process.execPath, [serverScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
        const readyLine = await new Promise((resolve, reject) => {
            let buf = '';
            const timer = setTimeout(() => reject(new Error('Timed out waiting for dual-origin server READY')), 4000);
            serverChild.stdout.on('data', chunk => {
                buf += chunk.toString('utf8');
                const nl = buf.indexOf('\n');
                if (nl >= 0) {
                    clearTimeout(timer);
                    resolve(buf.slice(0, nl).trim());
                }
            });
            serverChild.on('error', err => {
                clearTimeout(timer);
                reject(err);
            });
        });

        assert.ok(readyLine.startsWith('READY:'), `Unexpected server ready line: ${readyLine}`);
        const [, portAStr] = readyLine.split(':');
        const originABase = `http://127.0.0.1:${portAStr}/v1`;

        const store = new SessionStore('r10_openai_sess', {sessionsRootDir: tmpDir});
        await store.load('openai', {openaiModel: 'o3-mini'});

        const events = [];
        const turns = new TurnController(ev => events.push(ev));
        const adapter = new OpenAIAdapter({
            turns,
            store,
            emitEvent: ev => events.push(ev),
        });
        adapter.initialize({
            baseUrl: originABase,
            chatUrl: `${originABase}/chat/completions`,
            modelsUrl: `${originABase}/models`,
            apiKey: 'sk-r10-secret-token',
            modelId: 'o3-mini',
            resolvedModel: 'o3-mini',
        }, {
            openaiBaseUrl: originABase,
            openaiApiKey: 'sk-r10-secret-token',
            openaiModel: 'o3-mini',
            thinkingLevel: 'high',
        });

        // 1. Model refresh
        const cat = await adapter.getModels();
        assert.deepEqual(cat.models, ['gpt-4o-mini', 'o3-mini']);
        assert.equal(cat.selectedModel, 'o3-mini');

        // 2. Normal SSE streaming
        events.length = 0;
        await adapter.sendMessage({text: '[SCENARIO:STREAM_NORMAL] 测试流式问答'});
        const settledOk = await waitForEvent(events, e => e.type === 'agent_settled');
        assert.equal(settledOk.status, 'completed');
        assert.equal(settledOk.usage?.total_tokens, 23);

        // 3. finish_reason=length -> partial: true
        events.length = 0;
        await adapter.sendMessage({text: '[SCENARIO:FINISH_LENGTH] 测试长度截断'});
        const settledLen = await waitForEvent(events, e => e.type === 'agent_settled');
        assert.equal(settledLen.status, 'completed');
        assert.equal(settledLen.finishReason, 'length');
        assert.equal(settledLen.partial, true);

        // 4. Truncated EOF without [DONE] -> interrupted
        events.length = 0;
        await adapter.sendMessage({text: '[SCENARIO:TRUNCATED_EOF] 测试断流'});
        const settledTrunc = await waitForEvent(events, e => e.type === 'agent_settled');
        assert.equal(settledTrunc.status, 'interrupted');
        assert.equal(settledTrunc.interrupted, true);

        // 5. HTTP 400 capability error -> explicit diagnostic, no auto-retry
        events.length = 0;
        await adapter.sendMessage({text: '[SCENARIO:HTTP_400_CAPABILITY] 测试参数不兼容'});
        const settled400 = await waitForEvent(events, e => e.type === 'agent_settled');
        assert.equal(settled400.status, 'failed');
        assert.match(settled400.errorMessage, /诊断：当前兼容接口或模型不支持 reasoning_effort/);

        // 6. Cross-origin 307 POST redirect -> blocked before Origin B receives request
        events.length = 0;
        await adapter.sendMessage({text: '[SCENARIO:REDIRECT_307] 测试跨源 POST 重定向拦截'});
        const settledRedir = await waitForEvent(events, e => e.type === 'agent_settled');
        assert.equal(settledRedir.status, 'failed');
        assert.match(settledRedir.errorMessage, /拒绝跨源重定向转发聊天请求/);

        // 7. In-flight turn cancellation
        events.length = 0;
        await adapter.sendMessage({text: '[SCENARIO:SLOW_CANCEL] 测试流取消'});
        await waitForEvent(events, e => e.type === 'message_update');
        const cancelRes = await adapter.cancel();
        assert.equal(cancelRes.aborted, true);
        const settledCancel = await waitForEvent(events, e => e.type === 'agent_settled');
        assert.equal(settledCancel.status, 'cancelled');

        // 8. Oversized chunked /models aborted mid-stream
        const Soup = globalThis.__qcMockSoup;
        const soupSess = new Soup.Session();
        const oversizedMsg = Soup.Message.new('GET', `${originABase}/models-oversized`);
        await assert.rejects(
            () => readSoupResponseBytesBoundedAsync(soupSess, oversizedMsg, {maxBytes: 32 * 1024}),
            /响应体积超过上限/
        );

        // 9. Cross-origin GET /models redirect strips Authorization
        adapter.updateEndpoint({
            baseUrl: originABase,
            chatUrl: `${originABase}/chat/completions`,
            modelsUrl: `${originABase}/models-redirect`,
            apiKey: 'sk-r10-secret-token',
        });
        const redirModels = await adapter.getModels();
        assert.deepEqual(redirModels.models, ['origin-b-redirected-model']);

        const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
        const postToOriginB = stats.originBRequests.filter(r => r.method === 'POST');
        assert.equal(postToOriginB.length, 0, 'Origin B must receive ZERO redirected POST requests');
        const getToOriginB = stats.originBRequests.find(r => r.method === 'GET' && r.url === '/v1/models');
        assert.ok(getToOriginB, 'Origin B must receive redirected GET /models');
        assert.equal(getToOriginB.hasAuthorization, false, 'Authorization must be stripped on cross-origin GET redirect');

        adapter.dispose();
    } finally {
        try { serverChild.kill('SIGTERM'); } catch (_) {}
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});

test('R10.2: Shared fake ZCode CLI + real spawnManagedCliTurn + ZCodeAdapter + zcodeBridge.cjs (parallel tools, modify answer, delayed ACK, scope auto-approve, stubborn process tree cleanup)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-r10-zcode-'));
    const bridgePath = path.resolve('zcodeBridge.cjs');

    try {
        // Part A: Full protocol + interactive question + approval ACK + parallel tools
        const fakeZcodeScript = path.join(tmpDir, 'fake_zcode_cli.cjs');
        fs.writeFileSync(fakeZcodeScript, buildFakeZCodeCliScriptSource(), {mode: 0o755});

        const events = [];
        const approvedScopes = new Set();
        const turns = new TurnController(ev => events.push(ev));
        const adapter = new ZCodeAdapter({
            turns,
            store: null,
            approvedScopes,
            getSessionContextConfig: () => ({}),
            emitEvent: ev => events.push(ev),
        });
        const turn = turns.beginTurn({
            turnId: 'r10_zcode_turn_1',
            messageId: 'r10_zcode_msg_1',
            sessionId: 'r10_zcode_sess_1',
            clientGeneration: 1,
            lifecycleGeneration: 1,
            backend: 'zcode',
            cancellable: new globalThis.__qcMockGio.Cancellable(),
        });

        spawnManagedCliTurn({
            backend: 'zcode',
            runtime: {
                executable: process.execPath,
                bridgePath,
                pathEnv: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
                extraEnv: {
                    NODE_OPTIONS: `--require ${bridgePath}`,
                    QUICK_CHAT_FORCE_BRIDGE: '1',
                },
            },
            config: {mode: 'readonly'},
            workspace: tmpDir,
            sessionId: 'r10_zcode_sess_1',
            specialDirs: {home: tmpDir, config: tmpDir, data: tmpDir, cache: tmpDir, runtime: tmpDir, tmp: tmpDir},
            turns,
            turn,
            store: null,
            approvedScopes,
            getSessionContextConfig: () => ({}),
            isDisposedFn: () => false,
            rawArgv: [process.execPath, fakeZcodeScript],
            keepStdinOpenForApproval: true,
            requireBridgeHandshake: true,
            effectiveMode: 'readonly',
        });

        const qReq = await waitForEvent(events, e => e.type === 'permission_request' && e.requestId === 'req_r10_q_1');
        const modInput = buildAskUserModifiedInput(qReq.rawInput, {
            '请选择目标环境': {selectedLabels: ['GNOME 50', 'Wayland'], customText: 'Ubuntu 26'},
        });
        const qResp = await adapter.respondPermission({
            turnId: 'r10_zcode_turn_1',
            requestId: 'req_r10_q_1',
            decision: 'modify',
            modifiedInput: modInput,
        });
        assert.equal(qResp.sent, true);
        await qResp.ackPromise;

        const webReq = await waitForEvent(events, e => e.type === 'permission_request' && e.requestId === 'req_r10_web_1');
        const wResp = await adapter.respondPermission({
            turnId: 'r10_zcode_turn_1',
            requestId: 'req_r10_web_1',
            decision: 'allow',
            alwaysAllow: true,
            allowSessionRule: true,
            scopeKey: webReq.scopeKey,
        });
        assert.equal(wResp.sent, true);
        await wResp.ackPromise;
        assert.equal(approvedScopes.has(webReq.scopeKey), true);

        const settled = await waitForEvent(events, e => e.type === 'agent_settled');
        assert.equal(settled.status, 'completed');
        const resultObj = JSON.parse(turn.text);
        assert.equal(resultObj.questionDecision, 'modify');
        assert.match(String(resultObj.questionAnswers?.['请选择目标环境'] || ''), /GNOME 50/);
        assert.match(String(resultObj.questionAnswers?.['请选择目标环境'] || ''), /Ubuntu 26/);
        assert.equal(resultObj.web1Decision, 'allow');
        assert.equal(resultObj.web2Decision, 'allow');

        // Verify both parallel tools reached 'done' state
        assert.equal(turn.toolExecutions.get('call_r10_read_1')?.status, 'done');
        assert.equal(turn.toolExecutions.get('call_r10_grep_2')?.status, 'done');

        // Part B: Stubborn child ignoring SIGTERM is cleaned up when turn is cancelled
        const stubbornPidFile = path.join(tmpDir, 'stubborn_child.pid');
        const fakeZcodeTreeScript = path.join(tmpDir, 'fake_zcode_tree.cjs');
        fs.writeFileSync(
            fakeZcodeTreeScript,
            buildFakeZCodeCliScriptSource({stubbornChildPidFile: stubbornPidFile, holdOpenAfterToolsMs: 4000}),
            {mode: 0o755}
        );

        const treeEvents = [];
        const treeTurns = new TurnController(ev => treeEvents.push(ev));
        const treeAdapter = new ZCodeAdapter({
            turns: treeTurns,
            store: null,
            approvedScopes: new Set(),
            getSessionContextConfig: () => ({}),
            emitEvent: ev => treeEvents.push(ev),
        });
        const treeTurn = treeTurns.beginTurn({
            turnId: 'r10_zcode_turn_tree',
            messageId: 'r10_zcode_msg_tree',
            sessionId: 'r10_zcode_sess_tree',
            clientGeneration: 2,
            lifecycleGeneration: 1,
            backend: 'zcode',
            cancellable: new globalThis.__qcMockGio.Cancellable(),
        });
        treeTurn.killGraceMs = 80;

        spawnManagedCliTurn({
            backend: 'zcode',
            runtime: {
                executable: process.execPath,
                bridgePath,
                pathEnv: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
                extraEnv: {
                    NODE_OPTIONS: `--require ${bridgePath}`,
                    QUICK_CHAT_FORCE_BRIDGE: '1',
                },
            },
            config: {mode: 'readonly'},
            workspace: tmpDir,
            sessionId: 'r10_zcode_sess_tree',
            specialDirs: {home: tmpDir, config: tmpDir, data: tmpDir, cache: tmpDir, runtime: tmpDir, tmp: tmpDir},
            turns: treeTurns,
            turn: treeTurn,
            store: null,
            getSessionContextConfig: () => ({}),
            isDisposedFn: () => false,
            rawArgv: [process.execPath, fakeZcodeTreeScript],
            keepStdinOpenForApproval: true,
            requireBridgeHandshake: true,
            effectiveMode: 'readonly',
        });

        await waitForEvent(treeEvents, e => e.type === 'tool_execution_end' && e.toolCallId === 'call_r10_grep_2');
        for (let i = 0; i < 30 && !fs.existsSync(stubbornPidFile); i++) {
            await sleep(20);
        }
        const stubbornPid = Number(fs.readFileSync(stubbornPidFile, 'utf8').trim());
        assert.equal(isPidAlive(stubbornPid), true);

        await treeAdapter.cancel('r10_zcode_turn_tree');
        for (let i = 0; i < 50 && isPidAlive(stubbornPid); i++) {
            await sleep(30);
        }
        assert.equal(isPidAlive(stubbornPid), false, 'Stubborn child process ignoring SIGTERM must be killed on turn cancel');
    } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});

test('R10.3: Shared fake Codex CLI + real CodexAdapter + spawnManagedCliTurn (stdin prompt, parallel command_execution items, remoteSessionId sync, and non-zero exit handling)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-r10-codex-'));
    try {
        const fakeCodexOk = path.join(tmpDir, 'fake_codex_ok.cjs');
        fs.writeFileSync(fakeCodexOk, buildFakeCodexCliScriptSource({exitCode: 0}), {mode: 0o755});

        const store = new SessionStore('r10_codex_sess', {sessionsRootDir: tmpDir});
        await store.load('codex', {});

        const events = [];
        const turns = new TurnController(ev => events.push(ev));
        const adapter = new CodexAdapter({
            turns,
            store,
            getSessionContextConfig: () => ({}),
            emitEvent: ev => events.push(ev),
        });
        adapter.initialize({
            executable: fakeCodexOk,
            pathEnv: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
            cliCapabilities: {
                supportsExecJson: true,
                supportsStdinPrompt: true,
                supportsSandboxReadOnly: true,
            },
        }, {mode: 'readonly'});

        await adapter.sendMessage({
            promptText: '检查 Codex 生产路径',
            turnMeta: {turnId: 'r10_codex_turn_1', messageId: 'r10_codex_msg_1', userMessageId: 'r10_codex_u_1'},
            workspace: tmpDir,
            sessionId: 'r10_codex_sess',
            specialDirs: {home: tmpDir},
        });

        const settledOk = await waitForEvent(events, e => e.type === 'agent_settled');
        assert.equal(settledOk.status, 'completed');
        assert.equal(store.remoteSessionId, 'codex_thread_r10_prod');
        assert.ok(store.remoteSyncedRevision > 0, 'remoteSyncedRevision must advance after Codex turn completes');

        // Non-zero exit status must invalidate remoteSessionId and settle as failed/interrupted
        const fakeCodexFail = path.join(tmpDir, 'fake_codex_fail.cjs');
        fs.writeFileSync(fakeCodexFail, buildFakeCodexCliScriptSource({exitCode: 2}), {mode: 0o755});
        adapter.initialize({
            executable: fakeCodexFail,
            pathEnv: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
            cliCapabilities: {
                supportsExecJson: true,
                supportsStdinPrompt: true,
                supportsSandboxReadOnly: true,
            },
        }, {mode: 'readonly'});

        events.length = 0;
        await adapter.sendMessage({
            promptText: '测试 Codex 异常退出码',
            turnMeta: {turnId: 'r10_codex_turn_2', messageId: 'r10_codex_msg_2', userMessageId: 'r10_codex_u_2'},
            workspace: tmpDir,
            sessionId: 'r10_codex_sess',
            specialDirs: {home: tmpDir},
        });
        const settledFail = await waitForEvent(events, e => e.type === 'agent_settled');
        assert.equal(settledFail.status, 'failed');
        assert.equal(store.remoteSessionId, '', 'Abnormal CLI exit must invalidate remoteSessionId');

        adapter.dispose();
    } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});
