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
        `会话存储: ${snap.sessionSaveStatus}`,
    ];
    if (snap.endpointSecurityNote) {
        lines.push(`端点安全: ${snap.endpointSecurityNote}`);
    }
    return lines.join('\n');
}
