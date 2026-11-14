import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    buildArgs,
    buildCodexArgs,
    buildZCodeArgs,
    buildZCodePersonalConfigOverride,
    detailedMessages,
    escapePango,
    inlineMarkdownToPango,
    messageText,
    messageThinking,
    normalizeEvent,
    normalizeOpenAIEndpoint,
    parseCodexProviderCatalog,
    parseMarkdownBlocks,
    parseOpenAISSELine,
    parseZCodeProviderCatalog,
    stripAnsi,
    visibleMessages,
} from '../protocol.js';

const config = {executable: '/usr/local/bin/pi', mode: 'chat', provider: 'openai', model: 'my-model'};

test('default mode disables all tools and discovered resources', () => {
    const args = buildArgs(config, '/tmp/sessions', 'abc-123');
    for (const flag of ['--no-tools', '--no-extensions', '--no-mcp', '--no-context-files']) {
        assert.ok(args.includes(flag));
    }
    assert.equal(args[0], config.executable);
    assert.equal(args[args.indexOf('--session-id') + 1], 'abc-123');
    assert.equal(args[args.indexOf('--model') + 1], 'my-model');
});

test('read only and full are explicit tool allowlists', () => {
    assert.ok(buildArgs({...config, mode: 'readonly'}, '/tmp/s', 'a').includes('read,grep,find,ls'));
    assert.ok(buildArgs({...config, mode: 'full'}, '/tmp/s', 'b').includes('read,bash,edit,write'));
    assert.ok(buildArgs({...config, mode: 'invalid'}, '/tmp/s', 'c').includes('--no-tools'));
});

test('messages extract text without exposing thinking or tool results', () => {
    assert.equal(messageText({content: [{type: 'thinking', thinking: 'hidden'}, {type: 'text', text: '你好'}]}), '你好');
    assert.deepEqual(
        visibleMessages([
            {role: 'user', content: '问题'},
            {role: 'assistant', content: [{type: 'text', text: '回答'}]},
            {role: 'toolResult', content: 'secret'},
        ]),
        [{role: 'user', text: '问题'}, {role: 'assistant', text: '回答'}]
    );
});

test('messageThinking and detailedMessages extract assistant reasoning separately', () => {
    const msg = {
        role: 'assistant',
        content: [
            {type: 'thinking', thinking: '先分析步骤'},
            {type: 'text', text: '最终结论'},
        ],
    };
    assert.equal(messageThinking(msg), '先分析步骤');
    assert.deepEqual(detailedMessages([msg]), [{
        role: 'assistant',
        text: '最终结论',
        thinking: '先分析步骤',
    }]);
});

test('ZCode and Codex argument builders map permission modes and session resume safely', () => {
    const zChat = buildZCodeArgs({commandPrefix: ['node', '/opt/ZCode/resources/glm/zcode.cjs'], mode: 'chat'}, '你好', 'sess_1');
    assert.equal(zChat[0], 'node');
    assert.ok(zChat.includes('stream-json'));
    assert.ok(zChat.includes('--resume'));
    assert.equal(zChat[zChat.indexOf('--resume') + 1], 'sess_1');
    assert.equal(zChat[zChat.indexOf('--mode') + 1], 'plan');

    const zRead = buildZCodeArgs({executable: 'zcode', mode: 'readonly'}, '查股价');
    assert.equal(zRead[zRead.indexOf('--mode') + 1], 'build');

    const zFull = buildZCodeArgs({executable: 'zcode', mode: 'full'}, '执行');
    assert.equal(zFull[zFull.indexOf('--mode') + 1], 'yolo');
    assert.ok(!zFull.includes('--resume'));

    const cRead = buildCodexArgs({executable: 'codex', mode: 'readonly', model: 'gpt-5'}, '/tmp/w', '检查', '');
    assert.equal(cRead[0], 'codex');
    assert.equal(cRead[1], 'exec');
    assert.ok(cRead.includes('--json'));
    assert.ok(cRead.includes('sandbox_mode="read-only"'));

    const cResume = buildCodexArgs({executable: 'codex', mode: 'full'}, '/tmp/w', '继续', 'thread_9');
    assert.deepEqual(cResume.slice(0, 3), ['codex', 'exec', 'resume']);
    assert.ok(cResume.includes('thread_9'));
});

test('normalizeEvent unifies ZCode and Codex streaming events into Pi event format', () => {
    assert.deepEqual(
        normalizeEvent('zcode', {type: 'model.streaming', payload: {kind: 'text_delta', delta: 'Hello'}}),
        {type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'Hello'}}
    );
    assert.deepEqual(
        normalizeEvent('zcode', {type: 'model.streaming', payload: {kind: 'reasoning_delta', delta: 'Thinking...'}}),
        {type: 'message_update', assistantMessageEvent: {type: 'thinking_delta', delta: 'Thinking...'}}
    );
    assert.deepEqual(
        normalizeEvent('zcode', {type: 'tool.updated', payload: {kind: 'started', toolName: 'Read'}}),
        {type: 'tool_execution_start', toolName: 'Read'}
    );
    assert.deepEqual(
        normalizeEvent('zcode', {
            type: 'quickchat.permission_requested',
            payload: {
                requestId: 'qc_perm_1',
                toolCallId: 'call_1',
                toolName: 'WebFetch',
                riskLevel: 'medium',
                reason: 'Fetching URL',
                summary: 'url: https://example.com',
            },
        }),
        {
            type: 'permission_request',
            requestId: 'qc_perm_1',
            toolCallId: 'call_1',
            toolName: 'WebFetch',
            riskLevel: 'medium',
            reason: 'Fetching URL',
            summary: 'url: https://example.com',
        }
    );
    assert.deepEqual(
        normalizeEvent('codex', {type: 'thread.started', thread_id: 'th_123'}),
        {type: 'session_bound', sessionId: 'th_123'}
    );
    assert.deepEqual(
        normalizeEvent('codex', {type: 'item.completed', item: {type: 'agent_message', text: 'Done'}}),
        {type: 'message_end', message: {role: 'assistant', content: 'Done'}}
    );
});

test('Markdown to Pango parser safely escapes XML and splits fenced code blocks', () => {
    assert.equal(escapePango('a < b & c > "d"'), 'a &lt; b &amp; c &gt; &quot;d&quot;');
    assert.equal(
        inlineMarkdownToPango('Use `x < y & z` and **bold <tag>** and **`Ctrl + Alt + T`**'),
        'Use <tt>x &lt; y &amp; z</tt> and <b>bold &lt;tag&gt;</b> and <b><tt>Ctrl + Alt + T</tt></b>'
    );

    const blocks = parseMarkdownBlocks('# 标题\n- 第一项 `code`\n```bash\necho "hello <world>"\n```\n尾段 **加粗**');
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].type, 'text');
    assert.ok(blocks[0].pango.includes('<b>标题</b>'));
    assert.ok(blocks[0].pango.includes('• 第一项 <tt>code</tt>'));
    assert.deepEqual(blocks[1], {
        type: 'code',
        lang: 'bash',
        code: 'echo "hello <world>"',
        closed: true,
    });
    assert.equal(blocks[2].type, 'text');
    assert.ok(blocks[2].pango.includes('<b>加粗</b>'));

    // Unclosed code block during streaming
    const streamingBlocks = parseMarkdownBlocks('说明：\n```python\nprint(1)');
    assert.equal(streamingBlocks.length, 2);
    assert.equal(streamingBlocks[1].type, 'code');
    assert.equal(streamingBlocks[1].closed, false);
    assert.equal(streamingBlocks[1].lang, 'python');

    assert.equal(stripAnsi('\x1b[31mError\x1b[0m'), 'Error');
});

test('OpenAI endpoint normalization and SSE parser handle standard and custom URLs', () => {
    assert.equal(normalizeOpenAIEndpoint('http://localhost:8317', '/chat/completions'), 'http://localhost:8317/v1/chat/completions');
    assert.equal(normalizeOpenAIEndpoint('http://localhost:8317/v1/', '/models'), 'http://localhost:8317/v1/models');
    assert.equal(normalizeOpenAIEndpoint('https://api.openai.com/v1/chat/completions', '/models'), 'https://api.openai.com/v1/models');

    assert.deepEqual(parseOpenAISSELine('data: [DONE]'), {done: true});
    assert.deepEqual(
        parseOpenAISSELine('data: {"model":"gpt-4o","choices":[{"delta":{"content":"你好","reasoning_content":"思考"}}]}'),
        {done: false, model: 'gpt-4o', textDelta: '你好', thinkingDelta: '思考'}
    );
});

test('ZCode and Codex provider/model catalog parsers and smart override recovery', () => {
    const sampleZCodePersonal = {
        schemaVersion: 1,
        config: {
            providerOrder: ['openai', 'openai-2'],
            providerConfigRules: {
                providerRules: [
                    {
                        providerId: 'openai',
                        providerName: 'OpenAI-codex',
                        config: {
                            api: {baseUrl: 'http://localhost:8317/v1'},
                            modelOrder: ['gpt-6-astra', 'gpt-6-luna'],
                            personalModelIds: ['gpt-6-astra', 'gpt-6-luna'],
                        },
                    },
                    {
                        providerId: 'openai-2',
                        providerName: 'OpenAI-R7000',
                        config: {
                            api: {baseUrl: 'http://100.99.76.31:8317/v1'},
                            modelOrder: ['gpt-5.6-sol'],
                            personalModelIds: ['gpt-5.6-sol'],
                        },
                    },
                ],
            },
        },
    };

    const cat = parseZCodeProviderCatalog(sampleZCodePersonal);
    assert.equal(cat.providers.length, 2);
    assert.equal(cat.providers[0].id, 'openai');
    assert.equal(cat.providers[0].name, 'OpenAI-codex');
    assert.deepEqual(cat.providers[0].models, ['gpt-6-astra', 'gpt-6-luna']);

    // Smart recovery when user typed model name into provider field
    const swapped = buildZCodePersonalConfigOverride(sampleZCodePersonal, {provider: 'gpt-6-luna', model: ''});
    assert.equal(swapped.providerId, 'openai');
    assert.equal(swapped.modelId, 'gpt-6-luna');
    assert.deepEqual(swapped.configObj.config.defaultModelSelection, {
        providerId: 'openai',
        modelId: 'gpt-6-luna',
        options: {reasoningLevel: 'max'},
    });

    // Custom manual model injection
    const customMod = buildZCodePersonalConfigOverride(sampleZCodePersonal, {provider: 'OpenAI-R7000', model: 'my-custom-gpt'});
    assert.equal(customMod.providerId, 'openai-2');
    assert.equal(customMod.modelId, 'my-custom-gpt');
    const r2 = customMod.configObj.config.providerConfigRules.providerRules[1];
    assert.ok(r2.config.personalModelIds.includes('my-custom-gpt'));

    // Codex catalog parsing
    const codexCat = parseCodexProviderCatalog(
        'model = "gpt-6-astra"\n[model_providers.custom]\nname = "custom"\nbase_url = "http://127.0.0.1:15721/v1"\n',
        {models: [{slug: 'gpt-6-luna'}, {slug: 'gpt-6-astra'}]}
    );
    assert.equal(codexCat.defaultModel, 'gpt-6-astra');
    assert.equal(codexCat.providers.length, 2);
    assert.equal(codexCat.providers[1].id, 'custom');
    assert.equal(codexCat.providers[1].baseUrl, 'http://127.0.0.1:15721/v1');
    assert.deepEqual(codexCat.providers[0].models, ['gpt-6-astra', 'gpt-6-luna']);
});
