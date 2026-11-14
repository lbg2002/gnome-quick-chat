'use strict';

const readline = require('node:readline');

const PROTOCOL_VERSION = 1;
const DESTRUCTIVE_SHELL_RE = /(?:^|[;&|]\s*)(?:sudo|su|rm\s+-[a-zA-Z]*[rf]|mkfs|dd\s+|fdisk|parted|shutdown|reboot|chmod\s+-R|chown\s+-R|>\s*\/etc\/)/i;

const pendingRequests = new Map();
const approvedScopes = new Set();

try {
    const rawScopes = process.env.QUICK_CHAT_APPROVED_SCOPES || '';
    if (rawScopes.startsWith('[')) {
        for (const s of JSON.parse(rawScopes)) {
            if (typeof s === 'string' && s.trim()) approvedScopes.add(s.trim());
        }
    }
} catch (_) {}

let rl = null;
let brokerPatched = false;
let readyEmitted = false;

function summarizeInput(toolName, input) {
    if (!input || typeof input !== 'object') return String(input ?? '');
    if (typeof input.command === 'string') return input.command;
    if (typeof input.url === 'string') return input.url;
    if (typeof input.file_path === 'string') return input.file_path;
    if (typeof input.path === 'string') return input.path;
    if (typeof input.pattern === 'string') return input.pattern;
    if (typeof input.query === 'string') return input.query;
    if (typeof input.title === 'string') return input.title;
    try {
        return JSON.stringify(input).slice(0, 200);
    } catch (_) {
        return '';
    }
}

function computeBridgeScope(toolName, summary) {
    const tool = String(toolName || '工具').trim();
    const cleanSummary = String(summary || '').trim();
    const lower = tool.toLowerCase();
    const isShell = lower === 'bash' || lower === 'sh' || lower.includes('shell') || lower.includes('exec') || lower.includes('repl');
    const isFileMutate = lower === 'write' || lower === 'edit' || lower === 'multiedit' || lower === 'notebookedit' || lower === 'delete';

    if (isShell) {
        if (!cleanSummary || DESTRUCTIVE_SHELL_RE.test(cleanSummary)) {
            return {scopeKey: '', allowSessionRule: false, sessionRuleLabel: ''};
        }
        const normalizedCmd = cleanSummary.replace(/\s+/g, ' ').slice(0, 120);
        return {
            scopeKey: `${tool}:cmd:${normalizedCmd}`,
            allowSessionRule: true,
            sessionRuleLabel: '✓ 本次会话允许该命令',
        };
    }

    if (isFileMutate) {
        if (!cleanSummary || cleanSummary.startsWith('/etc/') || cleanSummary.startsWith('/usr/')) {
            return {scopeKey: '', allowSessionRule: false, sessionRuleLabel: ''};
        }
        return {
            scopeKey: `${tool}:file:${cleanSummary}`,
            allowSessionRule: true,
            sessionRuleLabel: '✓ 本次会话允许修改该文件',
        };
    }

    if (lower === 'webfetch' && cleanSummary) {
        const urlMatch = /^(?:url:\s*)?https?:\/\/([^/?#:\s]+)/i.exec(cleanSummary);
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

function updateStdinRef() {
    try {
        if (pendingRequests.size > 0) {
            process.stdin.resume();
            process.stdin.ref?.();
        } else {
            process.stdin.pause();
            process.stdin.unref?.();
        }
    } catch (_) {}
}

function ensureStdinListener() {
    if (rl) {
        updateStdinRef();
        return;
    }
    rl = readline.createInterface({
        input: process.stdin,
        crlfDelay: Infinity,
        terminal: false,
    });
    rl.on('line', line => {
        const trimmed = String(line || '').trim();
        if (!trimmed.startsWith('{')) return;
        let msg;
        try {
            msg = JSON.parse(trimmed);
        } catch (_) {
            return;
        }
        if (msg.type !== 'permission_response') return;

        const targetId = msg.requestId;
        const entry = targetId
            ? pendingRequests.get(targetId)
            : pendingRequests.values().next().value;
        if (!entry) return;

        pendingRequests.delete(entry.req.requestId);
        updateStdinRef();

        const allow = msg.decision === 'allow';
        const effectiveScopeKey = entry.scope.allowSessionRule ? entry.scope.scopeKey : '';

        if (allow && msg.alwaysAllow && effectiveScopeKey) {
            approvedScopes.add(effectiveScopeKey);
        }

        entry.settle({
            decision: allow ? 'allow' : 'deny',
            reason: allow
                ? (msg.alwaysAllow && effectiveScopeKey ? '用户在随问中授予范围许可' : '用户在随问中批准执行')
                : '用户在随问中拒绝了该工具调用',
            resolvedAt: new Date(),
        });

        // Only auto-settle other pending requests if they match the exact same scoped rule!
        if (allow && msg.alwaysAllow && effectiveScopeKey) {
            for (const [otherId, otherEntry] of Array.from(pendingRequests.entries())) {
                if (otherEntry.scope?.allowSessionRule && otherEntry.scope.scopeKey === effectiveScopeKey) {
                    pendingRequests.delete(otherId);
                    otherEntry.settle({
                        decision: 'allow',
                        reason: '用户在随问中授予同类范围许可',
                        resolvedAt: new Date(),
                    });
                }
            }
            updateStdinRef();
        }
    });
    rl.on('close', () => {
        for (const [id, entry] of pendingRequests.entries()) {
            pendingRequests.delete(id);
            entry.settle({
                decision: 'deny',
                reason: '输入流已关闭',
                resolvedAt: new Date(),
            });
        }
    });
    updateStdinRef();
}

function handlePermissionRequest(req, opts = {}) {
    const summary = summarizeInput(req?.toolName, req?.input);
    const scope = computeBridgeScope(req?.toolName, summary);

    if (scope.allowSessionRule && scope.scopeKey && approvedScopes.has(scope.scopeKey)) {
        opts?.claimResponse?.();
        return Promise.resolve({
            decision: 'allow',
            reason: `Auto-approved by QuickChat scoped rule (${scope.scopeKey})`,
            resolvedAt: new Date(),
        });
    }

    ensureStdinListener();

    let settled = false;
    let resolvePromise;
    const promise = new Promise(resolve => {
        resolvePromise = resolve;
    });

    const settle = result => {
        if (settled) return;
        settled = true;
        pendingRequests.delete(req.requestId);
        updateStdinRef();
        try {
            opts?.claimResponse?.();
        } catch (_) {}
        resolvePromise(result);
    };

    if (opts?.signal) {
        if (opts.signal.aborted) {
            settle({decision: 'deny', reason: 'Cancelled', resolvedAt: new Date()});
            return promise;
        }
        opts.signal.addEventListener('abort', () => {
            settle({decision: 'deny', reason: 'Cancelled', resolvedAt: new Date()});
        }, {once: true});
    }

    pendingRequests.set(req.requestId, {req, opts, scope, settle});
    updateStdinRef();

    try {
        process.stdout.write(JSON.stringify({
            type: 'quickchat.permission_requested',
            protocolVersion: PROTOCOL_VERSION,
            sessionId: req.sessionId || '',
            payload: {
                requestId: req.requestId,
                toolCallId: req.toolCallId || '',
                toolName: req.toolName || '工具',
                riskLevel: req.riskLevel || 'medium',
                reason: req.reason || '',
                summary,
                scopeKey: scope.scopeKey,
                allowSessionRule: scope.allowSessionRule,
                sessionRuleLabel: scope.sessionRuleLabel,
                input: req.input || {},
            },
        }) + '\n');
    } catch (_) {}

    return promise;
}

function emitBridgeReadyOnce() {
    if (readyEmitted) return;
    readyEmitted = true;
    try {
        process.stdout.write(JSON.stringify({
            type: 'quickchat.bridge_ready',
            protocolVersion: PROTOCOL_VERSION,
            patched: brokerPatched,
        }) + '\n');
    } catch (_) {}
}

function patchDenyPermissionBroker(BrokerClass, origDefineProp) {
    if (!BrokerClass || !BrokerClass.prototype || BrokerClass.prototype.__qcPatched) return;
    BrokerClass.prototype.__qcPatched = true;
    brokerPatched = true;
    BrokerClass.prototype.requestPermission = function (req, opts = {}) {
        return handlePermissionRequest(req, opts);
    };
    // Restore original Object.defineProperty immediately once target class is hooked
    if (origDefineProp && Object.defineProperty !== origDefineProp) {
        Object.defineProperty = origDefineProp;
    }
}

const isZCodeProcess = process.argv.some(arg => String(arg).includes('zcode'));
if (isZCodeProcess || process.env.QUICK_CHAT_FORCE_BRIDGE === '1') {
    const origDefineProperty = Object.defineProperty;
    Object.defineProperty = function (target, prop, desc) {
        const res = origDefineProperty.call(this, target, prop, desc);
        if (prop === 'name' && desc && typeof target === 'function') {
            if (desc.value === 'DenyPermissionBroker' && target.prototype) {
                patchDenyPermissionBroker(target, origDefineProperty);
            }
        }
        return res;
    };
    setImmediate(() => {
        if (Object.defineProperty !== origDefineProperty) {
            Object.defineProperty = origDefineProperty;
        }
        emitBridgeReadyOnce();
    });
}

module.exports = {
    PROTOCOL_VERSION,
    computeBridgeScope,
    summarizeInput,
};
