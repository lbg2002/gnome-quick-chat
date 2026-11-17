import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {registerGiMocks} from './helpers/giMockLoader.js';

await registerGiMocks();

const {
    normalizeEvent,
    isMeaningfulProgressEvent,
} = await import('../protocol.js');
const {TurnController} = await import('../core/turnController.js');
const {
    computeToolDotVisualState,
    applyToolTraceEventToCard,
} = await import('../core/renderScheduler.js');
const {
    spawnManagedCliTurn,
    attachTurnWatchdog,
    attachApprovalWatchdog,
} = await import('../runtime/processManager.js');

function createMockCard() {
    return {
        role: 'assistant',
        text: '',
        thinking: '',
        toolNodes: [],
        dirtyToolNodeIds: new Set(),
        selectedNodeId: null,
        activeTool: false,
        dirty: {text: false, thinking: false, tools: false, toolsUrgent: false},
    };
}

test('R7.1: Map<toolCallId, state> / Set activeToolIds tracks tools idempotently across Codex and ZCode start/update events', () => {
    // 1. Codex item.started -> tool_execution_start, item.updated -> tool_execution_update
    const codexStarted = normalizeEvent('codex', {
        type: 'item.started',
        item: {id: 'cmd_1', type: 'command_execution', command: 'npm test'},
    });
    const codexUpdated = normalizeEvent('codex', {
        type: 'item.updated',
        item: {id: 'cmd_1', type: 'command_execution', command: 'npm test', aggregated_output: 'running...'},
    });
    assert.equal(codexStarted.type, 'tool_execution_start');
    assert.equal(codexUpdated.type, 'tool_execution_update');
    assert.equal(codexUpdated.detail, 'running...');

    // 2. ZCode tool.updated kind='started' vs kind='updated'
    const zcodeStarted = normalizeEvent('zcode', {
        type: 'tool.updated',
        payload: {kind: 'started', toolCallId: 'zt_1', toolName: 'Bash', input: {command: 'ls -la'}},
    });
    const zcodeUpdated = normalizeEvent('zcode', {
        type: 'tool.updated',
        payload: {kind: 'updated', toolCallId: 'zt_1', toolName: 'Bash', progress: '50%'},
    });
    assert.equal(zcodeStarted.type, 'tool_execution_start');
    assert.equal(zcodeUpdated.type, 'tool_execution_update');
    assert.equal(zcodeUpdated.detail, '50%');

    // 3. TurnController & Card idempotency: duplicate starts/updates never double-count activeToolIds or duplicate nodes
    const turns = new TurnController(() => {});
    const turn = turns.beginTurn({turnId: 'turn_r7_1', sessionId: 'sess_r7'});
    const card = createMockCard();

    turns.recordToolStart(turn, codexStarted);
    turns.recordToolStart(turn, codexStarted); // duplicate start
    turns.recordToolUpdate(turn, codexUpdated);
    assert.equal(turn.activeToolIds.size, 1);
    assert.equal(turn.toolExecutions.size, 1);
    assert.equal(turn.watchdogPhase, 'tool_execution');

    applyToolTraceEventToCard(card, codexStarted, {activeTurn: turn});
    applyToolTraceEventToCard(card, codexStarted, {activeTurn: turn});
    applyToolTraceEventToCard(card, codexUpdated, {activeTurn: turn});
    assert.equal(card.toolNodes.length, 1);
    assert.equal(card.toolNodes[0].status, 'running');
    assert.equal(card.toolNodes[0].detail, 'running...');
    assert.equal(computeToolDotVisualState(card.toolNodes[0]).colorClass, 'qc-dot-tool-running');

    // Finish cmd_1 and ensure late duplicate start/update cannot resurrect a finished tool
    const codexCompleted = normalizeEvent('codex', {
        type: 'item.completed',
        item: {id: 'cmd_1', type: 'command_execution', command: 'npm test', exit_code: 0},
    });
    turns.recordToolEnd(turn, codexCompleted);
    applyToolTraceEventToCard(card, codexCompleted, {activeTurn: turn});
    assert.equal(turn.activeToolIds.size, 0);
    assert.equal(turn.watchdogPhase, 'stream_idle');
    assert.equal(card.toolNodes[0].status, 'done');
    assert.equal(computeToolDotVisualState(card.toolNodes[0]).colorClass, 'qc-dot-tool-ok');

    // Late update after completion must not resurrect tool into activeToolIds or running state
    turns.recordToolUpdate(turn, codexUpdated);
    applyToolTraceEventToCard(card, codexUpdated, {activeTurn: turn});
    assert.equal(turn.activeToolIds.size, 0);
    assert.equal(card.toolNodes[0].status, 'done');
});

test('R7.2: Concurrent same-name tools, duplicate tool_execution_end, and tool_execution_end without start', () => {
    const turns = new TurnController(() => {});
    const turn = turns.beginTurn({turnId: 'turn_r7_2', sessionId: 'sess_r7'});
    const card = createMockCard();

    // Two concurrent Bash tools start
    const bash1Start = {type: 'tool_execution_start', toolCallId: 'bash_1', toolName: 'Bash', summary: 'sleep 1'};
    const bash2Start = {type: 'tool_execution_start', toolCallId: 'bash_2', toolName: 'Bash', summary: 'sleep 2'};
    turns.recordToolStart(turn, bash1Start);
    turns.recordToolStart(turn, bash2Start);
    applyToolTraceEventToCard(card, bash1Start, {activeTurn: turn});
    applyToolTraceEventToCard(card, bash2Start, {activeTurn: turn});

    assert.equal(turn.activeToolIds.size, 2);
    assert.equal(card.toolNodes.length, 2);
    assert.notEqual(card.toolNodes[0].id, card.toolNodes[1].id);

    // An orphan tool_execution_end for a third Bash tool ('bash_3') arrives WITHOUT a prior tool_execution_start.
    // Must NOT guess/hijack bash_1 or bash_2 by toolName!
    const bash3OrphanEnd = {
        type: 'tool_execution_end',
        toolCallId: 'bash_3',
        toolName: 'Bash',
        isError: false,
        detail: 'orphan completed',
    };
    turns.recordToolEnd(turn, bash3OrphanEnd);
    applyToolTraceEventToCard(card, bash3OrphanEnd, {activeTurn: turn});

    assert.equal(turn.activeToolIds.size, 2, 'bash_1 and bash_2 must remain active');
    assert.equal(turn.watchdogPhase, 'tool_execution');
    assert.equal(card.toolNodes.length, 3, 'orphan tool_execution_end must create its own node');
    assert.equal(card.toolNodes[0].status, 'running');
    assert.equal(card.toolNodes[1].status, 'running');
    assert.equal(card.toolNodes[2].toolCallId, 'bash_3');
    assert.equal(card.toolNodes[2].status, 'done');
    assert.equal(card.toolNodes[2].startedWithoutStartEvent, true);
    assert.equal(computeToolDotVisualState(card.toolNodes[2]).colorClass, 'qc-dot-tool-ok');

    // Duplicate tool_execution_end for bash_1 must not decrement bash_2 or alter bash_1's status
    const bash1End = {type: 'tool_execution_end', toolCallId: 'bash_1', toolName: 'Bash', isError: false, detail: 'ok 1'};
    turns.recordToolEnd(turn, bash1End);
    turns.recordToolEnd(turn, {...bash1End, isError: true, detail: 'late duplicate should be ignored'});
    applyToolTraceEventToCard(card, bash1End, {activeTurn: turn});
    applyToolTraceEventToCard(card, {...bash1End, isError: true, detail: 'late duplicate should be ignored'}, {activeTurn: turn});

    assert.equal(turn.activeToolIds.size, 1, 'bash_2 is still active');
    assert.equal(turn.activeToolIds.has('bash_2'), true);
    assert.equal(turn.watchdogPhase, 'tool_execution');
    assert.equal(card.toolNodes[0].status, 'done');
    assert.equal(card.toolNodes[0].detail, 'ok 1');
    assert.equal(card.toolNodes[1].status, 'running');
});

test('R7.3: Cross-batch tool_batch_end only modifies explicit IDs, never infers all tools succeeded on missing IDs, and uses unknown for unconfirmed batch ends', () => {
    const turns = new TurnController(() => {});
    const turn = turns.beginTurn({turnId: 'turn_r7_3', sessionId: 'sess_r7'});
    const card = createMockCard();

    for (const id of ['t_batch1_a', 't_batch1_b', 't_batch2_c']) {
        const startEv = {type: 'tool_execution_start', toolCallId: id, toolName: 'Read', summary: id};
        turns.recordToolStart(turn, startEv);
        applyToolTraceEventToCard(card, startEv, {activeTurn: turn});
    }
    // t_batch1_a completes normally before batch end
    const endA = {type: 'tool_execution_end', toolCallId: 't_batch1_a', toolName: 'Read', isError: false};
    turns.recordToolEnd(turn, endA);
    applyToolTraceEventToCard(card, endA, {activeTurn: turn});

    // 1. Empty tool_batch_end (missing toolCallIds) must NOT mark t_batch1_b or t_batch2_c as done!
    const emptyBatch = {type: 'tool_batch_end', toolCallIds: []};
    turns.recordToolBatchEnd(turn, emptyBatch);
    applyToolTraceEventToCard(card, emptyBatch, {activeTurn: turn});

    assert.equal(turn.activeToolIds.size, 2);
    assert.equal(turn.watchdogPhase, 'tool_execution');
    assert.equal(card.toolNodes[1].status, 'running');
    assert.equal(card.toolNodes[2].status, 'running');

    // 2. Batch 1 ends with ['t_batch1_a', 't_batch1_b'] while Batch 2 ('t_batch2_c') is still running.
    // Since t_batch1_b never emitted an individual tool_execution_end, its status becomes 'unknown' (not 'done'),
    // and t_batch2_c remains 'running' with watchdogPhase === 'tool_execution'!
    const batch1End = {type: 'tool_batch_end', toolCallIds: ['t_batch1_a', 't_batch1_b']};
    turns.recordToolBatchEnd(turn, batch1End);
    applyToolTraceEventToCard(card, batch1End, {activeTurn: turn});

    assert.equal(turn.activeToolIds.size, 1);
    assert.equal(turn.activeToolIds.has('t_batch2_c'), true);
    assert.equal(turn.watchdogPhase, 'tool_execution');

    assert.equal(card.toolNodes[0].status, 'done');
    assert.equal(computeToolDotVisualState(card.toolNodes[0]).colorClass, 'qc-dot-tool-ok');

    assert.equal(card.toolNodes[1].status, 'unknown');
    assert.equal(computeToolDotVisualState(card.toolNodes[1]).colorClass, 'qc-dot-tool-interrupted');

    assert.equal(card.toolNodes[2].status, 'running');
    assert.equal(computeToolDotVisualState(card.toolNodes[2]).colorClass, 'qc-dot-tool-running');
});

test('R7.4: Result arriving before permission_resolved ACK, parallel approvals, and cancellation in intermediate states', () => {
    const turns = new TurnController(() => {});
    const turn = turns.beginTurn({turnId: 'turn_r7_4', sessionId: 'sess_r7'});
    const card = createMockCard();

    // Two parallel approvals req_1 (tc_1) and req_2 (tc_2)
    const req1 = {
        type: 'permission_request',
        requestId: 'req_1',
        toolCallId: 'tc_1',
        toolName: 'Bash',
        summary: 'echo 1',
    };
    const req2 = {
        type: 'permission_request',
        requestId: 'req_2',
        toolCallId: 'tc_2',
        toolName: 'Bash',
        summary: 'echo 2',
    };
    turns.enterApproval(turn, 'req_1', req1);
    turns.enterApproval(turn, 'req_2', req2);
    applyToolTraceEventToCard(card, req1, {activeTurn: turn});
    applyToolTraceEventToCard(card, req2, {activeTurn: turn});

    assert.equal(turn.watchdogPhase, 'approval_wait');
    assert.equal(computeToolDotVisualState(card.toolNodes[0]).colorClass, 'qc-dot-tool-pending');
    assert.equal(computeToolDotVisualState(card.toolNodes[1]).colorClass, 'qc-dot-tool-pending');

    // Simulate user sending approval for req_1, and tool_execution_end for tc_1 arriving BEFORE permission_resolved ACK!
    card.toolNodes[0].status = 'sending_approval';
    card.toolNodes[0].approvalPhase = 'awaiting_ack';

    const earlyEnd1 = {
        type: 'tool_execution_end',
        toolCallId: 'tc_1',
        toolName: 'Bash',
        isError: false,
        detail: '1',
        duration: 45,
    };
    turns.recordToolEnd(turn, earlyEnd1);
    applyToolTraceEventToCard(card, earlyEnd1, {activeTurn: turn});
    assert.equal(card.toolNodes[0].status, 'done');

    // Now permission_resolved ACK for req_1 arrives:
    // Must mark approvalPhase='resolved' and approvalState='allowed' WITHOUT regressing status from 'done' to 'running',
    // and MUST keep turn.watchdogPhase === 'approval_wait' because req_2 is still pending!
    const ack1 = {
        type: 'permission_resolved',
        requestId: 'req_1',
        toolCallId: 'tc_1',
        toolName: 'Bash',
        decision: 'allow',
    };
    turns.resolveApprovalFromBridge(turn, ack1);
    applyToolTraceEventToCard(card, ack1, {activeTurn: turn});

    assert.equal(card.toolNodes[0].status, 'done', 'must not regress from done to running');
    assert.equal(card.toolNodes[0].approvalPhase, 'resolved');
    assert.equal(card.toolNodes[0].approvalState, 'allowed');
    assert.equal(computeToolDotVisualState(card.toolNodes[0]).colorClass, 'qc-dot-tool-ok');

    assert.equal(turn.pendingApprovals.size, 1, 'req_2 is still pending');
    assert.equal(turn.watchdogPhase, 'approval_wait', 'must stay in approval_wait while req_2 is pending');
    assert.equal(turn.state, 'awaiting_approval');
    assert.equal(card.selectedNodeId, card.toolNodes[1].id, 'selection advances to req_2');

    // Start a third tool tc_3 and then cancel the turn while req_2 is pending_approval and tc_3 is running
    const start3 = {type: 'tool_execution_start', toolCallId: 'tc_3', toolName: 'Bash', summary: 'sleep 10'};
    turns.recordToolStart(turn, start3);
    applyToolTraceEventToCard(card, start3, {activeTurn: turn});
    assert.equal(turn.watchdogPhase, 'approval_wait', 'tool start while approval pending must not leave approval_wait');

    turns.cancelActiveTurn();
    applyToolTraceEventToCard(card, {type: 'agent_settled', status: 'cancelled', aborted: true}, {activeTurn: turn});

    assert.equal(turn.state, 'cancelled');
    assert.equal(turn.watchdogPhase, 'settled');
    assert.equal(turn.toolExecutions.get('tc_1').status, 'done');
    assert.equal(turn.toolExecutions.get('tc_2').status, 'interrupted');
    assert.equal(turn.toolExecutions.get('tc_3').status, 'interrupted');

    assert.equal(card.toolNodes[0].status, 'done');
    assert.equal(card.toolNodes[1].status, 'interrupted');
    assert.equal(card.toolNodes[2].status, 'interrupted');
    assert.equal(computeToolDotVisualState(card.toolNodes[1]).colorClass, 'qc-dot-tool-interrupted');
    assert.equal(computeToolDotVisualState(card.toolNodes[2]).colorClass, 'qc-dot-tool-interrupted');
});

test('R7.5: 4-phase watchdog separation on real spawnManagedCliTurn — heartbeats/logs do not extend stream_idle, and totalTurnTimeoutSec caps long tools', async () => {
    // Verify isMeaningfulProgressEvent rejects heartbeats, logs, and empty updates
    assert.equal(isMeaningfulProgressEvent(null), false);
    assert.equal(isMeaningfulProgressEvent({type: 'heartbeat'}), false);
    assert.equal(isMeaningfulProgressEvent({type: 'log', message: 'tick'}), false);
    assert.equal(isMeaningfulProgressEvent({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: ''}}), false);
    assert.equal(isMeaningfulProgressEvent({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'ok'}}), true);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-r7-watchdog-'));
    try {
        // Case A: Fake CLI emits non-JSON logs and heartbeat JSON every 250ms, but no real progress.
        // streamIdleTimeoutSec = 1s must fire on schedule and record timedOutPhase === 'stream_idle'.
        const fakeHeartbeatCli = path.join(tmpDir, 'fake-heartbeat-cli.sh');
        fs.writeFileSync(
            fakeHeartbeatCli,
            [
                '#!/bin/sh',
                'while true; do',
                '  echo "[debug] keepalive log line"',
                '  echo \'{"type":"heartbeat","ts":123}\'',
                '  sleep 0.2',
                'done',
            ].join('\n'),
            {mode: 0o755}
        );

        let settledEventA = null;
        const turnsA = new TurnController(ev => {
            if (ev.type === 'agent_settled') settledEventA = ev;
        });
        const turnA = turnsA.beginTurn({turnId: 'turn_r7_5a', sessionId: 'sess_r7', backend: 'codex'});

        const settledPromiseA = new Promise(resolve => {
            const origOnEvent = turnsA._onEvent;
            turnsA._onEvent = ev => {
                origOnEvent?.(ev);
                if (ev.type === 'agent_settled') resolve(ev);
            };
        });

        await spawnManagedCliTurn({
            backend: 'codex',
            workspace: tmpDir,
            sessionId: 'sess_r7',
            turns: turnsA,
            turn: turnA,
            rawArgv: [fakeHeartbeatCli],
            timeouts: {
                streamIdleTimeoutSec: 1,
                toolExecutionTimeoutSec: 10,
                approvalTimeoutSec: 10,
                totalTurnTimeoutSec: 20,
            },
        });

        const resA = await settledPromiseA;
        assert.equal(resA.status, 'timed_out');
        assert.equal(turnA.timedOutPhase, 'stream_idle');
        assert.match(resA.errorMessage, /空闲超时/);

        // Case B: Fake CLI starts a long tool (toolExecutionTimeoutSec = 10s), but totalTurnTimeoutSec = 1s caps total runtime!
        const fakeLongToolCli = path.join(tmpDir, 'fake-long-tool-cli.sh');
        fs.writeFileSync(
            fakeLongToolCli,
            [
                '#!/bin/sh',
                'echo \'{"type":"item.started","item":{"id":"long_tool_1","type":"command_execution","command":"sleep 30"}}\'',
                'sleep 10',
            ].join('\n'),
            {mode: 0o755}
        );

        const turnsB = new TurnController(() => {});
        const turnB = turnsB.beginTurn({turnId: 'turn_r7_5b', sessionId: 'sess_r7', backend: 'codex'});
        let sawToolPhaseB = '';
        const settledPromiseB = new Promise(resolve => {
            turnsB._onEvent = ev => {
                if (ev.type === 'tool_execution_start') {
                    sawToolPhaseB = turnB.watchdogPhase;
                }
                if (ev.type === 'agent_settled') resolve(ev);
            };
        });

        await spawnManagedCliTurn({
            backend: 'codex',
            workspace: tmpDir,
            sessionId: 'sess_r7',
            turns: turnsB,
            turn: turnB,
            rawArgv: [fakeLongToolCli],
            timeouts: {
                streamIdleTimeoutSec: 5,
                toolExecutionTimeoutSec: 10,
                approvalTimeoutSec: 10,
                totalTurnTimeoutSec: 1,
            },
        });

        const resB = await settledPromiseB;
        assert.equal(sawToolPhaseB, 'tool_execution');
        assert.equal(resB.status, 'timed_out');
        assert.equal(turnB.timedOutPhase, 'total_turn');
        assert.match(resB.errorMessage, /总时长超出安全上限/);
        assert.equal(turnB.toolExecutions.get('long_tool_1')?.status, 'interrupted');
    } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});
