import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TurnController} from '../core/turnController.js';

test('Cancel Turn A and immediately start Turn B: late callbacks from Turn A never corrupt Turn B', () => {
    const events = [];
    const persisted = [];
    const controller = new TurnController(evt => events.push(evt));

    let turnACancelled = false;
    const turnA = controller.beginTurn({
        backend: 'openai',
        promptText: 'Question A',
        cancellable: {cancel: () => { turnACancelled = true; }},
    });
    controller.markStreaming(turnA);
    controller.appendText(turnA, 'Partial A...');

    // User clicks Stop on Turn A
    controller.cancelActiveTurn({
        onPersistAssistant: m => persisted.push(m),
    });
    assert.equal(turnACancelled, true);
    assert.equal(turnA.finalized, true);
    assert.equal(controller.isBusy, false);

    // User immediately sends Question B
    const turnB = controller.beginTurn({
        backend: 'openai',
        promptText: 'Question B',
    });
    controller.markStreaming(turnB);
    controller.appendText(turnB, 'Answer B');

    // Late async network/process callback from Turn A arrives AFTER Turn B started!
    assert.equal(controller.isCurrent(turnA), false);
    assert.equal(controller.appendText(turnA, 'Stale A chunk'), false);
    assert.equal(controller.finalizeTurn(turnA, {
        errorText: 'Cancelled IO error',
        onPersistAssistant: m => persisted.push(m),
    }), false);

    // Turn B remains completely intact and active
    assert.equal(controller.isCurrent(turnB), true);
    assert.equal(turnB.text, 'Answer B');

    // Turn B finishes normally
    turnB.sawDoneMarker = true;
    assert.equal(controller.finalizeTurn(turnB, {
        onPersistAssistant: m => persisted.push(m),
    }), true);

    assert.equal(persisted.length, 2); // Partial A (saved on cancel) + Answer B
    const settledEvents = events.filter(e => e.type === 'agent_settled');
    assert.equal(settledEvents.length, 2);
    assert.deepEqual(settledEvents[0], {turnId: turnA.id, type: 'agent_settled', aborted: true});
    assert.deepEqual(settledEvents[1], {turnId: turnB.id, type: 'agent_settled', aborted: false});
});

test('Duplicate end events and simultaneous timeout + abort settle at most once and clean temp files', () => {
    const events = [];
    const cleanedFiles = [];
    let killCount = 0;
    const controller = new TurnController(evt => events.push(evt));

    const turn = controller.beginTurn({backend: 'zcode', promptText: 'Test'});
    turn.process = {pid: 12345};
    turn.tempFiles.push('/run/user/1000/gnome-quick-chat/zcode-provider-test.json');
    controller.markStreaming(turn);
    controller.appendText(turn, 'Hello world');

    // First settlement (e.g. watchdog timeout or EOF)
    const first = controller.finalizeTurn(turn, {
        onTerminateProcess: () => { killCount++; },
        onCleanupTempFiles: files => cleanedFiles.push(...files),
    });
    assert.equal(first, true);

    // Second settlement (e.g. late abort or duplicate turn.completed) is strictly a no-op
    const second = controller.finalizeTurn(turn, {
        errorText: 'Late error',
        onTerminateProcess: () => { killCount++; },
        onCleanupTempFiles: files => cleanedFiles.push(...files),
    });
    assert.equal(second, false);
    assert.equal(controller.cancelActiveTurn(), null);

    assert.equal(killCount, 1);
    assert.deepEqual(cleanedFiles, ['/run/user/1000/gnome-quick-chat/zcode-provider-test.json']);
    assert.equal(events.filter(e => e.type === 'message_end').length, 1);
    assert.equal(events.filter(e => e.type === 'agent_settled').length, 1);
});

test('Approval state pauses watchdog and only resumes watchdog once all pending approvals resolve', () => {
    const controller = new TurnController(() => {});
    const turn = controller.beginTurn({backend: 'zcode', promptText: 'Check web'});

    let pausedCount = 0;
    let resetCount = 0;
    turn.pauseWatchdog = () => { pausedCount++; };
    turn.resetWatchdog = () => { resetCount++; };

    controller.markStreaming(turn);
    assert.equal(turn.state, 'streaming');

    // Two parallel tool permission requests arrive
    controller.enterApproval(turn, 'perm_1');
    controller.enterApproval(turn, 'perm_2');
    assert.equal(turn.state, 'awaiting_approval');
    assert.equal(pausedCount, 2);
    assert.equal(resetCount, 0);

    // Resolving only the first approval keeps state in awaiting_approval without restarting timeout
    controller.leaveApproval(turn, 'perm_1');
    assert.equal(turn.state, 'awaiting_approval');
    assert.equal(resetCount, 0);

    // Resolving the final approval transitions back to streaming and explicitly resumes watchdog
    controller.leaveApproval(turn, 'perm_2');
    assert.equal(turn.state, 'streaming');
    assert.equal(resetCount, 1);
});
