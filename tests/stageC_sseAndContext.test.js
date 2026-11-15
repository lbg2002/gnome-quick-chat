import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
    OpenAISseParser,
    parseModelsResponse,
    supportsOpenAIReasoningEffort,
    redactSensitiveText,
    resolveSplitTimeouts,
} from '../runtime/sseParser.js';
import {
    buildRuntimeContextSignature,
    buildBudgetedContextMessages,
    buildCrossBackendPromptWithContext,
    preparePromptWithinBudget,
} from '../core/contextManager.js';
import {SessionStoreEngine} from '../core/sessionEngine.js';
import {TurnController} from '../core/turnController.js';
import {normalizeEvent} from '../protocol.js';

test('Stage C3: OpenAISseParser handles CRLF splits, mid-character Chinese/emoji UTF-8 byte chunks, multi-line data, comments, usage, and [DONE]', () => {
    const parser = new OpenAISseParser();
    const rawSseStream = [
        ': keepalive comment\r\n',
        'event: message\r\n',
        'data: {"model":"deepseek-r1","choices":[{"delta":\r\n',
        'data: {"reasoning_content":"先思考中文🧪"}}]}\r\n',
        '\r\n',
        'data: {"choices":[{"delta":{"content":"你好，世界🚀！"}}]}\r\n\r\n',
        'data: {"choices":[{"delta":{"content":"再见。"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":8}}\r\n\r\n',
        'data: [DONE]\r\n\r\n',
    ].join('');

    const fullBytes = new TextEncoder().encode(rawSseStream);
    const collected = [];
    // Feed 2 bytes at a time so multi-byte UTF-8 characters (3–4 bytes) and `\r\n` are split right down the middle!
    for (let offset = 0; offset < fullBytes.byteLength; offset += 2) {
        const slice = fullBytes.subarray(offset, Math.min(fullBytes.byteLength, offset + 2));
        collected.push(...parser.pushBytes(slice));
    }
    const fin = parser.finish();
    collected.push(...fin.events);

    assert.equal(fin.completedCleanly, true);
    assert.equal(fin.interrupted, false);
    assert.equal(fin.error, '');
    assert.equal(fin.model, 'deepseek-r1');
    assert.equal(fin.finishReason, 'stop');
    assert.deepEqual(fin.usage, {prompt_tokens: 12, completion_tokens: 8});

    const thinking = collected.filter(e => e.type === 'delta').map(e => e.thinkingDelta || '').join('');
    const text = collected.filter(e => e.type === 'delta').map(e => e.textDelta || '').join('');
    assert.equal(thinking, '先思考中文🧪');
    assert.equal(text, '你好，世界🚀！再见。');
    assert.equal(collected.some(e => e.type === 'done'), true);
});

test('Stage C3: OpenAISseParser supports valid non-SSE JSON fallback, flags unterminated EOF as interrupted without polluting text, and enforces byte caps', () => {
    // 1. Non-SSE JSON fallback
    const jsonParser = new OpenAISseParser();
    const body = JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o-mini',
        choices: [{
            index: 0,
            message: {role: 'assistant', content: '非流式完整 JSON 回答', reasoning_content: '简短推理'},
            finish_reason: 'stop',
        }],
        usage: {total_tokens: 42},
    });
    assert.deepEqual(jsonParser.pushBytes(new TextEncoder().encode(body)), []);
    const jsonFin = jsonParser.finish();
    assert.equal(jsonFin.completedCleanly, true);
    assert.equal(jsonFin.interrupted, false);
    assert.equal(jsonFin.isNonSseJson, true);
    assert.equal(jsonFin.nonSseText, '非流式完整 JSON 回答');
    assert.equal(jsonFin.nonSseThinking, '简短推理');

    // 2. Unterminated SSE EOF (network drop mid-answer without [DONE] or finish_reason)
    const dropParser = new OpenAISseParser();
    const events = dropParser.pushText('data: {"choices":[{"delta":{"content":"半截回答"}}]}\n\n');
    assert.equal(events.length, 1);
    assert.equal(events[0].textDelta, '半截回答');
    const dropFin = dropParser.finish();
    assert.equal(dropFin.completedCleanly, false);
    assert.equal(dropFin.interrupted, true);
    // Must NEVER inject network warning text into textDelta!
    assert.equal(dropFin.events.filter(e => e.textDelta).length, 0);

    // 3. Mid-stream API error with secret redaction
    const errParser = new OpenAISseParser({apiKey: 'my-super-secret-token-999'});
    const errOut = errParser.pushText(
        'event: error\ndata: {"error":{"message":"Quota exceeded for key my-super-secret-token-999 Bearer sk-1234567890abcdef"}}\n\n'
    );
    assert.equal(errOut.length, 1);
    assert.equal(errOut[0].type, 'error');
    assert.doesNotMatch(errOut[0].error, /my-super-secret-token-999/);
    assert.doesNotMatch(errOut[0].error, /sk-1234567890abcdef/);

    // 4. Byte limit enforcement
    const cappedParser = new OpenAISseParser({limits: {maxEventBytes: 64, maxNonSseBytes: 128}});
    const overOut = cappedParser.pushText(`data: ${'x'.repeat(200)}\n\n`);
    assert.equal(overOut.some(e => e.type === 'error'), true);
});

test('Stage C3: Real localhost HTTP SSE chunked streaming integration test', async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/v1/models') {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({
                data: [
                    {id: 'first-default-model', context_length: 16384},
                    {id: 'user-chosen-model', context_length: 65536},
                ],
            }));
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        const fullFrame = Buffer.from(
            'data: {"model":"user-chosen-model","choices":[{"delta":{"content":"本地实时流测试：成功！"}}]}\r\n\r\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n' +
            'data: [DONE]\r\n\r\n',
            'utf8'
        );
        // Deliberately split across two network writes mid-UTF-8 character
        res.write(fullFrame.subarray(0, 59));
        setTimeout(() => {
            res.end(fullFrame.subarray(59));
        }, 10);
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address();
    try {
        // Test /v1/models status check & user-selected model precedence
        const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`);
        const modelsBytes = new Uint8Array(await modelsRes.arrayBuffer());
        const parsedModels = parseModelsResponse(modelsRes.status, modelsBytes, {
            preferredModel: 'user-chosen-model',
        });
        assert.deepEqual(parsedModels.models, ['first-default-model', 'user-chosen-model']);
        assert.equal(parsedModels.selectedModel, 'user-chosen-model');
        assert.equal(parsedModels.metadataById['user-chosen-model'].contextWindowTokens, 65536);

        // Test SSE stream parsing over real HTTP response body chunks
        const chatRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {method: 'POST'});
        const sse = new OpenAISseParser();
        let assembled = '';
        for await (const chunk of chatRes.body) {
            for (const ev of sse.pushBytes(chunk)) {
                if (ev.type === 'delta' && ev.textDelta) assembled += ev.textDelta;
            }
        }
        const done = sse.finish();
        assert.equal(done.completedCleanly, true);
        assert.equal(assembled, '本地实时流测试：成功！');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('Stage C3: parseModelsResponse HTTP status check, reasoning_effort capability, and split timeouts', () => {
    assert.throws(
        () => parseModelsResponse(401, '{"error":{"message":"Invalid key sk-secret1234567890"}}', {apiKey: 'sk-secret1234567890'}),
        err => /HTTP 401/.test(err.message) && !/sk-secret1234567890/.test(err.message)
    );
    assert.throws(
        () => parseModelsResponse(200, 'x'.repeat(2048), {maxBytes: 512}),
        /超过安全上限/
    );

    assert.equal(supportsOpenAIReasoningEffort('o3-mini'), true);
    assert.equal(supportsOpenAIReasoningEffort('gpt-5-mini'), true);
    assert.equal(supportsOpenAIReasoningEffort('deepseek/deepseek-reasoner'), true);
    assert.equal(supportsOpenAIReasoningEffort('qwq-32b'), true);
    assert.equal(supportsOpenAIReasoningEffort('gpt-4o-mini'), false);
    assert.equal(supportsOpenAIReasoningEffort('llama-3.3-70b'), false);
    assert.equal(supportsOpenAIReasoningEffort('custom-model', true), true);

    assert.equal(
        redactSensitiveText('GET https://host/v1?api_key=abc123secret&x=1'),
        'GET https://host/v1?api_key=[REDACTED]&x=1'
    );

    const timeouts = resolveSplitTimeouts();
    assert.ok(timeouts.toolExecutionTimeoutSec > timeouts.streamIdleTimeoutSec);
    assert.ok(timeouts.approvalTimeoutSec >= 300);
});

test('Stage C3: TurnController aggregates multi-message turns by segmentId and emits text_replace on non-prefix snapshot rewrites', () => {
    const events = [];
    const persisted = [];
    const controller = new TurnController(ev => events.push(ev));

    const turn = controller.beginTurn({
        turnId: 'turn_seg_1',
        messageId: 'asst_msg_1',
        replyTo: 'user_msg_1',
        sessionId: 'default',
        clientGeneration: 3,
        backend: 'codex',
        modelId: 'codex-1',
    });

    // Codex emits item_1 ("我先检查目录。"), runs a tool, then emits item_3 ("检查完毕，草稿" -> updated -> completed)
    const ev1 = normalizeEvent('codex', {
        type: 'item.completed',
        item: {id: 'item_1', type: 'agent_message', text: '我先检查目录。'},
    });
    const ev2 = normalizeEvent('codex', {
        type: 'item.updated',
        item: {id: 'item_3', type: 'agent_message', text: '检查完毕，草稿'},
    });
    // Non-prefix correction on item_3 ("检查完毕，共 3 个文件。") -> must overwrite item_3 via text_replace, NOT append!
    const ev3 = normalizeEvent('codex', {
        type: 'item.completed',
        item: {id: 'item_3', type: 'agent_message', text: '检查完毕，共 3 个文件。'},
    });

    controller.replaceText(turn, ev1.message.content, ev1.segmentId);
    controller.replaceText(turn, ev2.text, ev2.segmentId);
    controller.replaceText(turn, ev3.message.content, ev3.segmentId);

    controller.finalizeTurn(turn, {
        status: 'completed',
        onPersistAssistant: msg => persisted.push(msg),
    });

    const expectedAuthoritativeText = '我先检查目录。\n\n检查完毕，共 3 个文件。';
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].content.find(c => c.type === 'text').text, expectedAuthoritativeText);
    assert.equal(persisted[0].replyTo, 'user_msg_1');
    assert.equal(persisted[0].modelId, 'codex-1');

    // Verify `text_replace` was emitted for the non-prefix rewrite and `message_end` matches `SessionStore` 100%
    const replaceEvents = events.filter(
        e => e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_replace'
    );
    assert.equal(replaceEvents.length, 1);
    assert.equal(replaceEvents[0].assistantMessageEvent.text, expectedAuthoritativeText);

    const msgEnd = events.find(e => e.type === 'message_end');
    assert.equal(msgEnd.message.content.find(c => c.type === 'text').text, expectedAuthoritativeText);
});

test('Stage C2: Context signature binding, cross-backend remoteSyncedRevision invalidation, and clean whole-turn context budgeting', async () => {
    // 1. Runtime context signature changes on backend, model, endpoint, workspace, or permission mode change
    const baseCfg = {provider: 'glm', model: 'glm-5', workspace: '/home/u/proj', effectiveMode: 'readonly'};
    const sigBase = buildRuntimeContextSignature('zcode', baseCfg);
    assert.notEqual(sigBase, buildRuntimeContextSignature('codex', baseCfg));
    assert.notEqual(sigBase, buildRuntimeContextSignature('zcode', {...baseCfg, model: 'glm-4'}));
    assert.notEqual(sigBase, buildRuntimeContextSignature('zcode', {...baseCfg, workspace: '/home/u/other'}));
    assert.notEqual(sigBase, buildRuntimeContextSignature('zcode', {...baseCfg, effectiveMode: 'full'}));
    assert.notEqual(
        buildRuntimeContextSignature('openai', {openaiBaseUrl: 'https://api.openai.com/v1', openaiModel: 'gpt-4o'}),
        buildRuntimeContextSignature('openai', {openaiBaseUrl: 'https://api.deepseek.com/v1', openaiModel: 'gpt-4o'})
    );

    // 2. Cross-backend revision tracking: switching ZCode -> OpenAI -> ZCode invalidates stale remoteSessionId!
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-stagec2-handoff-'));
    try {
        const memFiles = new Map();
        const memIo = {
            exists: async p => memFiles.has(p),
            readText: async p => memFiles.get(p) || '',
            appendLine: async (p, l) => memFiles.set(p, (memFiles.get(p) || '') + (l.endsWith('\n') ? l : `${l}\n`)),
            replaceFile: async (p, c) => memFiles.set(p, c),
        };
        const store = new SessionStoreEngine('handoff_sess', {
            sessionsRootDir: tmpRoot,
            io: memIo,
            buildContextSignature: buildRuntimeContextSignature,
        });
        await store.load('zcode', baseCfg);
        store.appendMessage({id: 'u1', role: 'user', content: 'ZCode 第一问'}, 'zcode', baseCfg);
        store.appendMessage({id: 'a1', role: 'assistant', content: 'ZCode 第一答'}, 'zcode', baseCfg);
        await store.setRemoteSessionId('zcode_remote_abc', 'zcode', baseCfg);
        assert.equal(store.remoteSessionId, 'zcode_remote_abc');

        // User switches to OpenAI in the same session: remoteSessionId must clear and OpenAI turn advances revision!
        await store.load('openai', {openaiBaseUrl: 'https://api.openai.com/v1', openaiModel: 'gpt-4o'});
        assert.equal(store.remoteSessionId, '');
        store.appendMessage({id: 'u2', role: 'user', content: 'OpenAI 第二问'}, 'openai', {openaiModel: 'gpt-4o'});
        store.appendMessage({id: 'a2', role: 'assistant', content: 'OpenAI 第二答'}, 'openai', {openaiModel: 'gpt-4o'});

        // Cross-backend handoff back to ZCode injects both ZCode & OpenAI turns cleanly
        const handoffPrompt = buildCrossBackendPromptWithContext(store.messages, 'ZCode 第三问');
        assert.match(handoffPrompt, /OpenAI 第二问/);
        assert.match(handoffPrompt, /OpenAI 第二答/);
        assert.match(handoffPrompt, /ZCode 第三问/);
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }

    // 3. Sanitization: strips hidden thinking, toolResult, internal env header, and UI error banners
    const dirtyHistory = [
        {role: 'user', content: '[Ubuntu GNOME 用户目录环境：桌面=~/Desktop]\n帮我算 1+1'},
        {
            role: 'assistant',
            content: [
                {type: 'thinking', thinking: '绝密思维链不应重发云端'},
                {type: 'text', text: '等于 2。'},
            ],
        },
        {role: 'toolResult', content: 'SECRET_FILE_OUTPUT=/etc/hosts'},
        {role: 'assistant', status: 'failed', errorMessage: 'HTTP 500', content: '⚠️ 请求失败：HTTP 500'},
        {role: 'user', content: '那 2+2 呢？'},
    ];
    const cleanBudgeted = buildBudgetedContextMessages(dirtyHistory, {
        maxMessages: 10,
        systemPrompt: '你是助手',
        contextWindowTokens: 8192,
        reserveOutputTokens: 1024,
    });
    assert.deepEqual(cleanBudgeted, [
        {role: 'user', content: '帮我算 1+1'},
        {role: 'assistant', content: '等于 2。'},
        {role: 'user', content: '那 2+2 呢？'},
    ]);

    // 4. Oversized current prompt is explicitly flagged instead of silently lost
    const rejected = preparePromptWithinBudget('超长问题'.repeat(5000), {
        maxPromptChars: 4000,
        allowTruncate: false,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.rejected, true);
    assert.match(rejected.warning, /超过单次上限/);
});
