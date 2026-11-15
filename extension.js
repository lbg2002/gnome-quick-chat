import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {BackendClient} from './backendClient.js';
import {
    buildAskUserModifiedInput,
    detailedMessages,
    formatAskUserAnswerSummary,
    getBackendCapabilities,
    messageText,
    messageThinking,
} from './protocol.js';
import {BackendRegistry} from './core/backendRegistry.js';
import {ChatController} from './core/chatController.js';
import {
    detectEffectiveBackend,
    invalidateBackendDetectionCaches,
    migrateGSettingsIfNeeded,
} from './core/backendDetect.js';
import {getSessionsDir, resolveWorkspacePath} from './core/paths.js';
import {appendBoundedInMemoryText} from './core/renderScheduler.js';
import {loadOpenAIApiKey} from './core/secretStore.js';
import {validateSessionId} from './core/sessionStore.js';
import {ChatPanelView} from './ui/chatPanel.js';
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
        this._sourceSignals = new Map();
        this._settingSignals = [];
        this._traySignals = [];
        this._registeredKeybindings = new Set();
        this._menuSignal = 0;
        this._sessionSignal = 0;
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

        try {
            this._settings = this.getSettings();
            migrateGSettingsIfNeeded(this._settings);

            this._registry = new BackendRegistry(this._settings);
            this._dateIntegration = new DateMenuIntegration();

            this._chatController = new ChatController({
                registry: this._registry,
                createClient: (onEvent, onError) => new BackendClient(onEvent, onError),
                loadRuntimeEnvironment: () => this._loadRuntimeEnvironment(),
                onEvent: event => this._onEvent(event),
                onStateChanged: info => this._onClientStateReady(info),
                onConnectionError: err => {
                    this._live = null;
                    this._setBusy(false);
                    this._panel?.setStatusIndicator('error', `连接失败：${err?.message || err}`);
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
            });

            this._modelPicker = new ModelPickerController({
                settings: this._settings,
                registry: this._registry,
                getEffectiveBackend: () => this._getEffectiveBackend(),
                getClient: () => this._chatController?.client || null,
                isExtensionAlive: () => this._isSessionUnlockedAndAlive(lifeGen),
                onNudgeLayout: () => this._dateIntegration?.nudgeLayout(),
                onOpenPreferences: () => this._openExtensionPreferences(),
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
                onSelectTab: tab => this._setTab(tab),
                onReconnectNow: () => this._reconnectNow(),
                onOpenPreferences: () => this._openExtensionPreferences(),
                onClipboardAsk: openFirst => this._triggerClipboardAsk(openFirst),
                onNewSession: () => this._newSession(),
                onSend: () => this._send(),
                onAbort: () => this._abort(),
                onEntryKeyPress: event => this._onEntryKeyPress(event),
                onDismissMigrationNotice: () => this._modelPicker?.dismissMigrationNotice(),
            });

            const wrapper = this._panel.build({showNotificationTab: true});
            const fallbackMode = this._getSettingString('panel-fallback-mode', 'auto') || 'auto';
            const mounted = this._dateIntegration.mount(
                wrapper,
                () => Boolean(
                    this._enabled &&
                    this._dateIntegration?.mountMode === 'datemenu' &&
                    this._tab === 'ai'
                ),
                {fallbackMode}
            );

            if (!mounted) {
                console.warn(
                    `[Quick Chat] Panel mount unavailable (mode=${fallbackMode}): ${this._dateIntegration.lastMountError || 'unknown'}; preserving native DateMenu.`
                );
                this.disable();
                return;
            }

            const hasNativeNotifications = this._dateIntegration.mountMode === 'datemenu';
            this._panel.setNotificationTabAvailable(hasNativeNotifications);
            const preferredTab = this._getSettingString('default-tab', 'ai') === 'notifications'
                ? 'notifications'
                : 'ai';
            this._tab = hasNativeNotifications ? preferredTab : 'ai';
            this._setTab(this._tab, false, false);

            const hostMenu = this._dateIntegration.menu;
            if (hostMenu) {
                this._menuSignal = hostMenu.connect('open-state-changed', (_, open) => {
                    if (!this._isSessionUnlockedAndAlive(lifeGen)) return;
                    if (open) {
                        this._panel?.syncThemeStyle(this._interfaceSettings);
                        this._panel?.updateNotificationBadge();
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
                    } else if (this._modelPicker?.isOpen) {
                        this._modelPicker.toggle(false);
                    }
                });
            }

            this._sessionSignal = Main.sessionMode.connect('updated', () => {
                if (!this._enabled || this._lifecycleGeneration !== lifeGen) return;
                // Never expose transcript or retain approved session scopes across lock screen / greeter.
                if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter) {
                    if (this._modelPicker?.isOpen) this._modelPicker.toggle(false);
                    this._panel?.wrapper?.hide();
                    this._live = null;
                    this._chatController?.stopClient();
                    this._setBusy(false);
                } else {
                    this._panel?.wrapper?.show();
                    this._setTab(this._tab, false, false);
                }
            });

            this._connectSettingsSignals();
            this._connectNotificationSignals();
            this._registerGlobalKeybindings();
            this._panel.syncThemeStyle(this._interfaceSettings);
            this._panel.applyDimensions(() => this._dateIntegration?.nudgeLayout());
        } catch (err) {
            console.error('[Quick Chat] enable() failed, rolling back cleanly:', err);
            this.disable();
        }
    }

    _isSessionUnlockedAndAlive(expectedLifeGen = this._lifecycleGeneration) {
        return Boolean(
            this._enabled &&
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
        return detectEffectiveBackend({
            configuredBackend: this._getSettingString('backend', 'auto'),
            zcodePath: this._getSettingString('zcode-path', ''),
            codexPath: this._getSettingString('codex-path', ''),
            openaiBaseUrl: this._getSettingString('openai-base-url', ''),
        });
    }

    _scheduleTimeout(ms, fn) {
        if (!this._enabled || !this._timers) return 0;
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
        if (!this._enabled || !this._timers) return 0;
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
        const addBinding = (keyName, handler) => {
            if (!this._hasKey(keyName)) return;
            const shortcuts = this._settings.get_strv(keyName);
            if (!shortcuts || !shortcuts.length || !shortcuts[0]) return;
            try {
                Main.wm.addKeybinding(
                    keyName,
                    this._settings,
                    Meta.KeyBindingFlags.NONE,
                    Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
                    handler
                );
                this._registeredKeybindings.add(keyName);
            } catch (err) {
                console.warn(`[Quick Chat] Failed to bind ${keyName}: ${err.message}`);
            }
        };

        addBinding('toggle-shortcut', () => this._toggleQuickChatPanel());
        addBinding('clipboard-shortcut', () => this._triggerClipboardAsk(true));
    }

    _unregisterGlobalKeybindings() {
        for (const keyName of this._registeredKeybindings || []) {
            try { Main.wm.removeKeybinding(keyName); } catch (_) {}
        }
        this._registeredKeybindings?.clear();
    }

    _toggleQuickChatPanel() {
        if (!this._isSessionUnlockedAndAlive()) return;
        const menu = this._dateIntegration?.menu;
        if (!menu) return;
        if (menu.isOpen && this._tab === 'ai') {
            menu.close();
            return;
        }
        if (!menu.isOpen) {
            menu.open(true);
        }
        this._setTab('ai', true, true);
        this._scheduleTimeout(50, () => {
            if (this._isSessionUnlockedAndAlive() && this._tab === 'ai') {
                this._panel?.entry?.grab_key_focus();
            }
        });
    }

    _triggerClipboardAsk(openPanelFirst = true) {
        if (!this._isSessionUnlockedAndAlive()) return;
        const lifeGen = this._lifecycleGeneration;
        const menu = this._dateIntegration?.menu;
        if (openPanelFirst && menu && !menu.isOpen) {
            menu.open(true);
        }
        if (this._tab !== 'ai') {
            this._setTab('ai', true, true);
        }

        const clip = St.Clipboard.get_default();
        const isAlive = () => Boolean(this._isSessionUnlockedAndAlive(lifeGen) && this._panel?.entry);
        const applyClipText = raw => {
            const trimmed = String(raw || '').trim();
            if (!trimmed || !isAlive()) return;
            const clipped = trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}…` : trimmed;
            const prompt = `请帮我分析、解释或处理以下内容：\n${clipped}`;
            this._panel.entry.set_text(prompt);
            this._panel.entry.grab_key_focus();
            this._panel.entry.clutter_text.set_cursor_position(-1);
        };

        clip.get_text(St.ClipboardType.CLIPBOARD, (_, text) => {
            if (!isAlive()) return;
            if (text && text.trim()) {
                applyClipText(text);
                return;
            }
            clip.get_text(St.ClipboardType.PRIMARY, (__, primaryText) => {
                if (!isAlive()) return;
                if (primaryText && primaryText.trim()) {
                    applyClipText(primaryText);
                } else {
                    this._panel?.entry?.grab_key_focus();
                }
            });
        });
    }

    _connectSettingsSignals() {
        this._settingSignals = [];
        const watch = (key, fn) => {
            if (this._hasKey(key)) {
                this._settingSignals.push(this._settings.connect(`changed::${key}`, fn));
            }
        };

        watch('panel-width', () => this._panel?.applyDimensions(() => this._dateIntegration?.nudgeLayout()));
        watch('panel-height', () => this._panel?.applyDimensions(() => this._dateIntegration?.nudgeLayout()));
        watch('render-markdown', () => this._panel?.rerenderAllMessages());
        watch('toggle-shortcut', () => this._registerGlobalKeybindings());
        watch('clipboard-shortcut', () => this._registerGlobalKeybindings());
        watch('migration-notice', () => {
            if (this._enabled && !this._panel?.mountedCards?.length) {
                this._panel?.buildEmptyState();
            }
        });

        const scopeBoundaryKeys = new Set([
            'backend',
            'workspace',
            'zcode-workspace',
            'codex-workspace',
            'agent-mode',
            'zcode-agent-mode',
            'codex-agent-mode',
            'session-id',
        ]);
        const cacheInvalidateKeys = new Set([
            'backend',
            'zcode-path',
            'codex-path',
            'openai-base-url',
        ]);

        const onBackendConfigChanged = keyName => {
            if (!this._enabled) return;
            this._registry?.bumpGeneration();
            if (cacheInvalidateKeys.has(keyName)) {
                invalidateBackendDetectionCaches();
            }
            if (!this._panel?.mountedCards?.length) {
                this._panel?.buildEmptyState();
            }
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

    _connectNotificationSignals() {
        this._traySignals = [];
        const tray = Main.messageTray;
        if (!tray) return;

        const bindSource = source => {
            if (!source || this._sourceSignals.has(source)) return;
            const id = source.connect('notify::count', () => this._panel?.updateNotificationBadge());
            this._sourceSignals.set(source, id);
        };
        const unbindSource = source => {
            const id = this._sourceSignals.get(source);
            if (id) {
                try { source.disconnect(id); } catch (_) {}
                this._sourceSignals.delete(source);
            }
        };

        this._traySignals.push(tray.connect('source-added', (_, src) => {
            bindSource(src);
            this._panel?.updateNotificationBadge();
        }));
        this._traySignals.push(tray.connect('source-removed', (_, src) => {
            unbindSource(src);
            this._panel?.updateNotificationBadge();
        }));
        this._traySignals.push(tray.connect('queue-changed', () => this._panel?.updateNotificationBadge()));

        try {
            for (const src of tray.getSources()) bindSource(src);
        } catch (_) {}

        this._panel?.updateNotificationBadge();
    }

    _setTab(tab, connect = true, animate = true) {
        if (!this._panel?.wrapper) return;
        const effectiveTab = this._dateIntegration?.mountMode === 'datemenu' ? tab : 'ai';
        const changed = this._tab !== effectiveTab;
        this._tab = effectiveTab;

        const showAi = effectiveTab === 'ai';
        const nativeList = this._dateIntegration?.nativeMessageList || null;
        const showNotif = Boolean(
            effectiveTab === 'notifications' &&
            nativeList &&
            Main.sessionMode.hasNotifications &&
            !Main.sessionMode.isLocked &&
            !Main.sessionMode.isGreeter
        );

        if (showAi) {
            this._dateIntegration?.collapseNativeMessageExpansion();
        } else if (this._modelPicker?.isOpen) {
            this._modelPicker.toggle(false);
        }

        this._panel.applyTabVisualState(effectiveTab, {
            nativeList,
            showNotif,
            animate,
            changed,
        });

        if (showAi) {
            this._panel.flushPendingBackgroundWork({
                isAiTabOpenAndVisible: Boolean(this._dateIntegration?.menu?.isOpen),
            });
            if (connect) {
                this._ensureClient();
                this._panel.entry?.grab_key_focus();
            }
        } else {
            this._updateAiTabBadge();
        }

        this._dateIntegration?.nudgeLayout();
    }

    async _loadRuntimeEnvironment() {
        migrateGSettingsIfNeeded(this._settings);
        const openaiBaseUrl = this._getSettingString('openai-base-url', '').trim();
        const apiKey = await loadOpenAIApiKey(this._settings, openaiBaseUrl);
        const eff = this._getEffectiveBackend();
        const config = this._registry.buildRuntimeConfig(eff, {apiKey});

        if (config.workspace && config.workspace.endsWith('/gnome-quick-chat/workspace')) {
            this._settings.set_string('workspace', '');
            config.workspace = '';
        }

        const workspace = resolveWorkspacePath(config.workspace);
        if (!GLib.file_test(workspace, GLib.FileTest.IS_DIR)) {
            GLib.mkdir_with_parents(workspace, 0o700);
        }
        if (!GLib.file_test(workspace, GLib.FileTest.IS_DIR)) {
            throw new Error('配置的工作目录不存在');
        }

        let sessionId = this._getSettingString('session-id', '');
        try {
            sessionId = validateSessionId(sessionId);
        } catch (_) {
            sessionId = GLib.uuid_string_random();
            this._settings.set_string('session-id', sessionId);
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

    _onClientStateReady({state, messages, config}) {
        this._live = null;
        this._panel?.renderInitialHistory(
            detailedMessages(messages),
            userText => this._recordPromptHistory(userText)
        );

        if (state.unconfigured || state.backend === 'unconfigured') {
            this._modelLabel = '未配置后端';
            this._idleStatus = '未配置后端';
            this._panel?.setStatusIndicator('error', state.reason || '未检测到可用后端，请在设置（⚙）中配置');
            this._setBusy(false);
            this._panel?.scrollBottom(true);
            return;
        }

        const backendTag = state.backend === 'openai'
            ? 'OpenAI API'
            : state.backend === 'codex'
                ? 'Codex'
                : 'ZCode';
        this._modelLabel = state.model?.id || config.model || backendTag;

        const effectiveMode = state.effectiveMode || config.mode;
        const caps = state.capabilities || getBackendCapabilities(state.backend, effectiveMode);
        const badge = caps.modeBadges?.[effectiveMode] || caps.modeBadges?.[config.mode] || '';
        const httpWarnSuffix = state.endpointSecurity?.isRemotePlaintextHttp ? ' · ⚠️明文HTTP' : '';
        this._idleStatus = (badge ? `${this._modelLabel} · ${badge}` : this._modelLabel) + httpWarnSuffix;

        if (state.sessionUnsavedWarning) {
            this._panel?.setStatusIndicator('error', `⚠️ ${state.sessionUnsavedWarning}`);
        } else {
            this._panel?.setStatusIndicator('ready', this._idleStatus);
        }
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

    _retryForAssistantCard(assistantCard) {
        if (this._chatController?.busy || !this._panel?.historyWindow) return;
        const promptText = this._panel.historyWindow.findRetryPromptForCard(assistantCard);
        if (promptText && this._panel.entry) {
            this._panel.entry.set_text(promptText);
            this._send();
        }
    }

    _onEntryKeyPress(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;

        if (symbol === Clutter.KEY_Escape && this._chatController?.busy) {
            this._abort();
            return Clutter.EVENT_STOP;
        }
        if (ctrl && (symbol === Clutter.KEY_n || symbol === Clutter.KEY_l) && !this._chatController?.busy) {
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
            entry.set_text(this._promptHistory[this._historyIndex] || '');
            entry.clutter_text.set_cursor_position(-1);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Down && this._historyIndex !== -1 && !shift && !ctrl) {
            if (this._historyIndex < this._promptHistory.length - 1) {
                this._historyIndex++;
                entry.set_text(this._promptHistory[this._historyIndex] || '');
            } else {
                this._historyIndex = -1;
                entry.set_text(this._draftInput || '');
            }
            entry.clutter_text.set_cursor_position(-1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    async _send() {
        const entry = this._panel?.entry;
        if (!entry || !this._chatController) return;
        const text = entry.get_text().trim();
        if (!text || this._chatController.busy) return;
        if (this._modelPicker?.isOpen) {
            this._modelPicker.toggle(false);
        }
        if (!this._chatController.ready) {
            await this._ensureClient();
            if (!this._chatController?.ready) return;
        }
        if (!this._isSessionUnlockedAndAlive() || this._chatController.busy) return;

        if (this._panel.historyWindow?.hasNewer) {
            this._panel.restoreLatestHistoryWindow();
        }

        const lifeGen = this._lifecycleGeneration;
        const generation = this._chatController.clientGeneration;
        const turnId = `turn_${GLib.uuid_string_random()}`;
        const userMessageId = `user_${GLib.uuid_string_random()}`;
        const messageId = `msg_${GLib.uuid_string_random()}`;

        this._chatController.activeTurnState = {
            turnId,
            userMessageId,
            messageId,
            sessionId: this._chatController.currentSessionId || '',
            clientGeneration: generation,
            lifecycleGeneration: lifeGen,
            state: 'starting',
        };

        this._recordPromptHistory(text);
        entry.set_text('');
        this._panel.addMessage('user', text, {
            animate: true,
            turnId,
            messageId: userMessageId,
        });
        this._live = null;
        this._setBusy(true);
        this._panel.setStatusIndicator('busy', '思考与生成中…');

        try {
            const result = await this._chatController.client.request('prompt', {
                message: text,
                turnId,
                userMessageId,
                messageId,
                clientGeneration: generation,
                lifecycleGeneration: lifeGen,
            });
            if (
                this._isSessionUnlockedAndAlive(lifeGen) &&
                generation === this._chatController.clientGeneration &&
                this._chatController.activeTurnState?.turnId === turnId &&
                result?.disposition === 'handled'
            ) {
                this._chatController.activeTurnState = null;
                this._setBusy(false);
                this._panel.setStatusIndicator('ready', this._idleStatus || '随问');
            }
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
            this._setBusy(false);
            if (!entry.get_text()) entry.set_text(text);
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
        const modifiedInput = buildAskUserModifiedInput(
            target.rawInput || {questions: target.questions},
            target.questionDrafts || {},
            {skipAll}
        );

        if (!skipAll && Object.keys(modifiedInput.answers || {}).length === 0) {
            target.validationHint = '请至少选择一项或输入自定义回答；若无需指定可点击「交由 AI 判断」';
            this._tracePanel.syncQuestionFormState(card, target);
            return;
        }

        const lifeGen = this._lifecycleGeneration;
        const expectedTurnId = card.turnId || this._chatController.activeTurnState?.turnId || '';
        target.validationHint = '';
        const answerSummary = formatAskUserAnswerSummary(target.questions, modifiedInput);

        target.status = 'sending_approval';
        target.deliveryError = '';
        card.dirtyToolNodeIds?.add(target.id);
        card.dirty.tools = true;
        card.dirty.toolsUrgent = true;
        if (!card.text) card.dirty.text = true;
        card.scheduleRender();
        this._panel?.setStatusIndicator('busy', skipAll ? '正在通知 AI 自行判断…' : '正在提交您的回答…');

        let sent = false;
        try {
            const res = await this._chatController.client?.request('permission_response', {
                turnId: expectedTurnId,
                requestId: target.requestId,
                decision: 'allow',
                alwaysAllow: false,
                allowSessionRule: false,
                scopeKey: '',
                toolName: target.toolName,
                modifiedInput,
                reason: skipAll ? '用户选择交由 AI 自行判断' : '用户在随问中提交了问题回答',
            });
            sent = Boolean(res?.sent);
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
            target.deliveryError = '回答未送达后端进程，请点击重试';
            card.selectedNodeId = target.id;
            card.dirtyToolNodeIds?.add(target.id);
            card.dirty.tools = true;
            card.dirty.toolsUrgent = true;
            card.flushRender(true);
            this._panel?.setStatusIndicator('error', '⚠️ 回答未送达后端，请重试');
            return;
        }

        target.status = 'running';
        target.approvalState = skipAll ? 'skipped' : 'answered';
        target.userAnswerSummary = answerSummary;
        card.dirtyToolNodeIds?.add(target.id);

        const nextPending = card.toolNodes.find(n => n.status === 'pending_approval');
        card.selectedNodeId = nextPending ? nextPending.id : null;
        card.activeTool = true;
        if (this._chatController.activeTurnState) {
            this._chatController.activeTurnState.state = nextPending ? 'awaiting_approval' : 'streaming';
        }
        card.dirty.tools = true;
        card.dirty.toolsUrgent = true;
        if (!card.text) card.dirty.text = true;
        card.scheduleRender();
        this._updateAiTabBadge();

        this._panel?.setStatusIndicator(
            'busy',
            nextPending
                ? (nextPending.isQuestion
                    ? '💬 请继续回答下一个问题…'
                    : `⚠️ 等待您审批工具：${nextPending.toolName}`)
                : '已收到您的回答，正在继续执行…'
        );
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
        target.deliveryError = '';
        card.dirtyToolNodeIds?.add(target.id);
        card.dirty.tools = true;
        card.dirty.toolsUrgent = true;
        if (!card.text) card.dirty.text = true;
        card.scheduleRender();
        this._panel?.setStatusIndicator('busy', `正在发送 ${target.toolName} 授权指令…`);

        let sent = false;
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
            target.deliveryError = '授权指令未送达后端进程，请点击按钮重试';
            card.selectedNodeId = target.id;
            card.dirtyToolNodeIds?.add(target.id);
            card.dirty.tools = true;
            card.dirty.toolsUrgent = true;
            card.flushRender(true);
            this._panel?.setStatusIndicator('error', `⚠️ ${target.toolName} 授权未送达，请重试`);
            return;
        }

        target.status = allow ? 'running' : 'denied';
        target.approvalState = allow ? (effectiveAlwaysAllow ? 'always' : 'allowed') : 'denied';
        card.dirtyToolNodeIds?.add(target.id);

        if (effectiveAlwaysAllow && target.scopeKey) {
            for (const other of card.toolNodes) {
                if (other.status === 'pending_approval' && other.scopeKey === target.scopeKey) {
                    other.status = 'running';
                    other.approvalState = 'always';
                    card.dirtyToolNodeIds?.add(other.id);
                }
            }
        }

        const nextPending = card.toolNodes.find(n => n.status === 'pending_approval');
        card.selectedNodeId = nextPending ? nextPending.id : null;
        card.activeTool = allow || Boolean(nextPending);
        if (this._chatController.activeTurnState) {
            this._chatController.activeTurnState.state = nextPending ? 'awaiting_approval' : 'streaming';
        }
        card.dirty.tools = true;
        card.dirty.toolsUrgent = true;
        if (!card.text) card.dirty.text = true;
        card.scheduleRender();
        this._updateAiTabBadge();

        this._panel?.setStatusIndicator(
            'busy',
            nextPending
                ? `⚠️ 等待您审批工具：${nextPending.toolName}`
                : allow
                    ? `已授权 ${target.toolName}，正在执行…`
                    : `已拒绝 ${target.toolName}，正在继续…`
        );
    }

    _onEvent(event) {
        if (!event || !this._panel || !this._chatController) return;

        if (event.type === 'models_discovered' && event.backend === 'openai' && Array.isArray(event.models)) {
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

        if (event.type === 'session_save_error') {
            this._panel.setStatusIndicator('error', `⚠️ ${event.message || '历史未保存'}`);
            return;
        }

        if ((event.type === 'bridge_warning' || event.type === 'mode_notice') && event.message) {
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

        if (event.type === 'tool_execution_start') {
            const card = this._ensureLiveCard(event);
            const node = this._tracePanel.findOrCreateToolNode(card, {
                toolCallId: event.toolCallId || '',
                toolName: event.toolName || '工具',
                summary: event.summary || '',
                isQuestion: Boolean(event.isQuestion),
                questions: event.questions,
                rawInput: event.rawInput,
            });
            if (node && node.status !== 'pending_approval' && node.status !== 'sending_approval' && node.status !== 'denied') {
                node.status = 'running';
                card.dirtyToolNodeIds?.add(node.id);
            }
            card.activeTool = true;
            card.dirty.tools = true;
            if (!card.text) card.dirty.text = true;
            if (!this._tracePanel.hasPendingApprovalNodes(card)) {
                this._panel.setStatusIndicator(
                    'busy',
                    node?.isQuestion
                        ? '💬 正在准备交互式提问…'
                        : `正在执行工具：${node?.toolName || event.toolName || '工具'}`
                );
            }
            card.scheduleRender();
        }

        if (event.type === 'permission_request') {
            const card = this._ensureLiveCard(event);
            const node = this._tracePanel.findOrCreateToolNode(card, {
                requestId: event.requestId || '',
                toolCallId: event.toolCallId || '',
                toolName: event.toolName || '工具',
                operationLabel: event.operationLabel || '',
                riskLevel: event.riskLevel || '',
                riskLabel: event.riskLabel || '',
                riskWarnings: event.riskWarnings,
                fullCommand: event.fullCommand || '',
                cwd: event.cwd || '',
                realCwd: event.realCwd || '',
                displayPath: event.displayPath || '',
                realPath: event.realPath || '',
                networkOrigin: event.networkOrigin || '',
                targetMismatch: Boolean(event.targetMismatch),
                symlinkEscape: Boolean(event.symlinkEscape),
                summary: event.summary || '',
                reason: event.reason || '',
                scopeKey: event.scopeKey || '',
                allowSessionRule: event.allowSessionRule,
                sessionRuleLabel: event.sessionRuleLabel || '',
                isQuestion: Boolean(event.isQuestion),
                questions: event.questions,
                rawInput: event.rawInput,
            });
            if (node) {
                node.status = 'pending_approval';
                node.approvalState = 'pending';
                card.dirtyToolNodeIds?.add(node.id);
                if (!this._tracePanel.hasPendingApprovalNodes(card) || !card.selectedNodeId) {
                    card.selectedNodeId = node.id;
                } else {
                    const selNode = card.toolNodes.find(n => n.id === card.selectedNodeId);
                    if (!selNode || selNode.status !== 'pending_approval') {
                        card.selectedNodeId = node.id;
                    }
                }
            }
            if (activeTurn) {
                activeTurn.state = 'awaiting_approval';
            }
            card.activeTool = true;
            card.dirty.tools = true;
            card.dirty.toolsUrgent = true;
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
        }

        if (event.type === 'permission_resolved') {
            const card = this._live || (event.autoApproved ? this._ensureLiveCard(event) : null);
            if (card?.toolNodes) {
                let node = card.toolNodes.find(
                    n => (event.requestId && n.requestId === event.requestId) ||
                         (event.toolCallId && n.toolCallId === event.toolCallId)
                );
                if (!node && event.autoApproved && event.requestId) {
                    node = this._tracePanel.findOrCreateToolNode(card, {
                        requestId: event.requestId,
                        toolCallId: event.toolCallId || '',
                        scopeKey: event.scopeKey || '',
                    });
                }
                if (node && (node.status === 'pending_approval' || node.status === 'sending_approval' || event.autoApproved)) {
                    const allow = event.decision !== 'deny';
                    if (node.status !== 'done' && node.status !== 'error') {
                        node.status = allow ? 'running' : 'denied';
                    }
                    if (!node.approvalState || node.approvalState === 'pending') {
                        node.approvalState = allow
                            ? (event.autoApproved ? 'always' : (node.isQuestion ? 'answered' : 'allowed'))
                            : 'denied';
                    }
                    card.dirtyToolNodeIds?.add(node.id);
                    if (card.selectedNodeId === node.id) {
                        const nextPending = card.toolNodes.find(n => n.status === 'pending_approval');
                        card.selectedNodeId = nextPending ? nextPending.id : null;
                    }
                }
                if (activeTurn) {
                    activeTurn.state = this._tracePanel.hasPendingApprovalNodes(card)
                        ? 'awaiting_approval'
                        : 'streaming';
                }
                card.dirty.tools = true;
                card.dirty.toolsUrgent = true;
                this._updateAiTabBadge();
                card.scheduleRender();
            }
        }

        if (event.type === 'tool_execution_end') {
            if (this._live?.toolNodes) {
                let node = null;
                if (event.toolCallId) {
                    node = this._live.toolNodes.find(n => n.toolCallId === event.toolCallId);
                }
                if (!node) {
                    for (let i = this._live.toolNodes.length - 1; i >= 0; i--) {
                        const cand = this._live.toolNodes[i];
                        if (cand.status === 'running' && (!event.toolName || cand.toolName === event.toolName)) {
                            node = cand;
                            break;
                        }
                    }
                }
                if (node) {
                    if (event.detail) node.detail = event.detail;
                    if (typeof event.duration === 'number' && event.duration > 0) {
                        node.duration = event.duration;
                    }
                    if (node.status !== 'denied') {
                        node.status = event.isError ? 'error' : 'done';
                    }
                    this._live.dirtyToolNodeIds?.add(node.id);
                }
                this._live.activeTool = this._live.toolNodes.some(
                    n => n.status === 'running' || n.status === 'pending_approval' || n.status === 'sending_approval'
                );
                this._live.dirty.tools = true;
                this._live.scheduleRender();
            }
        }

        if (event.type === 'tool_batch_end') {
            if (this._live?.toolNodes) {
                const confirmedIds = Array.isArray(event.toolCallIds) && event.toolCallIds.length > 0
                    ? new Set(event.toolCallIds.map(String))
                    : null;
                for (const node of this._live.toolNodes) {
                    if (node.status === 'running' && (!confirmedIds || (node.toolCallId && confirmedIds.has(node.toolCallId)))) {
                        node.status = 'done';
                        this._live.dirtyToolNodeIds?.add(node.id);
                    }
                }
                this._live.activeTool = this._live.toolNodes.some(
                    n => n.status === 'running' || n.status === 'pending_approval' || n.status === 'sending_approval'
                );
                this._live.dirty.tools = true;
                this._live.scheduleRender();
            }
        }

        if ((event.type === 'message_end' || event.type === 'message_final') && event.message?.role === 'assistant') {
            const text = messageText(event.message);
            const thinking = messageThinking(event.message);
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
                card.activeTool = false;
                this._panel.historyWindow?.updateStoredMessageById(card.messageId, {
                    text: card.text,
                    thinking: card.thinking,
                    modelId: card.modelId || this._modelLabel || '',
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
            const finishedText = this._live?.text || '';
            if (this._live) {
                if (this._live.toolNodes) {
                    for (const node of this._live.toolNodes) {
                        if (node.status === 'pending_approval' || node.status === 'sending_approval') {
                            node.status = 'denied';
                            node.approvalState = 'denied';
                            this._live.dirtyToolNodeIds?.add(node.id);
                            if (this._live.selectedNodeId === node.id) {
                                this._live.selectedNodeId = null;
                            }
                        } else if (node.status === 'running') {
                            node.status = 'interrupted';
                            this._live.dirtyToolNodeIds?.add(node.id);
                        }
                    }
                }
                this._live.activeTool = false;
                this._live.dirty.tools = true;
                this._live.dirty.toolsUrgent = true;
                this._live.dirty.text = true;
                this._panel.historyWindow?.updateStoredMessageById(this._live.messageId, {
                    text: this._live.text,
                    thinking: this._live.thinking,
                    modelId: this._live.modelId || this._modelLabel || '',
                    status: terminalStatus,
                });
                this._live.flushRender();
            }

            if (!this._isChatVisible() && terminalStatus === 'completed' && finishedText) {
                this._panel.hasUnreadBackgroundReply = true;
                if (
                    !this._dateIntegration?.menu?.isOpen &&
                    !Main.sessionMode.isLocked &&
                    !Main.sessionMode.isGreeter &&
                    this._getSettingBool('notify-on-complete', false)
                ) {
                    try {
                        Main.notify('随问 · 回答已完成', '点击顶部时间栏查看完整回答');
                    } catch (_) {}
                }
            }

            if (!event.turnId || this._chatController.activeTurnState?.turnId === event.turnId) {
                this._chatController.activeTurnState = null;
            }

            this._setBusy(false);
            if (terminalStatus === 'cancelled') {
                this._panel.setStatusIndicator('ready', '已停止生成');
            } else if (terminalStatus === 'timed_out') {
                this._panel.setStatusIndicator('error', event.errorMessage || '请求超时');
            } else if (terminalStatus === 'interrupted') {
                this._panel.setStatusIndicator('error', event.errorMessage || '输出中断（回答可能不完整）');
            } else if (terminalStatus === 'failed') {
                this._panel.setStatusIndicator('error', event.errorMessage ? `错误：${event.errorMessage}` : '执行失败');
            } else if (
                !this._panel.lastStatusText.startsWith('错误：') &&
                !this._panel.lastStatusText.startsWith('⚠️ 历史未保存')
            ) {
                this._panel.setStatusIndicator('ready', this._idleStatus || '随问');
            }

            this._live = null;
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

    async _newSession() {
        if (!this._chatController || this._chatController.busy) return;
        if (this._modelPicker?.isOpen) {
            this._modelPicker.toggle(false);
        }
        const prevClient = this._chatController.client;
        prevClient?.revokeApprovedScopes?.();
        if (prevClient) {
            try { await prevClient.request('flush_session'); } catch (_) {}
        }
        if (!this._isSessionUnlockedAndAlive() || this._chatController.busy) return;

        this._chatController.stopClient();
        this._live = null;
        this._draftInput = '';
        this._promptHistory = [];
        this._historyIndex = -1;
        this._modelPicker?.resetSessionState();
        this._settings.set_string('session-id', GLib.uuid_string_random());
        this._panel?.clearMessages();
        this._panel?.entry?.set_text('');
        if (this._panel) {
            this._panel.userScrolledUp = false;
            this._panel.updateJumpBottomVisibility();
        }
        this._ensureClient();
        this._panel?.entry?.grab_key_focus();
    }

    disable() {
        ++nextLifecycleGeneration;
        this._lifecycleGeneration = 0;
        this._enabled = false;

        this._unregisterGlobalKeybindings();

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

        for (const sig of this._traySignals || []) {
            try { Main.messageTray?.disconnect(sig); } catch (_) {}
        }
        this._traySignals = [];

        for (const [src, sig] of this._sourceSignals?.entries?.() || []) {
            try { src.disconnect(sig); } catch (_) {}
        }
        this._sourceSignals?.clear();

        this._live = null;
        this._chatController?.dispose();
        this._chatController = null;

        this._modelPicker?.dispose();
        this._modelPicker = null;

        const wrapper = this._panel?.wrapper || null;
        this._panel?.dispose();
        this._panel = null;
        this._cardFactory = null;
        this._tracePanel = null;

        for (const timerId of this._timers || []) {
            try { GLib.source_remove(timerId); } catch (_) {}
        }
        this._timers?.clear();

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
