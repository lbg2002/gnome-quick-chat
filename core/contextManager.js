/**
 * Pure-JS unified 3-backend session context & token budget manager (Stage C2, zero GJS dependencies).
 *
 * Responsibilities:
 * 1. Bind `remoteSessionId` strictly to `backend + provider/model/endpoint + workspace + effectiveMode`.
 * 2. Sanitize stored messages before sending to cloud APIs or cross-backend handoffs:
 *    never leak hidden `thinking`, raw `toolResult` payloads, or UI `⚠️` error banners into model prompts.
 * 3. Select prior history strictly by **complete conversation turns** (`user` + `assistant`),
 *    guaranteeing space for `systemPrompt`, `currentPrompt`, and `reserveOutputTokens`.
 * 4. Explicitly detect oversized current prompts (`preparePromptWithinBudget`) instead of silently dropping text.
 */

import {parseUrlPortable} from './permissionPolicy.js';

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 32000;
export const DEFAULT_RESERVE_OUTPUT_TOKENS = 4096;
export const DEFAULT_MAX_HISTORY_MESSAGES = 24;
export const DEFAULT_MAX_HISTORY_CHARS = 28000;
export const DEFAULT_MAX_SINGLE_PROMPT_CHARS = 64000;

const INTERNAL_ENV_HEADER_RE = /^\[Ubuntu GNOME 用户目录环境：[^\n]*\]\n/;
const UI_ERROR_BANNER_PREFIX_RE = /^(?:⚠️\s*(?:错误|请求失败|连接失败|执行失败|历史未保存)|\[网络中断|\[连接异常)/;

export function stripInternalPromptHeaders(text) {
    if (typeof text !== 'string' || !text) return '';
    return text.replace(INTERNAL_ENV_HEADER_RE, '');
}

/**
 * Extracts strictly user-visible / model-safe text from a stored message record,
 * deliberately excluding hidden `thinking` blocks and `toolResult` payloads.
 */
export function extractCleanMessageText(message) {
    if (!message || typeof message !== 'object') return '';
    if (message.role === 'toolResult') return '';

    let rawText = '';
    if (typeof message.content === 'string') {
        rawText = message.content;
    } else if (Array.isArray(message.content)) {
        rawText = message.content
            .filter(item => item && item.type === 'text' && typeof item.text === 'string')
            .map(item => item.text)
            .join('');
    }

    const stripped = stripInternalPromptHeaders(rawText).trim();
    if (!stripped) return '';

    // Never feed UI-only error banners back into model context!
    if (message.role === 'assistant') {
        if (message.status === 'failed' && !rawText.trim()) return '';
        if (UI_ERROR_BANNER_PREFIX_RE.test(stripped) && message.errorMessage) return '';
    }
    return stripped;
}

/**
 * Conservative token estimator for mixed Chinese/English technical text when backend tokenizer
 * metadata is unavailable:
 * - CJK / non-ASCII code points: ~1 token per character (conservative upper bound)
 * - ASCII characters: ~1 token per 3.5 characters
 * - Per-message framing overhead: +6 tokens
 */
export function estimateTextTokens(text) {
    const str = String(text ?? '');
    if (!str) return 0;
    let asciiCount = 0;
    let nonAsciiCount = 0;
    for (let i = 0; i < str.length; i++) {
        if (str.charCodeAt(i) <= 0x7f) {
            asciiCount++;
        } else {
            nonAsciiCount++;
        }
    }
    return nonAsciiCount + Math.ceil(asciiCount / 3.5);
}

export function estimateMessageTokens(msg) {
    if (!msg) return 0;
    return 6 + estimateTextTokens(msg.content || msg.text || '');
}

function normalizeEndpointForSignature(rawBaseUrl = '') {
    const trimmed = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    try {
        const u = parseUrlPortable(trimmed);
        const portPart = u.port ? `:${u.port}` : '';
        const cleanPath = u.pathname.replace(/\/chat\/completions$/i, '').replace(/\/models$/i, '').replace(/\/+$/, '');
        return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${portPart}${cleanPath}`;
    } catch (_) {
        return trimmed.toLowerCase();
    }
}

/**
 * Builds a deterministic runtime context signature binding all execution-critical fields:
 * `backend`, `provider`, `model`, `endpoint`, `workspace`, and `effectiveMode`.
 */
export function buildRuntimeContextSignature(backend, config = {}) {
    const cleanBackend = String(backend || '').trim().toLowerCase();
    if (!cleanBackend || cleanBackend === 'unconfigured') return '';

    const workspace = String(config?.resolvedWorkspace || config?.workspace || '').trim().replace(/\/+$/, '');
    const mode = String(config?.effectiveMode || config?.mode || 'readonly').trim().toLowerCase();

    if (cleanBackend === 'openai') {
        const endpoint = normalizeEndpointForSignature(config?.openaiBaseUrl || '');
        const model = String(config?.openaiModel || config?.model || '').trim();
        return `openai|ep=${endpoint}|model=${model}`;
    }

    const provider = String(config?.resolvedProvider || config?.provider || '').trim();
    const model = String(config?.resolvedModel || config?.model || '').trim();
    return `${cleanBackend}|prov=${provider}|model=${model}|ws=${workspace}|mode=${mode}`;
}

/**
 * Sanitizes stored history into clean `{role: 'user'|'assistant', content, id, status}` entries,
 * excluding tool outputs, hidden thinking, empty messages, and pure error banners.
 */
export function sanitizeMessagesForModelContext(messages) {
    if (!Array.isArray(messages)) return [];
    const clean = [];
    for (const msg of messages) {
        if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
        // Skip empty failed turns or cancelled turns with zero text
        if (msg.role === 'assistant' && msg.status === 'failed' && !extractCleanMessageText(msg)) {
            continue;
        }
        const content = extractCleanMessageText(msg);
        if (!content) continue;
        clean.push({
            role: msg.role,
            content,
            ...(msg.id ? {id: msg.id} : {}),
            ...(msg.status ? {status: msg.status} : {}),
        });
    }
    return clean;
}

/**
 * Groups sanitized `{role, content}` messages into complete turns (`[user, ...assistant]`).
 * Trailing standalone `user` message (the current prompt already appended to store) is kept as its own group.
 */
export function groupContextTurns(sanitizedMessages) {
    const groups = [];
    let current = [];

    for (const msg of sanitizedMessages) {
        if (msg.role === 'user') {
            if (current.length > 0) {
                groups.push(current);
            }
            current = [msg];
        } else if (msg.role === 'assistant') {
            if (current.length === 0) {
                // Drop leading orphan assistant reply whose user prompt was already evicted,
                // preventing invalid assistant-first message sequences!
                continue;
            }
            current.push(msg);
        }
    }
    if (current.length > 0) {
        groups.push(current);
    }
    return groups;
}

/**
 * Validates and bounds the user's current prompt against single-prompt and token-window limits.
 * Never silently drops user input: returns `rejected: true` or `truncated: true` with an explicit Chinese notice.
 */
export function preparePromptWithinBudget(rawPromptText, {
    systemPrompt = '',
    contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
    reserveOutputTokens = DEFAULT_RESERVE_OUTPUT_TOKENS,
    maxPromptChars = DEFAULT_MAX_SINGLE_PROMPT_CHARS,
    allowTruncate = false,
} = {}) {
    const text = String(rawPromptText ?? '');
    if (!text.trim()) {
        return {
            ok: false,
            rejected: true,
            truncated: false,
            promptText: '',
            warning: '输入内容不能为空',
        };
    }

    const sysTokens = estimateTextTokens(systemPrompt) + 8;
    const availableInputTokens = Math.max(512, contextWindowTokens - reserveOutputTokens - sysTokens);
    const promptTokens = estimateTextTokens(text) + 6;
    const exceedsChars = text.length > maxPromptChars;
    const exceedsTokens = promptTokens > availableInputTokens;

    if (!exceedsChars && !exceedsTokens) {
        return {
            ok: true,
            rejected: false,
            truncated: false,
            promptText: text,
            estimatedTokens: promptTokens,
            warning: '',
        };
    }

    if (!allowTruncate) {
        return {
            ok: false,
            rejected: true,
            truncated: false,
            promptText: text,
            estimatedTokens: promptTokens,
            warning: exceedsChars
                ? `当前提问长度（${text.length} 字符）超过单次上限（${maxPromptChars} 字符），请精简或分段提问`
                : `当前提问预计占用约 ${promptTokens} tokens，超过模型输入窗口上限（可用约 ${availableInputTokens} tokens），请精简内容后重试`,
        };
    }

    const charRatio = exceedsChars ? maxPromptChars / text.length : 1;
    const tokenRatio = exceedsTokens ? (availableInputTokens * 0.92) / promptTokens : 1;
    const ratio = Math.max(0.05, Math.min(charRatio, tokenRatio));
    const keepLen = Math.max(128, Math.floor(text.length * ratio));
    const truncatedText = `${text.slice(0, keepLen)}\n\n[注：原始输入过长，已按上下文窗口上限保留前 ${keepLen} 字符]`;

    return {
        ok: true,
        rejected: false,
        truncated: true,
        promptText: truncatedText,
        estimatedTokens: estimateTextTokens(truncatedText) + 6,
        warning: `当前提问超出上下文预算，已保留前 ${keepLen} 字符`,
    };
}

/**
 * Selects complete conversation turns within message, character, and token budgets,
 * guaranteeing room for `systemPrompt`, `currentPrompt` (if passed separately), and `reserveOutputTokens`.
 *
 * Compatible with both:
 *   `buildBudgetedContextMessages(messages, maxMessages, maxChars)`
 * and:
 *   `buildBudgetedContextMessages(messages, {maxMessages, maxChars, systemPrompt, currentPrompt, contextWindowTokens, reserveOutputTokens})`
 */
export function buildBudgetedContextMessages(messages, optionsOrMaxMessages = DEFAULT_MAX_HISTORY_MESSAGES, legacyMaxChars = DEFAULT_MAX_HISTORY_CHARS) {
    const opts = (optionsOrMaxMessages && typeof optionsOrMaxMessages === 'object')
        ? optionsOrMaxMessages
        : {
            maxMessages: Number(optionsOrMaxMessages) || DEFAULT_MAX_HISTORY_MESSAGES,
            maxChars: Number(legacyMaxChars) || DEFAULT_MAX_HISTORY_CHARS,
        };

    const maxMessages = Math.max(1, Number(opts.maxMessages ?? DEFAULT_MAX_HISTORY_MESSAGES));
    const maxChars = Math.max(128, Number(opts.maxChars ?? DEFAULT_MAX_HISTORY_CHARS));
    const contextWindowTokens = Math.max(1024, Number(opts.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS));
    const reserveOutputTokens = Math.max(256, Number(opts.reserveOutputTokens ?? DEFAULT_RESERVE_OUTPUT_TOKENS));
    const systemTokens = opts.systemPrompt ? estimateTextTokens(opts.systemPrompt) + 8 : 0;
    const separateCurrentTokens = opts.currentPrompt ? estimateTextTokens(opts.currentPrompt) + 8 : 0;
    const separateCurrentChars = opts.currentPrompt ? String(opts.currentPrompt).length : 0;

    const maxHistoryTokens = Math.max(256, contextWindowTokens - reserveOutputTokens - systemTokens - separateCurrentTokens);
    const maxHistoryChars = Math.max(128, maxChars - separateCurrentChars);

    const sanitized = sanitizeMessagesForModelContext(messages);
    if (!sanitized.length) return [];

    const turnGroups = groupContextTurns(sanitized);
    if (!turnGroups.length) return [];

    const selectedGroupsReversed = [];
    let usedMessages = 0;
    let usedChars = 0;
    let usedTokens = 0;

    const hasSeparateCurrentPrompt = Boolean(opts.currentPrompt && String(opts.currentPrompt).trim());
    const cleanSeparateCurrent = hasSeparateCurrentPrompt
        ? stripInternalPromptHeaders(String(opts.currentPrompt)).trim()
        : '';

    for (let i = turnGroups.length - 1; i >= 0; i--) {
        const group = turnGroups[i];
        const isNewestTurn = i === turnGroups.length - 1;
        const hasAssistantReply = group.some(m => m.role === 'assistant');

        // R3: If a prior turn group has NO assistant reply (e.g. CLI spawn failed, request failed,
        // or turn was cancelled before any output), do NOT re-inject the unanswered user prompt
        // into subsequent turns (prevents both duplicate prompt injection on retry and unintended
        // re-execution of side-effecting requests).
        if (!hasAssistantReply && (hasSeparateCurrentPrompt || !isNewestTurn)) {
            continue;
        }
        if (
            hasSeparateCurrentPrompt &&
            group.length === 1 &&
            group[0].role === 'user' &&
            stripInternalPromptHeaders(group[0].content).trim() === cleanSeparateCurrent
        ) {
            continue;
        }

        const groupMsgCount = group.length;
        const groupChars = group.reduce((sum, m) => sum + m.content.length, 0);
        const groupTokens = group.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

        if (
            usedMessages + groupMsgCount <= maxMessages &&
            usedChars + groupChars <= maxHistoryChars &&
            usedTokens + groupTokens <= maxHistoryTokens
        ) {
            selectedGroupsReversed.push(group.map(m => ({
                role: m.role,
                content: m.content,
                ...(m.status ? {status: m.status} : {}),
            })));
            usedMessages += groupMsgCount;
            usedChars += groupChars;
            usedTokens += groupTokens;
            continue;
        }

        // If even the newest group exceeds the budget AND it is the trailing current user message,
        // bound it explicitly instead of blowing past the ceiling or returning empty context!
        if (!hasSeparateCurrentPrompt && isNewestTurn && selectedGroupsReversed.length === 0) {
            const latestUser = group[0];
            if (latestUser && latestUser.role === 'user') {
                const boundedContent = latestUser.content.length > maxHistoryChars
                    ? `${latestUser.content.slice(0, Math.max(64, maxHistoryChars - 36))}\n[内容过长已按预算截断]`
                    : latestUser.content;
                selectedGroupsReversed.push([{role: 'user', content: boundedContent}]);
            }
        }
        break;
    }

    return selectedGroupsReversed.reverse().flat().map(m => ({role: m.role, content: m.content}));
}

export function buildCrossBackendPromptWithContext(historyBeforePrompt, newPromptText, maxCharsOrOpts = 6000) {
    const opts = typeof maxCharsOrOpts === 'object' && maxCharsOrOpts !== null
        ? {...maxCharsOrOpts, currentPrompt: newPromptText}
        : {
            maxMessages: 10,
            maxChars: Number(maxCharsOrOpts) + String(newPromptText || '').length,
            currentPrompt: newPromptText,
        };

    const prior = buildBudgetedContextMessages(historyBeforePrompt, opts);
    if (!prior.length) return newPromptText;

    const lines = prior.map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`);
    return [
        '[以下是当前随问会话的前序上下文（仅供背景参考，请勿自动重复执行前序已取消或未完成的副作用操作），请自然承接回答最新问题]',
        ...lines,
        '',
        '[最新问题]',
        newPromptText,
    ].join('\n');
}
