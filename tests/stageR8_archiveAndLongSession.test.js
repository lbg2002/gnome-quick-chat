import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    SessionStoreEngine,
    exportSessionFormatted,
    formatSessionByteSize,
    inspectSessionsWithIo,
    planSessionRetentionCleanup,
    resolvePreviousSessionId,
} from '../core/sessionEngine.js';
import {buildBudgetedContextMessages} from '../protocol.js';
import {
    DEFAULT_HOT_DATA_CACHE_LIMIT,
    DEFAULT_MAX_MOUNTED_ACTORS,
    HistoryWindowController,
    releaseCardRuntimeReferences,
} from '../core/renderScheduler.js';

function createNodeFsAdapter() {
    return {
        async exists(filePath) {
            try {
                await fs.access(filePath);
                return true;
            } catch (_) {
                return false;
            }
        },
        async readText(filePath, maxBytes = 0) {
            try {
                const buf = await fs.readFile(filePath);
                if (maxBytes > 0 && buf.byteLength > maxBytes) {
                    return buf.subarray(0, maxBytes).toString('utf8');
                }
                return buf.toString('utf8');
            } catch (err) {
                if (err?.code === 'ENOENT') return '';
                throw err;
            }
        },
        async replaceFile(filePath, content) {
            await fs.mkdir(path.dirname(filePath), {recursive: true, mode: 0o700});
            const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
            await fs.writeFile(tmp, content, {encoding: 'utf8', mode: 0o600});
            await fs.rename(tmp, filePath);
            await fs.chmod(filePath, 0o600);
        },
        async appendLine(filePath, lineStr) {
            await fs.mkdir(path.dirname(filePath), {recursive: true, mode: 0o700});
            const payload = lineStr.endsWith('\n') ? lineStr : `${lineStr}\n`;
            await fs.appendFile(filePath, payload, {encoding: 'utf8', mode: 0o600});
            await fs.chmod(filePath, 0o600);
        },
        async unlink(filePath) {
            try {
                await fs.unlink(filePath);
            } catch (_) {}
        },
        async rmdir(dirPath) {
            try {
                await fs.rm(dirPath, {recursive: true, force: true});
            } catch (_) {}
        },
        async listDir(rootDir) {
            try {
                const entries = await fs.readdir(rootDir, {withFileTypes: true});
                return entries.map(e => ({
                    name: e.name,
                    isDir: e.isDirectory(),
                    isSymlink: e.isSymbolicLink(),
                }));
            } catch (err) {
                if (err?.code === 'ENOENT') return [];
                throw err;
            }
        },
        async statMtimeMs(filePath) {
            try {
                const st = await fs.stat(filePath);
                return st.mtimeMs;
            } catch (_) {
                return 0;
            }
        },
    };
}

test('R8.1: 1000+ messages whole-turn compaction, restart, paginated archive access, revision index, and separation of full export vs context budget', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-r8-1000msgs-'));
    try {
        const io = createNodeFsAdapter();
        const sessionId = 'r8-1000-session';
        const store = new SessionStoreEngine(sessionId, {
            sessionsRootDir: tmpRoot,
            io,
            maxHotMessages: 80,
            maxHotFileBytes: 64 * 1024,
        });

        await store.load();

        // Append 520 whole turns = 1040 messages
        const totalTurns = 520;
        for (let t = 1; t <= totalTurns; t++) {
            await store.appendMessage({
                id: `u-${t}`,
                turnId: `turn-${t}`,
                role: 'user',
                content: `第 ${t} 轮用户提问：请解释模块 #${t}`,
                ts: 1700000000000 + t * 2000,
                backend: 'zcode',
            });

            await store.appendMessage({
                id: `a-${t}`,
                turnId: `turn-${t}`,
                replyTo: `u-${t}`,
                role: 'assistant',
                content: `第 ${t} 轮回答：模块 #${t} 的核心职责是处理会话流。`,
                ts: 1700000000000 + t * 2000 + 500,
                backend: 'zcode',
                modelId: 'glm-5.1',
                status: 'completed',
            });
        }

        const flushed = await store.flush();
        assert.equal(flushed.ok, true);

        // Hot messages should be compacted <= 80, while totalLogicalMessageCount === 1040
        assert.ok(store.messages.length <= 80, `Expected hot messages <= 80, got ${store.messages.length}`);
        assert.equal(store.messages[0].role, 'user', 'Whole-turn compaction must never split a turn leaving orphan assistant at index 0');
        assert.equal(store.totalLogicalMessageCount, 1040);
        assert.equal(store.archivedMessageCount, 1040 - store.messages.length);

        // Simulate restart with a fresh SessionStoreEngine instance on a copied root dir
        const restartRoot = `${tmpRoot}-restart`;
        await fs.cp(tmpRoot, restartRoot, {recursive: true});
        try {
            const reloaded = new SessionStoreEngine(sessionId, {
                sessionsRootDir: restartRoot,
                io,
                maxHotMessages: 80,
                maxHotFileBytes: 64 * 1024,
            });
            await reloaded.load();

            assert.equal(reloaded.totalLogicalMessageCount, 1040);
            assert.equal(reloaded.archivedMessageCount + reloaded.messages.length, 1040);

            // Verify revision index lookup across both archive and hot messages
            const rev1 = reloaded.lookupByRevision(1);
            assert.equal(rev1?.location, 'archive');
            assert.equal(rev1?.id, 'u-1');

            const revLast = reloaded.lookupByRevision(1040);
            assert.equal(revLast?.location, 'hot');
            assert.equal(revLast?.id, `a-${totalTurns}`);

            // Paginated loading from archive.jsonl
            const page1 = await reloaded.loadArchivedHistoryPage({
                beforeIndex: reloaded.archivedMessageCount,
                limit: 20,
            });
            assert.equal(page1.messages.length, 20);
            assert.equal(page1.olderRemainingCount, reloaded.archivedMessageCount - 20);
            assert.equal(page1.messages[0].role, 'user');

            const earliestPage = await reloaded.loadArchivedHistoryPage({
                beforeIndex: 20,
                limit: 20,
            });
            assert.equal(earliestPage.pageStartIndex, 0);
            assert.equal(earliestPage.olderRemainingCount, 0);
            assert.equal(earliestPage.messages[0].id, 'u-1');
            assert.equal(earliestPage.messages[1].id, 'a-1');

            // Full logical history export includes all 1040 active messages
            const fullHistory = await reloaded.loadFullLogicalHistory({includeRewound: false});
            assert.equal(fullHistory.messages.length, 1040);
            assert.equal(fullHistory.messages[0].id, 'u-1');
            assert.equal(fullHistory.messages[1039].id, `a-${totalTurns}`);

            const mdExport = exportSessionFormatted({
                sessionId,
                meta: reloaded.meta,
                messages: fullHistory.messages,
                format: 'markdown',
            });
            assert.match(mdExport, /当前逻辑会话完整有效历史（不含已撤销\/编辑替换的旧分支）/);
            assert.match(mdExport, /第 1 轮用户提问/);
            assert.match(mdExport, /第 520 轮回答/);

            // Model context budget stays strictly separated from full history
            const contextMsgs = buildBudgetedContextMessages(reloaded.messages, {
                maxMessages: 12,
                maxChars: 2000,
            });
            assert.ok(contextMsgs.length <= 12, `Expected context messages <= 12, got ${contextMsgs.length}`);
            assert.ok(contextMsgs.at(-1)?.content.includes('520'));
            assert.ok(!contextMsgs.some(m => m.content.includes('第 1 轮')));
        } finally {
            await fs.rm(restartRoot, {recursive: true, force: true});
        }
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('R8.2: Rewound/edited history branches are isolated in rewound.jsonl and excluded from archive, default export, and model context', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-r8-rewind-'));
    try {
        const io = createNodeFsAdapter();
        const sessionId = 'r8-rewind-session';
        const store = new SessionStoreEngine(sessionId, {
            sessionsRootDir: tmpRoot,
            io,
            maxHotMessages: 6,
        });
        await store.load();

        // Append 5 turns (10 messages) -> older turns get compacted to archive.jsonl
        for (let t = 1; t <= 5; t++) {
            await store.appendMessage({
                id: `u-${t}`,
                turnId: `turn-${t}`,
                role: 'user',
                content: `原始问题 ${t}`,
                ts: 1700000000000 + t * 1000,
            });
            await store.appendMessage({
                id: `a-${t}`,
                turnId: `turn-${t}`,
                replyTo: `u-${t}`,
                role: 'assistant',
                content: `原始回答 ${t}（若被撤销不应再进入上下文）`,
                ts: 1700000000000 + t * 1000 + 500,
            });
        }
        await store.flush();
        assert.ok(store.archivedMessageCount > 0);
        assert.equal(store.totalLogicalMessageCount, 10);

        // Edit/replace from u-4 (in hot messages)
        const rwHot = store.rewindFromUserMessage('u-4', {archiveRemoved: true});
        assert.equal(rwHot.ok, true);
        assert.equal(rwHot.removedMessages.length, 4); // u-4, a-4, u-5, a-5
        const rwHotCommit = await rwHot.writePromise;
        assert.equal(rwHotCommit.ok, true);

        // Append replacement turn 4b
        await store.appendMessage({
            id: 'u-4b',
            turnId: 'turn-4b',
            role: 'user',
            content: '编辑后的新问题 4b',
            ts: 1700000020000,
        });
        await store.appendMessage({
            id: 'a-4b',
            turnId: 'turn-4b',
            replyTo: 'u-4b',
            role: 'assistant',
            content: '编辑后的新回答 4b',
            ts: 1700000020500,
        });
        await store.flush();

        // Verify active logical history has u-1..a-3 + u-4b..a-4b (8 messages), NO u-4/a-4/u-5/a-5
        const activeExport = await store.loadFullLogicalHistory({includeRewound: false});
        assert.deepEqual(
            activeExport.messages.map(m => m.id),
            ['u-1', 'a-1', 'u-2', 'a-2', 'u-3', 'a-3', 'u-4b', 'a-4b']
        );
        assert.equal(activeExport.rewoundBranches.length, 0);

        // Verify includeRewound: true returns the rewound branch separately
        const fullWithRewound = await store.loadFullLogicalHistory({includeRewound: true});
        assert.deepEqual(
            fullWithRewound.rewoundBranches.map(m => m.id),
            ['u-4', 'a-4', 'u-5', 'a-5']
        );
        assert.ok(fullWithRewound.rewoundBranches.every(m => m.archiveKind === 'rewound_branch'));

        // Verify model context NEVER includes rewound messages
        const ctx = buildBudgetedContextMessages(store.messages, {maxMessages: 20, maxChars: 10000});
        assert.ok(!ctx.some(m => m.content.includes('原始问题 4') || m.content.includes('原始回答 4')));
        assert.ok(ctx.some(m => m.content.includes('编辑后的新问题 4b')));

        // Also test rewinding a turn that was already compacted into archive.jsonl (e.g., u-2)
        const rwArchived = store.rewindFromUserMessage('u-2', {archiveRemoved: true});
        assert.equal(rwArchived.ok, true);
        const rwArchivedCommit = await rwArchived.writePromise;
        assert.equal(rwArchivedCommit.ok, true);

        const afterArchivedRewind = await store.loadFullLogicalHistory({includeRewound: false});
        assert.deepEqual(
            afterArchivedRewind.messages.map(m => m.id),
            ['u-1', 'a-1']
        );
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('R8.3: Crash window between archive.jsonl append and messages.jsonl replace recovers idempotently without duplicates', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-r8-crash-'));
    try {
        const io = createNodeFsAdapter();
        const sessionId = 'r8-crash-session';
        const sessionDir = path.join(tmpRoot, sessionId);

        // Simulate crash after archive.jsonl was appended with u-1, a-1, AND legacy rewound_branch item,
        // BEFORE messages.jsonl was replaced (so messages.jsonl still contains u-1, a-1, u-2, a-2)
        const archiveLines = [
            JSON.stringify({id: 'u-1', turnId: 't-1', role: 'user', content: 'Q1', ts: 1000, revision: 1, archiveKind: 'compacted'}),
            JSON.stringify({id: 'a-1', turnId: 't-1', replyTo: 'u-1', role: 'assistant', content: 'A1', ts: 1100, revision: 2, archiveKind: 'compacted'}),
            // Duplicate of u-1 (e.g. retried compaction before hot replace)
            JSON.stringify({id: 'u-1', turnId: 't-1', role: 'user', content: 'Q1', ts: 1000, revision: 1, archiveKind: 'compacted'}),
            // Legacy rewound message mixed into archive.jsonl before R8
            JSON.stringify({id: 'a-old', turnId: 't-1', replyTo: 'u-1', role: 'assistant', content: 'Old branch', ts: 1050, revision: 2, rewoundAt: '2026-11-15T00:00:00.000Z'}),
        ];
        const hotLines = [
            JSON.stringify({id: 'u-1', turnId: 't-1', role: 'user', content: 'Q1', ts: 1000, revision: 1}),
            JSON.stringify({id: 'a-1', turnId: 't-1', replyTo: 'u-1', role: 'assistant', content: 'A1', ts: 1100, revision: 2}),
            JSON.stringify({id: 'u-2', turnId: 't-2', role: 'user', content: 'Q2', ts: 2000, revision: 3}),
            JSON.stringify({id: 'a-2', turnId: 't-2', replyTo: 'u-2', role: 'assistant', content: 'A2', ts: 2100, revision: 4}),
        ];

        await io.replaceFile(path.join(sessionDir, 'archive.jsonl'), `${archiveLines.join('\n')}\n`);
        await io.replaceFile(path.join(sessionDir, 'messages.jsonl'), `${hotLines.join('\n')}\n`);

        const store = new SessionStoreEngine(sessionId, {
            sessionsRootDir: tmpRoot,
            io,
        });
        await store.load();
        await store.flush();

        // Hot messages should have deduplicated u-1 and a-1 (already in archive.jsonl)
        assert.deepEqual(store.messages.map(m => m.id), ['u-2', 'a-2']);
        // Archive index should have deduplicated u-1, a-1 and moved a-old out to rewound.jsonl
        assert.equal(store.archivedMessageCount, 2);
        assert.equal(store.totalLogicalMessageCount, 4);

        const full = await store.loadFullLogicalHistory({includeRewound: true});
        assert.deepEqual(full.messages.map(m => m.id), ['u-1', 'a-1', 'u-2', 'a-2']);
        assert.deepEqual(full.rewoundBranches.map(m => m.id), ['a-old']);
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('R8.4: Corrupt archive handling and size-aware retention cleanup planning', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-r8-corrupt-'));
    try {
        const io = createNodeFsAdapter();
        const sessionId = 'r8-corrupt-session';
        const sessionDir = path.join(tmpRoot, sessionId);

        await io.replaceFile(
            path.join(sessionDir, 'archive.jsonl'),
            [
                JSON.stringify({id: 'u-1', role: 'user', content: 'Valid archived Q1', ts: 1000, revision: 1}),
                '{broken json in archive',
                JSON.stringify({id: 'a-1', role: 'assistant', content: 'Valid archived A1', ts: 1100, revision: 2}),
            ].join('\n') + '\n'
        );
        await io.replaceFile(
            path.join(sessionDir, 'messages.jsonl'),
            JSON.stringify({id: 'u-2', role: 'user', content: 'Hot Q2', ts: 2000, revision: 3}) + '\n'
        );

        const store = new SessionStoreEngine(sessionId, {
            sessionsRootDir: tmpRoot,
            io,
        });
        await store.load();
        await store.flush();

        assert.equal(store.archivedMessageCount, 2);
        assert.equal(store.messages.length, 1);

        const page = await store.loadArchivedHistoryPage({limit: 10});
        assert.deepEqual(page.messages.map(m => m.id), ['u-1', 'a-1']);

        // Create two more sessions to test inspectSessionsWithIo + planSessionRetentionCleanup size reporting
        for (let i = 1; i <= 2; i++) {
            const sid = `old-session-${i}`;
            const s = new SessionStoreEngine(sid, {sessionsRootDir: tmpRoot, io});
            await s.load();
            await s.appendMessage({
                id: `m-${i}`,
                role: 'user',
                content: `Old session content ${i} `.repeat(20),
                ts: 1000 * i,
            });
            await s.flush();
        }

        const inspected = await inspectSessionsWithIo(tmpRoot, io);
        assert.equal(inspected.length, 3);
        for (const item of inspected) {
            assert.ok(item.totalBytes > 0, 'Session inspection must report non-zero disk byte size');
            assert.ok(item.formattedSize.length > 0);
        }

        const prevId = resolvePreviousSessionId(inspected, sessionId, '');
        assert.ok(prevId.startsWith('old-session-'));

        const plan = planSessionRetentionCleanup(inspected, {
            currentSessionId: sessionId,
            previousSessionId: prevId,
            maxSessions: 2,
            maxAgeDays: 36500,
        });
        assert.equal(plan.candidatesToDelete.length, 1);
        assert.ok(plan.candidateTotalBytes > 0);
        assert.equal(plan.candidateSizeSummary, formatSessionByteSize(plan.candidateTotalBytes));
        assert.match(plan.policySummary, /保留最近 2 个会话/);
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('R8.5: HistoryWindowController 1000+ messages pagination, Actor cap <= 48, hot cache demotion, and card/trace/timer release', () => {
    const clearedTimers = [];
    const clearTimer = id => clearedTimers.push(id);

    const win = new HistoryWindowController({
        initialPageSize: 30,
        pageSize: 20,
        maxMountedActors: DEFAULT_MAX_MOUNTED_ACTORS,
        maxHotDataMessages: DEFAULT_HOT_DATA_CACHE_LIMIT,
        clearTimer,
    });

    const makeMockCard = msg => ({
        messageId: msg.id,
        turnId: msg.turnId,
        role: msg.role,
        text: msg.text,
        thinking: msg.thinking || '',
        renderTimer: 101,
        copyBtn: {_copyResetTimer: 102},
        drawerCopyBtn: {_copyResetTimer: 103},
        renderState: {blocks: [{actor: {}}]},
        toolNodes: [{id: 'tool-1', dotBtn: {}, questionFormState: {customEntry: {}}}],
        traceBox: {},
        detailDrawer: {},
        box: {
            destroyed: false,
            remove_all_transitions() {},
            destroy() { this.destroyed = true; },
        },
        flushRender() {},
    });

    // Start with 80 hot messages and 960 archived messages on disk (total 1040)
    const initialHot = [];
    for (let i = 961; i <= 1040; i++) {
        initialHot.push({
            id: `m-${i}`,
            turnId: `t-${Math.ceil(i / 2)}`,
            role: i % 2 === 1 ? 'user' : 'assistant',
            text: `Message body #${i} `.repeat(30),
            thinking: `Thinking #${i} `.repeat(20),
            ts: 1700000000000 + i * 1000,
        });
    }

    const {initialSlice} = win.reset(initialHot, {externalArchivedCount: 960});
    assert.equal(initialSlice.length, 30);
    assert.equal(win.olderRemainingCount, 50 + 960);

    win.registerMountedInitialCards(initialSlice.map(makeMockCard));
    assert.equal(win.mountedCount, 30);

    // Page up through hot messages and then prepend archived pages
    while (win.windowStart > 0) {
        const plan = win.planPrependOlderBatch();
        const prepended = plan.slice.map(makeMockCard);
        const evicted = win.commitPrependedBatch(prepended, plan.newWindowStart, plan.evictBottomCount);
        for (const c of evicted) {
            releaseCardRuntimeReferences(c, {clearTimer});
            assert.equal(c.box, null);
            assert.equal(c.toolNodes.length, 0);
            assert.equal(c.renderState, null);
        }
        assert.ok(win.mountedCount <= DEFAULT_MAX_MOUNTED_ACTORS, `Mounted actors (${win.mountedCount}) exceeded cap (${DEFAULT_MAX_MOUNTED_ACTORS})`);
    }

    // Now windowStart === 0 and externalArchivedCount === 960; simulate loading 5 archive pages (100 messages)
    let remainingExt = 960;
    for (let p = 0; p < 5; p++) {
        const startNum = remainingExt - 19;
        const pageMsgs = [];
        for (let i = startNum; i <= remainingExt; i++) {
            pageMsgs.push({
                id: `m-${i}`,
                turnId: `t-${Math.ceil(i / 2)}`,
                role: i % 2 === 1 ? 'user' : 'assistant',
                text: `Archived message #${i} `.repeat(25),
                thinking: `Archived thinking #${i} `.repeat(15),
                ts: 1700000000000 + i * 1000,
            });
        }
        remainingExt -= 20;
        win.prependArchivedMessages(pageMsgs, {remainingExternalCount: remainingExt});
        const plan = win.planPrependOlderBatch();
        const prepended = plan.slice.map(makeMockCard);
        const evicted = win.commitPrependedBatch(prepended, plan.newWindowStart, plan.evictBottomCount);
        for (const c of evicted) {
            releaseCardRuntimeReferences(c, {clearTimer});
        }
        assert.ok(win.mountedCount <= DEFAULT_MAX_MOUNTED_ACTORS);
        assert.ok(win.hotCachedCount <= DEFAULT_HOT_DATA_CACHE_LIMIT + DEFAULT_MAX_MOUNTED_ACTORS);
    }

    assert.ok(win.pagedIndexEntryCount > 0, 'Distant messages outside hot cache window should be demoted to compact index entries');
    assert.ok(win.paginationIndex.size >= 180, 'Pagination index should track loaded message metadata');
    assert.ok(clearedTimers.length > 0, 'Destroyed cards must clear pending timers');
});
