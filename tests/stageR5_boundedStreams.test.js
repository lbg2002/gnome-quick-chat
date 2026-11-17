import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

import {registerGiMocks} from './helpers/giMockLoader.js';

registerGiMocks();

const {
    TurnController,
} = await import('../core/turnController.js');
const {
    spawnManagedCliTurn,
} = await import('../runtime/processManager.js');
const {
    OpenAIAdapter,
    readSoupResponseBytesBoundedAsync,
} = await import('../backends/openaiAdapter.js');
const {
    readFileBytesBoundedAsync,
} = await import('../core/paths.js');
const {
    SessionStore,
    createGioSessionIo,
} = await import('../core/sessionStore.js');
const {
    HistoryWindowController,
} = await import('../core/renderScheduler.js');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        if (stat.includes(') Z ')) return false;
        return true;
    } catch (_) {
        return false;
    }
}

test('R5.1: spawnManagedCliTurn aborts 10MiB newline-less stdout mid-stream via read_bytes_async and bounds huge stderr', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-r5-cli-stream-'));
    const pidFile = path.join(tmpDir, 'cli.pid');
    const fakeCli = path.join(tmpDir, 'fake-huge-cli.sh');

    // Fake CLI writes 1 MiB of stderr and attempts to write 10 MiB without a newline to stdout
    fs.writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const stderrChunk = Buffer.alloc(64 * 1024, 'E');
for (let i = 0; i < 16; i++) {
    try { process.stderr.write(stderrChunk); } catch (_) { break; }
}
const stdoutChunk = Buffer.alloc(64 * 1024, 'A');
let written = 0;
function pump() {
    while (written < 10 * 1024 * 1024) {
        written += stdoutChunk.length;
        let ok = false;
        try {
            ok = process.stdout.write(stdoutChunk);
        } catch (_) {
            process.exit(0);
        }
        if (!ok) {
            process.stdout.once('drain', pump);
            return;
        }
    }
    setTimeout(() => process.exit(0), 2000);
}
pump();
`, {mode: 0o755});

    try {
        const events = [];
        const controller = new TurnController(ev => events.push(ev));
        const turn = controller.beginTurn({
            turnId: 'turn_r5_1',
            messageId: 'msg_r5_1',
            sessionId: 'sess_r5_1',
            backend: 'codex',
        });

        // Cap line bytes at 128 KiB so a 10 MiB newline-less stream is aborted after ~144 KiB
        const maxLineBytes = 128 * 1024;
        spawnManagedCliTurn({
            backend: 'codex',
            sessionId: 'sess_r5_1',
            workspace: tmpDir,
            runtime: {
                pathEnv: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
                extraEnv: {},
            },
            specialDirs: {
                home: tmpDir,
                config: tmpDir,
                data: tmpDir,
                cache: tmpDir,
                runtime: tmpDir,
                tmp: tmpDir,
            },
            turns: controller,
            turn,
            store: null,
            rawArgv: [fakeCli],
            streamLimits: {
                maxLineBytes,
                maxStderrChars: 4096,
                pipeChunkBytes: 16 * 1024,
            },
        });

        const settled = await new Promise((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error('Timed out waiting for turn to abort on oversized line')), 6000);
            const check = setInterval(() => {
                const s = events.find(e => e.type === 'agent_settled');
                if (s) {
                    clearInterval(check);
                    clearTimeout(deadline);
                    resolve(s);
                }
            }, 25);
        });

        assert.equal(settled.status, 'failed', 'Turn must fail when stdout emits a newline-less line exceeding maxLineBytes');
        assert.match(settled.errorMessage, /单行(?:输出|事件)超过安全上限/, 'Error message must report oversized single-line event');
        assert.ok(turn.text.length === 0, 'Oversized malformed line must never be buffered into assistant text');

        if (fs.existsSync(pidFile)) {
            const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
            for (let i = 0; i < 30 && isPidAlive(childPid); i++) {
                await sleep(30);
            }
            assert.equal(isPidAlive(childPid), false, 'Runaway CLI process must be terminated immediately upon stdout line overflow');
        }
    } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});

test('R5.2: OpenAIAdapter.getModels & readSoupResponseBytesBoundedAsync abort chunked /models responses exceeding byte cap mid-stream', async () => {
    let bytesSentByServer = 0;
    const server = http.createServer((req, res) => {
        if (req.url === '/v1/models') {
            // Chunked response without Content-Length that tries to stream 5 MiB of JSON
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Transfer-Encoding': 'chunked',
            });
            res.write('{"data":[');
            const chunk = Buffer.alloc(32 * 1024, 'x');
            const timer = setInterval(() => {
                if (res.destroyed || res.writableEnded) {
                    clearInterval(timer);
                    return;
                }
                bytesSentByServer += chunk.length;
                res.write(chunk);
                if (bytesSentByServer >= 5 * 1024 * 1024) {
                    clearInterval(timer);
                    res.end(']}');
                }
            }, 5);
            req.on('close', () => clearInterval(timer));
            return;
        }
        res.writeHead(404);
        res.end();
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        const Soup = globalThis.__qcMockSoup;
        const session = new Soup.Session();
        const msg = Soup.Message.new('GET', `http://127.0.0.1:${port}/v1/models`);
        const maxBytes = 64 * 1024; // 64 KiB cap for test

        await assert.rejects(
            () => readSoupResponseBytesBoundedAsync(session, msg, {
                maxBytes,
                chunkBytes: 16 * 1024,
            }),
            /响应体积超过上限/,
            'Oversized chunked HTTP response must reject mid-stream'
        );
        assert.ok(
            bytesSentByServer < 1024 * 1024,
            `Stream must be aborted early before reading full 5 MiB (server only sent ${bytesSentByServer} bytes)`
        );

        // Also verify OpenAIAdapter.getModels rejects when Content-Length or stream exceeds limit
        const dishonestServer = http.createServer((req, res) => {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Length': String(20 * 1024 * 1024),
            });
            res.end('{"data":[]}');
        });
        await new Promise(resolve => dishonestServer.listen(0, '127.0.0.1', resolve));
        const port2 = dishonestServer.address().port;
        try {
            const adapter = new OpenAIAdapter({
                turns: new TurnController(() => {}),
                emitEvent: () => {},
            });
            const cfg = {
                openaiBaseUrl: `http://127.0.0.1:${port2}/v1`,
                openaiApiKey: 'sk-test-r5',
                openaiModel: 'gpt-4o-mini',
            };
            adapter.initialize({
                modelsUrl: `http://127.0.0.1:${port2}/v1/models`,
                apiKey: 'sk-test-r5',
                modelId: 'gpt-4o-mini',
            }, cfg);
            await assert.rejects(
                () => adapter.getModels({maxBytes: 64 * 1024}),
                /响应体积超过上限/
            );
            adapter.dispose();
        } finally {
            dishonestServer.close();
        }
    } finally {
        server.close();
    }
});

test('R5.3: readFileBytesBoundedAsync rejects FIFOs/directories, detects file growth after stat, and SessionStore bounds oversized JSONL lines', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-r5-files-'));
    try {
        // 1. Reject directory
        const dirRes = await readFileBytesBoundedAsync(tmpDir, 4096);
        assert.equal(dirRes.nonRegular, true, 'Directories must be rejected as non-regular files');
        assert.equal(dirRes.bytes, null);

        // 2. Reject FIFO special file
        const fifoPath = path.join(tmpDir, 'test.fifo');
        const mkfifo = spawnSync('mkfifo', [fifoPath]);
        if (mkfifo.status === 0 && fs.existsSync(fifoPath)) {
            const fifoRes = await readFileBytesBoundedAsync(fifoPath, 4096);
            assert.equal(fifoRes.nonRegular, true, 'FIFO must set nonRegular: true without opening or blocking');
            assert.equal(fifoRes.bytes, null);
        }

        // 3. Detect file growth past maxBytes after stat()
        const growFile = path.join(tmpDir, 'grow.txt');
        fs.writeFileSync(growFile, Buffer.alloc(1024, 'a'));
        const Gio = globalThis.__qcMockGio;
        const origNewForPath = Gio.File.new_for_path.bind(Gio.File);
        Gio.File.new_for_path = function (filePath) {
            const f = origNewForPath(filePath);
            if (filePath === growFile) {
                const origReadAsync = f.read_async.bind(f);
                f.read_async = function (prio, cancellable, cb) {
                    // Simulate another process appending 32 KiB right after stat() succeeded!
                    fs.appendFileSync(growFile, Buffer.alloc(32 * 1024, 'b'));
                    return origReadAsync(prio, cancellable, cb);
                };
            }
            return f;
        };
        try {
            const growRes = await readFileBytesBoundedAsync(growFile, 4096);
            assert.equal(growRes.tooLarge, true, 'File that grows past maxBytes during chunked read must be rejected');
            assert.equal(growRes.grewDuringRead, true, 'Must report grewDuringRead: true');
            assert.equal(growRes.bytes, null);
        } finally {
            Gio.File.new_for_path = origNewForPath;
        }

        // 4. SessionStore.load skips an oversized corrupted line mid-stream via readJsonlBounded without losing valid messages
        const sessionsRoot = path.join(tmpDir, 'sessions');
        const sessDir = path.join(sessionsRoot, 'sess_r5_jsonl');
        fs.mkdirSync(sessDir, {recursive: true});
        const msg1 = JSON.stringify({
            id: 'm1',
            revision: 1,
            role: 'user',
            content: '第一条正常问题',
            ts: 1000,
        });
        // 80 KiB single line (exceeds our 16 KiB test maxLineBytes)
        const hugeCorruptLine = `{"id":"m_huge","role":"assistant","content":"${'X'.repeat(80 * 1024)}"}`;
        const msg2 = JSON.stringify({
            id: 'm2',
            revision: 2,
            role: 'assistant',
            content: '第二条正常回答',
            ts: 2000,
        });
        const jsonlPath = path.join(sessDir, 'messages.jsonl');
        fs.writeFileSync(jsonlPath, `${msg1}\n${hugeCorruptLine}\n${msg2}\n`);

        const io = createGioSessionIo();
        const boundedRead = await io.readJsonlBounded(jsonlPath, {
            maxLineBytes: 16 * 1024,
            maxTotalBytes: 1024 * 1024,
            maxRetainedLines: 100,
        });
        assert.equal(boundedRead.lines.length, 2, 'Must retain the 2 valid lines around the oversized line');
        assert.equal(boundedRead.corruptLines.length, 1, 'Must isolate the 1 oversized line');
        assert.equal(boundedRead.corruptLines[0].reason, 'line_too_large');

        const store = new SessionStore('sess_r5_jsonl', {
            sessionsRootDir: sessionsRoot,
            io,
            maxLineBytes: 16 * 1024,
        });
        await store.load('openai', {model: 'gpt-4o-mini'});
        assert.equal(store.messages.length, 2, 'SessionStore.load must recover both valid messages');
        assert.equal(store.corruptLineCount, 1, 'SessionStore.load must count the oversized line as corrupt');
        await store.flush();
        assert.ok(fs.existsSync(path.join(sessDir, 'corrupt.jsonl')), 'Oversized line preview must be isolated to corrupt.jsonl');
    } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});

test('R5.4: TurnController and HistoryWindowController enforce cumulative byte budgets without losing terminal state', async () => {
    const events = [];
    const controller = new TurnController(ev => events.push(ev), {
        maxTurnTextBytes: 2048,
        maxTurnThinkingBytes: 1024,
        maxToolDetailBytesPerEvent: 512,
        maxTurnToolEventsBytes: 1200,
    });

    const turn = controller.beginTurn({
        turnId: 'turn_r5_budget',
        messageId: 'msg_r5_budget',
        sessionId: 'sess_r5_budget',
        backend: 'zcode',
    });

    const chunk500 = '礼'.repeat(200); // 600 UTF-8 bytes
    for (let i = 0; i < 10; i++) {
        controller.appendText(turn, chunk500, `seg_${i % 2}`);
        controller.appendThinking(turn, chunk500, 'think_0');
    }

    assert.equal(turn.textBudgetTruncated, true, 'Cumulative text exceeding maxTurnTextBytes must be truncated');
    assert.ok(
        Buffer.byteLength(turn.text, 'utf8') <= 2048,
        `Truncated turn.text (${Buffer.byteLength(turn.text, 'utf8')}B) must stay within maxTurnTextBytes (2048B)`
    );
    assert.match(turn.text, /输出已达单轮内存上限/);

    assert.equal(turn.thinkingBudgetTruncated, true, 'Cumulative thinking exceeding maxTurnThinkingBytes must be truncated');
    assert.ok(
        Buffer.byteLength(turn.thinking, 'utf8') <= 1024,
        `Truncated turn.thinking (${Buffer.byteLength(turn.thinking, 'utf8')}B) must stay within maxTurnThinkingBytes (1024B)`
    );

    // Emit 5 tool events each with 1000 bytes of detail
    for (let i = 0; i < 5; i++) {
        controller.emitForTurn(turn, {
            type: 'tool_execution_update',
            toolCallId: `call_${i}`,
            toolName: 'Bash',
            detail: 'D'.repeat(1000),
        });
    }
    assert.equal(turn.toolEventsBudgetTruncated, true, 'Cumulative tool event details must be capped');
    const toolEvents = events.filter(e => e.type === 'tool_execution_update');
    assert.equal(toolEvents.length, 5, 'All tool events must still be emitted for state tracking');
    assert.match(toolEvents[4].detail, /工具日志累计已达单轮上限/, 'Later tool events must omit bulky detail once budget is exhausted');

    // Finalize turn and verify terminal state is preserved
    controller.finalizeTurn(turn, {status: 'completed'});
    const settled = events.find(e => e.type === 'agent_settled');
    assert.ok(settled, 'Turn must still emit agent_settled after hitting byte budgets');
    assert.equal(settled.status, 'completed');

    // Verify HistoryWindowController data-layer budget
    const historyWindow = new HistoryWindowController({
        initialPageSize: 4,
        pageSize: 4,
        maxMountedActors: 6,
        maxSingleMessageDataBytes: 2048,
        maxHistoryDataBytes: 8192,
    });

    const largeMessages = Array.from({length: 20}, (_, i) => ({
        id: `m_${i + 1}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `Message ${i + 1}: ` + '内'.repeat(1200), // ~3600 bytes each before cap
    }));

    historyWindow.reset(largeMessages);
    assert.ok(
        historyWindow.totalDataBytes <= 8192,
        `HistoryWindowController totalDataBytes (${historyWindow.totalDataBytes}) must stay within maxHistoryDataBytes (8192)`
    );
    assert.ok(historyWindow.compactedCount > 0, 'Older messages must be compacted when totalDataBytes exceeds budget');
});
