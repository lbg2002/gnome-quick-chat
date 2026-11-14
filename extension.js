import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {PiClient} from './piClient.js';
import {
    detailedMessages,
    escapePango,
    messageText,
    messageThinking,
    parseMarkdownBlocks,
} from './protocol.js';

const V = Clutter.Orientation.VERTICAL;
const H = Clutter.Orientation.HORIZONTAL;

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

function wrapLabel(text, style = '', useMarkup = false) {
    const label = new St.Label({
        text: useMarkup ? '' : text,
        style_class: style,
        x_expand: true,
        y_align: Clutter.ActorAlign.START,
    });
    const ct = label.clutter_text;
    ct.line_wrap = true;
    ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    ct.ellipsize = Pango.EllipsizeMode.NONE;
    ct.selectable = false;
    if (useMarkup) {
        try {
            ct.use_markup = true;
            ct.set_markup(text);
        } catch (_) {
            ct.use_markup = false;
            label.text = text;
        }
    }
    return label;
}

function setLabelMarkupSafe(label, pangoMarkup, rawFallback) {
    const ct = label.clutter_text;
    try {
        ct.use_markup = true;
        ct.set_markup(pangoMarkup);
    } catch (_) {
        ct.use_markup = false;
        label.text = rawFallback ?? pangoMarkup;
    }
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
        this._promptHistory = [];
        this._historyIndex = -1;
        this._draftInput = '';
        this._userScrolledUp = false;
        this._needsReconnect = false;

        this._settings = this.getSettings();
        this._date = Main.panel.statusArea.dateMenu;
        this._native = this._date?._messageList;
        this._parent = this._native?.get_parent();
        if (!this._parent || this._parent.name !== 'calendarArea') {
            console.warn('[Quick Chat] Unsupported date menu; no UI changes made.');
            return;
        }

        this._index = this._parent.get_children().indexOf(this._native);
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

        // Keep native notification actor intact inside wrapper and restore on disable.
        this._parent.remove_child(this._native);
        this._native.add_style_class_name('qc-native-clean');
        this._wrapper.add_child(this._native);
        this._parent.insert_child_at_index(this._wrapper, this._index);

        this._nativeVisibleGuard = this._native.connect('notify::visible', () => {
            if (this._enabled && this._tab === 'ai' && this._native.visible) {
                this._native.visible = false;
            }
        });

        this._tab = this._getSettingString('default-tab', 'ai') === 'notifications' ? 'notifications' : 'ai';
        this._setTab(this._tab, false, false);

        this._menuSignal = this._date.menu.connect('open-state-changed', (_, open) => {
            if (open) {
                this._syncThemeStyle();
                this._updateNotificationBadge();
                if (this._tab === 'ai') {
                    this._ensureClient();
                    this._scheduleTimeout(40, () => {
                        if (this._enabled && this._tab === 'ai') this._entry?.grab_key_focus();
                    });
                }
            }
        });

        this._sessionSignal = Main.sessionMode.connect('updated', () => {
            // Never expose the transcript on the lock screen or greeter.
            if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter) {
                this._wrapper.hide();
                this._stopClient();
            } else {
                this._wrapper.show();
                this._setTab(this._tab, false, false);
            }
        });

        this._connectSettingsSignals();
        this._connectNotificationSignals();
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

    _buildTopTabs() {
        this._tabs = new St.BoxLayout({orientation: H, style_class: 'qc-tabs', y_align: Clutter.ActorAlign.CENTER});
        const tabGroup = new St.BoxLayout({orientation: H, style_class: 'qc-tab-group'});

        this._aiTab = button('✦ 随问', () => this._setTab('ai'), 'qc-tab-button', '切换到随问助手');
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
            this._date.menu.close();
            this.openPreferences();
        }, 'qc-icon-button', '随问设置');
        this._tabs.add_child(this._settingsButton);

        this._wrapper.add_child(this._tabs);
    }

    _buildChat() {
        const header = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-header',
            y_align: Clutter.ActorAlign.CENTER,
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
        header.add_child(statusBox);

        this._newButton = button('＋ 新对话', () => this._newSession(), 'qc-button-subtle', '开启新对话');
        header.add_child(this._newButton);
        this._chat.add_child(header);

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
        const mode = this._getSettingString('agent-mode', 'readonly');
        const modeDesc = mode === 'full'
            ? '当前：全自动 Agent 模式（自动执行联网、命令与文件工具，免手动审批）'
            : mode === 'readonly'
                ? '当前：智能审批 Agent 模式（支持联网/命令/文件工具，敏感操作弹窗审批）'
                : '当前：纯问答模式（无工具调用，轻量快速响应）';
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

    _unfreezeDateMenuLayout() {
        const bin = this._parent?.get_parent?.();
        const lm = bin?.layout_manager;
        if (lm) {
            const wasFrozen = Boolean(lm._frozen);
            if (wasFrozen) lm._frozen = false;
            try { lm.layout_changed(); } catch (_) {}
            try { bin.queue_relayout(); } catch (_) {}
        }
    }

    _applyDimensions() {
        if (!this._wrapper || !this._chat || !this._scroll) return;
        const width = this._getSettingInt('panel-width', 460);
        const height = this._getSettingInt('panel-height', 380);
        this._wrapper.set_width(width);
        this._chat.set_width(Math.max(300, width - 16));
        this._scroll.set_height(height);
        this._unfreezeDateMenuLayout();
    }

    _setTab(tab, connect = true, animate = true) {
        if (!this._wrapper) return;
        const changed = this._tab !== tab;
        this._tab = tab;

        const showAi = tab === 'ai';
        const showNotif = tab === 'notifications' && Main.sessionMode.hasNotifications && !Main.sessionMode.isGreeter;

        if (showAi) {
            try { this._native?._messageView?.collapse?.(); } catch (_) {}
        }

        this._chat.visible = showAi;
        this._native.visible = showNotif;
        this._aiTab.set_checked?.(showAi);
        this._notificationTab.set_checked?.( tab === 'notifications');

        if (showAi) {
            this._aiTab.add_style_pseudo_class('checked');
            this._notificationTab.remove_style_pseudo_class('checked');
            if (connect) {
                this._ensureClient();
                this._entry?.grab_key_focus();
            }
        } else {
            this._notificationTab.add_style_pseudo_class('checked');
            this._aiTab.remove_style_pseudo_class('checked');
        }

        this._unfreezeDateMenuLayout();

        const targetActor = showAi ? this._chat : (showNotif ? this._native : null);
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
        this._status.text = text;
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

    _config() {
        return {
            backend: this._getSettingString('backend', 'auto').trim() || 'auto',
            executable: this._getSettingString('pi-path', 'pi').trim() || 'pi',
            provider: this._getSettingString('provider', '').trim(),
            model: this._getSettingString('model', '').trim(),
            openaiBaseUrl: this._getSettingString('openai-base-url', '').trim(),
            openaiApiKey: this._getSettingString('openai-api-key', '').trim(),
            openaiModel: this._getSettingString('openai-model', '').trim(),
            systemPrompt: this._getSettingString('system-prompt', '').trim(),
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
        const config = this._config();
        this._ready = false;
        this._setStatusIndicator('busy', '正在连接智能后端…');

        try {
            const root = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-quick-chat']);
            const sessions = GLib.build_filenamev([root, 'sessions']);
            const defaultHome = GLib.get_home_dir() || GLib.build_filenamev([root, 'workspace']);
            const work = config.workspace || defaultHome;
            GLib.mkdir_with_parents(root, 0o700);
            GLib.mkdir_with_parents(sessions, 0o700);
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

            this._clearMessages();
            for (const msg of detailedMessages(data.messages)) {
                const card = this._addMessage(msg.role, msg.text, {
                    animate: false,
                    thinking: msg.thinking || '',
                });
                if (msg.role === 'user' && msg.text) {
                    this._recordPromptHistory(msg.text);
                }
                card?.flushRender?.();
            }

            this._ready = true;
            const backendTag = state.backend === 'openai'
                ? 'OpenAI API'
                : state.backend === 'zcode'
                    ? 'ZCode'
                    : state.backend === 'codex'
                        ? 'Codex'
                        : 'Pi';
            this._modelLabel = state.model?.id || config.model || backendTag;
            const modeSuffix = state.backend === 'openai'
                ? ''
                : config.mode === 'full'
                    ? ' · 全自动 Agent'
                    : config.mode === 'readonly'
                        ? ' · 智能审批'
                        : ' · 纯问答';
            this._idleStatus = `${this._modelLabel}${modeSuffix}`;
            this._setStatusIndicator('ready', this._idleStatus);
            this._setBusy(false);
            this._scrollBottom(true);
        } catch (error) {
            if (!this._enabled || generation !== this._generation) return;
            this._stopClient();
            this._setStatusIndicator('error', `连接失败：${error.message}`);
        }
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
        const {bodyBox, role} = card;
        const rawText = card.text || '';
        bodyBox.destroy_all_children();

        if (!rawText) {
            const hasPendingApproval = card.toolNodes?.some(n => n.status === 'pending_approval');
            const waitText = hasPendingApproval
                ? '请在上方展开的审批栏中选择是否允许执行…'
                : card.activeTool
                    ? `正在执行 ${card.toolNodes?.at(-1)?.toolName || '工具'}…`
                    : card.thinking
                        ? '正在整理回答…'
                        : '…';
            const placeholder = wrapLabel(waitText, 'qc-message-text');
            bodyBox.add_child(placeholder);
            return;
        }

        if (role === 'user' || !this._markdownEnabled()) {
            bodyBox.add_child(wrapLabel(rawText, 'qc-message-text', false));
            return;
        }

        const blocks = parseMarkdownBlocks(rawText);
        if (!blocks.length) {
            bodyBox.add_child(wrapLabel(rawText, 'qc-message-text', false));
            return;
        }

        for (const block of blocks) {
            if (block.type === 'code') {
                const codeCard = new St.BoxLayout({
                    orientation: V,
                    style_class: 'qc-code-block',
                    x_expand: true,
                });
                const codeHeader = new St.BoxLayout({
                    orientation: H,
                    style_class: 'qc-code-header',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const langLabel = new St.Label({
                    text: block.lang || 'code',
                    style_class: 'qc-code-lang',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                codeHeader.add_child(langLabel);
                const codeCopyBtn = button('复制代码', () => {
                    this._copyWithFeedback(codeCopyBtn, () => block.code, '复制代码');
                }, 'qc-copy-btn', '复制代码片段');
                codeHeader.add_child(codeCopyBtn);
                codeCard.add_child(codeHeader);

                const codeBody = wrapLabel(block.code || ' ', 'qc-code-text', false);
                codeCard.add_child(codeBody);
                bodyBox.add_child(codeCard);
            } else {
                const lbl = wrapLabel('', 'qc-message-text', false);
                setLabelMarkupSafe(lbl, block.pango, block.raw);
                bodyBox.add_child(lbl);
            }
        }
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
        if (node.status === 'pending_approval') {
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
                card.traceHintLabel.text = brief
                    ? `${node.toolName}: ${brief}`
                    : `${node.toolName}（点击小圆切换详情）`;
                return;
            }
        }

        const pendingNode = tools.find(n => n.status === 'pending_approval');
        if (pendingNode) {
            card.traceHintLabel.text = `⚠️ 待审批: ${pendingNode.toolName}`;
            return;
        }
        const runningNode = tools.find(n => n.status === 'running');
        if (runningNode) {
            card.traceHintLabel.text = `正在执行 ${runningNode.toolName}…`;
            return;
        }

        const segs = [];
        if (hasThinking) segs.push('思考');
        if (tools.length > 0) segs.push(`${tools.length} 项工具`);
        card.traceHintLabel.text = segs.length ? `${segs.join(' · ')}（点击小圆查看）` : '';
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
            card.detailDrawer.visible = false;
            return;
        }

        if (selId === 'thinking') {
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
            card.detailDrawer.visible = false;
            return;
        }

        card.detailDrawer.visible = true;
        if (node.status === 'pending_approval') {
            card.detailDrawer.add_style_class_name('qc-drawer-pending');
        } else {
            card.detailDrawer.remove_style_class_name('qc-drawer-pending');
        }

        const durSuffix = node.duration > 0 ? ` (${(node.duration / 1000).toFixed(1)}s)` : '';
        let statusTitle = `🔧 ${node.toolName}`;
        if (node.status === 'pending_approval') {
            statusTitle = `🛡️ 请求授权调用：${node.toolName}`;
        } else if (node.status === 'running') {
            statusTitle = `⏳ 正在执行：${node.toolName}`;
        } else if (node.status === 'denied') {
            statusTitle = `✕ 已拒绝调用：${node.toolName}`;
        } else if (node.status === 'error') {
            statusTitle = `⚠️ 执行异常：${node.toolName}${durSuffix}`;
        } else if (node.approvalState === 'always') {
            statusTitle = `✓ 已始终允许：${node.toolName}${durSuffix}`;
        } else if (node.approvalState === 'allowed') {
            statusTitle = `✓ 已批准执行：${node.toolName}${durSuffix}`;
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

        const extraInfo = node.status === 'pending_approval'
            ? (node.reason && node.reason !== node.summary ? node.reason : '')
            : (node.detail && node.detail !== node.summary ? node.detail : '');
        if (extraInfo) {
            card.drawerBody.text = extraInfo;
            card.drawerBody.visible = true;
        } else if (!card.drawerSummary.visible) {
            card.drawerBody.text = `工具名称：${node.toolName}`;
            card.drawerBody.visible = true;
        } else {
            card.drawerBody.visible = false;
        }

        card.drawerActions.visible = node.status === 'pending_approval';
    }

    _addMessage(role, text, options = {}) {
        const {animate = true, thinking = ''} = options;
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
            toolNodes: [],
            selectedNodeId: null,
            hoveredNodeId: null,
            activeTool: false,
            renderTimer: 0,
        };

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
            const drawerTitle = wrapLabel('', 'qc-drawer-title', false);
            drawerTitle.x_expand = true;
            drawerHeader.add_child(drawerTitle);

            const drawerCloseBtn = button('收起', () => {
                card.selectedNodeId = null;
                this._updateCardActivity(card);
            }, 'qc-drawer-close', '收起详情');
            drawerHeader.add_child(drawerCloseBtn);
            detailDrawer.add_child(drawerHeader);

            const drawerSummary = wrapLabel('', 'qc-approval-summary', false);
            drawerSummary.visible = false;
            detailDrawer.add_child(drawerSummary);

            const drawerBody = wrapLabel('', 'qc-drawer-body', false);
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
                '✓ 始终允许',
                () => this._submitActiveToolDecision(card, 'allow', true),
                'qc-approval-btn qc-approval-always',
                '当前会话始终允许该工具'
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
            card.drawerBody = drawerBody;
            card.drawerActions = drawerActions;
        }

        const bodyBox = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-message-body',
            x_expand: true,
        });
        box.add_child(bodyBox);
        card.bodyBox = bodyBox;

        card.flushRender = () => {
            if (card.renderTimer) {
                this._clearTimer(card.renderTimer);
                card.renderTimer = 0;
            }
            this._updateCardActivity(card);
            this._renderCardBody(card);
        };

        card.scheduleRender = () => {
            this._updateCardActivity(card);
            if (card.renderTimer) return;
            card.renderTimer = this._scheduleTimeout(45, () => {
                card.renderTimer = 0;
                this._renderCardBody(card);
                this._scrollBottom(false);
            });
        };

        card.flushRender();
        this._messages.add_child(box);
        if (!this._cardList) this._cardList = [];
        this._cardList.push(card);

        if (animate && this._animEnabled()) {
            box.opacity = 0;
            box.translation_y = 9;
            this._easeActor(box, {
                opacity: 255,
                translation_y: 0,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }

        this._scrollBottom(role === 'user');
        return card;
    }

    _rerenderAllMessages() {
        for (const card of this._cardList || []) {
            card.flushRender?.();
        }
    }

    _scrollBottom(force = false) {
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
    }

    async _send() {
        const text = this._entry.get_text().trim();
        if (!text || this._busy) return;
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
            // Match an active node of the same toolName that hasn't bound a conflicting toolCallId yet
            for (let i = card.toolNodes.length - 1; i >= 0; i--) {
                const cand = card.toolNodes[i];
                if (
                    cand.toolName === toolName &&
                    (cand.status === 'running' || cand.status === 'pending_approval') &&
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
                dotBtn: null,
            };

            if (card.toolDotsBox) {
                const dotBtn = new St.Button({
                    style_class: 'qc-dot-circle qc-dot-tool-running',
                    can_focus: true,
                    reactive: true,
                    track_hover: true,
                    accessible_name: `工具 ${node.toolName}`,
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

        if (info.summary && !node.summary) {
            node.summary = info.summary;
        }
        if (info.reason && !node.reason) {
            node.reason = info.reason;
        }
        if (info.detail) {
            node.detail = info.detail;
        }
        if (typeof info.duration === 'number' && info.duration > 0) {
            node.duration = info.duration;
        }
        return node;
    }

    async _submitActiveToolDecision(card, decision, alwaysAllow = false) {
        if (!card?.toolNodes) return;
        const target = card.toolNodes.find(
            n => n.id === card.selectedNodeId && n.status === 'pending_approval'
        ) || card.toolNodes.find(n => n.status === 'pending_approval');
        if (!target) return;

        const allow = decision === 'allow';
        target.status = allow ? 'done' : 'denied';
        target.approvalState = allow ? (alwaysAllow ? 'always' : 'allowed') : 'denied';

        if (allow && alwaysAllow && target.toolName) {
            for (const other of card.toolNodes) {
                if (other.status === 'pending_approval' && other.toolName === target.toolName) {
                    other.status = 'done';
                    other.approvalState = 'always';
                }
            }
        }

        // Auto-advance to next pending approval if any, otherwise collapse drawer into the green circle
        const nextPending = card.toolNodes.find(n => n.status === 'pending_approval');
        card.selectedNodeId = nextPending ? nextPending.id : null;
        card.activeTool = allow || Boolean(nextPending);
        card.scheduleRender();

        this._setStatusIndicator(
            'busy',
            nextPending
                ? `⚠️ 等待您审批工具：${nextPending.toolName}`
                : allow
                    ? `已授权 ${target.toolName}，正在执行…`
                    : `已拒绝 ${target.toolName}，正在继续…`
        );

        try {
            await this._client?.request('permission_response', {
                requestId: target.requestId,
                decision,
                alwaysAllow,
                toolName: target.toolName,
            });
        } catch (_) {}
    }

    _onEvent(event) {
        if (event.type === 'message_start' && event.message?.role === 'assistant') {
            if (event.modelId) {
                const prefix = (this._idleStatus || '').split(' · ')[0] || '随问';
                this._idleStatus = `${prefix} · ${event.modelId}`;
                this._modelLabel = event.modelId;
            }
            if (this._live && this._live.text && !this._live.text.endsWith('\n')) {
                this._live.text += '\n\n';
            }
        }
        if (event.type === 'message_update') {
            const delta = event.assistantMessageEvent;
            if (delta?.type === 'thinking_delta' && delta.delta) {
                const card = this._ensureLiveCard();
                card.thinking += delta.delta;
                this._setStatusIndicator('busy', '深度思考中…');
                card.scheduleRender();
            } else if (delta?.type === 'text_delta' && delta.delta) {
                const card = this._ensureLiveCard();
                card.text += delta.delta;
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
            });
            if (node && node.status !== 'pending_approval' && node.status !== 'denied') {
                node.status = node.approvalState ? 'done' : 'running';
            }
            card.activeTool = true;
            this._setStatusIndicator('busy', `正在执行工具：${node?.toolName || event.toolName || '工具'}`);
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
            });
            if (node) {
                node.status = 'pending_approval';
                node.approvalState = 'pending';
                card.selectedNodeId = node.id;
            }
            card.activeTool = true;
            this._setStatusIndicator('busy', `⚠️ 等待您审批工具：${node?.toolName || event.toolName || '工具'}`);
            card.scheduleRender();
            this._scrollBottom(true);
        }
        if (event.type === 'permission_resolved') {
            if (this._live?.toolNodes) {
                const node = this._live.toolNodes.find(
                    n => (event.requestId && n.requestId === event.requestId) ||
                         (event.toolCallId && n.toolCallId === event.toolCallId)
                );
                if (node && node.status === 'pending_approval') {
                    const allow = event.decision !== 'deny';
                    node.status = allow ? 'done' : 'denied';
                    node.approvalState = allow ? 'allowed' : 'denied';
                    if (this._live.selectedNodeId === node.id) {
                        const nextPending = this._live.toolNodes.find(n => n.status === 'pending_approval');
                        this._live.selectedNodeId = nextPending ? nextPending.id : null;
                    }
                }
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
                        if (cand.status === 'running' || cand.status === 'done') {
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
                    n => n.status === 'running' || n.status === 'pending_approval'
                );
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
                    } else if (!card.text.includes(text)) {
                        card.text = `${card.text.trimEnd()}\n\n${text}`;
                    }
                }
                if (thinking && !card.thinking) card.thinking = thinking;
                if (event.message.errorMessage && !card.text) {
                    card.text = `⚠️ ${event.message.errorMessage}`;
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
            if (this._live) {
                if (this._live.toolNodes) {
                    for (const node of this._live.toolNodes) {
                        if (node.status === 'pending_approval') {
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
                this._live.flushRender();
            }
            this._setBusy(false);
            if (!this._status.text.startsWith('错误：')) {
                if (event.aborted) {
                    this._setStatusIndicator('ready', '已停止生成');
                } else {
                    this._setStatusIndicator('ready', this._idleStatus || '随问');
                }
            }
            this._live = null;
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

        if (this._menuSignal) this._date?.menu?.disconnect(this._menuSignal);
        if (this._sessionSignal) Main.sessionMode.disconnect(this._sessionSignal);
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

        if (this._native && this._nativeVisibleGuard) {
            try { this._native.disconnect(this._nativeVisibleGuard); } catch (_) {}
            this._nativeVisibleGuard = 0;
        }

        if (this._wrapper) {
            if (this._native && this._native.get_parent() === this._wrapper) {
                this._wrapper.remove_child(this._native);
                this._native.remove_style_class_name('qc-native-clean');
                this._parent.insert_child_at_index(this._native, this._index);
                this._native.opacity = 255;
                this._native.translation_y = 0;
                this._native.visible = Main.sessionMode.hasNotifications && !Main.sessionMode.isGreeter;
            }
            this._unfreezeDateMenuLayout();
            this._wrapper.destroy();
        }

        this._wrapper = this._native = this._parent = this._chat = this._date = null;
        this._sendButton = this._stopButton = this._newButton = this._reconnectButton = null;
        this._entry = this._scroll = this._scrollStack = this._messages = this._jumpBottomBtn = null;
        this._status = this._statusDot = this._notifBadge = null;
        this._cardList = null;
        this._settings = null;
    }
}
