import test from 'node:test';
import assert from 'node:assert/strict';
import {isDefaultBrowserLaunchRequest, normalizeEffectiveAgentMode} from '../protocol.js';
import {DshSdkTurn, supportsDshSdk} from '../runtime/dshSdk.js';
import {buildDshProfileOverlay} from '../core/dshModelCatalog.js';
import {BaseBackendAdapter} from '../backends/baseAdapter.js';

const frame = data => ({jsonrpc: '2.0', ...data});
const event = (type, data) => frame({method: 'session.event', params: {sessionId: 'local-turn', event: {type, data}}});

const sdkPermissions = (mode, workspaceWrite = false) =>
    normalizeEffectiveAgentMode('dsh', mode, {dshSdk: true}, {workspaceWrite}).native;

function fixture(approvalRequests = true) {
    const sdk = new DshSdkTurn({
        sessionId: 'local-turn', workspace: '/tmp', provider: 'codex', model: 'example',
        prompt: 'question', permissions: sdkPermissions(approvalRequests ? 'smart' : 'readonly'),
    });
    const sent = [];
    sdk.start(async message => sent.push(message));
    sdk.read(frame({id: 'qc-init', result: {serverInfo: {name: 'deepseek-harness-sdk-runtime'}}}));
    sdk.read(frame({id: 'qc-prompt', result: {messageId: 'accepted'}}));
    return {sdk, sent};
}

test('DSH SDK uses one-shot scoped approvals, checks source arguments and never grants an unrelated session', async () => {
    assert.equal(supportsDshSdk('0.2.2-rc.4'), false);
    assert.equal(supportsDshSdk('0.2.2-rc.5'), true);
    assert.equal(supportsDshSdk('0.2.2'), true);
    assert.equal(supportsDshSdk('0.1.5-rc.2'), false);
    const {sdk, sent} = fixture();
    assert.equal(sent[0].params.approvalRequests, true);
    assert.equal(sent[0].params.capabilities.userQuestions, true);
    assert.equal(sent[1].method, 'session/prompt');
    assert.equal(sent[2].method, 'session/wait');
    sdk.read(event('tool/call', {name: 'bash', callId: 'tool-1', arguments: '{"command":"printf test"}'}));
    const params = {sessionId: 'local-turn', toolName: 'bash', callId: 'tool-1'};
    sdk.read(event('approval/asked', {id: 'native-approval', callId: 'tool-1'}));
    const request = sdk.read(frame({id: 7, method: 'approval/request', params}));
    assert.equal(request.type, 'permission_request');
    assert.equal(request.allowSessionRule, false);
    assert.equal(request.rawInput.command, 'printf test');
    assert.equal((await sdk.respond({requestId: request.requestId, decision: 'allow', alwaysAllow: true})).sent, false);
    assert.equal((await sdk.respond({requestId: request.requestId, decision: 'allow'})).sent, true);
    assert.equal(sdk.read(event('approval/decided', {id: 'native-approval', outcome: 'allowed-once'})).decision, 'allow');
    assert.deepEqual(sent.at(-1).result, {outcome: 'allowed-once'});
    assert.equal((await sdk.respond({requestId: request.requestId, decision: 'allow'})).sent, false);
    assert.equal(sdk.read(frame({id: 8, method: 'approval/request', params: {...params, sessionId: 'stale'}})), null);
    assert.deepEqual(sent.at(-1).result, {outcome: 'rejected'});
});

test('DSH questions preserve exact options, custom input and native cancellation', async () => {
    const {sdk, sent} = fixture(false);
    const params = {requestId: 'native-question', sessionId: 'local-turn', questions: [
        {id: 'a', question: 'Pick names', detail: 'A note', multiSelect: true,
            options: [{label: 'A, B'}, {label: 'C'}]},
        {id: 'b', question: 'Explain'},
    ]};
    const request = sdk.read(frame({id: 8, method: 'user-question/ask', params}));
    assert.ok(request.isQuestion);
    const questionDrafts = {
        'Pick names\n\nA note': {selectedLabels: ['A, B', 'C']},
        Explain: {customText: 'custom answer'},
    };
    assert.equal((await sdk.respond({requestId: request.requestId, decision: 'modify', questionDrafts})).sent, true);
    assert.deepEqual(sent.at(-1).result, {answers: [
        {id: 'a', selected: ['A, B', 'C']},
        {id: 'b', selected: [], custom: 'custom answer'},
    ]});
    const later = sdk.read(frame({id: 'next', method: 'user-question/ask', params}));
    const cancelled = sdk.read(frame({method: 'user-question.cancelled', params}));
    assert.equal(cancelled.requestId, later.requestId);
    assert.equal((await sdk.respond({requestId: later.requestId, decision: 'modify', questionDrafts})).sent, false);
});

test('DSH SDK detects incompatible native sandbox and approval policy', () => {
    const {sdk} = fixture();
    assert.equal(sdk.read(event('sandbox/mode', {mode: 'read-only'})), null);
    assert.throws(() => sdk.read(event('sandbox/mode', {mode: 'danger-full-access'})), /沙箱/);
    assert.throws(() => sdk.read(event('approval/policy', {policy: 'never'})), /审批策略/);
});

test('DSH completes only after durable turn/end plus session/wait', () => {
    const {sdk, sent} = fixture();
    assert.equal(sdk.read(event('assistant/message', {message: {content: [{type: 'text', text: 'answer'}]}})).text, 'answer');
    assert.equal(sdk.read(event('turn/end', {reason: {kind: 'completed'}})), null);
    assert.equal(sdk.read(frame({id: 'qc-wait', result: {}})).isError, false);
    assert.equal(sent.at(-1).method, 'shutdown');
    const missing = fixture().sdk.read(frame({id: 'qc-wait', result: {}}));
    assert.equal(missing.isError, true);
});

test('DSH overlay uses native managed credentials and preserves restricted approval policy', () => {
    const overlay = buildDshProfileOverlay({mountCredentials: true, sdkPermissions: sdkPermissions('smart', true)});
    assert.match(overlay, /id: credentials\n  disabled: false/);
    assert.match(overlay, /mode: workspace-write/);
    assert.match(overlay, /policy: ask/);
    assert.match(buildDshProfileOverlay({sdkPermissions: sdkPermissions('readonly')}), /policy: never/);
});

test('shared backend context is rebuilt from the current local conversation after edits', () => {
    const store = {
        messages: [{role: 'user', content: 'before edit'}, {role: 'assistant', content: 'acknowledged'}],
        resolveRemoteSessionForTurn: backend => backend === 'zcode' ? 'zcode-cache' : '',
    };
    const zcode = new BaseBackendAdapter('zcode');
    const dsh = new BaseBackendAdapter('dsh');
    for (const adapter of [zcode, dsh]) {
        adapter._store = store;
        adapter._getSessionContextConfig = () => ({});
    }
    const options = {workspace: '/tmp', specialDirs: {}, mode: 'readonly'};
    assert.equal(zcode.prepareCliContext('new prompt', options).remoteId, 'zcode-cache');
    assert.match(dsh.prepareCliContext('new prompt', options).prompt, /before edit/);
    store.messages = [{role: 'user', content: 'edited shared memory'}, {role: 'assistant', content: 'acknowledged edit'}];
    for (const adapter of [zcode, dsh]) {
        const replay = adapter.prepareCliContext('new prompt', {...options, allowResume: false});
        assert.match(replay.prompt, /edited shared memory/);
        assert.doesNotMatch(replay.prompt, /before edit/);
    }
});

test('DSH restores a bound native session before sending the next prompt', () => {
    const makeTurn = () => new DshSdkTurn({sessionId: 'local-turn', workspace: '/tmp', provider: 'codex',
        model: 'example', prompt: 'next question', permissions: sdkPermissions('smart'), resume: true});
    const sent = [];
    const sdk = makeTurn();
    sdk.start(async message => sent.push(message));
    sdk.read(frame({id: 'qc-init', result: {serverInfo: {name: 'deepseek-harness-sdk-runtime'}}}));
    assert.deepEqual(sent.map(message => message.method), ['initialize', 'session/resume']);
    assert.deepEqual(sent.at(-1).params, {sessionId: 'local-turn'});
    sdk.read(frame({id: 'qc-resume', result: {}}));
    assert.deepEqual(sent.at(-1).params, {
        sessionId: 'local-turn', contentBlocks: [{type: 'text', text: 'next question'}],
    });
    sdk.read(frame({id: 'qc-prompt', result: {messageId: 'accepted'}}));
    sdk.read(event('turn/end', {reason: {kind: 'completed'}}));
    assert.equal(sdk.read(frame({id: 'qc-wait', result: {}})).sessionId, 'local-turn');

    const missing = makeTurn();
    const second = [];
    missing.start(async message => second.push(message));
    missing.read(frame({id: 'qc-init', result: {serverInfo: {name: 'deepseek-harness-sdk-runtime'}}}));
    const result = missing.read(frame({id: 'qc-resume', error: {message: 'missing session'}}));
    assert.equal(result.isError, true);
    assert.equal(result.sessionId, '');
    assert.deepEqual(second.map(message => message.method), ['initialize', 'session/resume', 'shutdown']);
});

test('browser action accepts only a direct instruction with no arbitrary command or URL', () => {
    for (const phrase of ['打开我的默认浏览器', '请帮我打开默认浏览器。', 'Open my default browser!']) {
        assert.equal(isDefaultBrowserLaunchRequest(phrase), true, phrase);
    }
    for (const phrase of ['如何打开我的默认浏览器？', '打开浏览器并删除文件', '请打开浏览器 https://example.test',
        'echo 打开我的默认浏览器', '“打开我的默认浏览器”', '不要打开浏览器']) {
        assert.equal(isDefaultBrowserLaunchRequest(phrase), false, phrase);
    }
});

test('DSH checks the route in the live request header before accepting answer events', () => {
    const sdk = new DshSdkTurn({sessionId: 'local-turn', workspace: '/tmp', provider: 'codex',
        model: 'gpt-6.1-terra', prompt: 'question', permissions: sdkPermissions('readonly')});
    const sent = [];
    sdk.start(async message => sent.push(message));
    assert.equal(sent[0].params.model, 'gpt-6.1-terra');
    sdk.read(frame({id: 'qc-init', result: {serverInfo: {name: 'deepseek-harness-sdk-runtime'}}}));
    const header = model => event('request/header', {header: {config: {provider: 'codex', model}}});
    assert.equal(sdk.read(header('gpt-6.1-terra')), null);
    assert.throws(() => sdk.read(header('gpt-6-astra')), error =>
        /gpt-6\.1-terra.*gpt-6-astra/.test(error.message) && error.reportedModelId === 'gpt-6-astra');
});
