// Pure-JS Quick Actions, Editable Prompt Templates & `/` Slash Commands Engine (Stage F1).
// Zero GI dependencies so unit tests validate real production logic directly in Node.
// Invariant: Selecting any quick chip or `/` command fills the input draft ONLY (`autoSend: false`)
// and NEVER triggers automatic submission!

export const MAX_CUSTOM_QUICK_PROMPTS = 12;
export const MAX_QUICK_LABEL_CHARS = 40;
export const MAX_QUICK_PROMPT_CHARS = 4000;

export const DEFAULT_QUICK_PROMPTS = Object.freeze([
    Object.freeze({
        id: 'explain_cmd',
        label: '💡 解释命令或报错',
        prompt: '请帮我解释下面这段 Linux 命令或终端报错的含义，并给出解决建议：\n',
        slash: '/explain',
    }),
    Object.freeze({
        id: 'ubuntu_tips',
        label: '⚡ Ubuntu 效率技巧',
        prompt: '请告诉我几个在 Ubuntu 26 / GNOME 50 下非常实用的高频快捷键或终端技巧。',
        slash: '',
    }),
    Object.freeze({
        id: 'polish_translate',
        label: '📝 润色或翻译文本',
        prompt: '请帮我润色或翻译下面这段内容，使其表达更加自然准确：\n',
        slash: '/polish',
    }),
]);

export const BUILTIN_SLASH_COMMANDS = Object.freeze([
    Object.freeze({
        command: '/explain',
        aliases: Object.freeze(['/解释', '/exp']),
        title: '解释',
        label: '💡 /explain · 解释',
        description: '解释概念、命令或代码逻辑',
        template: '请用清晰易懂的中文帮我解释以下内容的核心含义与工作原理：\n',
    }),
    Object.freeze({
        command: '/translate',
        aliases: Object.freeze(['/翻译', '/tr']),
        title: '翻译',
        label: '🌐 /translate · 翻译',
        description: '中英自然互译并保留代码与术语',
        template: '请将以下内容自然准确地翻译（中文译为地道英文，其他语言译为流畅中文，保留代码与专有名词）：\n',
    }),
    Object.freeze({
        command: '/polish',
        aliases: Object.freeze(['/润色', '/pol']),
        title: '润色',
        label: '✨ /polish · 润色',
        description: '修正语病并优化表达流畅度',
        template: '请帮我润色以下文本，修正语病并使其表达更加清晰自然，保持原意不变：\n',
    }),
    Object.freeze({
        command: '/summarize',
        aliases: Object.freeze(['/总结', '/sum']),
        title: '总结',
        label: '📋 /summarize · 总结',
        description: '提炼核心要点与关键结论',
        template: '请帮我总结以下内容的核心要点（使用简明列表呈现）：\n',
    }),
    Object.freeze({
        command: '/review',
        aliases: Object.freeze(['/代码检查', '/cr', '/check']),
        title: '代码检查',
        label: '🔍 /review · 代码检查',
        description: '审查潜在缺陷、边界与安全隐患',
        template: '请审查以下代码，指出潜在 Bug、边界条件缺陷、安全隐患与性能问题，并给出具体修改建议：\n',
    }),
    Object.freeze({
        command: '/error',
        aliases: Object.freeze(['/报错分析', '/err', '/fix']),
        title: '报错分析',
        label: '🛠️ /error · 报错分析',
        description: '定位终端异常根因并给出排查步骤',
        template: '请帮我分析以下终端报错或异常日志的根本原因，并给出可直接验证的排查与修复步骤：\n',
    }),
    Object.freeze({
        command: '/academic',
        aliases: Object.freeze(['/学术润色', '/acad', '/paper']),
        title: '学术润色',
        label: '🎓 /academic · 学术润色',
        description: '按严谨学术论文规范润色段落',
        template: '请按严谨、客观、精炼的学术写作规范润色以下段落，提升学术表达准确性并简要说明关键修改点：\n',
    }),
]);

function normalizeSlashToken(rawSlash) {
    const trimmed = String(rawSlash || '').trim();
    if (!trimmed) return '';
    const withPrefix = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    const clean = withPrefix.replace(/\s+/g, '').slice(0, 24);
    return clean.length > 1 ? clean.toLowerCase() : '';
}

/**
 * Parses user-configured `quick-prompts-json` safely, falling back to `DEFAULT_QUICK_PROMPTS`
 * when blank or malformed.
 */
export function parseQuickPromptsConfig(rawJson = '') {
    const trimmed = String(rawJson || '').trim();
    if (!trimmed) {
        return DEFAULT_QUICK_PROMPTS.map(item => ({...item}));
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
            return DEFAULT_QUICK_PROMPTS.map(item => ({...item}));
        }
        const normalized = [];
        for (let i = 0; i < parsed.length && normalized.length < MAX_CUSTOM_QUICK_PROMPTS; i++) {
            const entry = parsed[i];
            if (!entry || typeof entry !== 'object') continue;
            const label = String(entry.label || '').trim().slice(0, MAX_QUICK_LABEL_CHARS);
            const prompt = String(entry.prompt || '').slice(0, MAX_QUICK_PROMPT_CHARS);
            if (!label || !prompt.trim()) continue;
            normalized.push({
                id: String(entry.id || `custom_${i + 1}`).slice(0, 32),
                label,
                prompt,
                slash: normalizeSlashToken(entry.slash || ''),
            });
        }
        return normalized.length > 0
            ? normalized
            : DEFAULT_QUICK_PROMPTS.map(item => ({...item}));
    } catch (_) {
        return DEFAULT_QUICK_PROMPTS.map(item => ({...item}));
    }
}

export function serializeQuickPromptsConfig(items = []) {
    if (!Array.isArray(items) || items.length === 0) return '';
    const clean = [];
    for (let i = 0; i < items.length && clean.length < MAX_CUSTOM_QUICK_PROMPTS; i++) {
        const item = items[i];
        if (!item || typeof item !== 'object') continue;
        const label = String(item.label || '').trim().slice(0, MAX_QUICK_LABEL_CHARS);
        const prompt = String(item.prompt || '').slice(0, MAX_QUICK_PROMPT_CHARS);
        if (!label || !prompt.trim()) continue;
        clean.push({
            label,
            prompt,
            ...(item.slash ? {slash: normalizeSlashToken(item.slash)} : {}),
        });
    }
    return clean.length > 0 ? JSON.stringify(clean, null, 2) : '';
}

/**
 * Builds the combined slash command catalog (built-in 7 commands + any custom quick prompts with `slash`).
 */
export function getCombinedSlashCommands(customQuickPrompts = []) {
    const list = BUILTIN_SLASH_COMMANDS.map(cmd => ({
        command: cmd.command,
        aliases: [...cmd.aliases],
        title: cmd.title,
        label: cmd.label,
        description: cmd.description,
        template: cmd.template,
        isCustom: false,
    }));

    const byCommand = new Map(list.map((c, idx) => [c.command.toLowerCase(), idx]));
    for (const item of Array.isArray(customQuickPrompts) ? customQuickPrompts : []) {
        const slash = normalizeSlashToken(item?.slash);
        if (!slash || !item?.prompt) continue;
        const existingIdx = byCommand.get(slash);
        if (existingIdx !== undefined) {
            // Allow user template override if custom prompt explicitly binds an existing `/command`
            list[existingIdx] = {
                ...list[existingIdx],
                label: `${slash} · ${item.label}`,
                template: item.prompt,
                isCustom: true,
            };
        } else {
            byCommand.set(slash, list.length);
            list.push({
                command: slash,
                aliases: [],
                title: item.label,
                label: `${slash} · ${item.label}`,
                description: '自定义快捷模板',
                template: item.prompt,
                isCustom: true,
            });
        }
    }
    return list;
}

/**
 * Matches `/` slash commands against the current input box text.
 * Returns `{active: boolean, query: string, remainder: string, matches: Array}`.
 */
export function matchSlashCommands(inputText, customQuickPrompts = [], {forceOpen = false} = {}) {
    const raw = String(inputText ?? '');
    const catalog = getCombinedSlashCommands(customQuickPrompts);

    if (forceOpen && !raw.trim().startsWith('/')) {
        return {
            active: true,
            query: '',
            remainder: raw,
            matches: catalog,
        };
    }

    const leadingTrimmed = raw.replace(/^\s+/, '');
    if (!leadingTrimmed.startsWith('/')) {
        return {active: false, query: '', remainder: '', matches: []};
    }

    // Only activate slash completion on the first line before a newline is committed
    if (leadingTrimmed.includes('\n')) {
        return {active: false, query: '', remainder: '', matches: []};
    }

    const firstSpaceIdx = leadingTrimmed.search(/\s/);
    const token = (firstSpaceIdx >= 0 ? leadingTrimmed.slice(0, firstSpaceIdx) : leadingTrimmed).toLowerCase();
    const remainder = firstSpaceIdx >= 0 ? leadingTrimmed.slice(firstSpaceIdx + 1) : '';

    // Avoid hijacking Unix absolute file paths like `/home/user/a.txt` or `/etc/hosts`
    if (token.slice(1).includes('/')) {
        return {active: false, query: '', remainder: '', matches: []};
    }

    if (token === '/') {
        return {
            active: true,
            query: '/',
            remainder,
            matches: catalog,
        };
    }

    const needle = token.slice(1);
    const matches = catalog.filter(cmd => {
        if (cmd.command.toLowerCase().startsWith(token)) return true;
        if (cmd.aliases.some(a => a.toLowerCase().startsWith(token))) return true;
        if (cmd.title.toLowerCase().includes(needle)) return true;
        return false;
    });

    return {
        active: matches.length > 0,
        query: token,
        remainder,
        matches,
    };
}

/**
 * Applies a selected quick action or `/` command to the user's current input draft.
 * Strictly returns `autoSend: false` — NEVER auto-sends!
 */
export function applyQuickActionToDraft(actionItem, currentDraft = '') {
    const template = String(actionItem?.template ?? actionItem?.prompt ?? '');
    const rawDraft = String(currentDraft ?? '');
    const leadingTrimmed = rawDraft.replace(/^\s+/, '');

    if (!template) {
        return {
            text: rawDraft,
            cursorPosition: -1,
            autoSend: false,
        };
    }

    // Case 1: Draft starts with a slash token (`/tr`, `/翻译`, `/explain foo`) -> replace slash token and keep remainder!
    if (leadingTrimmed.startsWith('/') && !leadingTrimmed.slice(1).split(/\s/)[0].includes('/')) {
        const firstSpaceIdx = leadingTrimmed.search(/\s/);
        const remainder = firstSpaceIdx >= 0 ? leadingTrimmed.slice(firstSpaceIdx + 1).trim() : '';
        if (remainder) {
            const sep = template.endsWith('\n') || template.endsWith(' ') ? '' : '\n';
            return {
                text: `${template}${sep}${remainder}`,
                cursorPosition: -1,
                autoSend: false,
            };
        }
        return {
            text: template,
            cursorPosition: -1,
            autoSend: false,
        };
    }

    // Case 2: User already typed non-empty draft text and triggered a `/` template or chip ->
    // prepend template cleanly instead of destroying their draft!
    const cleanExisting = rawDraft.trim();
    if (cleanExisting && cleanExisting !== template.trim()) {
        const sep = template.endsWith('\n') || template.endsWith(' ') ? '' : '\n';
        return {
            text: `${template}${sep}${cleanExisting}`,
            cursorPosition: -1,
            autoSend: false,
        };
    }

    return {
        text: template,
        cursorPosition: -1,
        autoSend: false,
    };
}
