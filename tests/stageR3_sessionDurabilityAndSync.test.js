/**
 * Stage R3 Regression & Production-Path Tests:
 * 1. Write failure A -> Write success B -> Flush error reporting -> Restart & idempotent retryFailedWrites recovery
 * 2. Transactional rewindFromUserMessage rollback on disk write failure & extension.js abort on !rw.ok
 * 3. Rapid double-click Retry (↻) and Rewind vs. New/Delete session concurrency mutex
 * 4. remoteSyncedRevision advances ONLY on backend protocol confirmation; CLI spawn failure invalidates remote resume
 *    and prevents duplicate prompt injection or auto-retrying side-effecting tasks
 * 5. Cancelled partial CLI turn invalidates remoteSessionId and resumes cleanly from local context
 * 6. Two loaded SessionStoreEngine instances writing concurrently to the same sessionId without data loss
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
    SessionStoreEngine,
} from '../core/sessionEngine.js';
import {
    buildRuntimeContextSignature,
    buildCrossBackendPromptWithContext,
} from '../core/contextManager.js';
import {
    HistoryWindowController,
} from '../core/renderScheduler.js';
import {
    TurnController,
} from '../core/turnController.js';
import {registerGiMocks} from './helpers/giMockLoader.js';

registerGiMocks();

const {ZCodeAdapter} = await import('../backends/zcodeAdapter.js');
const {BackendClient} = await import('../backendClient.js');

function createControllableIo({delayMs = 0} = {}) {
    let failPredicate = null;
    let writeCount = 0;
    const sleep = () => (delayMs > 0 ? new Promise(r => setTimeout(r, delayMs)) : Promise.resolve());

    return {
        setFailPredicate(fn) {
            failPredicate = fn;
        },
        get writeCount() {
            return writeCount;
        },
        async exists(filePath) {
            try {
                await fs.access(filePath);
                return true;
            } catch {
                return false;
            }
        },
        async readText(filePath) {
            await sleep();
            return fs.readFile(filePath, 'utf8');
        },
        async appendLine(filePath, lineOrBlock) {
            await sleep();
            writeCount++;
            if (failPredicate && failPredicate('appendLine', filePath, lineOrBlock, writeCount)) {
                throw new Error('模拟磁盘写入失败 (ENOSPC: appendLine)');
            }
            await fs.mkdir(path.dirname(filePath), {recursive: true, mode: 0o700});
            const normalized = lineOrBlock.endsWith('\n') ? lineOrBlock : `${lineOrBlock}\n`;
            await fs.appendFile(filePath, normalized, {encoding: 'utf8', mode: 0o600});
        },
        async replaceFile(filePath, content) {
            await sleep();
            writeCount++;
            if (failPredicate && failPredicate('replaceFile', filePath, content, writeCount)) {
                throw new Error('模拟磁盘写入失败 (ENOSPC: replaceFile)');
            }
            await fs.mkdir(path.dirname(filePath), {recursive: true, mode: 0o700});
            const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
            await fs.writeFile(tmp, content, {encoding: 'utf8', mode: 0o600});
            await fs.rename(tmp, filePath);
        },
        async unlink(filePath) {
            try {
                await fs.unlink(filePath);
            } catch {}
        },
    };
}

test('R3.1: Write failure A -> Write success B -> flush reports failure -> restart shows why masking is fatal -> retryFailedWrites recovers A & B idempotently', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-r3-writefail-'));
    try {
        const io = createControllableIo();
        const saveErrors = [];
        const store = new SessionStoreEngine('sess_r3_1', {
            sessionsRootDir: tmpRoot,
            io,
            maxWriteRetries: 1,
            retryDelayMs: 2,
            onSaveError: err => saveErrors.push(err),
        });
        await store.load('zcode', {model: 'glm-5'});

        // 1. Fail Write A (revision 1) across all retry attempts
        io.setFailPredicate((op, filePath, content) => String(content).includes('msg_A'));
        const writeARes = await store.appendMessage(
            {id: 'msg_A', role: 'user', content: '第一条：磁盘满时写入的提问'},
            'zcode',
            {model: 'glm-5'}
        );
        assert.equal(writeARes.ok, false);
        assert.equal(store.hasUnsavedChanges, true);
        assert.equal(store.durableRevision, 0);
        assert.equal(store.revision, 1);
        assert.deepEqual(store.failedRevisions, [1]);
        assert.equal(saveErrors.length, 1);

        // 2. Write B (revision 2) succeeds on disk!
        io.setFailPredicate(null);
        const writeBRes = await store.appendMessage(
            {id: 'msg_B', role: 'assistant', content: '第二条：磁盘恢复后写入的回答', replyTo: 'msg_A'},
            'zcode',
            {model: 'glm-5'}
        );
        assert.equal(writeBRes.ok, true);

        // CRITICAL R3 ASSERTION: Write B's incremental success MUST NOT clear Write A's failure!
        assert.equal(store.hasUnsavedChanges, true, 'Subsequent incremental write B must not mask failed write A');
        assert.ok(store.lastWriteError, 'lastWriteError must remain populated while msg_A is unsaved');
        assert.deepEqual(store.failedRevisions, [1]);
        assert.equal(store.durableRevision, 0, 'durableRevision must not advance past failed revision 1');
        assert.equal(store.revision, 2);

        // 3. flush() and BackendClient flush_session must return real failure status + failedRevisions
        const flushStatus = await store.flush();
        assert.equal(flushStatus.ok, false);
        assert.equal(flushStatus.flushed, false);
        assert.equal(flushStatus.hasUnsavedChanges, true);
        assert.deepEqual(flushStatus.failedRevisions, [1]);

        const fakeClient = Object.create(BackendClient.prototype);
        fakeClient._store = store;
        fakeClient._disposed = false;
        fakeClient._started = true;
        const clientFlush = await fakeClient.request('flush_session');
        assert.equal(clientFlush.ok, false);
        assert.equal(clientFlush.flushed, false);
        assert.equal(clientFlush.hasUnsavedChanges, true);
        assert.deepEqual(clientFlush.failedRevisions, [1]);

        // 4. Simulate cold restart from disk BEFORE recovery: disk only has msg_B, proving msg_A was not on disk
        const rawBeforeRetry = await fs.readFile(store.jsonlPath, 'utf8');
        const diskIdsBeforeRetry = rawBeforeRetry.trim().split('\n').map(l => JSON.parse(l).id);
        assert.deepEqual(diskIdsBeforeRetry, ['msg_B']);
        // Meanwhile, in-memory history still holds both msg_A and msg_B for export or retry!
        assert.deepEqual(store.messages.map(m => m.id), ['msg_A', 'msg_B']);

        // 5. Call retry_save_session / retryFailedWrites(): idempotently writes full snapshot [msg_A, msg_B]
        const retryRes = await fakeClient.request('retry_save_session');
        assert.equal(retryRes.ok, true);
        assert.equal(retryRes.hasUnsavedChanges, false);
        assert.equal(retryRes.durableRevision, 2);
        assert.deepEqual(retryRes.failedRevisions, []);
        assert.equal(store.lastWriteError, null);

        const flushAfterRetry = await store.flush();
        assert.equal(flushAfterRetry.ok, true);
        assert.equal(flushAfterRetry.flushed, true);
        assert.equal(flushAfterRetry.durableRevision, 2);

        // 6. Restart in a new SessionStoreEngine instance: both msg_A and msg_B are recovered in order without duplicates!
        const restartedStore = new SessionStoreEngine('sess_r3_1', {
            sessionsRootDir: tmpRoot,
            io: createControllableIo(),
        });
        await restartedStore.load('zcode', {model: 'glm-5'});
        assert.deepEqual(restartedStore.messages.map(m => m.id), ['msg_A', 'msg_B']);
        assert.deepEqual(restartedStore.messages.map(m => m.revision), [1, 2]);
        assert.equal(restartedStore.durableRevision, 2);
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('R3.2: Transactional rewindFromUserMessage rolls back memory on disk write failure and stops extension prompt dispatch', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-r3-rewind-tx-'));
    try {
        const io = createControllableIo();
        const store = new SessionStoreEngine('sess_r3_rewind', {
            sessionsRootDir: tmpRoot,
            io,
            maxWriteRetries: 1,
            retryDelayMs: 2,
            buildContextSignature: buildRuntimeContextSignature,
        });
        const cfg = {provider: 'glm', model: 'glm-5', workspace: '/tmp/ws', effectiveMode: 'readonly'};
        await store.load('zcode', cfg);

        await store.appendMessage({id: 'u1', role: 'user', content: '问题1'}, 'zcode', cfg);
        await store.appendMessage({id: 'a1', role: 'assistant', content: '回答1', replyTo: 'u1'}, 'zcode', cfg);
        await store.appendMessage({id: 'u2', role: 'user', content: '问题2'}, 'zcode', cfg);
        await store.appendMessage({id: 'a2', role: 'assistant', content: '回答2', replyTo: 'u2'}, 'zcode', cfg);
        await store.confirmRemoteTurnSynced('zcode_remote_tx_1', 'zcode', cfg);
        await store.flush();

        assert.equal(store.messages.length, 4);
        assert.equal(store.remoteSessionId, 'zcode_remote_tx_1');
        assert.equal(store.revision, 4);

        // Force disk write failure during rewind
        io.setFailPredicate(() => true);

        let revokedScopesCount = 0;
        const client = Object.create(BackendClient.prototype);
        client._store = store;
        client._sessionId = 'sess_r3_rewind';
        client._disposed = false;
        client._started = true;
        client.revokeApprovedScopes = () => {
            revokedScopesCount++;
        };

        const rwRes = await client.request('rewind_from_user_turn', {
            userMessageId: 'u2',
            sessionId: 'sess_r3_rewind',
        });

        // Rewind MUST report ok: false and roll back memory so memory, disk, and UI stay 100% consistent!
        assert.equal(rwRes.ok, false);
        assert.equal(rwRes.rolledBack, true);
        assert.match(rwRes.error, /模拟磁盘写入失败/);
        assert.equal(revokedScopesCount, 0, 'Must not revoke scopes when rewind transaction rolled back');

        assert.deepEqual(store.messages.map(m => m.id), ['u1', 'a1', 'u2', 'a2']);
        assert.equal(store.remoteSessionId, 'zcode_remote_tx_1');
        assert.equal(store.revision, 4);

        // Now verify extension.js _executePromptTurn aborts on !rw.ok without truncating UI or sending prompt!
        const {default: QuickChatExtension} = await import('../extension.js');
        const hw = new HistoryWindowController({initialPageSize: 24, maxMountedActors: 48});
        const initialUiMsgs = store.messages.map(m => ({
            id: m.id,
            role: m.role,
            text: typeof m.content === 'string' ? m.content : m.content[0].text,
            replyTo: m.replyTo || '',
        }));
        hw.reset(initialUiMsgs);
        hw.registerMountedInitialCards(initialUiMsgs.map(m => ({
            messageId: m.id,
            role: m.role,
            text: m.text,
            replyTo: m.replyTo,
        })));

        let promptSentCount = 0;
        let lastStatus = null;
        const ext = Object.create(QuickChatExtension.prototype);
        ext._enabled = true;
        ext._lifecycleGeneration = 1;
        ext._sessionMutationLock = false;
        ext._isSessionUnlockedAndAlive = () => true;
        ext._getSettingString = () => 'sess_r3_rewind';
        ext._setBusy = () => {};
        ext._recordPromptHistory = () => {};
        ext._panel = {
            historyWindow: hw,
            isSessionMenuOpen: false,
            closeSlashMenu() {},
            setRouteSuggestion() {},
            setStatusIndicator(kind, text) {
                lastStatus = {kind, text};
            },
            truncateMessagesFromId(id, opts) {
                hw.truncateFromMessageId(id, opts);
            },
        };
        ext._chatController = {
            ready: true,
            busy: false,
            clientGeneration: 1,
            currentSessionId: 'sess_r3_rewind',
            client: {
                async request(type, fields) {
                    if (type === 'rewind_from_user_turn') {
                        return client.request(type, fields);
                    }
                    if (type === 'prompt') {
                        promptSentCount++;
                        return {disposition: 'streaming'};
                    }
                    return {};
                },
            },
        };

        await ext._executePromptTurn({
            promptText: '问题2',
            displayUserText: '问题2',
            rewindUserMessageId: 'u2',
            reuseExistingUserCard: true,
            userMessageId: 'u2',
        });

        assert.equal(promptSentCount, 0, 'Must NOT send prompt when rewind_from_user_turn returns ok: false');
        assert.equal(lastStatus?.kind, 'error');
        assert.match(lastStatus?.text || '', /回退历史失败/);
        assert.deepEqual(
            hw.mountedCards.map(c => c.messageId),
            ['u1', 'a1', 'u2', 'a2'],
            'UI cards must NOT be truncated when rewind disk write fails'
        );
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('R3.3: Rapid double-click Retry (↻) and Rewind vs. New/Delete session concurrency are serialized by _sessionMutationLock', async () => {
    const {default: QuickChatExtension} = await import('../extension.js');
    const hw = new HistoryWindowController({initialPageSize: 24, maxMountedActors: 48});
    const cards = [
        {messageId: 'u1', role: 'user', text: '问题1', replyTo: ''},
        {messageId: 'a1', role: 'assistant', text: '回答1', replyTo: 'u1'},
    ];
    hw.reset(cards.map(c => ({id: c.messageId, role: c.role, text: c.text, replyTo: c.replyTo})));
    hw.registerMountedInitialCards(cards);

    let rewindCalls = 0;
    let promptCalls = 0;
    let currentSessionId = 'sess_initial';

    const ext = Object.create(QuickChatExtension.prototype);
    ext._enabled = true;
    ext._lifecycleGeneration = 1;
    ext._sessionMutationLock = false;
    ext._isSessionUnlockedAndAlive = () => true;
    ext._getSettingString = key => (key === 'session-id' ? currentSessionId : '');
    ext._hasKey = () => true;
    ext._settings = {
        set_string(key, val) {
            if (key === 'session-id') currentSessionId = val;
        },
    };
    ext._rememberPreviousNonEmptySessionId = () => {};
    ext._resetTransientComposerState = () => {};
    ext._ensureClient = () => Promise.resolve();
    ext._recordPromptHistory = () => {};
    ext._setBusy = val => {
        ext._chatController.busy = val;
    };
    ext._panel = {
        historyWindow: hw,
        isSessionMenuOpen: false,
        closeSlashMenu() {},
        setRouteSuggestion() {},
        setStatusIndicator() {},
        truncateMessagesFromId(id, opts) {
            hw.truncateFromMessageId(id, opts);
        },
        scrollBottom() {},
        clearMessages() {},
    };
    ext._chatController = {
        ready: true,
        busy: false,
        clientGeneration: 1,
        get currentSessionId() {
            return currentSessionId;
        },
        stopClient() {
            this.clientGeneration++;
        },
        client: {
            revokeApprovedScopes() {},
            async request(type) {
                if (type === 'rewind_from_user_turn') {
                    rewindCalls++;
                    await new Promise(r => setTimeout(r, 25));
                    return {ok: true, targetUserMessage: {id: 'u1'}};
                }
                if (type === 'prompt') {
                    promptCalls++;
                    return {disposition: 'streaming'};
                }
                return {};
            },
        },
    };

    // 1. Rapid double-click on Retry (↻) in the same tick + concurrent _newSession() while rewind is awaiting!
    ext._retryForAssistantCard(cards[1]);
    ext._retryForAssistantCard(cards[1]); // Blocked by _sessionMutationLock!
    await ext._newSession(); // Blocked by _sessionMutationLock!

    // Wait for first retry to complete rewind + prompt dispatch
    await new Promise(r => setTimeout(r, 50));
    assert.equal(rewindCalls, 1, 'Second concurrent retry click must be blocked by _sessionMutationLock');
    assert.equal(promptCalls, 1, 'Only one prompt turn may be dispatched');
    assert.equal(currentSessionId, 'sess_initial', '_newSession during active rewind must be blocked');
});

test('R3.4: remoteSyncedRevision advances ONLY on backend confirmation; CLI spawn failure invalidates remoteSessionId and avoids duplicate prompt injection', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-r3-remotesync-'));
    try {
        const io = createControllableIo();
        const cfg = {provider: '', model: '', workspace: tmpRoot, mode: 'full', effectiveMode: 'full'};
        const store = new SessionStoreEngine('sess_r3_sync', {
            sessionsRootDir: tmpRoot,
            io,
            buildContextSignature: buildRuntimeContextSignature,
        });
        await store.load('zcode', cfg);

        // Fake ZCode CLI script that succeeds on Turn 1, emitting session_id = 'zcode_remote_turn1'
        const fakeCliPath = path.join(tmpRoot, 'fake-zcode-r3.mjs');
        await fs.writeFile(
            fakeCliPath,
            `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const recordFile = process.env.QC_TEST_ARGS_LOG || '';
const promptFile = process.env.QUICK_CHAT_PROMPT_FILE || '';
const promptContent = promptFile && fs.existsSync(promptFile)
    ? fs.readFileSync(promptFile, 'utf8')
    : args.join('\\n');
if (recordFile) {
    fs.appendFileSync(recordFile, JSON.stringify({args, promptContent}) + '\\n', 'utf8');
}
process.stdout.write(JSON.stringify({
    type: 'session.created',
    sessionId: 'zcode_remote_turn1',
}) + '\\n');
process.stdout.write(JSON.stringify({
    type: 'model.streaming',
    payload: {kind: 'text_delta', delta: '第一轮回答完成'},
}) + '\\n');
process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'zcode_remote_turn1',
    result: '第一轮回答完成',
}) + '\\n');
process.exit(0);
`,
            {mode: 0o755}
        );

        const argsLogPath = path.join(tmpRoot, 'cli-invocations.jsonl');
        process.env.QC_TEST_ARGS_LOG = argsLogPath;

        let settledEvents = [];
        const turns = new TurnController(ev => {
            if (ev.type === 'agent_settled') settledEvents.push(ev);
        });

        const runtime = {
            executable: process.execPath,
            commandPrefix: [process.execPath, fakeCliPath],
            setsidPath: '',
            bridgePath: path.join(process.cwd(), 'zcodeBridge.cjs'),
            cliCapabilities: {
                probeSucceeded: true,
                supportsStreamJson: true,
                supportsPromptFlag: true,
                supportsResume: true,
                supportsDangerouslySkipPermissions: true,
            },
            resolvedProvider: 'glm',
            resolvedModel: '',
            label: 'glm-5',
        };

        const adapter = new ZCodeAdapter({
            turns,
            store,
            approvedScopes: new Set(),
            getSessionContextConfig: () => cfg,
        });
        adapter.initialize(runtime, cfg);

        // --- Turn 1: Succeeds and confirms remoteSyncedRevision ---
        await adapter.sendMessage({
            promptText: '第一问：你好',
            turnMeta: {turnId: 'turn_1', messageId: 'asst_1', userMessageId: 'user_1'},
            workspace: tmpRoot,
            sessionId: 'sess_r3_sync',
            specialDirs: {home: tmpRoot},
        });
        while (settledEvents.length < 1) {
            await new Promise(r => setTimeout(r, 15));
        }
        assert.equal(settledEvents[0].status, 'completed');
        assert.equal(store.remoteSessionId, 'zcode_remote_turn1');
        assert.equal(store.revision, 2);
        assert.equal(store.meta.remoteSyncedRevision, 2, 'remoteSyncedRevision must equal 2 after Turn 1 completes');

        // Verify local appendMessage alone does NOT advance remoteSyncedRevision!
        await store.appendMessage({id: 'local_unconfirmed', role: 'user', content: '未确认本地提问'}, 'zcode', cfg);
        assert.equal(store.revision, 3);
        assert.equal(
            store.meta.remoteSyncedRevision,
            2,
            'appendMessage MUST NOT advance remoteSyncedRevision before backend confirmation'
        );
        // Rewind the temporary test message back and re-confirm Turn 1 state for Turn 2 spawn test
        const rw = store.rewindFromUserMessage('local_unconfirmed', {archiveRemoved: false});
        await rw.writePromise;
        await store.confirmRemoteTurnSynced('zcode_remote_turn1', 'zcode', cfg);
        assert.equal(store.remoteSessionId, 'zcode_remote_turn1');
        assert.equal(store.meta.remoteSyncedRevision, store.revision);

        // --- Turn 2: Simulate CLI spawn failure on a side-effecting prompt ---
        runtime.executable = '/nonexistent/binary/that/fails/spawn';
        runtime.commandPrefix = ['/nonexistent/binary/that/fails/spawn'];
        await assert.rejects(
            () => adapter.sendMessage({
                promptText: '删除临时缓存目录 /tmp/danger',
                turnMeta: {turnId: 'turn_2', messageId: 'asst_2', userMessageId: 'user_2'},
                workspace: tmpRoot,
                sessionId: 'sess_r3_sync',
                specialDirs: {home: tmpRoot},
            })
        );

        // After spawn failure, remoteSessionId MUST be invalidated!
        assert.equal(store.remoteSessionId, '', 'CLI spawn failure must invalidate remoteSessionId');
        assert.equal(store.meta.remoteSyncedRevision, 0);

        // --- Turn 3A: User retries the exact same prompt -> must NOT duplicate the prompt in context! ---
        const retryContextPrompt = buildCrossBackendPromptWithContext(
            store.messages,
            '删除临时缓存目录 /tmp/danger'
        );
        const occurrences = retryContextPrompt.split('删除临时缓存目录 /tmp/danger').length - 1;
        assert.equal(
            occurrences,
            1,
            'Retrying a failed unanswered prompt must NOT inject the prompt twice into local context'
        );

        // --- Turn 3B: User decides NOT to retry Turn 2 and asks a new safe question in Turn 3 ---
        runtime.executable = process.execPath;
        runtime.commandPrefix = [process.execPath, fakeCliPath];
        await adapter.sendMessage({
            promptText: '第三问：现在只查看当前状态',
            turnMeta: {turnId: 'turn_3', messageId: 'asst_3', userMessageId: 'user_3'},
            workspace: tmpRoot,
            sessionId: 'sess_r3_sync',
            specialDirs: {home: tmpRoot},
        });
        while (settledEvents.length < 3) {
            await new Promise(r => setTimeout(r, 15));
        }
        assert.equal(settledEvents.at(-1).status, 'completed');

        const invocations = (await fs.readFile(argsLogPath, 'utf8'))
            .trim()
            .split('\n')
            .map(l => JSON.parse(l));
        assert.equal(invocations.length, 2); // Turn 1 and Turn 3B
        const turn3Call = invocations[1];
        assert.ok(
            !turn3Call.args.some(a => String(a).startsWith('--resume')),
            'Turn 3 after spawn failure must NOT use --resume'
        );
        assert.match(turn3Call.promptContent, /第一问：你好/);
        assert.match(turn3Call.promptContent, /第一轮回答完成/);
        assert.doesNotMatch(
            turn3Call.promptContent,
            /删除临时缓存目录/,
            'Unanswered failed side-effecting Turn 2 must NOT be injected into Turn 3 context'
        );
        assert.match(turn3Call.promptContent, /第三问：现在只查看当前状态/);
    } finally {
        delete process.env.QC_TEST_ARGS_LOG;
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('R3.5: Cancelled partial CLI turn invalidates remoteSessionId and next turn resumes cleanly from local context', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-r3-cancelpartial-'));
    try {
        const io = createControllableIo();
        const cfg = {provider: '', model: '', workspace: tmpRoot, mode: 'full', effectiveMode: 'full'};
        const store = new SessionStoreEngine('sess_r3_cancel', {
            sessionsRootDir: tmpRoot,
            io,
            buildContextSignature: buildRuntimeContextSignature,
        });
        await store.load('zcode', cfg);

        const fakeCliPath = path.join(tmpRoot, 'fake-zcode-partial.mjs');
        await fs.writeFile(
            fakeCliPath,
            `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const logFile = process.env.QC_CANCEL_TEST_LOG || '';
const promptFile = process.env.QUICK_CHAT_PROMPT_FILE || '';
const promptText = promptFile && fs.existsSync(promptFile)
    ? fs.readFileSync(promptFile, 'utf8')
    : args.join('\\n');
if (logFile) {
    fs.appendFileSync(logFile, JSON.stringify({args, promptText}) + '\\n', 'utf8');
}
process.stdout.write(JSON.stringify({
    type: 'session.created',
    sessionId: 'zcode_sess_partial_99',
}) + '\\n');

if (promptText.includes('第二问：需要中途取消') && !promptText.includes('第三问：基于上文继续')) {
    process.stdout.write(JSON.stringify({
        type: 'model.streaming',
        payload: {kind: 'text_delta', delta: '这是取消前生成的半截回答'},
    }) + '\\n');
    // Stay alive until cancelled
    setInterval(() => {}, 1000);
} else {
    process.stdout.write(JSON.stringify({
        type: 'model.streaming',
        payload: {kind: 'text_delta', delta: '正常完整回答'},
    }) + '\\n');
    process.stdout.write(JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 'zcode_sess_partial_99',
        result: '正常完整回答',
    }) + '\\n');
    process.exit(0);
}
`,
            {mode: 0o755}
        );

        const callLogPath = path.join(tmpRoot, 'cancel-calls.jsonl');
        process.env.QC_CANCEL_TEST_LOG = callLogPath;

        const events = [];
        const turns = new TurnController(ev => events.push(ev));
        const runtime = {
            executable: process.execPath,
            commandPrefix: [process.execPath, fakeCliPath],
            setsidPath: '',
            bridgePath: path.join(process.cwd(), 'zcodeBridge.cjs'),
            cliCapabilities: {
                probeSucceeded: true,
                supportsStreamJson: true,
                supportsPromptFlag: true,
                supportsResume: true,
                supportsDangerouslySkipPermissions: true,
            },
            resolvedProvider: 'glm',
            resolvedModel: '',
            label: 'glm-5',
        };
        const adapter = new ZCodeAdapter({
            turns,
            store,
            approvedScopes: new Set(),
            getSessionContextConfig: () => cfg,
        });
        adapter.initialize(runtime, cfg);

        // Turn 1: completes normally
        await adapter.sendMessage({
            promptText: '第一问：基础背景',
            turnMeta: {turnId: 't1', messageId: 'a1', userMessageId: 'u1'},
            workspace: tmpRoot,
            sessionId: 'sess_r3_cancel',
            specialDirs: {home: tmpRoot},
        });
        while (!events.some(e => e.turnId === 't1' && e.type === 'agent_settled')) {
            await new Promise(r => setTimeout(r, 15));
        }
        assert.equal(store.remoteSessionId, 'zcode_sess_partial_99');

        // Turn 2: streams partial output, then user cancels!
        await adapter.sendMessage({
            promptText: '第二问：需要中途取消',
            turnMeta: {turnId: 't2', messageId: 'a2', userMessageId: 'u2'},
            workspace: tmpRoot,
            sessionId: 'sess_r3_cancel',
            specialDirs: {home: tmpRoot},
        });
        while (!events.some(e => e.turnId === 't2' && e.type === 'message_update')) {
            await new Promise(r => setTimeout(r, 15));
        }
        // Notice: even though session_bound arrived in Turn 2, remoteSyncedRevision was NOT advanced to Turn 2!
        assert.equal(store.meta.remoteSyncedRevision, 2);

        const cancelRes = await adapter.cancel('t2');
        assert.equal(cancelRes.aborted, true);
        assert.equal(store.remoteSessionId, '', 'Cancelling a turn must invalidate remoteSessionId');
        assert.equal(store.meta.remoteSyncedRevision, 0);

        const partialMsg = store.messages.find(m => m.id === 'a2');
        assert.ok(partialMsg, 'Partial assistant reply must be preserved in local session store');
        assert.equal(partialMsg.status, 'cancelled');
        assert.equal(partialMsg.partial, true);

        // Turn 3: resumes from local context (without --resume) including Turn 1 and Turn 2's partial reply
        await adapter.sendMessage({
            promptText: '第三问：基于上文继续',
            turnMeta: {turnId: 't3', messageId: 'a3', userMessageId: 'u3'},
            workspace: tmpRoot,
            sessionId: 'sess_r3_cancel',
            specialDirs: {home: tmpRoot},
        });
        while (!events.some(e => e.turnId === 't3' && e.type === 'agent_settled')) {
            await new Promise(r => setTimeout(r, 15));
        }

        const calls = (await fs.readFile(callLogPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
        assert.equal(calls.length, 3);
        assert.ok(calls[1].args.some(a => String(a).startsWith('--resume')), 'Turn 2 used --resume from Turn 1');
        assert.ok(!calls[2].args.some(a => String(a).startsWith('--resume')), 'Turn 3 after cancelled Turn 2 must NOT use --resume');
        assert.match(calls[2].promptText, /第一问：基础背景/);
        assert.match(calls[2].promptText, /这是取消前生成的半截回答/);
        assert.match(calls[2].promptText, /第三问：基于上文继续/);
    } finally {
        delete process.env.QC_CANCEL_TEST_LOG;
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('R3.6: Two loaded SessionStoreEngine instances for the same sessionId coordinate revisions and never overwrite each other', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-r3-dualstore-'));
    try {
        const io1 = createControllableIo({delayMs: 5});
        const io2 = createControllableIo({delayMs: 5});

        const store1 = new SessionStoreEngine('dual_sess', {
            sessionsRootDir: tmpRoot,
            io: io1,
            maxHotMessages: 6,
        });
        const store2 = new SessionStoreEngine('dual_sess', {
            sessionsRootDir: tmpRoot,
            io: io2,
            maxHotMessages: 6,
        });

        await store1.load('zcode', {model: 'glm-5'});
        await store1.appendMessage({id: 'u1', role: 'user', content: 'Turn 1 Q'}, 'zcode', {model: 'glm-5'});
        await store1.appendMessage({id: 'a1', role: 'assistant', content: 'Turn 1 A', replyTo: 'u1'}, 'zcode', {model: 'glm-5'});
        await store1.flush();

        // Both store1 and store2 are now loaded at revision 2 ([u1, a1])
        await store2.load('zcode', {model: 'glm-5'});
        assert.equal(store1.revision, 2);
        assert.equal(store2.revision, 2);

        // Interleave writes across store1 and store2 concurrently (including in-place update on store1!)
        const p1 = store1.appendMessage({id: 'u2', role: 'user', content: 'From Store 1 (u2)'}, 'zcode', {model: 'glm-5'});
        const p2 = store2.appendMessage({id: 'a2', role: 'assistant', content: 'From Store 2 (a2)', replyTo: 'u2'}, 'zcode', {model: 'glm-5'});
        const p3 = store1.appendMessage({id: 'u3', role: 'user', content: 'From Store 1 (u3)'}, 'zcode', {model: 'glm-5'});
        // Store 2 performs an in-place replacement (full snapshot write) — must NOT clobber u3 from Store 1!
        const p4 = store2.appendMessage({id: 'a2', role: 'assistant', content: 'From Store 2 (a2 updated)', replyTo: 'u2'}, 'zcode', {model: 'glm-5'});
        const p5 = store2.appendMessage({id: 'a3', role: 'assistant', content: 'From Store 2 (a3)', replyTo: 'u3'}, 'zcode', {model: 'glm-5'});

        await Promise.all([p1, p2, p3, p4, p5]);
        const f1 = await store1.flush();
        const f2 = await store2.flush();
        assert.equal(f1.ok, true);
        assert.equal(f2.ok, true);

        const expectedIds = ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'];
        assert.deepEqual(store1.messages.map(m => m.id), expectedIds);
        assert.deepEqual(store2.messages.map(m => m.id), expectedIds);
        assert.equal(store1.revision, 7);
        assert.equal(store2.revision, 7);

        // Reload in a 3rd fresh instance from disk and verify disk matches memory 100%
        const store3 = new SessionStoreEngine('dual_sess', {
            sessionsRootDir: tmpRoot,
            io: createControllableIo(),
        });
        await store3.load('zcode', {model: 'glm-5'});
        assert.deepEqual(store3.messages.map(m => m.id), expectedIds);
        assert.equal(
            store3.messages.find(m => m.id === 'a2').content,
            'From Store 2 (a2 updated)',
            'In-place update on store2 must be preserved alongside store1 appends'
        );
        assert.equal(store3.revision, 7);
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});
