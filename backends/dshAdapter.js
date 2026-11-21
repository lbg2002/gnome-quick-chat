// DeepSeek Harness (dsh) official headless JSONL adapter.
// The SDK profile supplies native callbacks on supported releases.
import Gio from 'gi://Gio';
import {BaseBackendAdapter} from './baseAdapter.js';
import {
    buildDshArgs,
    normalizeEffectiveAgentMode,
    preparePromptWithinBudget,
} from '../protocol.js';
import GLib from 'gi://GLib';
import {getPrivateRuntimeDir, removeFileQuietly, writePrivateFileAsync} from '../core/paths.js';
import {loadLocalBackendCatalogAsync, readDshWebProfilePatchAsync} from '../core/backendDetect.js';
import {
    buildDshProfileOverlay,
    cleanDshModelId,
    extractDshPiAiProviders,
    normalizeDshProviderId,
    resolveDesktopAssistantPrompt,
} from '../core/dshModelCatalog.js';
import {DshSdkTurn} from '../runtime/dshSdk.js';
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

        const sdk = this._runtime?.cliCapabilities?.dshSdk === true;
        const modeInfo = normalizeEffectiveAgentMode(
            'dsh', this._config?.mode || 'readonly',
            {enableAutoReview: this._config?.dshAutoReview === true, dshSdk: sdk}
        );
        const effectiveMode = modeInfo.effectiveMode;
        const {remoteId, prompt: cliPrompt} = this.prepareCliContext(budgetCheck.promptText, {
            workspace, specialDirs, mode: effectiveMode,
        });

        let rawArgv;
        try {
            validateCliPromptLength(cliPrompt, {viaArgv: false});
            const persona = resolveDesktopAssistantPrompt(this._config?.assistantInstructions);
            const configuredModel = String(this._config?.model || '').trim();
            const configuredProvider = normalizeDshProviderId(this._config?.provider);
            const catalog = sdk && !configuredModel
                ? (await this.getModels({cancellable: turn.cancellable})).catalog : null;
            const provider = configuredProvider || catalog?.defaultProviderId || '';
            const model = configuredModel || (provider === catalog?.defaultProviderId
                ? catalog?.defaultModelId : catalog?.providers.find(item => item.id === provider)?.models[0]) || '';
            if (sdk && !model) throw new Error('请选择该 DSH Provider 可用的模型');

            // DSH Web providers are profile-scoped. Bridge only the
            // selected route for this turn, without altering ~/.dsh.
            let piAiPatch = '';
            if (model && provider && provider !== 'deepseek-official') {
                const webPatch = await readDshWebProfilePatchAsync(turn.cancellable);
                if (extractDshPiAiProviders(webPatch).some(p => p.id === provider)) {
                    piAiPatch = webPatch;
                }
            }
            const profileOverlay = buildDshProfileOverlay({
                provider: model ? (provider || 'deepseek-official') : '',
                model, persona, piAiPatch,
                mountCredentials: true,
                sdkMode: sdk ? effectiveMode : '',
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
            if (sdk) {
                turn.dshSdk = new DshSdkTurn({
                    sessionId: remoteId || GLib.uuid_string_random(), workspace,
                    resume: Boolean(remoteId),
                    provider: provider || 'deepseek-official',
                    model,
                    prompt: cliPrompt, approvalRequests: effectiveMode === 'smart',
                    fullAccess: effectiveMode === 'full',
                });
                rawArgv = [this._runtime.executable, '--profile', 'sdk', '--patch', overlayPath];
            } else {
                rawArgv = buildDshArgs({
                    ...this._config,
                    executable: this._runtime.executable,
                    mode: effectiveMode,
                }, remoteId, {overlayPath});
            }
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
            conversationTransport: turn.dshSdk,
            turnExtraEnv: sdk ? {DSH_PERMISSION_MODE: effectiveMode === 'full' ? 'danger-full-access' : 'read-only'} : {},
            keepStdinOpenForApproval: false,
            requireBridgeHandshake: false,
            remoteId,
            modeNotice: modeInfo.notice || '',
            effectiveMode,
            timeouts,
        });
    }

    async respondPermission(request = {}) {
        const turn = this._turns.activeTurn;
        if (!turn?.dshSdk || !this._turns.isCurrent(turn) || request.turnId !== turn.id) {
            return {sent: false};
        }
        const response = await turn.dshSdk.respond(request);
        if (response.event && this._turns.isCurrent(turn)) turn.applyInteractionResolution?.(response.event);
        return {sent: response.sent, phase: response.event ? 'delivered' : 'awaiting_ack'};
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
