// Shared Production-Path Integration Fixtures for Node (`npm test`) and GJS (`gjs -m tests/gjs_smoke.js`) (Stage R10).
// Pure JS module with zero runtime-specific imports so both SpiderMonkey/GJS and Node import the exact same fixtures.

/**
 * Generates an executable Node.js script that acts as the ZCode CLI target under `zcodeBridge.cjs`
 * (`NODE_OPTIONS="--require .../zcodeBridge.cjs"`).
 *
 * Exercises:
 * 1. Real `DenyPermissionBroker.prototype.requestPermission` monkey-patched by `zcodeBridge.cjs`.
 * 2. Parallel tool execution events (`call_r10_read_1`, `call_r10_grep_2`) + `tool_batch_end`.
 * 3. Interactive `AskUserQuestion` (`req_r10_q_1`) with multi-select and custom answer via `decision = 'modify'`.
 * 4. Delayed approval + session scope auto-approval (`req_r10_web_1` -> `req_r10_web_2`).
 * 5. Optional stubborn child process ignoring `SIGTERM` (`spawnStubbornChild: true`) for process-group cleanup verification.
 */
export function buildFakeZCodeCliScriptSource({
    stubbornChildPidFile = '',
    holdOpenAfterToolsMs = 0,
} = {}) {
    return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const {spawn} = require('node:child_process');

function DenyPermissionBroker() {}
Object.defineProperty(DenyPermissionBroker.prototype, 'requestPermission', {
    value: async () => ({decision: 'deny'}),
    writable: true,
    configurable: true,
});

const broker = new DenyPermissionBroker();

const stubbornPidFile = ${JSON.stringify(String(stubbornChildPidFile || ''))};
if (stubbornPidFile) {
    const child = spawn(process.execPath, [
        '-e',
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 5000);',
    ], {
        stdio: 'ignore',
    });
    fs.writeFileSync(stubbornPidFile, String(child.pid));
}

function writeJsonLine(obj) {
    process.stdout.write(JSON.stringify(obj) + '\\n');
}

(async () => {
    // 1. Emit parallel tool start/update/end events in ZCode wire format (type: 'tool.updated')
    writeJsonLine({
        type: 'tool.updated',
        payload: {
            kind: 'started',
            toolCallId: 'call_r10_read_1',
            toolName: 'Read',
            input: {file_path: 'README.md'},
        },
    });
    writeJsonLine({
        type: 'tool.updated',
        payload: {
            kind: 'started',
            toolCallId: 'call_r10_grep_2',
            toolName: 'Grep',
            input: {pattern: 'Quick Chat'},
        },
    });
    writeJsonLine({
        type: 'tool.updated',
        payload: {
            kind: 'updated',
            toolCallId: 'call_r10_read_1',
            toolName: 'Read',
            progress: 'reading README.md',
        },
    });
    writeJsonLine({
        type: 'tool.updated',
        payload: {
            kind: 'result',
            toolCallId: 'call_r10_read_1',
            toolName: 'Read',
            result: {isError: false, summary: 'ok'},
        },
    });
    writeJsonLine({
        type: 'tool.updated',
        payload: {
            kind: 'result',
            toolCallId: 'call_r10_grep_2',
            toolName: 'Grep',
            result: {isError: false, summary: 'ok'},
        },
    });

    if (${Number(holdOpenAfterToolsMs) || 0} > 0) {
        await new Promise(r => setTimeout(r, ${Number(holdOpenAfterToolsMs) || 0}));
    }

    // 2. Interactive AskUserQuestion through real zcodeBridge.cjs broker
    const qRes = await broker.requestPermission({
        requestId: 'req_r10_q_1',
        toolCallId: 'call_r10_q_1',
        toolName: 'AskUserQuestion',
        input: {
            questions: [
                {
                    id: 'q_target_env',
                    question: '请选择目标环境',
                    options: [{label: 'GNOME 50'}, {label: 'Wayland'}],
                    multiSelect: true,
                },
            ],
        },
    });

    // 3. Two WebFetch approvals sharing the same scope key so the second is auto-approved after session scope save
    const webRes1 = await broker.requestPermission({
        requestId: 'req_r10_web_1',
        toolCallId: 'call_r10_web_1',
        toolName: 'WebFetch',
        input: {url: 'https://developer.gnome.org/hig/'},
    });
    const webRes2 = await broker.requestPermission({
        requestId: 'req_r10_web_2',
        toolCallId: 'call_r10_web_2',
        toolName: 'WebFetch',
        input: {url: 'https://developer.gnome.org/gjs/'},
    });

    writeJsonLine({
        type: 'result',
        sessionId: 'zcode_remote_sess_r10',
        response: JSON.stringify({
            questionDecision: qRes.decision,
            questionAnswers: qRes.modifiedInput ? qRes.modifiedInput.answers : null,
            web1Decision: webRes1.decision,
            web2Decision: webRes2.decision,
        }),
        is_error: false,
    });
    writeJsonLine({
        type: 'turn.completed',
    });
    process.exit(0);
})();
`;
}

/**
 * Generates an executable Node.js script that acts as `codex exec --json`.
 *
 * Exercises:
 * 1. Stdin prompt reception.
 * 2. `thread.started` (`thread_id`) + `turn.started`.
 * 3. Parallel `item.started` / `item.updated` / `item.completed` for `command_execution` tools.
 * 4. `agent_message` streaming & completion + `turn.completed`.
 */
export function buildFakeCodexCliScriptSource({
    exitCode = 0,
} = {}) {
    return `#!/usr/bin/env node
'use strict';

let stdinText = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    stdinText += chunk;
});
process.stdin.on('end', () => {
    const emit = obj => process.stdout.write(JSON.stringify(obj) + '\\n');
    emit({type: 'thread.started', thread_id: 'codex_thread_r10_prod'});
    emit({type: 'turn.started'});
    emit({
        type: 'item.started',
        item: {id: 'codex_cmd_1', type: 'command_execution', command: 'git status -s', status: 'in_progress'},
    });
    emit({
        type: 'item.updated',
        item: {id: 'codex_cmd_1', type: 'command_execution', command: 'git status -s', status: 'in_progress'},
    });
    emit({
        type: 'item.started',
        item: {id: 'codex_cmd_2', type: 'command_execution', command: 'ls -la', status: 'in_progress'},
    });
    emit({
        type: 'item.completed',
        item: {id: 'codex_cmd_1', type: 'command_execution', command: 'git status -s', status: 'completed', exit_code: 0},
    });
    emit({
        type: 'item.completed',
        item: {id: 'codex_cmd_2', type: 'command_execution', command: 'ls -la', status: 'completed', exit_code: 0},
    });
    emit({
        type: 'item.completed',
        item: {
            id: 'codex_msg_1',
            type: 'agent_message',
            text: 'Codex 生产路径正常（stdin 长度=' + stdinText.length + '）',
        },
    });
    emit({
        type: 'turn.completed',
        usage: {input_tokens: 18, output_tokens: 9},
    });
    process.exit(${Number(exitCode) || 0});
});
`;
}

/**
 * Generates an executable Node.js script that starts two real localhost HTTP servers (`Origin A` and `Origin B`)
 * for testing `OpenAIAdapter` and `readSoupResponseBytesBoundedAsync` across both Node and GJS (`gi://Soup?version=3.0`).
 */
export function buildMockOpenAiDualOriginServerScriptSource({
    statsFile = '',
} = {}) {
    return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const http = require('node:http');

const statsFile = ${JSON.stringify(String(statsFile || ''))};
const stats = {
    originBRequests: [],
    originAChatPostCount: 0,
};

function saveStats() {
    if (!statsFile) return;
    try {
        fs.writeFileSync(statsFile, JSON.stringify(stats));
    } catch (_) {}
}
saveStats();

const serverB = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString('utf8');
    });
    req.on('end', () => {
        stats.originBRequests.push({
            method: req.method,
            url: req.url,
            hasAuthorization: Boolean(req.headers.authorization),
            bodyLength: body.length,
        });
        saveStats();
        if (req.url === '/v1/models') {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({
                data: [{id: 'origin-b-redirected-model', context_length: 16384}],
            }));
            return;
        }
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ok: true}));
    });
});

let originBBase = '';

const serverA = http.createServer((req, res) => {
    if (req.url === '/v1/models' && req.method === 'GET') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({
            data: [
                {id: 'gpt-4o-mini', context_length: 128000, supports_reasoning: false},
                {id: 'o3-mini', context_length: 200000, supports_reasoning: true},
            ],
        }));
        return;
    }
    if (req.url === '/v1/models-redirect' && req.method === 'GET') {
        res.writeHead(307, {Location: originBBase + '/models'});
        res.end();
        return;
    }
    if (req.url === '/v1/models-oversized' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked',
        });
        res.write('{"data":[');
        const bigChunk = Buffer.alloc(16 * 1024, 'x');
        let sent = 0;
        const timer = setInterval(() => {
            if (res.destroyed || res.writableEnded) {
                clearInterval(timer);
                return;
            }
            sent += bigChunk.length;
            res.write(bigChunk);
            if (sent >= 512 * 1024) {
                clearInterval(timer);
                res.end(']}');
            }
        }, 5);
        req.on('close', () => clearInterval(timer));
        return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString('utf8');
        });
        req.on('end', () => {
            stats.originAChatPostCount += 1;
            saveStats();
            let parsed = {};
            try { parsed = JSON.parse(body); } catch (_) {}
            const lastUserContent = String(parsed.messages?.at(-1)?.content || '');

            if (lastUserContent.includes('[SCENARIO:REDIRECT_307]')) {
                res.writeHead(307, {Location: originBBase + '/chat/completions'});
                res.end();
                return;
            }
            if (lastUserContent.includes('[SCENARIO:HTTP_400_CAPABILITY]')) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({
                    error: {
                        message: 'Unrecognized request argument supplied: reasoning_effort',
                        code: 'unknown_parameter',
                    },
                }));
                return;
            }
            if (lastUserContent.includes('[SCENARIO:TRUNCATED_EOF]')) {
                res.writeHead(200, {'Content-Type': 'text/event-stream'});
                res.write('data: ' + JSON.stringify({
                    id: 'chatcmpl-trunc',
                    model: parsed.model || 'gpt-4o-mini',
                    choices: [{index: 0, delta: {content: '半截回答但流异常断开'}, finish_reason: null}],
                }) + '\\n\\n');
                res.end();
                return;
            }
            if (lastUserContent.includes('[SCENARIO:SLOW_CANCEL]')) {
                res.writeHead(200, {'Content-Type': 'text/event-stream'});
                res.write('data: ' + JSON.stringify({
                    id: 'chatcmpl-slow',
                    model: parsed.model || 'gpt-4o-mini',
                    choices: [{index: 0, delta: {content: '正在生成第一段…'}, finish_reason: null}],
                }) + '\\n\\n');
                const t = setTimeout(() => {
                    if (!res.destroyed && !res.writableEnded) res.end();
                }, 5000);
                req.on('close', () => clearTimeout(t));
                return;
            }

            let memoryAnswer = '';
            if (lastUserContent.startsWith('总结可跨会话复用')) {
                if (lastUserContent.includes('TEST_MIXED_RECEIPT')) {
                    memoryAnswer = JSON.stringify([
                        {scope: 'computer', name: 'MEMORY.md', markdown: '[更新](preview.md)'},
                        {scope: 'computer', name: 'preview.md', markdown: 'Updated'},
                        {scope: 'project', name: 'MEMORY.md', markdown: ''},
                        {scope: 'project', name: 'preview.md', markdown: null},
                    ]);
                } else if (lastUserContent.includes('TEST_EXPERIENCE_')) {
                    const context = JSON.parse(lastUserContent.split('\\n').at(-1));
                    const note = context.notes['memory://computer/preview.md'];
                    const update = (name, markdown) => ({scope: 'computer', name, markdown});
                    let changes = [];
                    if (context.user.includes('TEST_EXPERIENCE_FIRST')) {
                        changes = [update('MEMORY.md', '[经验](preview.md)'), update('preview.md', '# 偏好 A')];
                    } else if (context.user.includes('TEST_EXPERIENCE_CORRECT') && note === '# 偏好 A') {
                        changes = [update('preview.md', '# 偏好 B')];
                    } else if (context.user.includes('TEST_EXPERIENCE_FORGET') && note === '# 偏好 B') {
                        changes = [update('preview.md', null), update('MEMORY.md', '')];
                    }
                    memoryAnswer = JSON.stringify(changes);
                } else if (lastUserContent.includes('TEST_MEMORY_FAIL')) {
                    memoryAnswer = 'invalid model response';
                } else if (lastUserContent.includes('TEST_MEMORY_UNINDEX')) {
                    memoryAnswer = JSON.stringify([{scope: 'computer', name: 'MEMORY.md', markdown: ''}]);
                } else if (lastUserContent.includes('TEST_MEMORY_FORGET')) {
                    memoryAnswer = JSON.stringify([
                        {scope: 'computer', name: 'MEMORY.md', markdown: ''},
                        {scope: 'computer', name: 'preview.md', markdown: null},
                    ]);
                } else if (lastUserContent.includes('TEST_MEMORY_WRITE')) {
                    memoryAnswer = JSON.stringify([
                        {scope: 'computer', name: 'MEMORY.md', markdown: '[测试笔记](preview.md)'},
                        {scope: 'computer', name: 'preview.md', markdown: 'Verified shared-memory note'},
                    ]);
                } else {
                    memoryAnswer = lastUserContent.includes('TEST_MEMORY_AFTER_FORGET') &&
                        lastUserContent.includes('Verified shared-memory note') ? 'stale snapshot' : '[]';
                }
            } else if (lastUserContent.startsWith('只返回与当前任务最相关')) {
                memoryAnswer = JSON.stringify(lastUserContent.includes('TEST_MIXED_RECEIPT')
                    ? ['memory://computer/preview.md', 'memory://project/preview.md'] : ['memory://computer/preview.md']);
            } else if (lastUserContent.includes('TEST_MEMORY_RECALL')) {
                memoryAnswer = lastUserContent.includes('Verified shared-memory note')
                    ? 'RECALL_OK' : 'RECALL_MISSING';
            }
            if (memoryAnswer) {
                const replyMemory = () => {
                    res.writeHead(200, {'Content-Type': 'text/event-stream'});
                    res.write('data: ' + JSON.stringify({choices: [{index: 0,
                        delta: {content: memoryAnswer}, finish_reason: 'stop'}]}) + '\\n\\n');
                    res.end('data: [DONE]\\n\\n');
                };
                if (lastUserContent.startsWith('总结可跨会话复用') && /TEST_MEMORY_(?:FORGET|FAIL)/.test(lastUserContent)) {
                    setTimeout(replyMemory, 900);
                } else replyMemory();
                return;
            }

            const finishReason = lastUserContent.includes('[SCENARIO:FINISH_LENGTH]') ? 'length' : 'stop';
            res.writeHead(200, {'Content-Type': 'text/event-stream'});
            const c1 = {
                id: 'chatcmpl-ok',
                model: parsed.model || 'gpt-4o-mini',
                choices: [{index: 0, delta: {reasoning_content: '思考过程', content: '你好🚀，'}, finish_reason: null}],
            };
            const c2 = {
                id: 'chatcmpl-ok',
                model: parsed.model || 'gpt-4o-mini',
                choices: [{index: 0, delta: {content: '生产路径正常'}, finish_reason: finishReason}],
                usage: {prompt_tokens: 15, completion_tokens: 8, total_tokens: 23},
            };
            res.write('data: ' + JSON.stringify(c1) + '\\n\\n');
            res.write('data: ' + JSON.stringify(c2) + '\\n\\n');
            res.write('data: [DONE]\\n\\n');
            res.end();
        });
        return;
    }
    res.writeHead(404);
    res.end();
});

serverB.listen(0, '127.0.0.1', () => {
    const portB = serverB.address().port;
    originBBase = 'http://127.0.0.1:' + portB + '/v1';
    serverA.listen(0, '127.0.0.1', () => {
        const portA = serverA.address().port;
        process.stdout.write('READY:' + portA + ':' + portB + '\\n');
    });
});

process.on('SIGTERM', () => {
    try { serverA.close(); } catch (_) {}
    try { serverB.close(); } catch (_) {}
    process.exit(0);
});
`;
}

export function buildMemoryCliScriptSource(backend, logPath) {
    return `#!/usr/bin/env node
const fs = require('node:fs');
const backend = ${JSON.stringify(backend)};
const args = process.argv.slice(2);
let stdin = '';
function respond() {
    const prompt = backend === 'zcode'
        ? (args.find(arg => arg.startsWith('--prompt=')) || '').slice('--prompt='.length)
        : stdin;
    const recall = prompt.includes('只返回与当前任务最相关');
    const update = prompt.includes('总结可跨会话复用');
    const hasMemory = prompt.includes('Verified shared-memory note');
    const expected = recall || update;
    const readonly = backend === 'codex' ? args.includes('sandbox_mode="read-only"')
        : backend === 'zcode' ? args.includes('plan')
        : args[args.indexOf('--permission-mode') + 1] === 'read-only';
    const overlay = backend === 'dsh' ? fs.readFileSync(args[args.indexOf('--patch') + 1], 'utf8') : '';
    const instructions = backend === 'dsh' ? overlay : prompt;
    const evidence = update ? JSON.parse(prompt.split('\\n').at(-1)) : null;
    fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({recall, update, readonly, hasMemory, instructions, evidence}) + '\\n');
    if (expected !== readonly) process.exit(2);
    let answer = 'CLI main turn';
    if (recall) answer = JSON.stringify(['memory://computer/preview.md']);
    else if (update) answer = prompt.includes('TEST_MEMORY_WRITE') ? JSON.stringify([
        {scope: 'computer', name: 'MEMORY.md', markdown: '[测试笔记](preview.md)'},
        {scope: 'computer', name: 'preview.md', markdown: 'Verified shared-memory note'},
    ]) : '[]';
    else if (prompt.includes('TEST_MEMORY_RECALL')) answer = hasMemory ? 'RECALL_OK' : 'RECALL_MISSING';
    const emit = obj => console.log(JSON.stringify(obj));
    if (!expected && prompt.includes('TEST_TOOL_EVIDENCE') && backend !== 'codex') {
        const sensitive = 'Bearer test-secret-123456 ' + 'raw stdout '.repeat(400);
        const tool = (id, kind, status, name = 'Probe') => {
            if (backend === 'zcode') {
                emit({type: 'tool.updated', payload: {
                    kind, toolCallId: id, toolName: name, input: {command: sensitive},
                    result: {isError: status === 'error' ? true : status === 'completed' ? false : undefined,
                        summary: sensitive},
                }});
            } else if (kind === 'started') {
                emit({type: 'tool_call', callId: id, tool: name, input: {command: sensitive}});
            } else {
                emit({type: 'tool_result', callId: id, status, result: sensitive});
            }
        };
        tool('same-1', 'started');
        tool('same-2', 'started');
        tool('same-2', 'result', 'error');
        tool('same-1', 'result', 'completed');
        tool('same-1', 'result', 'completed');
        tool('unknown', 'result', undefined, 'Uncertain');
        tool('unfinished', 'started', undefined, 'Unfinished');
        tool('', 'result', 'completed', 'MissingId');
        tool('secret', 'result', 'completed', 'sk-testsecret123456789');
        for (let index = 0; index < 20; index++) tool('extra-' + index, 'result', 'completed', 'Extra');
    }
    if (backend === 'codex') {
        emit({type: 'thread.started', thread_id: 'memory-thread'});
        emit({type: 'item.completed', item: {id: 'result', type: 'agent_message', text: answer}});
        emit({type: 'turn.completed'});
    } else if (backend === 'zcode') {
        emit({type: 'result', sessionId: 'memory-zcode', response: answer, is_error: false});
        emit({type: 'turn.completed'});
    } else {
        emit({type: 'session', sessionId: 'memory-dsh'});
        emit({type: 'final', reason: {kind: 'completed'}, sessionId: 'memory-dsh', text: answer});
    }
}
if (backend === 'zcode') respond();
else {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { stdin += chunk; });
    process.stdin.on('end', respond);
}
`;
}
