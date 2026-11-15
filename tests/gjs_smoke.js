// Real GJS Headless Integration Smoke Test (executed via `gjs -m tests/gjs_smoke.js` in CI).
// Validates that all GI-backed (`gi://GLib`, `gi://Gio`) and pure-JS modules load and execute
// cleanly inside SpiderMonkey/GJS without relying on Node-only globals (such as `globalThis.URL`).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {BackendRegistry, MemorySettingsStore} from '../core/backendRegistry.js';
import {detectBackendSelection} from '../core/backendDetect.js';
import {parseUrlPortable, evaluatePermissionPolicy} from '../core/permissionPolicy.js';
import {inspectEndpointSecurity, normalizeEndpointKeyIdentity, shouldStripAuthOnRedirect} from '../core/secretPolicy.js';
import {buildRuntimeContextSignature, buildBudgetedContextMessages} from '../core/contextManager.js';
import {SessionStore} from '../core/sessionStore.js';
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
import {getBackendCapabilities} from '../protocol.js';

function assert(cond, msg) {
    if (!cond) {
        throw new Error(`GJS smoke assertion failed: ${msg}`);
    }
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
const rawSseBytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好🚀"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
// Split right inside multi-byte UTF-8 sequence to verify GJS-compatible carry decoding without `{stream: true}`
const sseEvents = [
    ...sse.pushBytes(rawSseBytes.subarray(0, 41)),
    ...sse.pushBytes(rawSseBytes.subarray(41)),
];
const sseFinal = sse.finish();
assert(sseEvents.some(e => e.type === 'delta' && e.textDelta === '你好🚀') && sseFinal.completedCleanly, 'SSE split UTF-8 delta');
assert(getBackendCapabilities('codex', 'readonly').supportsApproval === false, 'Codex capability honesty');
assert(typeof BaseBackendAdapter === 'function' && typeof computeAdaptiveRenderDelayMs === 'function', 'Adapter & scheduler helpers');
assert(buildBudgetedContextMessages([{role: 'user', content: 'hi'}], {currentPrompt: 'next'}).length === 1, 'Budgeted context');

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

// 5. Real Gio async SessionStore write + reload in an isolated temp dir
const tmpRoot = GLib.dir_make_tmp('qc-gjs-smoke-XXXXXX');
const loop = new GLib.MainLoop(null, false);
let asyncError = null;

(async () => {
    try {
        const store = new SessionStore('gjs_smoke_sess', {sessionsRootDir: tmpRoot});
        await store.load('openai', {openaiModel: 'gpt-4o'});
        await store.appendMessage({id: 'u1', role: 'user', content: 'GJS 异步持久化测试'}, 'openai', {openaiModel: 'gpt-4o'});
        await store.appendMessage({id: 'a1', role: 'assistant', content: '持久化正常', replyTo: 'u1'}, 'openai', {openaiModel: 'gpt-4o'});
        await store.flush();
        assert(!store.lastWriteError, `SessionStore write error: ${store.lastWriteError}`);

        const reloaded = new SessionStore('gjs_smoke_sess', {sessionsRootDir: tmpRoot});
        await reloaded.load('openai', {openaiModel: 'gpt-4o'});
        assert(reloaded.messages.length === 2, 'Reloaded 2 messages via Gio');

        const hw = new HistoryWindowController();
        hw.reset(reloaded.messages);
        assert(hw.allMessages.length === 2, 'HistoryWindowController reset');

        // Verify Gio private 0600/0700 Unix mode enforcement (replaces non-GIR GLib.chmod)
        const privFile = GLib.build_filenamev([tmpRoot, 'priv_secret_test.json']);
        await writePrivateFileAsync(privFile, new TextEncoder().encode('{"ok":true}\n'));
        const privInfo = Gio.File.new_for_path(privFile).query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        assert((privInfo.get_attribute_uint32('unix::mode') & 0o777) === 0o600, 'Private file mode 0600');
        removeFileQuietly(privFile);

        const sessDir = Gio.File.new_for_path(GLib.build_filenamev([tmpRoot, 'gjs_smoke_sess']));
        const dirInfo = sessDir.query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        assert((dirInfo.get_attribute_uint32('unix::mode') & 0o777) === 0o700, 'Session directory mode 0700');

        // Cleanup isolated temp directory
        for (const fname of ['messages.jsonl', 'meta.json']) {
            const f = sessDir.get_child(fname);
            if (f.query_exists(null)) f.delete(null);
        }
        if (sessDir.query_exists(null)) sessDir.delete(null);
        Gio.File.new_for_path(tmpRoot).delete(null);
    } catch (err) {
        asyncError = err;
    } finally {
        loop.quit();
    }
})();

loop.run();
if (asyncError) {
    throw asyncError;
}
print('GJS headless integration & pure-module smoke suite passed.');
