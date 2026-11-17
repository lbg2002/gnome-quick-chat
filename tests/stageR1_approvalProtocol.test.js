import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';

import {registerGiMocks, MockOutputStream} from './helpers/giMockLoader.js';

registerGiMocks();

const require = createRequire(import.meta.url);
const zcodeBridge = require('../zcodeBridge.cjs');

const {TurnController} = await import('../core/turnController.js');
const {
    buildAskUserModifiedInput,
    formatAskUserAnswerSummary,
    normalizeEvent,
} = await import('../protocol.js');
const {ZCodeAdapter} = await import('../backends/zcodeAdapter.js');

/**
 * Helper that connects a real ZCodeAdapter + TurnController to a real zcodeBridge
 * PermissionBrokerController via a real stream pipe, routing bridge stdout events
 * through normalizeEvent into TurnController just like processManager.js.
 */
function createAdapterBridgeHarness({
    sessionId = 'sess_r1',
    turnId = 'turn_r1_1',
    approvalTimeoutMs = 200,
    writeDelayMs = 0,
} = {}) {
    const hostEvents = [];
    const bridgeEvents = [];
    const approvedScopes = new Set();
    const turns = new TurnController(evt => hostEvents.push(evt));
    const cancellable = new globalThis.__qcMockGio.Cancellable();

    const turn = turns.beginTurn({
        turnId,
        messageId: `msg_${turnId}`,
        sessionId,
        clientGeneration: 1,
        lifecycleGeneration: 1,
        backend: 'zcode',
        cancellable,
    });

    const stdinPipe = new PassThrough();
    const stdinStream = new MockOutputStream(stdinPipe);
    stdinStream.writeDelayMs = writeDelayMs;
    turn.stdin = stdinStream;

    const adapter = new ZCodeAdapter({
        turns,
        store: null,
        approvedScopes,
        getSessionContextConfig: () => ({}),
        emitEvent: evt => hostEvents.push(evt),
    });

    const broker = zcodeBridge.createPermissionBrokerController({
        sessionId,
        turnId,
        workspace: '/work/project',
        approvalTimeoutMs,
        emitEvent: rawEvt => {
            bridgeEvents.push(rawEvt);
            const norm = normalizeEvent('zcode', rawEvt);
            if (!norm) return;
            if (norm.type === 'permission_request') {
                turns.enterApproval(turn, norm.requestId, norm);
                turns.emitForTurn(turn, norm);
            } else if (norm.type === 'permission_resolved') {
                if (typeof turns.resolveApprovalFromBridge === 'function') {
                    turns.resolveApprovalFromBridge(turn, norm, {approvedScopes});
                } else {
                    turns.leaveApproval(turn, norm.requestId);
                }
                turns.emitForTurn(turn, norm);
            } else if (norm.type === 'permission_response_rejected') {
                if (typeof turns.rejectApprovalResponseFromBridge === 'function') {
                    turns.rejectApprovalResponseFromBridge(turn, norm);
                }
                turns.emitForTurn(turn, norm);
            }
        },
    });

    let lineBuf = '';
    stdinPipe.on('data', chunk => {
        lineBuf += chunk.toString('utf8');
        let idx;
        while ((idx = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, idx).trim();
            lineBuf = lineBuf.slice(idx + 1);
            if (line.startsWith('{')) {
                const msg = JSON.parse(line);
                broker.handlePermissionResponseMessage(msg);
            }
        }
    });

    return {
        turns,
        turn,
        adapter,
        broker,
        approvedScopes,
        hostEvents,
        bridgeEvents,
        stdinStream,
        stdinPipe,
    };
}

test('R1.1: End-to-end AskUserQuestion preserves custom answer, single-select, multi-select, and explicit skip through ZCodeAdapter -> stdin -> zcodeBridge', async () => {
    const h = createAdapterBridgeHarness({turnId: 'turn_ask_1'});

    const rawInput = {
        questions: [
            {
                id: 'q_framework',
                question: '使用哪个测试框架？',
                options: [{label: 'node:test'}, {label: 'vitest'}],
                multiSelect: false,
            },
            {
                id: 'q_targets',
                question: '需要覆盖哪些模块？',
                options: [{label: 'ZCodeAdapter'}, {label: 'zcodeBridge'}, {label: 'TurnController'}],
                multiSelect: true,
            },
            {
                id: 'q_custom',
                question: '补充说明？',
                options: [{label: '无'}],
                multiSelect: false,
            },
        ],
        metadata: {source: 'zcode_agent'},
    };

    // 1. Bridge receives AskUserQuestion from ZCode CLI
    const brokerPromise = h.broker.handlePermissionRequest({
        requestId: 'req_q_1',
        toolCallId: 'call_q_1',
        toolName: 'AskUserQuestion',
        input: rawInput,
    });

    assert.equal(h.turn.pendingApprovals.has('req_q_1'), true);
    assert.equal(h.turn.state, 'awaiting_approval');

    // 2. Build modifiedInput using the exact production helper from protocol.js
    const drafts = {
        q_framework: {selected: ['node:test'], customText: ''},
        q_targets: {selected: ['ZCodeAdapter', 'zcodeBridge'], customText: 'TurnController'},
        q_custom: {selected: [], customText: '必须验证桥接权威 ACK'},
    };
    const modifiedInput = buildAskUserModifiedInput(rawInput, drafts, {skipAll: false});
    const summaryText = formatAskUserAnswerSummary(rawInput.questions, modifiedInput);
    assert.ok(summaryText.includes('node:test'));
    assert.ok(summaryText.includes('必须验证桥接权威 ACK'));

    // 3. Submit via ZCodeAdapter.respondPermission with decision='modify'
    const sendRes = await h.adapter.respondPermission({
        turnId: 'turn_ask_1',
        requestId: 'req_q_1',
        decision: 'modify',
        alwaysAllow: false,
        allowSessionRule: false,
        scopeKey: '',
        modifiedInput,
        reason: '用户在随问中提交了问题回答',
    });
    assert.equal(sendRes.sent, true);

    // 4. Verify the broker resolution returned to ZCode CLI has the EXACT user answers (not {})!
    const resolution = await brokerPromise;
    assert.equal(resolution.decision, 'modify');
    assert.deepEqual(resolution.modifiedInput.answers, {
        q_framework: 'node:test',
        q_targets: 'ZCodeAdapter, zcodeBridge, TurnController',
        q_custom: '必须验证桥接权威 ACK',
    });
    assert.equal(resolution.modifiedInput.metadata?.source, 'zcode_agent');
    assert.equal(h.turn.pendingApprovals.size, 0);
    assert.equal(h.turn.state, 'streaming');

    // 5. Test explicit "交由 AI 判断" (skipAll = true) -> empty answers {} with AI judgment message
    const skipBrokerPromise = h.broker.handlePermissionRequest({
        requestId: 'req_q_skip',
        toolCallId: 'call_q_skip',
        toolName: 'AskUserQuestion',
        input: rawInput,
    });
    const skipModified = buildAskUserModifiedInput(rawInput, {}, {skipAll: true});
    const skipSendRes = await h.adapter.respondPermission({
        turnId: 'turn_ask_1',
        requestId: 'req_q_skip',
        decision: 'modify',
        alwaysAllow: false,
        allowSessionRule: false,
        scopeKey: '',
        modifiedInput: skipModified,
    });
    assert.equal(skipSendRes.sent, true);
    const skipResolution = await skipBrokerPromise;
    assert.equal(skipResolution.decision, 'modify');
    assert.deepEqual(skipResolution.modifiedInput.answers, {});
    assert.ok(skipResolution.reason.includes('交由 AI'));
});

test('R1.2: Protocol strictly validates decision = allow | deny | modify, forbids modifiedInput on allow/deny or non-question tools, and enforces question IDs & turnId', async () => {
    const h = createAdapterBridgeHarness({turnId: 'turn_strict_1'});

    // 1. Start a Bash permission request and an AskUserQuestion request
    const bashPromise = h.broker.handlePermissionRequest({
        requestId: 'req_bash_1',
        toolCallId: 'call_bash_1',
        toolName: 'Bash',
        input: {command: 'ls -la'},
    });
    const qPromise = h.broker.handlePermissionRequest({
        requestId: 'req_ask_2',
        toolCallId: 'call_ask_2',
        toolName: 'AskUserQuestion',
        input: {
            questions: [{id: 'q_lang', question: '语言？', options: [{label: '中文'}]}],
        },
    });

    // 2. Ordinary allow MUST NOT carry modifiedInput (rejected at adapter AND bridge)
    const sneakAllow = await h.adapter.respondPermission({
        turnId: 'turn_strict_1',
        requestId: 'req_bash_1',
        decision: 'allow',
        modifiedInput: {command: 'rm -rf /'},
    });
    assert.equal(sneakAllow.sent, false);
    assert.equal(sneakAllow.rejected, 'modified_input_forbidden_for_decision');

    const bridgeSneakAllow = h.broker.handlePermissionResponseMessage({
        type: 'permission_response',
        turnId: 'turn_strict_1',
        requestId: 'req_bash_1',
        decision: 'allow',
        modifiedInput: {command: 'rm -rf /'},
    });
    assert.equal(bridgeSneakAllow.accepted, false);
    assert.equal(bridgeSneakAllow.reason, 'modified_input_forbidden_for_decision');

    // 3. Non-question tool (Bash) MUST NOT use decision='modify'
    const modifyBash = await h.adapter.respondPermission({
        turnId: 'turn_strict_1',
        requestId: 'req_bash_1',
        decision: 'modify',
        modifiedInput: {questions: [], answers: {}},
    });
    assert.equal(modifyBash.sent, false);
    assert.equal(modifyBash.rejected, 'modify_forbidden_for_tool');

    const bridgeModifyBash = h.broker.handlePermissionResponseMessage({
        type: 'permission_response',
        turnId: 'turn_strict_1',
        requestId: 'req_bash_1',
        decision: 'modify',
        modifiedInput: {questions: [], answers: {}},
    });
    assert.equal(bridgeModifyBash.accepted, false);
    assert.equal(bridgeModifyBash.reason, 'modify_forbidden_for_tool');

    // 4. AskUserQuestion with unknown question ID or malformed answers MUST be rejected
    const badQId = await h.adapter.respondPermission({
        turnId: 'turn_strict_1',
        requestId: 'req_ask_2',
        decision: 'modify',
        modifiedInput: {
            questions: [{id: 'q_lang', question: '语言？', options: [{label: '中文'}]}],
            answers: {q_injected_unknown: '恶意注入'},
        },
    });
    assert.equal(badQId.sent, false);
    assert.equal(badQId.rejected, 'unknown_question_id');

    // 5. Missing turnId when turn has turnId MUST be rejected by bridge (strict mode)
    const missingTurnIdRes = h.broker.handlePermissionResponseMessage({
        type: 'permission_response',
        requestId: 'req_bash_1',
        decision: 'allow',
    });
    assert.equal(missingTurnIdRes.accepted, false);
    assert.equal(missingTurnIdRes.reason, 'missing_turn_id');

    // Clean up both pending requests with valid responses
    await h.adapter.respondPermission({
        turnId: 'turn_strict_1',
        requestId: 'req_bash_1',
        decision: 'deny',
    });
    await h.adapter.respondPermission({
        turnId: 'turn_strict_1',
        requestId: 'req_ask_2',
        decision: 'modify',
        modifiedInput: {
            questions: [{id: 'q_lang', question: '语言？', options: [{label: '中文'}]}],
            answers: {q_lang: '中文'},
        },
    });
    assert.equal((await bashPromise).decision, 'deny');
    assert.equal((await qPromise).decision, 'modify');
});

test('R1.3: Authoritative ACK lifecycle — pipe write completion does NOT settle approval or widen approvedScopes; only bridge permission_resolved does', async () => {
    const h = createAdapterBridgeHarness({turnId: 'turn_ack_1'});

    // Intercept stdinPipe so we can inspect state AFTER adapter write succeeds but BEFORE bridge processes the message
    const interceptedLines = [];
    h.stdinPipe.removeAllListeners('data');
    h.stdinPipe.on('data', chunk => {
        interceptedLines.push(chunk.toString('utf8'));
    });

    // Two parallel WebFetch requests with identical safe scopeKey + one different scope
    const p1 = h.broker.handlePermissionRequest({
        requestId: 'req_web_1',
        toolCallId: 'call_web_1',
        toolName: 'WebFetch',
        input: {url: 'https://developer.gnome.org/page1'},
    });
    const p2 = h.broker.handlePermissionRequest({
        requestId: 'req_web_2',
        toolCallId: 'call_web_2',
        toolName: 'WebFetch',
        input: {url: 'https://developer.gnome.org/page2'},
    });
    const p3 = h.broker.handlePermissionRequest({
        requestId: 'req_web_3',
        toolCallId: 'call_web_3',
        toolName: 'WebFetch',
        input: {url: 'https://gitlab.gnome.org/other'},
    });

    const req1Event = h.hostEvents.find(e => e.type === 'permission_request' && e.requestId === 'req_web_1');
    assert.ok(req1Event?.scopeKey);

    // Send "alwaysAllow" on req_web_1
    const writeRes = await h.adapter.respondPermission({
        turnId: 'turn_ack_1',
        requestId: 'req_web_1',
        decision: 'allow',
        alwaysAllow: true,
        allowSessionRule: true,
        scopeKey: req1Event.scopeKey,
    });
    assert.equal(writeRes.sent, true);
    assert.equal(interceptedLines.length, 1);

    // CRITICAL ASSERTIONS BEFORE BRIDGE ACK:
    // 1. req_web_1 is STILL in pendingApprovals (watchdog NOT resumed prematurely!)
    assert.equal(h.turn.pendingApprovals.has('req_web_1'), true);
    assert.equal(h.turn.state, 'awaiting_approval');
    // 2. approvedScopes is STILL EMPTY before bridge ACK!
    assert.equal(h.approvedScopes.size, 0);
    // 3. Duplicate retry while awaiting_ack is idempotent and does not write a second line
    const retryRes = await h.adapter.respondPermission({
        turnId: 'turn_ack_1',
        requestId: 'req_web_1',
        decision: 'allow',
        alwaysAllow: true,
        allowSessionRule: true,
        scopeKey: req1Event.scopeKey,
    });
    assert.equal(retryRes.sent, true);
    assert.equal(interceptedLines.length, 1);

    // Now deliver the line to the bridge!
    h.broker.handlePermissionResponseMessage(JSON.parse(interceptedLines[0].trim()));

    assert.equal((await p1).decision, 'allow');
    assert.equal((await p2).decision, 'allow');

    // AFTER BRIDGE ACK:
    // 1. approvedScopes now contains req1Event.scopeKey
    assert.equal(h.approvedScopes.has(req1Event.scopeKey), true);
    // 2. Both req_web_1 and auto-approved req_web_2 have left pendingApprovals via bridge events
    assert.equal(h.turn.pendingApprovals.has('req_web_1'), false);
    assert.equal(h.turn.pendingApprovals.has('req_web_2'), false);
    // 3. req_web_3 is still pending, so turn.state remains 'awaiting_approval'
    assert.equal(h.turn.pendingApprovals.has('req_web_3'), true);
    assert.equal(h.turn.state, 'awaiting_approval');

    // Resolve req_web_3
    const msg3 = {
        type: 'permission_response',
        turnId: 'turn_ack_1',
        requestId: 'req_web_3',
        decision: 'deny',
    };
    h.broker.handlePermissionResponseMessage(msg3);
    assert.equal((await p3).decision, 'deny');
    assert.equal(h.turn.pendingApprovals.size, 0);
    assert.equal(h.turn.state, 'streaming');
});

test('R1.4: Edge cases — expired request before write, deny ACK before write callback, lost ACK timeout, and cancel Turn A -> start Turn B isolation', async () => {
    // Case A: Deny/Timeout ACK arrives from bridge BEFORE the slow stdin write callback completes
    const hSlow = createAdapterBridgeHarness({turnId: 'turn_race_1', writeDelayMs: 40});
    hSlow.stdinPipe.removeAllListeners('data'); // Bridge will time out before write arrives

    const pRace = hSlow.broker.handlePermissionRequest({
        requestId: 'req_race_1',
        toolCallId: 'call_race_1',
        toolName: 'WebFetch',
        input: {url: 'https://developer.gnome.org/race'},
    });
    const reqRaceEvt = hSlow.hostEvents.find(e => e.type === 'permission_request' && e.requestId === 'req_race_1');

    // Start slow write with alwaysAllow: true
    const slowWritePromise = hSlow.adapter.respondPermission({
        turnId: 'turn_race_1',
        requestId: 'req_race_1',
        decision: 'allow',
        alwaysAllow: true,
        allowSessionRule: true,
        scopeKey: reqRaceEvt.scopeKey,
    });

    // While write is still in flight, bridge closes/denies the pending request (e.g. timeout)
    hSlow.broker.closeAllPending('审批等待超时');
    assert.equal((await pRace).decision, 'deny');
    assert.equal(hSlow.turn.pendingApprovals.has('req_race_1'), false);
    assert.equal(hSlow.approvedScopes.size, 0);

    // Now slow write callback completes — it MUST NOT re-add scopeKey or overwrite resolved state!
    await slowWritePromise;
    assert.equal(hSlow.approvedScopes.size, 0, 'Late write completion must never widen approvedScopes after deny ACK');
    assert.equal(hSlow.turn.pendingApprovals.size, 0);

    // Case B: Bridge ACK is lost (never arrives within ackTimeoutMs)
    const hLost = createAdapterBridgeHarness({turnId: 'turn_lost_ack'});
    hLost.stdinPipe.removeAllListeners('data'); // Blackhole stdin so bridge never ACKs
    const _pLost = hLost.broker.handlePermissionRequest({
        requestId: 'req_lost_1',
        toolCallId: 'call_lost_1',
        toolName: 'WebFetch',
        input: {url: 'https://developer.gnome.org/lost'},
    });
    const reqLostEvt = hLost.hostEvents.find(e => e.type === 'permission_request' && e.requestId === 'req_lost_1');

    const lostWriteRes = await hLost.adapter.respondPermission({
        turnId: 'turn_lost_ack',
        requestId: 'req_lost_1',
        decision: 'allow',
        alwaysAllow: true,
        allowSessionRule: true,
        scopeKey: reqLostEvt.scopeKey,
        ackTimeoutMs: 35,
    });
    assert.equal(lostWriteRes.sent, true);

    await new Promise(r => setTimeout(r, 60));
    assert.equal(hLost.approvedScopes.size, 0, 'Lost ACK must not grant session scope');
    assert.equal(hLost.turn.pendingApprovals.has('req_lost_1'), true, 'Unacknowledged request remains pending');
    assert.ok(
        hLost.hostEvents.some(e => e.type === 'permission_ack_timeout' && e.requestId === 'req_lost_1'),
        'Should emit permission_ack_timeout when bridge ACK is lost'
    );
    hLost.broker.closeAllPending('cleanup');

    // Case C: Cancel Turn A while approval write is in flight, then immediately start Turn B
    const hCancel = createAdapterBridgeHarness({turnId: 'turn_A', writeDelayMs: 35});
    const _pCancel = hCancel.broker.handlePermissionRequest({
        requestId: 'req_cancel_A',
        toolCallId: 'call_cancel_A',
        toolName: 'WebFetch',
        input: {url: 'https://developer.gnome.org/cancelA'},
    });
    const reqCancelEvt = hCancel.hostEvents.find(e => e.type === 'permission_request' && e.requestId === 'req_cancel_A');

    const writePromiseA = hCancel.adapter.respondPermission({
        turnId: 'turn_A',
        requestId: 'req_cancel_A',
        decision: 'allow',
        alwaysAllow: true,
        allowSessionRule: true,
        scopeKey: reqCancelEvt.scopeKey,
    });

    // Cancel Turn A and immediately start Turn B before writePromiseA finishes
    hCancel.turns.cancelActiveTurn();
    const turnB = hCancel.turns.beginTurn({
        turnId: 'turn_B',
        messageId: 'msg_B',
        sessionId: 'sess_r1',
        clientGeneration: 1,
        lifecycleGeneration: 1,
        backend: 'zcode',
    });
    hCancel.turns.markStreaming(turnB);

    await writePromiseA;
    assert.equal(hCancel.approvedScopes.size, 0, 'Cancelled Turn A must not add scopeKey');
    assert.equal(hCancel.turns.activeTurn, turnB);
    assert.equal(turnB.state, 'streaming');
    hCancel.broker.closeAllPending('cleanup');
});

test('R1.5: Real subprocess production path — spawnManagedCliTurn + ZCodeAdapter + zcodeBridge.cjs over OS pipes', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const {fileURLToPath} = await import('node:url');
    const {spawnManagedCliTurn} = await import('../runtime/processManager.js');

    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const bridgePath = path.join(repoRoot, 'zcodeBridge.cjs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-r1-subproc-'));

    try {
        const fakeZcodePath = path.join(tmpDir, 'zcode-fake.cjs');
        fs.writeFileSync(
            fakeZcodePath,
            `#!/usr/bin/env node
'use strict';
function DenyPermissionBroker() {}
Object.defineProperty(DenyPermissionBroker.prototype, 'requestPermission', {
    value: async () => ({decision: 'deny'}),
    writable: true,
    configurable: true,
});
const broker = new DenyPermissionBroker();
(async () => {
    const qRes = await broker.requestPermission({
        requestId: 'subproc_q_1',
        toolCallId: 'call_sub_q_1',
        toolName: 'AskUserQuestion',
        input: {
            questions: [
                {id: 'q_env', question: '部署环境？', options: [{label: 'staging'}, {label: 'prod'}], multiSelect: false}
            ]
        }
    });
    const webRes1 = await broker.requestPermission({
        requestId: 'subproc_web_1',
        toolCallId: 'call_sub_w_1',
        toolName: 'WebFetch',
        input: {url: 'https://developer.gnome.org/api'}
    });
    const webRes2 = await broker.requestPermission({
        requestId: 'subproc_web_2',
        toolCallId: 'call_sub_w_2',
        toolName: 'WebFetch',
        input: {url: 'https://developer.gnome.org/hig'}
    });
    process.stdout.write(JSON.stringify({
        type: 'result',
        sessionId: 'sess_subproc_r1',
        response: JSON.stringify({
            qDecision: qRes.decision,
            qAnswers: qRes.modifiedInput ? qRes.modifiedInput.answers : null,
            web1: webRes1.decision,
            web2: webRes2.decision,
        }),
        is_error: false,
    }) + '\\n');
    process.stdout.write(JSON.stringify({
        type: 'turn.completed',
    }) + '\\n');
    process.exit(0);
})();
`,
            {mode: 0o755}
        );

        const events = [];
        const approvedScopes = new Set();
        let settledPromiseResolve;
        const settledPromise = new Promise(r => { settledPromiseResolve = r; });

        const turns = new TurnController(evt => {
            events.push(evt);
            if (evt.type === 'agent_settled') {
                settledPromiseResolve(evt);
            }
        });

        const adapter = new ZCodeAdapter({
            turns,
            store: null,
            approvedScopes,
            getSessionContextConfig: () => ({}),
            emitEvent: evt => events.push(evt),
        });

        const turn = turns.beginTurn({
            turnId: 'turn_subproc_r1',
            messageId: 'msg_subproc_r1',
            sessionId: 'sess_subproc_r1',
            clientGeneration: 1,
            lifecycleGeneration: 1,
            backend: 'zcode',
            cancellable: new globalThis.__qcMockGio.Cancellable(),
        });

        // React to permission_request events asynchronously via ZCodeAdapter.respondPermission
        const handledIds = new Set();
        const pollAndRespond = async () => {
            for (let i = 0; i < 80; i++) {
                const qReq = events.find(e => e.type === 'permission_request' && e.requestId === 'subproc_q_1');
                if (qReq && !handledIds.has('subproc_q_1') && turn.pendingApprovals.has('subproc_q_1')) {
                    handledIds.add('subproc_q_1');
                    const mod = buildAskUserModifiedInput(qReq.rawInput, {
                        '部署环境？': {selectedLabels: ['staging'], customText: ''},
                    });
                    const r = await adapter.respondPermission({
                        turnId: 'turn_subproc_r1',
                        requestId: 'subproc_q_1',
                        decision: 'modify',
                        modifiedInput: mod,
                    });
                    assert.equal(r.sent, true);
                    await r.ackPromise;
                }
                const wReq = events.find(e => e.type === 'permission_request' && e.requestId === 'subproc_web_1');
                if (wReq && !handledIds.has('subproc_web_1') && turn.pendingApprovals.has('subproc_web_1')) {
                    handledIds.add('subproc_web_1');
                    const r = await adapter.respondPermission({
                        turnId: 'turn_subproc_r1',
                        requestId: 'subproc_web_1',
                        decision: 'allow',
                        alwaysAllow: true,
                        allowSessionRule: true,
                        scopeKey: wReq.scopeKey,
                    });
                    assert.equal(r.sent, true);
                    await r.ackPromise;
                    break;
                }
                await new Promise(r => setTimeout(r, 15));
            }
        };

        const turnPromise = spawnManagedCliTurn({
            backend: 'zcode',
            runtime: {
                executable: process.execPath,
                bridgePath,
                pathEnv: process.env.PATH || '',
                extraEnv: {
                    NODE_OPTIONS: `--require ${bridgePath}`,
                    QUICK_CHAT_FORCE_BRIDGE: '1',
                },
            },
            config: {mode: 'readonly'},
            workspace: tmpDir,
            sessionId: 'sess_subproc_r1',
            specialDirs: {home: tmpDir},
            turns,
            turn,
            store: null,
            approvedScopes,
            getSessionContextConfig: () => ({}),
            rawArgv: [process.execPath, fakeZcodePath],
            turnExtraEnv: {},
            keepStdinOpenForApproval: true,
            requireBridgeHandshake: true,
            effectiveMode: 'readonly',
        });

        await pollAndRespond();
        const settled = await settledPromise;
        await turnPromise;
        assert.equal(settled.status, 'completed');

        const parsedOut = JSON.parse(turn.text);
        assert.equal(parsedOut.qDecision, 'modify');
        assert.deepEqual(parsedOut.qAnswers, {'部署环境？': 'staging'});
        assert.equal(parsedOut.web1, 'allow');
        assert.equal(parsedOut.web2, 'allow');
        assert.equal(approvedScopes.size, 1);
    } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});

