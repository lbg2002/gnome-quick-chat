// Pure-JS Redacted Runtime Diagnostics Builder (Stage F7).
// Produces a concise, secret-free diagnostic snapshot & copyable report covering:
//   - Backend engine & CLI version
//   - Active provider & resolved model
//   - Effective permission mode & capability matrix
//   - ZCode bridge handshake verification status
//   - DateMenu mount mode & last connection error
//   - SessionStore persistence status
// Strictly whitelist-only: NEVER includes prompts, conversation messages, or raw API keys/credentials!

import {redactSensitiveText} from '../runtime/sseParser.js';

function scrubHomeAndSecrets(value, {homeDir = '', apiKey = '', maxChars = 240} = {}) {
    let str = String(value ?? '').trim();
    if (!str) return '';
    str = redactSensitiveText(str, {apiKey, maxChars: maxChars * 2});
    // Scrub URL userinfo credentials (`https://user:pass@host` -> `https://[REDACTED]@host`)
    str = str.replace(/\b(https?:\/\/)([^/\s:@]+(?::[^/\s@]*)?)@/gi, '$1[REDACTED]@');
    // Scrub common query token parameters (`?api_key=...`, `&token=...`, `&key=...`)
    str = str.replace(/([?&](?:api_key|apikey|token|access_token|secret|key)=)[^&\s]+/gi, '$1[REDACTED]');
    // Replace exact home directory path with `~` so user's OS login name isn't leaked when pasting bug reports
    const cleanHome = String(homeDir || '').replace(/\/+$/, '');
    if (cleanHome && cleanHome.length > 1) {
        str = str.split(cleanHome).join('~');
    }
    // Also scrub generic `/home/<username>/` paths
    str = str.replace(/\/home\/[A-Za-z0-9._-]+\//g, '~/');
    if (str.length > maxChars) {
        str = `${str.slice(0, maxChars)}…`;
    }
    return str;
}

export function formatCapabilitiesLine(caps = null, effectiveMode = '') {
    if (!caps || typeof caps !== 'object') {
        return effectiveMode ? `模式: ${effectiveMode}` : '未探测';
    }
    const items = [
        `模式: ${effectiveMode || 'readonly'}`,
        `工具调用: ${caps.supportsTools ? '支持' : '禁用'}`,
        `交互审批: ${caps.supportsApproval ? '支持' : '不支持'}`,
        `交互提问: ${(caps.interactiveQuestions ?? caps.supportsAskUser) ? '支持' : '不支持'}`,
        `思考强度: ${(caps.supportsThinking ?? caps.supportsReasoningEffort) ? '支持' : '不支持'}`,
    ];
    return items.join(' · ');
}

/**
 * Sanitizes a raw diagnostic object into a strict whitelist snapshot safe for GSettings or clipboard export.
 */
export function sanitizeDiagnosticSnapshot(raw = {}, {homeDir = '', apiKey = ''} = {}) {
    const opts = {homeDir, apiKey};
    const configuredBackend = scrubHomeAndSecrets(raw.configuredBackend || 'auto', {...opts, maxChars: 32});
    const effectiveBackend = scrubHomeAndSecrets(raw.effectiveBackend || 'unconfigured', {...opts, maxChars: 32});
    const cliVersion = scrubHomeAndSecrets(raw.cliVersion || '', {...opts, maxChars: 120});
    const activeProvider = scrubHomeAndSecrets(raw.activeProvider || '', {...opts, maxChars: 80});
    const activeModel = scrubHomeAndSecrets(raw.activeModel || '', {...opts, maxChars: 120});
    const effectiveMode = scrubHomeAndSecrets(raw.effectiveMode || '', {...opts, maxChars: 32});
    const capabilitySummary = scrubHomeAndSecrets(
        raw.capabilitySummary || formatCapabilitiesLine(raw.capabilities, effectiveMode),
        {...opts, maxChars: 200}
    );
    const bridgeHandshake = scrubHomeAndSecrets(raw.bridgeHandshake || '', {...opts, maxChars: 180});
    const mountMode = scrubHomeAndSecrets(raw.mountMode || '', {...opts, maxChars: 64});
    const lastConnectionError = scrubHomeAndSecrets(raw.lastConnectionError || '', {...opts, maxChars: 240});
    const sessionSaveStatus = scrubHomeAndSecrets(raw.sessionSaveStatus || '', {...opts, maxChars: 200});
    const endpointSecurityNote = scrubHomeAndSecrets(raw.endpointSecurityNote || '', {...opts, maxChars: 180});

    return {
        updatedAt: raw.updatedAt ? String(raw.updatedAt).slice(0, 40) : new Date().toISOString(),
        configuredBackend,
        effectiveBackend,
        cliVersion: cliVersion || (effectiveBackend === 'openai' ? 'HTTP/SSE (Soup 3.0)' : '未获取'),
        activeProvider: activeProvider || (effectiveBackend === 'openai' ? '自定义端点' : '默认'),
        activeModel: activeModel || '默认（待首次解析）',
        effectiveMode: effectiveMode || 'readonly',
        capabilitySummary,
        bridgeHandshake: bridgeHandshake || (
            effectiveBackend === 'zcode'
                ? '待任务启动时验证握手'
                : '不适用（当前非 ZCode 后端）'
        ),
        mountMode: mountMode || 'datemenu',
        lastConnectionError: lastConnectionError || '无',
        sessionSaveStatus: sessionSaveStatus || '正常',
        endpointSecurityNote,
    };
}

export function parseStoredDiagnosticSnapshot(rawJson = '', {homeDir = ''} = {}) {
    const trimmed = String(rawJson || '').trim();
    if (!trimmed) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object') return null;
        return sanitizeDiagnosticSnapshot(parsed, {homeDir});
    } catch (_) {
        return null;
    }
}

export function formatRedactedDiagnosticsText(rawOrSanitized = {}, {
    extensionVersion = '',
    gnomeShellHint = 'GNOME Shell 50',
    homeDir = '',
    apiKey = '',
} = {}) {
    const snap = sanitizeDiagnosticSnapshot(rawOrSanitized, {homeDir, apiKey});
    const lines = [
        `Quick Chat（随问）脱敏诊断报告${extensionVersion ? ` v${extensionVersion}` : ''}`,
        `生成时间: ${snap.updatedAt}`,
        `运行环境: ${gnomeShellHint}`,
        `后端配置: ${snap.configuredBackend} -> 实际生效: ${snap.effectiveBackend}`,
        `后端版本: ${snap.cliVersion}`,
        `生效模型: ${snap.activeModel} (Provider: ${snap.activeProvider})`,
        `权限能力: ${snap.capabilitySummary}`,
        `桥接握手: ${snap.bridgeHandshake}`,
        `面板挂载: ${snap.mountMode}`,
        `连接错误: ${snap.lastConnectionError}`,
        `会话保存状态: ${snap.sessionSaveStatus}`,
        `会话存储: ${snap.sessionSaveStatus}`,
    ];
    if (snap.endpointSecurityNote) {
        lines.push(`端点安全: ${snap.endpointSecurityNote}`);
    }
    return lines.join('\n');
}

export const formatDiagnosticReportText = formatRedactedDiagnosticsText;

/**
 * Derives a clear, non-overlapping runtime status presentation (Stage R11.2):
 * Explicitly distinguishes:
 *  - `'sending'` (`发送中`)
 *  - `'waiting_approval'` (`等待审批 / 等待回答`)
 *  - `'executing'` (`执行中 / 生成中`)
 *  - `'network_interrupted'` (`网络或流中断`)
 *  - `'save_failed'` (`会话保存失败`)
 *  - `'ready'` (`就绪`)
 */
export function deriveRuntimeStatusIndicator({
    phase = '',
    busy = false,
    turnState = '',
    hasPendingApproval = false,
    toolName = '',
    pendingToolName = '',
    activeToolName = '',
    isQuestion = false,
    pendingIsQuestion = false,
    questionHint = '',
    idleLabel = '随问',
    errorMessage = '',
    connectionError = '',
    saveWarning = '',
    isNetworkInterrupted = false,
    usage = null,
    finishReason = '',
} = {}) {
    const cleanErr = String(errorMessage || connectionError || '').trim();
    const cleanSaveWarn = String(saveWarning || '').trim();
    const effectiveToolName = String(toolName || pendingToolName || activeToolName || '').trim();
    const effectiveIsQuestion = Boolean(isQuestion || pendingIsQuestion);
    const networkInterrupted = Boolean(
        isNetworkInterrupted ||
        /network|timeout|connection|reset|stream|eof|broken pipe|网络|连接|中断|超时/i.test(cleanErr)
    );

    let cleanPhase = String(phase || '').trim();
    if (!cleanPhase) {
        if (hasPendingApproval) {
            cleanPhase = 'waiting_approval';
        } else if (busy) {
            cleanPhase = (turnState === 'starting' || turnState === 'sending') ? 'sending' : 'executing';
        } else if (cleanSaveWarn && !cleanErr) {
            cleanPhase = 'save_failed';
        } else if (cleanErr && networkInterrupted) {
            cleanPhase = 'network_interrupted';
        } else if (cleanErr) {
            cleanPhase = 'error';
        } else {
            cleanPhase = 'ready';
        }
    }

    if (cleanPhase === 'sending') {
        return {
            state: 'busy',
            dotState: 'busy',
            phase: 'sending',
            text: '⏳ 正在发送请求…',
            showReconnect: false,
            showRetrySave: false,
        };
    }

    if (cleanPhase === 'waiting_approval') {
        const text = effectiveIsQuestion
            ? (questionHint ? `💬 等待回答：${questionHint}` : '💬 等待您回答问题…')
            : `⚠️ 等待您审批工具：${effectiveToolName || '工具'}`;
        return {
            state: 'approval',
            dotState: 'approval',
            phase: 'waiting_approval',
            text,
            showReconnect: false,
            showRetrySave: false,
        };
    }

    if (cleanPhase === 'executing') {
        const text = effectiveToolName
            ? (effectiveIsQuestion ? '💬 正在准备交互式提问…' : `🔧 正在执行工具：${effectiveToolName}`)
            : '正在生成回答…';
        return {
            state: 'busy',
            dotState: 'busy',
            phase: 'executing',
            text,
            showReconnect: false,
            showRetrySave: false,
        };
    }

    if (cleanPhase === 'save_failed' || (cleanPhase === 'ready' && cleanSaveWarn)) {
        return {
            state: 'error',
            dotState: 'error',
            phase: 'save_failed',
            text: `💾 会话保存失败：${cleanSaveWarn || cleanErr || '历史尚未落盘，可点击重试保存'}`,
            showReconnect: false,
            showRetrySave: true,
        };
    }

    if (cleanPhase === 'network_interrupted' || (cleanErr && networkInterrupted)) {
        return {
            state: 'error',
            dotState: 'error',
            phase: 'network_interrupted',
            text: `🌐 网络中断或流中断：${cleanErr || '回答可能不完整，可点击重试或继续生成'}`,
            showReconnect: true,
            showRetrySave: false,
        };
    }

    if (cleanPhase === 'error' || (cleanErr && cleanPhase !== 'ready')) {
        return {
            state: 'error',
            dotState: 'error',
            phase: 'error',
            text: cleanErr.startsWith('错误：') ? cleanErr : `错误：${cleanErr || '执行失败'}`,
            showReconnect: true,
            showRetrySave: false,
        };
    }

    const usageHint = usage?.totalTokens ? ` · ${usage.totalTokens} tokens` : '';
    if (finishReason === 'length') {
        return {
            state: 'ready',
            dotState: 'ready',
            phase: 'ready',
            text: `⚠️ 输出达长度上限 (length)${usageHint} · 可点击继续生成`,
            showReconnect: false,
            showRetrySave: false,
        };
    }

    return {
        state: 'ready',
        dotState: 'ready',
        phase: 'ready',
        text: `${idleLabel || '随问'}${usageHint}`,
        showReconnect: false,
        showRetrySave: false,
    };
}

