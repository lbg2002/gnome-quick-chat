import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {registerGiMocks} from './helpers/giMockLoader.js';

registerGiMocks();

const {TurnController} = await import('../core/turnController.js');
const {
    OpenAIAdapter,
} = await import('../backends/openaiAdapter.js');
const {
    SessionStore,
} = await import('../core/sessionStore.js');
const {
    EndpointModelMetadataCache,
    makeEndpointModelMetadataKey,
} = await import('../core/modelCatalogCache.js');
const {
    evaluateRedirectPolicy,
    resolveRedirectTargetUrl,
} = await import('../core/secretPolicy.js');

function waitForSettledEvent(events, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => {
            clearInterval(timer);
            reject(new Error(`Timed out waiting for agent_settled (${timeoutMs}ms)`));
        }, timeoutMs);
        const timer = setInterval(() => {
            const settled = events.find(e => e.type === 'agent_settled');
            if (settled) {
                clearInterval(timer);
                clearTimeout(deadline);
                resolve(settled);
            }
        }, 15);
    });
}

test('R9.1: Post-discovery budget re-check rejects oversized prompt before SessionStore mutation, trims multi-turn history while preserving non-duplicated current question, and marks finish_reason=length as partial', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-r9-1-'));
    const chatPayloads = [];
    let nextFinishReason = 'stop';

    const server = http.createServer((req, res) => {
        if (req.url === '/v1/models' && req.method === 'GET') {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({
                data: [
                    {
                        id: 'small-ctx-model',
                        context_length: 140, // Narrow context window discovered from /models
                        supports_reasoning: false,
                    },
                ],
            }));
            return;
        }
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString('utf8');
            });
            req.on('end', () => {
                const parsed = JSON.parse(body);
                chatPayloads.push(parsed);
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                });
                const chunk1 = {
                    id: 'chatcmpl-r9-1',
                    model: parsed.model || 'small-ctx-model',
                    choices: [{
                        index: 0,
                        delta: {content: '收到：' + (parsed.messages?.at(-1)?.content || '')},
                        finish_reason: null,
                    }],
                };
                const chunk2 = {
                    id: 'chatcmpl-r9-1',
                    model: parsed.model || 'small-ctx-model',
                    choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: nextFinishReason,
                    }],
                    usage: {
                        prompt_tokens: 28,
                        completion_tokens: 14,
                        total_tokens: 42,
                    },
                };
                res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
                res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/v1`;

    try {
        const store = new SessionStore('sess_r9_1', {sessionsRootDir: tmpDir});
        await store.load();

        const events = [];
        const turns = new TurnController(ev => events.push(ev));
        const metaCache = new EndpointModelMetadataCache();
        const adapter = new OpenAIAdapter({
            turns,
            store,
            emitEvent: ev => events.push(ev),
            metadataCache: metaCache,
        });

        // Initial config starts with a generous default contextWindowTokens (32000),
        // and empty modelId so _discoverModelIfNeeded() fetches /v1/models during sendMessage()
        const cfg = {
            openaiBaseUrl: baseUrl,
            openaiApiKey: 'sk-r9-test-123456',
            openaiModel: '',
            contextWindowTokens: 32000,
            reserveOutputTokens: 40,
            maxPromptBytes: 64 * 1024,
        };
        adapter.initialize({
            baseUrl,
            endpoint: `${baseUrl}/chat/completions`,
            modelsUrl: `${baseUrl}/models`,
            apiKey: 'sk-r9-test-123456',
            modelId: '',
            resolvedModel: 'gpt-4o-mini',
        }, cfg);

        // 1. Send an oversized prompt (> 140 context tokens discovered from /models).
        // Even though initial cfg.contextWindowTokens was 32000, post-discovery re-check MUST reject it
        // BEFORE appending to SessionStore or sending HTTP POST!
        const hugeQuestion = '这是一段超长的问题内容，用于测试模型自动发现窄上下文窗口后的预算二次校验。'.repeat(12);
        const res1 = await adapter.sendMessage({text: hugeQuestion});
        assert.equal(res1.disposition, 'rejected_budget', 'Oversized prompt after /models discovery must be rejected');
        assert.equal(chatPayloads.length, 0, 'Must NOT send HTTP POST when post-discovery budget check fails');
        assert.equal(store.messages.length, 0, 'Must NOT append rejected oversized user message to SessionStore');
        const settled1 = events.find(e => e.type === 'agent_settled');
        assert.ok(settled1, 'Must emit agent_settled on budget rejection');
        assert.equal(settled1.status, 'failed');
        assert.match(settled1.errorMessage, /超过模型输入窗口上限|超出上下文窗口上限/);

        // 2. Seed several older conversation turns in SessionStore so total history > 140 tokens,
        // then send a short current question. Verify older turns are trimmed while current question
        // is preserved once (not duplicated) in the actual HTTP POST payload.
        for (let i = 1; i <= 4; i++) {
            await store.appendMessage({
                id: `u_hist_${i}`,
                turnId: `t_hist_${i}`,
                role: 'user',
                content: `历史问题第 ${i} 轮：请解释 Linux 内核调度器与内存管理的交互细节 ${'补充背景'.repeat(6)}`,
                status: 'completed',
            }, 'openai');
            await store.appendMessage({
                id: `a_hist_${i}`,
                turnId: `t_hist_${i}`,
                role: 'assistant',
                content: `历史回答第 ${i} 轮：内核通过 CFS/EEVDF 与页回收水位协同工作 ${'详细说明'.repeat(6)}`,
                status: 'completed',
            }, 'openai');
        }

        events.length = 0;
        nextFinishReason = 'length'; // Also test finish_reason=length -> explicit partial
        const currentQuestion = '当前最新问题：请用一句话总结重点。';
        const res2 = await adapter.sendMessage({text: currentQuestion});
        assert.equal(res2.disposition, 'streaming');

        const settled2 = await waitForSettledEvent(events);
        assert.equal(settled2.status, 'completed');
        assert.equal(settled2.finishReason, 'length', 'finish_reason=length must be propagated to agent_settled');
        assert.equal(settled2.partial, true, 'finish_reason=length must set partial: true on agent_settled');
        assert.equal(settled2.contextWindowTokens, 140, 'Discovered contextWindowTokens must be reported');
        assert.equal(settled2.usage?.total_tokens, 42);

        const msgEnd2 = events.find(e => e.type === 'message_end');
        assert.ok(msgEnd2);
        assert.equal(msgEnd2.partial, true, 'message_end must mark partial: true when finish_reason=length');
        assert.equal(msgEnd2.finishReason, 'length');

        // Verify persisted assistant message in SessionStore is marked partial: true
        const lastPersisted = store.messages.at(-1);
        assert.equal(lastPersisted.role, 'assistant');
        assert.equal(lastPersisted.partial, true, 'Persisted assistant message must have partial: true on finish_reason=length');
        assert.equal(lastPersisted.finishReason, 'length');

        // Verify actual HTTP POST messages sent to server:
        // - older history turns were trimmed to fit the 140-token context window
        // - current question is at the end and appears EXACTLY ONCE
        assert.equal(chatPayloads.length, 1);
        const sentMessages = chatPayloads[0].messages;
        const matchingCurrent = sentMessages.filter(m => m.role === 'user' && m.content === currentQuestion);
        assert.equal(matchingCurrent.length, 1, 'Current user question must be present and NOT duplicated');
        assert.equal(sentMessages.at(-1).content, currentQuestion, 'Current user question must be the final message');
        assert.ok(
            sentMessages.length < 9,
            `Older history turns must be trimmed to fit 140-token window (sent ${sentMessages.length} messages total)`
        );

        adapter.dispose();
    } finally {
        server.close();
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});

test('R9.2: /models discovery is bound to endpoint & generation, cancels on endpoint switch, isolates metadata per endpoint+model, and never overwrites manual user model', async () => {
    let slowEndpointRequests = 0;
    let fastEndpointRequests = 0;

    // Endpoint 1: slow response (250ms), exposes model "shared-model" with 8192 context and reasoning=false
    const server1 = http.createServer((req, res) => {
        if (req.url === '/v1/models') {
            slowEndpointRequests += 1;
            const timer = setTimeout(() => {
                if (res.destroyed || res.writableEnded) return;
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({
                    data: [
                        {id: 'auto-model-from-endpoint-1', context_length: 4096},
                        {id: 'shared-model', context_length: 8192, supports_reasoning: false},
                    ],
                }));
            }, 250);
            req.on('close', () => clearTimeout(timer));
            return;
        }
        res.writeHead(404);
        res.end();
    });

    // Endpoint 2: fast response (20ms), exposes "shared-model" with 131072 context and reasoning=true
    const server2 = http.createServer((req, res) => {
        if (req.url === '/v1/models') {
            fastEndpointRequests += 1;
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({
                data: [
                    {id: 'auto-model-from-endpoint-2', context_length: 65536},
                    {id: 'shared-model', context_length: 131072, supports_reasoning: true},
                ],
            }));
            return;
        }
        res.writeHead(404);
        res.end();
    });

    await new Promise(resolve => server1.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => server2.listen(0, '127.0.0.1', resolve));
    const baseUrl1 = `http://127.0.0.1:${server1.address().port}/v1`;
    const baseUrl2 = `http://127.0.0.1:${server2.address().port}/v1`;

    try {
        const events = [];
        const turns = new TurnController(ev => events.push(ev));
        const metadataCache = new EndpointModelMetadataCache();
        const adapter = new OpenAIAdapter({
            turns,
            emitEvent: ev => events.push(ev),
            metadataCache,
            clientGeneration: 7,
        });

        // User explicitly configured "manual-custom-model"
        adapter.initialize({
            baseUrl: baseUrl1,
            endpoint: `${baseUrl1}/chat/completions`,
            modelsUrl: `${baseUrl1}/models`,
            apiKey: 'sk-endpoint-1',
            modelId: 'manual-custom-model',
            resolvedModel: 'manual-custom-model',
            hasExplicitUserModel: true,
        }, {
            openaiBaseUrl: baseUrl1,
            openaiApiKey: 'sk-endpoint-1',
            openaiModel: 'manual-custom-model',
        });

        // Start /models request against Endpoint 1 (slow)
        const pendingModels1 = adapter.getModels();

        // While Endpoint 1 /models is still in-flight, switch adapter to Endpoint 2!
        await new Promise(resolve => setTimeout(resolve, 30));
        adapter.updateEndpoint({
            baseUrl: baseUrl2,
            endpoint: `${baseUrl2}/chat/completions`,
            modelsUrl: `${baseUrl2}/models`,
            apiKey: 'sk-endpoint-2',
            modelId: 'manual-custom-model',
            hasExplicitUserModel: true,
        }, {
            openaiBaseUrl: baseUrl2,
            openaiApiKey: 'sk-endpoint-2',
            openaiModel: 'manual-custom-model',
        });

        const res1 = await pendingModels1;
        assert.equal(res1.stale, true, 'In-flight /models from old endpoint must be cancelled/marked stale on endpoint switch');

        // Now fetch /models from Endpoint 2
        const res2 = await adapter.getModels();
        assert.equal(res2.stale, undefined);
        assert.deepEqual(res2.models, ['auto-model-from-endpoint-2', 'shared-model']);
        assert.equal(
            res2.selectedModel,
            'manual-custom-model',
            'Manually configured user model must NEVER be overwritten by discovered models[0]'
        );
        assert.equal(
            adapter._runtime.modelId,
            'manual-custom-model',
            'Adapter runtime.modelId must retain manual user model after /models discovery'
        );

        // Verify models_discovered event only emitted for Endpoint 2, with matching clientGeneration & endpointKey
        const discoveredEvents = events.filter(e => e.type === 'models_discovered');
        assert.equal(discoveredEvents.length, 1, 'Stale endpoint 1 must not emit models_discovered');
        assert.equal(discoveredEvents[0].clientGeneration, 7);
        assert.equal(discoveredEvents[0].selectedModel, 'manual-custom-model');

        // Also populate Endpoint 1 metadata in cache to verify endpoint+model metadata isolation
        metadataCache.set(baseUrl1, 'shared-model', {
            contextWindowTokens: 8192,
            supportsReasoningEffort: false,
        });

        const metaEp1 = adapter.getModelMetadata('shared-model', baseUrl1);
        const metaEp2 = adapter.getModelMetadata('shared-model', baseUrl2);
        assert.equal(metaEp1.contextWindowTokens, 8192);
        assert.equal(metaEp1.supportsReasoningEffort, false);
        assert.equal(metaEp2.contextWindowTokens, 131072);
        assert.equal(metaEp2.supportsReasoningEffort, true);
        assert.notEqual(
            makeEndpointModelMetadataKey(baseUrl1, 'shared-model'),
            makeEndpointModelMetadataKey(baseUrl2, 'shared-model')
        );

        assert.equal(slowEndpointRequests, 1);
        assert.equal(fastEndpointRequests, 1);
        adapter.dispose();
    } finally {
        server1.close();
        server2.close();
    }
});

test('R9.3: Real two-origin localhost HTTP servers verify cross-origin 307/308 POST redirect blocking (no body/auth leak) and GET /models credential stripping', async () => {
    const originBReceived = [];

    // Origin B (foreign origin that Origin A redirects to)
    const serverB = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString('utf8');
        });
        req.on('end', () => {
            originBReceived.push({
                method: req.method,
                url: req.url,
                headers: {...req.headers},
                body,
            });
            if (req.url === '/v1/models') {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({
                    data: [{id: 'origin-b-public-model', context_length: 16384}],
                }));
                return;
            }
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ok: true}));
        });
    });

    await new Promise(resolve => serverB.listen(0, '127.0.0.1', resolve));
    const portB = serverB.address().port;
    const originBBase = `http://127.0.0.1:${portB}/v1`;

    let redirectStatusForChat = 307;
    // Origin A (configured API endpoint that issues 307/308 redirects to Origin B)
    const serverA = http.createServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
            req.resume();
            res.writeHead(redirectStatusForChat, {
                Location: `${originBBase}/chat/completions`,
            });
            res.end();
            return;
        }
        if (req.url === '/v1/models') {
            res.writeHead(307, {
                Location: `${originBBase}/models`,
            });
            res.end();
            return;
        }
        res.writeHead(404);
        res.end();
    });

    await new Promise(resolve => serverA.listen(0, '127.0.0.1', resolve));
    const portA = serverA.address().port;
    const originABase = `http://127.0.0.1:${portA}/v1`;

    try {
        const events = [];
        const turns = new TurnController(ev => events.push(ev));
        const adapter = new OpenAIAdapter({
            turns,
            emitEvent: ev => events.push(ev),
        });

        const secretKey = 'sk-super-secret-origin-a-token';
        const cfg = {
            openaiBaseUrl: originABase,
            openaiApiKey: secretKey,
            openaiModel: 'gpt-4o-mini',
        };
        adapter.initialize({
            baseUrl: originABase,
            endpoint: `${originABase}/chat/completions`,
            modelsUrl: `${originABase}/models`,
            apiKey: secretKey,
            modelId: 'gpt-4o-mini',
            resolvedModel: 'gpt-4o-mini',
            hasExplicitUserModel: true,
        }, cfg);

        // 1. Test POST /chat/completions with 307 Temporary Redirect to Origin B:
        // Must be blocked BEFORE Origin B receives any request, attachment body, or Authorization header!
        redirectStatusForChat = 307;
        const sensitivePrompt = '请分析附件内容：\n<<<QUICKCHAT_ATTACHMENT_BEGIN>>>\nPRIVATE_SSH_KEY_MATERIAL\n<<<QUICKCHAT_ATTACHMENT_END>>>';
        const sendRes307 = await adapter.sendMessage({text: sensitivePrompt});
        assert.equal(sendRes307.disposition, 'streaming');

        const settled307 = await waitForSettledEvent(events);
        assert.equal(settled307.status, 'failed', 'Cross-origin 307 POST redirect must fail the turn');
        assert.match(settled307.errorMessage, /拒绝跨源重定向转发聊天请求/, 'Must explain that cross-origin POST redirect was blocked');
        assert.equal(
            originBReceived.length,
            0,
            'Origin B must NEVER receive the redirected POST request or attachment body on 307'
        );

        // 2. Test POST /chat/completions with 308 Permanent Redirect to Origin B:
        events.length = 0;
        redirectStatusForChat = 308;
        await adapter.sendMessage({text: sensitivePrompt});
        const settled308 = await waitForSettledEvent(events);
        assert.equal(settled308.status, 'failed', 'Cross-origin 308 POST redirect must also fail the turn');
        assert.match(settled308.errorMessage, /拒绝跨源重定向转发聊天请求/);
        assert.equal(
            originBReceived.length,
            0,
            'Origin B must NEVER receive the redirected POST request or attachment body on 308'
        );

        // 3. Test GET /models redirected (307) from Origin A to Origin B:
        // Allowed for GET, but Authorization / Cookie / X-Api-Key headers MUST be stripped before Origin B!
        const modelsRes = await adapter.getModels();
        assert.deepEqual(modelsRes.models, ['origin-b-public-model']);
        assert.equal(originBReceived.length, 1, 'GET /models redirect to Origin B may proceed without credentials');
        assert.equal(originBReceived[0].method, 'GET');
        assert.equal(originBReceived[0].url, '/v1/models');
        assert.equal(
            originBReceived[0].headers.authorization,
            undefined,
            'Authorization header MUST be stripped before following cross-origin GET redirect to Origin B'
        );

        // 4. Verify HTTPS -> HTTP protocol downgrade redirect is blocked for both GET and POST
        const downgradeGet = evaluateRedirectPolicy(
            'https://api.example.com/v1/models',
            'http://api.example.com/v1/models',
            {method: 'GET', status: 302}
        );
        assert.equal(downgradeGet.allowed, false);
        assert.equal(downgradeGet.isHttpsDowngrade, true);
        assert.match(downgradeGet.message, /HTTPS 降级重定向/);

        const relativeTarget = resolveRedirectTargetUrl(
            'https://api.example.com/v1/chat/completions',
            '/v2/chat/completions'
        );
        assert.equal(relativeTarget, 'https://api.example.com/v2/chat/completions');
        const sameOriginPost = evaluateRedirectPolicy(
            'https://api.example.com/v1/chat/completions',
            relativeTarget,
            {method: 'POST', status: 307}
        );
        assert.equal(sameOriginPost.allowed, true);
        assert.equal(sameOriginPost.stripAuthorization, false);

        adapter.dispose();
    } finally {
        serverA.close();
        serverB.close();
    }
});

test('R9.4: Capability mismatch diagnostics never auto-retry POST, usage & reasoning_effort are propagated, and failed messages are never injected into subsequent turns', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-r9-4-'));
    const receivedChatRequests = [];
    let nextServerMode = 'reject_reasoning_effort';

    const server = http.createServer((req, res) => {
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString('utf8');
            });
            req.on('end', () => {
                const parsed = JSON.parse(body);
                receivedChatRequests.push(parsed);

                if (nextServerMode === 'reject_reasoning_effort') {
                    res.writeHead(400, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({
                        error: {
                            message: 'Unrecognized request argument supplied: reasoning_effort',
                            type: 'invalid_request_error',
                            code: 'unknown_parameter',
                        },
                    }));
                    return;
                }

                res.writeHead(200, {'Content-Type': 'text/event-stream'});
                const deltaChunk = {
                    id: 'chatcmpl-r9-4',
                    model: 'o3-mini',
                    choices: [{
                        index: 0,
                        delta: {
                            reasoning_content: '先推导条件',
                            content: '这是第二轮成功回答。',
                        },
                        finish_reason: 'stop',
                    }],
                    usage: {
                        prompt_tokens: 20,
                        completion_tokens: 15,
                        total_tokens: 35,
                        completion_tokens_details: {
                            reasoning_tokens: 9,
                        },
                    },
                };
                res.write(`data: ${JSON.stringify(deltaChunk)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/v1`;

    try {
        const store = new SessionStore('sess_r9_4', {sessionsRootDir: tmpDir});
        await store.load();

        const events = [];
        const turns = new TurnController(ev => events.push(ev));
        const adapter = new OpenAIAdapter({
            turns,
            store,
            emitEvent: ev => events.push(ev),
        });

        const cfg = {
            openaiBaseUrl: baseUrl,
            openaiApiKey: 'sk-r9-4-key',
            openaiModel: 'o3-mini',
            thinkingLevel: 'high',
            contextWindowTokens: 32000,
            reserveOutputTokens: 1024,
        };
        adapter.initialize({
            baseUrl,
            endpoint: `${baseUrl}/chat/completions`,
            modelsUrl: `${baseUrl}/models`,
            apiKey: 'sk-r9-4-key',
            modelId: 'o3-mini',
            resolvedModel: 'o3-mini',
            hasExplicitUserModel: true,
        }, cfg);

        // Turn 1: Server returns HTTP 400 rejecting reasoning_effort
        nextServerMode = 'reject_reasoning_effort';
        await adapter.sendMessage({text: '第一轮问题：测试兼容接口不支持 reasoning_effort'});
        const settled1 = await waitForSettledEvent(events);

        assert.equal(settled1.status, 'failed');
        assert.equal(
            receivedChatRequests.length,
            1,
            'Must NEVER auto-retry side-effecting POST request on capability error'
        );
        assert.equal(receivedChatRequests[0].reasoning_effort, 'high');
        assert.match(
            settled1.errorMessage,
            /诊断：当前兼容接口或模型不支持 reasoning_effort/,
            'Must surface explicit Chinese diagnostic for reasoning_effort incompatibility'
        );

        // Also simulate a persisted failed assistant message in SessionStore to ensure
        // extractCleanMessageText / buildBudgetedContextMessages never injects failed messages into Turn 2
        await store.appendMessage({
            id: 'failed_assistant_msg',
            turnId: settled1.turnId,
            role: 'assistant',
            content: [{type: 'text', text: 'HTTP 400: Unrecognized request argument supplied: reasoning_effort'}],
            status: 'failed',
            errorMessage: settled1.errorMessage,
        }, 'openai');

        // Turn 2: Server succeeds and returns reasoning + usage with reasoning_tokens
        events.length = 0;
        nextServerMode = 'success';
        await adapter.sendMessage({text: '第二轮问题：验证失败消息不会注入后续上下文'});
        const settled2 = await waitForSettledEvent(events);

        assert.equal(settled2.status, 'completed');
        assert.equal(settled2.reasoningEffort, 'high');
        assert.equal(settled2.usage?.promptTokens, 20);
        assert.equal(settled2.usage?.completionTokens, 15);
        assert.equal(settled2.usage?.totalTokens, 35);
        assert.equal(settled2.usage?.reasoningTokens, 9);

        assert.equal(receivedChatRequests.length, 2);
        const turn2SentMessages = receivedChatRequests[1].messages;
        for (const msg of turn2SentMessages) {
            assert.doesNotMatch(
                String(msg.content || ''),
                /Unrecognized request argument|诊断：/,
                'Failed assistant message or HTTP error text must NEVER be injected into subsequent turn messages'
            );
        }

        adapter.dispose();
    } finally {
        server.close();
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});
