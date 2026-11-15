import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
    SessionStoreEngine,
    validateSessionId,
    resolveSafeSessionPaths,
    compactMessagesByWholeTurn,
    deduplicateMessagesPreservingOrder,
    importLegacyPiSessionWithIo,
} from '../core/sessionEngine.js';
import {buildRuntimeContextSignature} from '../core/contextManager.js';

function createNodeFsIo({delayMs = 0, failFirstN = 0, alwaysFail = false} = {}) {
    let writeCalls = 0;
    const maybeDelay = () => (delayMs > 0 ? new Promise(r => setTimeout(r, delayMs)) : Promise.resolve());
    const maybeFail = op => {
        writeCalls++;
        if (alwaysFail) {
            throw new Error(`模拟磁盘空间不足 (${op})`);
        }
        if (failFirstN > 0 && writeCalls <= failFirstN) {
            throw new Error(`模拟瞬时 I/O 错误 (${op}#${writeCalls})`);
        }
    };

    return {
        get writeCalls() {
            return writeCalls;
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
            await maybeDelay();
            return fs.readFile(filePath, 'utf8');
        },
        async appendLine(filePath, lineOrBlock) {
            await maybeDelay();
            maybeFail('appendLine');
            await fs.mkdir(path.dirname(filePath), {recursive: true, mode: 0o700});
            const normalized = lineOrBlock.endsWith('\n') ? lineOrBlock : `${lineOrBlock}\n`;
            await fs.appendFile(filePath, normalized, {encoding: 'utf8', mode: 0o600});
        },
        async replaceFile(filePath, content) {
            await maybeDelay();
            maybeFail('replaceFile');
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

test('Stage C1: validateSessionId and resolveSafeSessionPaths reject path traversal and uncontrolled formats', () => {
    assert.equal(validateSessionId('default'), 'default');
    assert.equal(validateSessionId('sess_2026-11-15_01'), 'sess_2026-11-15_01');

    for (const bad of ['', '   ', '../escape', 'foo/bar', 'foo\\bar', '.hidden', '-leadingdash', 'a\u0000b', 'a'.repeat(130)]) {
        assert.throws(() => validateSessionId(bad), /非法的会话 ID/);
        assert.throws(() => resolveSafeSessionPaths('/tmp/qc-sessions', bad));
    }

    assert.throws(() => resolveSafeSessionPaths('relative/root', 'default'), /绝对路径/);
    assert.throws(() => resolveSafeSessionPaths('/tmp/../etc', 'default'), /\.\./);

    const safe = resolveSafeSessionPaths('/tmp/qc-sessions', 'session_alpha');
    assert.equal(safe.dir, '/tmp/qc-sessions/session_alpha');
    assert.equal(safe.jsonlPath, '/tmp/qc-sessions/session_alpha/messages.jsonl');
    assert.equal(safe.metaPath, '/tmp/qc-sessions/session_alpha/meta.json');
});

test('Stage C1: 201st message whole-turn compaction concurrent with 202nd & 203rd appends produces zero duplicates or lost records', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-stagec1-race-'));
    try {
        // Deliberate async I/O latency so #202 and #203 are enqueued BEFORE #201's compaction writes execute!
        const io = createNodeFsIo({delayMs: 4});
        const store = new SessionStoreEngine('race_session', {
            sessionsRootDir: tmpRoot,
            io,
            maxHotMessages: 200,
            keepArchive: true,
        });
        await store.load('zcode', {model: 'glm-5'});

        // Append 100 complete turns = 200 messages synchronously into queue
        for (let t = 1; t <= 100; t++) {
            store.appendMessage({id: `u_${t}`, role: 'user', content: `问题 ${t}`}, 'zcode', {model: 'glm-5'});
            store.appendMessage({id: `a_${t}`, role: 'assistant', content: `回答 ${t}`}, 'zcode', {model: 'glm-5'});
        }

        // Message #201 triggers compaction (> 200), and #202 + #203 are appended immediately in the same tick!
        const p201 = store.appendMessage({id: 'u_101', role: 'user', content: '并发问题 101'}, 'zcode', {model: 'glm-5'});
        const p202 = store.appendMessage({id: 'a_101', role: 'assistant', content: '并发回答 101'}, 'zcode', {model: 'glm-5'});
        const p203 = store.appendMessage({id: 'u_102', role: 'user', content: '并发问题 102'}, 'zcode', {model: 'glm-5'});

        await Promise.all([p201, p202, p203]);
        await store.flush();

        // Inspect raw JSONL lines on disk: every ID must appear AT MOST ONCE (zero duplicate writes!)
        const rawLines = (await fs.readFile(store.jsonlPath, 'utf8')).trim().split('\n');
        const rawIds = rawLines.map(line => JSON.parse(line).id);
        const uniqueIds = new Set(rawIds);
        assert.equal(rawIds.length, uniqueIds.size, 'messages.jsonl must not contain duplicate records after compaction race');

        // Verify #201, #202, #203 are all present at the tail in exact order
        assert.deepEqual(rawIds.slice(-3), ['u_101', 'a_101', 'u_102']);
        // Verify first retained message is a `user` turn boundary (never an orphan assistant half-turn)
        const firstRetained = JSON.parse(rawLines[0]);
        assert.equal(firstRetained.role, 'user');

        // Reload in a brand-new SessionStoreEngine instance and verify hot + archive = all 203 messages!
        const reloaded = new SessionStoreEngine('race_session', {
            sessionsRootDir: tmpRoot,
            io: createNodeFsIo(),
            maxHotMessages: 200,
        });
        await reloaded.load('zcode', {model: 'glm-5'});
        assert.deepEqual(reloaded.messages.map(m => m.id), rawIds);

        const archiveLines = (await fs.readFile(store.archivePath, 'utf8')).trim().split('\n');
        const archivedIds = archiveLines.map(l => JSON.parse(l).id);
        assert.equal(archivedIds.length + reloaded.messages.length, 203);
        assert.equal(archivedIds[0], 'u_1');
        assert.equal(reloaded.messages.at(-1).id, 'u_102');
        assert.equal(reloaded.messages.find(m => m.id === 'a_101').replyTo, 'u_101');
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('Stage C1: multi-instance concurrent writes, single-flight load(), and crash recovery (JSONL ahead of meta.json)', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-stagec1-multi-'));
    try {
        const ioA = createNodeFsIo({delayMs: 8});
        const ioB = createNodeFsIo({delayMs: 3});

        const clientA = new SessionStoreEngine('shared_sess', {sessionsRootDir: tmpRoot, io: ioA});
        await clientA.load('openai', {openaiModel: 'gpt-4o'});
        clientA.appendMessage({id: 'm1', role: 'user', content: '来自旧客户端的提问'}, 'openai', {openaiModel: 'gpt-4o'});
        clientA.appendMessage({id: 'm2', role: 'assistant', content: '来自旧客户端的回答'}, 'openai', {openaiModel: 'gpt-4o'});

        // Client B starts loading BEFORE Client A's async writes finish; single-flight + shared write chain coordinates!
        const clientB = new SessionStoreEngine('shared_sess', {sessionsRootDir: tmpRoot, io: ioB});
        const [load1, load2] = await Promise.all([
            clientB.load('openai', {openaiModel: 'gpt-4o'}),
            clientB.load('openai', {openaiModel: 'gpt-4o'}),
        ]);
        assert.equal(load1, load2);
        assert.deepEqual(clientB.messages.map(m => m.id), ['m1', 'm2']);

        // Simulate power-loss crash: messages.jsonl has m3 (rev 3) appended, while meta.json is truncated/corrupted
        await fs.appendFile(
            clientB.jsonlPath,
            `${JSON.stringify({id: 'm3', revision: 3, role: 'user', content: '断电前已写入日志'})}\n`,
            'utf8'
        );
        await fs.writeFile(clientB.metaPath, '{"schemaVersion":2,"committedRevision":1', 'utf8'); // truncated JSON!

        const recovered = new SessionStoreEngine('shared_sess', {sessionsRootDir: tmpRoot, io: createNodeFsIo()});
        await recovered.load('openai', {openaiModel: 'gpt-4o'});
        assert.deepEqual(recovered.messages.map(m => m.id), ['m1', 'm2', 'm3']);
        assert.equal(recovered.revision, 3);
        assert.equal(recovered.meta.committedRevision, 3);
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('Stage C1: corrupt JSONL lines are isolated to corrupt.jsonl without clobbering sole history copy, and backed up before compaction', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-stagec1-corrupt-'));
    try {
        const sessDir = path.join(tmpRoot, 'broken_sess');
        await fs.mkdir(sessDir, {recursive: true});
        const origContent = [
            JSON.stringify({id: 'u1', revision: 1, role: 'user', content: '第一问'}),
            '{"id":"corrupt_mid", BROKEN_JSON_LINE',
            JSON.stringify({id: 'a1', revision: 2, role: 'assistant', content: '第一答'}),
            '{"id":"truncated_tail","role":"user"', // Power-loss mid-line WITHOUT trailing \n!
        ].join('\n');
        const jsonlFile = path.join(sessDir, 'messages.jsonl');
        await fs.writeFile(jsonlFile, origContent, 'utf8');

        const store = new SessionStoreEngine('broken_sess', {
            sessionsRootDir: tmpRoot,
            io: createNodeFsIo(),
            maxHotMessages: 4,
        });
        await store.load('codex', {model: 'o3'});
        await store.flush();

        assert.equal(store.corruptLineCount, 2);
        assert.deepEqual(store.messages.map(m => m.id), ['u1', 'a1']);

        // Original messages.jsonl MUST NOT be overwritten merely by loading!
        const afterLoadRaw = await fs.readFile(jsonlFile, 'utf8');
        assert.equal(afterLoadRaw, origContent);

        // Corrupt lines must be recorded in corrupt.jsonl
        const corruptLog = (await fs.readFile(store.corruptPath, 'utf8')).trim().split('\n');
        assert.equal(corruptLog.length, 2);
        assert.match(corruptLog[0], /BROKEN_JSON_LINE/);

        // Appending u2 onto a file whose tail lacked `\n` must start on a fresh line without corrupting u2!
        await store.appendMessage({id: 'u2', role: 'user', content: '2'}, 'codex', {});
        const checkAfterU2 = new SessionStoreEngine('broken_sess', {
            sessionsRootDir: tmpRoot,
            io: createNodeFsIo(),
            maxHotMessages: 4,
        });
        await checkAfterU2.load('codex', {model: 'o3'});
        assert.deepEqual(checkAfterU2.messages.map(m => m.id), ['u1', 'a1', 'u2']);

        // Trigger compaction (> 4 messages): must save exact pristine `.corrupt-backup` before rewriting `messages.jsonl`!
        store.appendMessage({id: 'a2', role: 'assistant', content: '2'}, 'codex', {});
        store.appendMessage({id: 'u3', role: 'user', content: '3'}, 'codex', {});
        await store.flush();

        const backupRaw = await fs.readFile(`${jsonlFile}.corrupt-backup`, 'utf8');
        assert.equal(backupRaw, origContent);
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('Stage C1: write retries, observable onSaveError (历史未保存), oversized record safety, single-turn protection, and legacy migrations', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-stagec1-misc-'));
    try {
        // 1. Transient failure succeeds on retry without firing error
        const flakyErrors = [];
        const flakyStore = new SessionStoreEngine('flaky_sess', {
            sessionsRootDir: tmpRoot,
            io: createNodeFsIo({failFirstN: 2}),
            maxWriteRetries: 2,
            retryDelayMs: 2,
            onSaveError: err => flakyErrors.push(err),
        });
        await flakyStore.load('openai', {});
        await flakyStore.appendMessage({id: 'ok_after_retry', role: 'user', content: '重试成功'}, 'openai', {});
        assert.equal(flakyErrors.length, 0);
        assert.equal(flakyStore.hasUnsavedChanges, false);

        // 2. Persistent failure exhausts bounded retries and notifies UI `历史未保存`
        const hardErrors = [];
        const failingStore = new SessionStoreEngine('failing_sess', {
            sessionsRootDir: tmpRoot,
            io: createNodeFsIo({alwaysFail: true}),
            maxWriteRetries: 2,
            retryDelayMs: 2,
            onSaveError: err => hardErrors.push(err),
        });
        const res = await failingStore.appendMessage({id: 'unsaved_1', role: 'user', content: '磁盘满'}, 'openai', {});
        assert.equal(res.ok, false);
        assert.equal(failingStore.hasUnsavedChanges, true);
        assert.equal(hardErrors.length, 1);
        assert.match(hardErrors[0].message, /历史未保存/);

        // 3. Single huge turn & oversized record: never splits a single turn, bounds >2MiB record safely
        const singleTurn = [
            {id: 'u_only', role: 'user', content: '唯一提问'},
            {id: 'a_part1', role: 'assistant', content: '分段1'},
            {id: 'a_part2', role: 'assistant', content: '分段2'},
            {id: 'a_part3', role: 'assistant', content: '分段3'},
            {id: 'a_part4', role: 'assistant', content: '分段4'},
        ];
        const notSplit = compactMessagesByWholeTurn(singleTurn, {maxMessages: 3, targetMessages: 2});
        assert.equal(notSplit.compacted, false);
        assert.equal(notSplit.retained.length, 5);

        const hugeStore = new SessionStoreEngine('huge_sess', {
            sessionsRootDir: tmpRoot,
            io: createNodeFsIo(),
        });
        await hugeStore.appendMessage({
            id: 'huge_msg',
            role: 'assistant',
            content: '中'.repeat(900_000), // ~2.7 MB UTF-8 > 2 MiB limit
        }, 'openai', {openaiModel: 'gpt-4o'});
        assert.equal(hugeStore.messages[0].truncated, true);
        assert.equal(hugeStore.messages[0].partial, true);

        // 4. Deduplicate in-place by ID preserving original order
        const deduped = deduplicateMessagesPreservingOrder([
            {id: 'm1', revision: 1, role: 'user', content: 'Q1'},
            {id: 'm2', revision: 2, role: 'assistant', content: 'Draft'},
            {id: 'm3', revision: 3, role: 'user', content: 'Q2'},
            {id: 'm2', revision: 4, role: 'assistant', content: 'Final Replaced'},
        ]);
        assert.deepEqual(deduped.messages.map(m => `${m.id}:${m.content}`), [
            'm1:Q1',
            'm2:Final Replaced',
            'm3:Q2',
        ]);

        // 5. Legacy `.qc.json` migration + read-only Pi `.jsonl` import
        const legacyQcPath = path.join(tmpRoot, 'legacy_qc.qc.json');
        await fs.writeFile(legacyQcPath, JSON.stringify({
            backend: 'pi',
            remoteSessionId: 'pi_old_remote_99',
            messages: [
                {role: 'user', content: '旧版问题'},
                {role: 'assistant', content: '旧版回答'},
            ],
        }), 'utf8');
        const migratedQc = new SessionStoreEngine('legacy_qc', {
            sessionsRootDir: tmpRoot,
            io: createNodeFsIo(),
            buildContextSignature: buildRuntimeContextSignature,
        });
        await migratedQc.load('zcode', {model: 'glm-5'});
        await migratedQc.flush();
        assert.equal(migratedQc.messages.length, 2);
        // Legacy Pi remoteSessionId must NEVER be forwarded to ZCode!
        assert.equal(migratedQc.remoteSessionId, '');

        const piSource = path.join(tmpRoot, 'old_pi_export.jsonl');
        await fs.writeFile(piSource, [
            JSON.stringify({type: 'session', id: 'pi_sess_1'}),
            JSON.stringify({type: 'message', message: {role: 'user', content: 'Pi 历史问题'}}),
            JSON.stringify({type: 'message', message: {role: 'assistant', content: [{type: 'text', text: 'Pi 历史回答'}]}}),
        ].join('\n'), 'utf8');

        const imported = await importLegacyPiSessionWithIo({
            sourceFilePath: piSource,
            targetSessionId: 'imported_pi_1',
            sessionsRootDir: tmpRoot,
            io: createNodeFsIo(),
        });
        assert.equal(imported.ok, true);
        assert.equal(imported.importedCount, 2);
        // Original Pi file must remain untouched!
        assert.equal(await fs.access(piSource).then(() => true), true);
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});
