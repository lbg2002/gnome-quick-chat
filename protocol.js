// Pure helpers shared with GNOME extension and Node unit tests. No GNOME dependencies.

const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text) {
    if (typeof text !== 'string') return '';
    return text.replace(ANSI_PATTERN, '');
}

export function messageText(message) {
    if (!message) return '';
    if (typeof message.content === 'string') return message.content;
    return (Array.isArray(message.content) ? message.content : [])
        .filter(part => part && part.type === 'text')
        .map(part => part.text ?? '')
        .join('\n');
}

export function messageThinking(message) {
    if (!message) return '';
    if (typeof message.thinking === 'string') return message.thinking;
    if (!Array.isArray(message.content)) return '';
    return message.content
        .filter(part => part && (part.type === 'thinking' || part.type === 'reasoning'))
        .map(part => part.thinking ?? part.text ?? '')
        .filter(Boolean)
        .join('\n');
}

export function visibleMessages(messages) {
    return (Array.isArray(messages) ? messages : [])
        .filter(m => m && ['user', 'assistant'].includes(m.role))
        .map(m => ({role: m.role, text: messageText(m)}))
        .filter(m => m.text.length > 0);
}

export function detailedMessages(messages) {
    return (Array.isArray(messages) ? messages : [])
        .filter(m => m && ['user', 'assistant'].includes(m.role))
        .map(m => ({
            role: m.role,
            text: messageText(m),
            thinking: m.role === 'assistant' ? messageThinking(m) : '',
        }))
        .filter(m => m.text.length > 0 || m.thinking.length > 0);
}

export function getBackendCapabilities(backend) {
    switch (backend) {
        case 'zcode':
            return {
                supportsTools: true,
                supportsApproval: true,
                supportsResume: true,
                supportsThinking: true,
                supportsSkills: true,
                supportsMcp: true,
                modeLabels: [
                    '纯问答 (禁用本地与联网工具)',
                    '智能审批 Agent (推荐 · 敏感工具气泡内审批)',
                    '全自动 Agent (免审批自动执行一切工具)',
                ],
                modeBadges: {chat: '纯问答', readonly: '智能审批', full: '全自动 Agent'},
            };
        case 'codex':
            return {
                supportsTools: true,
                supportsApproval: false,
                supportsResume: true,
                supportsThinking: true,
                supportsSkills: false,
                supportsMcp: true,
                modeLabels: [
                    '纯问答 (受限只读沙箱 · 指示仅作答)',
                    '只读沙箱 Agent (允许只读检索 · 无弹窗审批)',
                    '全自动 Agent (无沙箱读写与执行命令)',
                ],
                modeBadges: {chat: '纯问答', readonly: '只读沙箱', full: '全自动 Agent'},
            };
        case 'pi':
            return {
                supportsTools: true,
                supportsApproval: false,
                supportsResume: true,
                supportsThinking: true,
                supportsSkills: false,
                supportsMcp: false,
                modeLabels: [
                    '纯问答 (--no-tools 完全禁用工具)',
                    '只读白名单 Agent (仅允许 read/grep/find/ls)',
                    '全自动 Agent (允许 read/bash/edit/write)',
                ],
                modeBadges: {chat: '纯问答', readonly: '只读白名单', full: '全自动 Agent'},
            };
        default:
            return {
                supportsTools: false,
                supportsApproval: false,
                supportsResume: true,
                supportsThinking: true,
                supportsSkills: false,
                supportsMcp: false,
                modeLabels: [
                    '纯问答 (HTTP 流式对话，不调用本机工具)',
                    '纯问答 (OpenAI API 模式无本机工具)',
                    '纯问答 (OpenAI API 模式无本机工具)',
                ],
                modeBadges: {chat: '', readonly: '', full: ''},
            };
    }
}

export function mapReasoningEffort(effort) {
    switch (String(effort || 'default').trim()) {
        case 'fast':
            return 'low';
        case 'standard':
            return 'medium';
        case 'deep':
            return 'high';
        default:
            return '';
    }
}

const DESTRUCTIVE_SHELL_RE = /(?:^|[;&|]\s*)(?:sudo|su|rm\s+-[a-zA-Z]*[rf]|mkfs|dd\s+|fdisk|parted|shutdown|reboot|chmod\s+-R|chown\s+-R|>\s*\/etc\/)/i;

export function isAskUserQuestionTool(toolName, input = null) {
    const lower = String(toolName || '').trim().toLowerCase();
    if (lower === 'askuserquestion') return true;
    return Boolean(input && typeof input === 'object' && Array.isArray(input.questions) && input.questions.length > 0);
}

export function parseAskUserQuestions(input) {
    const rawList = Array.isArray(input?.questions) ? input.questions : [];
    const result = [];
    for (const item of rawList) {
        if (!item || typeof item !== 'object') continue;
        const question = String(item.question || '').trim();
        if (!question) continue;
        const header = String(item.header || '').trim();
        const multiSelect = Boolean(item.multiSelect);
        const rawOptions = Array.isArray(item.options) ? item.options : [];
        const options = [];
        for (const opt of rawOptions) {
            if (!opt || typeof opt !== 'object') continue;
            const label = String(opt.label || '').trim();
            if (!label) continue;
            const normalizedOpt = {
                label,
                description: String(opt.description || '').trim(),
            };
            if (typeof opt.preview === 'string' && opt.preview.trim()) {
                normalizedOpt.preview = opt.preview.trim();
            }
            options.push(normalizedOpt);
        }
        result.push({question, header, multiSelect, options});
    }
    return result;
}

export function summarizeAskUserQuestions(input) {
    const questions = parseAskUserQuestions(input);
    if (!questions.length) return '';
    if (questions.length === 1) {
        const q = questions[0];
        return q.header ? `[${q.header}] ${q.question}` : q.question;
    }
    return questions
        .map(q => (q.header ? `[${q.header}] ${q.question}` : q.question))
        .join(' · ');
}

/**
 * Builds a strict ZCode-compatible `modifiedInput` object for `AskUserQuestion`.
 * Preserves only schema-permitted keys (`questions`, `answers`, `annotations`, `metadata`)
 * and guarantees no blank string values exist in `answers`.
 */
export function buildAskUserModifiedInput(rawInput, drafts = {}, {skipAll = false} = {}) {
    const baseQuestions = Array.isArray(rawInput?.questions) ? rawInput.questions : [];
    const parsedQuestions = parseAskUserQuestions(rawInput);
    const answers = {};
    const annotations = {};

    if (!skipAll) {
        for (const q of parsedQuestions) {
            const draft = drafts?.[q.question] || {};
            const selectedLabels = (Array.isArray(draft.selectedLabels) ? draft.selectedLabels : [])
                .map(s => String(s || '').trim())
                .filter(Boolean);
            const customText = String(draft.customText || '').trim();

            if (q.multiSelect) {
                const combined = [...selectedLabels, ...(customText ? [customText] : [])];
                if (combined.length > 0) {
                    answers[q.question] = combined.join(', ');
                }
            } else if (selectedLabels.length > 0) {
                answers[q.question] = selectedLabels[0];
                const matchedOpt = q.options.find(o => o.label === selectedLabels[0]);
                const noteObj = {};
                if (matchedOpt?.preview) noteObj.preview = matchedOpt.preview;
                if (customText) noteObj.notes = customText;
                if (Object.keys(noteObj).length > 0) {
                    annotations[q.question] = noteObj;
                }
            } else if (customText) {
                answers[q.question] = customText;
            }
        }
    }

    const modified = {
        questions: baseQuestions,
        answers,
    };
    if (Object.keys(annotations).length > 0) {
        modified.annotations = annotations;
    }
    if (rawInput?.metadata && typeof rawInput.metadata === 'object') {
        const cleanMeta = {};
        if (typeof rawInput.metadata.source === 'string') {
            cleanMeta.source = rawInput.metadata.source;
        }
        modified.metadata = cleanMeta;
    }
    return modified;
}

export function formatAskUserAnswerSummary(questions = [], modifiedInput = null) {
    const answers = modifiedInput?.answers || {};
    const annotations = modifiedInput?.annotations || {};
    const entries = Object.entries(answers).filter(([, v]) => String(v || '').trim().length > 0);
    if (entries.length === 0) {
        return '⏭ 已交由 AI 自行判断';
    }
    const lines = [];
    const list = Array.isArray(questions) && questions.length > 0
        ? questions
        : entries.map(([qText]) => ({question: qText, header: ''}));
    for (const q of list) {
        const val = answers[q.question];
        const prefix = q.header || q.question;
        if (!val) {
            lines.push(`• ${prefix}：（未指定，交由 AI 判断）`);
            continue;
        }
        const notes = annotations[q.question]?.notes;
        lines.push(notes ? `✓ ${prefix}：${val}（备注：${notes}）` : `✓ ${prefix}：${val}`);
    }
    return lines.join('\n');
}

/**
 * Computes graded, command/action-scoped session approval keys.
 * Prevents broad tool-level `alwaysAllow` on dangerous tools like Bash/Edit/Write
 * and interactive tools like AskUserQuestion.
 */
export function computePermissionScope(toolName, summaryOrInput = '') {
    const tool = String(toolName || '工具').trim();
    if (isAskUserQuestionTool(tool, typeof summaryOrInput === 'object' ? summaryOrInput : null)) {
        return {
            scopeKey: '',
            allowSessionRule: false,
            sessionRuleLabel: '',
        };
    }

    const rawSummary = typeof summaryOrInput === 'string'
        ? summaryOrInput.trim()
        : String(summaryOrInput?.command || summaryOrInput?.url || summaryOrInput?.file_path || summaryOrInput?.path || '').trim();

    const lower = tool.toLowerCase();
    const isShell = lower === 'bash' || lower === 'sh' || lower.includes('shell') || lower.includes('exec') || lower.includes('repl');
    const isFileMutate = lower === 'write' || lower === 'edit' || lower === 'multiedit' || lower === 'notebookedit' || lower === 'delete';

    if (isShell) {
        if (!rawSummary || DESTRUCTIVE_SHELL_RE.test(rawSummary)) {
            return {
                scopeKey: '',
                allowSessionRule: false,
                sessionRuleLabel: '',
            };
        }
        // Scope strictly to the normalized command string (never all Bash commands!)
        const normalizedCmd = rawSummary.replace(/\s+/g, ' ').slice(0, 120);
        return {
            scopeKey: `${tool}:cmd:${normalizedCmd}`,
            allowSessionRule: true,
            sessionRuleLabel: '✓ 本次会话允许该命令',
        };
    }

    if (isFileMutate) {
        if (!rawSummary || rawSummary.startsWith('/etc/') || rawSummary.startsWith('/usr/')) {
            return {
                scopeKey: '',
                allowSessionRule: false,
                sessionRuleLabel: '',
            };
        }
        return {
            scopeKey: `${tool}:file:${rawSummary}`,
            allowSessionRule: true,
            sessionRuleLabel: '✓ 本次会话允许修改该文件',
        };
    }

    if (lower === 'webfetch' && rawSummary) {
        const urlMatch = /^(?:url:\s*)?https?:\/\/([^/?#:\s]+)/i.exec(rawSummary);
        const host = urlMatch ? urlMatch[1].toLowerCase() : '';
        if (host) {
            return {
                scopeKey: `${tool}:host:${host}`,
                allowSessionRule: true,
                sessionRuleLabel: `✓ 允许访问 ${host}`,
            };
        }
    }

    return {
        scopeKey: `tool:${tool}`,
        allowSessionRule: true,
        sessionRuleLabel: '✓ 本次会话始终允许',
    };
}

export function buildModelSignature(backend, config = {}) {
    if (backend === 'openai') {
        const url = String(config.openaiBaseUrl || '').trim().replace(/\/+$/, '');
        const mod = String(config.openaiModel || config.model || '').trim();
        return `openai:${url}:${mod}`;
    }
    return `${backend}:${String(config.provider || '').trim()}:${String(config.model || '').trim()}`;
}

export function buildBudgetedContextMessages(messages, maxMessages = 24, maxChars = 28000) {
    if (!Array.isArray(messages) || !messages.length) return [];
    const selected = [];
    let usedChars = 0;

    for (let i = messages.length - 1; i >= 0 && selected.length < maxMessages; i--) {
        const m = messages[i];
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
        const txt = messageText(m).trim();
        if (!txt) continue;
        if (selected.length > 0 && usedChars + txt.length > maxChars) {
            break;
        }
        selected.push({role: m.role, content: txt});
        usedChars += txt.length;
    }

    selected.reverse();
    return selected;
}

export function buildCrossBackendPromptWithContext(historyBeforePrompt, newPromptText, maxChars = 6000) {
    const prior = buildBudgetedContextMessages(historyBeforePrompt, 8, maxChars);
    if (!prior.length) return newPromptText;
    const lines = prior.map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`);
    return [
        '[以下是当前随问会话的前序上下文，请自然承接回答最新问题]',
        ...lines,
        '',
        '[最新问题]',
        newPromptText,
    ].join('\n');
}

export function buildArgs(config, sessionDir, sessionId) {
    const mode = config?.mode;
    const args = [
        config?.executable || 'pi',
        '--mode', 'rpc',
        '--session-dir', sessionDir,
        '--session-id', sessionId,
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--no-mcp',
    ];
    if (mode === 'full') args.push('--tools', 'read,bash,edit,write');
    else if (mode === 'readonly') args.push('--tools', 'read,grep,find,ls');
    else args.push('--no-tools');
    if (config?.provider) args.push('--provider', config.provider);
    if (config?.model) args.push('--model', config.model);
    return args;
}

export function buildZCodeArgs(config, prompt, resumeSessionId = '') {
    const mode = config?.mode;
    const prefix = Array.isArray(config?.commandPrefix) && config.commandPrefix.length
        ? [...config.commandPrefix]
        : [config?.executable || 'zcode'];
    const args = [
        ...prefix,
        '--prompt', String(prompt ?? ''),
        '--output-format', 'stream-json',
        '--no-color',
        '--workflow-mode', 'disabled',
        '--toolsearch-mode', 'off',
    ];
    if (mode === 'full') {
        args.push('--mode', 'yolo');
    } else if (mode === 'readonly') {
        args.push('--mode', 'build');
    } else {
        args.push('--mode', 'plan', '--disallowed-tools', 'Bash Edit Write Read Grep Glob LS WebFetch WebSearch TodoWrite NotebookEdit');
    }
    if (resumeSessionId) {
        args.push('--resume', resumeSessionId);
    }
    return args;
}

export function buildCodexArgs(config, workspace, prompt, resumeSessionId = '') {
    const mode = config?.mode;
    const exec = config?.executable || 'codex';
    const common = ['--json', '--skip-git-repo-check', '--color', 'never'];
    const provider = String(config?.provider ?? '').trim();
    const model = String(config?.model ?? '').trim();
    if (provider && provider !== 'openai') {
        common.push('-c', `model_provider=${JSON.stringify(provider)}`);
    }
    if (model) {
        common.push('-c', `model=${JSON.stringify(model)}`);
    }
    const effort = mapReasoningEffort(config?.reasoningEffort);
    if (effort) {
        common.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
    }
    if (mode === 'full') {
        common.push('-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"');
    } else {
        common.push('-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"');
    }
    const effectivePrompt = mode === 'chat'
        ? `[纯问答模式：请直接回答问题，不要执行本地命令或调用检索工具]\n${String(prompt ?? '')}`
        : String(prompt ?? '');
    if (resumeSessionId) {
        return [exec, 'exec', 'resume', ...common, resumeSessionId, effectivePrompt];
    }
    return [exec, 'exec', ...common, ...(workspace ? ['-C', workspace] : []), effectivePrompt];
}

export function parseZCodeProviderCatalog(personalConfigObj, builtinConfigObj = null) {
    const providers = [];
    const seenIds = new Set();
    const pc = personalConfigObj?.config || {};
    const order = Array.isArray(pc.providerOrder) ? pc.providerOrder : [];
    const rules = Array.isArray(pc.providerConfigRules?.providerRules)
        ? pc.providerConfigRules.providerRules
        : [];

    const ruleById = new Map();
    for (const r of rules) {
        if (r?.providerId) ruleById.set(r.providerId, r);
    }

    const orderedRules = [
        ...order.map(id => ruleById.get(id)).filter(Boolean),
        ...rules.filter(r => r?.providerId && !order.includes(r.providerId)),
    ];

    for (const r of orderedRules) {
        if (r.config?.enabled === false) continue;
        const id = String(r.providerId).trim();
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        const name = String(r.providerName || id).trim();
        const baseUrl = String(r.config?.api?.baseUrl || '').trim();
        const apiKey = String(r.config?.access?.apiKey || '').trim();
        const rawModels = [
            ...(Array.isArray(r.config?.modelOrder) ? r.config.modelOrder : []),
            ...(Array.isArray(r.config?.personalModelIds) ? r.config.personalModelIds : []),
        ];
        const models = Array.from(new Set(rawModels.map(m => String(m ?? '').trim()).filter(Boolean)));
        providers.push({id, name, baseUrl, apiKey, models});
    }

    const builtinRules = Array.isArray(builtinConfigObj?.config?.providerConfigRules?.providerRules)
        ? builtinConfigObj.config.providerConfigRules.providerRules
        : [];
    for (const r of builtinRules) {
        const id = String(r?.providerId || '').trim();
        if (!id || seenIds.has(id) || r.config?.visibility === 'hidden') continue;
        const models = Array.from(new Set(
            (Array.isArray(r.config?.builtinModelIds) ? r.config.builtinModelIds : [])
                .map(m => String(m ?? '').trim())
                .filter(Boolean)
        ));
        if (!models.length) continue;
        seenIds.add(id);
        const name = String(r.providerNameMap?.['zh-CN'] || r.providerNameMap?.['en-US'] || id).trim();
        const baseUrl = String(r.config?.api?.baseUrl || '').trim();
        providers.push({id, name, baseUrl, apiKey: '', models});
    }

    return {
        defaultSelection: pc.defaultModelSelection || null,
        providers,
    };
}

export function buildZCodePersonalConfigOverride(personalConfigObj, {provider = '', model = '', reasoningEffort = 'default'} = {}) {
    if (!personalConfigObj || typeof personalConfigObj !== 'object') return null;
    const cloned = JSON.parse(JSON.stringify(personalConfigObj));
    if (!cloned.config || typeof cloned.config !== 'object') {
        cloned.config = {};
    }
    const catalog = parseZCodeProviderCatalog(cloned);
    const providers = catalog.providers;
    let rawProvider = String(provider ?? '').trim();
    let rawModel = String(model ?? '').trim();
    const mappedEffort = mapReasoningEffort(reasoningEffort);

    if (!rawProvider && !rawModel && !mappedEffort) {
        return {configObj: cloned, providerId: '', modelId: ''};
    }

    const matchProvider = query => {
        if (!query) return null;
        const q = query.toLowerCase();
        return providers.find(p => p.id.toLowerCase() === q || p.name.toLowerCase() === q) || null;
    };

    let matchedProvider = matchProvider(rawProvider);

    // Smart recovery: if user entered a model ID into the provider field and left model empty
    if (!matchedProvider && rawProvider && !rawModel) {
        const owner = providers.find(p => p.models.some(m => m.toLowerCase() === rawProvider.toLowerCase()));
        if (owner) {
            matchedProvider = owner;
            rawModel = owner.models.find(m => m.toLowerCase() === rawProvider.toLowerCase()) || rawProvider;
            rawProvider = owner.id;
        }
    }

    if (!matchedProvider && rawModel) {
        matchedProvider = providers.find(p => p.models.some(m => m.toLowerCase() === rawModel.toLowerCase()))
            || providers[0]
            || null;
    }

    const existingDefault = cloned.config.defaultModelSelection || {};
    const resolvedProviderId = (rawProvider || rawModel)
        ? (matchedProvider ? matchedProvider.id : (rawProvider || providers[0]?.id || ''))
        : (existingDefault.providerId || providers[0]?.id || '');
    const resolvedModelId = (rawProvider || rawModel)
        ? (rawModel || matchedProvider?.models?.[0] || '')
        : (existingDefault.modelId || matchedProvider?.models?.[0] || '');

    if (resolvedProviderId && resolvedModelId) {
        const rules = Array.isArray(cloned.config.providerConfigRules?.providerRules)
            ? cloned.config.providerConfigRules.providerRules
            : [];
        const rule = rules.find(r => r?.providerId === resolvedProviderId);
        if (rule?.config) {
            if (Array.isArray(rule.config.personalModelIds) && !rule.config.personalModelIds.includes(resolvedModelId)) {
                rule.config.personalModelIds.unshift(resolvedModelId);
            }
            if (Array.isArray(rule.config.modelOrder) && !rule.config.modelOrder.includes(resolvedModelId)) {
                rule.config.modelOrder.unshift(resolvedModelId);
            }
        }
        const preservedOptions = existingDefault.options && typeof existingDefault.options === 'object'
            ? {...existingDefault.options}
            : {};
        if (mappedEffort) {
            preservedOptions.reasoningLevel = mappedEffort;
        }
        cloned.config.defaultModelSelection = {
            providerId: resolvedProviderId,
            modelId: resolvedModelId,
            ...(Object.keys(preservedOptions).length > 0 ? {options: preservedOptions} : {}),
        };
    }

    return {
        configObj: cloned,
        providerId: resolvedProviderId,
        modelId: resolvedModelId,
    };
}

export function parseCodexProviderCatalog(configTomlText = '', modelsCacheObj = null) {
    const text = String(configTomlText ?? '');
    const lines = text.split(/\r?\n/);
    let defaultModel = '';
    let defaultProvider = 'openai';
    let currentSection = '';
    const providerMap = new Map([
        ['openai', {id: 'openai', name: 'OpenAI (默认)', baseUrl: '', apiKey: '', models: []}],
    ]);

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const secMatch = line.match(/^\[([^\]]+)\]$/);
        if (secMatch) {
            currentSection = secMatch[1].trim();
            const mpMatch = currentSection.match(/^model_providers\.([a-zA-Z0-9_-]+)$/);
            if (mpMatch) {
                const id = mpMatch[1];
                if (!providerMap.has(id)) {
                    providerMap.set(id, {id, name: id, baseUrl: '', apiKey: '', models: []});
                }
            }
            continue;
        }
        const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/);
        if (!kvMatch) continue;
        const [, key, val] = kvMatch;
        if (!currentSection) {
            if (key === 'model') defaultModel = val.trim();
            if (key === 'model_provider') defaultProvider = val.trim() || 'openai';
        } else if (currentSection.startsWith('model_providers.')) {
            const id = currentSection.slice('model_providers.'.length);
            const entry = providerMap.get(id);
            if (entry) {
                if (key === 'name' && val.trim()) entry.name = val.trim();
                if (key === 'base_url') entry.baseUrl = val.trim();
                if (key === 'experimental_bearer_token') entry.apiKey = val.trim();
            }
        }
    }

    const cacheModels = Array.isArray(modelsCacheObj?.models)
        ? modelsCacheObj.models.map(m => String(m?.slug || m?.id || m?.name || '').trim()).filter(Boolean)
        : [];
    const allModels = Array.from(new Set([
        ...(defaultModel ? [defaultModel] : []),
        ...cacheModels,
    ]));

    for (const entry of providerMap.values()) {
        entry.models = [...allModels];
    }

    return {
        defaultProvider,
        defaultModel,
        providers: Array.from(providerMap.values()),
    };
}

export function normalizeOpenAIEndpoint(baseUrl, resourcePath = '/chat/completions') {
    const raw = String(baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (raw.endsWith('/chat/completions')) {
        if (resourcePath === '/chat/completions') return raw;
        return raw.slice(0, -'/chat/completions'.length) + resourcePath;
    }
    if (raw.endsWith('/models')) {
        if (resourcePath === '/models') return raw;
        return raw.slice(0, -'/models'.length) + resourcePath;
    }
    // Check if URL already has a non-root path like /v1, /v1beta, /api/v3, /compatible-mode/v1 (portable across GJS & Node)
    const pathMatch = /^https?:\/\/[^/?#]+(\/[^?#]*)?/i.exec(raw);
    if (pathMatch) {
        const pathname = pathMatch[1] || '';
        if (!pathname || pathname === '/') {
            return `${raw}/v1${resourcePath}`;
        }
    } else if (!raw.includes('/v1')) {
        return `${raw}/v1${resourcePath}`;
    }
    return `${raw}${resourcePath}`;
}

export function parseOpenAISSELine(line) {
    if (typeof line !== 'string') return null;
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;
    const payload = trimmed.slice(5).trim();
    if (!payload) return null;
    if (payload === '[DONE]') return {done: true};
    try {
        const parsed = JSON.parse(payload);
        if (parsed.error) {
            return {error: parsed.error.message || JSON.stringify(parsed.error)};
        }
        const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
        const delta = choice?.delta || choice?.message || {};
        const textDelta = typeof delta.content === 'string' ? delta.content : '';
        const thinkingDelta = typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : (typeof delta.thinking === 'string' ? delta.thinking : '');
        return {
            done: false,
            model: parsed.model || '',
            textDelta,
            thinkingDelta,
        };
    } catch (_) {
        return null;
    }
}

export function normalizeEvent(backend, record) {
    if (!record || typeof record !== 'object') return null;

    if (backend === 'zcode') {
        const type = record.type;
        if (type === 'session.created' || type === 'session.resumed') {
            return {type: 'session_bound', sessionId: record.sessionId || record.payload?.sessionId || ''};
        }
        if (type === 'turn.started') {
            return {
                type: 'message_start',
                sessionId: record.sessionId || '',
                modelId: record.payload?.intent?.modelSelection?.modelId || '',
                message: {role: 'assistant'},
            };
        }
        if (type === 'model.streaming') {
            const kind = record.payload?.kind;
            const delta = record.payload?.delta ?? '';
            if (kind === 'text_delta' && delta) {
                return {type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta}};
            }
            if (kind === 'reasoning_delta' && delta) {
                return {type: 'message_update', assistantMessageEvent: {type: 'thinking_delta', delta}};
            }
            return null;
        }
        if (type === 'quickchat.bridge_ready') {
            return {
                type: 'bridge_ready',
                protocolVersion: Number(record.protocolVersion || 1),
                patched: Boolean(record.patched),
            };
        }
        if (type === 'quickchat.permission_requested') {
            const p = record.payload || {};
            if (!p.requestId) return null;
            const toolName = String(p.toolName || '工具');
            const questions = parseAskUserQuestions(p.input);
            const isQuestion = isAskUserQuestionTool(toolName, p.input) && questions.length > 0;
            let summary = isQuestion
                ? summarizeAskUserQuestions(p.input)
                : (p.summary || '');
            if (!summary && p.input && typeof p.input === 'object') {
                summary = p.input.command || p.input.url || p.input.file_path || p.input.path || p.input.pattern || p.input.query || p.input.title || '';
            }
            const scope = isQuestion
                ? {scopeKey: '', allowSessionRule: false, sessionRuleLabel: ''}
                : computePermissionScope(toolName, summary || p.input || '');
            const evt = {
                type: 'permission_request',
                requestId: String(p.requestId),
                toolCallId: String(p.toolCallId || ''),
                toolName,
                riskLevel: String(p.riskLevel || 'medium'),
                reason: String(p.reason || (isQuestion ? '请选择或输入您的回答以继续' : '该操作需要您的授权')),
                summary: String(summary || ''),
                scopeKey: isQuestion ? '' : (p.scopeKey ? String(p.scopeKey) : scope.scopeKey),
                allowSessionRule: isQuestion
                    ? false
                    : (typeof p.allowSessionRule === 'boolean' ? p.allowSessionRule : scope.allowSessionRule),
                sessionRuleLabel: isQuestion
                    ? ''
                    : (p.sessionRuleLabel ? String(p.sessionRuleLabel) : scope.sessionRuleLabel),
            };
            if (isQuestion) {
                evt.isQuestion = true;
                evt.questions = questions;
                evt.rawInput = p.input;
            }
            return evt;
        }
        if (type === 'permission.resolved' || type === 'permission.denied') {
            const p = record.payload || {};
            return {
                type: 'permission_resolved',
                requestId: String(p.requestId || ''),
                toolCallId: String(p.toolCallId || ''),
                decision: String(p.decision || (type === 'permission.denied' ? 'deny' : 'allow')),
            };
        }
        if (type === 'tool.updated') {
            const p = record.payload || {};
            const kind = p.kind;
            const toolName = p.toolName || p.name || p.tool || '工具';
            const toolCallId = p.toolCallId ? String(p.toolCallId) : '';
            const isQuestionTool = isAskUserQuestionTool(toolName, p.input);
            let summary = '';
            if (isQuestionTool && p.input && typeof p.input === 'object') {
                summary = summarizeAskUserQuestions(p.input);
            } else if (p.input && typeof p.input === 'object') {
                summary = p.input.command || p.input.url || p.input.file_path || p.input.path || p.input.pattern || p.input.query || p.input.code || p.input.title || '';
            } else if (typeof p.input === 'string') {
                summary = p.input;
            }
            if (!summary && p.description) summary = p.description;

            if (kind === 'started' || kind === 'scheduled') {
                const evt = {type: 'tool_execution_start', toolName: String(toolName)};
                if (toolCallId) evt.toolCallId = toolCallId;
                if (summary) evt.summary = String(summary);
                if (isQuestionTool) {
                    const questions = parseAskUserQuestions(p.input);
                    if (questions.length > 0) {
                        evt.isQuestion = true;
                        evt.questions = questions;
                        evt.rawInput = p.input;
                    }
                }
                return evt;
            }
            if (kind === 'result' || kind === 'error') {
                const evt = {
                    type: 'tool_execution_end',
                    toolName: String(toolName),
                    isError: kind === 'error' || Boolean(p.result?.isError),
                };
                if (toolCallId) evt.toolCallId = toolCallId;
                if (typeof p.duration === 'number') evt.duration = p.duration;
                const detail = p.error?.message || p.error?.detail || p.result?.title || p.result?.summary || '';
                if (detail) evt.detail = String(detail);
                return evt;
            }
            if (kind === 'batch') {
                return {type: 'tool_batch_end', toolCallIds: Array.isArray(p.toolCallIds) ? p.toolCallIds : []};
            }
            return null;
        }
        if (type === 'turn.failed') {
            const err = record.payload?.message || record.payload?.error || '请求执行失败';
            return {
                type: 'message_end',
                message: {role: 'assistant', content: '', errorMessage: String(err)},
            };
        }
        if (type === 'result') {
            return {
                type: 'turn_result',
                sessionId: record.sessionId || '',
                text: typeof record.response === 'string' ? record.response : '',
            };
        }
        return null;
    }

    if (backend === 'codex') {
        const type = record.type;
        if (type === 'thread.started' && record.thread_id) {
            return {type: 'session_bound', sessionId: record.thread_id};
        }
        if (type === 'turn.started') {
            return {type: 'message_start', message: {role: 'assistant'}};
        }
        if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
            const item = record.item;
            if (!item || typeof item !== 'object') return null;
            if (item.type === 'reasoning' && typeof item.text === 'string' && item.text) {
                return {type: 'thinking_snapshot', text: item.text};
            }
            if (item.type === 'command_execution' || item.type === 'mcp_tool_call' || item.type === 'file_change') {
                const toolCallId = item.id ? String(item.id) : '';
                const toolName = item.type === 'command_execution'
                    ? 'Bash'
                    : item.type === 'mcp_tool_call'
                        ? String(item.tool_name || 'MCP')
                        : 'FileChange';
                const summary = String(item.command || item.tool_name || item.path || '');
                if (type === 'item.completed') {
                    const isError = Boolean(
                        (typeof item.exit_code === 'number' && item.exit_code !== 0) ||
                        item.status === 'failed' ||
                        item.error
                    );
                    const evt = {type: 'tool_execution_end', toolName, isError};
                    if (toolCallId) evt.toolCallId = toolCallId;
                    if (isError && typeof item.exit_code === 'number') {
                        evt.detail = `退出码 ${item.exit_code}`;
                    } else if (item.error) {
                        evt.detail = String(item.error?.message || item.error);
                    }
                    return evt;
                }
                const evt = {type: 'tool_execution_start', toolName};
                if (toolCallId) evt.toolCallId = toolCallId;
                if (summary) evt.summary = summary;
                return evt;
            }
            if (item.type === 'agent_message' && typeof item.text === 'string') {
                if (type === 'item.completed') {
                    return {type: 'message_end', message: {role: 'assistant', content: item.text}};
                }
                return {type: 'text_snapshot', text: item.text};
            }
        }
        if (type === 'turn.completed') {
            return {type: 'turn_completed'};
        }
        if (type === 'turn.failed' || type === 'error') {
            const msg = record.error?.message || record.message || '执行失败';
            return {type: 'message_end', message: {role: 'assistant', content: '', errorMessage: String(msg)}};
        }
        return null;
    }

    return record;
}

export function escapePango(text) {
    if (typeof text !== 'string' || !text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function inlineMarkdownToPango(text) {
    if (typeof text !== 'string' || !text) return '';
    const codeSpans = [];
    // Extract inline code spans into placeholders first so outer **bold** / *italic* can wrap them cleanly.
    const withPlaceholders = text.replace(/`([^`\n]+)`/g, (_, inner) => {
        const idx = codeSpans.length;
        codeSpans.push(`<tt>${escapePango(inner)}</tt>`);
        return `\u0000CODE_${idx}\u0000`;
    });

    let escaped = escapePango(withPlaceholders);
    // Markdown links [label](url) -> underlined label (url)
    escaped = escaped.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<u>$1</u> <small>($2)</small>');
    // Bold **text** or __text__
    escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    escaped = escaped.replace(/__([^_\n]+)__/g, '<b>$1</b>');
    // Italic *text*
    escaped = escaped.replace(/(^|[\s(（])\*([^*\n]+)\*(?=$|[\s).,!?:;，。！？：；）])/g, '$1<i>$2</i>');
    // Strikethrough ~~text~~
    escaped = escaped.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

    return escaped.replace(/\u0000CODE_(\d+)\u0000/g, (_, idx) => codeSpans[Number(idx)] ?? '');
}

function formatLineToPango(line) {
    const trimmed = line.trimStart();
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
        const content = inlineMarkdownToPango(headingMatch[2].trim());
        return `<b>${content}</b>`;
    }
    const bulletMatch = /^(\s*)([-*+])\s+(.+)$/.exec(line);
    if (bulletMatch) {
        const indent = '  '.repeat(Math.min(4, Math.floor(bulletMatch[1].length / 2)));
        return `${indent}• ${inlineMarkdownToPango(bulletMatch[3])}`;
    }
    const orderedMatch = /^(\s*)(\d+[.)])\s+(.+)$/.exec(line);
    if (orderedMatch) {
        const indent = '  '.repeat(Math.min(4, Math.floor(orderedMatch[1].length / 2)));
        return `${indent}<b>${escapePango(orderedMatch[2])}</b> ${inlineMarkdownToPango(orderedMatch[3])}`;
    }
    const quoteMatch = /^>\s?(.*)$/.exec(trimmed);
    if (quoteMatch) {
        return `┃ <i>${inlineMarkdownToPango(quoteMatch[1])}</i>`;
    }
    if (/^([-*_])\1{2,}\s*$/.test(trimmed)) {
        return '────────────';
    }
    return inlineMarkdownToPango(line);
}

export function parseMarkdownBlocks(markdown) {
    if (typeof markdown !== 'string' || !markdown) return [];
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let textLines = [];
    let inCode = false;
    let codeLang = '';
    let codeLines = [];

    const flushText = () => {
        if (!textLines.length) return;
        const raw = textLines.join('\n').replace(/^\n+|\n+$/g, '');
        textLines = [];
        if (!raw) return;
        const pango = raw.split('\n').map(formatLineToPango).join('\n');
        blocks.push({type: 'text', raw, pango});
    };

    for (const line of lines) {
        const fenceMatch = /^\s*```([\w.+-]*)\s*$/.exec(line);
        if (!inCode && fenceMatch) {
            flushText();
            inCode = true;
            codeLang = (fenceMatch[1] || '').trim().toLowerCase();
            codeLines = [];
            continue;
        }
        if (inCode && /^\s*```\s*$/.test(line)) {
            blocks.push({
                type: 'code',
                lang: codeLang || 'code',
                code: codeLines.join('\n'),
                closed: true,
            });
            inCode = false;
            codeLang = '';
            codeLines = [];
            continue;
        }
        if (inCode) {
            codeLines.push(line);
        } else {
            textLines.push(line);
        }
    }

    if (inCode) {
        blocks.push({
            type: 'code',
            lang: codeLang || 'code',
            code: codeLines.join('\n'),
            closed: false,
        });
    } else {
        flushText();
    }

    return blocks;
}
