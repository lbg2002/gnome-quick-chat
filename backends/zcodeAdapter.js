// ZCode CLI Backend Adapter (Stage E).
// Supports per-turn CLI execution, isolated async 0600 provider_config override,
// zcodeBridge.cjs handshake verification, and interactive stdin permission/Q&A responses.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {BaseBackendAdapter} from './baseAdapter.js';
import {resolveDesktopAssistantPrompt} from '../core/dshModelCatalog.js';
import {
    buildZCodeArgs,
    normalizeEffectiveAgentMode,
    preparePromptWithinBudget,
    validatePermissionResponsePayload,
} from '../protocol.js';
import {
    loadLocalBackendCatalogAsync,
    readJsonFileAsync,
    readJsonFileSync,
} from '../core/backendDetect.js';
import {
    getPrivateRuntimeDir,
    readFileBytesBoundedAsync,
    removeFileQuietly,
    writeAllBytesAsync,
    writePrivateFileAsync,
    writePrivateFileSync,
} from '../core/paths.js';
import {
    prepareZCodeConfigOverride,
    prepareZCodeConfigOverrideAsync,
    validateCliPromptLength,
} from '../runtime/cliProcessRunner.js';
import {
    spawnManagedCliTurn,
    terminateTurnProcess,
} from '../runtime/processManager.js';

const Encoder = new TextEncoder();

function createDefaultZCodeConfigIo() {
    return {
        homeDir: GLib.get_home_dir(),
        fileExists: p => Boolean(p && GLib.file_test(p, GLib.FileTest.EXISTS)),
        readJson: readJsonFileSync,
        getRuntimeDir: getPrivateRuntimeDir,
        makeUuid: () => GLib.uuid_string_random(),
        writePrivateFile: (p, bytes) => writePrivateFileSync(p, bytes),
        removeFile: removeFileQuietly,
    };
}

function createDefaultZCodeConfigAsyncIo() {
    return {
        homeDir: GLib.get_home_dir(),
        fileExistsAsync: async p => {
            const info = await readFileBytesBoundedAsync(p, 16);
            return info.exists;
        },
        readJsonAsync: (p, opts = {}) => readJsonFileAsync(p, opts.maxBytes),
        getRuntimeDir: getPrivateRuntimeDir,
        makeUuid: () => GLib.uuid_string_random(),
        writePrivateFileAsync: (p, bytes) => writePrivateFileAsync(p, bytes),
        removeFile: removeFileQuietly,
    };
}

export function createIsolatedZCodeConfigOverride(config, ioEnv = null) {
    return prepareZCodeConfigOverride(config, ioEnv || createDefaultZCodeConfigIo());
}

export function createIsolatedZCodeConfigOverrideAsync(config, asyncIoEnv = null) {
    return prepareZCodeConfigOverrideAsync(config, asyncIoEnv || createDefaultZCodeConfigAsyncIo());
}

export class ZCodeAdapter extends BaseBackendAdapter {
    constructor({
        turns,
        store,
        approvedScopes,
        getSessionContextConfig,
        emitEvent,
    } = {}) {
        super('zcode', {emitEvent});
        this._turns = turns;
        this._store = store;
        this._approvedScopes = approvedScopes || new Set();
        this._getSessionContextConfig = getSessionContextConfig || (() => ({}));
    }

    async refreshDefaultModelIfCold() {
        if (!this._disposed && this._runtime && !this._runtime.resolvedModel && !this._config?.model) {
            try {
                const cat = await loadLocalBackendCatalogAsync('zcode');
                if (!this._disposed && cat?.defaultModelId && !this._runtime.resolvedModel) {
                    this._runtime.resolvedProvider = this._runtime.resolvedProvider || cat.defaultProviderId || '';
                    this._runtime.resolvedModel = cat.defaultModelId;
                    this._runtime.label = cat.defaultModelId;
                }
            } catch (_) {}
        }
    }

    async getModels({forceRefresh = false} = {}) {
        const cat = await loadLocalBackendCatalogAsync('zcode', {
            forceRefresh: Boolean(forceRefresh),
        });
        return {
            backend: 'zcode',
            catalog: cat,
            models: [],
        };
    }

    async sendMessage({
        promptText,
        turnMeta = {},
        workspace = '',
        sessionId = '',
        specialDirs = {},
        timeouts = null,
        memoryContext = '',
        disableResume = false,
    }) {
        const budgetCheck = preparePromptWithinBudget(promptText, {allowTruncate: false});
        if (!budgetCheck.ok) {
            throw new Error(budgetCheck.warning || '当前提问超出单次输入上限');
        }

        const cancellable = new Gio.Cancellable();
        const turn = this._turns.beginTurn({
            replyMarker: turnMeta.replyMarker,
            allowedMemoryReferences: turnMeta.allowedMemoryReferences,
            turnId: turnMeta.turnId,
            messageId: turnMeta.messageId,
            replyTo: turnMeta.userMessageId || '',
            modelId: this._runtime?.resolvedModel || '',
            sessionId,
            clientGeneration: turnMeta.clientGeneration ?? 0,
            lifecycleGeneration: turnMeta.lifecycleGeneration ?? 0,
            backend: 'zcode',
            promptText: budgetCheck.promptText,
            cancellable,
            deferTempCleanupUntilProcessExit: true,
        });

        const cliCaps = this._runtime?.cliCapabilities || null;
        const modeInfo = normalizeEffectiveAgentMode('zcode', this._config?.mode || 'readonly', cliCaps);
        const effectiveMode = modeInfo.effectiveMode;

        const {remoteId, prompt: effectiveCliPrompt} = this.prepareCliContext(budgetCheck.promptText, {
            memoryContext, allowResume: !disableResume,
            workspace, specialDirs, mode: effectiveMode,
            assistantInstructions: resolveDesktopAssistantPrompt(this._config?.assistantInstructions),
        });

        const requireBridgeHandshake = effectiveMode === 'smart';
        if (requireBridgeHandshake && !this._runtime?.bridgePath) {
            const err = new Error('未找到 ZCode 权限审批桥接模块（zcodeBridge.cjs），已阻止在需审批模式下启动任务');
            this._turns.finalizeTurn(turn, {status: 'failed', errorText: err.message});
            throw err;
        }

        let zcodeIsolated = {env: {}, tempFilePath: '', resolvedProvider: '', resolvedModel: ''};
        let promptTempFilePath = '';
        let rawArgv = [];
        const useZCodePromptFile = Boolean(this._runtime?.bridgePath);

        try {
            validateCliPromptLength(effectiveCliPrompt, {viaArgv: !useZCodePromptFile});

            zcodeIsolated = await createIsolatedZCodeConfigOverrideAsync(this._config);
            if (zcodeIsolated.tempFilePath) {
                turn.tempFiles.push(zcodeIsolated.tempFilePath);
            }
            if (zcodeIsolated.resolvedModel && !this._disposed) {
                this._runtime.resolvedProvider = zcodeIsolated.resolvedProvider || this._runtime.resolvedProvider;
                this._runtime.resolvedModel = zcodeIsolated.resolvedModel;
                this._runtime.label = zcodeIsolated.resolvedModel;
                turn.selectedModelId = turn.modelId = zcodeIsolated.resolvedModel;
            }
            if (useZCodePromptFile) {
                const runtimeDir = getPrivateRuntimeDir();
                promptTempFilePath = GLib.build_filenamev([
                    runtimeDir,
                    `zcode-prompt-${GLib.uuid_string_random()}.txt`,
                ]);
                await writePrivateFileAsync(promptTempFilePath, Encoder.encode(effectiveCliPrompt), turn.cancellable);
                turn.tempFiles.push(promptTempFilePath);
            }

            if (!this._turns.isCurrent(turn)) {
                turn.tempFiles.splice(0).forEach(removeFileQuietly);
                return {disposition: 'cancelled', turnId: turn.id};
            }

            const spawnConfig = {
                ...this._config,
                mode: effectiveMode,
                executable: this._runtime.executable,
                commandPrefix: this._runtime.commandPrefix,
                cliCapabilities: cliCaps,
            };
            rawArgv = buildZCodeArgs(spawnConfig, effectiveCliPrompt, remoteId, workspace, {
                cliCaps,
                usePromptFile: Boolean(promptTempFilePath),
            });
        } catch (prepErr) {
            turn.tempFiles.splice(0).forEach(removeFileQuietly);
            this._store?.clearRemoteSessionId('prep_failed');
            if (this._turns.isCurrent(turn)) {
                this._turns.finalizeTurn(turn, {
                    status: turn.aborted ? 'cancelled' : 'failed',
                    errorText: turn.aborted ? '' : prepErr.message,
                    onCleanupTempFiles: files => files.forEach(removeFileQuietly),
                });
            }
            if (turn.aborted) {
                return {disposition: 'cancelled', turnId: turn.id};
            }
            throw prepErr;
        }

        const updatedCtxCfg = this._getSessionContextConfig();
        this._store?.appendMessage(
            {
                id: turnMeta.userMessageId,
                turnId: turn.id,
                role: 'user',
                content: budgetCheck.promptText,
                ...(turnMeta.displayUserText ? {displayText: turnMeta.displayUserText} : {}),
                ...(turnMeta.userCreatedAt ? {createdAt: turnMeta.userCreatedAt} : {}),
                ...(turnMeta.userTs ? {ts: turnMeta.userTs} : {}),
            },
            'zcode',
            updatedCtxCfg
        );

        const turnExtraEnv = {
            ...zcodeIsolated.env,
            ...(promptTempFilePath ? {QUICK_CHAT_PROMPT_FILE: promptTempFilePath} : {}),
            ...(this._approvedScopes.size > 0
                ? {QUICK_CHAT_APPROVED_SCOPES: JSON.stringify(Array.from(this._approvedScopes))}
                : {}),
        };

        return spawnManagedCliTurn({
            backend: 'zcode',
            runtime: this._runtime,
            config: this._config,
            workspace,
            sessionId,
            specialDirs,
            turns: this._turns,
            turn,
            store: this._store,
            approvedScopes: this._approvedScopes,
            getSessionContextConfig: this._getSessionContextConfig,
            isDisposedFn: () => this._disposed,
            rawArgv,
            turnExtraEnv,
            keepStdinOpenForApproval: true,
            requireBridgeHandshake,
            remoteId,
            modeNotice: modeInfo.notice || '',
            effectiveMode,
            timeouts,
        });
    }

    async cancel(turnId = '') {
        const active = this._turns?.activeTurn;
        if (!active || active.finalized) return {aborted: false};
        if (turnId && active.id !== String(turnId)) return {aborted: false, stale: true};
        const ctxCfg = this._getSessionContextConfig();
        this._turns.cancelActiveTurn({
            onPersistAssistant: m => this._store?.appendMessage(m, 'zcode', ctxCfg),
            onTerminateProcess: proc => terminateTurnProcess(active, proc),
            onCleanupTempFiles: files => files.forEach(removeFileQuietly),
        });
        this._store?.clearRemoteSessionId('turn_cancelled');
        return {aborted: true, turnId: active.id};
    }

    respondPermission({
        turnId = '',
        requestId = '',
        decision = 'deny',
        alwaysAllow = false,
        allowSessionRule = false,
        scopeKey = '',
        toolName = '',
        modifiedInput = undefined,
        reason = '',
        ackTimeoutMs = 0,
    } = {}) {
        const turn = this._turns?.activeTurn;
        const cleanReqId = String(requestId || '').trim();
        if (!turn || turn.finalized || !turn.stdin || !cleanReqId) {
            return Promise.resolve({sent: false, rejected: 'no_active_turn_or_request_id'});
        }
        const cleanTurnId = String(turnId || '').trim();
        if (!cleanTurnId) {
            return Promise.resolve({sent: false, rejected: 'missing_turn_id'});
        }
        if (cleanTurnId !== turn.id) {
            return Promise.resolve({sent: false, rejected: 'turn_id_mismatch'});
        }
        if (!turn.pendingApprovals.has(cleanReqId)) {
            return Promise.resolve({sent: false, rejected: 'unknown_or_already_resolved_request'});
        }

        const entry = this._turns.getApprovalEntry?.(turn, cleanReqId) || null;
        if (entry && (entry.state === 'sending_approval' || entry.state === 'awaiting_ack')) {
            if (entry.inFlightPromise && entry.requestedDecision === decision) {
                return entry.inFlightPromise;
            }
            return Promise.resolve({sent: false, rejected: 'approval_already_in_flight'});
        }

        const validation = validatePermissionResponsePayload(
            {
                decision,
                alwaysAllow,
                allowSessionRule: entry ? (entry.allowSessionRule || allowSessionRule) : allowSessionRule,
                scopeKey: scopeKey || entry?.scopeKey || '',
                modifiedInput,
                toolName: entry?.toolName || toolName || '',
            },
            entry || {toolName, allowSessionRule, scopeKey}
        );
        if (!validation.valid) {
            return Promise.resolve({sent: false, rejected: validation.reason});
        }

        if (entry) {
            try { entry.clearAckTimer?.(); } catch (_) {}
            entry.clearAckTimer = null;
            entry.state = 'sending_approval';
            entry.requestedDecision = validation.decision;
            entry.requestedAlwaysAllow = validation.alwaysAllow;
            entry.requestedScopeKey = validation.scopeKey;
            entry.requestedModifiedInput = validation.modifiedInput;
        }

        const msgObj = {
            type: 'permission_response',
            turnId: turn.id,
            requestId: cleanReqId,
            decision: validation.decision,
            alwaysAllow: validation.alwaysAllow,
            ...(validation.scopeKey ? {scopeKey: validation.scopeKey} : {}),
            ...(validation.modifiedInput !== undefined ? {modifiedInput: validation.modifiedInput} : {}),
            ...(reason ? {reason: String(reason)} : {}),
        };
        const bytes = Encoder.encode(`${JSON.stringify(msgObj)}\n`);

        const effectiveAckTimeoutMs = Number.isFinite(ackTimeoutMs) && ackTimeoutMs > 0
            ? Number(ackTimeoutMs)
            : Number(this._config?.approvalAckTimeoutMs || 8000);

        const writeTask = () => new Promise(resolve => {
            if (!this._turns.matchesIdentity(turn, {turnId: turn.id}) || !turn.stdin) {
                if (entry) entry.inFlightPromise = null;
                resolve({sent: false, rejected: 'turn_no_longer_active'});
                return;
            }
            if (entry && entry.state !== 'sending_approval') {
                entry.inFlightPromise = null;
                resolve({sent: false, alreadySettled: true, status: entry.state});
                return;
            }
            writeAllBytesAsync(turn.stdin, bytes, GLib.PRIORITY_DEFAULT, turn.cancellable).then(
                () => {
                    try {
                        turn.stdin?.flush_async?.(GLib.PRIORITY_DEFAULT, turn.cancellable, () => {});
                    } catch (_) {}

                    const markRes = this._turns.markApprovalWriteCompleted(turn, cleanReqId);
                    if (!markRes.ok || markRes.alreadySettled) {
                        if (entry) entry.inFlightPromise = null;
                        resolve({
                            sent: Boolean(markRes.ok),
                            alreadySettled: Boolean(markRes.alreadySettled),
                            status: markRes.state,
                        });
                        return;
                    }

                    if (entry && effectiveAckTimeoutMs > 0) {
                        let ackTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, effectiveAckTimeoutMs, () => {
                            ackTimerId = 0;
                            if (entry) entry.clearAckTimer = null;
                            this._turns.markApprovalAckTimedOut(turn, cleanReqId, 'bridge_ack_timeout');
                            return GLib.SOURCE_REMOVE;
                        });
                        entry.clearAckTimer = () => {
                            if (ackTimerId) {
                                GLib.source_remove(ackTimerId);
                                ackTimerId = 0;
                            }
                        };
                    }

                    const ackPromise = entry
                        ? new Promise(ackResolve => {
                            if (entry.state !== 'sending_approval' && entry.state !== 'awaiting_ack') {
                                ackResolve({acked: entry.state === 'resolved', state: entry.state});
                            } else {
                                entry.ackWaiters.push(ackResolve);
                            }
                        })
                        : Promise.resolve({acked: false});

                    resolve({
                        sent: true,
                        status: 'awaiting_ack',
                        ackPromise,
                    });
                },
                () => {
                    if (entry && entry.state === 'sending_approval') {
                        entry.state = 'pending_approval';
                        entry.inFlightPromise = null;
                    }
                    resolve({sent: false, rejected: 'stdin_write_failed'});
                }
            );
        });

        const chainedPromise = (turn.stdinWriteChain || Promise.resolve()).then(writeTask, writeTask);
        turn.stdinWriteChain = chainedPromise.then(() => {}, () => {});
        if (entry) {
            entry.inFlightPromise = chainedPromise;
        }
        return chainedPromise;
    }
}
