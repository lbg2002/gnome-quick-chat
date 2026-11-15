// ZCode CLI Backend Adapter (Stage E).
// Supports per-turn CLI execution, isolated async 0600 provider_config override,
// zcodeBridge.cjs handshake verification, and interactive stdin permission/Q&A responses.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {BaseBackendAdapter} from './baseAdapter.js';
import {
    augmentPromptWithDesktopContext,
    buildCrossBackendPromptWithContext,
    buildZCodeArgs,
    normalizeEffectiveAgentMode,
    preparePromptWithinBudget,
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
    }) {
        const budgetCheck = preparePromptWithinBudget(promptText, {allowTruncate: false});
        if (!budgetCheck.ok) {
            throw new Error(budgetCheck.warning || '当前提问超出单次输入上限');
        }

        const cancellable = new Gio.Cancellable();
        const turn = this._turns.beginTurn({
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

        const historyBeforePrompt = this._store ? [...this._store.messages] : [];
        const remoteId = this._store?.remoteSessionId || '';
        const promptWithDesktopEnv = augmentPromptWithDesktopContext(budgetCheck.promptText, specialDirs, {
            isFirstTurn: !remoteId,
            mode: effectiveMode,
            workspace,
        });
        const effectiveCliPrompt = (!remoteId && historyBeforePrompt.length > 0)
            ? buildCrossBackendPromptWithContext(historyBeforePrompt, promptWithDesktopEnv)
            : promptWithDesktopEnv;

        const requireBridgeHandshake = effectiveMode === 'readonly';
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
                turn.modelId = zcodeIsolated.resolvedModel;
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

        const ctxCfg = this._getSessionContextConfig();
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
            ctxCfg
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
        return {aborted: true, turnId: active.id};
    }

    respondPermission({
        turnId = '',
        requestId = '',
        decision = 'deny',
        alwaysAllow = false,
        allowSessionRule = false,
        scopeKey = '',
        modifiedInput = undefined,
        reason = '',
    } = {}) {
        const turn = this._turns?.activeTurn;
        const cleanReqId = String(requestId || '').trim();
        if (!turn || turn.finalized || !turn.stdin || !cleanReqId) {
            return Promise.resolve({sent: false, rejected: 'no_active_turn_or_request_id'});
        }
        if (turnId && String(turnId) !== turn.id) {
            return Promise.resolve({sent: false, rejected: 'turn_id_mismatch'});
        }
        if (!turn.pendingApprovals.has(cleanReqId)) {
            return Promise.resolve({sent: false, rejected: 'unknown_or_already_resolved_request'});
        }

        const effectiveAlwaysAllow = Boolean(decision === 'allow' && alwaysAllow && allowSessionRule && scopeKey);
        const msgObj = {
            type: 'permission_response',
            turnId: turn.id,
            requestId: cleanReqId,
            decision: decision === 'allow' ? 'allow' : 'deny',
            alwaysAllow: effectiveAlwaysAllow,
        };
        if (modifiedInput !== undefined) {
            msgObj.modifiedInput = modifiedInput;
        }
        if (reason) {
            msgObj.reason = String(reason);
        }
        const bytes = Encoder.encode(`${JSON.stringify(msgObj)}\n`);

        return new Promise(resolve => {
            writeAllBytesAsync(turn.stdin, bytes, GLib.PRIORITY_DEFAULT, turn.cancellable).then(
                () => {
                    try {
                        turn.stdin.flush_async(GLib.PRIORITY_DEFAULT, turn.cancellable, () => {});
                    } catch (_) {}
                    if (this._turns.matchesIdentity(turn, {turnId: turn.id})) {
                        if (effectiveAlwaysAllow) {
                            this._approvedScopes.add(scopeKey);
                        }
                        this._turns.leaveApproval(turn, cleanReqId);
                    }
                    resolve({sent: true});
                },
                () => resolve({sent: false})
            );
        });
    }
}
