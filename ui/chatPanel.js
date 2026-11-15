import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getBackendCapabilities} from '../protocol.js';
import {
    DEFAULT_HISTORY_PAGE_SIZE,
    DEFAULT_INITIAL_HISTORY_COUNT,
    DEFAULT_MAX_MOUNTED_ACTORS,
    HistoryWindowController,
} from '../core/renderScheduler.js';
import {H, V, createStButton, createWrapLabel} from './tracePanel.js';

export const DEFAULT_QUICK_PROMPTS = [
    {label: '💡 解释命令或报错', prompt: '请帮我解释下面这段 Linux 命令或终端报错的含义，并给出解决建议：\n'},
    {label: '⚡ Ubuntu 效率技巧', prompt: '请告诉我几个在 Ubuntu 26 / GNOME 50 下非常实用的高频快捷键或终端技巧。'},
    {label: '📝 润色或翻译文本', prompt: '请帮我润色或翻译下面这段内容，使其表达更加自然准确：\n'},
];

/**
 * Encapsulates Quick Chat's GNOME Shell St widget hierarchy, tab switching, status header,
 * windowed `HistoryWindowController` DOM recycling, and single-idle scroll coalescing (Stage E).
 */
export class ChatPanelView {
    constructor({
        cardFactory,
        modelPicker,
        getSettingString,
        getSettingInt,
        isAnimEnabled,
        isChatVisible,
        getEffectiveBackend,
        getEffectiveMode,
        getLiveCard,
        isBusy,
        scheduleTimeout,
        scheduleIdle,
        clearTimer,
        easeActor,
        onSelectTab,
        onReconnectNow,
        onOpenPreferences,
        onClipboardAsk,
        onNewSession,
        onSend,
        onAbort,
        onEntryKeyPress,
        onDismissMigrationNotice,
    }) {
        this._cardFactory = cardFactory;
        this._modelPicker = modelPicker;
        this._getSettingString = getSettingString;
        this._getSettingInt = getSettingInt;
        this._isAnimEnabled = isAnimEnabled;
        this._isChatVisible = isChatVisible;
        this._getEffectiveBackend = getEffectiveBackend;
        this._getEffectiveMode = getEffectiveMode;
        this._getLiveCard = getLiveCard;
        this._isBusy = isBusy;
        this._scheduleTimeout = scheduleTimeout;
        this._scheduleIdle = scheduleIdle;
        this._clearTimer = clearTimer;
        this._easeActor = easeActor;

        this._onSelectTab = onSelectTab;
        this._onReconnectNow = onReconnectNow;
        this._onOpenPreferences = onOpenPreferences;
        this._onClipboardAsk = onClipboardAsk;
        this._onNewSession = onNewSession;
        this._onSend = onSend;
        this._onAbort = onAbort;
        this._onEntryKeyPress = onEntryKeyPress;
        this._onDismissMigrationNotice = onDismissMigrationNotice;

        this.historyWindow = new HistoryWindowController({
            initialPageSize: DEFAULT_INITIAL_HISTORY_COUNT,
            pageSize: DEFAULT_HISTORY_PAGE_SIZE,
            maxMountedActors: DEFAULT_MAX_MOUNTED_ACTORS,
        });

        this.wrapper = null;
        this.chatBox = null;
        this.entry = null;
        this.scroll = null;
        this.messagesBox = null;
        this._aiTab = null;
        this._notificationTab = null;
        this._aiBadge = null;
        this._notifBadge = null;
        this._reconnectButton = null;
        this._status = null;
        this._statusDot = null;
        this._sendButton = null;
        this._stopButton = null;
        this._newButton = null;
        this._jumpBottomBtn = null;
        this._loadMoreBtn = null;
        this._loadNewerBtn = null;
        this._empty = null;

        this._vadjValueSig = 0;
        this._vadjUpperSig = 0;
        this._scrollIdleId = 0;
        this._scrollPendingAnimate = false;
        this._programmaticScroll = false;
        this.userScrolledUp = false;
        this.lastStatusState = '';
        this.lastStatusText = '';
        this.lastAiBadgeState = '';
        this.hasPendingBackgroundRender = false;
        this.hasUnreadBackgroundReply = false;
    }

    get mountedCards() {
        return this.historyWindow?.mountedCards || [];
    }

    build({showNotificationTab = true} = {}) {
        this.wrapper = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-wrapper',
            x_expand: true,
            y_expand: true,
        });

        this._buildTopTabs({showNotificationTab});
        this.chatBox = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-chat',
            x_expand: true,
            y_expand: true,
        });
        this.wrapper.add_child(this.chatBox);
        this._buildChatArea();
        return this.wrapper;
    }

    _buildTopTabs({showNotificationTab = true} = {}) {
        const tabs = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-tabs',
            y_align: Clutter.ActorAlign.CENTER,
        });
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
        this._aiTab.connect('clicked', () => this._onSelectTab('ai'));
        tabGroup.add_child(this._aiTab);

        if (showNotificationTab) {
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
            this._notificationTab.connect('clicked', () => this._onSelectTab('notifications'));
            tabGroup.add_child(this._notificationTab);
        }

        tabs.add_child(tabGroup);
        tabs.add_child(new St.Widget({x_expand: true}));

        this._reconnectButton = createStButton('↻', () => this._onReconnectNow(), 'qc-icon-button', '重新连接智能后端');
        this._reconnectButton.visible = false;
        tabs.add_child(this._reconnectButton);

        const settingsBtn = createStButton('⚙', () => this._onOpenPreferences(), 'qc-icon-button', '随问设置');
        tabs.add_child(settingsBtn);

        this.wrapper.add_child(tabs);
    }

    _buildChatArea() {
        const header = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-header',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const statusBtn = new St.Button({
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
        this._status = createWrapLabel('未连接', 'qc-status');
        this._status.y_align = Clutter.ActorAlign.CENTER;
        statusBox.add_child(this._status);

        const chevron = new St.Label({
            text: '▾',
            style_class: 'qc-status-chevron',
            y_align: Clutter.ActorAlign.CENTER,
        });
        statusBox.add_child(chevron);
        statusBtn.set_child(statusBox);
        statusBtn.connect('clicked', () => this._modelPicker.toggle());
        header.add_child(statusBtn);

        header.add_child(createStButton(
            '📋',
            () => this._onClipboardAsk(false),
            'qc-button-subtle',
            '读取剪贴板内容并提问'
        ));

        this._newButton = createStButton('＋ 新对话', () => this._onNewSession(), 'qc-button-subtle', '开启新对话');
        header.add_child(this._newButton);
        this.chatBox.add_child(header);

        const pickerBox = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-model-picker',
            x_expand: true,
            visible: false,
        });
        this.chatBox.add_child(pickerBox);
        this._modelPicker.attachActors(pickerBox, chevron);

        const scrollStack = new St.Widget({
            style_class: 'qc-scroll-stack',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        this.scroll = new St.ScrollView({
            style_class: 'qc-scroll',
            x_expand: true,
            y_expand: true,
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this.messagesBox = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-messages',
            x_expand: true,
        });
        this.scroll.set_child(this.messagesBox);
        scrollStack.add_child(this.scroll);

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
            this.userScrolledUp = false;
            if (this.historyWindow?.hasNewer) {
                this.restoreLatestHistoryWindow();
                return;
            }
            this.updateJumpBottomVisibility();
            this.scrollBottom(true, true);
        });
        scrollStack.add_child(this._jumpBottomBtn);
        this.chatBox.add_child(scrollStack);

        const vadj = this.scroll.vadjustment;
        if (vadj) {
            this._vadjValueSig = vadj.connect('notify::value', () => this._onScrollChanged());
            this._vadjUpperSig = vadj.connect('notify::upper', () => this._onScrollChanged());
        }

        this.buildEmptyState();

        const inputRow = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-input-row',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.entry = new St.Entry({
            hint_text: '输入问题（Enter 发送，↑↓ 历史，Esc 停止）…',
            can_focus: true,
            x_expand: true,
            style_class: 'qc-entry',
            track_hover: true,
        });
        this.entry.clutter_text.connect('activate', () => this._onSend());
        this.entry.clutter_text.connect('key-press-event', (_, event) => this._onEntryKeyPress(event));
        inputRow.add_child(this.entry);

        this._sendButton = createStButton('发送', () => this._onSend(), 'qc-send-btn', '发送问题');
        this._stopButton = createStButton('■ 停止', () => this._onAbort(), 'qc-stop-btn', '停止生成');
        this._stopButton.hide();
        inputRow.add_child(this._sendButton);
        inputRow.add_child(this._stopButton);
        this.chatBox.add_child(inputRow);
    }

    setNotificationTabAvailable(available) {
        if (this._notificationTab) {
            this._notificationTab.visible = Boolean(available);
        }
    }

    applyTabVisualState(tab, {nativeList = null, showNotif = false, animate = true, changed = false} = {}) {
        if (!this.wrapper) return;
        const showAi = tab === 'ai';
        this.chatBox.visible = showAi;
        if (nativeList) nativeList.visible = showNotif;
        this._aiTab?.set_checked?.(showAi);
        this._notificationTab?.set_checked?.(tab === 'notifications');

        if (showAi) {
            this._aiTab?.add_style_pseudo_class('checked');
            this._notificationTab?.remove_style_pseudo_class('checked');
        } else {
            this._notificationTab?.add_style_pseudo_class('checked');
            this._aiTab?.remove_style_pseudo_class('checked');
        }

        const targetActor = showAi ? this.chatBox : (showNotif ? nativeList : null);
        if (animate && changed && targetActor && this._isAnimEnabled()) {
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

    buildEmptyState() {
        if (!this.messagesBox) return;
        if (this._empty) {
            try { this._empty.destroy(); } catch (_) {}
        }
        const card = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-empty-card',
            x_expand: true,
        });
        const effBackend = this._getEffectiveBackend();
        const caps = getBackendCapabilities(effBackend);
        const mode = this._getEffectiveMode?.() || this._getSettingString('agent-mode', 'readonly');
        const modeIdx = mode === 'full' ? 2 : mode === 'readonly' ? 1 : 0;
        const modeDesc = effBackend === 'unconfigured'
            ? '未检测到可用后端：请安装 ZCode / Codex CLI，或在右上角 ⚙ 设置中配置 OpenAI 兼容 API。'
            : `当前模式：${caps.modeLabels[modeIdx] || caps.modeLabels[1]}`;

        card.add_child(createWrapLabel('有什么想问的？', 'qc-empty-title'));
        card.add_child(createWrapLabel(modeDesc, 'qc-empty-subtitle'));

        const migrationNotice = this._getSettingString('migration-notice', '').trim();
        if (migrationNotice) {
            card.add_child(createWrapLabel(`ℹ️ ${migrationNotice}`, 'qc-empty-subtitle'));
        }

        const chips = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-chips-box',
            x_expand: true,
        });
        if (effBackend === 'unconfigured') {
            const setupChip = createStButton('⚙ 打开随问设置配置后端…', () => {
                this._onDismissMigrationNotice?.();
                this._onOpenPreferences?.();
            }, 'qc-chip', '打开设置配置后端');
            setupChip.x_align = Clutter.ActorAlign.START;
            chips.add_child(setupChip);
        }
        for (const item of DEFAULT_QUICK_PROMPTS) {
            const chip = createStButton(item.label, () => {
                if (item.prompt.endsWith('\n')) {
                    this.entry.set_text(item.prompt);
                    this.entry.grab_key_focus();
                    this.entry.clutter_text.set_cursor_position(-1);
                } else {
                    this.entry.set_text(item.prompt);
                    this._onSend();
                }
            }, 'qc-chip', item.label);
            chip.x_align = Clutter.ActorAlign.START;
            chips.add_child(chip);
        }
        card.add_child(chips);
        this._empty = card;
        this.messagesBox.add_child(this._empty);
    }

    syncThemeStyle(interfaceSettings) {
        if (!this.wrapper) return;
        let isLight = false;
        try {
            const scheme = interfaceSettings?.get_string('color-scheme') || '';
            const gtkTheme = (interfaceSettings?.get_string('gtk-theme') || '').toLowerCase();
            if (scheme === 'prefer-light' || (scheme === 'default' && gtkTheme.includes('light'))) {
                isLight = true;
            }
        } catch (_) {}
        if (isLight) this.wrapper.add_style_class_name('qc-light');
        else this.wrapper.remove_style_class_name('qc-light');
    }

    applyDimensions(nudgeLayoutFn) {
        if (!this.wrapper || !this.chatBox || !this.scroll) return;
        const width = this._getSettingInt('panel-width', 460);
        const height = this._getSettingInt('panel-height', 380);
        this.wrapper.set_width(width);
        this.chatBox.set_width(Math.max(300, width - 16));
        this.scroll.set_height(height);
        nudgeLayoutFn?.();
    }

    updateNotificationBadge() {
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

    updateAiTabBadge({isAiTabOpenAndVisible = false} = {}) {
        if (!this._aiBadge) return;
        let nextState = 'hidden';
        if (!isAiTabOpenAndVisible) {
            const live = this._getLiveCard?.();
            const hasPendingApproval = Boolean(
                live?.toolNodes?.some(n => n.status === 'pending_approval')
            );
            if (hasPendingApproval) nextState = 'pending';
            else if (this._isBusy?.()) nextState = 'busy';
            else if (this.hasUnreadBackgroundReply) nextState = 'unread';
        }

        if (this.lastAiBadgeState === nextState) return;
        this.lastAiBadgeState = nextState;

        for (const cls of ['qc-ai-dot-busy', 'qc-ai-dot-pending', 'qc-ai-dot-unread']) {
            this._aiBadge.remove_style_class_name(cls);
        }
        if (nextState === 'pending') {
            this._aiBadge.text = '!';
            this._aiBadge.add_style_class_name('qc-ai-dot-pending');
            this._aiBadge.visible = true;
        } else if (nextState === 'busy') {
            this._aiBadge.text = '●';
            this._aiBadge.add_style_class_name('qc-ai-dot-busy');
            this._aiBadge.visible = true;
        } else if (nextState === 'unread') {
            this._aiBadge.text = '●';
            this._aiBadge.add_style_class_name('qc-ai-dot-unread');
            this._aiBadge.visible = true;
        } else {
            this._aiBadge.visible = false;
        }
    }

    setBusyVisual(busy) {
        if (this._sendButton) this._sendButton.visible = !busy;
        if (this._stopButton) this._stopButton.visible = busy;
        if (this._newButton) this._newButton.reactive = !busy;
    }

    setStatusIndicator(state, text) {
        if (!this._status || !this._statusDot) return;
        const nextText = String(text ?? '');
        if (this.lastStatusText !== nextText) {
            this.lastStatusText = nextText;
            this._status.text = nextText;
        }
        if (this.lastStatusState === state) return;
        this.lastStatusState = state;

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
            if (this._isAnimEnabled()) {
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

    flushPendingBackgroundWork({isAiTabOpenAndVisible = true} = {}) {
        this.hasUnreadBackgroundReply = false;
        this.updateAiTabBadge({isAiTabOpenAndVisible});
        if (!this.hasPendingBackgroundRender) return;
        this.hasPendingBackgroundRender = false;
        for (const card of this.mountedCards) {
            if (card.dirty?.text || card.dirty?.thinking || card.dirty?.tools) {
                card.flushRender?.(true);
            }
        }
        this.scrollBottom(false);
    }

    _onScrollChanged() {
        if (this._programmaticScroll) return;
        const adj = this.scroll?.vadjustment;
        if (!adj) return;
        const maxVal = Math.max(adj.lower, adj.upper - adj.page_size);
        const dist = maxVal - adj.value;
        if (dist > 75) this.userScrolledUp = true;
        else if (dist <= 20) this.userScrolledUp = false;
        this.updateJumpBottomVisibility();
    }

    updateJumpBottomVisibility() {
        if (!this._jumpBottomBtn) return;
        const shouldShow = this.userScrolledUp || Boolean(this.historyWindow?.hasNewer);
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

    scrollBottom(force = false, animate = force) {
        if (!this._isChatVisible() && !force) return;
        if (force) {
            this.userScrolledUp = false;
            this.updateJumpBottomVisibility();
        }
        if (this.userScrolledUp && !force) return;
        if (animate) this._scrollPendingAnimate = true;
        if (this._scrollIdleId) return;

        this._scrollIdleId = this._scheduleIdle(() => {
            this._scrollIdleId = 0;
            const shouldAnimate = Boolean(this._scrollPendingAnimate && this._isAnimEnabled());
            this._scrollPendingAnimate = false;
            const adj = this.scroll?.vadjustment;
            if (!adj) return;
            const target = Math.max(adj.lower, adj.upper - adj.page_size);
            if (Math.abs(adj.value - target) < 1) return;
            this._programmaticScroll = true;
            if (shouldAnimate && adj.ease) {
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
        });
    }

    addMessage(role, text, options = {}) {
        const {
            animate = true,
            insertIndex = -1,
            scrollOnAdd = true,
            trackInHistoryWindow = true,
        } = options;
        this._empty?.hide();

        const card = this._cardFactory.createCard(role, text, options);

        if (insertIndex >= 0) {
            this.messagesBox.insert_child_at_index(card.box, insertIndex);
        } else if (this._loadNewerBtn && this._loadNewerBtn.get_parent() === this.messagesBox) {
            const idx = Math.max(0, this.messagesBox.get_n_children() - 1);
            this.messagesBox.insert_child_at_index(card.box, idx);
        } else {
            this.messagesBox.add_child(card.box);
        }

        if (trackInHistoryWindow && this.historyWindow) {
            const storedRecord = {
                id: card.messageId,
                turnId: card.turnId,
                replyTo: card.replyTo,
                role,
                text: card.text,
                thinking: card.thinking,
                createdAt: card.createdAt,
                ts: card.effectiveTs,
                backend: card.backend,
                modelId: card.modelId,
                status: 'completed',
            };
            const {evictedTopCards} = this.historyWindow.appendRuntimeCard(storedRecord, card, {
                allowRecycleTop: !this.userScrolledUp,
                protectedCard: this._getLiveCard?.(),
            });
            for (const oldTop of evictedTopCards) {
                this._cardFactory.destroyCardActor(oldTop);
            }
            if (evictedTopCards.length > 0) {
                this.syncHistoryWindowButtons();
            }
        }

        if (animate && this._isAnimEnabled() && this._isChatVisible()) {
            card.box.opacity = 0;
            card.box.translation_y = 9;
            this._easeActor(card.box, {
                opacity: 255,
                translation_y: 0,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }

        if (scrollOnAdd) {
            this.scrollBottom(role === 'user', role === 'user');
        }
        return card;
    }

    renderInitialHistory(allDetailed, onUserPromptSeen) {
        this.clearMessages();
        const normalized = Array.isArray(allDetailed) ? allDetailed : [];
        for (const msg of normalized) {
            if (msg.role === 'user' && msg.text) {
                onUserPromptSeen?.(msg.text);
            }
        }
        const {initialSlice} = this.historyWindow.reset(normalized);
        if (!initialSlice.length) return;

        const mounted = initialSlice.map(msg => this.addMessage(msg.role, msg.text, {
            animate: false,
            thinking: msg.thinking || '',
            scrollOnAdd: false,
            trackInHistoryWindow: false,
            messageId: msg.id || '',
            turnId: msg.turnId || '',
            replyTo: msg.replyTo || '',
            createdAt: msg.createdAt || '',
            ts: msg.ts || 0,
            modelId: msg.modelId || '',
            backend: msg.backend || '',
            errorMessage: msg.errorMessage || '',
        }));
        this.historyWindow.registerMountedInitialCards(mounted);
        this.syncHistoryWindowButtons();
    }

    syncHistoryWindowButtons() {
        if (!this.messagesBox || !this.historyWindow) return;

        if (!this.historyWindow.hasOlder) {
            if (this._loadMoreBtn) {
                try { this._loadMoreBtn.destroy(); } catch (_) {}
                this._loadMoreBtn = null;
            }
        } else {
            const remaining = this.historyWindow.olderRemainingCount;
            const label = `↑ 加载更早的 ${Math.min(DEFAULT_HISTORY_PAGE_SIZE, remaining)} 条对话（剩余 ${remaining} 条）`;
            if (!this._loadMoreBtn) {
                this._loadMoreBtn = createStButton(
                    label,
                    () => this.prependOlderHistoryBatch(),
                    'qc-load-more-btn',
                    '加载更早的历史对话'
                );
                this.messagesBox.insert_child_at_index(this._loadMoreBtn, 0);
            } else {
                this._loadMoreBtn.label = label;
            }
        }

        if (!this.historyWindow.hasNewer) {
            if (this._loadNewerBtn) {
                try { this._loadNewerBtn.destroy(); } catch (_) {}
                this._loadNewerBtn = null;
            }
        } else {
            const newerRemaining = this.historyWindow.newerRemainingCount;
            const newerLabel = `↓ 返回最新对话（已回收底部 ${newerRemaining} 条不可见消息以节省内存）`;
            if (!this._loadNewerBtn) {
                this._loadNewerBtn = createStButton(
                    newerLabel,
                    () => this.restoreLatestHistoryWindow(),
                    'qc-load-more-btn',
                    '回到最新历史窗口'
                );
                this.messagesBox.add_child(this._loadNewerBtn);
            } else {
                this._loadNewerBtn.label = newerLabel;
                try {
                    this.messagesBox.set_child_above_sibling(this._loadNewerBtn, null);
                } catch (_) {}
            }
        }
    }

    prependOlderHistoryBatch() {
        if (!this.historyWindow?.hasOlder || !this.messagesBox) return;
        const adj = this.scroll?.vadjustment;
        const prevUpper = adj ? adj.upper : 0;
        const prevValue = adj ? adj.value : 0;
        const anchorBox = this.historyWindow.mountedCards[0]?.box || null;
        let anchorPrevY = 0;
        try {
            if (anchorBox) anchorPrevY = anchorBox.get_allocation_box().y1;
        } catch (_) {}

        const {slice, newWindowStart, evictBottomCount} = this.historyWindow.planPrependOlderBatch({
            protectedCard: this._getLiveCard?.(),
        });
        if (!slice.length) return;

        const baseInsertIdx = this._loadMoreBtn ? 1 : 0;
        const prependedCards = slice.map((msg, offset) => this.addMessage(msg.role, msg.text, {
            animate: false,
            thinking: msg.thinking || '',
            insertIndex: baseInsertIdx + offset,
            scrollOnAdd: false,
            trackInHistoryWindow: false,
            messageId: msg.id || '',
            turnId: msg.turnId || '',
            replyTo: msg.replyTo || '',
            createdAt: msg.createdAt || '',
            ts: msg.ts || 0,
            modelId: msg.modelId || '',
            backend: msg.backend || '',
            errorMessage: msg.errorMessage || '',
        }));

        const evictedBottom = this.historyWindow.commitPrependedBatch(
            prependedCards,
            newWindowStart,
            evictBottomCount
        );
        for (const oldCard of evictedBottom) {
            this._cardFactory.destroyCardActor(oldCard);
        }
        this.syncHistoryWindowButtons();
        this.updateJumpBottomVisibility();

        this._scheduleTimeout(20, () => {
            if (!adj || !this.messagesBox) return;
            let shiftPx = Math.max(0, adj.upper - prevUpper);
            try {
                if (anchorBox && anchorBox.get_parent() === this.messagesBox) {
                    const anchorNewY = anchorBox.get_allocation_box().y1;
                    if (anchorNewY >= anchorPrevY) {
                        shiftPx = anchorNewY - anchorPrevY;
                    }
                }
            } catch (_) {}
            this._programmaticScroll = true;
            adj.value = Math.max(adj.lower, prevValue + shiftPx);
            this._programmaticScroll = false;
        });
    }

    restoreLatestHistoryWindow() {
        if (!this.messagesBox || !this.historyWindow) return;
        const all = [...this.historyWindow.allMessages];
        const liveCard = this._getLiveCard?.() || null;
        const liveBox = liveCard?.box || null;

        if (liveBox && liveBox.get_parent() === this.messagesBox) {
            try { this.messagesBox.remove_child(liveBox); } catch (_) {}
        }

        for (const c of this.historyWindow.mountedCards) {
            if (c !== liveCard) {
                this._cardFactory.destroyCardActor(c);
            }
        }
        if (this._loadMoreBtn) {
            try { this._loadMoreBtn.destroy(); } catch (_) {}
            this._loadMoreBtn = null;
        }
        if (this._loadNewerBtn) {
            try { this._loadNewerBtn.destroy(); } catch (_) {}
            this._loadNewerBtn = null;
        }

        if (!liveCard) {
            const {initialSlice} = this.historyWindow.reset(all);
            const mounted = initialSlice.map(msg => this.addMessage(msg.role, msg.text, {
                animate: false,
                thinking: msg.thinking || '',
                scrollOnAdd: false,
                trackInHistoryWindow: false,
                messageId: msg.id || '',
                turnId: msg.turnId || '',
                replyTo: msg.replyTo || '',
                createdAt: msg.createdAt || '',
                ts: msg.ts || 0,
                modelId: msg.modelId || '',
                backend: msg.backend || '',
                errorMessage: msg.errorMessage || '',
            }));
            this.historyWindow.registerMountedInitialCards(mounted);
        } else {
            const liveMsgIdx = liveCard.messageId
                ? all.findIndex(m => m && m.id === liveCard.messageId)
                : -1;
            const beforeLive = liveMsgIdx >= 0 ? all.slice(0, liveMsgIdx) : all;
            const startIdx = Math.max(0, beforeLive.length - (DEFAULT_INITIAL_HISTORY_COUNT - 1));
            const mountedBefore = beforeLive.slice(startIdx).map(msg => this.addMessage(msg.role, msg.text, {
                animate: false,
                thinking: msg.thinking || '',
                scrollOnAdd: false,
                trackInHistoryWindow: false,
                messageId: msg.id || '',
                turnId: msg.turnId || '',
                replyTo: msg.replyTo || '',
                createdAt: msg.createdAt || '',
                ts: msg.ts || 0,
                modelId: msg.modelId || '',
                backend: msg.backend || '',
                errorMessage: msg.errorMessage || '',
            }));
            if (liveBox) this.messagesBox.add_child(liveBox);
            this.historyWindow.allMessages = all;
            this.historyWindow.windowStart = startIdx;
            this.historyWindow.windowEnd = all.length;
            this.historyWindow.registerMountedInitialCards([...mountedBefore, liveCard]);
        }

        this.syncHistoryWindowButtons();
        this.userScrolledUp = false;
        this.updateJumpBottomVisibility();
        this.scrollBottom(true, true);
    }

    clearMessages() {
        for (const c of this.mountedCards) {
            this._cardFactory.destroyCardActor(c);
        }
        this.historyWindow?.clear();
        this._loadMoreBtn = null;
        this._loadNewerBtn = null;
        this._empty = null;
        this.messagesBox?.destroy_all_children();
        this.buildEmptyState();
    }

    rerenderAllMessages() {
        for (const card of this.mountedCards) {
            card.renderState = null;
            card.flushRender?.(true);
        }
    }

    dispose() {
        if (this._scrollIdleId) {
            this._clearTimer(this._scrollIdleId);
            this._scrollIdleId = 0;
        }
        const vadj = this.scroll?.vadjustment;
        if (vadj) {
            if (this._vadjValueSig) {
                try { vadj.disconnect(this._vadjValueSig); } catch (_) {}
            }
            if (this._vadjUpperSig) {
                try { vadj.disconnect(this._vadjUpperSig); } catch (_) {}
            }
            this._vadjValueSig = this._vadjUpperSig = 0;
        }

        for (const c of this.mountedCards) {
            this._cardFactory.destroyCardActor(c);
        }
        this.historyWindow?.clear();
        this.historyWindow = null;

        for (const actor of [this._statusDot, this._jumpBottomBtn, this.chatBox, this.wrapper]) {
            try { actor?.remove_all_transitions?.(); } catch (_) {}
        }

        this.wrapper = this.chatBox = this.entry = this.scroll = this.messagesBox = null;
        this._aiTab = this._notificationTab = this._aiBadge = this._notifBadge = null;
        this._reconnectButton = this._status = this._statusDot = null;
        this._sendButton = this._stopButton = this._newButton = this._jumpBottomBtn = null;
        this._loadMoreBtn = this._loadNewerBtn = this._empty = null;
    }
}
