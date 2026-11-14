'use strict';

const readline = require('node:readline');

const pendingRequests = new Map();
const alwaysAllowedTools = new Set(
    String(process.env.QUICK_CHAT_AUTO_APPROVE_TOOLS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
);

let rl = null;

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

        if (msg.alwaysAllow && entry.req.toolName) {
            alwaysAllowedTools.add(entry.req.toolName);
        }

        const allow = msg.decision === 'allow';
        entry.settle({
            decision: allow ? 'allow' : 'deny',
            reason: allow
                ? (msg.alwaysAllow ? '用户在随问中选择始终允许' : '用户在随问中批准执行')
                : '用户在随问中拒绝了该工具调用',
            ...(allow && msg.alwaysAllow && Array.isArray(entry.req.suggestedPermissionUpdates)
                ? {permissionUpdates: entry.req.suggestedPermissionUpdates}
                : {}),
            resolvedAt: new Date(),
        });

        if (allow && msg.alwaysAllow && entry.req.toolName) {
            for (const [otherId, otherEntry] of Array.from(pendingRequests.entries())) {
                if (otherEntry.req?.toolName === entry.req.toolName) {
                    pendingRequests.delete(otherId);
                    otherEntry.settle({
                        decision: 'allow',
                        reason: '用户在随问中选择始终允许',
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

function handlePermissionRequest(req, opts = {}) {
    if (req?.toolName && alwaysAllowedTools.has(req.toolName)) {
        opts?.claimResponse?.();
        return Promise.resolve({
            decision: 'allow',
            reason: 'Auto-approved by QuickChat session rule',
            ...(Array.isArray(req.suggestedPermissionUpdates)
                ? {permissionUpdates: req.suggestedPermissionUpdates}
                : {}),
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

    pendingRequests.set(req.requestId, {req, opts, settle});
    updateStdinRef();

    try {
        process.stdout.write(JSON.stringify({
            type: 'quickchat.permission_requested',
            sessionId: req.sessionId || '',
            payload: {
                requestId: req.requestId,
                toolCallId: req.toolCallId || '',
                toolName: req.toolName || '工具',
                riskLevel: req.riskLevel || 'medium',
                reason: req.reason || '',
                summary: summarizeInput(req.toolName, req.input),
                input: req.input || {},
            },
        }) + '\n');
    } catch (_) {}

    return promise;
}

function patchDenyPermissionBroker(BrokerClass) {
    if (!BrokerClass || !BrokerClass.prototype || BrokerClass.prototype.__qcPatched) return;
    BrokerClass.prototype.__qcPatched = true;
    BrokerClass.prototype.requestPermission = function (req, opts = {}) {
        return handlePermissionRequest(req, opts);
    };
}

const origDefineProperty = Object.defineProperty;
Object.defineProperty = function (target, prop, desc) {
    const res = origDefineProperty.call(this, target, prop, desc);
    if (prop === 'name' && desc && typeof target === 'function') {
        if (desc.value === 'DenyPermissionBroker' && target.prototype) {
            patchDenyPermissionBroker(target);
        }
    }
    return res;
};
