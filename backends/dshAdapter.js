// DeepSeek Harness (dsh) official headless JSONL adapter.
// One CLI process per turn; no WebView, no persistent agent daemon.
// Headless approval has no Quick Chat callback transport, so never claim it.
import Gio from 'gi://Gio';
import {BaseBackendAdapter} from './baseAdapter.js';
import {
    augmentPromptWithDesktopContext,
    buildCrossBackendPromptWithContext,
    buildDshArgs,
    normalizeEffectiveAgentMode,
    preparePromptWithinBudget,
} from '../protocol.js';
import {removeFileQuietly} from '../core/paths.js';
import {validateCliPromptLength} from '../runtime/cliProcessRunner.js';
import {spawnManagedCliTurn, terminateTurnProcess} from '../runtime/processManager.js';

export class DshAdapter extends BaseBackendAdapter {
    constructor({turns, store, getSessionContextConfig, emitEvent} = {}) {
        super('dsh', {emitEvent});
        this._turns = turns;
        this._store = store;
        this._getSessionContextConfig = getSessionContextConfig || (() => ({}));
    }

    async getModels() {
        // dsh's model is selected by the user's profile, not by an invented CLI --model flag.
        return {
            backend: 'dsh',
            catalog: {backendLabel: 'DeepSeek Harness', providers: []},
            models: [],
        };
    }

    async sendMessage({promptText, turnMeta = {}, workspace = '', sessionId = '',
        specialDirs = {}, timeouts = null}) {
        const budgetCheck = preparePromptWithinBudget(promptText, {allowTruncate: false});
        if (!budgetCheck.ok) throw new Error(budgetCheck.warning || '当前提问超过输入上限');

        const turn = this._turns.beginTurn({
            turnId: turnMeta.turnId,
            messageId: turnMeta.messageId,
            replyTo: turnMeta.userMessageId || '',
            modelId: this._runtime?.resolvedModel || '',
            sessionId,
            clientGeneration: turnMeta.clientGeneration ?? 0,
            lifecycleGeneration: turnMeta.lifecycleGeneration ?? 0,
            backend: 'dsh',
            promptText: budgetCheck.promptText,
            cancellable: new Gio.Cancellable(),
            deferTempCleanupUntilProcessExit: true,
        });

        const modeInfo = normalizeEffectiveAgentMode('dsh', this._config?.mode || 'readonly');
        const effectiveMode = modeInfo.effectiveMode;
        const ctxCfg = this._getSessionContextConfig();
        const historyBeforePrompt = this._store ? [...this._store.messages] : [];
        const remoteId = this._store
            ? (typeof this._store.resolveRemoteSessionForTurn === 'function'
                ? this._store.resolveRemoteSessionForTurn('dsh', ctxCfg)
                : this._store.remoteSessionId || '')
            : '';
        const desktopPrompt = augmentPromptWithDesktopContext(budgetCheck.promptText, specialDirs, {
            isFirstTurn: !remoteId, mode: effectiveMode, workspace,
        });
        const cliPrompt = (!remoteId && historyBeforePrompt.length)
            ? buildCrossBackendPromptWithContext(historyBeforePrompt, desktopPrompt)
            : desktopPrompt;

        let rawArgv;
        try {
            validateCliPromptLength(cliPrompt, {viaArgv: false});
            rawArgv = buildDshArgs({
                ...this._config, executable: this._runtime.executable, mode: effectiveMode,
            }, remoteId);
        } catch (err) {
            this._store?.clearRemoteSessionId('prep_failed');
            if (this._turns.isCurrent(turn)) {
                this._turns.finalizeTurn(turn, {
                    status: turn.aborted ? 'cancelled' : 'failed',
                    errorText: turn.aborted ? '' : err.message,
                });
            }
            if (turn.aborted) return {disposition: 'cancelled', turnId: turn.id};
            throw err;
        }

        this._store?.appendMessage({
            id: turnMeta.userMessageId,
            turnId: turn.id,
            role: 'user',
            content: budgetCheck.promptText,
            ...(turnMeta.displayUserText ? {displayText: turnMeta.displayUserText} : {}),
            ...(turnMeta.userCreatedAt ? {createdAt: turnMeta.userCreatedAt} : {}),
            ...(turnMeta.userTs ? {ts: turnMeta.userTs} : {}),
        }, 'dsh', this._getSessionContextConfig());

        return spawnManagedCliTurn({
            backend: 'dsh',
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
            stdinPromptText: cliPrompt,
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
        const ctx = this._getSessionContextConfig();
        this._turns.cancelActiveTurn({
            onPersistAssistant: msg => this._store?.appendMessage(msg, 'dsh', ctx),
            onTerminateProcess: proc => terminateTurnProcess(active, proc),
            onCleanupTempFiles: files => files.forEach(removeFileQuietly),
        });
        this._store?.clearRemoteSessionId('turn_cancelled');
        return {aborted: true, turnId: active.id};
    }
}
