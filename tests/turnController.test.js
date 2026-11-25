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
    assert.deepEqual(settledEvents[0], {
        turnId: turnA.id,
        messageId: turnA.messageId,
        sessionId: '',
        clientGeneration: 0,
        type: 'agent_settled',
        status: 'cancelled',
        aborted: true,
        timedOut: false,
        interrupted: false,
        errorMessage: '',
    });
    assert.deepEqual(settledEvents[1], {
        turnId: turnB.id,
        messageId: turnB.messageId,
        sessionId: '',
        clientGeneration: 0,
        type: 'agent_settled',
        status: 'completed',
        aborted: false,
        timedOut: false,
        interrupted: false,
        errorMessage: '',
    });
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

test('Assistant replies keep model identity, selected references and partial tool progress', () => {
    const events = [];
    const persisted = [];
    const controller = new TurnController(event => events.push(event));
    const marker = '[随问回执 test]';
    const address = 'memory://computer/project.md';
    const first = controller.beginTurn({
        backend: 'dsh', modelId: 'Terra', replyMarker: marker,
        allowedMemoryReferences: new Set([address]),
    });
    controller.appendText(first, '找到两个项目。\n[随问回');
    controller.appendText(first, '执 test]' + JSON.stringify({
        used: [address, 'memory://computer/not-read.md'],
        reason: '上次确认了项目',
        choices: ['项目 A', '项目 B'],
    }));
    controller.finalizeTurn(first, {status: 'completed', onPersistAssistant: message => persisted.push(message)});

    const second = controller.beginTurn({backend: 'dsh', modelId: 'Astra'});
    second.reportedModelId = 'Terra';
    controller.finalizeTurn(second, {status: 'failed', errorText: '模型不匹配',
        onPersistAssistant: message => persisted.push(message)});

    const retry = controller.beginTurn({backend: 'zcode', modelId: 'Astra'});
    controller.recordToolEnd(retry, {toolCallId: 'step-1', toolName: 'Read', executionOutcome: 'succeeded'});
    controller.recordToolEnd(retry, {toolCallId: 'step-2', toolName: 'Check', executionOutcome: 'failed'});
    controller.finalizeTurn(retry, {status: 'failed', errorText: '无法完成最后一步',
        onPersistAssistant: message => persisted.push(message)});

    assert.equal(persisted[0].modelId, 'Terra');
    assert.equal(persisted[0].backend, 'dsh');
    assert.deepEqual(persisted[0].memoryReferences, [address]);
    assert.deepEqual(persisted[0].taskChoices, ['项目 A', '项目 B']);
    assert.equal(persisted[0].content[0].text, '找到两个项目。');
    assert.ok(!JSON.stringify(events).includes('not-read.md'));
    assert.equal(persisted[1].selectedModelId, 'Astra');
    assert.equal(persisted[1].reportedModelId, 'Terra');
    assert.deepEqual(persisted[2].taskProgress, {completed: ['Read'], blocked: ['Check'], unconfirmed: []});
});
