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
    if (mode === 'full') {
        common.push('-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"');
    } else {
        common.push('-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"');
    }
    if (resumeSessionId) {
        return [exec, 'exec', 'resume', ...common, resumeSessionId, String(prompt ?? '')];
    }
    return [exec, 'exec', ...common, ...(workspace ? ['-C', workspace] : []), String(prompt ?? '')];
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

export function buildZCodePersonalConfigOverride(personalConfigObj, {provider = '', model = ''} = {}) {
    if (!personalConfigObj || typeof personalConfigObj !== 'object') return null;
    const cloned = JSON.parse(JSON.stringify(personalConfigObj));
    if (!cloned.config || typeof cloned.config !== 'object') {
        cloned.config = {};
    }
    const catalog = parseZCodeProviderCatalog(cloned);
    const providers = catalog.providers;
    let rawProvider = String(provider ?? '').trim();
    let rawModel = String(model ?? '').trim();

    if (!rawProvider && !rawModel) {
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

    const resolvedProviderId = matchedProvider ? matchedProvider.id : (rawProvider || providers[0]?.id || '');
    const resolvedModelId = rawModel || matchedProvider?.models?.[0] || '';

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
        cloned.config.defaultModelSelection = {
            providerId: resolvedProviderId,
            modelId: resolvedModelId,
            options: {reasoningLevel: 'max'},
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
    // Check if URL already has a version/API path like /v1, /v1beta, /api/v3, /compatible-mode/v1
    try {
        const u = new URL(raw);
        if (!u.pathname || u.pathname === '/') {
            return `${raw}/v1${resourcePath}`;
        }
    } catch (_) {
        if (!raw.includes('/v1')) return `${raw}/v1${resourcePath}`;
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
        if (type === 'quickchat.permission_requested') {
            const p = record.payload || {};
            if (!p.requestId) return null;
            let summary = p.summary || '';
            if (!summary && p.input && typeof p.input === 'object') {
                summary = p.input.command || p.input.url || p.input.file_path || p.input.path || p.input.pattern || p.input.query || p.input.title || '';
            }
            return {
                type: 'permission_request',
                requestId: String(p.requestId),
                toolCallId: String(p.toolCallId || ''),
                toolName: String(p.toolName || '工具'),
                riskLevel: String(p.riskLevel || 'medium'),
                reason: String(p.reason || '该操作需要您的授权'),
                summary: String(summary || ''),
            };
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
            let summary = '';
            if (p.input && typeof p.input === 'object') {
                summary = p.input.command || p.input.url || p.input.file_path || p.input.path || p.input.pattern || p.input.query || p.input.code || p.input.title || '';
            } else if (typeof p.input === 'string') {
                summary = p.input;
            }
            if (!summary && p.description) summary = p.description;

            if (kind === 'started' || kind === 'scheduled') {
                const evt = {type: 'tool_execution_start', toolName: String(toolName)};
                if (toolCallId) evt.toolCallId = toolCallId;
                if (summary) evt.summary = String(summary);
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
                const label = item.command || item.tool_name || item.type;
                if (type === 'item.completed') {
                    return {type: 'tool_execution_end', toolName: String(label)};
                }
                return {type: 'tool_execution_start', toolName: String(label)};
            }
            if (item.type === 'agent_message' && typeof item.text === 'string') {
                if (type === 'item.completed') {
                    return {type: 'message_end', message: {role: 'assistant', content: item.text}};
                }
                return {type: 'text_snapshot', text: item.text};
            }
        }
        if (type === 'turn.completed') {
            return {type: 'agent_settled', aborted: false};
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
