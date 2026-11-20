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
import GLib from 'gi://GLib';
import {getPrivateRuntimeDir, removeFileQuietly, writePrivateFileAsync} from '../core/paths.js';
import {loadLocalBackendCatalogAsync} from '../core/backendDetect.js';
import {
    buildDshProfileOverlay,
    cleanDshModelId,
    resolveDesktopAssistantPrompt,
} from '../core/dshModelCatalog.js';
import {validateCliPromptLength} from '../runtime/cliProcessRunner.js';
import {spawnManagedCliTurn, terminateTurnProcess} from '../runtime/processManager.js';

export class DshAdapter extends BaseBackendAdapter {
    constructor({turns, store, getSessionContextConfig, emitEvent} = {}) {
        super('dsh', {emitEvent});
        this._turns = turns;
        this._store = store;
        this._getSessionContextConfig = getSessionContextConfig || (() => ({}));
    }

    async getModels({forceRefresh = false, cancellable = null} = {}) {
        const catalog = await loadLocalBackendCatalogAsync('dsh', {
            dshPath: this._runtime?.executable || this._config?.dshPath || '',
            forceRefresh, cancellable,
        });
        return {
            backend: 'dsh',
            catalog,
            models: catalog.providers.flatMap(p => p.models),
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

        const modeInfo = normalizeEffectiveAgentMode(
            'dsh', this._config?.mode || 'readonly',
            {enableAutoReview: this._config?.dshAutoReview === true}
        );
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
            const persona = resolveDesktopAssistantPrompt(this._config?.assistantInstructions);
            const model = String(this._config?.model || '').trim();
            const provider = String(this._config?.provider || '').trim();
            const profileOverlay = buildDshProfileOverlay({
                provider: model ? (provider || 'deepseek-official') : '',
                model, persona,
            });
            let overlayPath = '';
            if (profileOverlay) {
                overlayPath = GLib.build_filenamev([
                    getPrivateRuntimeDir(),
                    `dsh-overlay-${GLib.uuid_string_random()}.yml`,
                ]);
                await writePrivateFileAsync(overlayPath, new TextEncoder().encode(profileOverlay), turn.cancellable);
                turn.tempFiles.push(overlayPath);
            }
            if (!this._turns.isCurrent(turn)) {
                turn.tempFiles.splice(0).forEach(removeFileQuietly);
                return {disposition: 'cancelled', turnId: turn.id};
            }
            rawArgv = buildDshArgs({
                ...this._config,
                executable: this._runtime.executable,
                mode: effectiveMode,
            }, remoteId, {overlayPath});
            if (model && cleanDshModelId(model)) {
                turn.modelId = model;
            }
        } catch (err) {
            turn.tempFiles.splice(0).forEach(removeFileQuietly);
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
