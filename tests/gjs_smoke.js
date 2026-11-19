// Real GJS Headless Production-Path Integration & Smoke Suite (executed via `gjs -m tests/gjs_smoke.js` in CI).
// Validates:
// 1. All GI-backed (`gi://GLib`, `gi://Gio`, `gi://Soup?version=3.0`) and pure-JS modules load and execute inside SpiderMonkey/GJS.
// 2. Real `OpenAIAdapter` + `Soup.Session` against dual-origin localhost HTTP servers (`Origin A` & `Origin B`):
//    SSE streaming, `finish_reason=length` partial, truncated EOF `interrupted`, HTTP 400 capability diagnostic,
//    cross-origin 307 POST redirect blocking, cross-origin GET `/models` credential stripping, `/models` byte cap, and cancellation.
// 3. Real `ZCodeAdapter` + `spawnManagedCliTurn` + `zcodeBridge.cjs` over OS pipes:
//    parallel tools, interactive `AskUserQuestion` with `decision='modify'` custom/multi-select answers,
//    authoritative bridge `permission_resolved` ACK + session scope auto-approval, and process group cleanup.
// 4. Real `CodexAdapter` + `spawnManagedCliTurn` over OS pipes:
//    stdin prompt streaming, parallel `command_execution` items, `agent_message`, and `remoteSessionId` sync.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {BackendRegistry, MemorySettingsStore} from '../core/backendRegistry.js';
import {detectBackendSelection} from '../core/backendDetect.js';
import {parseUrlPortable, evaluatePermissionPolicy} from '../core/permissionPolicy.js';
import {
    evaluateRedirectPolicy,
    inspectEndpointSecurity,
    normalizeEndpointKeyIdentity,
    shouldStripAuthOnRedirect,
} from '../core/secretPolicy.js';
import {buildRuntimeContextSignature, buildBudgetedContextMessages} from '../core/contextManager.js';
import {SessionStore} from '../core/sessionStore.js';
import {TurnController} from '../core/turnController.js';
import {writePrivateFileAsync, removeFileQuietly} from '../core/paths.js';
import {StreamingMarkdownParser} from '../core/markdownStreamParser.js';
import {HistoryWindowController, computeAdaptiveRenderDelayMs} from '../core/renderScheduler.js';
import {matchSlashCommands, applyQuickActionToDraft} from '../core/quickActions.js';
import {AttachmentManager, extractCopiedFilePaths} from '../core/attachmentManager.js';
import {BackgroundNotificationGate, resolveNotificationClickTarget} from '../core/notificationPolicy.js';
import {recommendRouteLocally} from '../core/modelRouter.js';
import {formatRedactedDiagnosticsText} from '../core/diagnosticsReport.js';
import {OpenAISseParser} from '../runtime/sseParser.js';
import {BaseBackendAdapter} from '../backends/baseAdapter.js';
import {OpenAIAdapter, readSoupResponseBytesBoundedAsync} from '../backends/openaiAdapter.js';
import {ZCodeAdapter} from '../backends/zcodeAdapter.js';
import {CodexAdapter} from '../backends/codexAdapter.js';
import {DshAdapter} from '../backends/dshAdapter.js';
import {spawnManagedCliTurn} from '../runtime/processManager.js';
import {BackendClient} from '../backendClient.js';
import {ChatController} from '../core/chatController.js';
import {getInstalledExtensionMode} from '../runtime/releaseUpdater.js';
import {detectBackendSelectionAsync} from '../core/backendDetect.js';
import {buildAskUserModifiedInput, getBackendCapabilities} from '../protocol.js';
import {
    buildFakeCodexCliScriptSource,
    buildFakeZCodeCliScriptSource,
    buildMockOpenAiDualOriginServerScriptSource,
} from './fixtures/productionAdapterFixtures.js';

// Verify the exact GJS checksum API used to validate downloaded release ZIPs.
const updaterHash = GLib.compute_checksum_for_data(
    GLib.ChecksumType.SHA256, new TextEncoder().encode('abc')
);
if (updaterHash !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') {
    throw new Error('GJS release SHA-256 checksum function mismatch');
}
if (!['user', 'system', 'mixed', 'unknown'].includes(getInstalledExtensionMode())) {
    throw new Error('Release installer mode detection returned an unexpected value');
}
const Encoder = new TextEncoder();
const Decoder = new TextDecoder('utf-8');

function assert(cond, msg) {
    if (!cond) {
        throw new Error(`GJS smoke assertion failed: ${msg}`);
    }
}

function sleepGjs(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, ms), () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

async function waitForEventGjs(events, predicate, timeoutMs = 6000) {
    const stepMs = 20;
    const maxSteps = Math.ceil(timeoutMs / stepMs);
    for (let i = 0; i < maxSteps; i++) {
        const match = events.find(predicate);
        if (match) return match;
        await sleepGjs(stepMs);
    }
    throw new Error(`Timed out waiting for event in GJS (${timeoutMs}ms)`);
}

function writeExecutableScriptSync(filePath, content) {
    const file = Gio.File.new_for_path(filePath);
    file.replace_contents(
        Encoder.encode(content),
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );
    const chmodProc = Gio.Subprocess.new(['chmod', '0755', filePath], Gio.SubprocessFlags.NONE);
    chmodProc.wait(null);
}

// 1. BackendRegistry + Gio/GLib detectBackendSelection
const settings = new MemorySettingsStore({
    backend: 'openai',
    'openai-base-url': 'https://api.example.com/v1',
});
const registry = new BackendRegistry(settings);
const sel = detectBackendSelection({
    configuredBackend: registry.getConfiguredBackend(),
    openaiBaseUrl: 'https://api.example.com/v1',
});
assert(sel.effectiveBackend === 'openai', 'Expected openai effectiveBackend');

// 2. Portable URL parsing, endpoint security, redirect guard & permission policy inside SpiderMonkey
const parsedUrl = parseUrlPortable('https://api.example.com:443/v1/chat/completions?foo=bar');
assert(parsedUrl.hostname === 'api.example.com' && parsedUrl.port === '', 'Default port 443 normalization');
assert(normalizeEndpointKeyIdentity('https://api.example.com/v1/models') === 'https://api.example.com', 'Endpoint key normalization');
assert(inspectEndpointSecurity('http://203.0.113.10:8080/v1').isRemotePlaintextHttp === true, 'Remote HTTP warning');
assert(shouldStripAuthOnRedirect('https://api.example.com/v1', 'https://evil.example.net/v1') === true, 'Cross-origin redirect strip');
assert(
    evaluateRedirectPolicy('https://api.example.com/v1/chat/completions', 'https://evil.example.net/v1/chat/completions', {
        method: 'POST',
        status: 307,
    }).allowed === false,
    'Cross-origin POST redirect blocked by default'
);
assert(buildRuntimeContextSignature('openai', {openaiBaseUrl: 'https://api.example.com/v1', openaiModel: 'gpt-4o'}).includes('api.example.com'), 'Context signature');
assert(
    evaluatePermissionPolicy({
        toolName: 'Bash',
        input: {command: 'ls -la'},
        cwd: '/tmp',
        sessionId: 's1',
    }).allowSessionRule === false,
    'Conservative Bash default'
);

// 3. Streaming Markdown + OpenAI SSE + Context budgeting + BaseBackendAdapter
const md = new StreamingMarkdownParser();
assert(md.update('# 标题\n\n```js\nconst x = 1;\n```\n', {finalize: true}).blocks.length === 2, 'Streaming Markdown blocks');

const sse = new OpenAISseParser();
const rawSseBytes = Encoder.encode('data: {"choices":[{"delta":{"content":"你好🚀"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
const sseEvents = [
    ...sse.pushBytes(rawSseBytes.subarray(0, 41)),
    ...sse.pushBytes(rawSseBytes.subarray(41)),
];
const sseFinal = sse.finish();
assert(sseEvents.some(e => e.type === 'delta' && e.textDelta === '你好🚀') && sseFinal.completedCleanly, 'SSE split UTF-8 delta');
assert(getBackendCapabilities('codex', 'readonly').supportsApproval === false, 'Codex capability honesty');
assert(typeof BaseBackendAdapter === 'function' && typeof computeAdaptiveRenderDelayMs === 'function', 'Adapter & scheduler helpers');
// Unanswered prior user prompts must not be replayed: a retry may carry side effects.
assert(buildBudgetedContextMessages([{role: 'user', content: 'hi'}], {currentPrompt: 'next'}).length === 0, 'Unanswered prior context is excluded');
const completedContext = buildBudgetedContextMessages([
    {role: 'user', content: 'hi'},
    {role: 'assistant', content: 'hello'},
], {currentPrompt: 'next'});
assert(completedContext.length === 2 && completedContext[0].content === 'hi' && completedContext[1].content === 'hello', 'Complete prior turn is preserved');

// 4. Stage F modules (`/` commands, Nautilus file URI attachments, notifications, router, diagnostics)
const slash = matchSlashCommands('/translate Hello');
assert(slash.active && slash.matches[0].command === '/translate', 'Slash match');
assert(applyQuickActionToDraft(slash.matches[0], '/translate Hello').autoSend === false, 'No auto-send');

const paths = extractCopiedFilePaths('copy\nfile:///tmp/demo%20file.txt');
assert(paths.length === 1 && paths[0] === '/tmp/demo file.txt', 'Nautilus URI parse in GJS');
const att = new AttachmentManager();
assert(att.addTextSnippet('clipboard text').ok === true, 'Attachment snippet');
assert(att.buildOutboundScopeNotice('openai', {endpointUrl: 'https://api.example.com/v1'}).includes('api.example.com'), 'Outbound scope host');

const gate = new BackgroundNotificationGate();
assert(gate.evaluate({kind: 'turn_completed', isLocked: true}).shouldNotify === false, 'Lock-screen suppression');
assert(resolveNotificationClickTarget({sessionId: 's1'}, {isLocked: true}).action === 'ignore', 'Locked click guard');

const route = recommendRouteLocally({
    promptText: '读取 ./README.md 文件',
    currentBackend: 'openai',
    availableBackends: ['zcode', 'openai'],
    profiles: {zcode: {mode: 'full'}},
});
assert(route && route.targetBackend === 'zcode' && route.targetMode === 'readonly', 'Router clamps full mode');
assert(!formatRedactedDiagnosticsText({lastConnectionError: 'Bearer sk-1234567890abcdefghijklmnop'}).includes('sk-1234567890'), 'Diagnostics redaction');

// 5. Real Gio async SessionStore + Real OpenAIAdapter (Soup 3.0) + Real ZCodeAdapter/CodexAdapter (spawnManagedCliTurn)
const tmpRoot = GLib.dir_make_tmp('qc-gjs-smoke-XXXXXX');
const loop = new GLib.MainLoop(null, false);
let asyncError = null;
let mockHttpProc = null;

(async () => {
    try {
        // 5A. Real Gio async SessionStore write + reload + unix mode 0600/0700
        const store = new SessionStore('gjs_smoke_sess', {sessionsRootDir: tmpRoot});
        await store.load('openai', {openaiModel: 'gpt-4o'});
        await store.appendMessage({id: 'u1', role: 'user', content: 'GJS 异步持久化测试'}, 'openai', {openaiModel: 'gpt-4o'});
        await store.appendMessage({id: 'a1', role: 'assistant', content: '持久化正常', replyTo: 'u1'}, 'openai', {openaiModel: 'gpt-4o'});
        await store.flush();
        assert(!store.lastWriteError, `SessionStore write error: ${store.lastWriteError}`);

        const reloaded = new SessionStore('gjs_smoke_sess', {sessionsRootDir: tmpRoot});
        await reloaded.load('openai', {openaiModel: 'gpt-4o'});
        assert(reloaded.messages.length === 2, 'Reloaded 2 messages via Gio');
        const fullLogical = await reloaded.loadFullLogicalHistory({includeRewound: false});
        assert(fullLogical.messages.length === 2, 'loadFullLogicalHistory via Gio');

        const hw = new HistoryWindowController();
        hw.reset(reloaded.messages, {externalArchivedCount: reloaded.archivedMessageCount});
        assert(hw.allMessages.length === 2, 'HistoryWindowController reset');

        const privFile = GLib.build_filenamev([tmpRoot, 'priv_secret_test.json']);
        await writePrivateFileAsync(privFile, Encoder.encode('{"ok":true}\n'));
        const privInfo = Gio.File.new_for_path(privFile).query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        assert((privInfo.get_attribute_uint32('unix::mode') & 0o777) === 0o600, 'Private file mode 0600');
        removeFileQuietly(privFile);

        const sessDir = Gio.File.new_for_path(GLib.build_filenamev([tmpRoot, 'gjs_smoke_sess']));
        const dirInfo = sessDir.query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        assert((dirInfo.get_attribute_uint32('unix::mode') & 0o777) === 0o700, 'Session directory mode 0700');

        // 5B. Real OpenAIAdapter + Soup 3.0 against dual-origin mock HTTP servers
        const nodeBin = GLib.find_program_in_path('node');
        assert(Boolean(nodeBin), 'node binary must be in PATH for R10 shared fixtures');

        const statsFile = GLib.build_filenamev([tmpRoot, 'http_stats.json']);
        const httpServerScript = GLib.build_filenamev([tmpRoot, 'mock_openai_server.cjs']);
        writeExecutableScriptSync(httpServerScript, buildMockOpenAiDualOriginServerScriptSource({statsFile}));

        mockHttpProc = Gio.Subprocess.new(
            [nodeBin, httpServerScript],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
        const serverStdout = new Gio.DataInputStream({base_stream: mockHttpProc.get_stdout_pipe()});
        const readyLine = await new Promise((resolve, reject) => {
            serverStdout.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, r) => {
                try {
                    const [line] = s.read_line_finish_utf8(r);
                    resolve(String(line || '').trim());
                } catch (err) {
                    reject(err);
                }
            });
        });
        assert(readyLine.startsWith('READY:'), `Expected READY:<portA>:<portB>, got ${readyLine}`);
        const [, portAStr] = readyLine.split(':');
        const originABase = `http://127.0.0.1:${portAStr}/v1`;

        const oaiEvents = [];
        const oaiTurns = new TurnController(ev => oaiEvents.push(ev));
        const oaiAdapter = new OpenAIAdapter({
            turns: oaiTurns,
            store,
            emitEvent: ev => oaiEvents.push(ev),
        });
        oaiAdapter.initialize({
            baseUrl: originABase,
            chatUrl: `${originABase}/chat/completions`,
            modelsUrl: `${originABase}/models`,
            apiKey: 'sk-gjs-soup-secret',
            modelId: 'o3-mini',
            resolvedModel: 'o3-mini',
        }, {
            openaiBaseUrl: originABase,
            openaiApiKey: 'sk-gjs-soup-secret',
            openaiModel: 'o3-mini',
            thinkingLevel: 'high',
        });

        // Model refresh via Soup
        const modelsCatalog = await oaiAdapter.getModels();
        assert(modelsCatalog.models.includes('gpt-4o-mini') && modelsCatalog.models.includes('o3-mini'), 'GJS Soup /models refresh');
        assert(modelsCatalog.selectedModel === 'o3-mini', 'Manual user model preserved on /models refresh');

        // Normal SSE streaming + usage
        oaiEvents.length = 0;
        await oaiAdapter.sendMessage({text: '[SCENARIO:STREAM_NORMAL] 你好'});
        const settledNormal = await waitForEventGjs(oaiEvents, e => e.type === 'agent_settled');
        assert(settledNormal.status === 'completed', `Expected completed, got ${settledNormal.status}: ${settledNormal.errorMessage}`);
        assert(settledNormal.usage?.total_tokens === 23, 'SSE usage propagated in GJS');

        // finish_reason=length -> partial: true
        oaiEvents.length = 0;
        await oaiAdapter.sendMessage({text: '[SCENARIO:FINISH_LENGTH] 长回答'});
        const settledLen = await waitForEventGjs(oaiEvents, e => e.type === 'agent_settled');
        assert(settledLen.status === 'completed' && settledLen.partial === true && settledLen.finishReason === 'length', 'finish_reason=length marks partial:true in GJS');

        // Truncated EOF -> interrupted
        oaiEvents.length = 0;
        await oaiAdapter.sendMessage({text: '[SCENARIO:TRUNCATED_EOF] 截断测试'});
        const settledTrunc = await waitForEventGjs(oaiEvents, e => e.type === 'agent_settled');
        assert(settledTrunc.status === 'interrupted' && settledTrunc.interrupted === true, 'Truncated SSE stream marked interrupted in GJS');

        // HTTP 400 capability mismatch -> explicit diagnostic, no auto-retry
        oaiEvents.length = 0;
        await oaiAdapter.sendMessage({text: '[SCENARIO:HTTP_400_CAPABILITY] 不支持参数'});
        const settled400 = await waitForEventGjs(oaiEvents, e => e.type === 'agent_settled');
        assert(settled400.status === 'failed' && settled400.errorMessage.includes('reasoning_effort'), 'HTTP 400 capability diagnostic in GJS');

        // Cross-origin 307 POST redirect blocked before Origin B receives request
        oaiEvents.length = 0;
        await oaiAdapter.sendMessage({text: '[SCENARIO:REDIRECT_307] 敏感附件'});
        const settledRedir = await waitForEventGjs(oaiEvents, e => e.type === 'agent_settled');
        assert(settledRedir.status === 'failed' && settledRedir.errorMessage.includes('拒绝跨源重定向'), 'Cross-origin 307 POST redirect blocked in GJS');

        // In-flight cancellation
        oaiEvents.length = 0;
        await oaiAdapter.sendMessage({text: '[SCENARIO:SLOW_CANCEL] 慢速流取消'});
        await waitForEventGjs(oaiEvents, e => e.type === 'message_update');
        const cancelRes = await oaiAdapter.cancel();
        assert(cancelRes.aborted === true, 'OpenAIAdapter.cancel() aborts active turn in GJS');
        const settledCancel = await waitForEventGjs(oaiEvents, e => e.type === 'agent_settled');
        assert(settledCancel.status === 'cancelled', 'Cancelled turn settles as cancelled in GJS');

        // Oversized chunked /models stream aborted by readSoupResponseBytesBoundedAsync
        const soupSession = new Soup.Session();
        const oversizedMsg = Soup.Message.new('GET', `${originABase}/models-oversized`);
        let oversizedThrew = false;
        try {
            await readSoupResponseBytesBoundedAsync(soupSession, oversizedMsg, {maxBytes: 32 * 1024});
        } catch (err) {
            oversizedThrew = String(err.message || err).includes('超过上限');
        }
        assert(oversizedThrew, 'Oversized chunked /models aborted mid-stream in GJS');

        // Cross-origin GET /models redirect strips Authorization
        oaiAdapter.updateEndpoint({
            baseUrl: originABase,
            chatUrl: `${originABase}/chat/completions`,
            modelsUrl: `${originABase}/models-redirect`,
            apiKey: 'sk-gjs-soup-secret',
        });
        const redirModels = await oaiAdapter.getModels();
        assert(redirModels.models.includes('origin-b-redirected-model'), 'Cross-origin GET /models redirect followed in GJS');

        const [, statsBytes] = Gio.File.new_for_path(statsFile).load_contents(null);
        const parsedStats = JSON.parse(Decoder.decode(statsBytes));
        const postToOriginB = parsedStats.originBRequests.filter(r => r.method === 'POST');
        assert(postToOriginB.length === 0, 'Origin B must receive ZERO redirected POST requests in GJS');
        const getToOriginB = parsedStats.originBRequests.find(r => r.method === 'GET' && r.url === '/v1/models');
        assert(getToOriginB && getToOriginB.hasAuthorization === false, 'Origin B GET /models must have Authorization stripped in GJS');
        oaiAdapter.dispose();

        // 5C. Real ZCodeAdapter + spawnManagedCliTurn + zcodeBridge.cjs in GJS
        const repoRoot = GLib.get_current_dir();
        const bridgePath = GLib.build_filenamev([repoRoot, 'zcodeBridge.cjs']);
        const fakeZcodeScript = GLib.build_filenamev([tmpRoot, 'fake_zcode_cli.cjs']);
        writeExecutableScriptSync(fakeZcodeScript, buildFakeZCodeCliScriptSource());

        const zcodeEvents = [];
        const approvedScopes = new Set();
        const zcodeTurns = new TurnController(ev => zcodeEvents.push(ev));
        const zcodeAdapter = new ZCodeAdapter({
            turns: zcodeTurns,
            store: null,
            approvedScopes,
            getSessionContextConfig: () => ({}),
            emitEvent: ev => zcodeEvents.push(ev),
        });
        const zcodeTurn = zcodeTurns.beginTurn({
            turnId: 'gjs_zcode_turn_1',
            messageId: 'gjs_zcode_msg_1',
            sessionId: 'gjs_zcode_sess_1',
            clientGeneration: 1,
            lifecycleGeneration: 1,
            backend: 'zcode',
            cancellable: new Gio.Cancellable(),
        });

        spawnManagedCliTurn({
            backend: 'zcode',
            runtime: {
                executable: nodeBin,
                bridgePath,
                pathEnv: GLib.getenv('PATH') || '/usr/local/bin:/usr/bin:/bin',
                extraEnv: {
                    NODE_OPTIONS: `--require ${bridgePath}`,
                    QUICK_CHAT_FORCE_BRIDGE: '1',
                },
            },
            config: {mode: 'readonly'},
            workspace: tmpRoot,
            sessionId: 'gjs_zcode_sess_1',
            specialDirs: {home: tmpRoot, config: tmpRoot, data: tmpRoot, cache: tmpRoot, runtime: tmpRoot, tmp: tmpRoot},
            turns: zcodeTurns,
            turn: zcodeTurn,
            store: null,
            approvedScopes,
            getSessionContextConfig: () => ({}),
            isDisposedFn: () => false,
            rawArgv: [nodeBin, fakeZcodeScript],
            keepStdinOpenForApproval: true,
            requireBridgeHandshake: true,
            effectiveMode: 'readonly',
        });

        // Wait for interactive question request and answer with decision='modify'
        const qReq = await waitForEventGjs(zcodeEvents, e => e.type === 'permission_request' && e.requestId === 'req_r10_q_1');
        const modInput = buildAskUserModifiedInput(qReq.rawInput, {
            '请选择目标环境': {selectedLabels: ['GNOME 50', 'Wayland'], customText: 'Ubuntu 26'},
        });
        const qResp = await zcodeAdapter.respondPermission({
            turnId: 'gjs_zcode_turn_1',
            requestId: 'req_r10_q_1',
            decision: 'modify',
            modifiedInput: modInput,
        });
        assert(qResp.sent === true, 'ZCode question response sent in GJS');
        await qResp.ackPromise;

        // Wait for first WebFetch approval and approve with session scope
        const webReq = await waitForEventGjs(zcodeEvents, e => e.type === 'permission_request' && e.requestId === 'req_r10_web_1');
        const wResp = await zcodeAdapter.respondPermission({
            turnId: 'gjs_zcode_turn_1',
            requestId: 'req_r10_web_1',
            decision: 'allow',
            alwaysAllow: true,
            allowSessionRule: true,
            scopeKey: webReq.scopeKey,
        });
        assert(wResp.sent === true, 'ZCode WebFetch approval sent in GJS');
        await wResp.ackPromise;
        assert(approvedScopes.has(webReq.scopeKey), 'Session scope saved only after bridge ACK in GJS');

        const zcodeSettled = await waitForEventGjs(zcodeEvents, e => e.type === 'agent_settled');
        assert(zcodeSettled.status === 'completed', `ZCode turn failed in GJS: ${zcodeSettled.errorMessage}`);
        const zcodeResultObj = JSON.parse(zcodeTurn.text);
        assert(zcodeResultObj.questionDecision === 'modify', 'ZCode bridge received modify decision in GJS');
        assert(
            String(zcodeResultObj.questionAnswers?.['请选择目标环境'] || '').includes('GNOME 50') &&
            String(zcodeResultObj.questionAnswers?.['请选择目标环境'] || '').includes('Ubuntu 26'),
            'ZCode bridge preserved multi-select + custom answer in GJS'
        );
        assert(zcodeResultObj.web1Decision === 'allow' && zcodeResultObj.web2Decision === 'allow', 'Second WebFetch auto-approved in GJS');

        // 5D. Real CodexAdapter + spawnManagedCliTurn in GJS
        const fakeCodexScript = GLib.build_filenamev([tmpRoot, 'fake_codex_cli.cjs']);
        writeExecutableScriptSync(fakeCodexScript, buildFakeCodexCliScriptSource());
        const codexStore = new SessionStore('gjs_codex_sess', {sessionsRootDir: tmpRoot});
        await codexStore.load('codex', {});
        const codexEvents = [];
        const codexTurns = new TurnController(ev => codexEvents.push(ev));
        const codexAdapter = new CodexAdapter({
            turns: codexTurns,
            store: codexStore,
            getSessionContextConfig: () => ({}),
            emitEvent: ev => codexEvents.push(ev),
        });
        codexAdapter.initialize({
            executable: fakeCodexScript,
            pathEnv: GLib.getenv('PATH') || '/usr/local/bin:/usr/bin:/bin',
            cliCapabilities: {
                supportsExecJson: true,
                supportsStdinPrompt: true,
                supportsSandboxReadOnly: true,
            },
        }, {mode: 'readonly'});

        await codexAdapter.sendMessage({
            promptText: '测试 Codex 生产路径',
            turnMeta: {turnId: 'gjs_codex_turn_1', messageId: 'gjs_codex_msg_1', userMessageId: 'gjs_codex_u_1'},
            workspace: tmpRoot,
            sessionId: 'gjs_codex_sess',
            specialDirs: {home: tmpRoot},
        });
        const codexSettled = await waitForEventGjs(codexEvents, e => e.type === 'agent_settled');
        assert(codexSettled.status === 'completed', `Codex turn failed in GJS: ${codexSettled.errorMessage}`);
        assert(codexStore.remoteSessionId === 'codex_thread_r10_prod', 'Codex remoteSessionId persisted in GJS');
        
        // 5D2. Real DSH Headless JSONL → Gio.Subprocess → shared TurnController.
        const fakeDshScript = GLib.build_filenamev([tmpRoot, 'fake_dsh_cli.cjs']);
        writeExecutableScriptSync(fakeDshScript, [
            '#!/usr/bin/env node',
            "let prompt = '';",
            "process.stdin.setEncoding('utf8');",
            "process.stdin.on('data', chunk => { prompt += chunk; });",
            "process.stdin.on('end', () => {",
            "  console.log(JSON.stringify({type:'session',sessionId:'session-gjs-dsh'}));",
            "  console.log(JSON.stringify({type:'text',text:'DSH 接收:' + prompt.trim()}));",
            "  console.log(JSON.stringify({type:'final',reason:{kind:'completed'},sessionId:'session-gjs-dsh',text:'DSH 完成:' + prompt.trim()}));",
            "});",
        ].join('\n') + '\n');
        const dshEvents = [];
        const dshTurns = new TurnController(ev => dshEvents.push(ev));
        const dshAdapter = new DshAdapter({
            turns: dshTurns,
            store: null,
            getSessionContextConfig: () => ({}),
            emitEvent: ev => dshEvents.push(ev),
        });
        dshAdapter.initialize({
            executable: fakeDshScript,
            pathEnv: GLib.getenv('PATH') || '/usr/local/bin:/usr/bin:/bin',
            setsidPath: null,
        }, {mode:'readonly'});
        await dshAdapter.sendMessage({
            promptText:'测试 DSH',
            turnMeta:{turnId:'gjs_dsh_turn_1',messageId:'gjs_dsh_msg_1',userMessageId:'gjs_dsh_u_1'},
            workspace:tmpRoot,
            sessionId:'gjs_dsh_sess',
            specialDirs:{home:tmpRoot},
        });
        const dshSettled = await waitForEventGjs(dshEvents,e => e.type === 'agent_settled');
        assert(dshSettled.status === 'completed',
            `DSH headless turn failed in real GJS: ${dshSettled.errorMessage}`);
        assert(dshEvents.some(e => e.type === 'message_end' &&
            String(e.message?.content || '').includes('DSH 完成:测试 DSH')),
            'DSH official final event must replace interim text');

        // 5E. Full startup pipeline: detect CLI identity -> async capability probe ->
        // BackendClient.startAsync -> get_state/get_messages (not just direct adapters).
        // This previously had no coverage in the real GJS smoke suite.
        for (const kind of ['zcode', 'codex', 'dsh']) {
            const cliFile = GLib.build_filenamev([tmpRoot, kind]);
            const cliStub = [
                '#!/usr/bin/env node',
                kind === 'zcode' ? '// @zcode/cli startup fixture' : kind === 'dsh' ? '// DeepSeek Harness dsh startup fixture' : '// codex-cli startup fixture',
                "const args = process.argv.slice(2);",
                "if (args.includes('--version')) {",
                `  console.log('${kind === 'zcode' ? 'zcode 1.1.0' : kind === 'dsh' ? 'dsh v0.1.0' : 'codex-cli 0.42.0'}');`,
                '} else if (args.includes("--help")) {',
                `  console.log('${kind === 'zcode' ? 'zcode --output-format --prompt --cwd --mode --resume' : kind === 'dsh' ? 'dsh --profile headless --json --permission-mode --session-id' : 'codex exec --json --sandbox read-only --model'}');`,
                '}',
            ].join('\n') + '\n';
            writeExecutableScriptSync(cliFile, cliStub);

            const detected = await detectBackendSelectionAsync({
                configuredBackend: kind,
                zcodePath: kind === 'zcode' ? cliFile : '',
                codexPath: kind === 'codex' ? cliFile : '',
                dshPath: kind === 'dsh' ? cliFile : '',
            }, {forceRefresh: true});
            assert(detected.available && detected.effectiveBackend === kind, `Real GJS ${kind} CLI identity detection`);

            const startupClient = new BackendClient(() => {}, () => {});
            try {
                await startupClient.startAsync({
                    backend: kind,
                    zcodePath: kind === 'zcode' ? cliFile : '',
                    codexPath: kind === 'codex' ? cliFile : '',
                dshPath: kind === 'dsh' ? cliFile : '',
                    mode: 'readonly',
                    workspace: tmpRoot,
                }, tmpRoot, tmpRoot, `gjs_startup_${kind}`, {clientGeneration: 1});
                const state = await startupClient.request('get_state');
                const history = await startupClient.request('get_messages');
                assert(state.backend === kind && !state.unconfigured, `Real GJS ${kind} startup state`);
                assert(Array.isArray(history.messages), `Real GJS ${kind} startup session read`);
            } finally {
                startupClient.close();
            }

            // QA-01/02: unlike the legacy smoke check above, this runs through
            // the actual ChatController.ensureConnected orchestration path.
            // A plain JS cancellable triggers a GJS GI argument type error
            // when backendDetect passes it to Gio.File.read_async().
            const nativeCancellables = [];
            const controller = new ChatController({
                createCancellable: () => {
                    const c = new Gio.Cancellable();
                    nativeCancellables.push(c);
                    return c;
                },
                createClient: (onEvent, onError) => new BackendClient(onEvent, onError),
                loadRuntimeEnvironment: async ({cancellable}) => {
                    assert(cancellable instanceof Gio.Cancellable,
                        'ChatController must pass a native Gio.Cancellable into the real GJS connection');
                    return {
                        config: {
                            backend: kind,
                            zcodePath: kind === 'zcode' ? cliFile : '',
                            codexPath: kind === 'codex' ? cliFile : '',
                dshPath: kind === 'dsh' ? cliFile : '',
                            mode: 'readonly',
                            workspace: tmpRoot,
                        },
                        workspace: tmpRoot,
                        sessionsDir: tmpRoot,
                        sessionId: `gjs_controller_${kind}`,
                    };
                },
            });
            controller.beginLifecycle(300);
            try {
                const connected = await controller.ensureConnected({canConnect: () => true});
                assert(connected?.state?.backend === kind,
                    `Full ChatController → Gio → ${kind} runtime must connect successfully`);
                assert(nativeCancellables.length === 1,
                    `Each ${kind} connection must construct exactly one Gio.Cancellable`);
            } finally {
                controller.dispose();
            }
        }

    } catch (err) {
        asyncError = err;
    } finally {
        if (mockHttpProc) {
            try { mockHttpProc.force_exit(); } catch (_) {}
        }
        try {
            const rmProc = Gio.Subprocess.new(['rm', '-rf', tmpRoot], Gio.SubprocessFlags.NONE);
            rmProc.wait(null);
        } catch (_) {}
        loop.quit();
    }
})();

loop.run();
if (asyncError) {
    throw asyncError;
}
print('GJS headless production-path integration (Soup HTTP/SSE + ZCode Bridge + Codex CLI + Gio SessionStore) passed.');
