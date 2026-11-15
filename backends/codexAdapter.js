// Codex CLI Backend Adapter (Stage E).
// Supports per-turn `codex exec --json` execution with stdin prompt streaming and
// native CLI read-only / full sandbox modes. Does NOT claim interactive tool approval.

import Gio from 'gi://Gio';
import {BaseBackendAdapter} from './baseAdapter.js';
import {
    augmentPromptWithDesktopContext,
    buildCodexArgs,
    buildCrossBackendPromptWithContext,
    normalizeEffectiveAgentMode,
    preparePromptWithinBudget,
} from '../protocol.js';
import {loadLocalBackendCatalogAsync} from '../core/backendDetect.js';
import {removeFileQuietly} from '../core/paths.js';
import {validateCliPromptLength} from '../runtime/cliProcessRunner.js';
import {
    spawnManagedCliTurn,
    terminateTurnProcess,
} from '../runtime/processManager.js';

export class CodexAdapter extends BaseBackendAdapter {
    constructor({
        turns,
        store,
        getSessionContextConfig,
        emitEvent,
    } = {}) {
        super('codex', {emitEvent});
        this._turns = turns;
        this._store = store;
        this._getSessionContextConfig = getSessionContextConfig || (() => ({}));
    }

    async getModels({forceRefresh = false} = {}) {
        const cat = await loadLocalBackendCatalogAsync('codex', {
            forceRefresh: Boolean(forceRefresh),
        });
        return {
            backend: 'codex',
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
            backend: 'codex',
            promptText: budgetCheck.promptText,
            cancellable,
            deferTempCleanupUntilProcessExit: true,
        });

        const cliCaps = this._runtime?.cliCapabilities || null;
        const modeInfo = normalizeEffectiveAgentMode('codex', this._config?.mode || 'readonly', cliCaps);
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

        const useCodexStdin = Boolean(cliCaps?.supportsStdinPrompt !== false);
        let rawArgv = [];

        try {
            validateCliPromptLength(effectiveCliPrompt, {viaArgv: !useCodexStdin});
            const spawnConfig = {
                ...this._config,
                mode: effectiveMode,
                executable: this._runtime.executable,
                cliCapabilities: cliCaps,
            };
            rawArgv = buildCodexArgs(spawnConfig, workspace, effectiveCliPrompt, remoteId, {
                cliCaps,
                stdinPrompt: useCodexStdin,
            });
        } catch (prepErr) {
            if (this._turns.isCurrent(turn)) {
                this._turns.finalizeTurn(turn, {
                    status: turn.aborted ? 'cancelled' : 'failed',
                    errorText: turn.aborted ? '' : prepErr.message,
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
            },
            'codex',
            ctxCfg
        );

        return spawnManagedCliTurn({
            backend: 'codex',
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
            stdinPromptText: useCodexStdin ? effectiveCliPrompt : '',
            keepStdinOpenForApproval: false,
            requireBridgeHandshake: false,
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
            onPersistAssistant: m => this._store?.appendMessage(m, 'codex', ctxCfg),
            onTerminateProcess: proc => terminateTurnProcess(active, proc),
            onCleanupTempFiles: files => files.forEach(removeFileQuietly),
        });
        return {aborted: true, turnId: active.id};
    }
}
