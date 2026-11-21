import test from 'node:test';
import assert from 'node:assert/strict';
import {DshSdkTurn, supportsDshSdk} from '../runtime/dshSdk.js';
import {buildDshProfileOverlay} from '../core/dshModelCatalog.js';
import {BaseBackendAdapter} from '../backends/baseAdapter.js';

const frame = data => ({jsonrpc: '2.0', ...data});
const event = (type, data) => frame({method: 'session.event', params: {sessionId: 'local-turn', event: {type, data}}});

function fixture(approvalRequests = true) {
    const sdk = new DshSdkTurn({
        sessionId: 'local-turn', workspace: '/tmp', provider: 'codex', model: 'example',
        prompt: 'question', approvalRequests,
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
    const overlay = buildDshProfileOverlay({mountCredentials: true, sdkMode: 'smart'});
    assert.match(overlay, /id: credentials\n  disabled: false/);
    assert.match(overlay, /mode: read-only/);
    assert.match(overlay, /policy: ask/);
    assert.match(buildDshProfileOverlay({sdkMode: 'readonly'}), /policy: never/);
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
