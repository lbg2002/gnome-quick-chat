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
import {MarkdownMemory} from '../core/markdownMemory.js';
import {SessionStore} from '../core/sessionStore.js';
import {TurnController} from '../core/turnController.js';
import {isDshWriteWorkspace, requireWorkspaceDirectory, writePrivateFileAsync, removeFileQuietly} from '../core/paths.js';
import {StreamingMarkdownParser} from '../core/markdownStreamParser.js';
import {HistoryWindowController, computeAdaptiveRenderDelayMs, formatMemoryReceipt} from '../core/renderScheduler.js';
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
import {IncrementalBoundedLineReader} from "../runtime/cliProcessRunner.js";
import {spawnManagedCliTurn} from '../runtime/processManager.js';
import {BackendClient} from '../backendClient.js';
import {ChatController} from '../core/chatController.js';
import {getInstalledExtensionMode} from '../runtime/releaseUpdater.js';
import {detectBackendSelectionAsync} from '../core/backendDetect.js';
import {buildAskUserModifiedInput, getBackendCapabilities} from '../protocol.js';
import {
    buildFakeCodexCliScriptSource,
    buildFakeZCodeCliScriptSource,
    buildMemoryCliScriptSource,
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
    // SDK JSON-RPC notifications span multiple reads in GJS. Its TextDecoder
    // lacks streaming mode, so verify splitting inside a UTF-8 code point.
    const reader = new IncrementalBoundedLineReader();
    const frame = new TextEncoder().encode('随问\n');
    assert(reader.pushChunk(frame.subarray(0, 2)).lines.length === 0, 'partial JSONL was emitted');
    assert(reader.pushChunk(frame.subarray(2)).lines[0] === '随问', 'chunk split corrupted UTF-8');

    try {
        assert(requireWorkspaceDirectory(tmpRoot) === tmpRoot, 'Existing workspace is preserved');
        const missingWorkspace = GLib.build_filenamev([tmpRoot, 'missing-workspace']);
        let workspaceError = '';
        try { requireWorkspaceDirectory(missingWorkspace); }
        catch (error) { workspaceError = error.message; }
        assert(workspaceError.includes('工作目录') && workspaceError.includes(missingWorkspace) &&
            !GLib.file_test(missingWorkspace, GLib.FileTest.EXISTS), 'Missing workspace reports path without creating it');

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
        
        // A real BackendClient uses independent OpenAI turns for recall and durable learning.
        const sharedMemory = new MarkdownMemory(tmpRoot, GLib.build_filenamev([tmpRoot, 'shared-memory']));
        const memoryRuntime = {backend: 'openai', baseUrl: originABase, chatUrl: originABase + '/chat/completions',
            modelsUrl: originABase + '/models', apiKey: 'sk-mock', modelId: 'gpt-4o-mini', resolvedModel: 'gpt-4o-mini'};
        const memoryConfig = {openaiModel: 'gpt-4o-mini', mode: 'chat'};
        const switchEvents = [];
        const switchClient = new BackendClient(event => switchEvents.push(event), () => {});
        try {
            switchClient._initWithRuntime({...memoryRuntime}, memoryConfig, tmpRoot, tmpRoot, 'switch-before');
            const adapter = switchClient.adapter;
            await switchClient.request('prompt', {message: '旧会话消息', turnId: 'switch-before-turn'});
            await waitForEventGjs(switchEvents, event => event.type === 'agent_settled' && event.turnId === 'switch-before-turn');
            assert((await switchClient.request('flush_session')).ok, 'Previous session is durable before switching');
            const oldStore = switchClient._store;
            switchClient._approvedScopes.add('old-scope');
            assert(switchClient.startNewSession('switch-after', () => {}) && switchClient.adapter === adapter &&
                !switchClient._approvedScopes.size, 'New session reuses the actual adapter and resets approvals');
            assert((await switchClient.request('get_messages')).messages.length === 0, 'New session starts empty');
            await switchClient.request('prompt', {message: '新会话消息', turnId: 'switch-after-turn'});
            await waitForEventGjs(switchEvents, event => event.type === 'agent_settled' && event.turnId === 'switch-after-turn');
            const newHistory = (await switchClient.request('get_messages')).messages;
            assert(newHistory.some(message => message.content === '新会话消息') &&
                !newHistory.some(message => message.content === '旧会话消息') &&
                !oldStore.messages.some(message => message.content === '新会话消息'), 'Adapter writes turns only to the selected session');
            assert((await switchClient.request('flush_session')).ok, 'New session is saved independently');
        } finally {
            switchClient.close();
        }
        const memoryWriterEvents = [];
        const memoryWriter = new BackendClient(event => memoryWriterEvents.push(event), () => {});
        const memoryReaderEvents = [];
        const memoryReader = new BackendClient(event => memoryReaderEvents.push(event), () => {});
        try {
            memoryWriter._initWithRuntime(memoryRuntime, memoryConfig, tmpRoot, tmpRoot, 'memory-writer');
            memoryWriter._memory = sharedMemory;
            await memoryWriter.request('prompt', {message: 'TEST_MEMORY_WRITE'});
            for (let i = 0; i < 200 && !memoryWriterEvents.some(event => event.type === 'memory_notice'); i++) {
                await sleepGjs(20);
            }
            assert((await sharedMemory.snapshot()).notes.has('memory://computer/preview.md'),
                'Model authored Markdown was written by the host');
            memoryReader._initWithRuntime({...memoryRuntime}, memoryConfig, tmpRoot, tmpRoot, 'memory-reader');
            memoryReader._memory = sharedMemory;
            await memoryReader.request('prompt', {message: '查看 Verified 的记录 TEST_MEMORY_RECALL'});
            for (let i = 0; i < 200 && !memoryReaderEvents.some(event => event.type === 'agent_settled'); i++) {
                await sleepGjs(20);
            }
            assert(memoryReaderEvents.some(event => event.message?.content?.some?.(part => part.text === 'RECALL_OK')),
                'New client received a matching Markdown excerpt in its normal request');
            await memoryReader.request('prompt', {message: '忘记测试笔记 TEST_MEMORY_FORGET', turnId: 'forget-a'});
            await waitForEventGjs(memoryReaderEvents, e => e.type === 'agent_settled' && e.turnId === 'forget-a');
            await memoryReader.request('prompt', {message: 'TEST_MEMORY_AFTER_FORGET', turnId: 'follow-b'});
            await waitForEventGjs(memoryReaderEvents, e => e.type === 'agent_settled' && e.turnId === 'follow-b');
            assert(!memoryReaderEvents.some(e => e.memoryTurnId === 'forget-a'), 'B settles while A still updates');
            const receipt = await waitForEventGjs(memoryReaderEvents, e => e.memoryTurnId === 'forget-a');
            assert(receipt.status === 'committed' && receipt.message.includes('preview.md'),
                'A emits a real commit receipt even after B completed');
            for (let attempt = 0; attempt < 200 && memoryReader._memoryUpdates.size; attempt++) await sleepGjs(20);
            assert(!memoryReader._memoryUpdates.size && !memoryReaderEvents.some(e => e.status === 'failed' && e.memoryTurnId),
                'B generated against the updated snapshot');
            assert(!(await sharedMemory.snapshot()).notes.has('memory://computer/preview.md') &&
                !GLib.file_test(sharedMemory.path('computer', 'preview.md'), GLib.FileTest.EXISTS),
                'Forgetting commits both note deletion and index update');
            await memoryReader.request('prompt', {message: 'TEST_MEMORY_FAIL', turnId: 'fail-a'});
            await waitForEventGjs(memoryReaderEvents, e => e.type === 'agent_settled' && e.turnId === 'fail-a');
            await memoryReader.request('prompt', {message: 'TEST_MEMORY_WRITE', turnId: 'commit-b'});
            await waitForEventGjs(memoryReaderEvents, e => e.type === 'agent_settled' && e.turnId === 'commit-b');
            assert(!memoryReaderEvents.some(e => e.memoryTurnId === 'fail-a'), 'B is queued before A fails');
            const failure = await waitForEventGjs(memoryReaderEvents, e => e.memoryTurnId === 'fail-a');
            const success = await waitForEventGjs(memoryReaderEvents, e => e.memoryTurnId === 'commit-b');
            assert(failure.status === 'failed' && success.status === 'committed' &&
                (await sharedMemory.snapshot()).notes.has('memory://computer/preview.md'),
            'A fails independently and B actually writes its topic');
            await memoryReader.request('prompt', {message: '从索引移出测试笔记 TEST_MEMORY_UNINDEX',
                turnId: 'unindex-b'});
            const unindexed = await waitForEventGjs(memoryReaderEvents, e => e.memoryTurnId === 'unindex-b');
            const file = sharedMemory.path('computer', 'preview.md');
            assert(unindexed.status === 'committed' && unindexed.message.includes('文件仍保留') &&
                Decoder.decode(GLib.file_get_contents(file)[1]) === 'Verified shared-memory note' &&
                !(await sharedMemory.snapshot()).notes.has('memory://computer/preview.md'),
            'Unindex receipt confirms the same note remains on disk');
            const deletedLine = formatMemoryReceipt(receipt);
            const unindexedLine = formatMemoryReceipt(unindexed);
            assert(deletedLine.includes('forget-a') && deletedLine.includes('忘记测试笔记') &&
                deletedLine.includes('已删除：电脑 / preview.md') && unindexedLine.includes('nindex-b') &&
                unindexedLine.includes('从索引移出测试笔记') && unindexedLine.includes('文件仍保留：电脑 / preview.md'),
            'User-visible receipts attribute same-name notes to their original turns and actions');
            const experience = new MarkdownMemory(tmpRoot, GLib.build_filenamev([tmpRoot, 'experience']));
            memoryReader._memory = experience;
            const experienceAddress = 'memory://computer/preview.md';
            for (const [scenario, expected, changed] of [
                ['FIRST', '# 偏好 A', true],
                ['DUPLICATE', '# 偏好 A', false],
                ['CORRECT', '# 偏好 B', true],
                ['TEMPORARY', '# 偏好 B', false],
                ['FORGET', undefined, true],
            ]) {
                const userRequest = (scenario === 'DUPLICATE' ? '记住 ' : '') + '偏好 TEST_EXPERIENCE_' + scenario;
                await memoryReader.request('prompt', {message: userRequest, turnId: scenario});
                await waitForEventGjs(memoryReaderEvents, e => e.type === 'agent_settled' && e.turnId === scenario);
                for (let attempt = 0; attempt < 200 && memoryReader._memoryUpdates.size; attempt++) await sleepGjs(20);
                const note = (await experience.recall(await experience.snapshot(),
                    JSON.stringify([experienceAddress]))).get(experienceAddress);
                assert(note === expected && !memoryReader._memoryUpdates.size, scenario + ' expected note state');
                assert(memoryReaderEvents.some(e => e.memoryTurnId === scenario && e.status === 'committed') === changed &&
                    !memoryReaderEvents.some(e => e.memoryTurnId === scenario && e.status === 'failed'),
                scenario + ' expected commit receipt');
                if (scenario === 'DUPLICATE') {
                    assert(memoryReaderEvents.some(e => e.memoryTurnId === scenario && e.status === 'unchanged' &&
                        e.message === '本轮未修改记忆'), 'Explicit no-op has distinct receipt');
                } else if (scenario === 'TEMPORARY') {
                    assert(!memoryReaderEvents.some(e => e.memoryTurnId === scenario), 'Ordinary no-op stays quiet');
                }
            }
            const mixed = new MarkdownMemory(tmpRoot, GLib.build_filenamev([tmpRoot, 'mixed-receipt']));
            await mixed.edit(await mixed.snapshot(), new Map(), JSON.stringify([
                {scope: 'computer', name: 'MEMORY.md', markdown: '[预览](preview.md) [保留](keep.md)'},
                {scope: 'computer', name: 'preview.md', markdown: 'Before'},
                {scope: 'computer', name: 'keep.md', markdown: 'Keep body'},
                {scope: 'project', name: 'MEMORY.md', markdown: '[项目预览](preview.md)'},
                {scope: 'project', name: 'preview.md', markdown: 'Delete body'},
            ]), () => true);
            memoryReader._memory = mixed;
            await memoryReader.request('prompt', {message: '更新预览笔记 TEST_MIXED_RECEIPT', turnId: 'mixed-turn'});
            const mixedReceipt = await waitForEventGjs(memoryReaderEvents, e => e.memoryTurnId === 'mixed-turn');
            assert(mixedReceipt.status === 'committed' && mixedReceipt.message.includes('已删除：项目 / preview.md') &&
                mixedReceipt.message.includes('文件仍保留：电脑 / keep.md') &&
                mixedReceipt.message.includes('已更新：电脑 / MEMORY.md、电脑 / preview.md、项目 / MEMORY.md'),
            'Mixed receipt lists every committed change and disambiguates identical filenames');
            GLib.file_set_contents(mixed.path('computer', 'MEMORY.md'), 'x'.repeat(9000));
            await memoryReader.request('prompt', {message: '测试读取失败时的原问题', turnId: 'read-error'});
            const readReceipt = await waitForEventGjs(memoryReaderEvents, e => e.memoryTurnId === 'read-error');
            await waitForEventGjs(memoryReaderEvents, e => e.type === 'agent_settled' && e.turnId === 'read-error');
            assert(readReceipt.status === 'failed' && formatMemoryReceipt(readReceipt).includes('测试读取失败时的原问题'),
                'Read failure is visibly attributed to its original prompt while the main turn completes');
            const taskMemory = new MarkdownMemory(tmpRoot, GLib.build_filenamev([tmpRoot, 'task-recall']));
            await taskMemory.edit(await taskMemory.snapshot(), new Map(), JSON.stringify([
                {scope: 'computer', name: 'MEMORY.md', markdown: '[项目 A](preview.md) [项目 B](other.md)'},
                {scope: 'computer', name: 'preview.md', markdown: '最近确认过项目 A'},
                {scope: 'computer', name: 'other.md', markdown: '最近确认过项目 B'},
            ]), () => true);
            memoryReader._memory = taskMemory;
            await memoryReader.request('prompt', {message: '继续上次那个项目 TEST_RESUME_CHOICES', turnId: 'task-choices'});
            const choices = await waitForEventGjs(memoryReaderEvents, e => e.type === 'message_end' && e.turnId === 'task-choices');
            await waitForEventGjs(memoryReaderEvents, e => e.type === 'agent_settled' && e.turnId === 'task-choices');
            assert(choices.message.taskChoices?.join('/') === '项目 A/项目 B', 'Ambiguous continuation returns two choices');
            await memoryReader.request('prompt', {message: '继续刚才的任务，我选「项目 A」。', turnId: 'task-selected'});
            const selected = await waitForEventGjs(memoryReaderEvents, e => e.type === 'message_end' && e.turnId === 'task-selected');
            await waitForEventGjs(memoryReaderEvents, e => e.type === 'agent_settled' && e.turnId === 'task-selected');
            assert(selected.message.memoryReferences?.join('/') === 'memory://computer/preview.md' &&
                selected.message.memoryReason === '上次确认了项目 A' &&
                !selected.message.content.some(part => part.text?.includes('随问回执')),
            'Only supplied memory can be cited and the control line is hidden');
            await memoryReader.request('prompt', {message: '以后改用项目 B TEST_REFERENCED_CORRECTION', turnId: 'task-correction'});
            const correction = await waitForEventGjs(memoryReaderEvents, e => e.memoryTurnId === 'task-correction');
            assert(correction.status === 'committed' && Decoder.decode(GLib.file_get_contents(
                taskMemory.path('computer', 'preview.md'))[1]) === '以后优先继续项目 B',
            'A correction rewrites the note used in the preceding answer');
            assert((await memoryReader.request('flush_session')).ok, 'Task history written to disk');
            const reloadedTaskSession = new SessionStore('memory-reader', {sessionsRootDir: tmpRoot});
            await reloadedTaskSession.load('openai', {});
            const reopened = reloadedTaskSession.messages.find(message => message.turnId === 'task-selected' &&
                message.role === 'assistant');
            assert(reopened?.backend === 'openai' && reopened?.modelId &&
                reopened.memoryReferences?.[0] === 'memory://computer/preview.md',
            'Answer identity and used reference survive session reload');
        } finally {
            memoryWriter.close();
            memoryReader.close();
        }

        // All four adapters participate in the same cross-backend memory protocol.
        const schemaDir = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('schemas').get_path();
        Gio.Subprocess.new(['glib-compile-schemas', '--strict', '--targetdir', tmpRoot, schemaDir],
            Gio.SubprocessFlags.NONE).wait_check(null);
        const schema = Gio.SettingsSchemaSource.new_from_directory(tmpRoot, null, false)
            .lookup('org.gnome.shell.extensions.quick-chat', false);
        const routeSettings = Gio.Settings.new_full(schema, Gio.memory_settings_backend_new(), null);
        const routeRegistry = new BackendRegistry(routeSettings);
        routeSettings.set_string('openai-base-url', originABase);
        routeSettings.set_string('openai-model', 'gpt-4o-mini');
        routeSettings.set_string('dsh-model', 'deepseek-v4-pro');
        const memoryBackends = ['codex', 'zcode', 'dsh', 'openai'];
        const runtimes = {openai: memoryRuntime};
        const cliLogs = {};
        for (const backend of memoryBackends) {
            if (backend !== 'openai') {
                const executable = GLib.build_filenamev([tmpRoot, 'memory-' + backend]);
                cliLogs[backend] = executable + '.log';
                writeExecutableScriptSync(executable, buildMemoryCliScriptSource(backend, cliLogs[backend]));
                routeSettings.set_string(backend + '-path', executable);
                routeSettings.set_string(backend + '-agent-mode', 'full');
                runtimes[backend] = {backend, executable, pathEnv: GLib.getenv('PATH')};
            }
            assert(!routeRegistry.buildRuntimeConfig(backend).autoMemory, 'Memory starts off for ' + backend);
            routeRegistry.setMemoryEnabled(backend, true);
            assert(routeRegistry.buildRuntimeConfig(backend).autoMemory, 'Settings enable ' + backend);
        }
        routeSettings.set_string('openai-base-url', originABase + '/other');
        assert(!routeRegistry.buildRuntimeConfig('openai').autoMemory, 'API destination change requires its own opt-in');
        routeSettings.set_string('openai-base-url', originABase);

        async function runMemoryTurn(backend, memory, id, message, options = {}) {
            const events = [];
            const client = new BackendClient(event => {
                events.push(event);
                if (options.expectExcludedEvidence && event.type === 'tool_execution_start') {
                    assert(client._memoryTurn?.toolCalls === null, 'Attachment turn allocates no evidence collector');
                }
                if (options.injectForeignTool && event.type === 'tool_execution_start') {
                    client._handleMemoryEvent({type: 'tool_execution_end', turnId: 'old-turn',
                        toolCallId: 'foreign', toolName: 'WrongTurn', executionOutcome: 'succeeded'});
                }
            }, () => {});
            const config = routeRegistry.buildRuntimeConfig(backend);
            client._initWithRuntime({...runtimes[backend]}, config, tmpRoot, tmpRoot, id);
            if (client._memory) client._memory = memory;
            if (options.priorBrowserReceipt) client.recordBrowserLaunch?.();
            try {
                await client.request('prompt', {message, turnId: id, ...options});
                const done = await waitForEventGjs(events, event => event.type === 'agent_settled');
                assert(done.status === 'completed', id + ' main turn completed: ' + done.errorMessage);
                if (options.expectWrite) {
                    const receipt = await waitForEventGjs(events, event => event.type === 'memory_notice');
                    assert(receipt.status === 'committed', id + ' memory committed: ' + receipt.message);
                } else if (options.expectReview) {
                    for (let attempt = 0; attempt < 200 && client._memoryUpdates.size; attempt++) await sleepGjs(20);
                    assert(!client._memoryUpdates.size && !events.some(event => event.type === 'memory_notice'),
                        id + ' completed its no-op review');
                } else {
                    assert(client._memoryUpdates.size === 0, id + ' did not schedule learning');
                }
                return events.filter(event => event.type === 'message_end')
                    .flatMap(event => event.message?.content || []).map(part => part.text || '').join('');
            } catch (error) {
                throw new Error(id + ": " + error.message);
            } finally {
                client.close();
            }
        }

        for (const writer of memoryBackends) {
            const memory = new MarkdownMemory(tmpRoot, GLib.build_filenamev([tmpRoot, 'from-' + writer]));
            await runMemoryTurn(writer, memory, 'writer-' + writer, 'TEST_MEMORY_WRITE', {expectWrite: true});
            for (const reader of memoryBackends.filter(backend => backend !== writer)) {
                const text = await runMemoryTurn(reader, memory, writer + '-to-' + reader, '查看 Verified 的记录 TEST_MEMORY_RECALL',
                    {displayUserText: '查看 Verified 的记录（带附件）'});
                assert(text === 'RECALL_OK', writer + ' to ' + reader + ' recalls its model-written topic: ' + text);
            }
            routeRegistry.setMemoryEnabled(writer, false);
            const text = await runMemoryTurn(writer, memory, 'disabled-' + writer, '查看 Verified 的记录 TEST_MEMORY_RECALL');
            assert(text === 'RECALL_MISSING', writer + ' receives no Markdown when memory is disabled');
            routeRegistry.setMemoryEnabled(writer, true);
        }
        for (const [backend, log] of Object.entries(cliLogs)) {
            const calls = Decoder.decode(GLib.file_get_contents(log)[1]).trim().split('\n').map(line => JSON.parse(line));
            assert(calls.filter(call => call.update).length === 1 && calls.every(call =>
                !call.recall && call.readonly === call.update),
            backend + ' only uses read-only for auxiliary calls and skips learning on attachment turns');
        }

        for (const backend of ['zcode', 'dsh']) {
            const calls = Decoder.decode(GLib.file_get_contents(cliLogs[backend])[1]).trim().split('\n').map(JSON.parse);
            const directive = '根据用户当前意图和已授予的权限，自主选择工具与执行方式。';
            const main = calls.find(call => !call.recall && !call.update);
            assert(main.instructions.split(directive).length === 2 && !main.instructions.includes('gtk-launch'),
                backend + ' sends the shared generic instructions once');
            routeRegistry.setMemoryEnabled(backend, false);
            routeSettings.set_string('desktop-assistant-prompt', '测试专用用户指引');
            await runMemoryTurn(backend, sharedMemory, 'custom-' + backend, '测试用户自定义指引');
            const last = JSON.parse(Decoder.decode(GLib.file_get_contents(cliLogs[backend])[1]).trim().split('\n').at(-1));
            assert(last.instructions.includes('测试专用用户指引') && !last.instructions.includes(directive),
                backend + ' sends the configured instructions');
            routeRegistry.setMemoryEnabled(backend, true);
        }

        for (const backend of ['zcode', 'dsh']) {
            await runMemoryTurn(backend, sharedMemory, 'evidence-' + backend, 'TEST_TOOL_EVIDENCE',
                {expectReview: true, injectForeignTool: true});
            const last = JSON.parse(Decoder.decode(GLib.file_get_contents(cliLogs[backend])[1]).trim().split('\n').at(-1));
            const {toolEvidence, toolEvidenceIncomplete, assistantReport} = last.evidence;
            const encoded = JSON.stringify(toolEvidence);
            assert(toolEvidence.length === 8 && Encoder.encode(encoded).length <= 1024 && toolEvidenceIncomplete === true,
                backend + ' maintains the count and byte budgets');
            assert(toolEvidence.filter(entry => entry.tool === 'Probe').length === 2 &&
                toolEvidence.some(entry => entry.tool === 'Probe' && entry.outcome === 'succeeded') &&
                toolEvidence.some(entry => entry.tool === 'Probe' && entry.outcome === 'failed'),
                backend + ' deduplicates terminal events and distinguishes concurrent same-name calls');
            assert(toolEvidence.some(entry => entry.outcome === 'unknown' && entry.endObserved) &&
                toolEvidence.some(entry => entry.outcome === 'unknown' && !entry.endObserved),
                backend + ' reports both unknown outcome and unobserved termination');
            if (backend === 'zcode') {
                assert(toolEvidence.some(entry => entry.tool === 'BatchFailure' &&
                        entry.endObserved && entry.outcome === 'failed') &&
                    toolEvidence.some(entry => entry.tool === 'BatchUnconfirmed' &&
                        !entry.endObserved && entry.outcome === 'unknown'),
                'Only a per-call batch result supplies terminal evidence');
            }
            assert(!/MissingId|WrongTurn|test-secret|testsecret|raw stdout|same-1/.test(encoded) &&
                assistantReport === 'CLI main turn' && !Object.hasOwn(last.evidence, 'goalEvidence'),
                backend + ' separates assistant claims, execution evidence and goal evidence');
            await runMemoryTurn(backend, sharedMemory, 'without-evidence-' + backend, 'TEST_CLEAN_TURN',
                {expectReview: true, priorBrowserReceipt: true});
            const clean = JSON.parse(Decoder.decode(GLib.file_get_contents(cliLogs[backend])[1]).trim().split('\n').at(-1));
            assert(clean.evidence.toolEvidence.length === 0 && clean.evidence.toolEvidenceIncomplete === false,
                backend + ' does not carry evidence or its truncation marker into another turn');
            assert(!JSON.stringify(clean.evidence).includes('open_default_browser'),
                backend + ' never attributes an earlier browser action to a new question');
            await runMemoryTurn(backend, sharedMemory, 'excluded-evidence-' + backend, 'TEST_TOOL_EVIDENCE',
                {displayUserText: '测试附件', expectExcludedEvidence: true});
        }

        const zcodeConfig = {mode: 'readonly', provider: 'openai', model: 'gpt-6-astra'};
        const savedZCodeSession = new SessionStore('zcode-model-preflight', {sessionsRootDir: tmpRoot});
        await savedZCodeSession.load();
        savedZCodeSession.appendMessage({role: 'user', content: '旧会话历史探针'}, 'zcode', zcodeConfig);
        savedZCodeSession.appendMessage({role: 'assistant', content: '旧回复'}, 'zcode', zcodeConfig);
        await savedZCodeSession.setRemoteSessionId('original-zcode-session', 'zcode', zcodeConfig);
        const invalidEvents = [];
        const preflightTurns = new TurnController(event => invalidEvents.push(event));
        const personal = {
            config: {
                providerConfigRules: {providerRules: [{providerId: 'openai',
                    config: {personalModelIds: ['gpt-6-astra', 'gpt-6.1-terra']}}]},
                modelConfigRules: {providerModelRules: [{providerId: 'openai', modelId: 'gpt-6.1-terra',
                    config: {enabled: false}}]},
            },
        };
        const personalPath = tmpRoot + '/.zcode/v2/provider_config.json';
        let overrideWrites = 0;
        const zcodeResumeFixture = tmpRoot + '/zcode-resume-fixture.cjs';
        GLib.file_set_contents(zcodeResumeFixture, [
            "const args = process.argv.slice(2);",
            "const prompt = args.find(arg => arg.startsWith('--prompt='));",
            "if (!args.includes('--resume=original-zcode-session') || !prompt?.includes('新问题') || prompt.includes('旧会话历史探针')) process.exit(2);",
            "console.log(JSON.stringify({type:'turn.started',payload:{intent:{modelSelection:{providerId:'openai',modelId:'gpt-6-astra'}}}}));",
            "console.log(JSON.stringify({type:'model.streaming',payload:{kind:'text_delta',delta:'已接着回答'}}));",
            "console.log(JSON.stringify({type:'turn.completed'}));",
        ].join('\n'));
        const preflightAdapter = new ZCodeAdapter({turns: preflightTurns, store: savedZCodeSession,
            getSessionContextConfig: () => zcodeConfig,
            modelConfigIo: {
                homeDir: tmpRoot,
                fileExistsAsync: async path => path === personalPath,
                readJsonAsync: async path => path === personalPath ? personal
                    : JSON.parse(Decoder.decode(GLib.file_get_contents(path)[1])),
                writePrivateFileAsync: async (path, bytes) => {
                    overrideWrites++;
                    await writePrivateFileAsync(path, bytes);
                },
                getRuntimeDir: () => tmpRoot,
                makeUuid: () => GLib.uuid_string_random(),
                removeFile: removeFileQuietly,
            },
        }).initialize({executable: nodeBin, commandPrefix: [nodeBin, zcodeResumeFixture]},
            {...zcodeConfig, model: 'gpt-6.1-terra'});
        await preflightAdapter.restoreSession(savedZCodeSession, {...zcodeConfig, model: 'gpt-6.1-terra'});
        const rejection = await preflightAdapter.sendMessage({promptText: '保留这条草稿', workspace: tmpRoot});
        assert(rejection.disposition === 'rejected_before_send' && rejection.error.includes('gpt-6.1-terra') &&
            !overrideWrites && !invalidEvents.length && !preflightTurns.activeTurn,
        'Disabled ZCode model is rejected locally before writing a config or spawning a process');
        assert(savedZCodeSession.messages.length === 2 && savedZCodeSession.remoteSessionId === 'original-zcode-session',
            'Rejecting an unsent prompt changes neither history nor its native session');
        preflightAdapter.configure(zcodeConfig);
        await preflightAdapter.sendMessage({promptText: '新问题', workspace: tmpRoot});
        const resumed = await waitForEventGjs(invalidEvents, event => event.type === 'agent_settled');
        assert(resumed.status === 'completed' && overrideWrites === 1 &&
            savedZCodeSession.remoteSessionId === 'original-zcode-session',
        'The next valid prompt resumes the original session without resending historical text');

        // A backend mismatch is visible to the user without stopping the existing native session.
        for (const [reported, mismatched] of [
            ['gpt-6.1-terra', false], ['gpt-6-astra', true], [null, false],
        ]) {
            const events = [];
            const turns = new TurnController(event => events.push(event));
            const turn = turns.beginTurn({backend: 'zcode', modelId: 'gpt-6.1-terra',
                cancellable: new Gio.Cancellable()});
            turn.expectedZCodeRoute = {provider: 'openai', model: 'gpt-6.1-terra'};
            const frames = [
                ...(reported ? [{type: 'turn.started',
                    payload: {intent: {modelSelection: {providerId: 'openai', modelId: reported}}}}] : []),
                {type: 'model.streaming', payload: {kind: 'text_delta', delta: 'model answer'}},
                {type: 'turn.completed'},
            ];
            let nativeConfirmed = false;
            let sessionCleared = false;
            spawnManagedCliTurn({
                backend: 'zcode', runtime: {executable: nodeBin}, config: {mode: 'readonly'},
                workspace: tmpRoot, turns, turn, getSessionContextConfig: () => ({}), isDisposedFn: () => false,
                remoteId: 'resumed-zcode-session',
                store: {appendMessage() {}, confirmRemoteTurnSynced() { nativeConfirmed = true; },
                    clearRemoteSessionId() { sessionCleared = true; }},
                rawArgv: [nodeBin, '-e', `console.log(${JSON.stringify(frames.map(frame =>
                    JSON.stringify(frame)).join('\n'))})`],
            });
            const settled = await waitForEventGjs(events, event => event.type === 'agent_settled');
            assert(settled.status === 'completed' && Boolean(settled.modelMismatch) === mismatched &&
                nativeConfirmed && !sessionCleared, 'ZCode reports a mismatch while retaining the synced native session');
            if (mismatched) assert(settled.modelMismatch.includes(reported), 'Error identifies the reported model');
        }

        assert(isDshWriteWorkspace(tmpRoot, tmpRoot), 'Explicit test workspace permits DSH workspace sandbox');
        assert(!isDshWriteWorkspace('', tmpRoot) &&
            !isDshWriteWorkspace('~', GLib.get_home_dir()) && !isDshWriteWorkspace('/', '/'),
        'DSH smart never enables workspace write for the default workspace, home, or root');

        // 5D2. Real DSH Headless JSONL → Gio.Subprocess → shared TurnController.
        const fakeDshScript = GLib.build_filenamev([tmpRoot, 'fake_dsh_cli.cjs']);
        writeExecutableScriptSync(fakeDshScript, [
            '#!/usr/bin/env node',
            "let prompt = '';",
            "process.stdin.setEncoding('utf8');",
            "process.stdin.on('data', chunk => { prompt += chunk; });",
            "process.stdin.on('end', () => {",
            "  const fs = require('node:fs');",
            "  const args = process.argv.slice(2);",
            "  const idx = args.indexOf('--patch');",
            "  if (idx < 0 || !args[idx+1]) { console.log(JSON.stringify({type:'error',message:'missing overlay'})); process.exit(1); }",
            "  const overlay = fs.readFileSync(args[idx+1], 'utf8');",
            "  if (!overlay.includes('deepseek-v4-pro') || !overlay.includes('桌面助手请打开浏览器')) { console.log(JSON.stringify({type:'error',message:'overlay content missing'})); process.exit(1); }",
            "  if (args[args.indexOf('--permission-mode') + 1] !== 'read-only') { process.exit(1); }",
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
        }, {mode:'readonly',provider:'deepseek-official',model:'deepseek-v4-pro',
            assistantInstructions:'桌面助手请打开浏览器'});
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
            Array.isArray(e.message?.content) &&
            e.message.content.some(p => p.type === 'text' &&
                String(p.text || '').startsWith('DSH 完成:') &&
                String(p.text || '').includes('测试 DSH'))),
            'DSH final must replace interim text in the persisted structured content parts');

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
                `  console.log('${kind === 'zcode' ? 'zcode --output-format --prompt --cwd --mode --resume' : kind === 'dsh' ? 'Usage: dsh --profile headless [options] [task...] --json --permission-mode --session-id --approval-policy' : 'codex exec --json --sandbox read-only --model'}');`,
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
