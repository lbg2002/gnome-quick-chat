import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {BackendClient} from './backendClient.js';
import {
    buildAskUserModifiedInput,
    detailedMessages,
    isDefaultBrowserLaunchRequest,
    expandHomePath,
    formatAskUserAnswerSummary,
    getBackendCapabilities,
    messageText,
    messageThinking,
} from './protocol.js';
import {
    AttachmentManager,
    MAX_ATTACHMENT_FILE_BYTES,
    describePathOnlyPureApiActions,
    extractCopiedFilePaths,
} from './core/attachmentManager.js';
import {BackendRegistry} from './core/backendRegistry.js';
import {ChatController} from './core/chatController.js';
import {
    detectBackendSelectionAsync,
    detectEffectiveBackend,
    invalidateBackendDetectionCaches,
    migrateGSettingsIfNeeded,
    peekEffectiveBackend,
} from './core/backendDetect.js';
import {
    deriveRuntimeStatusIndicator,
    formatDiagnosticReportText,
    sanitizeDiagnosticSnapshot,
} from './core/diagnosticsReport.js';
import {
    clampSafeRecommendedMode,
    recommendRouteLocally,
} from './core/modelRouter.js';
import {
    BackgroundNotificationGate,
    resolveNotificationClickTarget,
} from './core/notificationPolicy.js';
import {
    getSessionsDir,
    readFileBytesBoundedAsync,
    requireWorkspaceDirectory,
} from './core/paths.js';
import {
    appendBoundedInMemoryText,
    applyToolTraceEventToCard,
} from './core/renderScheduler.js';
import {
    loadOpenAIApiKey,
    normalizeEndpointKeyIdentity,
} from './core/secretStore.js';
import {
    buildContinuationPrompt,
    planSessionRetentionCleanup,
    resolvePreviousSessionId,
} from './core/sessionEngine.js';
import {
    deleteStoredSessionAsync,
    executeApprovedSessionCleanupAsync,
    listStoredSessionsAsync,
    validateSessionId,
} from './core/sessionStore.js';
import {ChatPanelView} from './ui/chatPanel.js';
import {CapsuleView} from './ui/capsuleView.js';
import {DateMenuIntegration} from './ui/dateMenuIntegration.js';
import {MessageCardFactory} from './ui/messageCard.js';
import {ModelPickerController} from './ui/modelPicker.js';
import {TracePanelController} from './ui/tracePanel.js';

let nextLifecycleGeneration = 0;

export default class QuickChat extends Extension {
    enable() {
        const lifeGen = ++nextLifecycleGeneration;
        this._lifecycleGeneration = lifeGen;
        this._enabled = true;
        this._timers = new Set();
        this._settingSignals = [];
        this._registeredKeybindings = new Set();
        this._menuSignal = 0;
        this._sessionSignal = 0;
        this._panelDestroyed = false;
        this._themeSig1 = 0;
        this._themeSig2 = 0;
        this._interfaceSettings = null;

        this._promptHistory = [];
        this._historyIndex = -1;
        this._draftInput = '';
        this._live = null;
        this._modelLabel = '随问';
        this._idleStatus = '随问';
        this._tab = 'ai';
        this._capsule = null;
        this._sessionSwitchInFlight = false;

        this._attachments = new AttachmentManager();
        this._notifGate = new BackgroundNotificationGate();
        this._dismissedRouteKeys = new Set();
        this._editingTurnInfo = null;
        this._lastConfirmedSideEffectRetryCardId = '';
        this._canUndoLastRewind = false;
        this._cachedAvailableBackends = new Set();
        this._diagState = {
            bridgeHandshake: '',
            lastConnectionError: '无',
            sessionSaveStatus: '正常',
            sessionSaveWarning: '',
        };

        try {
            this._settings = this.getSettings();
            migrateGSettingsIfNeeded(this._settings);

            this._observedSessionId = this._getSettingString('session-id', '');
            this._registry = new BackendRegistry(this._settings);
            this._dateIntegration = new DateMenuIntegration();

            this._chatController = new ChatController({
                registry: this._registry,
                createClient: (onEvent, onError) => new BackendClient(onEvent, onError),
                loadRuntimeEnvironment: options => this._loadRuntimeEnvironment(options),
                createCancellable: () => new Gio.Cancellable(),
                onEvent: event => this._onEvent(event),
                onStateChanged: info => this._onClientStateReady(info),
                onConnectionError: err => {
                    this._live = null;
                    this._setBusy(false);
                    const errMsg = err?.message || String(err || '未知错误');
                    if (this._capsule?.isPending) this._capsule.fail(errMsg);
                    this._panel?.setStatusIndicator('error', `连接失败：${errMsg}`);
                    this._syncDiagnosticsSnapshot({lastConnectionError: errMsg});
                },
                scheduleDelay: (ms, cb) => {
                    const id = this._scheduleTimeout(ms, cb);
                    return () => this._clearTimer(id);
                },
            });
            this._chatController.beginLifecycle(lifeGen);

            this._tracePanel = new TracePanelController({
                copyWithFeedback: (btn, getTextFn, defaultLabel) =>
                    this._cardFactory?.copyWithFeedback(btn, getTextFn, defaultLabel),
                getApprovalSlot: card => card === this._live ? this._panel?.approvalSlot : null,
                onSubmitToolDecision: (card, decision, alwaysAllow) =>
                    this._submitActiveToolDecision(card, decision, alwaysAllow),
                onSubmitQuestionDecision: (card, action) =>
                    this._submitQuestionDecision(card, action),
            });

            this._cardFactory = new MessageCardFactory({
                tracePanel: this._tracePanel,
                isChatVisible: () => this._isChatVisible(),
                isMarkdownEnabled: () => this._markdownEnabled(),
                isAnimEnabled: () => this._animEnabled(),
                isCardStreaming: card => Boolean(card === this._live && this._chatController?.busy),
                getFallbackModelLabel: () => this._modelLabel || '随问',
                scheduleTimeout: (ms, fn) => this._scheduleTimeout(ms, fn),
                clearTimer: id => this._clearTimer(id),
                easeActor: (actor, params) => this._easeActor(actor, params),
                onMarkBackgroundDirty: () => {
                    if (this._panel) {
                        this._panel.hasPendingBackgroundRender = true;
                        this._updateAiTabBadge();
                    }
                },
                onScrollBottom: (force, animate) => this._panel?.scrollBottom(force, animate),
                onRetryAssistantCard: card => this._retryForAssistantCard(card),
                onContinueAssistantCard: card => this._continueForAssistantCard(card),
                onEditUserCard: card => this._beginEditUserCard(card),
            });

            this._modelPicker = new ModelPickerController({
                settings: this._settings,
                registry: this._registry,
                getEffectiveBackend: () => this._getEffectiveBackend(),
                getActiveRuntimeInfo: () => {
                    const state = this._chatController?.lastState;
                    return this._chatController?.ready && state
                        ? {
                            modelId: state.model?.modelId || '',
                            providerId: state.model?.provider || '',
                            capabilities: state.capabilities || null,
                        }
                        : {};
                },
                getClient: () => this._chatController?.client || null,
                isExtensionAlive: () => this._isSessionUnlockedAndAlive(lifeGen),
                onNudgeLayout: () => this._dateIntegration?.nudgeLayout(),
                onOpenPreferences: () => this._openExtensionPreferences(),
                getCurrentResolvedModel: () => this._modelLabel || '',
                getAvailableBackends: () => this._cachedAvailableBackends,
            });

            this._panel = new ChatPanelView({
                cardFactory: this._cardFactory,
                modelPicker: this._modelPicker,
                getSettingString: (k, fb) => this._getSettingString(k, fb),
                getSettingInt: (k, fb) => this._getSettingInt(k, fb),
                isAnimEnabled: () => this._animEnabled(),
                isChatVisible: () => this._isChatVisible(),
                getEffectiveBackend: () => this._getEffectiveBackend(),
                getEffectiveMode: () => this._registry?.getBackendProfile(this._getEffectiveBackend()).mode || 'readonly',
                getLiveCard: () => this._live,
                isBusy: () => Boolean(this._chatController?.busy),
                scheduleTimeout: (ms, fn) => this._scheduleTimeout(ms, fn),
                scheduleIdle: fn => this._scheduleIdle(fn),
                clearTimer: id => this._clearTimer(id),
                easeActor: (actor, params) => this._easeActor(actor, params),
                onSelectTab: () => this._showChat(),
                onReconnectNow: () => this._reconnectNow(),
                onOpenPreferences: () => this._openExtensionPreferences(),
                onClipboardAsk: openFirst => this._triggerClipboardAsk(openFirst),
                onAttachFileButton: () => this._panel?.toggleFileAttachBar(),
                onAttachPathSubmit: (rawPath, opts) => this._attachLocalFilePath(rawPath, opts),
                onRemoveAttachment: id => this._removeAttachment(id),
                onToggleAttachmentPreview: id => this._toggleAttachmentPreview(id),
                onToggleAttachmentFileMode: id => this._toggleAttachmentFileMode(id),
                onNewSession: () => this._newSession(),
                onRefreshSessionMenuState: () => this._refreshSessionMenuState(),
                onRestorePreviousSession: sid => this._restoreSessionById(sid),
                onExportSession: () => this._exportCurrentSession(),
                onDeleteCurrentSession: () => this._deleteCurrentSession(),
                onApproveRetentionCleanup: ids => this._approveRetentionCleanup(ids),
                onCancelEditQuestion: () => this._cancelEditQuestion(),
                onApplyRouteSuggestion: suggestion => this._applyRouteSuggestion(suggestion),
                onDismissRouteSuggestion: suggestion => this._dismissRouteSuggestion(suggestion),
                onSend: () => this._send(),
                onAbort: () => this._abort(),
                onEntryKeyPress: event => this._onEntryKeyPress(event),
                onEntryTextChanged: text => this._onEntryTextChanged(text),
                onDismissMigrationNotice: () => this._modelPicker?.dismissMigrationNotice(),
                onLoadOlderArchivePage: pageSize => this._loadOlderArchivePage(pageSize),
                onCopyDiagnosticsReport: () => this._copyDiagnosticsReport(),
                onRetrySaveSession: () => this._retrySaveSession(),
                onUndoLastRewind: () => this._undoLastRewind(),
                onSwitchToAgentBackendForPath: () => this._switchToAgentBackendForPath(),
            });

            const wrapper = this._panel.build();
            wrapper.connect('destroy', () => this._onPanelDestroyed(lifeGen));
            if (!this._dateIntegration.mount(wrapper)) {
                console.warn('[Quick Chat] Panel mount unavailable: ' + this._dateIntegration.lastMountError);
                this.disable();
                return;
            }
            this._syncDiagnosticsSnapshot({mountMode: this._dateIntegration.mountMode});
            this._showChat(false);

            const hostMenu = this._dateIntegration.menu;
            if (hostMenu) {
                this._menuSignal = hostMenu.connect('open-state-changed', (_, open) => {
                    if (!this._isSessionUnlockedAndAlive(lifeGen)) return;
                    if (open) {
                        this._panel?.syncThemeStyle(this._interfaceSettings);
                        if (this._tab === 'ai') {
                            this._panel?.flushPendingBackgroundWork({isAiTabOpenAndVisible: true});
                            if (this._chatController?.client) {
                                const gen = this._chatController.clientGeneration;
                                const curBaseUrl = this._getSettingString('openai-base-url', '').trim();
                                loadOpenAIApiKey(this._settings, curBaseUrl).then(k => {
                                    if (
                                        this._isSessionUnlockedAndAlive(lifeGen) &&
                                        this._chatController?.clientGeneration === gen
                                    ) {
                                        this._chatController.client?.updateApiKey?.(k);
                                    }
                                }).catch(() => {});
                            }
                            this._ensureClient();
                            this._scheduleTimeout(40, () => {
                                if (this._isSessionUnlockedAndAlive(lifeGen) && this._tab === 'ai') {
                                    this._panel?.entry?.grab_key_focus();
                                }
                            });
                        } else {
                            this._updateAiTabBadge();
                        }
                    } else {
                        if (this._modelPicker?.isOpen) {
                            this._modelPicker.toggle(false);
                        }
                        if (this._panel?.isSessionMenuOpen) {
                            this._panel.toggleSessionMenu(false);
                        }
                        this._panel?.closeSlashMenu();
                    }
                });
            }

            this._sessionSignal = Main.sessionMode.connect('updated', () => this._onSessionModeUpdated(lifeGen));
            this._connectSettingsSignals();
            this._registerGlobalKeybindings();
            this._panel.syncThemeStyle(this._interfaceSettings);
            this._panel.applyDimensions();
            this._refreshAvailableBackendsAsync();
        } catch (err) {
            console.error('[Quick Chat] enable() failed, rolling back cleanly:', err);
            this.disable();
        }
    }

    _onPanelDestroyed(lifeGen) {
        if (!this._enabled || this._lifecycleGeneration !== lifeGen) return;
        // Shell may destroy its actor tree before dispatching pending sources
        // in the nested main loop used to finish shutdown.
        this._panelDestroyed = true;
        this._panel = null;
        this._live = null;
        this._sessionSwitchInFlight = false;
        this._cancelScheduledWork();
        this._chatController?.stopClient();
        this._modelPicker?.dispose();
    }

    _onSessionModeUpdated(lifeGen) {
        if (!this._enabled || this._lifecycleGeneration !== lifeGen) return;
        // Never expose transcript, pending attachments, or approved session scopes across lock screen / greeter.
        if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter) {
            this._capsule?.reset();
            this._dateIntegration?.menu?.close();
            this._sessionSwitchInFlight = false;
            this._notifGate?.onLockScreenEntered?.();
            if (this._modelPicker?.isOpen) this._modelPicker.toggle(false);
            this._panel?.toggleSessionMenu(false);
            this._panel?.toggleFileAttachBar(false);
            this._panel?.closeSlashMenu();
            this._panel?.setRouteSuggestion(null);
            this._cancelEditQuestion({keepEntry: true});
            this._attachments?.clear();
            this._panel?.renderAttachments([], '');
            this._panel?.wrapper?.hide();
            this._live = null;
            this._chatController?.stopClient();
            this._setBusy(false);
        } else {
            this._panel?.wrapper?.show();
            this._showChat(false);
        }
    }

    _isSessionUnlockedAndAlive(expectedLifeGen = this._lifecycleGeneration) {
        return Boolean(
            this._enabled &&
            !this._panelDestroyed &&
            this._lifecycleGeneration === expectedLifeGen &&
            !Main.sessionMode.isLocked &&
            !Main.sessionMode.isGreeter
        );
    }

    _hasKey(key) {
        return Boolean(this._settings?.settings_schema?.has_key?.(key));
    }

    _getSettingString(key, fallback = '') {
        return this._hasKey(key) ? this._settings.get_string(key) : fallback;
    }

    _getSettingInt(key, fallback = 0) {
        return this._hasKey(key) ? this._settings.get_int(key) : fallback;
    }

    _getSettingBool(key, fallback = true) {
        return this._hasKey(key) ? this._settings.get_boolean(key) : fallback;
    }

    _getSettingStrv(key) {
        return this._hasKey(key) ? (this._settings.get_strv(key) || []) : [];
    }

    _animEnabled() {
        return this._getSettingBool('enable-animations', true);
    }

    _markdownEnabled() {
        return this._getSettingBool('render-markdown', true);
    }

    _isChatVisible() {
        return Boolean(
            this._isSessionUnlockedAndAlive() &&
            this._dateIntegration?.menu?.isOpen &&
            this._tab === 'ai'
        );
    }

    _getEffectiveBackend() {
        const configured = this._getSettingString('backend', 'auto');
        const confirmed = this._chatController?.ready ? this._chatController.lastState?.backend : '';
        // Prefer the connected runtime over the cold-cache placeholder; explicit
        // switching to another backend still shows the newly selected engine.
        if (confirmed && (configured === 'auto' || confirmed === configured)) {
            return confirmed;
        }
        return detectEffectiveBackend({
            configuredBackend: configured,
            zcodePath: this._getSettingString('zcode-path', ''),
            codexPath: this._getSettingString('codex-path', ''),
            dshPath: this._getSettingString('dsh-path', ''),
            openaiBaseUrl: this._getSettingString('openai-base-url', ''),
        });
    }

    _scheduleTimeout(ms, fn) {
        if (!this._enabled || this._panelDestroyed || !this._timers) return 0;
        const lifeGen = this._lifecycleGeneration;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers?.delete(id);
            if (this._enabled && this._lifecycleGeneration === lifeGen) {
                fn();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return id;
    }

    _scheduleIdle(fn) {
        if (!this._enabled || this._panelDestroyed || !this._timers) return 0;
        const lifeGen = this._lifecycleGeneration;
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._timers?.delete(id);
            if (this._isSessionUnlockedAndAlive(lifeGen)) {
                fn();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return id;
    }

    _cancelScheduledWork() {
        for (const timerId of this._timers || []) {
            try { GLib.source_remove(timerId); } catch (_) {}
        }
        this._timers?.clear();
    }

    _clearTimer(id) {
        if (id && this._timers?.has(id)) {
            try { GLib.source_remove(id); } catch (_) {}
            this._timers.delete(id);
        }
    }

    _easeActor(actor, params) {
        if (!actor) return;
        try { actor.remove_all_transitions?.(); } catch (_) {}
        if (!this._animEnabled() || !actor.ease) {
            const {duration: _d, mode: _m, delay: _dl, repeatCount: _r, autoReverse: _ar, onComplete, ...rest} = params;
            try { actor.set(rest); } catch (_) {}
            onComplete?.();
            return;
        }
        try {
            const p = actor.ease(params);
            p?.catch?.(() => {});
        } catch (_) {}
    }

    _openExtensionPreferences() {
        this._dateIntegration?.menu?.close?.();
        this.openPreferences();
    }

    _updateAiTabBadge() {
        this._panel?.updateAiTabBadge({
            isAiTabOpenAndVisible: Boolean(this._tab === 'ai' && this._dateIntegration?.menu?.isOpen),
        });
    }

    _setBusy(busy) {
        if (this._chatController) {
            this._chatController.busy = Boolean(busy);
        }
        this._panel?.setBusyVisual(Boolean(busy));
        this._updateAiTabBadge();
    }

    _registerGlobalKeybindings() {
        this._unregisterGlobalKeybindings();
        const addBinding = (keyName, handler,
            actionMode = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP) => {
            if (!this._hasKey(keyName)) return;
            const shortcuts = this._settings.get_strv(keyName);
            if (!shortcuts || !shortcuts.length || !shortcuts[0]) return;
            try {
                Main.wm.addKeybinding(
                    keyName,
                    this._settings,
                    Meta.KeyBindingFlags.NONE,
                    actionMode,
                    handler
                );
                this._registeredKeybindings.add(keyName);
            } catch (err) {
                console.warn(`[Quick Chat] Failed to bind ${keyName}: ${err.message}`);
            }
        };

        addBinding('toggle-shortcut', () => this._toggleQuickChatPanel());
        addBinding('clipboard-shortcut', () => this._triggerClipboardAsk(true));
        if (this._hasKey('enable-experimental-capsule') &&
            this._settings.get_boolean('enable-experimental-capsule')) {
            addBinding('capsule-shortcut', () => this._toggleCapsule(), Shell.ActionMode.NORMAL);
        }
    }

    _unregisterGlobalKeybindings() {
        for (const keyName of this._registeredKeybindings || []) {
            try { Main.wm.removeKeybinding(keyName); } catch (_) {}
        }
        this._registeredKeybindings?.clear();
    }

    _toggleCapsule() {
        if (!this._isSessionUnlockedAndAlive()) return;
        if (!this._settings?.get_boolean('enable-experimental-capsule')) return;
        this._capsule ??= new CapsuleView({
            onSubmit: text => this._sendCapsuleQuestion(text),
            onExpand: () => this._toggleQuickChatPanel(),
        });
        try {
            if (!this._capsule.visible) this._dateIntegration?.menu?.close();
            this._capsule.toggle();
        } catch (err) {
            console.warn('[Quick Chat] Capsule unavailable: ' + err.message);
            this._capsule.dispose();
            this._capsule = null;
        }
    }

    _sendCapsuleQuestion(text) {
        if (!this._isSessionUnlockedAndAlive() || this._isBusyOrMutating()) {
            this._capsule?.fail('当前有任务正在执行，请稍后再试');
            return Promise.resolve(null);
        }
        // Capsule input is separate from the main composer, so the latter's
        // unsent draft and pending attachments are never silently included.
        return this._executePromptTurn({
            promptText: text,
            displayUserText: text,
            recordHistoryText: text,
            clearEntry: false,
            clearAttachments: false,
            capsule: this._capsule,
        });
    }

    _toggleQuickChatPanel() {
        if (!this._isSessionUnlockedAndAlive()) return;
        this._capsule?.hide();
        const menu = this._dateIntegration?.menu;
        if (!menu) return;
        if (menu.isOpen && this._tab === 'ai') {
            menu.close();
            return;
        }
        if (!menu.isOpen) {
            menu.open(true);
        }
        this._showChat();
        this._scheduleTimeout(50, () => {
            if (this._isSessionUnlockedAndAlive() && this._tab === 'ai') {
                this._panel?.entry?.grab_key_focus();
            }
        });
    }

    _refreshAttachmentBarUi() {
        if (!this._panel || !this._attachments) return;
        const eff = this._getEffectiveBackend();
        const endpointUrl = this._getSettingString('openai-base-url', '').trim();
        const draftText = this._panel.entry?.get_text() || '';
        const notice = this._attachments.buildOutboundScopeNotice(eff, {
            endpointUrl,
            modelLabel: this._modelLabel || '',
            draftText,
        });
        const pureApiActionDesc = describePathOnlyPureApiActions(this._attachments.items, eff);
        this._panel.renderAttachments(this._attachments.items, notice, {pureApiActionDesc});
        this._updateLocalRouteSuggestion(draftText);
    }

    _removeAttachment(id) {
        if (!this._attachments) return;
        this._attachments.remove(id);
        this._refreshAttachmentBarUi();
    }

    _toggleAttachmentPreview(id) {
        if (!this._attachments) return;
        this._attachments.togglePreview(id);
        this._refreshAttachmentBarUi();
    }

    async _toggleAttachmentFileMode(id) {
        if (!this._attachments) return;
        const eff = this._getEffectiveBackend();
        const res = this._attachments.toggleFileMode(id, {
            effectiveBackend: eff,
        });
        if (!res.ok && res.needsAsyncContentRead && res.filePath) {
            const lifeGen = this._lifecycleGeneration;
            const initialSessionId = this._chatController?.currentSessionId || this._getSettingString('session-id', '');
            const cancellable = new Gio.Cancellable();
            const readGuard = this._attachments.beginReadGuard({
                sessionId: initialSessionId,
                cancellable,
            });
            try {
                const readRes = await readFileBytesBoundedAsync(res.filePath, MAX_ATTACHMENT_FILE_BYTES, cancellable);
                const nowSessionId = this._chatController?.currentSessionId || this._getSettingString('session-id', '');
                if (
                    !this._isSessionUnlockedAndAlive(lifeGen) ||
                    !this._attachments ||
                    !readGuard.isValid({currentSessionId: nowSessionId}) ||
                    readRes.cancelled
                ) {
                    return;
                }
                const upgraded = this._attachments.upgradePathAttachmentToContent(id, {
                    bytes: readRes.bytes,
                    fileSize: readRes.byteLength,
                    tooLarge: readRes.tooLarge,
                    nonRegular: readRes.nonRegular,
                    effectiveBackend: this._getEffectiveBackend(),
                });
                if (!upgraded.ok && upgraded.error) {
                    this._panel?.setStatusIndicator('error', `⚠️ ${upgraded.error}`);
                } else if (!this._chatController?.busy) {
                    this._panel?.setStatusIndicator('ready', '✓ 已读取本地文件正文作为引用');
                }
                this._refreshAttachmentBarUi();
            } finally {
                readGuard.finish();
            }
            return;
        }
        if (!res.ok && res.error) {
            this._panel?.setStatusIndicator('error', `⚠️ ${res.error}`);
        } else if (res.warning && !this._chatController?.busy) {
            this._panel?.setStatusIndicator('ready', `ℹ️ ${res.warning}`);
        }
        this._refreshAttachmentBarUi();
    }

    _switchToAgentBackendForPath() {
        if (!this._registry || this._chatController?.busy) return;
        const avail = this._cachedAvailableBackends || new Set();
        const targetBackend = avail.has('zcode')
            ? 'zcode'
            : avail.has('codex')
                ? 'codex'
                : 'zcode';
        const curProfile = this._registry.getBackendProfile(targetBackend);
        const safeMode = clampSafeRecommendedMode(targetBackend, curProfile.mode || 'readonly');
        this._registry.updateBackendProfile(targetBackend, {mode: safeMode});
        this._registry.selectBackend(targetBackend);
        this._refreshAttachmentBarUi();
    }

    async _attachLocalFilePath(rawPath, {preferPathOnly = false, sourceOrigin = '手动附加文件'} = {}) {
        if (!this._isSessionUnlockedAndAlive() || !this._attachments) return false;
        const lifeGen = this._lifecycleGeneration;
        const initialSessionId = this._chatController?.currentSessionId || this._getSettingString('session-id', '');
        const home = GLib.get_home_dir() || '';
        const expanded = expandHomePath(String(rawPath || '').trim(), home);
        if (!expanded || !expanded.startsWith('/')) {
            this._panel?.setStatusIndicator('error', '⚠️ 请输入有效的本地绝对路径（支持 ~/ 开头）');
            return false;
        }
        if (!GLib.file_test(expanded, GLib.FileTest.EXISTS)) {
            this._panel?.setStatusIndicator('error', `⚠️ 文件或目录不存在：${expanded}`);
            return false;
        }

        const effectiveBackend = this._getEffectiveBackend();

        if (GLib.file_test(expanded, GLib.FileTest.IS_DIR)) {
            const dirRes = this._attachments.addFileCandidate({
                filePath: expanded,
                exists: true,
                isDirectory: true,
                sourceOrigin,
                effectiveBackend,
            });
            if (!dirRes.ok) {
                this._panel?.setStatusIndicator('error', `⚠️ ${dirRes.error}`);
                return false;
            }
            this._panel?.toggleFileAttachBar(false);
            this._refreshAttachmentBarUi();
            if (dirRes.item?.warning && !this._chatController?.busy) {
                this._panel?.setStatusIndicator('ready', `ℹ️ ${dirRes.item.warning}`);
            }
            return true;
        }

        const cancellable = new Gio.Cancellable();
        const readGuard = this._attachments.beginReadGuard({
            sessionId: initialSessionId,
            cancellable,
        });
        const isReadStillValid = () => {
            const nowSessionId = this._chatController?.currentSessionId || this._getSettingString('session-id', '');
            return Boolean(
                this._isSessionUnlockedAndAlive(lifeGen) &&
                this._attachments &&
                readGuard.isValid({currentSessionId: nowSessionId})
            );
        };

        try {
            let fileSize = 0;
            try {
                const info = await new Promise(resolve => {
                    Gio.File.new_for_path(expanded).query_info_async(
                        'standard::size,standard::type',
                        Gio.FileQueryInfoFlags.NONE,
                        GLib.PRIORITY_DEFAULT,
                        cancellable,
                        (f, r) => {
                            try { resolve(f.query_info_finish(r)); } catch (_) { resolve(null); }
                        }
                    );
                });
                fileSize = Number(info?.get_size?.() || 0);
            } catch (_) {}

            if (!isReadStillValid()) return false;

            let readRes = {exists: true, tooLarge: fileSize > MAX_ATTACHMENT_FILE_BYTES, bytes: null};
            if (!preferPathOnly && !readRes.tooLarge) {
                readRes = await readFileBytesBoundedAsync(expanded, MAX_ATTACHMENT_FILE_BYTES, cancellable);
                if (!isReadStillValid() || readRes.cancelled) return false;
            }

            if (readRes.nonRegular) {
                this._panel?.setStatusIndicator('error', `⚠️ ${readRes.error || '不支持附加特殊文件（FIFO/设备/Socket）'}`);
                return false;
            }

            const added = this._attachments.addFileCandidate({
                filePath: expanded,
                fileSize: readRes.byteLength || fileSize,
                exists: readRes.exists,
                isDirectory: false,
                nonRegular: Boolean(readRes.nonRegular),
                tooLarge: readRes.tooLarge,
                bytes: readRes.bytes,
                preferPathOnly,
                sourceOrigin,
                effectiveBackend: this._getEffectiveBackend(),
            });

            if (!added.ok) {
                this._panel?.setStatusIndicator('error', `⚠️ ${added.error}`);
                return false;
            }

            this._panel?.toggleFileAttachBar(false);
            this._refreshAttachmentBarUi();
            if (added.item?.warning && !this._chatController?.busy) {
                this._panel?.setStatusIndicator('ready', `ℹ️ ${added.item.warning}`);
            }
            return true;
        } finally {
            readGuard.finish();
        }
    }

    _triggerClipboardAsk(openPanelFirst = true) {
        if (!this._isSessionUnlockedAndAlive() || !this._attachments) return;
        const lifeGen = this._lifecycleGeneration;
        const initialSessionId = this._chatController?.currentSessionId || this._getSettingString('session-id', '');
        const clipGuard = this._attachments.beginReadGuard({sessionId: initialSessionId});
        const menu = this._dateIntegration?.menu;
        if (openPanelFirst && menu && !menu.isOpen) {
            menu.open(true);
        }
        if (this._tab !== 'ai') {
            this._showChat();
        }

        const clip = St.Clipboard.get_default();
        const isAlive = () => {
            const nowSessionId = this._chatController?.currentSessionId || this._getSettingString('session-id', '');
            return Boolean(
                this._isSessionUnlockedAndAlive(lifeGen) &&
                this._panel?.entry &&
                this._attachments &&
                clipGuard.isValid({currentSessionId: nowSessionId})
            );
        };

        const attachClipboardContent = async (raw, {fromPrimarySelection = false} = {}) => {
            try {
                const trimmed = String(raw || '').trim();
                if (!trimmed || !isAlive()) return;

                // Check if user copied files in Nautilus (`file://` URIs or explicit path lines)
                const copiedPaths = extractCopiedFilePaths(trimmed).filter(p => GLib.file_test(p, GLib.FileTest.EXISTS));
                if (copiedPaths.length > 0) {
                    for (const fp of copiedPaths) {
                        if (!isAlive()) return;
                        await this._attachLocalFilePath(fp, {
                            preferPathOnly: false,
                            sourceOrigin: 'Nautilus 选中文件',
                        });
                    }
                    this._panel?.entry?.grab_key_focus();
                    return;
                }

                // Attach text / terminal log snippet independently WITHOUT overwriting entry draft or truncating at 4000 chars!
                const res = this._attachments.addTextSnippet(trimmed, {fromPrimarySelection});
                if (!res.ok) {
                    this._panel?.setStatusIndicator('error', `⚠️ ${res.error}`);
                } else {
                    this._refreshAttachmentBarUi();
                }
                this._panel?.entry?.grab_key_focus();
            } finally {
                clipGuard.finish();
            }
        };

        clip.get_text(St.ClipboardType.CLIPBOARD, (_, text) => {
            if (!isAlive()) {
                clipGuard.finish();
                return;
            }
            if (text && text.trim()) {
                attachClipboardContent(text, {fromPrimarySelection: false});
                return;
            }
            clip.get_text(St.ClipboardType.PRIMARY, (__, primaryText) => {
                if (!isAlive()) {
                    clipGuard.finish();
                    return;
                }
                if (primaryText && primaryText.trim()) {
                    attachClipboardContent(primaryText, {fromPrimarySelection: true});
                } else {
                    clipGuard.finish();
                    this._panel?.entry?.grab_key_focus();
                }
            });
        });
    }

    async _refreshAvailableBackendsAsync() {
        const lifeGen = this._lifecycleGeneration;
        if (!this._enabled) return;
        const zcodePath = this._getSettingString('zcode-path', '');
        const codexPath = this._getSettingString('codex-path', '');
        const dshPath = this._getSettingString('dsh-path', '');
        const openaiBaseUrl = this._getSettingString('openai-base-url', '').trim();
        try {
            const [zSel, cSel, dSel] = await Promise.all([
                detectBackendSelectionAsync({configuredBackend: 'zcode', zcodePath, codexPath, dshPath, openaiBaseUrl}),
                detectBackendSelectionAsync({configuredBackend: 'codex', zcodePath, codexPath, dshPath, openaiBaseUrl}),
                detectBackendSelectionAsync({configuredBackend: 'dsh', zcodePath, codexPath, dshPath, openaiBaseUrl}),
            ]);
            if (!this._isSessionUnlockedAndAlive(lifeGen)) return;
            const nextSet = new Set();
            if (zSel?.available) nextSet.add('zcode');
            if (cSel?.available) nextSet.add('codex');
            if (dSel?.available) nextSet.add('dsh');
            if (openaiBaseUrl) nextSet.add('openai');
            this._cachedAvailableBackends = nextSet;
            this._updateLocalRouteSuggestion(this._panel?.entry?.get_text() || '');
        } catch (_) {}
    }

    _onEntryTextChanged(text) {
        this._updateLocalRouteSuggestion(text);
    }

    _updateLocalRouteSuggestion(draftText = '') {
        if (!this._panel || !this._registry) return;
        if (!this._getSettingBool('enable-model-routing', false) || this._chatController?.busy) {
            this._panel.setRouteSuggestion(null);
            return;
        }
        const avail = new Set(this._cachedAvailableBackends || []);
        if (this._getSettingString('openai-base-url', '').trim()) avail.add('openai');
        else avail.delete('openai');

        const eff = this._getEffectiveBackend();
        if (eff !== 'unconfigured') avail.add(eff);
        const curProfile = this._registry.getBackendProfile(eff);

        const suggestion = recommendRouteLocally({
            promptText: draftText,
            attachments: this._attachments?.items || [],
            currentBackend: eff,
            currentModel: curProfile.model || '',
            currentMode: curProfile.mode || 'readonly',
            currentEffort: curProfile.reasoningEffort || 'default',
            availableBackends: Array.from(avail),
            profiles: {
                zcode: this._registry.getBackendProfile('zcode'),
                codex: this._registry.getBackendProfile('codex'),
                dsh: this._registry.getBackendProfile('dsh'),
                openai: this._registry.getBackendProfile('openai'),
            },
            dismissedKeys: this._dismissedRouteKeys,
        });
        this._panel.setRouteSuggestion(suggestion);
    }

    _applyRouteSuggestion(suggestion) {
        if (!suggestion || !this._registry || this._chatController?.busy) return;
        const targetBackend = suggestion.targetBackend;
        if (!['zcode', 'codex', 'dsh', 'openai'].includes(targetBackend)) return;

        // Hard security rule (Stage F6): NEVER auto-enable `full` or expand file/command scopes!
        const safeMode = clampSafeRecommendedMode(targetBackend, suggestion.targetMode);
        const curMode = this._registry.getBackendProfile(targetBackend).mode || 'readonly';
        const effectiveAppliedMode = curMode === 'chat' && targetBackend === 'zcode'
            ? safeMode
            : clampSafeRecommendedMode(targetBackend, safeMode);

        this._registry.updateBackendProfile(targetBackend, {
            mode: effectiveAppliedMode,
            reasoningEffort: suggestion.targetEffort || 'default',
            ...(suggestion.targetModel ? {model: suggestion.targetModel} : {}),
        });
        this._registry.selectBackend(targetBackend);
        this._panel?.setRouteSuggestion(null);
    }

    _dismissRouteSuggestion(suggestion) {
        if (suggestion?.signature) {
            this._dismissedRouteKeys?.add(suggestion.signature);
        }
        this._panel?.setRouteSuggestion(null);
    }

    _connectSettingsSignals() {
        this._settingSignals = [];
        const watch = (key, fn) => {
            if (this._hasKey(key)) {
                this._settingSignals.push(this._settings.connect(`changed::${key}`, fn));
            }
        };

        watch('panel-width', () => this._panel?.applyDimensions());
        watch('panel-height', () => this._panel?.applyDimensions());
        watch('render-markdown', () => this._panel?.rerenderAllMessages());
        watch('toggle-shortcut', () => this._registerGlobalKeybindings());
        watch('clipboard-shortcut', () => this._registerGlobalKeybindings());
        watch('capsule-shortcut', () => this._registerGlobalKeybindings());
        watch('enable-experimental-capsule', () => {
            this._capsule?.dispose();
            this._capsule = null;
            this._registerGlobalKeybindings();
        });
        watch('migration-notice', () => {
            if (this._enabled && !this._panel?.mountedCards?.length) {
                this._panel?.buildEmptyState();
            }
        });
        watch('quick-prompts-json', () => {
            if (!this._enabled) return;
            if (!this._panel?.mountedCards?.length) {
                this._panel?.buildEmptyState();
            }
            if (this._panel?.isSlashMenuOpen) {
                this._panel.refreshSlashMenuForText(this._panel.entry?.get_text() || '');
            }
        });
        watch('enable-model-routing', () => {
            if (this._enabled) {
                this._updateLocalRouteSuggestion(this._panel?.entry?.get_text() || '');
            }
        });

        const scopeBoundaryKeys = new Set([
            'backend',
            'workspace',
            'zcode-workspace',
            'codex-workspace',
            'dsh-workspace',
            'dsh-agent-mode',
            'dsh-auto-review',
            'agent-mode',
            'zcode-agent-mode',
            'codex-agent-mode',
            'session-id',
        ]);
        const cacheInvalidateKeys = new Set([
            'backend',
            'zcode-path',
            'codex-path',
            'dsh-path',
            'openai-base-url',
        ]);

        const onBackendConfigChanged = keyName => {
            if (!this._enabled) return;
            if (keyName === 'session-id') {
                const sessionId = this._getSettingString('session-id', '');
                if (sessionId === this._observedSessionId) return;
                this._observedSessionId = sessionId;
            }
            this._registry?.bumpGeneration();
            if (cacheInvalidateKeys.has(keyName)) {
                invalidateBackendDetectionCaches();
                this._refreshAvailableBackendsAsync();
            }
            if (keyName !== 'session-id' && !this._panel?.mountedCards?.length) {
                this._panel?.buildEmptyState();
            }
            this._refreshAttachmentBarUi();
            this._chatController?.scheduleConfigReconnect({
                debounceMs: 60,
                revokeScopes: scopeBoundaryKeys.has(keyName),
                isLocked: Boolean(Main.sessionMode.isLocked || Main.sessionMode.isGreeter),
            });
        };

        for (const key of [
            'backend',
            'zcode-path',
            'codex-path',
            'provider',
            'model',
            'zcode-provider',
            'zcode-model',
            'zcode-reasoning-effort',
            'zcode-workspace',
            'zcode-agent-mode',
            'codex-provider',
            'codex-model',
            'codex-reasoning-effort',
            'codex-workspace',
            'codex-agent-mode',
            'dsh-path',
            'dsh-workspace',
            'dsh-agent-mode',
            'dsh-auto-review',
            'dsh-provider',
            'dsh-model',
            'desktop-assistant-prompt',
            'shared-memory-backends',
            'openai-base-url',
            'openai-api-key',
            'openai-model',
            'openai-reasoning-effort',
            'system-prompt',
            'reasoning-effort',
            'agent-mode',
            'workspace',
            'session-id',
        ]) {
            watch(key, () => onBackendConfigChanged(key));
        }

        try {
            this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            this._themeSig1 = this._interfaceSettings.connect('changed::color-scheme', () =>
                this._panel?.syncThemeStyle(this._interfaceSettings)
            );
            this._themeSig2 = this._interfaceSettings.connect('changed::gtk-theme', () =>
                this._panel?.syncThemeStyle(this._interfaceSettings)
            );
        } catch (_) {}
    }

    _showChat(connect = true) {
        if (!this._panel?.wrapper) return;

        this._panel.flushPendingBackgroundWork({
            isAiTabOpenAndVisible: Boolean(this._dateIntegration?.menu?.isOpen),
        });
        if (connect) {
            this._ensureClient();
            this._panel.entry?.grab_key_focus();
        }
    }

    _setSessionId(sessionId) {
        const previous = this._observedSessionId;
        this._observedSessionId = sessionId;
        if (this._settings.set_string('session-id', sessionId)) return;
        this._observedSessionId = previous;
        throw new Error('无法保存会话 ID');
    }

    async _loadRuntimeEnvironment({cancellable = null} = {}) {
        const lifeGen = this._lifecycleGeneration;
        const assertCurrent = () => {
            if (cancellable?.is_cancelled() || !this._isSessionUnlockedAndAlive(lifeGen)) {
                throw new Error('连接已取消');
            }
        };
        const openaiBaseUrl = this._getSettingString('openai-base-url', '').trim();
        const apiKey = await loadOpenAIApiKey(this._settings, openaiBaseUrl);
        assertCurrent();
        const selection = await detectBackendSelectionAsync({
            configuredBackend: this._getSettingString('backend', 'auto'),
            zcodePath: this._getSettingString('zcode-path', ''),
            codexPath: this._getSettingString('codex-path', ''),
            dshPath: this._getSettingString('dsh-path', ''),
            openaiBaseUrl,
        }, {cancellable});
        assertCurrent();
        const eff = selection?.effectiveBackend || 'unconfigured';
        const config = this._registry.buildRuntimeConfig(eff, {apiKey});

        const workspace = requireWorkspaceDirectory(config.workspace);

        let sessionId = this._getSettingString('session-id', '');
        try {
            sessionId = validateSessionId(sessionId);
        } catch (_) {
            sessionId = GLib.uuid_string_random();
            this._setSessionId(sessionId);
        }

        return {
            config,
            workspace,
            sessionsDir: getSessionsDir(),
            sessionId,
        };
    }

    _ensureClient() {
        if (!this._isSessionUnlockedAndAlive() || !this._panel?.chatBox || !this._chatController) {
            return Promise.resolve(null);
        }
        if (!this._chatController.ready && !this._chatController.client) {
            this._panel.setStatusIndicator('busy', '正在连接智能后端…');
        }
        return this._chatController.ensureConnected({
            canConnect: () => Boolean(this._isSessionUnlockedAndAlive() && this._panel?.chatBox),
        });
    }

    _reconnectNow() {
        if (!this._isSessionUnlockedAndAlive() || this._chatController?.busy) return Promise.resolve(null);
        this._panel?.setStatusIndicator('busy', '正在重新连接智能后端…');
        return this._chatController.reconnectNow({
            canConnect: () => Boolean(this._isSessionUnlockedAndAlive() && this._panel?.chatBox),
        });
    }

    async _loadOlderArchivePage(pageSize = 20) {
        if (!this._isSessionUnlockedAndAlive() || !this._chatController?.client || !this._panel?.historyWindow) {
            return null;
        }
        const beforeIndex = Number(this._panel.historyWindow.externalArchivedCount || 0);
        if (beforeIndex <= 0) return null;
        try {
            const data = await this._chatController.client.request('get_archive_page', {
                beforeIndex,
                limit: pageSize,
            });
            return {
                messages: detailedMessages(data?.messages || []),
                olderRemainingCount: Number(data?.olderRemainingCount ?? 0),
                pageStartIndex: Number(data?.pageStartIndex ?? 0),
                pageEndIndex: Number(data?.pageEndIndex ?? 0),
            };
        } catch (_) {
            return null;
        }
    }

    _onClientStateReady({state, messages, config}) {
        this._live = null;
        this._panel?.renderInitialHistory(
            detailedMessages(messages),
            userText => this._recordPromptHistory(userText),
            {externalArchivedCount: Number(state?.archivedMessageCount || 0)}
        );
        this._refreshAttachmentBarUi();

        if (state.unconfigured || state.backend === 'unconfigured') {
            this._modelLabel = '未配置后端';
            this._idleStatus = '未配置后端';
            const reason = state.reason || '未检测到可用后端，请在设置（⚙）中配置';
            this._panel?.setStatusIndicator('error', reason);
            this._syncDiagnosticsSnapshot({
                configuredBackend: this._getSettingString('backend', 'auto'),
                effectiveBackend: 'unconfigured',
                cliVersion: '未检测到可用引擎',
                activeProvider: '无',
                activeModel: '未配置',
                effectiveMode: 'chat',
                capabilities: state.capabilities || getBackendCapabilities('unconfigured', 'chat'),
                bridgeHandshake: '不适用',
                lastConnectionError: reason,
                sessionSaveStatus: '正常',
                sessionSaveWarning: '',
                endpointSecurityNote: '',
            });
            this._setBusy(false);
            this._panel?.scrollBottom(true);
            return;
        }

        const backendTag = state.backend === 'openai'
            ? 'OpenAI API'
            : state.backend === 'codex'
                ? 'Codex'
                : state.backend === 'dsh'
                    ? 'DeepSeek Harness'
                    : 'ZCode';
        this._modelLabel = state.model?.id || config.model || backendTag;

        const effectiveMode = state.effectiveMode || config.mode;
        const caps = state.capabilities || getBackendCapabilities(state.backend, effectiveMode);
        const badge = caps.modeBadges?.[effectiveMode] || caps.modeBadges?.[config.mode] || '';
        const httpWarnSuffix = state.endpointSecurity?.isRemotePlaintextHttp ? ' · ⚠️明文HTTP' : '';
        this._idleStatus = (badge ? `${this._modelLabel} · ${badge}` : this._modelLabel) + httpWarnSuffix;

        const defaultBridgeDiag = state.backend === 'zcode'
            ? (this._diagState?.bridgeHandshake ||
                (state.bridgeAvailable ? '桥接脚本就绪（待首次任务启动验证握手）' : '⚠️ 未找到桥接脚本'))
            : '不适用（当前非 ZCode 后端）';
        this._syncDiagnosticsSnapshot({
            configuredBackend: this._getSettingString('backend', 'auto'),
            effectiveBackend: state.backend,
            cliVersion: state.cliVersion || (state.backend === 'openai' ? 'HTTP/SSE (Soup 3.0)' : '已探测 CLI'),
            activeProvider: state.model?.provider || config?.provider || (state.backend === 'openai' ? '自定义端点' : '默认'),
            activeModel: state.model?.modelId || this._modelLabel,
            effectiveMode,
            capabilities: caps,
            bridgeHandshake: defaultBridgeDiag,
            mountMode: this._dateIntegration?.mountMode || 'unmounted',
            lastConnectionError: '无',
            sessionSaveStatus: state.sessionUnsavedWarning || '正常',
            sessionSaveWarning: state.sessionUnsavedWarning || '',
            endpointSecurityNote: state.endpointSecurity?.warning || '',
        });

        if (state.sessionUnsavedWarning) {
            this._panel?.setStatusIndicator('error', `⚠️ ${state.sessionUnsavedWarning}`);
        } else {
            this._panel?.setStatusIndicator('ready', this._idleStatus);
        }
        this._canUndoLastRewind = Boolean(state.canUndoLastRewind);
        this._modelPicker?.refreshResultsOnly();
        this._setBusy(false);
        this._panel?.scrollBottom(true);
    }

    _recordPromptHistory(text) {
        const trimmed = String(text || '').trim();
        if (!trimmed) return;
        if (this._promptHistory.at(-1) !== trimmed) {
            this._promptHistory.push(trimmed);
            if (this._promptHistory.length > 50) this._promptHistory.shift();
        }
        this._historyIndex = -1;
    }

    _isBusyOrMutating() {
        return Boolean(this._chatController?.busy || this._sessionMutationLock || this._sessionSwitchInFlight);
    }

    _retryForAssistantCard(assistantCard) {
        if (this._isBusyOrMutating() || !this._panel?.historyWindow || !assistantCard) return;
        const retryInfo = this._panel.historyWindow.findRetryTurnInfoForCard(assistantCard);
        if (!retryInfo?.promptText) return;
        const cardKey = String(assistantCard.messageId || retryInfo.userMessageId || 'card');
        if (retryInfo.hadSideEffectTools && this._lastConfirmedSideEffectRetryCardId !== cardKey) {
            this._lastConfirmedSideEffectRetryCardId = cardKey;
            this._panel?.setStatusIndicator(
                'ready',
                '⚠️ 该回答曾执行写入或命令操作，为防重复副作用未自动重跑；再次点击「↻ 重试」确认重新生成'
            );
            return;
        }
        this._lastConfirmedSideEffectRetryCardId = '';
        this._executePromptTurn({
            promptText: retryInfo.promptText,
            displayUserText: retryInfo.displayText || retryInfo.promptText,
            rewindUserMessageId: retryInfo.userMessageId || '',
            reuseExistingUserCard: Boolean(retryInfo.userMessageId),
            userMessageId: retryInfo.userMessageId || '',
            userCreatedAt: retryInfo.createdAt || '',
            userTs: retryInfo.ts || 0,
            clearEntry: false,
            recordHistoryText: '',
        });
    }

    _continueForAssistantCard(assistantCard) {
        if (this._isBusyOrMutating() || !assistantCard?.text?.trim()) return;
        const contPrompt = buildContinuationPrompt(assistantCard.text);
        if (!contPrompt) return;
        this._executePromptTurn({
            promptText: contPrompt,
            displayUserText: '⤵ 继续生成上一段未完成的回答',
            clearEntry: false,
            recordHistoryText: '',
        });
    }

    _beginEditUserCard(userCard) {
        if (this._isBusyOrMutating() || !this._panel?.historyWindow || !userCard) return;
        const info = this._panel.historyWindow.findRetryTurnInfoForCard(userCard);
        if (!info?.promptText) return;
        this._editingTurnInfo = info;
        const editableQuestion = info.editableQuestionText || info.displayText || info.promptText;
        this._panel.setEditQuestionBanner(true, editableQuestion, {
            discardedCount: Number(info.discardedSubsequentCount || 0),
            hasPreservedAttachments: Boolean(info.hasPreservedAttachments),
            hadSideEffectTools: Boolean(info.hadSideEffectTools),
        });
        this._panel.setEntryTextProgrammatically(editableQuestion, {focus: true, cursorAtEnd: true});
    }

    _cancelEditQuestion({keepEntry = false} = {}) {
        const hadEdit = Boolean(this._editingTurnInfo);
        this._editingTurnInfo = null;
        this._panel?.setEditQuestionBanner(false);
        if (hadEdit && !keepEntry && this._panel?.entry) {
            this._panel.setEntryTextProgrammatically('', {focus: true, cursorAtEnd: true});
        }
    }

    _onEntryKeyPress(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;

        if (ctrl && (symbol === Clutter.KEY_slash || symbol === Clutter.KEY_question)) {
            this._panel?.refreshSlashMenuForText(this._panel.entry?.get_text() || '', {forceOpen: true});
            return Clutter.EVENT_STOP;
        }

        if (this._panel?.isSlashMenuOpen) {
            if (symbol === Clutter.KEY_Up) {
                this._panel.moveSlashSelection(-1);
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_Down) {
                this._panel.moveSlashSelection(1);
                return Clutter.EVENT_STOP;
            }
            if (
                symbol === Clutter.KEY_Tab ||
                symbol === Clutter.KEY_ISO_Left_Tab ||
                ((symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) && !shift)
            ) {
                // Stage F1: Tab / Enter on slash completion ONLY fills the input draft, never auto-sends!
                this._panel.acceptSlashSelection();
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_Escape) {
                this._panel.closeSlashMenu();
                return Clutter.EVENT_STOP;
            }
        }

        if (symbol === Clutter.KEY_Escape && this._chatController?.busy) {
            this._abort();
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Escape && this._editingTurnInfo && !this._chatController?.busy) {
            this._cancelEditQuestion();
            return Clutter.EVENT_STOP;
        }
        if (ctrl && (symbol === Clutter.KEY_n || symbol === Clutter.KEY_l) && !this._isBusyOrMutating()) {
            this._newSession();
            return Clutter.EVENT_STOP;
        }
        if ((symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) && !shift) {
            this._send();
            return Clutter.EVENT_STOP;
        }
        const entry = this._panel?.entry;
        if (!entry) return Clutter.EVENT_PROPAGATE;

        if (symbol === Clutter.KEY_Up && this._promptHistory.length > 0 && !shift && !ctrl) {
            const current = entry.get_text();
            if (this._historyIndex === -1 && current.trim().length > 0) {
                return Clutter.EVENT_PROPAGATE;
            }
            if (this._historyIndex === -1) {
                this._draftInput = current;
                this._historyIndex = this._promptHistory.length - 1;
            } else if (this._historyIndex > 0) {
                this._historyIndex--;
            }
            this._panel.setEntryTextProgrammatically(this._promptHistory[this._historyIndex] || '', {
                focus: false,
                cursorAtEnd: true,
            });
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Down && this._historyIndex !== -1 && !shift && !ctrl) {
            if (this._historyIndex < this._promptHistory.length - 1) {
                this._historyIndex++;
                this._panel.setEntryTextProgrammatically(this._promptHistory[this._historyIndex] || '', {
                    focus: false,
                    cursorAtEnd: true,
                });
            } else {
                this._historyIndex = -1;
                this._panel.setEntryTextProgrammatically(this._draftInput || '', {
                    focus: false,
                    cursorAtEnd: true,
                });
            }
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    async _send() {
        const entry = this._panel?.entry;
        if (!entry || !this._chatController || this._isBusyOrMutating()) return;
        const rawDraft = entry.get_text().trim();
        const hasAttachments = Boolean(this._attachments?.count > 0);
        const editTarget = this._editingTurnInfo;
        const hasEditAttachments = Boolean(!hasAttachments && editTarget?.hasPreservedAttachments);
        if (!rawDraft && !hasAttachments && !hasEditAttachments) return;

        if (!hasAttachments && !editTarget && isDefaultBrowserLaunchRequest(rawDraft)) {
            await this._launchDefaultBrowser(rawDraft);
            return;
        }

        const effectiveBackend = this._getEffectiveBackend();
        const attachmentSnapshot = this._attachments
            ? this._attachments.createSnapshot(rawDraft)
            : null;
        let payload;
        if (!hasAttachments && hasEditAttachments && typeof editTarget?.recomposePrompt === 'function') {
            payload = {
                hasAttachments: true,
                promptForModel: editTarget.recomposePrompt(rawDraft),
                displayUserText: typeof editTarget.recomposeDisplayText === 'function'
                    ? editTarget.recomposeDisplayText(rawDraft)
                    : rawDraft,
                overBudget: false,
            };
        } else {
            payload = this._attachments
                ? this._attachments.composeTurnPayload(rawDraft, {backend: effectiveBackend})
                : {hasAttachments: false, promptForModel: rawDraft, displayUserText: rawDraft, overBudget: false};
        }

        if (payload.overBudget) {
            this._panel?.setStatusIndicator(
                'error',
                `⚠️ ${payload.budgetWarning || '当前提问与引用附件超出上下文预算，请精简后重试'}`
            );
            return;
        }

        await this._executePromptTurn({
            promptText: payload.promptForModel,
            displayUserText: payload.displayUserText,
            rewindUserMessageId: editTarget?.userMessageId || '',
            reuseExistingUserCard: false,
            clearEntry: true,
            clearAttachments: hasAttachments,
            attachmentSnapshot,
            clearEditState: Boolean(editTarget),
            recordHistoryText: rawDraft,
            restoreDraftOnEarlyError: rawDraft,
        });
    }

    async _launchDefaultBrowser(draft) {
        if (this._browserLaunch || !this._isSessionUnlockedAndAlive()) return;
        const lifeGen = this._lifecycleGeneration;
        const sessionId = this._getSettingString('session-id', '');
        const token = this._browserLaunch = {};
        const draftIsCurrent = () => this._isSessionUnlockedAndAlive(lifeGen) &&
            this._getSettingString('session-id', '') === sessionId &&
            this._panel?.entry?.get_text().trim() === draft;
        try {
            const app = await new Promise((resolve, reject) => {
                Gio.AppInfo.get_default_for_uri_scheme_async('https', null, (_, result) => {
                    try { resolve(Gio.AppInfo.get_default_for_uri_scheme_finish(result)); }
                    catch (err) { reject(err); }
                });
            });
            if (!draftIsCurrent()) return;
            if (!app) throw new Error('系统未设置默认浏览器');
            const launchContext = global.create_app_launch_context(global.get_current_time(), -1);
            await new Promise((resolve, reject) => {
                app.launch_uris_async([], launchContext, null, (source, result) => {
                    try {
                        if (!source.launch_uris_finish(result)) throw new Error('桌面拒绝了浏览器启动请求');
                        resolve();
                    } catch (err) { reject(err); }
                });
            });
            if (!draftIsCurrent()) return;
            this._panel.setEntryTextProgrammatically('', {focus: false});
            this._panel.setStatusIndicator('ready', '已向桌面提交默认浏览器启动请求');
            this._dateIntegration?.menu?.close();
        } catch (err) {
            if (draftIsCurrent()) this._panel.setStatusIndicator('error', `无法启动默认浏览器：${err.message}`);
        } finally {
            if (this._browserLaunch === token) this._browserLaunch = null;
        }
    }

    async _executePromptTurn({
        promptText,
        displayUserText = '',
        rewindUserMessageId = '',
        reuseExistingUserCard = false,
        userMessageId = '',
        userCreatedAt = '',
        userTs = 0,
        clearEntry = true,
        clearAttachments = false,
        attachmentSnapshot = null,
        clearEditState = false,
        recordHistoryText = '',
        restoreDraftOnEarlyError = '',
        capsule = null,
    } = {}) {
        if (!promptText || !this._panel || !this._chatController || this._isBusyOrMutating()) return;
        this._sessionMutationLock = true;

        let lifeGen = this._lifecycleGeneration;
        let generation = this._chatController.clientGeneration;
        let expectedSessionId = this._chatController.currentSessionId || this._getSettingString('session-id', '');

        try {
            if (this._modelPicker?.isOpen) {
                this._modelPicker.toggle(false);
            }
            if (this._panel.isSessionMenuOpen) {
                this._panel.toggleSessionMenu(false);
            }
            this._panel.closeSlashMenu();
            this._panel.setRouteSuggestion(null);

            if (!this._chatController.ready) {
                await this._ensureClient();
                if (!this._chatController?.ready) return;
            }
            if (!this._isSessionUnlockedAndAlive(lifeGen) || this._chatController.busy) return;

            lifeGen = this._lifecycleGeneration;
            generation = this._chatController.clientGeneration;
            expectedSessionId = this._chatController.currentSessionId || this._getSettingString('session-id', '');

            if (rewindUserMessageId) {
                let rw = null;
                try {
                    rw = await this._chatController.client.request('rewind_from_user_turn', {
                        userMessageId: rewindUserMessageId,
                        sessionId: expectedSessionId,
                    });
                } catch (rwErr) {
                    this._panel?.setStatusIndicator('error', `回退历史失败：${rwErr?.message || rwErr}`);
                    return;
                }
                const currentSessionAfterAwait =
                    this._chatController?.currentSessionId || this._getSettingString('session-id', '');
                if (
                    !this._isSessionUnlockedAndAlive(lifeGen) ||
                    generation !== this._chatController?.clientGeneration ||
                    this._chatController?.busy ||
                    (expectedSessionId && currentSessionAfterAwait !== expectedSessionId)
                ) {
                    return;
                }
                if (!rw || !rw.ok) {
                    this._panel?.setStatusIndicator('error', `回退历史失败：${rw?.error || '磁盘写入失败'}`);
                    return;
                }
                this._canUndoLastRewind = Boolean(rw.canUndo);
                this._panel.truncateMessagesFromId(rewindUserMessageId, {
                    keepStartMessage: Boolean(reuseExistingUserCard),
                });
            }

            if (this._panel.historyWindow?.hasNewer) {
                this._panel.restoreLatestHistoryWindow();
            }

            const turnId = `turn_${GLib.uuid_string_random()}`;
            const effectiveUserMessageId = userMessageId || `user_${GLib.uuid_string_random()}`;
            const messageId = `msg_${GLib.uuid_string_random()}`;
            const shownUserText = displayUserText || promptText;

            capsule?.trackTurn(turnId);
            this._chatController.activeTurnState = {
                turnId,
                userMessageId: effectiveUserMessageId,
                messageId,
                sessionId: expectedSessionId,
                clientGeneration: generation,
                lifecycleGeneration: lifeGen,
                state: 'starting',
            };

            if (recordHistoryText) {
                this._recordPromptHistory(recordHistoryText);
            }
            if (clearEditState) {
                this._cancelEditQuestion({keepEntry: true});
            }
            if (clearEntry && this._panel.entry) {
                this._panel.setEntryTextProgrammatically('', {focus: false, cursorAtEnd: true});
            }
            if (clearAttachments && this._attachments) {
                this._attachments.clear();
                this._refreshAttachmentBarUi();
            }

            if (!reuseExistingUserCard) {
                this._panel.addMessage('user', shownUserText, {
                    rawPromptText: promptText,
                    animate: true,
                    turnId,
                    messageId: effectiveUserMessageId,
                    ...(userCreatedAt ? {createdAt: userCreatedAt} : {}),
                    ...(userTs ? {ts: userTs} : {}),
                });
            } else {
                this._panel.scrollBottom(true, true);
            }

            this._live = null;
            this._setBusy(true);
            this._panel.setStatusIndicator('busy', '正在发送请求…');
        } finally {
            this._sessionMutationLock = false;
        }

        const activeTurn = this._chatController?.activeTurnState;
        if (!activeTurn) return;
        const {turnId, userMessageId: effectiveUserMessageId, messageId} = activeTurn;
        const shownUserText = displayUserText || promptText;

        try {
            const result = await this._chatController.client.request('prompt', {
                message: promptText,
                ...(shownUserText !== promptText ? {displayUserText: shownUserText} : {}),
                turnId,
                userMessageId: effectiveUserMessageId,
                ...(userCreatedAt ? {userCreatedAt} : {}),
                ...(userTs ? {userTs} : {}),
                messageId,
                clientGeneration: generation,
                lifecycleGeneration: lifeGen,
            });
            if (result?.disposition === 'rejected_budget') {
                // OpenAI may reject AFTER async model metadata discovery. This is
                // a structured result rather than an exception, but the request
                // was never sent and must not consume the user's draft/attachments.
                if (
                    !this._isSessionUnlockedAndAlive(lifeGen) ||
                    generation !== this._chatController?.clientGeneration ||
                    (this._chatController.activeTurnState &&
                     this._chatController.activeTurnState.turnId !== turnId)
                ) {
                    return;
                }
                this._chatController.activeTurnState = null;
                this._setBusy(false);
                if (!reuseExistingUserCard) {
                    this._panel?.truncateMessagesFromId(effectiveUserMessageId);
                }
                this._panel?.setStatusIndicator('error',
                    `⚠️ 请求未发送：${result.error || '超出模型上下文预算'}`);
                if (restoreDraftOnEarlyError && this._panel?.entry && !this._panel.entry.get_text()) {
                    this._panel.setEntryTextProgrammatically(restoreDraftOnEarlyError, {
                        focus: true, cursorAtEnd: true,
                    });
                }
                if (clearAttachments && attachmentSnapshot && this._attachments && this._attachments.count === 0) {
                    this._attachments.restoreFromSnapshot(attachmentSnapshot);
                    this._refreshAttachmentBarUi();
                }
                return;
            }
            if (
                this._isSessionUnlockedAndAlive(lifeGen) &&
                generation === this._chatController?.clientGeneration &&
                this._chatController.activeTurnState?.turnId === turnId &&
                result?.disposition === 'handled'
            ) {
                this._chatController.activeTurnState = null;
                this._setBusy(false);
                this._panel.setStatusIndicator('ready', this._idleStatus || '随问');
            }
            return this._isSessionUnlockedAndAlive(lifeGen) &&
                this._chatController?.activeTurnState?.turnId === turnId;
        } catch (error) {
            if (
                !this._isSessionUnlockedAndAlive(lifeGen) ||
                generation !== this._chatController?.clientGeneration
            ) {
                return;
            }
            if (this._chatController.activeTurnState && this._chatController.activeTurnState.turnId !== turnId) {
                return;
            }
            this._chatController.activeTurnState = null;
            this._panel?.setStatusIndicator('error', `发送失败：${error.message}`);
            this._syncDiagnosticsSnapshot({lastConnectionError: error.message || String(error)});
            this._setBusy(false);
            if (restoreDraftOnEarlyError && this._panel?.entry && !this._panel.entry.get_text()) {
                this._panel.setEntryTextProgrammatically(restoreDraftOnEarlyError, {focus: true, cursorAtEnd: true});
            }
            if (clearAttachments && attachmentSnapshot && this._attachments && this._attachments.count === 0) {
                this._attachments.restoreFromSnapshot(attachmentSnapshot);
                this._refreshAttachmentBarUi();
            }
            if (String(error.message || '').includes('超时')) {
                this._chatController.stopClient();
            }
        }
    }

    _ensureLiveCard(event = null) {
        const activeTurn = this._chatController?.activeTurnState;
        if (!this._live) {
            this._live = this._panel.addMessage('assistant', '', {
                animate: true,
                turnId: event?.turnId || activeTurn?.turnId || '',
                messageId: event?.messageId || activeTurn?.messageId || '',
                replyTo: event?.replyTo || activeTurn?.userMessageId || '',
                modelId: event?.modelId || this._modelLabel || '',
                backend: this._getEffectiveBackend(),
            });
        } else {
            if (event?.turnId && !this._live.turnId) this._live.turnId = event.turnId;
            if (event?.messageId && !this._live.messageId) this._live.messageId = event.messageId;
            if (!this._live.replyTo && activeTurn?.userMessageId) {
                this._live.replyTo = activeTurn.userMessageId;
            }
        }
        return this._live;
    }

    async _submitQuestionDecision(card, action = 'answer') {
        if (!card?.toolNodes || !this._chatController) return;
        const target = card.toolNodes.find(
            n => n.id === card.selectedNodeId && n.status === 'pending_approval'
        ) || card.toolNodes.find(n => n.isQuestion && n.status === 'pending_approval');
        if (!target || !target.requestId) return;

        if (action === 'deny') {
            await this._submitActiveToolDecision(card, 'deny', false);
            return;
        }

        const skipAll = action === 'skip';
        const isDsh = this._getEffectiveBackend() === 'dsh';
        if (isDsh && !skipAll && target.questions.some(question => {
            const draft = target.questionDrafts?.[question.question];
            return !question.multiSelect && draft?.selectedLabels?.length && draft.customText?.trim();
        })) {
            target.validationHint = '单选题请在选项与自定义回答中选一种';
            this._tracePanel.syncQuestionFormState(card, target);
            return;
        }
        const modifiedInput = buildAskUserModifiedInput(
            target.rawInput || {questions: target.questions},
            target.questionDrafts || {},
            {skipAll}
        );

        const hasAnswer = isDsh
            ? Object.values(target.questionDrafts || {}).some(draft => draft.selectedLabels?.length || draft.customText?.trim())
            : Object.keys(modifiedInput.answers || {}).length > 0;
        if (!skipAll && !hasAnswer) {
            target.validationHint = isDsh ? '请至少选择一项或输入自定义回答'
                : '请至少选择一项或输入自定义回答；若无需指定可点击「交由 AI 判断」';
            this._tracePanel.syncQuestionFormState(card, target);
            return;
        }

        const lifeGen = this._lifecycleGeneration;
        const expectedTurnId = card.turnId || this._chatController.activeTurnState?.turnId || '';
        target.validationHint = '';
        const answerSummary = formatAskUserAnswerSummary(target.questions, modifiedInput);

        target.status = 'sending_approval';
        target.approvalPhase = 'sending';
        target.pendingApprovalAction = skipAll ? 'skipped' : 'answered';
        target.pendingUserAnswerSummary = answerSummary;
        target.deliveryError = '';
        card.dirtyToolNodeIds?.add(target.id);
        card.dirty.tools = true;
        card.dirty.toolsUrgent = true;
        if (!card.text) card.dirty.text = true;
        card.scheduleRender();
        this._panel?.setStatusIndicator('busy', skipAll ? '正在通知 AI 自行判断…' : '正在提交您的回答…');

        let sent = false;
        let phase = '';
        try {
            const res = await this._chatController.client?.request('permission_response', {
                turnId: expectedTurnId,
                requestId: target.requestId,
                decision: skipAll ? 'allow' : 'modify',
                alwaysAllow: false,
                allowSessionRule: false,
                scopeKey: '',
                toolName: target.toolName,
                modifiedInput: skipAll ? undefined : modifiedInput,
                ...(isDsh ? {questionDrafts: target.questionDrafts} : {}),
                reason: skipAll ? '用户选择交由 AI 自行判断' : '用户在随问中提交了问题回答',
            });
            sent = Boolean(res?.sent);
            phase = String(res?.phase || '');
        } catch (_) {
            sent = false;
        }

        if (
            !this._isSessionUnlockedAndAlive(lifeGen) ||
            card !== this._live ||
            (expectedTurnId && this._chatController?.activeTurnState?.turnId !== expectedTurnId)
        ) {
            return;
        }

        if (!sent) {
            target.status = 'pending_approval';
            target.approvalPhase = '';
            target.deliveryError = '回答未送达后端进程，请点击重试';
            card.selectedNodeId = target.id;
            card.dirtyToolNodeIds?.add(target.id);
            card.dirty.tools = true;
            card.dirty.toolsUrgent = true;
            card.flushRender(true);
            this._panel?.setStatusIndicator('error', '⚠️ 回答未送达后端，请重试');
            return;
        }

        // R1 & R11.4: Do NOT transition to 'running' until authoritative bridge `permission_resolved` ACK arrives!
        // If `permission_resolved` already arrived before pipe callback settled, `target.status` is already updated.
        if (target.status === 'sending_approval') {
            target.approvalPhase = phase || 'awaiting_ack';
            card.dirtyToolNodeIds?.add(target.id);
            card.dirty.tools = true;
            card.dirty.toolsUrgent = true;
            card.scheduleRender();
            this._panel?.setStatusIndicator('busy', '已发送回答，等待桥接确认…');
        }
    }

    async _submitActiveToolDecision(card, decision, alwaysAllow = false) {
        if (!card?.toolNodes || !this._chatController) return;
        const target = card.toolNodes.find(
            n => n.id === card.selectedNodeId && n.status === 'pending_approval'
        ) || card.toolNodes.find(n => n.status === 'pending_approval');
        if (!target || !target.requestId) return;

        const lifeGen = this._lifecycleGeneration;
        const expectedTurnId = card.turnId || this._chatController.activeTurnState?.turnId || '';
        const allow = decision === 'allow';
        const effectiveAlwaysAllow = Boolean(allow && alwaysAllow && target.allowSessionRule === true && target.scopeKey);

        target.status = 'sending_approval';
        target.approvalPhase = 'sending';
        target.pendingApprovalAction = allow ? (effectiveAlwaysAllow ? 'always' : 'allowed') : 'denied';
        target.deliveryError = '';
        card.dirtyToolNodeIds?.add(target.id);
        card.dirty.tools = true;
        card.dirty.toolsUrgent = true;
        if (!card.text) card.dirty.text = true;
        card.scheduleRender();
        this._panel?.setStatusIndicator('busy', `正在发送 ${target.toolName} 授权指令…`);

        let sent = false;
        let phase = '';
        try {
            const res = await this._chatController.client?.request('permission_response', {
                turnId: expectedTurnId,
                requestId: target.requestId,
                decision: allow ? 'allow' : 'deny',
                alwaysAllow: effectiveAlwaysAllow,
                allowSessionRule: Boolean(target.allowSessionRule),
                scopeKey: effectiveAlwaysAllow ? target.scopeKey : '',
                toolName: target.toolName,
            });
            sent = Boolean(res?.sent);
            phase = String(res?.phase || '');
        } catch (_) {
            sent = false;
        }

        if (
            !this._isSessionUnlockedAndAlive(lifeGen) ||
            card !== this._live ||
            (expectedTurnId && this._chatController?.activeTurnState?.turnId !== expectedTurnId)
        ) {
            return;
        }

        if (!sent) {
            target.status = 'pending_approval';
            target.approvalPhase = '';
            target.deliveryError = '授权指令未送达后端进程，请点击按钮重试';
            card.selectedNodeId = target.id;
            card.dirtyToolNodeIds?.add(target.id);
            card.dirty.tools = true;
            card.dirty.toolsUrgent = true;
            card.flushRender(true);
            this._panel?.setStatusIndicator('error', `⚠️ ${target.toolName} 授权未送达，请重试`);
            return;
        }

        // R1: Wait for authoritative bridge `permission_resolved` ACK before leaving approval or releasing same-scope nodes!
        if (target.status === 'sending_approval') {
            target.approvalPhase = phase || 'awaiting_ack';
            card.dirtyToolNodeIds?.add(target.id);
            card.dirty.tools = true;
            card.dirty.toolsUrgent = true;
            card.scheduleRender();
            this._panel?.setStatusIndicator('busy', `已发送 ${target.toolName} 授权，等待桥接确认…`);
        }
    }

    _onEvent(event) {
        if (!event || !this._panel || !this._chatController) return;

        if (event.type === 'models_discovered' && event.backend === 'openai' && Array.isArray(event.models)) {
            if (
                event.clientGeneration !== undefined &&
                this._chatController?.clientGeneration !== undefined &&
                Number(event.clientGeneration) !== Number(this._chatController.clientGeneration)
            ) {
                return;
            }
            const currentEndpointKey = normalizeEndpointKeyIdentity(this._getSettingString('openai-base-url', ''));
            if (event.endpointKey && currentEndpointKey && event.endpointKey !== currentEndpointKey) {
                return;
            }
            if (this._hasKey('openai-cached-models') && event.models.length > 0) {
                const seen = new Set();
                const ids = [];
                for (const m of event.models) {
                    const clean = String(m || '').trim();
                    if (!clean || seen.has(clean)) continue;
                    seen.add(clean);
                    ids.push(clean);
                    if (ids.length >= 300) break;
                }
                const existing = this._getSettingStrv('openai-cached-models');
                if (ids.length > 0 && ids.join('\n') !== existing.join('\n')) {
                    this._settings.set_strv('openai-cached-models', ids);
                    this._modelPicker?.refreshResultsOnly();
                }
            }
            return;
        }

        const activeTurn = this._chatController.activeTurnState;
        if (event.turnId && activeTurn?.turnId && event.turnId !== activeTurn.turnId) {
            return;
        }
        this._capsule?.recordEvent(event);

        if (event.type === 'memory_notice') {
            this._panel?.setMemoryReceipt(event);
            return;
        }

        if (event.type === 'session_save_error') {
            const msg = event.message || '历史未保存';
            this._panel.setStatusIndicator('error', `⚠️ ${msg}`);
            this._syncDiagnosticsSnapshot({
                sessionSaveStatus: `⚠️ ${msg}`,
                sessionSaveWarning: msg,
            });
            return;
        }

        if (event.type === 'bridge_ready') {
            const ver = event.protocolVersion ? `v${event.protocolVersion}` : 'v1';
            const statusText = event.patched
                ? `已通过握手验证 (${ver} · 权限拦截生效)`
                : `⚠️ 握手未命中补丁 (${event.error || '未知原因'})`;
            this._syncDiagnosticsSnapshot({bridgeHandshake: statusText});
            return;
        }

        if ((event.type === 'bridge_warning' || event.type === 'mode_notice') && event.message) {
            if (event.type === 'bridge_warning') {
                this._syncDiagnosticsSnapshot({bridgeHandshake: `⚠️ ${event.message}`});
            }
            if (!this._tracePanel.hasPendingApprovalNodes(this._live)) {
                this._panel.setStatusIndicator('busy', `ℹ️ ${event.message}`);
            }
            return;
        }

        if (event.type === 'message_start' && event.message?.role === 'assistant') {
            if (event.modelId) {
                const suffix = (this._idleStatus || '').includes(' · ')
                    ? ` · ${(this._idleStatus || '').split(' · ').slice(1).join(' · ')}`
                    : '';
                this._modelLabel = event.modelId;
                this._idleStatus = `${event.modelId}${suffix}`;
                this._syncDiagnosticsSnapshot({activeModel: event.modelId});
                if (this._live) {
                    this._live.modelId = event.modelId;
                    if (this._live.roleLabel) {
                        this._live.roleLabel.text = event.modelId;
                    }
                }
            }
            if (activeTurn && !this._tracePanel.hasPendingApprovalNodes(this._live)) {
                activeTurn.state = 'streaming';
            }
            if (this._live && this._live.text && !this._live.text.endsWith('\n')) {
                this._live.text = appendBoundedInMemoryText(this._live.text, '\n\n');
                this._live.dirty.text = true;
            }
        }

        if (event.type === 'message_update') {
            const delta = event.assistantMessageEvent;
            const awaiting = this._tracePanel.hasPendingApprovalNodes(this._live);
            if (delta?.type === 'thinking_delta' && delta.delta) {
                const card = this._ensureLiveCard(event);
                card.thinking = appendBoundedInMemoryText(card.thinking, delta.delta);
                card.dirty.thinking = true;
                if (!card.thinkingHadContent && card.thinking.trim()) {
                    card.thinkingHadContent = true;
                    card.dirty.tools = true;
                    if (!card.text) card.dirty.text = true;
                }
                if (!awaiting) {
                    if (activeTurn) activeTurn.state = 'streaming';
                    this._panel.setStatusIndicator('busy', '深度思考中…');
                }
                card.scheduleRender();
            } else if (delta?.type === 'thinking_replace' && typeof delta.thinking === 'string') {
                const card = this._ensureLiveCard(event);
                card.thinking = appendBoundedInMemoryText('', delta.thinking);
                card.dirty.thinking = true;
                if (!card.thinkingHadContent && card.thinking.trim()) {
                    card.thinkingHadContent = true;
                    card.dirty.tools = true;
                    if (!card.text) card.dirty.text = true;
                }
                if (!awaiting) {
                    if (activeTurn) activeTurn.state = 'streaming';
                    this._panel.setStatusIndicator('busy', '深度思考中…');
                }
                card.scheduleRender();
            } else if (delta?.type === 'text_delta' && delta.delta) {
                const card = this._ensureLiveCard(event);
                card.text = appendBoundedInMemoryText(card.text, delta.delta);
                card.dirty.text = true;
                if (!awaiting) {
                    if (activeTurn) activeTurn.state = 'streaming';
                    this._panel.setStatusIndicator('busy', '正在生成回答…');
                }
                card.scheduleRender();
            } else if (delta?.type === 'text_replace' && typeof delta.text === 'string') {
                const card = this._ensureLiveCard(event);
                card.text = appendBoundedInMemoryText('', delta.text);
                card.dirty.text = true;
                if (!awaiting) {
                    if (activeTurn) activeTurn.state = 'streaming';
                    this._panel.setStatusIndicator('busy', '正在生成回答…');
                }
                card.scheduleRender();
            }
        }

        if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update') {
            const card = this._ensureLiveCard(event);
            const {node, stillWaiting} = applyToolTraceEventToCard(card, event, {
                findOrCreateNode: (targetCard, info) => this._tracePanel.findOrCreateToolNode(targetCard, info),
                activeTurn,
            });
            if (!card.text) card.dirty.text = true;
            if (!stillWaiting && node) {
                this._panel.setStatusIndicator(
                    'busy',
                    node.isQuestion
                        ? '💬 正在准备交互式提问…'
                        : `正在执行工具：${node.toolName || event.toolName || '工具'}`
                );
            }
            card.scheduleRender();
        }

        if (event.type === 'permission_request') {
            const card = this._ensureLiveCard(event);
            const {node} = applyToolTraceEventToCard(card, event, {
                findOrCreateNode: (targetCard, info) => this._tracePanel.findOrCreateToolNode(targetCard, info),
                activeTurn,
            });
            if (!card.text) card.dirty.text = true;
            if (node?.isQuestion) {
                const brief = this._tracePanel.formatShortHint(node.summary, 20);
                this._panel.setStatusIndicator('busy', brief ? `💬 等待回答：${brief}` : '💬 等待您回答问题…');
            } else {
                this._panel.setStatusIndicator('busy', `⚠️ 等待您审批工具：${node?.toolName || event.toolName || '工具'}`);
            }
            this._updateAiTabBadge();
            card.scheduleRender();
            this._panel.scrollBottom(true, true);

            this._dispatchBackgroundNotification('approval_needed', {
                sessionId: activeTurn?.sessionId || this._chatController?.currentSessionId || '',
                turnId: event.turnId || activeTurn?.turnId || '',
                requestId: event.requestId || '',
                isQuestion: Boolean(node?.isQuestion || event.isQuestion),
            });
        }

        if (event.type === 'permission_resolved') {
            const card = this._live || (event.autoApproved ? this._ensureLiveCard(event) : null);
            if (card?.toolNodes) {
                const {node, nextPending, allow} = applyToolTraceEventToCard(card, event, {
                    findOrCreateNode: (targetCard, info) => this._tracePanel.findOrCreateToolNode(targetCard, info),
                    activeTurn,
                });
                if (!card.text) card.dirty.text = true;
                this._updateAiTabBadge();
                card.scheduleRender();

                const labelName = node?.toolName || event.toolName || '工具';
                this._panel.setStatusIndicator(
                    'busy',
                    nextPending
                        ? (nextPending.isQuestion
                            ? '💬 请继续回答下一个问题…'
                            : `⚠️ 等待您审批工具：${nextPending.toolName}`)
                        : allow
                            ? (node?.isQuestion
                                ? '已确认您的回答，正在继续执行…'
                                : `已确认授权 ${labelName}，正在执行…`)
                            : `已拒绝 ${labelName}，正在继续…`
                );
            }
        }

        if (event.type === 'permission_response_rejected' || event.type === 'permission_ack_timeout') {
            const card = this._live;
            if (card?.toolNodes && event.requestId) {
                const node = card.toolNodes.find(n => n.requestId === event.requestId);
                if (node && (node.status === 'sending_approval' || node.status === 'pending_approval')) {
                    if (event.reason === 'unknown_or_expired_request_id') {
                        node.status = 'denied';
                        node.approvalState = 'timed_out';
                        node.approvalPhase = 'expired';
                        node.deliveryError = '该审批请求在桥接端已过期或已结束';
                        const nextPending = card.toolNodes.find(
                            n => n.status === 'pending_approval' || n.status === 'sending_approval'
                        );
                        card.selectedNodeId = nextPending ? nextPending.id : node.id;
                        if (activeTurn) {
                            activeTurn.state = nextPending ? 'awaiting_approval' : 'streaming';
                        }
                    } else {
                        node.status = 'pending_approval';
                        node.approvalPhase = '';
                        node.deliveryError = event.type === 'permission_ack_timeout'
                            ? '等待桥接确认超时，请点击重试或停止当前回合'
                            : `审批确认未通过桥接校验（${event.reason || '已拒绝'}），请重试`;
                        card.selectedNodeId = node.id;
                        if (activeTurn) {
                            activeTurn.state = 'awaiting_approval';
                        }
                    }
                    card.dirtyToolNodeIds?.add(node.id);
                    card.dirty.tools = true;
                    card.dirty.toolsUrgent = true;
                    this._updateAiTabBadge();
                    card.flushRender(true);
                    this._panel.setStatusIndicator('error', `⚠️ ${node.deliveryError}`);
                }
            }
        }

        if (event.type === 'tool_execution_end') {
            const card = this._ensureLiveCard(event);
            if (card?.toolNodes) {
                applyToolTraceEventToCard(card, event, {
                    findOrCreateNode: (targetCard, info) => this._tracePanel.findOrCreateToolNode(targetCard, info),
                    activeTurn,
                });
                if (!card.text) card.dirty.text = true;
                card.scheduleRender();
            }
        }

        if (event.type === 'tool_batch_end') {
            if (this._live?.toolNodes) {
                applyToolTraceEventToCard(this._live, event, {
                    findOrCreateNode: (targetCard, info) => this._tracePanel.findOrCreateToolNode(targetCard, info),
                    activeTurn,
                });
                this._live.scheduleRender();
            }
        }

        if ((event.type === 'message_end' || event.type === 'message_final') && event.message?.role === 'assistant') {
            const text = messageText(event.message);
            const thinking = messageThinking(event.message);
            const finishReason = String(event.finishReason || event.message?.finishReason || '');
            const isPartial = Boolean(event.partial || event.message?.partial || finishReason === 'length');
            const usage = event.usage || event.message?.usage || null;
            if (text || thinking || event.message.errorMessage) {
                const card = this._ensureLiveCard(event);
                if (text && card.text !== text) {
                    card.text = text;
                    card.dirty.text = true;
                }
                if (thinking && card.thinking !== thinking) {
                    card.thinking = thinking;
                    card.thinkingHadContent = true;
                    card.dirty.thinking = true;
                    card.dirty.tools = true;
                }
                if (event.message.errorMessage && !card.text) {
                    card.text = `⚠️ ${event.message.errorMessage}`;
                    card.dirty.text = true;
                    card.box?.add_style_class_name('qc-message-error');
                }
                if (finishReason) card.finishReason = finishReason;
                if (isPartial) card.partial = true;
                if (usage) card.usage = usage;
                card.activeTool = false;
                this._panel.historyWindow?.updateStoredMessageById(card.messageId, {
                    text: card.text,
                    thinking: card.thinking,
                    modelId: card.modelId || this._modelLabel || '',
                    ...(finishReason ? {finishReason} : {}),
                    ...(isPartial ? {partial: true} : {}),
                    ...(usage ? {usage} : {}),
                    ...(event.message.errorMessage ? {errorMessage: event.message.errorMessage} : {}),
                });
                card.flushRender();
            }
            if (event.message.errorMessage) {
                this._panel.setStatusIndicator('error', `错误：${event.message.errorMessage}`);
            }
            this._panel.scrollBottom(false, false);
        }

        if (
            event.type === 'agent_settled' ||
            event.type === 'turn_settled' ||
            (event.type === 'agent_end' && event.willRetry === undefined)
        ) {
            const terminalStatus = event.status || (event.aborted ? 'cancelled' : 'completed');
            const finishReason = String(event.finishReason || this._live?.finishReason || '');
            const isPartial = Boolean(
                event.partial ||
                this._live?.partial ||
                finishReason === 'length' ||
                (terminalStatus !== 'completed' && Boolean(this._live?.text?.trim()))
            );
            const usage = event.usage || this._live?.usage || null;
            const finishedText = this._live?.text || '';
            const settledCard = this._live;
            const settledTurnId = event.turnId || activeTurn?.turnId || settledCard?.turnId || '';
            const settledSessionId = activeTurn?.sessionId || this._chatController?.currentSessionId || '';

            if (settledCard) {
                if (settledCard.toolNodes) {
                    applyToolTraceEventToCard(settledCard, {
                        ...event,
                        type: 'agent_settled',
                        status: terminalStatus,
                    }, {
                        findOrCreateNode: (targetCard, info) => this._tracePanel.findOrCreateToolNode(targetCard, info),
                        activeTurn,
                    });
                }
                settledCard.status = terminalStatus;
                settledCard.partial = isPartial;
                if (finishReason) settledCard.finishReason = finishReason;
                if (usage) settledCard.usage = usage;
                settledCard.activeTool = false;
                settledCard.dirty.tools = true;
                settledCard.dirty.toolsUrgent = true;
                settledCard.dirty.text = true;
                this._panel.historyWindow?.updateStoredMessageById(settledCard.messageId, {
                    text: settledCard.text,
                    thinking: settledCard.thinking,
                    modelId: settledCard.modelId || this._modelLabel || '',
                    status: terminalStatus,
                    partial: isPartial,
                    ...(settledCard.finishReason ? {finishReason: settledCard.finishReason} : {}),
                    ...(settledCard.usage ? {usage: settledCard.usage} : {}),
                });
                settledCard.flushRender();
            }

            if (!this._isChatVisible()) {
                if (terminalStatus === 'completed' && finishedText) {
                    this._panel.hasUnreadBackgroundReply = true;
                    this._dispatchBackgroundNotification('turn_completed', {
                        sessionId: settledSessionId,
                        turnId: settledTurnId,
                    });
                } else if (
                    terminalStatus === 'failed' ||
                    terminalStatus === 'timed_out' ||
                    terminalStatus === 'interrupted'
                ) {
                    this._panel.hasUnreadBackgroundReply = true;
                    this._dispatchBackgroundNotification('turn_failed', {
                        sessionId: settledSessionId,
                        turnId: settledTurnId,
                    });
                }
            }

            if (!event.turnId || this._chatController.activeTurnState?.turnId === event.turnId) {
                this._chatController.activeTurnState = null;
            }

            this._setBusy(false);
            this._live = null;
            settledCard?.syncContinueVisibility?.();

            if (terminalStatus === 'cancelled') {
                this._panel.setStatusIndicator('ready', '已停止生成');
            } else if (terminalStatus === 'timed_out') {
                const msg = event.errorMessage || '请求超时';
                this._panel.setStatusIndicator('error', msg);
                this._syncDiagnosticsSnapshot({lastConnectionError: msg});
            } else if (terminalStatus === 'interrupted') {
                const msg = event.errorMessage || '输出中断（回答可能不完整）';
                this._panel.setStatusIndicator('error', msg);
                this._syncDiagnosticsSnapshot({lastConnectionError: msg});
            } else if (terminalStatus === 'failed') {
                const msg = event.errorMessage || '执行失败';
                this._panel.setStatusIndicator('error', `错误：${msg}`);
                this._syncDiagnosticsSnapshot({lastConnectionError: msg});
            } else if (terminalStatus === 'completed' && finishReason === 'length') {
                const usageHint = usage?.totalTokens ? ` · 本轮 ${usage.totalTokens} tokens` : '';
                this._panel.setStatusIndicator('ready', `⚠️ 输出达长度上限 (length)${usageHint} · 可点击继续生成`);
            } else if (
                !this._panel.lastStatusText.startsWith('错误：') &&
                !this._panel.lastStatusText.startsWith('⚠️ 历史未保存')
            ) {
                const usageHint = usage?.totalTokens ? ` · ${usage.totalTokens} tokens` : '';
                this._panel.setStatusIndicator('ready', `${this._idleStatus || '随问'}${usageHint}`);
            }

            this._updateAiTabBadge();
            if (this._chatController.needsReconnect) {
                this._chatController.needsReconnect = false;
                this._reconnectNow();
            }
        }
    }

    async _abort() {
        if (!this._chatController?.client || !this._chatController.busy) return;
        const lifeGen = this._lifecycleGeneration;
        const generation = this._chatController.clientGeneration;
        const targetTurnId = this._chatController.activeTurnState?.turnId || '';
        if (this._chatController.activeTurnState) {
            this._chatController.activeTurnState.state = 'cancelling';
        }
        this._panel?.setStatusIndicator('busy', '正在停止…');
        try {
            await this._chatController.client.request('abort', {turnId: targetTurnId});
        } catch (error) {
            if (
                this._isSessionUnlockedAndAlive(lifeGen) &&
                generation === this._chatController?.clientGeneration &&
                (!targetTurnId || !this._chatController.activeTurnState || this._chatController.activeTurnState.turnId === targetTurnId)
            ) {
                this._chatController.stopClient();
                this._setBusy(false);
                this._panel?.setStatusIndicator('error', `已断开：${error.message}`);
            }
            return;
        }

        if (
            this._isSessionUnlockedAndAlive(lifeGen) &&
            generation === this._chatController?.clientGeneration &&
            this._chatController.activeTurnState &&
            this._chatController.activeTurnState.turnId === targetTurnId
        ) {
            this._chatController.activeTurnState = null;
            this._setBusy(false);
            this._panel?.setStatusIndicator('ready', '已停止生成');
        }
    }

    _syncDiagnosticsSnapshot(patch = {}) {
        if (!this._enabled || !this._settings) return;
        this._diagState = {
            ...(this._diagState || {}),
            ...patch,
        };
        if (!this._hasKey('last-diagnostic-json')) return;
        try {
            const snap = sanitizeDiagnosticSnapshot(this._diagState, {
                homeDir: GLib.get_home_dir() || '',
            });
            const serialized = JSON.stringify(snap);
            if (this._settings.get_string('last-diagnostic-json') !== serialized) {
                this._settings.set_string('last-diagnostic-json', serialized);
            }
        } catch (_) {}
    }

    _dispatchBackgroundNotification(kind, {
        sessionId = '',
        turnId = '',
        requestId = '',
        isQuestion = false,
    } = {}) {
        if (!this._notifGate || !this._enabled) return;
        const lifeGen = this._lifecycleGeneration;
        const decision = this._notifGate.evaluate({
            kind,
            sessionId,
            turnId,
            requestId,
            isQuestion,
            isChatVisible: this._isChatVisible(),
            isLocked: Boolean(Main.sessionMode.isLocked),
            isGreeter: Boolean(Main.sessionMode.isGreeter),
            enabledSettings: {
                notifyOnApproval: this._getSettingBool('notify-on-approval', true),
                notifyOnError: this._getSettingBool('notify-on-error', true),
                notifyOnComplete: this._getSettingBool('notify-on-complete', false),
            },
        });
        if (!decision.shouldNotify) return;

        try {
            const sysSource = typeof MessageTray.getSystemSource === 'function'
                ? MessageTray.getSystemSource()
                : null;
            if (sysSource && typeof MessageTray.Notification === 'function') {
                const notification = new MessageTray.Notification({
                    source: sysSource,
                    title: decision.title,
                    body: decision.body,
                });
                notification.connect('activated', () => {
                    if (this._isSessionUnlockedAndAlive(lifeGen)) {
                        this._handleNotificationClicked(decision.target);
                    }
                });
                if (typeof sysSource.addNotification === 'function') {
                    sysSource.addNotification(notification);
                    return;
                }
            }
        } catch (_) {
            // Fall through to standard Main.notify if MessageTray signature differs
        }

        try {
            Main.notify(decision.title, decision.body);
        } catch (_) {}
    }

    async _handleNotificationClicked(target) {
        if (!this._isSessionUnlockedAndAlive() || !target) return;
        const lifeGen = this._lifecycleGeneration;
        const currentSessionId = this._getSettingString('session-id', '');
        const mountedTurnIds = (this._panel?.mountedCards || []).map(c => c.turnId).filter(Boolean);
        const storedTurnIds = (this._panel?.historyWindow?.allMessages || []).map(m => m.turnId).filter(Boolean);
        const pendingRequestIds = (this._live?.toolNodes || [])
            .filter(n => n.status === 'pending_approval' || n.status === 'sending_approval')
            .map(n => n.requestId)
            .filter(Boolean);

        let existingSessionIds = [];
        if (target.sessionId && target.sessionId !== currentSessionId) {
            try {
                const list = await listStoredSessionsAsync();
                existingSessionIds = list.map(s => s.sessionId);
            } catch (_) {}
        }
        if (!this._isSessionUnlockedAndAlive(lifeGen)) return;

        const resolved = resolveNotificationClickTarget(target, {
            isLocked: Boolean(Main.sessionMode.isLocked),
            isGreeter: Boolean(Main.sessionMode.isGreeter),
            isBusy: Boolean(this._chatController?.busy),
            currentSessionId,
            activeTurnId: this._chatController?.activeTurnState?.turnId || '',
            mountedTurnIds,
            storedTurnIds,
            existingSessionIds,
            currentLockEpoch: this._notifGate?.lockEpoch ?? 0,
            pendingRequestIds,
        });
        if (resolved.action === 'ignore') return;

        const menu = this._dateIntegration?.menu;
        if (menu && !menu.isOpen) {
            menu.open(true);
        }
        this._showChat();

        if (resolved.action === 'switch_session_and_focus' && resolved.sessionId) {
            await this._restoreSessionById(resolved.sessionId);
            if (this._isSessionUnlockedAndAlive(lifeGen)) {
                this._panel?.scrollBottom(true, true);
            }
            return;
        }

        if (resolved.statusHint && !this._chatController?.busy) {
            this._panel?.setStatusIndicator('ready', `ℹ️ ${resolved.statusHint}`);
            return;
        }

        if (resolved.action === 'focus_current_turn') {
            if (this._panel?.historyWindow?.hasNewer) {
                this._panel.restoreLatestHistoryWindow();
            }
            if (resolved.requestId && this._live?.toolNodes) {
                const pendingNode = this._live.toolNodes.find(
                    n => n.requestId === resolved.requestId && n.status === 'pending_approval'
                );
                if (pendingNode) {
                    this._live.selectedNodeId = pendingNode.id;
                    this._live.dirty.tools = true;
                    this._live.dirty.toolsUrgent = true;
                    this._live.flushRender?.(true);
                }
            }
            this._panel?.scrollBottom(true, true);
            this._scheduleTimeout(40, () => {
                if (this._isSessionUnlockedAndAlive(lifeGen)) {
                    this._panel?.entry?.grab_key_focus();
                }
            });
        }
    }

    _copyDiagnosticsReport() {
        if (!this._isSessionUnlockedAndAlive()) return;
        const lifeGen = this._lifecycleGeneration;
        const snap = sanitizeDiagnosticSnapshot(this._diagState || {}, {
            homeDir: GLib.get_home_dir() || '',
        });
        const reportText = formatDiagnosticReportText(snap);
        try {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, reportText);
        } catch (_) {}
        this._panel?.setStatusIndicator('ready', '✓ 已复制脱敏诊断摘要（不含 API Key 与对话正文）');
        this._scheduleTimeout(3000, () => {
            if (this._isSessionUnlockedAndAlive(lifeGen) && !this._chatController?.busy) {
                this._panel?.setStatusIndicator('ready', this._idleStatus || '随问');
            }
        });
    }

    async _retrySaveSession() {
        if (!this._isSessionUnlockedAndAlive() || !this._chatController?.client) return;
        const lifeGen = this._lifecycleGeneration;
        try {
            const res = await this._chatController.client.request('retry_save_session');
            if (!this._isSessionUnlockedAndAlive(lifeGen)) return;
            if (res?.ok && !res?.hasUnsavedChanges) {
                this._syncDiagnosticsSnapshot({
                    sessionSaveStatus: '正常',
                    sessionSaveWarning: '',
                });
                this._panel?.setStatusIndicator('ready', '✓ 历史消息已成功保存到本地磁盘');
            } else {
                const msg = res?.error || '历史保存仍失败';
                this._syncDiagnosticsSnapshot({
                    sessionSaveStatus: `⚠️ ${msg}`,
                    sessionSaveWarning: msg,
                });
                this._panel?.setStatusIndicator('error', `⚠️ 历史未保存：${msg}`);
            }
        } catch (err) {
            this._panel?.setStatusIndicator('error', `⚠️ 重试保存失败：${err?.message || err}`);
        }
    }

    async _undoLastRewind() {
        if (!this._isSessionUnlockedAndAlive() || !this._chatController?.client || this._isBusyOrMutating()) {
            return;
        }
        this._sessionMutationLock = true;
        const lifeGen = this._lifecycleGeneration;
        try {
            const res = await this._chatController.client.request('undo_last_rewind');
            if (!this._isSessionUnlockedAndAlive(lifeGen)) return;
            if (!res?.ok) {
                this._panel?.setStatusIndicator('error', `⚠️ ${res?.error || '撤销回退失败'}`);
                return;
            }
            this._canUndoLastRewind = false;
            this._panel?.renderInitialHistory(
                detailedMessages(res.messages || []),
                userText => this._recordPromptHistory(userText),
                {externalArchivedCount: Number(res.archivedCount || 0)}
            );
            this._panel?.scrollBottom(true, true);
            this._panel?.setStatusIndicator('ready', `✓ 已恢复此前回退舍弃的 ${res.restoredCount || 0} 条记录`);
        } catch (err) {
            this._panel?.setStatusIndicator('error', `⚠️ 撤销回退失败：${err?.message || err}`);
        } finally {
            this._sessionMutationLock = false;
        }
    }

    _rememberPreviousNonEmptySessionId(sessionId) {
        if (!this._hasKey('previous-session-id')) return;
        const cleanId = String(sessionId || '').trim();
        const totalMessages =
            (this._panel?.historyWindow?.allMessages?.length || 0) +
            (this._panel?.historyWindow?.externalArchivedCount || 0);
        if (cleanId && totalMessages > 0) {
            this._settings.set_string('previous-session-id', cleanId);
        }
    }

    async _refreshSessionMenuState() {
        if (!this._isSessionUnlockedAndAlive() || !this._panel) return;
        const lifeGen = this._lifecycleGeneration;
        const currentSessionId = this._getSettingString('session-id', '');
        const explicitPrev = this._getSettingString('previous-session-id', '');
        try {
            const sessions = await listStoredSessionsAsync();
            if (!this._isSessionUnlockedAndAlive(lifeGen) || !this._panel?.isSessionMenuOpen) return;
            const previousSessionId = resolvePreviousSessionId(sessions, currentSessionId, explicitPrev);
            const prevObj = sessions.find(s => s.sessionId === previousSessionId);
            const cleanupPlan = planSessionRetentionCleanup(sessions, {
                currentSessionId,
                previousSessionId,
                maxSessions: this._getSettingInt('session-retention-max-count', 20),
                maxAgeDays: this._getSettingInt('session-retention-max-days', 30),
            });
            const hotCount = this._panel.historyWindow?.allMessages?.length || 0;
            const archivedCount = this._panel.historyWindow?.externalArchivedCount || 0;
            this._panel.renderSessionMenuState({
                currentSessionId,
                messageCount: hotCount + archivedCount,
                archivedCount,
                previousSessionId,
                previousPreview: prevObj?.preview || '',
                cleanupPlan,
                saveWarning: this._diagState?.sessionSaveWarning || '',
                canUndoLastRewind: Boolean(this._canUndoLastRewind),
            });
        } catch (_) {}
    }

    async _flushBeforeSessionTransition(actionLabel = '切换会话') {
        const client = this._chatController?.client;
        if (!client) return true;
        const lifeGen = this._lifecycleGeneration;
        const isCurrent = () => this._isSessionUnlockedAndAlive(lifeGen) &&
            this._chatController?.client === client;
        try {
            const result = await client.request('flush_session');
            if (!isCurrent()) return false;
            if (result?.ok && !result?.hasUnsavedChanges) return true;
            const reason = result?.error || '仍有未持久化的消息';
            this._panel?.setStatusIndicator('error', `⚠️ ${actionLabel}已暂停：历史未保存（${reason}）。请先重试保存或导出。`);
            this._syncDiagnosticsSnapshot({
                sessionSaveStatus: '未保存',
                sessionSaveWarning: reason,
            });
            return false;
        } catch (err) {
            if (!isCurrent()) return false;
            this._panel?.setStatusIndicator('error', `⚠️ ${actionLabel}已暂停：无法确认历史已保存（${err?.message || err}）`);
            return false;
        }
    }

    async _restoreSessionById(targetSessionId) {
        if (!this._chatController || this._isBusyOrMutating()) return;
        let validTarget = '';
        try {
            validTarget = validateSessionId(targetSessionId);
        } catch (_) {
            return;
        }
        const currentId = this._getSettingString('session-id', '');
        if (validTarget === currentId) return;

        this._sessionMutationLock = true;
        this._attachments?.invalidatePendingReads({nextSessionId: validTarget});
        const lifeGen = this._lifecycleGeneration;
        try {
            const prevClient = this._chatController.client;
            prevClient?.revokeApprovedScopes?.();
            if (prevClient && !await this._flushBeforeSessionTransition('切换会话')) {
                return;
            }
            if (
                !this._isSessionUnlockedAndAlive(lifeGen) ||
                this._chatController.busy ||
                this._getSettingString('session-id', '') !== currentId
            ) {
                return;
            }

            this._rememberPreviousNonEmptySessionId(currentId);
            this._resetTransientComposerState(validTarget);
            this._chatController.stopClient();
            this._setSessionId(validTarget);
            this._panel?.setStatusIndicator('busy', '正在恢复会话…');
            this._scheduleIdle(() => {
                if (this._isSessionUnlockedAndAlive(lifeGen) &&
                    this._getSettingString('session-id', '') === validTarget) {
                    this._ensureClient();
                }
            });
        } finally {
            this._sessionMutationLock = false;
        }
    }

    async _exportCurrentSession() {
        if (!this._isSessionUnlockedAndAlive() || !this._chatController) return;
        const lifeGen = this._lifecycleGeneration;
        if (!this._chatController.ready) {
            await this._ensureClient();
        }
        if (!this._isSessionUnlockedAndAlive(lifeGen) || !this._chatController?.client) return;
        try {
            const res = await this._chatController.client.request('export_session', {format: 'markdown'});
            if (!this._isSessionUnlockedAndAlive(lifeGen)) return;
            if (res?.content) {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, res.content);
            }
            this._panel?.setStatusIndicator('ready', '✓ 已导出对话至 exports 目录并复制 Markdown');
            this._scheduleTimeout(3200, () => {
                if (this._isSessionUnlockedAndAlive(lifeGen) && !this._chatController?.busy) {
                    this._panel?.setStatusIndicator('ready', this._idleStatus || '随问');
                }
            });
        } catch (err) {
            this._panel?.setStatusIndicator('error', `⚠️ 导出失败：${err?.message || err}`);
        }
    }

    async _deleteCurrentSession() {
        if (!this._chatController || this._isBusyOrMutating()) return;
        this._sessionMutationLock = true;
        this._attachments?.invalidatePendingReads();
        const lifeGen = this._lifecycleGeneration;
        const victimId = this._getSettingString('session-id', '');

        try {
            this._chatController.client?.revokeApprovedScopes?.();
            this._chatController.stopClient();
            if (this._hasKey('previous-session-id') && this._getSettingString('previous-session-id', '') === victimId) {
                this._settings.set_string('previous-session-id', '');
            }

            let deletion = null;
            try {
                deletion = await deleteStoredSessionAsync(victimId);
            } catch (err) {
                deletion = {ok: false, error: err?.message || String(err)};
            }
            if (!deletion?.ok) {
                if (this._isSessionUnlockedAndAlive(lifeGen)) {
                    await this._ensureClient();
                    this._panel?.setStatusIndicator('error',
                        `⚠️ 删除会话失败：${deletion?.error || '文件删除未完成'}。会话未切换，请核查原始文件。`);
                }
                return;
            }
            if (
                !this._isSessionUnlockedAndAlive(lifeGen) ||
                this._chatController.busy ||
                this._getSettingString('session-id', '') !== victimId
            ) {
                return;
            }

            const nextSessionId = GLib.uuid_string_random();
            this._resetTransientComposerState(nextSessionId);
            this._setSessionId(nextSessionId);
            this._panel?.setStatusIndicator('busy', '正在建立新会话…');
            this._scheduleIdle(() => {
                if (this._isSessionUnlockedAndAlive(lifeGen) &&
                    this._getSettingString('session-id', '') === nextSessionId) {
                    this._ensureClient();
                }
            });
        } finally {
            this._sessionMutationLock = false;
        }
    }

    async _approveRetentionCleanup(candidateIds = []) {
        if (!this._isSessionUnlockedAndAlive() || !Array.isArray(candidateIds) || candidateIds.length === 0) {
            return;
        }
        const lifeGen = this._lifecycleGeneration;
        const protectedIds = [
            this._getSettingString('session-id', ''),
            this._getSettingString('previous-session-id', ''),
        ].filter(Boolean);
        try {
            const res = await executeApprovedSessionCleanupAsync(candidateIds, {protectedIds});
            if (!this._isSessionUnlockedAndAlive(lifeGen)) return;
            this._panel?.setStatusIndicator('ready', `✓ 已清理 ${res.deletedCount} 个超出保留策略的旧会话`);
            this._scheduleTimeout(3000, () => {
                if (this._isSessionUnlockedAndAlive(lifeGen) && !this._chatController?.busy) {
                    this._panel?.setStatusIndicator('ready', this._idleStatus || '随问');
                }
            });
        } catch (err) {
            this._panel?.setStatusIndicator('error', `⚠️ 清理旧会话失败：${err?.message || err}`);
        }
    }

    _resetTransientComposerState(nextSessionId = undefined) {
        this._live = null;
        this._draftInput = '';
        this._promptHistory = [];
        this._historyIndex = -1;
        this._editingTurnInfo = null;
        this._dismissedRouteKeys?.clear();
        this._attachments?.clear({nextSessionId});
        this._modelPicker?.resetSessionState();
        if (this._panel) {
            this._panel.setEditQuestionBanner(false);
            this._panel.setRouteSuggestion(null);
            this._panel.toggleFileAttachBar(false);
            this._panel.toggleSessionMenu(false);
            this._panel.closeSlashMenu();
            this._panel.renderAttachments([], '');
            this._panel.setEntryTextProgrammatically('', {focus: false, cursorAtEnd: true});
            this._panel.userScrolledUp = false;
            this._panel.updateJumpBottomVisibility();
        }
    }

    async _newSession() {
        if (!this._isSessionUnlockedAndAlive() || !this._chatController || this._isBusyOrMutating()) return;
        this._sessionMutationLock = true;
        const switchToken = {};
        this._sessionSwitchInFlight = switchToken;
        let switchScheduled = false;
        this._attachments?.invalidatePendingReads();
        const lifeGen = this._lifecycleGeneration;
        const controller = this._chatController;
        const generation = controller.clientGeneration;
        const finishSwitch = () => {
            if (this._sessionSwitchInFlight === switchToken) this._sessionSwitchInFlight = false;
        };
        const currentId = this._getSettingString('session-id', '');

        try {
            if (this._modelPicker?.isOpen) {
                this._modelPicker.toggle(false);
            }
            const prevClient = this._chatController.client;
            prevClient?.revokeApprovedScopes?.();
            if (prevClient && !await this._flushBeforeSessionTransition('切换会话')) {
                return;
            }
            if (
                !this._isSessionUnlockedAndAlive(lifeGen) ||
                this._sessionSwitchInFlight !== switchToken ||
                controller.clientGeneration !== generation || controller.busy ||
                this._getSettingString('session-id', '') !== currentId
            ) {
                return;
            }

            const nextSessionId = GLib.uuid_string_random();
            this._rememberPreviousNonEmptySessionId(currentId);
            this._setSessionId(nextSessionId);
            this._chatController.stopClient();
            this._capsule?.reset();
            this._resetTransientComposerState(nextSessionId);
            // Do not synchronously destroy/rebuild the complete Shell actor
            // tree on a button click. renderInitialHistory() is the sole owner
            // of the new message tree once the fresh client is ready.
            this._panel?.setStatusIndicator('busy', '正在建立新会话…');
            switchScheduled = Boolean(this._scheduleTimeout(0, () => {
                if (!this._isSessionUnlockedAndAlive(lifeGen) ||
                    this._sessionSwitchInFlight !== switchToken ||
                    this._getSettingString('session-id', '') !== nextSessionId) {
                    finishSwitch();
                    return;
                }
                Promise.resolve().then(() => this._ensureClient()).then(finishSwitch, finishSwitch);
                if (this._dateIntegration?.menu?.isOpen) {
                    this._panel?.entry?.grab_key_focus();
                }
            }));
        } catch (err) {
            if (this._isSessionUnlockedAndAlive(lifeGen)) {
                this._panel?.setStatusIndicator('error', err?.message || String(err));
            }
        } finally {
            if (this._lifecycleGeneration === lifeGen) this._sessionMutationLock = false;
            if (!switchScheduled) finishSwitch();
        }
    }

    disable() {
        ++nextLifecycleGeneration;
        this._lifecycleGeneration = 0;
        this._enabled = false;
        this._sessionMutationLock = false;
        this._sessionSwitchInFlight = false;
        this._browserLaunch = null;

        this._cancelScheduledWork();

        this._unregisterGlobalKeybindings();
        this._capsule?.dispose();
        this._capsule = null;

        const hostMenu = this._dateIntegration?.menu;
        if (this._menuSignal && hostMenu) {
            try { hostMenu.disconnect(this._menuSignal); } catch (_) {}
        }
        this._menuSignal = 0;

        if (this._sessionSignal) {
            try { Main.sessionMode.disconnect(this._sessionSignal); } catch (_) {}
            this._sessionSignal = 0;
        }

        for (const sig of this._settingSignals || []) {
            try { this._settings?.disconnect(sig); } catch (_) {}
        }
        this._settingSignals = [];

        if (this._interfaceSettings) {
            if (this._themeSig1) {
                try { this._interfaceSettings.disconnect(this._themeSig1); } catch (_) {}
            }
            if (this._themeSig2) {
                try { this._interfaceSettings.disconnect(this._themeSig2); } catch (_) {}
            }
            this._themeSig1 = this._themeSig2 = 0;
            this._interfaceSettings = null;
        }

        this._live = null;
        this._editingTurnInfo = null;
        this._attachments?.clear();
        this._attachments = null;
        this._notifGate?.reset();
        this._notifGate = null;
        this._dismissedRouteKeys?.clear();
        this._dismissedRouteKeys = null;
        this._cachedAvailableBackends?.clear();
        this._cachedAvailableBackends = null;
        this._diagState = null;

        this._chatController?.dispose();
        this._chatController = null;

        this._modelPicker?.dispose();
        this._modelPicker = null;

        const wrapper = this._panel?.wrapper || null;
        this._panel?.dispose();
        this._panel = null;
        this._cardFactory = null;
        this._tracePanel = null;

        if (this._dateIntegration) {
            this._dateIntegration.unmount(wrapper);
            this._dateIntegration = null;
        } else if (wrapper) {
            try {
                wrapper.remove_all_transitions?.();
                wrapper.destroy?.();
            } catch (_) {}
        }

        this._registry = null;
        this._settings = null;
    }
}
