import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {
    buildArgs,
    buildBudgetedContextMessages,
    buildCodexArgs,
    buildCrossBackendPromptWithContext,
    buildModelSignature,
    buildZCodeArgs,
    buildZCodePersonalConfigOverride,
    computePermissionScope,
    detailedMessages,
    escapePango,
    getBackendCapabilities,
    inlineMarkdownToPango,
    mapReasoningEffort,
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

const require = createRequire(import.meta.url);
const zcodeBridge = require('../zcodeBridge.cjs');

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

test('ZCode and Codex argument builders map permission modes, reasoning effort, and session resume safely', () => {
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

    const cRead = buildCodexArgs(
        {executable: 'codex', mode: 'readonly', model: 'gpt-5', reasoningEffort: 'fast'},
        '/tmp/w',
        '检查',
        ''
    );
    assert.equal(cRead[0], 'codex');
    assert.equal(cRead[1], 'exec');
    assert.ok(cRead.includes('--json'));
    assert.ok(cRead.includes('sandbox_mode="read-only"'));
    assert.ok(cRead.includes('model_reasoning_effort="low"'));

    const cResume = buildCodexArgs({executable: 'codex', mode: 'full'}, '/tmp/w', '继续', 'thread_9');
    assert.deepEqual(cResume.slice(0, 3), ['codex', 'exec', 'resume']);
    assert.ok(cResume.includes('thread_9'));
});

test('normalizeEvent unifies ZCode and Codex events without duplicate settlement and preserves parallel toolCallIds', () => {
    assert.deepEqual(
        normalizeEvent('zcode', {type: 'quickchat.bridge_ready', protocolVersion: 1, patched: true}),
        {type: 'bridge_ready', protocolVersion: 1, patched: true}
    );
    assert.deepEqual(
        normalizeEvent('zcode', {type: 'model.streaming', payload: {kind: 'text_delta', delta: 'Hello'}}),
        {type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'Hello'}}
    );
    assert.deepEqual(
        normalizeEvent('zcode', {type: 'model.streaming', payload: {kind: 'reasoning_delta', delta: 'Thinking...'}}),
        {type: 'message_update', assistantMessageEvent: {type: 'thinking_delta', delta: 'Thinking...'}}
    );

    // Parallel same-name tools in ZCode preserve distinct toolCallId
    assert.deepEqual(
        normalizeEvent('zcode', {type: 'tool.updated', payload: {kind: 'started', toolCallId: 'call_a', toolName: 'Bash', input: {command: 'ls -la'}}}),
        {type: 'tool_execution_start', toolCallId: 'call_a', toolName: 'Bash', summary: 'ls -la'}
    );
    assert.deepEqual(
        normalizeEvent('zcode', {type: 'tool.updated', payload: {kind: 'started', toolCallId: 'call_b', toolName: 'Bash', input: {command: 'pwd'}}}),
        {type: 'tool_execution_start', toolCallId: 'call_b', toolName: 'Bash', summary: 'pwd'}
    );

    // Scoped permission normalization
    const permEvt = normalizeEvent('zcode', {
        type: 'quickchat.permission_requested',
        payload: {
            requestId: 'qc_perm_1',
            toolCallId: 'call_1',
            toolName: 'WebFetch',
            riskLevel: 'medium',
            reason: 'Fetching URL',
            summary: 'https://finance.yahoo.com/quote/601899.SS/',
        },
    });
    assert.equal(permEvt.type, 'permission_request');
    assert.equal(permEvt.scopeKey, 'WebFetch:host:finance.yahoo.com');
    assert.equal(permEvt.allowSessionRule, true);
    assert.equal(permEvt.sessionRuleLabel, '✓ 允许访问 finance.yahoo.com');

    // Codex turn.completed emits turn_completed (NOT agent_settled) to prevent double settlement
    assert.deepEqual(
        normalizeEvent('codex', {type: 'turn.completed'}),
        {type: 'turn_completed'}
    );

    // Codex parallel command_execution preserves item.id as toolCallId and checks exit_code
    assert.deepEqual(
        normalizeEvent('codex', {
            type: 'item.started',
            item: {id: 'item_cmd_1', type: 'command_execution', command: 'git status'},
        }),
        {type: 'tool_execution_start', toolCallId: 'item_cmd_1', toolName: 'Bash', summary: 'git status'}
    );
    assert.deepEqual(
        normalizeEvent('codex', {
            type: 'item.completed',
            item: {id: 'item_cmd_1', type: 'command_execution', command: 'false', exit_code: 2},
        }),
        {type: 'tool_execution_end', toolCallId: 'item_cmd_1', toolName: 'Bash', isError: true, detail: '退出码 2'}
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

test('Scoped permission rules isolate commands/hosts/files and block destructive session-wide rules', () => {
    const safeCmd = computePermissionScope('Bash', 'df -h');
    const otherCmd = computePermissionScope('Bash', 'uname -a');
    assert.equal(safeCmd.allowSessionRule, true);
    assert.equal(safeCmd.scopeKey, 'Bash:cmd:df -h');
    assert.notEqual(safeCmd.scopeKey, otherCmd.scopeKey);

    // Destructive commands disallow session-level auto-approval in both protocol.js and zcodeBridge.cjs
    for (const dangerous of ['rm -rf ~/Documents', 'sudo apt remove gjs', 'echo x && rm -rf /tmp/a', 'dd if=/dev/zero of=/dev/sda']) {
        const pScope = computePermissionScope('Bash', dangerous);
        const bScope = zcodeBridge.computeBridgeScope('Bash', dangerous);
        assert.equal(pScope.allowSessionRule, false, `protocol should block session rule for: ${dangerous}`);
        assert.equal(pScope.scopeKey, '');
        assert.equal(bScope.allowSessionRule, false, `bridge should block session rule for: ${dangerous}`);
        assert.equal(bScope.scopeKey, '');
    }

    // System config paths disallow session-level auto-approval
    assert.equal(computePermissionScope('Edit', '/etc/passwd').allowSessionRule, false);
    assert.equal(computePermissionScope('Edit', '/home/user/notes.md').scopeKey, 'Edit:file:/home/user/notes.md');

    // Bridge protocol version handshake
    assert.equal(zcodeBridge.PROTOCOL_VERSION, 1);
    assert.equal(
        zcodeBridge.computeBridgeScope('WebFetch', 'https://api.github.com/repos').scopeKey,
        'WebFetch:host:api.github.com'
    );
});

test('Markdown to Pango parser safely escapes XML and maintains frozen block stability during large streaming', () => {
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

    // Simulate 40 incremental chunks of a multi-codeblock long response and verify completed blocks stay identical
    const fullDoc = [
        '# 性能分析报告',
        '第一段说明文字，包含 **重点** 与 `inline_code()`。',
        '```js',
        'function add(a, b) {',
        '  return a + b;',
        '}',
        '```',
        '中间过渡段落：',
        '- 列表项 A',
        '- 列表项 B',
        '```bash',
        'gnome-extensions enable quick-chat@lbg2002.github.io',
        '```',
        '总结段落：流式渲染稳定完成。',
    ].join('\n');

    let prevCompleted = [];
    for (let cursor = 10; cursor <= fullDoc.length; cursor += 12) {
        const partial = fullDoc.slice(0, cursor);
        const curBlocks = parseMarkdownBlocks(partial);
        const completed = curBlocks.slice(0, Math.max(0, curBlocks.length - 1));
        for (let i = 0; i < Math.min(prevCompleted.length, completed.length); i++) {
            assert.deepEqual(completed[i], prevCompleted[i], `Frozen block ${i} should not mutate at cursor ${cursor}`);
        }
        prevCompleted = completed;
    }

    assert.equal(stripAnsi('\x1b[31mError\x1b[0m'), 'Error');
});

test('OpenAI endpoint normalization and SSE parser handle standard, custom, and malformed/error streams', () => {
    assert.equal(normalizeOpenAIEndpoint('http://localhost:8317', '/chat/completions'), 'http://localhost:8317/v1/chat/completions');
    assert.equal(normalizeOpenAIEndpoint('http://localhost:8317/v1/', '/models'), 'http://localhost:8317/v1/models');
    assert.equal(normalizeOpenAIEndpoint('https://api.openai.com/v1/chat/completions', '/models'), 'https://api.openai.com/v1/models');
    assert.equal(normalizeOpenAIEndpoint('https://generativelanguage.googleapis.com/v1beta/openai', '/models'), 'https://generativelanguage.googleapis.com/v1beta/openai/models');

    assert.deepEqual(parseOpenAISSELine('data: [DONE]'), {done: true});
    assert.deepEqual(
        parseOpenAISSELine('data: {"model":"gpt-4o","choices":[{"delta":{"content":"你好","reasoning_content":"思考"}}]}'),
        {done: false, model: 'gpt-4o', textDelta: '你好', thinkingDelta: '思考'}
    );
    assert.deepEqual(
        parseOpenAISSELine('data: {"error":{"message":"Rate limit exceeded"}}'),
        {error: 'Rate limit exceeded'}
    );
    assert.equal(parseOpenAISSELine('data: {truncated_json'), null);
});

test('ZCode config override is strictly immutable and respects configurable reasoningEffort without forcing max', () => {
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
    const originalSnapshot = JSON.stringify(sampleZCodePersonal);

    // Smart recovery when user typed model name into provider field — default effort does NOT inject reasoningLevel: 'max'
    const swapped = buildZCodePersonalConfigOverride(sampleZCodePersonal, {
        provider: 'gpt-6-luna',
        model: '',
        reasoningEffort: 'default',
    });
    assert.equal(swapped.providerId, 'openai');
    assert.equal(swapped.modelId, 'gpt-6-luna');
    assert.deepEqual(swapped.configObj.config.defaultModelSelection, {
        providerId: 'openai',
        modelId: 'gpt-6-luna',
    });

    // Explicit deep reasoning effort maps cleanly to 'high'
    const deepOverride = buildZCodePersonalConfigOverride(sampleZCodePersonal, {
        provider: 'openai',
        model: 'gpt-6-astra',
        reasoningEffort: 'deep',
    });
    assert.deepEqual(deepOverride.configObj.config.defaultModelSelection, {
        providerId: 'openai',
        modelId: 'gpt-6-astra',
        options: {reasoningLevel: 'high'},
    });
    assert.equal(mapReasoningEffort('fast'), 'low');
    assert.equal(mapReasoningEffort('standard'), 'medium');
    assert.equal(mapReasoningEffort('deep'), 'high');
    assert.equal(mapReasoningEffort('default'), '');

    // Original config object must NEVER be mutated in-place
    assert.equal(JSON.stringify(sampleZCodePersonal), originalSnapshot);

    // Codex catalog parsing
    const codexCat = parseCodexProviderCatalog(
        'model = "gpt-6-astra"\n[model_providers.custom]\nname = "custom"\nbase_url = "http://127.0.0.1:15721/v1"\n',
        {models: [{slug: 'gpt-6-luna'}, {slug: 'gpt-6-astra'}]}
    );
    assert.equal(codexCat.defaultModel, 'gpt-6-astra');
    assert.equal(codexCat.providers.length, 2);
    assert.equal(codexCat.providers[1].id, 'custom');
    assert.deepEqual(codexCat.providers[0].models, ['gpt-6-astra', 'gpt-6-luna']);
});

test('Model signature, budgeted context slicing, cross-backend handoff, and capability matrix', () => {
    const sigOpenAI1 = buildModelSignature('openai', {openaiBaseUrl: 'http://localhost:8317/v1/', openaiModel: 'gpt-4o'});
    const sigOpenAI2 = buildModelSignature('openai', {openaiBaseUrl: 'https://api.deepseek.com/v1', openaiModel: 'deepseek-chat'});
    assert.equal(sigOpenAI1, 'openai:http://localhost:8317/v1:gpt-4o');
    assert.notEqual(sigOpenAI1, sigOpenAI2);
    assert.equal(buildModelSignature('zcode', {provider: 'openai', model: 'gpt-6-luna'}), 'zcode:openai:gpt-6-luna');

    // Budgeted context respects character ceiling while always keeping at least the latest turn
    const history = [
        {role: 'user', content: 'A'.repeat(500)},
        {role: 'assistant', content: 'B'.repeat(500)},
        {role: 'user', content: '最近的问题'},
    ];
    const budgeted = buildBudgetedContextMessages(history, 10, 600);
    assert.equal(budgeted.length, 2);
    assert.equal(budgeted[0].content, 'B'.repeat(500));
    assert.equal(budgeted[1].content, '最近的问题');

    // Cross-backend prompt carries concise prior context when switching backends mid-session
    const handoffPrompt = buildCrossBackendPromptWithContext(
        [{role: 'user', content: '帮我查端口 8080'}, {role: 'assistant', content: '可以使用 ss -tulpn | grep 8080'}],
        '那怎么杀掉对应进程？'
    );
    assert.ok(handoffPrompt.includes('用户：帮我查端口 8080'));
    assert.ok(handoffPrompt.includes('助手：可以使用 ss -tulpn | grep 8080'));
    assert.ok(handoffPrompt.includes('那怎么杀掉对应进程？'));

    // Capability matrix reflects true backend differences
    assert.equal(getBackendCapabilities('zcode').supportsApproval, true);
    assert.equal(getBackendCapabilities('codex').supportsApproval, false);
    assert.equal(getBackendCapabilities('openai').supportsTools, false);
});
