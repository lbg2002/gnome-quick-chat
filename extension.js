import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {PiClient} from './piClient.js';
import {
    buildAskUserModifiedInput,
    computePermissionScope,
    detailedMessages,
    formatAskUserAnswerSummary,
    getBackendCapabilities,
    messageText,
    messageThinking,
} from './protocol.js';
import {getSessionsDir, resolveWorkspacePath} from './core/paths.js';
import {loadOpenAIApiKey} from './core/secretStore.js';
import {detectEffectiveBackend, loadLocalBackendCatalog} from './core/backendDetect.js';
import {DateMenuIntegration} from './ui/dateMenuIntegration.js';
import {renderCardBodyIncremental} from './ui/markdownRenderer.js';

const V = Clutter.Orientation.VERTICAL;
const H = Clutter.Orientation.HORIZONTAL;
const HISTORY_PAGE_SIZE = 24;

const QUICK_PROMPTS = [
    {label: '💡 解释命令或报错', prompt: '请帮我解释下面这段 Linux 命令或终端报错的含义，并给出解决建议：\n'},
    {label: '⚡ Ubuntu 效率技巧', prompt: '请告诉我几个在 Ubuntu 26 / GNOME 50 下非常实用的高频快捷键或终端技巧。'},
    {label: '📝 润色或翻译文本', prompt: '请帮我润色或翻译下面这段内容，使其表达更加自然准确：\n'},
];

function button(label, callback, styleClass = 'button qc-button', tooltip = '') {
    const b = new St.Button({
        label,
        style_class: styleClass,
        can_focus: true,
        reactive: true,
        track_hover: true,
        accessible_name: tooltip || label,
    });
    b.connect('clicked', callback);
    return b;
}

function wrapLabel(text, style = '') {
    const label = new St.Label({
        text: text ?? '',
        style_class: style,
        x_expand: true,
        y_align: Clutter.ActorAlign.START,
    });
    const ct = label.clutter_text;
    ct.line_wrap = true;
    ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    ct.ellipsize = Pango.EllipsizeMode.NONE;
    ct.selectable = false;
    return label;
}

function formatNowTime() {
    const now = GLib.DateTime.new_now_local();
    return now ? now.format('%H:%M') : '';
}

export default class QuickChat extends Extension {
    enable() {
        this._enabled = true;
        this._generation = 0;
        this._timers = new Set();
        this._sourceSignals = new Map();
        this._registeredKeybindings = new Set();
        this._promptHistory = [];
        this._historyIndex = -1;
        this._draftInput = '';
        this._userScrolledUp = false;
        this._needsReconnect = false;
        this._lastStatusState = '';
        this._lastStatusText = '';
        this._hasPendingBackgroundRender = false;
        this._hasUnreadBackgroundReply = false;
        this._allHistoryMessages = [];
        this._historyStartIndex = 0;
        this._loadMoreBtn = null;
        this._modelPickerOpen = false;

        this._settings = this.getSettings();
        this._dateIntegration = new DateMenuIntegration();

        this._wrapper = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-wrapper',
            x_expand: true,
            y_expand: true,
        });

        this._buildTopTabs();
        this._chat = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-chat',
            x_expand: true,
            y_expand: true,
        });
        this._wrapper.add_child(this._chat);
        this._buildChat();

        const mounted = this._dateIntegration.mount(
            this._wrapper,
            () => this._enabled && this._tab === 'ai'
        );
        if (!mounted) {
            try { this._wrapper.destroy(); } catch (_) {}
            this._wrapper = null;
            return;
        }

        this._tab = this._getSettingString('default-tab', 'ai') === 'notifications' ? 'notifications' : 'ai';
        this._setTab(this._tab, false, false);

        const dateMenu = this._dateIntegration.dateMenu;
        this._menuSignal = dateMenu.menu.connect('open-state-changed', (_, open) => {
            if (open) {
                this._syncThemeStyle();
                this._updateNotificationBadge();
                if (this._tab === 'ai') {
                    this._flushPendingBackgroundWork();
                    if (this._client) {
                        loadOpenAIApiKey(this._settings).then(k => this._client?.updateApiKey?.(k)).catch(() => {});
                    }
                    this._ensureClient();
                    this._scheduleTimeout(40, () => {
                        if (this._enabled && this._tab === 'ai') this._entry?.grab_key_focus();
                    });
                } else {
                    this._updateAiTabBadge();
                }
            } else if (this._modelPickerOpen) {
                this._toggleModelPicker(false);
            }
        });

        this._sessionSignal = Main.sessionMode.connect('updated', () => {
            // Never expose the transcript on the lock screen or greeter.
            if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter) {
                this._wrapper?.hide();
                this._stopClient();
            } else {
                this._wrapper?.show();
                this._setTab(this._tab, false, false);
            }
        });

        this._connectSettingsSignals();
        this._connectNotificationSignals();
        this._registerGlobalKeybindings();
        this._syncThemeStyle();
        this._applyDimensions();
    }

    _hasKey(key) {
        return Boolean(this._settings?.settings_schema?.has_key?.(key));
    }

    _getSettingString(key, fallback = '') {
        if (!this._hasKey(key)) return fallback;
        return this._settings.get_string(key);
    }

    _getSettingInt(key, fallback = 0) {
        if (!this._hasKey(key)) return fallback;
        return this._settings.get_int(key);
    }

    _getSettingBool(key, fallback = true) {
        if (!this._hasKey(key)) return fallback;
        return this._settings.get_boolean(key);
    }

    _animEnabled() {
        return this._getSettingBool('enable-animations', true);
    }

    _markdownEnabled() {
        return this._getSettingBool('render-markdown', true);
    }

    _isChatVisible() {
        return Boolean(
            this._enabled &&
            this._dateIntegration?.dateMenu?.menu?.isOpen &&
            this._tab === 'ai' &&
            !Main.sessionMode.isLocked &&
            !Main.sessionMode.isGreeter
        );
    }

    _scheduleTimeout(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(id);
            if (this._enabled) fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return id;
    }

    _clearTimer(id) {
        if (id && this._timers.has(id)) {
            GLib.source_remove(id);
            this._timers.delete(id);
        }
    }

    _easeActor(actor, params) {
        if (!actor) return;
        try {
            actor.remove_all_transitions?.();
        } catch (_) {}
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
        addBinding('clipboard-shortcut', () => this._triggerClipboardAsk());
    }

    _unregisterGlobalKeybindings() {
        for (const keyName of this._registeredKeybindings) {
            try {
                Main.wm.removeKeybinding(keyName);
            } catch (_) {}
        }
        this._registeredKeybindings.clear();
    }

    _toggleQuickChatPanel() {
        if (!this._enabled || Main.sessionMode.isLocked || Main.sessionMode.isGreeter) return;
        const menu = this._dateIntegration?.dateMenu?.menu;
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
            if (this._enabled && this._tab === 'ai') {
                this._entry?.grab_key_focus();
            }
        });
    }

    _triggerClipboardAsk(openPanelFirst = true) {
        if (!this._enabled || Main.sessionMode.isLocked || Main.sessionMode.isGreeter) return;
        const menu = this._dateIntegration?.dateMenu?.menu;
        if (openPanelFirst && menu && !menu.isOpen) {
            menu.open(true);
        }
        if (this._tab !== 'ai') {
            this._setTab('ai', true, true);
        }

        const clip = St.Clipboard.get_default();
        const applyClipText = raw => {
            const trimmed = String(raw || '').trim();
            if (!trimmed || !this._enabled) return;
            const clipped = trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}…` : trimmed;
            const prompt = `请帮我分析、解释或处理以下内容：\n${clipped}`;
            this._entry.set_text(prompt);
            this._entry.grab_key_focus();
            this._entry.clutter_text.set_cursor_position(-1);
        };

        clip.get_text(St.ClipboardType.CLIPBOARD, (_, text) => {
            if (text && text.trim()) {
                applyClipText(text);
                return;
            }
            clip.get_text(St.ClipboardType.PRIMARY, (__, primaryText) => {
                if (primaryText && primaryText.trim()) {
                    applyClipText(primaryText);
                } else {
                    this._entry?.grab_key_focus();
                }
            });
        });
    }

    _buildTopTabs() {
        this._tabs = new St.BoxLayout({orientation: H, style_class: 'qc-tabs', y_align: Clutter.ActorAlign.CENTER});
        const tabGroup = new St.BoxLayout({orientation: H, style_class: 'qc-tab-group'});

        this._aiTab = new St.Button({
            style_class: 'qc-tab-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            accessible_name: '切换到随问助手',
        });
        const aiContent = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-tab-content',
            y_align: Clutter.ActorAlign.CENTER,
        });
        aiContent.add_child(new St.Label({text: '✦ 随问', y_align: Clutter.ActorAlign.CENTER}));
        this._aiBadge = new St.Label({
            text: '●',
            style_class: 'qc-ai-tab-dot',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        aiContent.add_child(this._aiBadge);
        this._aiTab.set_child(aiContent);
        this._aiTab.connect('clicked', () => this._setTab('ai'));
        tabGroup.add_child(this._aiTab);

        this._notificationTab = new St.Button({
            style_class: 'qc-tab-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            accessible_name: '切换到系统通知',
        });
        const notifContent = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-tab-content',
            y_align: Clutter.ActorAlign.CENTER,
        });
        notifContent.add_child(new St.Label({text: '通知', y_align: Clutter.ActorAlign.CENTER}));
        this._notifBadge = new St.Label({
            text: '0',
            style_class: 'qc-tab-badge',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        notifContent.add_child(this._notifBadge);
        this._notificationTab.set_child(notifContent);
        this._notificationTab.connect('clicked', () => this._setTab('notifications'));
        tabGroup.add_child(this._notificationTab);

        this._tabs.add_child(tabGroup);
        this._tabs.add_child(new St.Widget({x_expand: true}));

        this._reconnectButton = button('↻', () => this._reconnectNow(), 'qc-icon-button', '重新连接智能后端');
        this._reconnectButton.visible = false;
        this._tabs.add_child(this._reconnectButton);

        this._settingsButton = button('⚙', () => {
            this._dateIntegration?.dateMenu?.menu?.close();
            this.openPreferences();
        }, 'qc-icon-button', '随问设置');
        this._tabs.add_child(this._settingsButton);

        this._wrapper.add_child(this._tabs);
    }

    _updateAiTabBadge() {
        if (!this._aiBadge) return;
        const hasPendingApproval = Boolean(
            this._live?.toolNodes?.some(n => n.status === 'pending_approval')
        );
        for (const cls of ['qc-ai-dot-busy', 'qc-ai-dot-pending', 'qc-ai-dot-unread']) {
            this._aiBadge.remove_style_class_name(cls);
        }

        if (this._tab === 'ai' && this._dateIntegration?.dateMenu?.menu?.isOpen) {
            this._aiBadge.visible = false;
            return;
        }

        if (hasPendingApproval) {
            this._aiBadge.text = '!';
            this._aiBadge.add_style_class_name('qc-ai-dot-pending');
            this._aiBadge.visible = true;
        } else if (this._busy) {
            this._aiBadge.text = '●';
            this._aiBadge.add_style_class_name('qc-ai-dot-busy');
            this._aiBadge.visible = true;
        } else if (this._hasUnreadBackgroundReply) {
            this._aiBadge.text = '●';
            this._aiBadge.add_style_class_name('qc-ai-dot-unread');
            this._aiBadge.visible = true;
        } else {
            this._aiBadge.visible = false;
        }
    }

    _flushPendingBackgroundWork() {
        this._hasUnreadBackgroundReply = false;
        this._updateAiTabBadge();
        if (!this._hasPendingBackgroundRender) return;
        this._hasPendingBackgroundRender = false;
        for (const card of this._cardList || []) {
            if (card.dirty?.text || card.dirty?.thinking || card.dirty?.tools) {
                card.flushRender?.(true);
            }
        }
        this._scrollBottom(false);
    }

    _buildChat() {
        const header = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-header',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._statusBtn = new St.Button({
            style_class: 'qc-status-btn',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            accessible_name: '点击快速切换模型与后端',
        });
        const statusBox = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-status-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._statusDot = new St.Widget({
            style_class: 'qc-status-dot',
            y_align: Clutter.ActorAlign.CENTER,
        });
        statusBox.add_child(this._statusDot);
        this._status = wrapLabel('未连接', 'qc-status');
        this._status.y_align = Clutter.ActorAlign.CENTER;
        statusBox.add_child(this._status);

        this._modelChevron = new St.Label({
            text: '▾',
            style_class: 'qc-status-chevron',
            y_align: Clutter.ActorAlign.CENTER,
        });
        statusBox.add_child(this._modelChevron);
        this._statusBtn.set_child(statusBox);
        this._statusBtn.connect('clicked', () => this._toggleModelPicker());
        header.add_child(this._statusBtn);

        this._clipAskBtn = button(
            '📋',
            () => this._triggerClipboardAsk(false),
            'qc-button-subtle',
            '读取剪贴板内容并提问'
        );
        header.add_child(this._clipAskBtn);

        this._newButton = button('＋ 新对话', () => this._newSession(), 'qc-button-subtle', '开启新对话');
        header.add_child(this._newButton);
        this._chat.add_child(header);

        this._modelPickerBox = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-model-picker',
            x_expand: true,
            visible: false,
        });
        this._chat.add_child(this._modelPickerBox);

        this._scrollStack = new St.Widget({
            style_class: 'qc-scroll-stack',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        this._scroll = new St.ScrollView({
            style_class: 'qc-scroll',
            x_expand: true,
            y_expand: true,
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._messages = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-messages',
            x_expand: true,
        });
        this._scroll.set_child(this._messages);
        this._scrollStack.add_child(this._scroll);

        this._jumpBottomBtn = new St.Button({
            style_class: 'qc-jump-bottom',
            can_focus: true,
            reactive: true,
            track_hover: true,
            accessible_name: '回到底部',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            visible: false,
            child: new St.Icon({
                icon_name: 'go-down-symbolic',
                style_class: 'qc-jump-icon',
            }),
        });
        this._jumpBottomBtn.connect('clicked', () => {
            this._userScrolledUp = false;
            this._updateJumpBottomVisibility();
            this._scrollBottom(true);
        });
        this._scrollStack.add_child(this._jumpBottomBtn);

        this._chat.add_child(this._scrollStack);

        const vadj = this._scroll.vadjustment;
        if (vadj) {
            this._vadjValueSig = vadj.connect('notify::value', () => this._onScrollChanged());
            this._vadjUpperSig = vadj.connect('notify::upper', () => this._onScrollChanged());
        }

        this._buildEmptyState();

        const inputRow = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-input-row',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._entry = new St.Entry({
            hint_text: '输入问题（Enter 发送，↑↓ 历史，Esc 停止）…',
            can_focus: true,
            x_expand: true,
            style_class: 'qc-entry',
            track_hover: true,
        });
        this._entry.clutter_text.connect('activate', () => this._send());
        this._entry.clutter_text.connect('key-press-event', (_, event) => this._onEntryKeyPress(event));
        inputRow.add_child(this._entry);

        this._sendButton = button('发送', () => this._send(), 'qc-send-btn', '发送问题');
        this._stopButton = button('■ 停止', () => this._abort(), 'qc-stop-btn', '停止生成');
        this._stopButton.hide();
        inputRow.add_child(this._sendButton);
        inputRow.add_child(this._stopButton);
        this._chat.add_child(inputRow);

        this._busy = false;
        this._ready = false;
        this._live = null;
    }

    _toggleModelPicker(forceState) {
        if (!this._modelPickerBox) return;
        const nextOpen = typeof forceState === 'boolean' ? forceState : !this._modelPickerOpen;
        this._modelPickerOpen = nextOpen;
        if (this._modelChevron) {
            this._modelChevron.text = nextOpen ? '▴' : '▾';
        }
        if (!nextOpen) {
            this._modelPickerBox.visible = false;
            this._dateIntegration?.nudgeLayout();
            return;
        }
        this._populateModelPicker();
        this._modelPickerBox.visible = true;
        this._dateIntegration?.nudgeLayout();
    }

    _populateModelPicker() {
        if (!this._modelPickerBox) return;
        this._modelPickerBox.destroy_all_children();

        const configuredBackend = this._getSettingString('backend', 'auto') || 'auto';
        const effectiveBackend = detectEffectiveBackend(
            configuredBackend,
            this._getSettingString('pi-path', 'pi'),
            this._getSettingString('openai-base-url', '')
        );

        // Row 1: Backend switcher chips
        const backendRow = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-picker-row',
            y_align: Clutter.ActorAlign.CENTER,
        });
        backendRow.add_child(new St.Label({
            text: '引擎:',
            style_class: 'qc-picker-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const backendChoices = [
            {id: 'auto', label: '自动'},
            {id: 'zcode', label: 'ZCode'},
            {id: 'codex', label: 'Codex'},
            {id: 'pi', label: 'Pi'},
            {id: 'openai', label: 'OpenAI'},
        ];
        for (const item of backendChoices) {
            const active = configuredBackend === item.id;
            const chip = button(
                item.label,
                () => {
                    this._settings.set_string('backend', item.id);
                    this._populateModelPicker();
                },
                active ? 'qc-picker-chip qc-picker-chip-active' : 'qc-picker-chip',
                `切换到 ${item.label}`
            );
            backendRow.add_child(chip);
        }
        this._modelPickerBox.add_child(backendRow);

        // Row 2: Discovered Models for effectiveBackend
        const catalog = loadLocalBackendCatalog(effectiveBackend);
        const curProvider = this._getSettingString('provider', '').trim();
        const curModel = effectiveBackend === 'openai'
            ? this._getSettingString('openai-model', '').trim()
            : this._getSettingString('model', '').trim();

        const modelEntries = [];
        const seen = new Set();
        for (const prov of catalog.providers) {
            for (const m of prov.models) {
                const key = `${prov.id}::${m}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    modelEntries.push({providerId: prov.id, providerName: prov.name, modelId: m});
                }
            }
        }

        if (modelEntries.length > 0) {
            const modelsWrap = new St.BoxLayout({
                orientation: V,
                style_class: 'qc-picker-models',
                x_expand: true,
            });

            // Group up to 10 models in compact 2-per-row layout
            const topEntries = modelEntries.slice(0, 10);
            for (let i = 0; i < topEntries.length; i += 2) {
                const line = new St.BoxLayout({orientation: H, style_class: 'qc-picker-row', x_expand: true});
                for (const entry of topEntries.slice(i, i + 2)) {
                    const isSelected = entry.modelId === curModel && (!curProvider || entry.providerId === curProvider);
                    const suffix = catalog.providers.length > 1 ? ` (${entry.providerName || entry.providerId})` : '';
                    const lbl = `${isSelected ? '✓ ' : ''}${entry.modelId}${suffix}`;
                    const mBtn = button(
                        lbl,
                        () => {
                            this._settings.set_string('provider', entry.providerId);
                            this._settings.set_string('model', entry.modelId);
                            this._toggleModelPicker(false);
                        },
                        isSelected ? 'qc-picker-model-btn qc-picker-chip-active' : 'qc-picker-model-btn',
                        lbl
                    );
                    mBtn.x_expand = true;
                    line.add_child(mBtn);
                }
                modelsWrap.add_child(line);
            }
            this._modelPickerBox.add_child(modelsWrap);
        } else {
            const hint = wrapLabel(
                effectiveBackend === 'openai'
                    ? `当前自定义模型：${curModel || '自动发现'}（可在设置中在线拉取列表）`
                    : '未检测到预设模型列表，将使用后端默认模型。',
                'qc-picker-empty'
            );
            this._modelPickerBox.add_child(hint);
        }

        // Row 3: Reasoning effort quick selector + link to full settings
        const footerRow = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-picker-row',
            y_align: Clutter.ActorAlign.CENTER,
        });
        footerRow.add_child(new St.Label({
            text: '思考:',
            style_class: 'qc-picker-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const curEffort = this._getSettingString('reasoning-effort', 'default') || 'default';
        for (const ef of [
            {id: 'default', label: '默认'},
            {id: 'fast', label: '快'},
            {id: 'standard', label: '标准'},
            {id: 'deep', label: '深入'},
        ]) {
            const efBtn = button(
                ef.label,
                () => {
                    if (this._hasKey('reasoning-effort')) {
                        this._settings.set_string('reasoning-effort', ef.id);
                    }
                    this._populateModelPicker();
                },
                curEffort === ef.id ? 'qc-picker-chip qc-picker-chip-active' : 'qc-picker-chip',
                `思考强度：${ef.label}`
            );
            footerRow.add_child(efBtn);
        }
        footerRow.add_child(new St.Widget({x_expand: true}));
        const moreBtn = button('更多设置…', () => {
            this._toggleModelPicker(false);
            this._dateIntegration?.dateMenu?.menu?.close();
            this.openPreferences();
        }, 'qc-picker-chip', '打开完整设置页面');
        footerRow.add_child(moreBtn);
        this._modelPickerBox.add_child(footerRow);
    }

    _buildEmptyState() {
        if (this._empty) {
            try { this._empty.destroy(); } catch (_) {}
        }
        const card = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-empty-card',
            x_expand: true,
        });
        const title = wrapLabel('有什么想问的？', 'qc-empty-title');

        const effBackend = detectEffectiveBackend(
            this._getSettingString('backend', 'auto'),
            this._getSettingString('pi-path', 'pi'),
            this._getSettingString('openai-base-url', '')
        );
        const caps = getBackendCapabilities(effBackend);
        const mode = this._getSettingString('agent-mode', 'readonly');
        const modeIdx = mode === 'full' ? 2 : mode === 'readonly' ? 1 : 0;
        const modeDesc = `当前模式：${caps.modeLabels[modeIdx] || caps.modeLabels[1]}`;
        const subtitle = wrapLabel(modeDesc, 'qc-empty-subtitle');
        card.add_child(title);
        card.add_child(subtitle);

        const chips = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-chips-box',
            x_expand: true,
        });
        for (const item of QUICK_PROMPTS) {
            const chip = button(item.label, () => {
                if (item.prompt.endsWith('\n')) {
                    this._entry.set_text(item.prompt);
                    this._entry.grab_key_focus();
                    this._entry.clutter_text.set_cursor_position(-1);
                } else {
                    this._entry.set_text(item.prompt);
                    this._send();
                }
            }, 'qc-chip', item.label);
            chip.x_align = Clutter.ActorAlign.START;
            chips.add_child(chip);
        }
        card.add_child(chips);
        this._empty = card;
        this._messages.add_child(this._empty);
    }

    _onEntryKeyPress(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;

        if (symbol === Clutter.KEY_Escape && this._busy) {
            this._abort();
            return Clutter.EVENT_STOP;
        }
        if (ctrl && (symbol === Clutter.KEY_n || symbol === Clutter.KEY_l) && !this._busy) {
            this._newSession();
            return Clutter.EVENT_STOP;
        }
        if ((symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) && !shift) {
            this._send();
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Up && this._promptHistory.length > 0 && !shift && !ctrl) {
            const current = this._entry.get_text();
            if (this._historyIndex === -1 && current.trim().length > 0) {
                return Clutter.EVENT_PROPAGATE;
            }
            if (this._historyIndex === -1) {
                this._draftInput = current;
                this._historyIndex = this._promptHistory.length - 1;
            } else if (this._historyIndex > 0) {
                this._historyIndex--;
            }
            this._entry.set_text(this._promptHistory[this._historyIndex] || '');
            this._entry.clutter_text.set_cursor_position(-1);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Down && this._historyIndex !== -1 && !shift && !ctrl) {
            if (this._historyIndex < this._promptHistory.length - 1) {
                this._historyIndex++;
                this._entry.set_text(this._promptHistory[this._historyIndex] || '');
            } else {
                this._historyIndex = -1;
                this._entry.set_text(this._draftInput || '');
            }
            this._entry.clutter_text.set_cursor_position(-1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onScrollChanged() {
        if (this._programmaticScroll) return;
        const adj = this._scroll?.vadjustment;
        if (!adj) return;
        const maxVal = Math.max(adj.lower, adj.upper - adj.page_size);
        const dist = maxVal - adj.value;
        if (dist > 75) {
            this._userScrolledUp = true;
        } else if (dist <= 20) {
            this._userScrolledUp = false;
        }
        this._updateJumpBottomVisibility();
    }

    _updateJumpBottomVisibility() {
        if (!this._jumpBottomBtn) return;
        const shouldShow = this._userScrolledUp;
        if (shouldShow && !this._jumpBottomBtn.visible) {
            this._jumpBottomBtn.opacity = 0;
            this._jumpBottomBtn.translation_y = 6;
            this._jumpBottomBtn.visible = true;
            this._easeActor(this._jumpBottomBtn, {
                opacity: 255,
                translation_y: 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else if (!shouldShow && this._jumpBottomBtn.visible) {
            this._jumpBottomBtn.visible = false;
        }
    }

    _connectSettingsSignals() {
        this._settingSignals = [];
        const watch = (key, fn) => {
            if (this._hasKey(key)) {
                this._settingSignals.push(this._settings.connect(`changed::${key}`, fn));
            }
        };
        watch('panel-width', () => this._applyDimensions());
        watch('panel-height', () => this._applyDimensions());
        watch('render-markdown', () => this._rerenderAllMessages());
        watch('toggle-shortcut', () => this._registerGlobalKeybindings());
        watch('clipboard-shortcut', () => this._registerGlobalKeybindings());

        const onBackendConfigChanged = () => {
            if (!this._enabled) return;
            if (this._busy) {
                this._needsReconnect = true;
            } else {
                this._reconnectNow();
            }
        };
        for (const key of [
            'backend',
            'pi-path',
            'provider',
            'model',
            'openai-base-url',
            'openai-api-key',
            'openai-model',
            'system-prompt',
            'reasoning-effort',
            'pi-idle-minutes',
            'agent-mode',
            'workspace',
        ]) {
            watch(key, onBackendConfigChanged);
        }

        try {
            this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            this._themeSig1 = this._interfaceSettings.connect('changed::color-scheme', () => this._syncThemeStyle());
            this._themeSig2 = this._interfaceSettings.connect('changed::gtk-theme', () => this._syncThemeStyle());
        } catch (_) {}
    }

    _syncThemeStyle() {
        if (!this._wrapper) return;
        let isLight = false;
        try {
            const scheme = this._interfaceSettings?.get_string('color-scheme') || '';
            const gtkTheme = (this._interfaceSettings?.get_string('gtk-theme') || '').toLowerCase();
            if (scheme === 'prefer-light' || (scheme === 'default' && gtkTheme.includes('light'))) {
                isLight = true;
            }
        } catch (_) {}
        if (isLight) this._wrapper.add_style_class_name('qc-light');
        else this._wrapper.remove_style_class_name('qc-light');
    }

    _connectNotificationSignals() {
        this._traySignals = [];
        const tray = Main.messageTray;
        if (!tray) return;

        const bindSource = source => {
            if (!source || this._sourceSignals.has(source)) return;
            const id = source.connect('notify::count', () => this._updateNotificationBadge());
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
            this._updateNotificationBadge();
        }));
        this._traySignals.push(tray.connect('source-removed', (_, src) => {
            unbindSource(src);
            this._updateNotificationBadge();
        }));
        this._traySignals.push(tray.connect('queue-changed', () => this._updateNotificationBadge()));

        try {
            for (const src of tray.getSources()) bindSource(src);
        } catch (_) {}

        this._updateNotificationBadge();
    }

    _updateNotificationBadge() {
        if (!this._notifBadge) return;
        let total = 0;
        try {
            for (const src of Main.messageTray?.getSources?.() || []) {
                total += Number(src.count || src.unseenCount || 0);
            }
        } catch (_) {}
        if (total > 0) {
            this._notifBadge.text = total > 99 ? '99+' : String(total);
            this._notifBadge.visible = true;
        } else {
            this._notifBadge.visible = false;
        }
    }

    _applyDimensions() {
        if (!this._wrapper || !this._chat || !this._scroll) return;
        const width = this._getSettingInt('panel-width', 460);
        const height = this._getSettingInt('panel-height', 380);
        this._wrapper.set_width(width);
        this._chat.set_width(Math.max(300, width - 16));
        this._scroll.set_height(height);
        this._dateIntegration?.nudgeLayout();
    }

    _setTab(tab, connect = true, animate = true) {
        if (!this._wrapper) return;
        const changed = this._tab !== tab;
        this._tab = tab;

        const showAi = tab === 'ai';
        const nativeList = this._dateIntegration?.nativeMessageList;
        const showNotif = tab === 'notifications' && Main.sessionMode.hasNotifications && !Main.sessionMode.isGreeter;

        if (showAi) {
            this._dateIntegration?.collapseNativeMessageExpansion();
        } else if (this._modelPickerOpen) {
            this._toggleModelPicker(false);
        }

        this._chat.visible = showAi;
        if (nativeList) nativeList.visible = showNotif;
        this._aiTab.set_checked?.(showAi);
        this._notificationTab.set_checked?.(tab === 'notifications');

        if (showAi) {
            this._aiTab.add_style_pseudo_class('checked');
            this._notificationTab.remove_style_pseudo_class('checked');
            this._flushPendingBackgroundWork();
            if (connect) {
                this._ensureClient();
                this._entry?.grab_key_focus();
            }
        } else {
            this._notificationTab.add_style_pseudo_class('checked');
            this._aiTab.remove_style_pseudo_class('checked');
            this._updateAiTabBadge();
        }

        this._dateIntegration?.nudgeLayout();

        const targetActor = showAi ? this._chat : (showNotif ? nativeList : null);
        if (animate && changed && targetActor && this._animEnabled()) {
            targetActor.opacity = 0;
            targetActor.translation_y = 7;
            this._easeActor(targetActor, {
                opacity: 255,
                translation_y: 0,
                duration: 170,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else if (targetActor) {
            targetActor.opacity = 255;
            targetActor.translation_y = 0;
        }
    }

    _setStatusIndicator(state, text) {
        if (!this._status || !this._statusDot) return;
        const nextText = String(text ?? '');
        if (this._lastStatusText !== nextText) {
            this._lastStatusText = nextText;
            this._status.text = nextText;
        }

        // Cache state so token deltas do NOT cancel/restart the 680ms pulse animation 20+ times/sec!
        if (this._lastStatusState === state) {
            return;
        }
        this._lastStatusState = state;

        this._statusDot.remove_style_class_name('qc-dot-ready');
        this._statusDot.remove_style_class_name('qc-dot-busy');
        this._statusDot.remove_style_class_name('qc-dot-error');
        try { this._statusDot.remove_all_transitions(); } catch (_) {}
        this._statusDot.opacity = 255;

        if (state === 'ready') {
            this._statusDot.add_style_class_name('qc-dot-ready');
            if (this._reconnectButton) this._reconnectButton.visible = false;
        } else if (state === 'busy') {
            this._statusDot.add_style_class_name('qc-dot-busy');
            if (this._reconnectButton) this._reconnectButton.visible = false;
            if (this._animEnabled()) {
                this._easeActor(this._statusDot, {
                    opacity: 90,
                    duration: 680,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    repeatCount: -1,
                    autoReverse: true,
                });
            }
        } else if (state === 'error') {
            this._statusDot.add_style_class_name('qc-dot-error');
            if (this._reconnectButton) this._reconnectButton.visible = true;
        } else {
            if (this._reconnectButton) this._reconnectButton.visible = true;
        }
    }

    async _loadRuntimeConfig() {
        const apiKey = await loadOpenAIApiKey(this._settings);
        return {
            backend: this._getSettingString('backend', 'auto').trim() || 'auto',
            executable: this._getSettingString('pi-path', 'pi').trim() || 'pi',
            provider: this._getSettingString('provider', '').trim(),
            model: this._getSettingString('model', '').trim(),
            openaiBaseUrl: this._getSettingString('openai-base-url', '').trim(),
            openaiApiKey: apiKey,
            openaiModel: this._getSettingString('openai-model', '').trim(),
            systemPrompt: this._getSettingString('system-prompt', '').trim(),
            reasoningEffort: this._getSettingString('reasoning-effort', 'default').trim() || 'default',
            piIdleMinutes: this._getSettingInt('pi-idle-minutes', 5),
            mode: this._getSettingString('agent-mode', 'readonly').trim() || 'readonly',
            workspace: this._getSettingString('workspace', '').trim(),
        };
    }

    _reconnectNow() {
        if (!this._enabled || this._busy) return;
        this._stopClient();
        this._ensureClient();
    }

    async _ensureClient() {
        if (!this._enabled || this._client || !this._chat || Main.sessionMode.isLocked || Main.sessionMode.isGreeter) {
            return;
        }
        const generation = ++this._generation;
        this._ready = false;
        this._setStatusIndicator('busy', '正在连接智能后端…');

        try {
            const config = await this._loadRuntimeConfig();
            if (!this._enabled || generation !== this._generation) return;

            const sessions = getSessionsDir();
            if (config.workspace && config.workspace.endsWith('/gnome-quick-chat/workspace')) {
                this._settings.set_string('workspace', '');
                config.workspace = '';
            }
            const work = resolveWorkspacePath(config.workspace);
            if (!GLib.file_test(work, GLib.FileTest.IS_DIR)) {
                GLib.mkdir_with_parents(work, 0o700);
            }
            if (!GLib.file_test(work, GLib.FileTest.IS_DIR)) throw new Error('配置的工作目录不存在');

            let sessionId = this._getSettingString('session-id', '');
            if (!sessionId) {
                sessionId = GLib.uuid_string_random();
                this._settings.set_string('session-id', sessionId);
            }

            const client = new PiClient(
                event => {
                    if (this._enabled && this._generation === generation) this._onEvent(event);
                },
                error => {
                    if (!this._enabled || this._generation !== generation) return;
                    this._client = null;
                    this._ready = false;
                    this._setBusy(false);
                    this._setStatusIndicator('error', error.message);
                }
            );
            this._client = client;
            client.start(config, work, sessions, sessionId);

            const state = await client.request('get_state');
            const data = await client.request('get_messages');
            if (!this._enabled || generation !== this._generation) return;

            const backendTag = state.backend === 'openai'
                ? 'OpenAI API'
                : state.backend === 'zcode'
                    ? 'ZCode'
                    : state.backend === 'codex'
                        ? 'Codex'
                        : 'Pi';
            this._modelLabel = state.model?.id || config.model || backendTag;

            this._renderInitialHistory(detailedMessages(data.messages));

            this._ready = true;
            const caps = getBackendCapabilities(state.backend);
            const badge = caps.modeBadges?.[config.mode] || '';
            this._idleStatus = badge ? `${this._modelLabel} · ${badge}` : this._modelLabel;
            this._setStatusIndicator('ready', this._idleStatus);
            this._setBusy(false);
            this._scrollBottom(true);
        } catch (error) {
            if (!this._enabled || generation !== this._generation) return;
            this._stopClient();
            this._setStatusIndicator('error', `连接失败：${error.message}`);
        }
    }

    _renderInitialHistory(allDetailed) {
        this._clearMessages();
        this._allHistoryMessages = Array.isArray(allDetailed) ? allDetailed : [];
        for (const msg of this._allHistoryMessages) {
            if (msg.role === 'user' && msg.text) {
                this._recordPromptHistory(msg.text);
            }
        }
        if (!this._allHistoryMessages.length) {
            this._historyStartIndex = 0;
            return;
        }

        this._historyStartIndex = Math.max(0, this._allHistoryMessages.length - HISTORY_PAGE_SIZE);
        this._syncLoadMoreHistoryButton();

        const recentSlice = this._allHistoryMessages.slice(this._historyStartIndex);
        for (const msg of recentSlice) {
            this._addMessage(msg.role, msg.text, {
                animate: false,
                thinking: msg.thinking || '',
                scrollOnAdd: false,
            });
        }
    }

    _syncLoadMoreHistoryButton() {
        if (this._historyStartIndex <= 0) {
            if (this._loadMoreBtn) {
                try { this._loadMoreBtn.destroy(); } catch (_) {}
                this._loadMoreBtn = null;
            }
            return;
        }
        const remaining = this._historyStartIndex;
        const label = `↑ 加载更早的 ${Math.min(HISTORY_PAGE_SIZE, remaining)} 条对话（剩余 ${remaining} 条）`;
        if (!this._loadMoreBtn) {
            this._loadMoreBtn = button(
                label,
                () => this._prependOlderHistoryBatch(),
                'qc-load-more-btn',
                '加载更早的历史对话'
            );
            this._messages.insert_child_at_index(this._loadMoreBtn, 0);
        } else {
            this._loadMoreBtn.label = label;
        }
    }

    _prependOlderHistoryBatch() {
        if (this._historyStartIndex <= 0 || !this._messages) return;
        const adj = this._scroll?.vadjustment;
        const prevUpper = adj ? adj.upper : 0;
        const prevValue = adj ? adj.value : 0;

        const nextStart = Math.max(0, this._historyStartIndex - HISTORY_PAGE_SIZE);
        const slice = this._allHistoryMessages.slice(nextStart, this._historyStartIndex);
        this._historyStartIndex = nextStart;
        this._syncLoadMoreHistoryButton();

        const baseInsertIdx = this._loadMoreBtn ? 1 : 0;
        slice.forEach((msg, offset) => {
            this._addMessage(msg.role, msg.text, {
                animate: false,
                thinking: msg.thinking || '',
                insertIndex: baseInsertIdx + offset,
                scrollOnAdd: false,
            });
        });

        // Preserve viewport scroll anchor after prepending above
        this._scheduleTimeout(20, () => {
            if (!adj) return;
            const deltaUpper = Math.max(0, adj.upper - prevUpper);
            this._programmaticScroll = true;
            adj.value = prevValue + deltaUpper;
            this._programmaticScroll = false;
        });
    }

    _recordPromptHistory(text) {
        const trimmed = text.trim();
        if (!trimmed) return;
        if (this._promptHistory.at(-1) !== trimmed) {
            this._promptHistory.push(trimmed);
            if (this._promptHistory.length > 50) this._promptHistory.shift();
        }
        this._historyIndex = -1;
    }

    _clearMessages() {
        if (this._live?.renderTimer) {
            this._clearTimer(this._live.renderTimer);
        }
        this._live = null;
        this._cardList = [];
        this._allHistoryMessages = [];
        this._historyStartIndex = 0;
        this._loadMoreBtn = null;
        this._empty = null;
        this._messages.destroy_all_children();
        this._buildEmptyState();
    }

    _copyWithFeedback(btn, getTextFn, defaultLabel = '复制') {
        const text = typeof getTextFn === 'function' ? getTextFn() : String(getTextFn ?? '');
        if (!text) return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        btn.label = '✓ 已复制';
        btn.add_style_class_name('qc-copied');
        if (this._animEnabled()) {
            btn.scale_x = 0.94;
            btn.scale_y = 0.94;
            this._easeActor(btn, {
                scale_x: 1.0,
                scale_y: 1.0,
                duration: 160,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        }
        if (btn._copyResetTimer) this._clearTimer(btn._copyResetTimer);
        btn._copyResetTimer = this._scheduleTimeout(1400, () => {
            btn._copyResetTimer = 0;
            try {
                btn.label = defaultLabel;
                btn.remove_style_class_name('qc-copied');
            } catch (_) {}
        });
    }

    _renderCardBody(card) {
        const pendingNode = card.toolNodes?.find(
            n => n.status === 'pending_approval' || n.status === 'sending_approval'
        );
        const placeholderText = pendingNode
            ? (pendingNode.isQuestion
                ? '请在上方问题卡片中选择或输入您的回答…'
                : '请在上方展开的审批栏中选择是否允许执行…')
            : card.activeTool
                ? `正在执行 ${card.toolNodes?.at(-1)?.toolName || '工具'}…`
                : card.thinking
                    ? '正在整理回答…'
                    : '…';

        renderCardBodyIncremental(card, {
            markdownEnabled: this._markdownEnabled(),
            placeholderText,
            onCreateCodeCopyButton: getCodeTextFn => {
                const codeCopyBtn = button('复制代码', () => {
                    this._copyWithFeedback(codeCopyBtn, getCodeTextFn, '复制代码');
                }, 'qc-copy-btn', '复制代码片段');
                return codeCopyBtn;
            },
        });
    }

    _syncToolNodeDotStyle(card, node) {
        const btn = node?.dotBtn;
        if (!btn) return;
        for (const cls of [
            'qc-dot-tool-ok',
            'qc-dot-tool-pending',
            'qc-dot-tool-running',
            'qc-dot-tool-error',
            'qc-dot-selected',
        ]) {
            btn.remove_style_class_name(cls);
        }
        if (node.status === 'pending_approval' || node.status === 'sending_approval') {
            btn.add_style_class_name('qc-dot-tool-pending');
        } else if (node.status === 'denied' || node.status === 'error') {
            btn.add_style_class_name('qc-dot-tool-error');
        } else if (node.status === 'running') {
            btn.add_style_class_name('qc-dot-tool-running');
        } else {
            btn.add_style_class_name('qc-dot-tool-ok');
        }
        if (card.selectedNodeId === node.id) {
            btn.add_style_class_name('qc-dot-selected');
        }
    }

    _formatShortHint(text, maxLen = 34) {
        const clean = String(text || '').replace(/\s+/g, ' ').trim();
        if (!clean) return '';
        return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
    }

    _updateTraceHint(card) {
        if (!card?.traceHintLabel) return;
        const hasThinking = Boolean(card.thinking && card.thinking.trim());
        const tools = card.toolNodes || [];

        const targetId = card.hoveredNodeId || card.selectedNodeId;
        if (targetId === 'thinking') {
            card.traceHintLabel.text = card.selectedNodeId === 'thinking'
                ? '思考过程（点击灰圆收起）'
                : '思考过程（点击展开）';
            return;
        }
        if (targetId) {
            const node = tools.find(n => n.id === targetId);
            if (node) {
                const brief = this._formatShortHint(node.summary, 28);
                if (node.isQuestion) {
                    card.traceHintLabel.text = brief
                        ? `问答: ${brief}`
                        : '交互式提问（点击小圆查看）';
                } else {
                    card.traceHintLabel.text = brief
                        ? `${node.toolName}: ${brief}`
                        : `${node.toolName}（点击小圆切换详情）`;
                }
                return;
            }
        }

        const pendingNode = tools.find(n => n.status === 'pending_approval' || n.status === 'sending_approval');
        if (pendingNode) {
            if (pendingNode.isQuestion) {
                const brief = this._formatShortHint(pendingNode.summary, 24);
                card.traceHintLabel.text = pendingNode.status === 'sending_approval'
                    ? '⏳ 正在提交回答…'
                    : (brief ? `💬 待回答: ${brief}` : '💬 待您回答问题');
            } else {
                card.traceHintLabel.text = pendingNode.status === 'sending_approval'
                    ? `⏳ 正在发送授权: ${pendingNode.toolName}`
                    : `⚠️ 待审批: ${pendingNode.toolName}`;
            }
            return;
        }
        const runningNode = tools.find(n => n.status === 'running');
        if (runningNode) {
            card.traceHintLabel.text = runningNode.isQuestion
                ? '正在提交回答并继续…'
                : `正在执行 ${runningNode.toolName}…`;
            return;
        }

        const segs = [];
        if (hasThinking) segs.push('思考');
        if (tools.length > 0) segs.push(`${tools.length} 项工具`);
        card.traceHintLabel.text = segs.length ? `${segs.join(' · ')}（点击小圆查看）` : '';
    }

    _hideQuestionForm(card) {
        if (!card) return;
        if (card.questionFormBox) {
            if (card.renderedQuestionNodeId) {
                card.questionFormBox.destroy_all_children();
                card.renderedQuestionNodeId = null;
                card.renderedQuestionWidgets = null;
            }
            card.questionFormBox.visible = false;
        }
        if (card.questionActions) {
            card.questionActions.visible = false;
        }
    }

    _syncQuestionFormState(card, node) {
        if (!card || !node) return;
        const interactive = node.status === 'pending_approval';
        for (const w of card.renderedQuestionWidgets || []) {
            const draft = node.questionDrafts?.[w.question] || {selectedLabels: [], customText: ''};
            for (const oRef of w.optionRefs) {
                const selected = draft.selectedLabels.includes(oRef.label);
                oRef.indLbl.text = w.multiSelect ? (selected ? '☑' : '☐') : (selected ? '●' : '○');
                if (selected) {
                    oRef.btn.add_style_class_name('qc-question-opt-selected');
                } else {
                    oRef.btn.remove_style_class_name('qc-question-opt-selected');
                }
                oRef.btn.reactive = interactive;
            }
            if (w.customEntry) {
                w.customEntry.reactive = interactive;
                if (w.multiSelect) {
                    w.customEntry.hint_text = '补充其他自定义项（可选，回车提交）…';
                } else if (draft.selectedLabels.length > 0) {
                    w.customEntry.hint_text = '已选上方选项，可在此补充备注（可选，回车提交）…';
                } else {
                    w.customEntry.hint_text = '或直接在此输入自定义回答（回车提交）…';
                }
            }
        }

        if (card.submitAnswerBtn) card.submitAnswerBtn.reactive = interactive;
        if (card.skipAnswerBtn) card.skipAnswerBtn.reactive = interactive;
        if (card.cancelQuestionBtn) card.cancelQuestionBtn.reactive = interactive;

        const warnLines = [];
        if (node.deliveryError) warnLines.push(`⚠️ ${node.deliveryError}`);
        if (node.validationHint) warnLines.push(`💡 ${node.validationHint}`);
        if (warnLines.length > 0) {
            card.drawerBody.text = warnLines.join('\n');
            card.drawerBody.visible = true;
        } else {
            card.drawerBody.visible = false;
        }
    }

    _ensureQuestionFormRendered(card, node) {
        if (!card?.questionFormBox || !node?.questions?.length) return;
        if (!node.questionDrafts) {
            node.questionDrafts = {};
        }

        if (card.renderedQuestionNodeId === node.id && Array.isArray(card.renderedQuestionWidgets)) {
            this._syncQuestionFormState(card, node);
            return;
        }

        card.questionFormBox.destroy_all_children();
        card.renderedQuestionNodeId = node.id;
        card.renderedQuestionWidgets = [];

        for (const q of node.questions) {
            if (!node.questionDrafts[q.question]) {
                node.questionDrafts[q.question] = {selectedLabels: [], customText: ''};
            }
            const draft = node.questionDrafts[q.question];

            const itemBox = new St.BoxLayout({
                orientation: V,
                style_class: 'qc-question-item',
                x_expand: true,
            });

            const metaRow = new St.BoxLayout({
                orientation: H,
                style_class: 'qc-question-meta-row',
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (q.header) {
                metaRow.add_child(new St.Label({
                    text: q.header,
                    style_class: 'qc-question-badge',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            metaRow.add_child(new St.Label({
                text: q.multiSelect ? '可多选' : '单选',
                style_class: 'qc-question-mode',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            itemBox.add_child(metaRow);

            const promptLbl = wrapLabel(q.question, 'qc-question-prompt');
            itemBox.add_child(promptLbl);

            const optsBox = new St.BoxLayout({
                orientation: V,
                style_class: 'qc-question-options',
                x_expand: true,
            });
            const optionRefs = [];
            for (const opt of q.options || []) {
                const optBtn = new St.Button({
                    style_class: 'qc-question-opt',
                    x_expand: true,
                    can_focus: true,
                    reactive: true,
                    track_hover: true,
                    accessible_name: opt.label,
                });
                const optRow = new St.BoxLayout({
                    orientation: H,
                    style_class: 'qc-question-opt-row',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.START,
                });
                const indLbl = new St.Label({
                    text: q.multiSelect ? '☐' : '○',
                    style_class: 'qc-question-indicator',
                    y_align: Clutter.ActorAlign.START,
                });
                const txtCol = new St.BoxLayout({
                    orientation: V,
                    style_class: 'qc-question-opt-text',
                    x_expand: true,
                });
                txtCol.add_child(wrapLabel(opt.label, 'qc-question-opt-label'));
                if (opt.description) {
                    txtCol.add_child(wrapLabel(opt.description, 'qc-question-opt-desc'));
                }
                optRow.add_child(indLbl);
                optRow.add_child(txtCol);
                optBtn.set_child(optRow);

                optBtn.connect('clicked', () => {
                    if (node.status !== 'pending_approval') return;
                    node.validationHint = '';
                    if (q.multiSelect) {
                        const idx = draft.selectedLabels.indexOf(opt.label);
                        if (idx >= 0) {
                            draft.selectedLabels.splice(idx, 1);
                        } else {
                            draft.selectedLabels.push(opt.label);
                        }
                    } else if (draft.selectedLabels[0] === opt.label) {
                        draft.selectedLabels = [];
                    } else {
                        draft.selectedLabels = [opt.label];
                    }
                    this._syncQuestionFormState(card, node);
                });

                optsBox.add_child(optBtn);
                optionRefs.push({label: opt.label, btn: optBtn, indLbl});
            }
            if (optionRefs.length > 0) {
                itemBox.add_child(optsBox);
            }

            const customEntry = new St.Entry({
                style_class: 'qc-question-entry',
                hint_text: '或直接在此输入自定义回答（回车提交）…',
                can_focus: true,
                x_expand: true,
            });
            if (draft.customText) {
                customEntry.set_text(draft.customText);
            }
            const ct = customEntry.clutter_text;
            ct.connect('text-changed', () => {
                draft.customText = customEntry.get_text();
                if (node.validationHint && draft.customText.trim()) {
                    node.validationHint = '';
                }
                this._syncQuestionFormState(card, node);
            });
            ct.connect('activate', () => {
                if (node.status === 'pending_approval') {
                    this._submitQuestionDecision(card, 'answer');
                }
            });
            itemBox.add_child(customEntry);

            card.questionFormBox.add_child(itemBox);
            card.renderedQuestionWidgets.push({
                question: q.question,
                multiSelect: q.multiSelect,
                optionRefs,
                customEntry,
            });
        }

        this._syncQuestionFormState(card, node);
    }

    _updateCardActivity(card) {
        if (!card || card.role !== 'assistant' || !card.traceBox) return;
        const hasThinking = Boolean(card.thinking && card.thinking.trim());
        const tools = card.toolNodes || [];
        if (!hasThinking && tools.length === 0) {
            card.traceBox.visible = false;
            return;
        }
        card.traceBox.visible = true;

        // 1. Update grey Thinking dot
        if (card.thinkingDot) {
            card.thinkingDot.visible = hasThinking;
            if (card.selectedNodeId === 'thinking') {
                card.thinkingDot.add_style_class_name('qc-dot-selected');
            } else {
                card.thinkingDot.remove_style_class_name('qc-dot-selected');
            }
        }

        // 2. Update each Tool dot's color & selection ring
        for (const node of tools) {
            this._syncToolNodeDotStyle(card, node);
        }

        // 3. Update inline hint caption next to dots
        this._updateTraceHint(card);

        // 4. Update collapsible detail drawer below dots
        const selId = card.selectedNodeId;
        if (!selId) {
            this._hideQuestionForm(card);
            card.detailDrawer.visible = false;
            return;
        }

        if (selId === 'thinking') {
            this._hideQuestionForm(card);
            if (!hasThinking) {
                card.detailDrawer.visible = false;
                return;
            }
            card.detailDrawer.visible = true;
            card.detailDrawer.remove_style_class_name('qc-drawer-pending');
            card.drawerTitle.text = '💭 思考过程';
            card.drawerSummary.visible = false;
            card.drawerBody.text = card.thinking.trim();
            card.drawerBody.visible = true;
            card.drawerActions.visible = false;
            return;
        }

        const node = tools.find(n => n.id === selId);
        if (!node) {
            this._hideQuestionForm(card);
            card.detailDrawer.visible = false;
            return;
        }

        card.detailDrawer.visible = true;
        const isAwaiting = node.status === 'pending_approval' || node.status === 'sending_approval';
        if (isAwaiting) {
            card.detailDrawer.add_style_class_name('qc-drawer-pending');
        } else {
            card.detailDrawer.remove_style_class_name('qc-drawer-pending');
        }

        const durSuffix = node.duration > 0 ? ` (${(node.duration / 1000).toFixed(1)}s)` : '';

        if (node.isQuestion && Array.isArray(node.questions) && node.questions.length > 0) {
            let qTitle = '💬 交互式提问';
            if (node.status === 'sending_approval') {
                qTitle = '⏳ 正在提交您的回答…';
            } else if (node.status === 'pending_approval') {
                qTitle = node.questions.length > 1
                    ? `💬 请回答以下问题（共 ${node.questions.length} 项）`
                    : '💬 请选择或输入您的回答';
            } else if (node.status === 'running') {
                qTitle = '⏳ 已收到回答，AI 正在继续处理…';
            } else if (node.status === 'denied') {
                qTitle = '✕ 已取消本次提问';
            } else if (node.status === 'error') {
                qTitle = `⚠️ 提问处理异常${durSuffix}`;
            } else if (node.approvalState === 'skipped') {
                qTitle = `⏭ 已交由 AI 自行判断${durSuffix}`;
            } else {
                qTitle = `✓ 已回答问题${durSuffix}`;
            }
            card.drawerTitle.text = qTitle;

            if (isAwaiting) {
                card.drawerSummary.visible = false;
                card.drawerActions.visible = false;
                card.questionFormBox.visible = true;
                card.questionActions.visible = true;
                this._ensureQuestionFormRendered(card, node);
                return;
            }

            this._hideQuestionForm(card);
            card.drawerActions.visible = false;
            if (node.summary) {
                card.drawerSummary.text = node.summary;
                card.drawerSummary.visible = true;
            } else {
                card.drawerSummary.visible = false;
            }

            const doneLines = [];
            if (node.userAnswerSummary) {
                doneLines.push(node.userAnswerSummary);
            }
            if (node.status === 'error' && node.detail) {
                doneLines.push(`⚠️ ${node.detail}`);
            }
            if (doneLines.length > 0) {
                card.drawerBody.text = doneLines.join('\n');
                card.drawerBody.visible = true;
            } else {
                card.drawerBody.visible = false;
            }
            return;
        }

        this._hideQuestionForm(card);
        let statusTitle = `🔧 ${node.toolName}`;
        if (node.status === 'sending_approval') {
            statusTitle = `⏳ 正在发送授权：${node.toolName}…`;
        } else if (node.status === 'pending_approval') {
            statusTitle = `🛡️ 请求授权调用：${node.toolName}`;
        } else if (node.status === 'running') {
            statusTitle = node.approvalState
                ? `⏳ 已授权，正在执行：${node.toolName}`
                : `⏳ 正在执行：${node.toolName}`;
        } else if (node.status === 'denied') {
            statusTitle = `✕ 已拒绝调用：${node.toolName}`;
        } else if (node.status === 'error') {
            statusTitle = `⚠️ 执行异常：${node.toolName}${durSuffix}`;
        } else if (node.approvalState === 'always') {
            statusTitle = `✓ 已按范围授权执行：${node.toolName}${durSuffix}`;
        } else if (node.approvalState === 'allowed') {
            statusTitle = `✓ 已批准并完成：${node.toolName}${durSuffix}`;
        } else {
            statusTitle = `✓ 已执行工具：${node.toolName}${durSuffix}`;
        }
        card.drawerTitle.text = statusTitle;

        if (node.summary && node.summary !== node.toolName) {
            card.drawerSummary.text = node.summary;
            card.drawerSummary.visible = true;
        } else {
            card.drawerSummary.visible = false;
        }

        const extraLines = [];
        if (node.deliveryError) {
            extraLines.push(`⚠️ ${node.deliveryError}`);
        }
        if (isAwaiting) {
            if (node.reason && node.reason !== node.summary) extraLines.push(node.reason);
        } else if (node.detail && node.detail !== node.summary) {
            extraLines.push(node.detail);
        }

        if (extraLines.length > 0) {
            card.drawerBody.text = extraLines.join('\n');
            card.drawerBody.visible = true;
        } else if (!card.drawerSummary.visible) {
            card.drawerBody.text = `工具名称：${node.toolName}`;
            card.drawerBody.visible = true;
        } else {
            card.drawerBody.visible = false;
        }

        card.drawerActions.visible = isAwaiting;
        if (isAwaiting) {
            const buttonsInteractive = node.status === 'pending_approval';
            card.allowBtn.reactive = buttonsInteractive;
            card.denyBtn.reactive = buttonsInteractive;
            if (node.allowSessionRule === false) {
                card.alwaysBtn.visible = false;
            } else {
                card.alwaysBtn.visible = true;
                card.alwaysBtn.reactive = buttonsInteractive;
                card.alwaysBtn.label = node.sessionRuleLabel || '✓ 本次会话允许';
            }
        }
    }

    _addMessage(role, text, options = {}) {
        const {
            animate = true,
            thinking = '',
            insertIndex = -1,
            scrollOnAdd = true,
        } = options;
        this._empty?.hide();

        const box = new St.BoxLayout({
            orientation: V,
            style_class: role === 'user' ? 'qc-message qc-user' : 'qc-message qc-assistant',
            x_expand: true,
        });

        const top = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-message-header',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const name = new St.Label({
            text: role === 'user' ? '我' : (this._modelLabel || '随问'),
            style_class: 'qc-role',
            y_align: Clutter.ActorAlign.CENTER,
        });
        top.add_child(name);

        const time = new St.Label({
            text: formatNowTime(),
            style_class: 'qc-time',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        top.add_child(time);

        const card = {
            role,
            box,
            text: text || '',
            thinking: thinking || '',
            thinkingHadContent: Boolean(thinking && thinking.trim()),
            toolNodes: [],
            selectedNodeId: null,
            hoveredNodeId: null,
            activeTool: false,
            renderTimer: 0,
            renderState: null,
            dirty: {text: true, thinking: Boolean(thinking), tools: Boolean(thinking)},
        };

        if (role === 'assistant') {
            const retryBtn = button('↻', () => this._retryForAssistantCard(card), 'qc-copy-btn', '重新生成该回答');
            top.add_child(retryBtn);
        }

        const copyBtn = button('复制', () => {
            this._copyWithFeedback(copyBtn, () => card.text, '复制');
        }, 'qc-copy-btn', '复制消息原文');
        top.add_child(copyBtn);
        box.add_child(top);

        if (role === 'assistant') {
            const traceBox = new St.BoxLayout({
                orientation: V,
                style_class: 'qc-trace-box',
                x_expand: true,
                visible: false,
            });

            const dotsRow = new St.BoxLayout({
                orientation: H,
                style_class: 'qc-trace-dots-row',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const thinkingDot = new St.Button({
                style_class: 'qc-dot-circle qc-dot-thinking',
                can_focus: true,
                reactive: true,
                track_hover: true,
                accessible_name: '思考过程',
                y_align: Clutter.ActorAlign.CENTER,
                visible: false,
            });
            thinkingDot.connect('clicked', () => {
                card.selectedNodeId = card.selectedNodeId === 'thinking' ? null : 'thinking';
                this._updateCardActivity(card);
            });
            thinkingDot.connect('notify::hover', () => {
                card.hoveredNodeId = thinkingDot.hover
                    ? 'thinking'
                    : (card.hoveredNodeId === 'thinking' ? null : card.hoveredNodeId);
                this._updateTraceHint(card);
            });
            dotsRow.add_child(thinkingDot);

            const toolDotsBox = new St.BoxLayout({
                orientation: H,
                style_class: 'qc-tool-dots-box',
                y_align: Clutter.ActorAlign.CENTER,
            });
            dotsRow.add_child(toolDotsBox);

            const traceHintLabel = new St.Label({
                text: '',
                style_class: 'qc-trace-hint',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            dotsRow.add_child(traceHintLabel);
            traceBox.add_child(dotsRow);

            const detailDrawer = new St.BoxLayout({
                orientation: V,
                style_class: 'qc-trace-drawer',
                x_expand: true,
                visible: false,
            });

            const drawerHeader = new St.BoxLayout({
                orientation: H,
                style_class: 'qc-drawer-header',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const drawerTitle = wrapLabel('', 'qc-drawer-title');
            drawerTitle.x_expand = true;
            drawerHeader.add_child(drawerTitle);

            const drawerCloseBtn = button('收起', () => {
                card.selectedNodeId = null;
                this._updateCardActivity(card);
            }, 'qc-drawer-close', '收起详情');
            drawerHeader.add_child(drawerCloseBtn);
            detailDrawer.add_child(drawerHeader);

            const drawerSummary = wrapLabel('', 'qc-approval-summary');
            drawerSummary.visible = false;
            detailDrawer.add_child(drawerSummary);

            const questionFormBox = new St.BoxLayout({
                orientation: V,
                style_class: 'qc-question-form',
                x_expand: true,
                visible: false,
            });
            detailDrawer.add_child(questionFormBox);

            const drawerBody = wrapLabel('', 'qc-drawer-body');
            drawerBody.visible = false;
            detailDrawer.add_child(drawerBody);

            const drawerActions = new St.BoxLayout({
                orientation: H,
                style_class: 'qc-approval-actions',
                y_align: Clutter.ActorAlign.CENTER,
                visible: false,
            });
            const allowBtn = button(
                '✓ 允许本次',
                () => this._submitActiveToolDecision(card, 'allow', false),
                'qc-approval-btn qc-approval-allow',
                '允许本次工具调用'
            );
            const alwaysBtn = button(
                '✓ 本次会话允许',
                () => this._submitActiveToolDecision(card, 'allow', true),
                'qc-approval-btn qc-approval-always',
                '当前会话对同类范围授权'
            );
            const denyBtn = button(
                '✕ 拒绝',
                () => this._submitActiveToolDecision(card, 'deny', false),
                'qc-approval-btn qc-approval-deny',
                '拒绝本次工具调用'
            );
            drawerActions.add_child(allowBtn);
            drawerActions.add_child(alwaysBtn);
            drawerActions.add_child(denyBtn);
            detailDrawer.add_child(drawerActions);

            const questionActions = new St.BoxLayout({
                orientation: H,
                style_class: 'qc-approval-actions',
                y_align: Clutter.ActorAlign.CENTER,
                visible: false,
            });
            const submitAnswerBtn = button(
                '✓ 提交回答',
                () => this._submitQuestionDecision(card, 'answer'),
                'qc-approval-btn qc-approval-allow',
                '提交所选回答并继续'
            );
            const skipAnswerBtn = button(
                '⏭ 交由 AI 判断',
                () => this._submitQuestionDecision(card, 'skip'),
                'qc-approval-btn qc-approval-always',
                '不指定偏好，交由 AI 自行判断'
            );
            const cancelQuestionBtn = button(
                '✕ 取消',
                () => this._submitQuestionDecision(card, 'deny'),
                'qc-approval-btn qc-approval-deny',
                '取消本次提问'
            );
            questionActions.add_child(submitAnswerBtn);
            questionActions.add_child(skipAnswerBtn);
            questionActions.add_child(cancelQuestionBtn);
            detailDrawer.add_child(questionActions);

            traceBox.add_child(detailDrawer);
            box.add_child(traceBox);

            card.traceBox = traceBox;
            card.dotsRow = dotsRow;
            card.thinkingDot = thinkingDot;
            card.toolDotsBox = toolDotsBox;
            card.traceHintLabel = traceHintLabel;
            card.detailDrawer = detailDrawer;
            card.drawerTitle = drawerTitle;
            card.drawerSummary = drawerSummary;
            card.questionFormBox = questionFormBox;
            card.renderedQuestionNodeId = null;
            card.renderedQuestionWidgets = null;
            card.drawerBody = drawerBody;
            card.drawerActions = drawerActions;
            card.allowBtn = allowBtn;
            card.alwaysBtn = alwaysBtn;
            card.denyBtn = denyBtn;
            card.questionActions = questionActions;
            card.submitAnswerBtn = submitAnswerBtn;
            card.skipAnswerBtn = skipAnswerBtn;
            card.cancelQuestionBtn = cancelQuestionBtn;
        }

        const bodyBox = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-message-body',
            x_expand: true,
        });
        box.add_child(bodyBox);
        card.bodyBox = bodyBox;

        card.flushRender = (forceAll = false) => {
            if (card.renderTimer) {
                this._clearTimer(card.renderTimer);
                card.renderTimer = 0;
            }
            if (!this._isChatVisible() && !forceAll && card === this._live) {
                this._hasPendingBackgroundRender = true;
                this._updateAiTabBadge();
                return;
            }
            if (forceAll || card.dirty.tools || (card.dirty.thinking && card.selectedNodeId === 'thinking')) {
                this._updateCardActivity(card);
                card.dirty.tools = false;
                card.dirty.thinking = false;
            }
            if (forceAll || card.dirty.text) {
                this._renderCardBody(card);
                card.dirty.text = false;
            }
        };

        card.scheduleRender = () => {
            if (!this._isChatVisible()) {
                this._hasPendingBackgroundRender = true;
                this._updateAiTabBadge();
                return;
            }
            if (card.dirty.tools) {
                this._updateCardActivity(card);
                card.dirty.tools = false;
            }
            if (!card.dirty.text && !(card.dirty.thinking && card.selectedNodeId === 'thinking')) {
                return;
            }
            if (card.renderTimer) return;

            const len = card.text.length;
            const intervalMs = len > 4000 ? 110 : len > 1500 ? 75 : 48;
            card.renderTimer = this._scheduleTimeout(intervalMs, () => {
                card.renderTimer = 0;
                if (!this._isChatVisible()) {
                    this._hasPendingBackgroundRender = true;
                    this._updateAiTabBadge();
                    return;
                }
                if (card.dirty.tools || (card.dirty.thinking && card.selectedNodeId === 'thinking')) {
                    this._updateCardActivity(card);
                    card.dirty.tools = false;
                    card.dirty.thinking = false;
                }
                if (card.dirty.text) {
                    this._renderCardBody(card);
                    card.dirty.text = false;
                }
                this._scrollBottom(false);
            });
        };

        card.flushRender(true);

        if (insertIndex >= 0) {
            this._messages.insert_child_at_index(box, insertIndex);
            if (!this._cardList) this._cardList = [];
            this._cardList.unshift(card);
        } else {
            this._messages.add_child(box);
            if (!this._cardList) this._cardList = [];
            this._cardList.push(card);
        }

        if (animate && this._animEnabled() && this._isChatVisible()) {
            box.opacity = 0;
            box.translation_y = 9;
            this._easeActor(box, {
                opacity: 255,
                translation_y: 0,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }

        if (scrollOnAdd) {
            this._scrollBottom(role === 'user');
        }
        return card;
    }

    _retryForAssistantCard(assistantCard) {
        if (this._busy || !this._cardList) return;
        const idx = this._cardList.indexOf(assistantCard);
        for (let i = (idx >= 0 ? idx - 1 : this._cardList.length - 1); i >= 0; i--) {
            const c = this._cardList[i];
            if (c?.role === 'user' && c.text?.trim()) {
                this._entry.set_text(c.text.trim());
                this._send();
                return;
            }
        }
    }

    _rerenderAllMessages() {
        for (const card of this._cardList || []) {
            card.renderState = null;
            card.flushRender?.(true);
        }
    }

    _scrollBottom(force = false) {
        if (!this._isChatVisible() && !force) return;
        if (force) {
            this._userScrolledUp = false;
            this._updateJumpBottomVisibility();
        }
        if (this._userScrolledUp && !force) return;
        if (this._scrollIdle) return;
        this._scrollIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scrollIdle = 0;
            const adj = this._scroll?.vadjustment;
            if (!adj) return GLib.SOURCE_REMOVE;
            const target = Math.max(adj.lower, adj.upper - adj.page_size);
            if (Math.abs(adj.value - target) < 1) return GLib.SOURCE_REMOVE;
            this._programmaticScroll = true;
            if (this._animEnabled() && adj.ease) {
                try {
                    const p = adj.ease(target, {
                        duration: 130,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onComplete: () => { this._programmaticScroll = false; },
                    });
                    p?.catch?.(() => { this._programmaticScroll = false; });
                } catch (_) {
                    adj.value = target;
                    this._programmaticScroll = false;
                }
            } else {
                adj.value = target;
                this._programmaticScroll = false;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _setBusy(busy) {
        this._busy = busy;
        if (this._sendButton) this._sendButton.visible = !busy;
        if (this._stopButton) this._stopButton.visible = busy;
        if (this._newButton) this._newButton.reactive = !busy;
        this._updateAiTabBadge();
    }

    async _send() {
        const text = this._entry.get_text().trim();
        if (!text || this._busy) return;
        if (this._modelPickerOpen) {
            this._toggleModelPicker(false);
        }
        if (!this._ready) {
            await this._ensureClient();
            if (!this._ready) return;
        }
        if (!this._enabled || this._busy) return;

        const generation = this._generation;
        this._recordPromptHistory(text);
        this._entry.set_text('');
        this._addMessage('user', text, {animate: true});
        this._live = null;
        this._setBusy(true);
        this._setStatusIndicator('busy', '思考与生成中…');

        try {
            const result = await this._client.request('prompt', {message: text});
            if (this._enabled && generation === this._generation && result.disposition === 'handled') {
                this._setBusy(false);
                this._setStatusIndicator('ready', this._idleStatus || '随问');
            }
        } catch (error) {
            if (!this._enabled || generation !== this._generation) return;
            this._setStatusIndicator('error', `发送失败：${error.message}`);
            this._setBusy(false);
            if (!this._entry.get_text()) this._entry.set_text(text);
            if (error.message.includes('超时')) this._stopClient();
        }
    }

    _ensureLiveCard() {
        if (!this._live) {
            this._live = this._addMessage('assistant', '', {animate: true});
        }
        return this._live;
    }

    _findOrCreateToolNode(card, info = {}) {
        if (!card?.toolNodes) return null;
        const {requestId = '', toolCallId = '', toolName = ''} = info;
        let node = null;

        if (requestId) {
            node = card.toolNodes.find(n => n.requestId && n.requestId === requestId);
        }
        if (!node && toolCallId) {
            node = card.toolNodes.find(n => n.toolCallId && n.toolCallId === toolCallId);
        }
        if (!node && toolName && toolName !== '工具') {
            for (let i = card.toolNodes.length - 1; i >= 0; i--) {
                const cand = card.toolNodes[i];
                if (
                    cand.toolName === toolName &&
                    (cand.status === 'running' || cand.status === 'pending_approval' || cand.status === 'sending_approval') &&
                    (!toolCallId || !cand.toolCallId || cand.toolCallId === toolCallId)
                ) {
                    node = cand;
                    break;
                }
            }
        }

        if (!node) {
            const index = card.toolNodes.length + 1;
            const id = `tool_${index}_${Date.now()}`;
            const defaultScope = computePermissionScope(toolName || '工具', info.summary || '');
            node = {
                id,
                index,
                requestId: requestId || '',
                toolCallId: toolCallId || '',
                toolName: toolName || '工具',
                summary: '',
                reason: '',
                detail: '',
                duration: 0,
                status: 'running',
                approvalState: '',
                scopeKey: info.scopeKey ?? defaultScope.scopeKey,
                allowSessionRule: typeof info.allowSessionRule === 'boolean'
                    ? info.allowSessionRule
                    : defaultScope.allowSessionRule,
                sessionRuleLabel: info.sessionRuleLabel || defaultScope.sessionRuleLabel,
                isQuestion: Boolean(info.isQuestion),
                questions: Array.isArray(info.questions) ? info.questions : [],
                rawInput: info.rawInput && typeof info.rawInput === 'object' ? info.rawInput : null,
                questionDrafts: null,
                validationHint: '',
                userAnswerSummary: '',
                deliveryError: '',
                dotBtn: null,
            };

            if (card.toolDotsBox) {
                const dotBtn = new St.Button({
                    style_class: 'qc-dot-circle qc-dot-tool-running',
                    can_focus: true,
                    reactive: true,
                    track_hover: true,
                    accessible_name: node.isQuestion ? '交互式提问' : `工具 ${node.toolName}`,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                dotBtn.connect('clicked', () => {
                    card.selectedNodeId = card.selectedNodeId === node.id ? null : node.id;
                    this._updateCardActivity(card);
                });
                dotBtn.connect('notify::hover', () => {
                    card.hoveredNodeId = dotBtn.hover
                        ? node.id
                        : (card.hoveredNodeId === node.id ? null : card.hoveredNodeId);
                    this._updateTraceHint(card);
                });
                node.dotBtn = dotBtn;
                card.toolDotsBox.add_child(dotBtn);
            }

            card.toolNodes.push(node);
        } else {
            if (requestId && !node.requestId) node.requestId = requestId;
            if (toolCallId && !node.toolCallId) node.toolCallId = toolCallId;
            if (toolName && toolName !== '工具' && (!node.toolName || node.toolName === '工具')) {
                node.toolName = toolName;
            }
        }

        if (info.isQuestion) {
            node.isQuestion = true;
            node.allowSessionRule = false;
            node.scopeKey = '';
            node.sessionRuleLabel = '';
            if (Array.isArray(info.questions) && info.questions.length > 0) {
                node.questions = info.questions;
            }
            if (info.rawInput && typeof info.rawInput === 'object') {
                node.rawInput = info.rawInput;
            }
            if (info.summary) {
                node.summary = info.summary;
            }
        } else if (info.summary && !node.summary) {
            node.summary = info.summary;
        }
        if (info.reason && !node.reason) {
            node.reason = info.reason;
        }
        if (info.detail) {
            node.detail = info.detail;
        }
        if (!node.isQuestion && typeof info.scopeKey === 'string' && info.scopeKey) {
            node.scopeKey = info.scopeKey;
        }
        if (!node.isQuestion && typeof info.allowSessionRule === 'boolean') {
            node.allowSessionRule = info.allowSessionRule;
        }
        if (!node.isQuestion && info.sessionRuleLabel) {
            node.sessionRuleLabel = info.sessionRuleLabel;
        }
        if (typeof info.duration === 'number' && info.duration > 0) {
            node.duration = info.duration;
        }
        return node;
    }

    async _submitQuestionDecision(card, action = 'answer') {
        if (!card?.toolNodes) return;
        const target = card.toolNodes.find(
            n => n.id === card.selectedNodeId && n.status === 'pending_approval'
        ) || card.toolNodes.find(n => n.isQuestion && n.status === 'pending_approval');
        if (!target) return;

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
            this._syncQuestionFormState(card, target);
            return;
        }

        target.validationHint = '';
        const answerSummary = formatAskUserAnswerSummary(target.questions, modifiedInput);

        target.status = 'sending_approval';
        target.deliveryError = '';
        card.dirty.tools = true;
        if (!card.text) card.dirty.text = true;
        card.scheduleRender();
        this._setStatusIndicator('busy', skipAll ? '正在通知 AI 自行判断…' : '正在提交您的回答…');

        let sent = false;
        try {
            const res = await this._client?.request('permission_response', {
                requestId: target.requestId,
                decision: 'modify',
                alwaysAllow: false,
                scopeKey: '',
                toolName: target.toolName,
                modifiedInput,
                reason: skipAll ? '用户选择交由 AI 自行判断' : '用户在随问中提交了问题回答',
            });
            sent = Boolean(res?.sent);
        } catch (_) {
            sent = false;
        }

        if (!this._enabled) return;

        if (!sent) {
            target.status = 'pending_approval';
            target.deliveryError = '回答未送达后端进程，请点击重试';
            card.selectedNodeId = target.id;
            card.dirty.tools = true;
            card.flushRender(true);
            this._setStatusIndicator('error', '⚠️ 回答未送达后端，请重试');
            return;
        }

        target.status = 'running';
        target.approvalState = skipAll ? 'skipped' : 'answered';
        target.userAnswerSummary = answerSummary;

        const nextPending = card.toolNodes.find(n => n.status === 'pending_approval');
        card.selectedNodeId = nextPending ? nextPending.id : null;
        card.activeTool = true;
        card.dirty.tools = true;
        if (!card.text) card.dirty.text = true;
        card.scheduleRender();
        this._updateAiTabBadge();

        this._setStatusIndicator(
            'busy',
            nextPending
                ? (nextPending.isQuestion
                    ? '💬 请继续回答下一个问题…'
                    : `⚠️ 等待您审批工具：${nextPending.toolName}`)
                : '已收到您的回答，正在继续执行…'
        );
    }

    async _submitActiveToolDecision(card, decision, alwaysAllow = false) {
        if (!card?.toolNodes) return;
        const target = card.toolNodes.find(
            n => n.id === card.selectedNodeId && n.status === 'pending_approval'
        ) || card.toolNodes.find(n => n.status === 'pending_approval');
        if (!target) return;

        const allow = decision === 'allow';
        const effectiveAlwaysAllow = Boolean(allow && alwaysAllow && target.allowSessionRule !== false && target.scopeKey);

        // Transition explicitly to `sending_approval` until delivery is confirmed!
        target.status = 'sending_approval';
        target.deliveryError = '';
        card.dirty.tools = true;
        if (!card.text) card.dirty.text = true;
        card.scheduleRender();
        this._setStatusIndicator('busy', `正在发送 ${target.toolName} 授权指令…`);

        let sent = false;
        try {
            const res = await this._client?.request('permission_response', {
                requestId: target.requestId,
                decision,
                alwaysAllow: effectiveAlwaysAllow,
                scopeKey: effectiveAlwaysAllow ? target.scopeKey : '',
                toolName: target.toolName,
            });
            sent = Boolean(res?.sent);
        } catch (_) {
            sent = false;
        }

        if (!this._enabled) return;

        if (!sent) {
            // Delivery failed — revert to pending_approval and surface retry prompt!
            target.status = 'pending_approval';
            target.deliveryError = '授权指令未送达后端进程，请点击按钮重试';
            card.selectedNodeId = target.id;
            card.dirty.tools = true;
            card.flushRender(true);
            this._setStatusIndicator('error', `⚠️ ${target.toolName} 授权未送达，请重试`);
            return;
        }

        // Delivery confirmed! Move to `running` (only turns green `done` when tool_execution_end arrives) or `denied`
        target.status = allow ? 'running' : 'denied';
        target.approvalState = allow ? (effectiveAlwaysAllow ? 'always' : 'allowed') : 'denied';

        if (effectiveAlwaysAllow && target.scopeKey) {
            for (const other of card.toolNodes) {
                if (other.status === 'pending_approval' && other.scopeKey === target.scopeKey) {
                    other.status = 'running';
                    other.approvalState = 'always';
                }
            }
        }

        const nextPending = card.toolNodes.find(n => n.status === 'pending_approval');
        card.selectedNodeId = nextPending ? nextPending.id : null;
        card.activeTool = allow || Boolean(nextPending);
        card.dirty.tools = true;
        if (!card.text) card.dirty.text = true;
        card.scheduleRender();
        this._updateAiTabBadge();

        this._setStatusIndicator(
            'busy',
            nextPending
                ? `⚠️ 等待您审批工具：${nextPending.toolName}`
                : allow
                    ? `已授权 ${target.toolName}，正在执行…`
                    : `已拒绝 ${target.toolName}，正在继续…`
        );
    }

    _onEvent(event) {
        if (event.type === 'bridge_warning' && event.message) {
            this._setStatusIndicator('busy', `⚠️ ${event.message}`);
            return;
        }

        if (event.type === 'message_start' && event.message?.role === 'assistant') {
            if (event.modelId) {
                const suffix = (this._idleStatus || '').includes(' · ')
                    ? ` · ${(this._idleStatus || '').split(' · ').slice(1).join(' · ')}`
                    : '';
                this._modelLabel = event.modelId;
                this._idleStatus = `${event.modelId}${suffix}`;
            }
            if (this._live && this._live.text && !this._live.text.endsWith('\n')) {
                this._live.text += '\n\n';
                this._live.dirty.text = true;
            }
        }

        if (event.type === 'message_update') {
            const delta = event.assistantMessageEvent;
            if (delta?.type === 'thinking_delta' && delta.delta) {
                const card = this._ensureLiveCard();
                card.thinking += delta.delta;
                card.dirty.thinking = true;
                if (!card.thinkingHadContent && card.thinking.trim()) {
                    card.thinkingHadContent = true;
                    card.dirty.tools = true;
                    if (!card.text) card.dirty.text = true;
                }
                this._setStatusIndicator('busy', '深度思考中…');
                card.scheduleRender();
            } else if (delta?.type === 'text_delta' && delta.delta) {
                const card = this._ensureLiveCard();
                card.text += delta.delta;
                card.dirty.text = true;
                this._setStatusIndicator('busy', '正在生成回答…');
                card.scheduleRender();
            }
        }

        if (event.type === 'tool_execution_start') {
            const card = this._ensureLiveCard();
            const node = this._findOrCreateToolNode(card, {
                toolCallId: event.toolCallId || '',
                toolName: event.toolName || '工具',
                summary: event.summary || '',
                isQuestion: Boolean(event.isQuestion),
                questions: event.questions,
                rawInput: event.rawInput,
            });
            if (node && node.status !== 'pending_approval' && node.status !== 'sending_approval' && node.status !== 'denied') {
                node.status = 'running';
            }
            card.activeTool = true;
            card.dirty.tools = true;
            if (!card.text) card.dirty.text = true;
            this._setStatusIndicator(
                'busy',
                node?.isQuestion
                    ? '💬 正在准备交互式提问…'
                    : `正在执行工具：${node?.toolName || event.toolName || '工具'}`
            );
            card.scheduleRender();
        }

        if (event.type === 'permission_request') {
            const card = this._ensureLiveCard();
            const node = this._findOrCreateToolNode(card, {
                requestId: event.requestId || '',
                toolCallId: event.toolCallId || '',
                toolName: event.toolName || '工具',
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
                card.selectedNodeId = node.id;
            }
            card.activeTool = true;
            card.dirty.tools = true;
            if (!card.text) card.dirty.text = true;
            if (node?.isQuestion) {
                const brief = this._formatShortHint(node.summary, 20);
                this._setStatusIndicator('busy', brief ? `💬 等待回答：${brief}` : '💬 等待您回答问题…');
            } else {
                this._setStatusIndicator('busy', `⚠️ 等待您审批工具：${node?.toolName || event.toolName || '工具'}`);
            }
            this._updateAiTabBadge();
            card.scheduleRender();
            this._scrollBottom(true);
        }

        if (event.type === 'permission_resolved') {
            if (this._live?.toolNodes) {
                const node = this._live.toolNodes.find(
                    n => (event.requestId && n.requestId === event.requestId) ||
                         (event.toolCallId && n.toolCallId === event.toolCallId)
                );
                if (node && (node.status === 'pending_approval' || node.status === 'sending_approval')) {
                    const allow = event.decision !== 'deny';
                    node.status = allow ? 'running' : 'denied';
                    if (!node.approvalState || node.approvalState === 'pending') {
                        node.approvalState = allow ? (node.isQuestion ? 'answered' : 'allowed') : 'denied';
                    }
                    if (this._live.selectedNodeId === node.id) {
                        const nextPending = this._live.toolNodes.find(n => n.status === 'pending_approval');
                        this._live.selectedNodeId = nextPending ? nextPending.id : null;
                    }
                }
                this._live.dirty.tools = true;
                this._updateAiTabBadge();
                this._live.scheduleRender();
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
                for (const node of this._live.toolNodes) {
                    if (node.status === 'running') {
                        node.status = 'done';
                    }
                }
                this._live.activeTool = false;
                this._live.dirty.tools = true;
                this._live.scheduleRender();
            }
        }

        if (event.type === 'message_end' && event.message?.role === 'assistant') {
            const text = messageText(event.message);
            const thinking = messageThinking(event.message);
            if (text || thinking || event.message.errorMessage) {
                const card = this._ensureLiveCard();
                if (text) {
                    if (!card.text) {
                        card.text = text;
                        card.dirty.text = true;
                    } else if (!card.text.includes(text)) {
                        card.text = `${card.text.trimEnd()}\n\n${text}`;
                        card.dirty.text = true;
                    }
                }
                if (thinking && !card.thinking) {
                    card.thinking = thinking;
                    card.thinkingHadContent = true;
                    card.dirty.thinking = true;
                    card.dirty.tools = true;
                }
                if (event.message.errorMessage && !card.text) {
                    card.text = `⚠️ ${event.message.errorMessage}`;
                    card.dirty.text = true;
                    card.box.add_style_class_name('qc-message-error');
                }
                card.activeTool = false;
                card.flushRender();
            }
            if (event.message.errorMessage) {
                this._setStatusIndicator('error', `错误：${event.message.errorMessage}`);
            }
            this._scrollBottom(false);
        }

        if (event.type === 'agent_settled' || (event.type === 'agent_end' && event.willRetry === undefined)) {
            const finishedText = this._live?.text || '';
            if (this._live) {
                if (this._live.toolNodes) {
                    for (const node of this._live.toolNodes) {
                        if (node.status === 'pending_approval' || node.status === 'sending_approval') {
                            node.status = 'denied';
                            node.approvalState = 'denied';
                            if (this._live.selectedNodeId === node.id) {
                                this._live.selectedNodeId = null;
                            }
                        } else if (node.status === 'running') {
                            node.status = 'done';
                        }
                    }
                }
                this._live.activeTool = false;
                this._live.dirty.tools = true;
                this._live.dirty.text = true;
                this._live.flushRender();
            }

            if (!this._isChatVisible() && !event.aborted && finishedText) {
                this._hasUnreadBackgroundReply = true;
                if (
                    !this._dateIntegration?.dateMenu?.menu?.isOpen &&
                    this._getSettingBool('notify-on-complete', false)
                ) {
                    const preview = finishedText.replace(/\s+/g, ' ').trim().slice(0, 72);
                    try {
                        Main.notify('随问 · 回答已完成', preview || '点击顶部时间栏查看完整回答');
                    } catch (_) {}
                }
            }

            this._setBusy(false);
            if (!this._lastStatusText.startsWith('错误：')) {
                if (event.aborted) {
                    this._setStatusIndicator('ready', '已停止生成');
                } else {
                    this._setStatusIndicator('ready', this._idleStatus || '随问');
                }
            }
            this._live = null;
            this._updateAiTabBadge();
            if (this._needsReconnect) {
                this._needsReconnect = false;
                this._reconnectNow();
            }
        }
    }

    async _abort() {
        if (!this._client || !this._busy) return;
        const generation = this._generation;
        this._setStatusIndicator('busy', '正在停止…');
        try {
            await this._client.request('abort');
        } catch (error) {
            if (this._enabled && generation === this._generation) {
                this._stopClient();
                this._setStatusIndicator('error', `已断开：${error.message}`);
            }
            return;
        }
        if (this._enabled && generation === this._generation) {
            this._setBusy(false);
            this._setStatusIndicator('ready', '已停止生成');
        }
    }

    _newSession() {
        if (this._busy) return;
        if (this._modelPickerOpen) {
            this._toggleModelPicker(false);
        }
        this._stopClient();
        this._settings.set_string('session-id', GLib.uuid_string_random());
        this._clearMessages();
        this._entry.set_text('');
        this._userScrolledUp = false;
        this._updateJumpBottomVisibility();
        this._ensureClient();
        this._entry.grab_key_focus();
    }

    _stopClient() {
        ++this._generation;
        this._client?.close();
        this._client = null;
        this._ready = false;
        if (this._sendButton) this._setBusy(false);
    }

    disable() {
        this._enabled = false;
        this._unregisterGlobalKeybindings();
        this._stopClient();

        for (const timerId of this._timers) {
            try { GLib.source_remove(timerId); } catch (_) {}
        }
        this._timers.clear();

        if (this._scrollIdle) {
            GLib.source_remove(this._scrollIdle);
            this._scrollIdle = 0;
        }

        const vadj = this._scroll?.vadjustment;
        if (vadj) {
            if (this._vadjValueSig) vadj.disconnect(this._vadjValueSig);
            if (this._vadjUpperSig) vadj.disconnect(this._vadjUpperSig);
            this._vadjValueSig = this._vadjUpperSig = 0;
        }

        if (this._menuSignal) {
            try { this._dateIntegration?.dateMenu?.menu?.disconnect(this._menuSignal); } catch (_) {}
        }
        if (this._sessionSignal) {
            try { Main.sessionMode.disconnect(this._sessionSignal); } catch (_) {}
        }
        this._menuSignal = this._sessionSignal = 0;

        for (const sig of this._settingSignals || []) {
            try { this._settings?.disconnect(sig); } catch (_) {}
        }
        this._settingSignals = [];

        if (this._interfaceSettings) {
            if (this._themeSig1) this._interfaceSettings.disconnect(this._themeSig1);
            if (this._themeSig2) this._interfaceSettings.disconnect(this._themeSig2);
            this._themeSig1 = this._themeSig2 = 0;
            this._interfaceSettings = null;
        }

        for (const sig of this._traySignals || []) {
            try { Main.messageTray?.disconnect(sig); } catch (_) {}
        }
        this._traySignals = [];

        for (const [src, sig] of this._sourceSignals.entries()) {
            try { src.disconnect(sig); } catch (_) {}
        }
        this._sourceSignals.clear();

        this._dateIntegration?.unmount(this._wrapper);
        this._dateIntegration = null;

        this._wrapper = this._chat = null;
        this._sendButton = this._stopButton = this._newButton = this._clipAskBtn = this._reconnectButton = null;
        this._statusBtn = this._modelChevron = this._modelPickerBox = this._loadMoreBtn = null;
        this._entry = this._scroll = this._scrollStack = this._messages = this._jumpBottomBtn = null;
        this._status = this._statusDot = this._notifBadge = this._aiBadge = null;
        this._cardList = null;
        this._allHistoryMessages = [];
        this._settings = null;
    }
}
