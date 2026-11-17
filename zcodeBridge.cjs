'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const vm = require('node:vm');

const PROTOCOL_VERSION = 1;
const BRIDGE_FAIL_EXIT_CODE = 78;
const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

function loadSharedPermissionPolicy({forceVmFallback = false} = {}) {
    const policyPath = path.join(__dirname, 'core', 'permissionPolicy.js');
    if (!forceVmFallback) {
        try {
            return require(policyPath);
        } catch (err) {
            if (!err || (err.code !== 'ERR_REQUIRE_ESM' && err.code !== 'ERR_UNKNOWN_FILE_EXTENSION')) {
                // Fall through to VM loader if available, otherwise fail closed below
            }
        }
    }

    try {
        const esmSource = fs.readFileSync(policyPath, 'utf8');
        const exportedNames = [];
        const cjsSource = esmSource
            .replace(/^export\s+const\s+([A-Za-z0-9_$]+)\s*=/gm, (_, name) => {
                exportedNames.push(name);
                return `const ${name} =`;
            })
            .replace(/^export\s+function\s+([A-Za-z0-9_$]+)\s*\(/gm, (_, name) => {
                exportedNames.push(name);
                return `function ${name}(`;
            }) +
            '\n' +
            exportedNames.map(n => `exports.${n} = ${n};`).join('\n');

        const sandbox = {
            exports: {},
            TextEncoder,
            Uint8Array,
            Uint32Array,
            DataView,
            URL,
            Set,
            Map,
            Math,
            Number,
            String,
            Boolean,
            Array,
            Object,
            JSON,
            RegExp,
        };
        vm.runInNewContext(cjsSource, sandbox, {filename: policyPath});
        if (typeof sandbox.exports.evaluatePermissionPolicy === 'function') {
            return sandbox.exports;
        }
    } catch (_) {}

    // Fail-closed fallback if policy module is unreadable: never grant session rules!
    return {
        isInteractiveQuestionTool(toolName, input, ruleId = '') {
            const lower = String(toolName || '').trim().toLowerCase();
            if (lower === 'askuserquestion' || ruleId === 'tool.userInteraction') return true;
            return Boolean(input && typeof input === 'object' && Array.isArray(input.questions) && input.questions.length > 0);
        },
        summarizeToolInput(toolName, input) {
            if (!input || typeof input !== 'object') return String(input ?? '');
            return String(input.command || input.url || input.file_path || input.path || '').slice(0, 200);
        },
        evaluatePermissionPolicy({toolName = '工具'} = {}) {
            return {
                toolName: String(toolName || '工具'),
                kind: 'unknown',
                operationLabel: '受限单次操作',
                riskLevel: 'high',
                riskLabel: '高风险',
                riskWarnings: ['权限策略模块未就绪，已降级为仅单次审批'],
                fullCommand: '',
                cwd: '',
                realCwd: '',
                displayPath: '',
                realPath: '',
                networkOrigin: '',
                targetMismatch: false,
                symlinkEscape: false,
                scopeKey: '',
                allowSessionRule: false,
                sessionRuleLabel: '',
            };
        },
    };
}

const sharedPolicy = loadSharedPermissionPolicy();

function createNodeFsEnv() {
    return {
        realpath(targetPath) {
            return fs.realpathSync(targetPath);
        },
        isSymlink(targetPath) {
            try {
                return fs.lstatSync(targetPath).isSymbolicLink();
            } catch (_) {
                return false;
            }
        },
        exists(targetPath) {
            try {
                return fs.existsSync(targetPath);
            } catch (_) {
                return false;
            }
        },
    };
}

function injectPromptFromFileIfConfigured(argv = process.argv, env = process.env) {
    const promptFile = String(env.QUICK_CHAT_PROMPT_FILE || '').trim();
    if (!promptFile) return false;
    delete env.QUICK_CHAT_PROMPT_FILE;

    try {
        const st = fs.lstatSync(promptFile);
        if (!st.isFile() || st.isSymbolicLink()) {
            try { fs.unlinkSync(promptFile); } catch (_) {}
            throw new Error('Prompt 临时文件不是普通私有文件');
        }
        const promptText = fs.readFileSync(promptFile, 'utf8');
        try { fs.unlinkSync(promptFile); } catch (_) {}

        for (let i = 0; i < argv.length; i++) {
            const arg = String(argv[i] || '');
            if (arg === '--prompt' && i + 1 < argv.length) {
                argv[i + 1] = promptText;
                return true;
            }
            if (arg.startsWith('--prompt=')) {
                argv[i] = `--prompt=${promptText}`;
                return true;
            }
        }
        argv.push(`--prompt=${promptText}`);
        return true;
    } catch (err) {
        try { fs.unlinkSync(promptFile); } catch (_) {}
        if (env.QUICK_CHAT_REQUIRE_PROMPT_FILE === '1') {
            try {
                process.stderr.write(`[Quick Chat Bridge] 读取 Prompt 文件失败: ${err.message}\n`);
            } catch (_) {}
            process.exit(BRIDGE_FAIL_EXIT_CODE);
        }
        return false;
    }
}

function isInteractiveQuestionRequest(toolName, input, ruleId = '') {
    return sharedPolicy.isInteractiveQuestionTool(toolName, input, ruleId);
}

function summarizeInput(toolName, input) {
    return sharedPolicy.summarizeToolInput(toolName, input);
}

function computeBridgeScope(toolName, summaryOrInput, context = {}) {
    const isObj = Boolean(summaryOrInput && typeof summaryOrInput === 'object');
    const fsEnv = context.fsEnv !== undefined ? context.fsEnv : createNodeFsEnv();
    return sharedPolicy.evaluatePermissionPolicy({
        toolName,
        input: isObj ? summaryOrInput : null,
        summary: isObj ? (context.summary || summarizeInput(toolName, summaryOrInput)) : String(summaryOrInput ?? ''),
        sessionId: context.sessionId ?? process.env.QUICK_CHAT_SESSION_ID ?? '',
        cwd: context.cwd ?? process.cwd(),
        workspace: context.workspace ?? process.env.QUICK_CHAT_WORKSPACE ?? '',
        homeDir: context.homeDir ?? os.homedir(),
        fsEnv,
        allowRepeatShellInSession: Boolean(
            context.allowRepeatShellInSession ?? (process.env.QUICK_CHAT_ALLOW_REPEAT_SHELL === '1')
        ),
        ruleId: context.ruleId || '',
        reportedRiskLevel: context.reportedRiskLevel || '',
    });
}

function buildBrokerResolution(entry, msg, validation = null) {
    const req = entry?.req || {};
    const scope = entry?.policy || entry?.scope || {scopeKey: '', allowSessionRule: false};
    const effectiveDecision = validation ? validation.decision : msg?.decision;
    const effectiveModifiedInput = validation ? validation.modifiedInput : msg?.modifiedInput;

    if (effectiveDecision === 'modify' && effectiveModifiedInput && typeof effectiveModifiedInput === 'object') {
        const ansObj = effectiveModifiedInput.answers;
        const hasNonEmptyAnswers = Boolean(
            ansObj && typeof ansObj === 'object' && Object.keys(ansObj).length > 0
        );
        const defaultReason = hasNonEmptyAnswers
            ? '用户在随问中提交了问题回答'
            : '用户选择交由 AI 自行判断';
        return {
            decision: 'modify',
            modifiedInput: effectiveModifiedInput,
            reason: typeof msg?.reason === 'string' && msg.reason
                ? msg.reason
                : defaultReason,
            resolvedAt: new Date(),
        };
    }

    // Defense-in-depth: AskUserQuestion requires `decision: "modify"` with `answers` object;
    // a plain `allow` without modifiedInput represents explicit "交由 AI 自行判断" (empty answers `{}`).
    if (effectiveDecision === 'allow' && isInteractiveQuestionRequest(req.toolName, req.input, req.ruleId)) {
        const fallbackModified = {
            questions: Array.isArray(req.input?.questions) ? req.input.questions : [],
            answers: {},
        };
        if (req.input?.metadata && typeof req.input.metadata === 'object') {
            const cleanMeta = {};
            if (typeof req.input.metadata.source === 'string') {
                cleanMeta.source = req.input.metadata.source;
            }
            fallbackModified.metadata = cleanMeta;
        }
        return {
            decision: 'modify',
            modifiedInput: fallbackModified,
            reason: '用户选择交由 AI 自行判断',
            resolvedAt: new Date(),
        };
    }

    const allow = effectiveDecision === 'allow';
    const effectiveScopeKey = scope.allowSessionRule ? scope.scopeKey : '';

    return {
        decision: allow ? 'allow' : 'deny',
        reason: allow
            ? (msg?.alwaysAllow && effectiveScopeKey ? '用户在随问中授予范围许可' : '用户在随问中批准执行')
            : (typeof msg?.reason === 'string' && msg.reason ? msg.reason : '用户在随问中拒绝了该工具调用'),
        resolvedAt: new Date(),
    };
}

function createPermissionBrokerController({
    sessionId = process.env.QUICK_CHAT_SESSION_ID || '',
    turnId = process.env.QUICK_CHAT_TURN_ID || '',
    workspace = process.env.QUICK_CHAT_WORKSPACE || '',
    homeDir = os.homedir(),
    fsEnv = createNodeFsEnv(),
    allowRepeatShellInSession = process.env.QUICK_CHAT_ALLOW_REPEAT_SHELL === '1',
    approvalTimeoutMs = Number(process.env.QUICK_CHAT_APPROVAL_TIMEOUT_MS || DEFAULT_APPROVAL_TIMEOUT_MS),
    initialApprovedScopes = [],
    emitEvent = null,
    onPendingCountChange = null,
} = {}) {
    const pendingRequests = new Map();
    const approvedScopes = new Set();
    for (const s of initialApprovedScopes) {
        if (typeof s === 'string' && s.startsWith('qc_scope_v1_')) {
            approvedScopes.add(s);
        }
    }

    const emit = obj => {
        try {
            emitEvent?.(obj);
        } catch (_) {}
    };

    const notifyPendingCount = () => {
        try {
            onPendingCountChange?.(pendingRequests.size);
        } catch (_) {}
    };

    const emitResolved = ({
        requestId,
        toolCallId = '',
        toolName = '',
        decision,
        autoApproved = false,
        timedOut = false,
        scopeKey = '',
        sessionScopeSaved = false,
        answers = null,
        reason = '',
    }) => {
        emit({
            type: 'quickchat.permission_resolved',
            protocolVersion: PROTOCOL_VERSION,
            turnId,
            sessionId,
            payload: {
                requestId: String(requestId || ''),
                toolCallId: String(toolCallId || ''),
                toolName: String(toolName || ''),
                decision,
                autoApproved: Boolean(autoApproved),
                timedOut: Boolean(timedOut),
                scopeKey: String(scopeKey || ''),
                sessionScopeSaved: Boolean(sessionScopeSaved),
                ...(answers && typeof answers === 'object' ? {answers} : {}),
                ...(reason ? {reason: String(reason)} : {}),
            },
        });
    };

    const emitRejected = ({requestId = '', reason = '', incomingTurnId = ''}) => {
        emit({
            type: 'quickchat.permission_response_rejected',
            protocolVersion: PROTOCOL_VERSION,
            turnId,
            sessionId,
            payload: {
                requestId: String(requestId || ''),
                reason: String(reason || 'rejected'),
                ...(incomingTurnId ? {incomingTurnId: String(incomingTurnId)} : {}),
            },
        });
    };

    function handlePermissionRequest(req, opts = {}) {
        if (!req || typeof req !== 'object') {
            return Promise.resolve({
                decision: 'deny',
                reason: '无效的权限请求对象',
                resolvedAt: new Date(),
            });
        }

        const requestId = typeof req.requestId === 'string' && req.requestId.trim()
            ? req.requestId.trim()
            : '';
        if (!requestId) {
            return Promise.resolve({
                decision: 'deny',
                reason: '权限请求缺少 requestId，已安全拒绝',
                resolvedAt: new Date(),
            });
        }

        if (pendingRequests.has(requestId)) {
            return Promise.resolve({
                decision: 'deny',
                reason: `重复的审批请求 ID (${requestId})，已拒绝`,
                resolvedAt: new Date(),
            });
        }

        const interactiveQuestion = isInteractiveQuestionRequest(req.toolName, req.input, req.ruleId);
        const summary = summarizeInput(req.toolName, req.input);
        const policy = interactiveQuestion
            ? {
                toolName: String(req.toolName || 'AskUserQuestion'),
                kind: 'question',
                operationLabel: '交互式提问',
                riskLevel: 'low',
                riskLabel: '低风险',
                riskWarnings: [],
                fullCommand: '',
                cwd: '',
                realCwd: '',
                displayPath: '',
                realPath: '',
                networkOrigin: '',
                targetMismatch: false,
                symlinkEscape: false,
                scopeKey: '',
                allowSessionRule: false,
                sessionRuleLabel: '',
            }
            : sharedPolicy.evaluatePermissionPolicy({
                toolName: req.toolName,
                input: req.input,
                summary,
                ruleId: req.ruleId || '',
                reportedRiskLevel: req.riskLevel || '',
                sessionId: req.sessionId || sessionId,
                cwd: req.cwd || (req.input && typeof req.input === 'object' ? req.input.cwd : '') || process.cwd(),
                workspace,
                homeDir,
                fsEnv,
                allowRepeatShellInSession,
            });

        if (!interactiveQuestion && policy.allowSessionRule && policy.scopeKey && approvedScopes.has(policy.scopeKey)) {
            try { opts?.claimResponse?.(); } catch (_) {}
            emitResolved({
                requestId,
                toolCallId: req.toolCallId || '',
                decision: 'allow',
                autoApproved: true,
                scopeKey: policy.scopeKey,
            });
            return Promise.resolve({
                decision: 'allow',
                reason: `Auto-approved by QuickChat scoped rule (${policy.scopeKey})`,
                resolvedAt: new Date(),
            });
        }

        let settled = false;
        let resolvePromise;
        let timeoutHandle = null;
        let abortHandler = null;

        const promise = new Promise(resolve => {
            resolvePromise = resolve;
        });

        const cleanupListeners = () => {
            if (timeoutHandle !== null) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (abortHandler && opts?.signal && typeof opts.signal.removeEventListener === 'function') {
                try {
                    opts.signal.removeEventListener('abort', abortHandler);
                } catch (_) {}
                abortHandler = null;
            }
        };

        const settle = result => {
            if (settled) return false;
            settled = true;
            cleanupListeners();
            pendingRequests.delete(requestId);
            notifyPendingCount();
            try {
                opts?.claimResponse?.();
            } catch (_) {}
            resolvePromise(result);
            return true;
        };

        if (opts?.signal) {
            if (opts.signal.aborted) {
                settle({decision: 'deny', reason: 'Cancelled', resolvedAt: new Date()});
                return promise;
            }
            abortHandler = () => {
                if (settle({decision: 'deny', reason: 'Cancelled', resolvedAt: new Date()})) {
                    emitResolved({
                        requestId,
                        toolCallId: req.toolCallId || '',
                        decision: 'deny',
                    });
                }
            };
            if (typeof opts.signal.addEventListener === 'function') {
                opts.signal.addEventListener('abort', abortHandler, {once: true});
            }
        }

        if (Number.isFinite(approvalTimeoutMs) && approvalTimeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                timeoutHandle = null;
                if (settle({decision: 'deny', reason: '审批等待超时，已安全拒绝', resolvedAt: new Date()})) {
                    emitResolved({
                        requestId,
                        toolCallId: req.toolCallId || '',
                        decision: 'deny',
                        timedOut: true,
                    });
                }
            }, approvalTimeoutMs);
        }

        const entry = {
            req: {...req, requestId},
            turnId,
            interactiveQuestion,
            opts,
            policy,
            scope: policy,
            settle,
        };
        pendingRequests.set(requestId, entry);
        notifyPendingCount();

        emit({
            type: 'quickchat.permission_requested',
            protocolVersion: PROTOCOL_VERSION,
            turnId,
            sessionId: req.sessionId || sessionId,
            payload: {
                requestId,
                toolCallId: req.toolCallId || '',
                toolName: req.toolName || '工具',
                operationLabel: policy.operationLabel,
                riskLevel: policy.riskLevel,
                riskLabel: policy.riskLabel,
                riskWarnings: policy.riskWarnings,
                reason: req.reason || '',
                summary,
                fullCommand: policy.fullCommand,
                cwd: policy.cwd,
                realCwd: policy.realCwd,
                displayPath: policy.displayPath,
                realPath: policy.realPath,
                networkOrigin: policy.networkOrigin,
                targetMismatch: policy.targetMismatch,
                symlinkEscape: policy.symlinkEscape,
                scopeKey: policy.scopeKey,
                allowSessionRule: policy.allowSessionRule,
                sessionRuleLabel: policy.sessionRuleLabel,
                input: req.input || {},
            },
        });

        return promise;
    }

    function handlePermissionResponseMessage(msg) {
        if (!msg || typeof msg !== 'object' || msg.type !== 'permission_response') {
            return {accepted: false, reason: 'invalid_message_type'};
        }

        // Strict ID verification: NEVER match missing/blank requestId to an arbitrary pending request!
        const targetId = typeof msg.requestId === 'string' ? msg.requestId.trim() : '';
        const incomingTurnId = typeof msg.turnId === 'string' ? msg.turnId.trim() : '';
        if (!targetId) {
            emitRejected({requestId: '', reason: 'missing_request_id', incomingTurnId});
            return {accepted: false, reason: 'missing_request_id'};
        }

        const entry = pendingRequests.get(targetId);
        if (!entry) {
            emitRejected({requestId: targetId, reason: 'unknown_or_expired_request_id', incomingTurnId});
            return {accepted: false, reason: 'unknown_or_expired_request_id'};
        }

        // Strict turnId verification: both missing turnId (when entry.turnId is set) and mismatched turnId are rejected.
        if (entry.turnId) {
            if (!incomingTurnId) {
                emitRejected({requestId: targetId, reason: 'missing_turn_id'});
                return {accepted: false, reason: 'missing_turn_id'};
            }
            if (incomingTurnId !== entry.turnId) {
                emitRejected({requestId: targetId, reason: 'turn_id_mismatch', incomingTurnId});
                return {accepted: false, reason: 'turn_id_mismatch'};
            }
        } else if (incomingTurnId) {
            emitRejected({requestId: targetId, reason: 'turn_id_mismatch', incomingTurnId});
            return {accepted: false, reason: 'turn_id_mismatch'};
        }

        const validation = typeof sharedPolicy.validatePermissionResponsePayload === 'function'
            ? sharedPolicy.validatePermissionResponsePayload(msg, {
                toolName: entry.req?.toolName || entry.policy?.toolName || '',
                input: entry.req?.input ?? null,
                ruleId: entry.req?.ruleId || '',
                isQuestion: Boolean(entry.interactiveQuestion),
                scopeKey: entry.policy?.scopeKey || '',
                allowSessionRule: Boolean(entry.policy?.allowSessionRule),
            })
            : {valid: msg.decision === 'allow' || msg.decision === 'deny', decision: msg.decision === 'allow' ? 'allow' : 'deny', alwaysAllow: false, scopeKey: ''};

        if (!validation.valid) {
            emitRejected({requestId: targetId, reason: validation.reason, incomingTurnId});
            return {accepted: false, reason: validation.reason};
        }

        const resolution = buildBrokerResolution(entry, msg, validation);
        const allow = resolution.decision === 'allow';
        const effectiveScopeKey = (allow && validation.alwaysAllow && entry.policy.allowSessionRule)
            ? entry.policy.scopeKey
            : '';

        let sessionScopeSaved = false;
        if (allow && validation.alwaysAllow && effectiveScopeKey) {
            approvedScopes.add(effectiveScopeKey);
            sessionScopeSaved = true;
        }

        entry.settle(resolution);
        emitResolved({
            requestId: targetId,
            toolCallId: entry.req?.toolCallId || '',
            toolName: entry.req?.toolName || entry.policy?.toolName || '',
            decision: resolution.decision,
            autoApproved: false,
            timedOut: false,
            scopeKey: effectiveScopeKey || entry.policy?.scopeKey || '',
            sessionScopeSaved,
            answers: resolution.modifiedInput?.answers || null,
            reason: resolution.reason || '',
        });

        // Auto-settle parallel pending requests ONLY if they match the exact same deterministic scopeKey,
        // and explicitly notify the host UI for every auto-settled requestId!
        const autoSettledIds = [];
        if (sessionScopeSaved && effectiveScopeKey) {
            for (const [otherId, otherEntry] of Array.from(pendingRequests.entries())) {
                if (otherEntry.policy?.allowSessionRule && otherEntry.policy.scopeKey === effectiveScopeKey) {
                    otherEntry.settle({
                        decision: 'allow',
                        reason: '用户在随问中授予同类范围许可',
                        resolvedAt: new Date(),
                    });
                    autoSettledIds.push(otherId);
                    emitResolved({
                        requestId: otherId,
                        toolCallId: otherEntry.req?.toolCallId || '',
                        toolName: otherEntry.req?.toolName || otherEntry.policy?.toolName || '',
                        decision: 'allow',
                        autoApproved: true,
                        timedOut: false,
                        scopeKey: effectiveScopeKey,
                        sessionScopeSaved: true,
                    });
                }
            }
        }

        return {accepted: true, requestId: targetId, decision: resolution.decision, autoSettledIds};
    }

    function closeAllPending(reason = '输入流已关闭') {
        for (const [id, entry] of Array.from(pendingRequests.entries())) {
            if (entry.settle({
                decision: 'deny',
                reason,
                resolvedAt: new Date(),
            })) {
                emitResolved({
                    requestId: id,
                    toolCallId: entry.req?.toolCallId || '',
                    decision: 'deny',
                });
            }
        }
    }

    function revokeApprovedScopes() {
        approvedScopes.clear();
    }

    return {
        pendingRequests,
        approvedScopes,
        handlePermissionRequest,
        handlePermissionResponseMessage,
        closeAllPending,
        revokeApprovedScopes,
    };
}

// =====================================================================
// Process-level ZCode runtime hook (only active inside ZCode CLI process)
// =====================================================================
let initialScopesFromEnv = [];
try {
    const rawScopes = process.env.QUICK_CHAT_APPROVED_SCOPES || '';
    if (rawScopes.startsWith('[')) {
        const parsed = JSON.parse(rawScopes);
        if (Array.isArray(parsed)) {
            initialScopesFromEnv = parsed;
        }
    }
} catch (_) {}

let rl = null;
let brokerPatched = false;
let readyEmitted = false;

function writeStdoutJsonLine(obj) {
    try {
        process.stdout.write(`${JSON.stringify(obj)}\n`);
    } catch (_) {}
}

function updateProcessStdinRef(pendingCount) {
    try {
        if (pendingCount > 0) {
            process.stdin.resume();
            process.stdin.ref?.();
        } else {
            process.stdin.pause();
            process.stdin.unref?.();
        }
    } catch (_) {}
}

const defaultController = createPermissionBrokerController({
    initialApprovedScopes: initialScopesFromEnv,
    emitEvent: writeStdoutJsonLine,
    onPendingCountChange: updateProcessStdinRef,
});

function ensureStdinListener() {
    if (rl) {
        updateProcessStdinRef(defaultController.pendingRequests.size);
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
        defaultController.handlePermissionResponseMessage(msg);
    });
    rl.on('close', () => {
        defaultController.closeAllPending('输入流已关闭');
    });
    process.stdin.on('error', () => {
        defaultController.closeAllPending('输入流异常中断');
    });
    updateProcessStdinRef(defaultController.pendingRequests.size);
}

function emitBridgeReadyOnce(extra = {}) {
    if (readyEmitted) return;
    readyEmitted = true;
    writeStdoutJsonLine({
        type: 'quickchat.bridge_ready',
        protocolVersion: PROTOCOL_VERSION,
        patched: brokerPatched,
        ...extra,
    });
}

function patchDenyPermissionBroker(BrokerClass, origDefineProp) {
    if (!BrokerClass || !BrokerClass.prototype || BrokerClass.prototype.__qcPatched) return;
    BrokerClass.prototype.__qcPatched = true;
    brokerPatched = true;
    BrokerClass.prototype.requestPermission = function (req, opts = {}) {
        ensureStdinListener();
        return defaultController.handlePermissionRequest(req, opts);
    };
    if (origDefineProp && Object.defineProperty !== origDefineProp) {
        Object.defineProperty = origDefineProp;
    }
    emitBridgeReadyOnce();
}

const isZCodeProcess = process.argv.some(arg => String(arg).includes('zcode'));
if (isZCodeProcess || process.env.QUICK_CHAT_FORCE_BRIDGE === '1') {
    injectPromptFromFileIfConfigured(process.argv, process.env);

    const requireBridgeStrict = process.env.QUICK_CHAT_REQUIRE_BRIDGE === '1';
    const expectedProto = Number(process.env.QUICK_CHAT_BRIDGE_PROTOCOL || PROTOCOL_VERSION);
    if (requireBridgeStrict && expectedProto !== PROTOCOL_VERSION) {
        emitBridgeReadyOnce({
            patched: false,
            fatal: true,
            error: `ZCode 桥接协议版本不匹配（期望 v${expectedProto}，实际 v${PROTOCOL_VERSION}）`,
        });
        process.exit(BRIDGE_FAIL_EXIT_CODE);
    }

    const origDefineProperty = Object.defineProperty;
    Object.defineProperty = function (target, prop, desc) {
        const res = origDefineProperty.call(this, target, prop, desc);
        if (prop === 'name' && desc && typeof target === 'function') {
            if (desc.value === 'DenyPermissionBroker' && target.prototype) {
                patchDenyPermissionBroker(target, origDefineProperty);
            }
        } else if (
            prop === 'requestPermission' &&
            target &&
            typeof target === 'object' &&
            target.constructor &&
            target.constructor.name === 'DenyPermissionBroker'
        ) {
            patchDenyPermissionBroker(target.constructor, origDefineProperty);
        }
        return res;
    };
    setImmediate(() => {
        if (Object.defineProperty !== origDefineProperty) {
            Object.defineProperty = origDefineProperty;
        }
        if (!brokerPatched && requireBridgeStrict) {
            emitBridgeReadyOnce({
                patched: false,
                fatal: true,
                error: '当前 ZCode 版本未命中 DenyPermissionBroker 审批钩子，已安全阻止任务执行',
            });
            process.exit(BRIDGE_FAIL_EXIT_CODE);
        }
        emitBridgeReadyOnce();
    });
}

module.exports = {
    PROTOCOL_VERSION,
    BRIDGE_FAIL_EXIT_CODE,
    buildBrokerResolution,
    computeBridgeScope,
    createPermissionBrokerController,
    injectPromptFromFileIfConfigured,
    isInteractiveQuestionRequest,
    loadSharedPermissionPolicy,
    summarizeInput,
};
