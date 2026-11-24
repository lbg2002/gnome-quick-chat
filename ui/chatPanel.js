import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getBackendCapabilities} from '../protocol.js';
import {
    DEFAULT_QUICK_PROMPTS,
    applyQuickActionToDraft,
    matchSlashCommands,
    parseQuickPromptsConfig,
} from '../core/quickActions.js';
import {
    DEFAULT_HISTORY_PAGE_SIZE,
    DEFAULT_INITIAL_HISTORY_COUNT,
    DEFAULT_MAX_MOUNTED_ACTORS,
    HistoryWindowController,
    formatMemoryReceipt,
} from '../core/renderScheduler.js';
import {H, V, createStButton, createWrapLabel} from './tracePanel.js';

export {DEFAULT_QUICK_PROMPTS};

/**
 * Encapsulates Quick Chat's GNOME Shell St widget hierarchy, tab switching, status header,
 * lightweight session recovery menu, context attachment chips, `/` slash command bar,
 * windowed `HistoryWindowController` DOM recycling, and single-idle scroll coalescing (Stages E & F).
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
        onAttachFileButton,
        onAttachPathSubmit,
        onRemoveAttachment,
        onToggleAttachmentPreview,
        onToggleAttachmentFileMode,
        onNewSession,
        onRefreshSessionMenuState,
        onRestorePreviousSession,
        onExportSession,
        onDeleteCurrentSession,
        onApproveRetentionCleanup,
        onCancelEditQuestion,
        onApplyRouteSuggestion,
        onDismissRouteSuggestion,
        onSend,
        onAbort,
        onEntryKeyPress,
        onEntryTextChanged,
        onDismissMigrationNotice,
        onLoadOlderArchivePage = null,
        onCopyDiagnosticsReport = null,
        onRetrySaveSession = null,
        onUndoLastRewind = null,
        onSwitchToAgentBackendForPath = null,
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
        this._onAttachFileButton = onAttachFileButton;
        this._onAttachPathSubmit = onAttachPathSubmit;
        this._onRemoveAttachment = onRemoveAttachment;
        this._onToggleAttachmentPreview = onToggleAttachmentPreview;
        this._onToggleAttachmentFileMode = onToggleAttachmentFileMode;
        this._onNewSession = onNewSession;
        this._onRefreshSessionMenuState = onRefreshSessionMenuState;
        this._onRestorePreviousSession = onRestorePreviousSession;
        this._onExportSession = onExportSession;
        this._onDeleteCurrentSession = onDeleteCurrentSession;
        this._onApproveRetentionCleanup = onApproveRetentionCleanup;
        this._onCancelEditQuestion = onCancelEditQuestion;
        this._onApplyRouteSuggestion = onApplyRouteSuggestion;
        this._onDismissRouteSuggestion = onDismissRouteSuggestion;
        this._onSend = onSend;
        this._onAbort = onAbort;
        this._onEntryKeyPress = onEntryKeyPress;
        this._onEntryTextChanged = onEntryTextChanged;
        this._onDismissMigrationNotice = onDismissMigrationNotice;
        this._onLoadOlderArchivePage = onLoadOlderArchivePage;
        this._onCopyDiagnosticsReport = onCopyDiagnosticsReport;
        this._onRetrySaveSession = onRetrySaveSession;
        this._onUndoLastRewind = onUndoLastRewind;
        this._onSwitchToAgentBackendForPath = onSwitchToAgentBackendForPath;
        this._archivePageLoading = false;

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
        this._aiBadge = null;
        this._reconnectButton = null;
        this._status = null;
        this._statusDot = null;
        this._sendButton = null;
        this._stopButton = null;
        this._newButton = null;
        this._sessionMenuBtn = null;
        this._sessionMenuBox = null;
        this._sessionDeleteConfirming = false;
        this._jumpBottomBtn = null;
        this._loadMoreBtn = null;
        this._loadNewerBtn = null;
        this._empty = null;

        this._editBanner = null;
        this._editBannerLabel = null;
        this._routeBanner = null;
        this._routeBannerLabel = null;
        this._currentRouteSuggestion = null;
        this._fileAttachBar = null;
        this._filePathEntry = null;
        this._attachmentBar = null;
        this._slashMenuBox = null;
        this._slashMatches = [];
        this._slashSelectedIndex = 0;
        this._suppressEntryChange = false;

        this._vadjValueSig = 0;
        this._vadjUpperSig = 0;
        this._entryTextChangedSig = 0;
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

    get isSessionMenuOpen() {
        return Boolean(this._sessionMenuBox?.visible);
    }

    get isSlashMenuOpen() {
        return Boolean(this._slashMenuBox?.visible && this._slashMatches.length > 0);
    }

    build() {
        this.wrapper = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-wrapper',
            x_expand: true,
            y_expand: true,
        });

        this._buildTopTabs();
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

    _buildTopTabs() {
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
            accessible_name: '聚焦随问输入框',
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
        // Bound the status label. Long backend diagnostics belong in the
        // settings report, not in an infinitely expanding Shell header.
        this._status.set_width(160);
        this._status.clutter_text.line_wrap = false;
        this._status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._status.y_align = Clutter.ActorAlign.CENTER;
        statusBox.add_child(this._status);

        const chevron = new St.Label({
            text: '▾',
            style_class: 'qc-status-chevron',
            y_align: Clutter.ActorAlign.CENTER,
        });
        statusBox.add_child(chevron);
        statusBtn.set_child(statusBox);
        statusBtn.connect('clicked', () => {
            if (this.isSessionMenuOpen) this.toggleSessionMenu(false);
            this._modelPicker.toggle();
        });
        header.add_child(statusBtn);

        header.add_child(createStButton(
            '📎',
            () => this._onAttachFileButton?.(),
            'qc-button-subtle',
            '附加选中文件或本地路径引用'
        ));

        header.add_child(createStButton(
            '📋',
            () => this._onClipboardAsk(false),
            'qc-button-subtle',
            '将剪贴板或选中日志作为独立附件引用（不覆盖草稿）'
        ));

        this._newButton = createStButton('＋ 新对话', () => this._onNewSession(), 'qc-button-subtle', '开启新对话');
        header.add_child(this._newButton);

        this._sessionMenuBtn = createStButton(
            '▾',
            () => this.toggleSessionMenu(),
            'qc-button-subtle',
            '当前会话恢复、导出与清理菜单'
        );
        header.add_child(this._sessionMenuBtn);

        this.chatBox.add_child(header);

        const pickerBox = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-model-picker',
            x_expand: true,
            visible: false,
        });
        this.chatBox.add_child(pickerBox);
        this._modelPicker.attachActors(pickerBox, chevron);

        this._sessionMenuBox = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-session-menu',
            x_expand: true,
            visible: false,
        });
        this.chatBox.add_child(this._sessionMenuBox);

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
        this._buildContextAndSlashBars();

        this._memoryReceipts = new Map();
        this._memoryReceipt = createWrapLabel('', 'qc-inline-banner');
        this._memoryReceipt.hide();
        this.chatBox.add_child(this._memoryReceipt);
        this.approvalSlot = new St.BoxLayout({orientation: V, x_expand: true});
        const approvalScroll = new St.ScrollView({
            style_class: 'qc-approval-scroll',
            x_expand: true,
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        approvalScroll.set_child(this.approvalSlot);
        this.chatBox.add_child(approvalScroll);
        const inputRow = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-input-row',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.entry = new St.Entry({
            hint_text: '输入问题 · Enter 发送 · / 快捷操作',
            can_focus: true,
            x_expand: true,
            style_class: 'qc-entry',
            track_hover: true,
        });
        this.entry.clutter_text.connect('activate', () => {
            if (this.isSlashMenuOpen) {
                this.acceptSlashSelection();
                return;
            }
            this._onSend();
        });
        this.entry.clutter_text.connect('key-press-event', (_, event) => this._onEntryKeyPress(event));
        this._entryTextChangedSig = this.entry.clutter_text.connect('text-changed', () => {
            if (this._suppressEntryChange) return;
            const current = this.entry?.get_text() || '';
            this.refreshSlashMenuForText(current);
            this._onEntryTextChanged?.(current);
        });
        inputRow.add_child(this.entry);

        this._sendButton = createStButton('发送', () => this._onSend(), 'qc-send-btn', '发送问题');
        this._stopButton = createStButton('■ 停止', () => this._onAbort(), 'qc-stop-btn', '停止生成');
        this._stopButton.hide();
        inputRow.add_child(this._sendButton);
        inputRow.add_child(this._stopButton);
        this.chatBox.add_child(inputRow);
    }

    setMemoryReceipt(event = null) {
        if (!this._memoryReceipt) return;
        if (!event) {
            this._memoryReceipts.clear();
        } else {
            const key = event.memoryTurnId || '';
            this._memoryReceipts.delete(key);
            this._memoryReceipts.set(key, formatMemoryReceipt(event));
            if (this._memoryReceipts.size > 3) this._memoryReceipts.delete(this._memoryReceipts.keys().next().value);
        }
        this._memoryReceipt.text = [...this._memoryReceipts.values()].join('\n');
        this._memoryReceipt.visible = this._memoryReceipts.size > 0;
    }

    _buildContextAndSlashBars() {
        // 1. Historical question edit banner (Stage F3)
        this._editBanner = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-inline-banner',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._editBannerLabel = createWrapLabel(
            '✎ 正在编辑历史问题（发送后将从该位置重新生成）',
            'qc-mini-label'
        );
        this._editBanner.add_child(this._editBannerLabel);
        this._editBanner.add_child(createStButton(
            '取消',
            () => this._onCancelEditQuestion?.(),
            'qc-copy-btn',
            '取消编辑历史问题'
        ));
        this.chatBox.add_child(this._editBanner);

        // 2. Optional local smart model routing suggestion banner (Stage F6)
        this._routeBanner = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-inline-banner',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._routeBannerLabel = createWrapLabel('', 'qc-mini-label');
        this._routeBanner.add_child(this._routeBannerLabel);
        this._routeBanner.add_child(createStButton(
            '采用',
            () => {
                if (this._currentRouteSuggestion) {
                    this._onApplyRouteSuggestion?.(this._currentRouteSuggestion);
                }
            },
            'qc-copy-btn',
            '采用本地推荐的后端与模型'
        ));
        this._routeBanner.add_child(createStButton(
            '忽略',
            () => {
                if (this._currentRouteSuggestion) {
                    this._onDismissRouteSuggestion?.(this._currentRouteSuggestion);
                }
            },
            'qc-copy-btn',
            '忽略本次推荐'
        ));
        this.chatBox.add_child(this._routeBanner);

        // 3. Inline file path attachment bar (Stage F2)
        this._fileAttachBar = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-inline-banner',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._filePathEntry = new St.Entry({
            hint_text: '输入或粘贴本地文件路径（如 ~/notes.md）…',
            can_focus: true,
            x_expand: true,
            style_class: 'qc-picker-search',
        });
        this._filePathEntry.clutter_text.connect('activate', () => {
            const p = this._filePathEntry.get_text().trim();
            if (p) this._onAttachPathSubmit?.(p, {preferPathOnly: false});
        });
        this._fileAttachBar.add_child(this._filePathEntry);
        this._fileAttachBar.add_child(createStButton(
            '引正文',
            () => {
                const p = this._filePathEntry?.get_text().trim() || '';
                if (p) this._onAttachPathSubmit?.(p, {preferPathOnly: false});
            },
            'qc-copy-btn',
            '读取 UTF-8 文本文件正文作为引用（≤128 KB）'
        ));
        this._fileAttachBar.add_child(createStButton(
            '仅路径',
            () => {
                const p = this._filePathEntry?.get_text().trim() || '';
                if (p) this._onAttachPathSubmit?.(p, {preferPathOnly: true});
            },
            'qc-copy-btn',
            '仅附带文件路径标识，不上传文件内容'
        ));
        this._fileAttachBar.add_child(createStButton(
            '✕',
            () => this.toggleFileAttachBar(false),
            'qc-copy-btn',
            '关闭文件附加栏'
        ));
        this.chatBox.add_child(this._fileAttachBar);

        // 4. Context attachments list & outbound scope notice (Stage F2)
        this._attachmentBar = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-attachment-bar',
            x_expand: true,
            visible: false,
        });
        this.chatBox.add_child(this._attachmentBar);

        // 5. Compact `/` slash command completion bar (Stage F1)
        this._slashMenuBox = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-slash-menu',
            x_expand: true,
            visible: false,
        });
        this.chatBox.add_child(this._slashMenuBox);
    }

    setEntryTextProgrammatically(text, {focus = false, cursorAtEnd = true} = {}) {
        if (!this.entry) return;
        this._suppressEntryChange = true;
        this.entry.set_text(String(text ?? ''));
        this._suppressEntryChange = false;
        this.closeSlashMenu();
        if (focus) {
            this.entry.grab_key_focus();
        }
        if (cursorAtEnd) {
            this.entry.clutter_text.set_cursor_position(-1);
        }
        this._onEntryTextChanged?.(this.entry.get_text());
    }

    /**
     * Fills `entry` with a quick prompt or `/` command WITHOUT auto-sending (Stage F1 invariant).
     */
    applyQuickPromptItem(item) {
        if (!this.entry || !item) return;
        const applied = applyQuickActionToDraft(item, this.entry.get_text());
        this.setEntryTextProgrammatically(applied.text, {focus: true, cursorAtEnd: true});
    }

    refreshSlashMenuForText(rawText, {forceOpen = false} = {}) {
        if (!this._slashMenuBox) return;
        const customPrompts = parseQuickPromptsConfig(this._getSettingString('quick-prompts-json', ''));
        const matched = matchSlashCommands(rawText, customPrompts, {forceOpen});
        if (!matched.active || matched.matches.length === 0) {
            this.closeSlashMenu();
            return;
        }
        this._slashMatches = matched.matches;
        if (this._slashSelectedIndex >= this._slashMatches.length) {
            this._slashSelectedIndex = 0;
        }
        this._renderSlashMenuItems();
    }

    _renderSlashMenuItems() {
        if (!this._slashMenuBox) return;
        this._slashMenuBox.destroy_all_children();
        if (!this._slashMatches.length) {
            this._slashMenuBox.visible = false;
            return;
        }

        const hint = createWrapLabel(
            '快捷命令（↑↓ 选择，Tab / Enter 仅填入输入框，Esc 关闭）',
            'qc-mini-label'
        );
        this._slashMenuBox.add_child(hint);

        this._slashMatches.forEach((cmd, idx) => {
            const cls = idx === this._slashSelectedIndex
                ? 'qc-slash-item qc-slash-item-active'
                : 'qc-slash-item';
            const btn = createStButton(
                `${cmd.label} — ${cmd.description}`,
                () => {
                    this._slashSelectedIndex = idx;
                    this.acceptSlashSelection();
                },
                cls,
                cmd.label
            );
            btn.x_align = Clutter.ActorAlign.FILL;
            btn.x_expand = true;
            this._slashMenuBox.add_child(btn);
        });
        this._slashMenuBox.visible = true;
    }

    moveSlashSelection(delta) {
        if (!this.isSlashMenuOpen) return false;
        const len = this._slashMatches.length;
        this._slashSelectedIndex = (this._slashSelectedIndex + delta + len) % len;
        this._renderSlashMenuItems();
        return true;
    }

    acceptSlashSelection() {
        if (!this.isSlashMenuOpen) return false;
        const chosen = this._slashMatches[this._slashSelectedIndex] || this._slashMatches[0];
        this.closeSlashMenu();
        if (chosen) {
            this.applyQuickPromptItem(chosen);
            return true;
        }
        return false;
    }

    closeSlashMenu() {
        this._slashMatches = [];
        this._slashSelectedIndex = 0;
        if (this._slashMenuBox) {
            this._slashMenuBox.visible = false;
            this._slashMenuBox.destroy_all_children();
        }
    }

    toggleFileAttachBar(forceState = null) {
        if (!this._fileAttachBar) return;
        const next = forceState !== null ? Boolean(forceState) : !this._fileAttachBar.visible;
        this._fileAttachBar.visible = next;
        if (next) {
            this._filePathEntry?.set_text('');
            this._filePathEntry?.grab_key_focus();
        } else {
            this.entry?.grab_key_focus();
        }
    }

    setEditQuestionBanner(active, previewQuestion = '', {
        discardedCount = 0,
        hasPreservedAttachments = false,
        hadSideEffectTools = false,
    } = {}) {
        if (!this._editBanner || !this._editBannerLabel) return;
        if (!active) {
            this._editBanner.visible = false;
            return;
        }
        const shortQ = String(previewQuestion || '').replace(/\s+/g, ' ').trim().slice(0, 22);
        const attachNote = hasPreservedAttachments ? ' · 已保留原附件' : '';
        const discardNote = discardedCount > 0
            ? ` · 发送后将舍弃后续 ${discardedCount} 条消息（可在会话菜单 ↶ 撤销回退）`
            : '（发送后从此处重新生成）';
        const sideEffectNote = hadSideEffectTools ? ' · ⚠️ 原回答曾执行写入/高风险工具，请留意不会自动回滚外部文件' : '';
        this._editBannerLabel.text = shortQ
            ? `✎ 编辑历史问题「${shortQ}${previewQuestion.length > 22 ? '…' : ''}」${attachNote}${discardNote}${sideEffectNote}`
            : `✎ 正在编辑历史问题${attachNote}${discardNote}${sideEffectNote}`;
        this._editBanner.visible = true;
    }

    setRouteSuggestion(suggestion = null) {
        this._currentRouteSuggestion = suggestion;
        if (!this._routeBanner || !this._routeBannerLabel) return;
        if (!suggestion) {
            this._routeBanner.visible = false;
            return;
        }
        this._routeBannerLabel.text = `💡 ${suggestion.reasonLabel}（推荐：${suggestion.summaryLabel}）`;
        this._routeBanner.visible = true;
    }

    renderAttachments(items = [], scopeNotice = '', {pureApiActionDesc = null} = {}) {
        if (!this._attachmentBar) return;
        this._attachmentBar.destroy_all_children();

        if (!Array.isArray(items) || items.length === 0) {
            this._attachmentBar.visible = false;
            if (this.entry) {
                this.entry.hint_text = '输入问题 · Enter 发送 · / 快捷操作';
            }
            return;
        }

        for (const item of items) {
            const itemBox = new St.BoxLayout({
                orientation: V,
                x_expand: true,
            });
            const row = new St.BoxLayout({
                orientation: H,
                style_class: 'qc-attachment-row',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            const titleLabel = createWrapLabel(
                `📎 ${item.sourceLabel} · ${item.title} (${item.sizeLabel})`,
                'qc-attachment-title'
            );
            row.add_child(titleLabel);

            if (item.canToggleContent) {
                const modeLabel = item.kind === 'file_content' ? '改为仅路径' : '附带正文';
                row.add_child(createStButton(
                    modeLabel,
                    () => this._onToggleAttachmentFileMode?.(item.id),
                    'qc-copy-btn',
                    '切换发送文件正文或仅发送路径'
                ));
            }

            row.add_child(createStButton(
                item.previewExpanded ? '收起' : '预览',
                () => this._onToggleAttachmentPreview?.(item.id),
                'qc-copy-btn',
                '预览将随本次提问发送的引用内容'
            ));

            row.add_child(createStButton(
                '✕',
                () => this._onRemoveAttachment?.(item.id),
                'qc-copy-btn',
                '移除此附件引用'
            ));
            itemBox.add_child(row);

            if (item.previewExpanded) {
                itemBox.add_child(createWrapLabel(item.previewText || '', 'qc-attachment-preview'));
            }
            this._attachmentBar.add_child(itemBox);
        }

        if (pureApiActionDesc?.hasPathWarning) {
            const actionRow = new St.BoxLayout({
                orientation: H,
                style_class: 'qc-attachment-row',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            actionRow.add_child(createWrapLabel(pureApiActionDesc.warningText, 'qc-scope-notice'));
            for (const act of pureApiActionDesc.actions || []) {
                if (act.action === 'upgrade_to_content' && act.itemIds?.length) {
                    actionRow.add_child(createStButton(
                        act.label,
                        () => {
                            for (const id of act.itemIds) {
                                this._onToggleAttachmentFileMode?.(id);
                            }
                        },
                        'qc-copy-btn',
                        act.description
                    ));
                } else if (act.action === 'switch_to_agent_backend') {
                    actionRow.add_child(createStButton(
                        act.label,
                        () => this._onSwitchToAgentBackendForPath?.(),
                        'qc-copy-btn',
                        act.description
                    ));
                }
            }
            this._attachmentBar.add_child(actionRow);
        }

        if (scopeNotice) {
            this._attachmentBar.add_child(createWrapLabel(scopeNotice, 'qc-scope-notice'));
        }
        this._attachmentBar.visible = true;
        if (this.entry) {
            this.entry.hint_text = `已附带 ${items.length} 个引用 · Enter 发送`;
        }
    }

    toggleSessionMenu(forceState = null) {
        if (!this._sessionMenuBox) return;
        const next = forceState !== null ? Boolean(forceState) : !this._sessionMenuBox.visible;
        this._sessionDeleteConfirming = false;
        if (next) {
            if (this._modelPicker?.isOpen) {
                this._modelPicker.toggle(false);
            }
            this._sessionMenuBox.visible = true;
            this._onRefreshSessionMenuState?.();
        } else {
            this._sessionMenuBox.visible = false;
            this._sessionMenuBox.destroy_all_children();
        }
    }

    /**
     * Renders the compact session recovery & diagnostics bar (Stage F4 & R11.2/R11.3):
     * Current Session Info / New / Restore Previous / Export / Copy Diagnostics / Retry Save / Undo Rewind / Delete.
     */
    renderSessionMenuState({
        currentSessionId = '',
        messageCount = 0,
        archivedCount = 0,
        previousSessionId = '',
        previousPreview = '',
        cleanupPlan = null,
        saveWarning = '',
        canUndoLastRewind = false,
    } = {}) {
        if (!this._sessionMenuBox || !this._sessionMenuBox.visible) return;
        this._sessionMenuBox.destroy_all_children();

        const shortCur = String(currentSessionId || '').slice(0, 8) || '未分配';
        const saveTag = saveWarning ? ` · ⚠️ ${saveWarning}` : ' · 已本地保存';
        const archiveTag = archivedCount > 0 ? `，含 ${archivedCount} 条已归档` : '';
        this._sessionMenuBox.add_child(createWrapLabel(
            `当前会话：${shortCur}（${messageCount} 条消息${archiveTag}${saveTag}）`,
            'qc-mini-label'
        ));

        const actionsRow = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-session-actions',
            y_align: Clutter.ActorAlign.CENTER,
        });

        actionsRow.add_child(createStButton(
            '＋ 新建',
            () => {
                this.toggleSessionMenu(false);
                this._onNewSession?.();
            },
            'qc-copy-btn',
            '新建空白会话'
        ));

        const prevBtn = createStButton(
            previousSessionId
                ? `↺ 恢复上一会话${previousPreview ? ` (${previousPreview.slice(0, 8)})` : ''}`
                : '↺ 暂无上一会话',
            () => {
                if (!previousSessionId) return;
                this.toggleSessionMenu(false);
                this._onRestorePreviousSession?.(previousSessionId);
            },
            'qc-copy-btn',
            '恢复最近一个非空会话'
        );
        prevBtn.reactive = Boolean(previousSessionId && !this._isBusy?.());
        actionsRow.add_child(prevBtn);

        if (canUndoLastRewind) {
            const undoBtn = createStButton(
                '↶ 撤销回退',
                () => {
                    this.toggleSessionMenu(false);
                    this._onUndoLastRewind?.();
                },
                'qc-copy-btn',
                '恢复上一次编辑或重试时舍弃的后续对话记录'
            );
            undoBtn.reactive = !this._isBusy?.();
            actionsRow.add_child(undoBtn);
        }

        if (saveWarning) {
            actionsRow.add_child(createStButton(
                '↻ 重试保存',
                () => {
                    this.toggleSessionMenu(false);
                    this._onRetrySaveSession?.();
                },
                'qc-copy-btn',
                '重试将未落盘的会话消息写入本地磁盘'
            ));
        }

        const exportBtn = createStButton(
            '⇩ 导出对话',
            () => {
                this.toggleSessionMenu(false);
                this._onExportSession?.();
            },
            'qc-copy-btn',
            '导出当前对话为 Markdown 并复制到剪贴板'
        );
        exportBtn.reactive = messageCount > 0;
        actionsRow.add_child(exportBtn);

        actionsRow.add_child(createStButton(
            '📋 复制诊断',
            () => {
                this.toggleSessionMenu(false);
                this._onCopyDiagnosticsReport?.();
            },
            'qc-copy-btn',
            '复制不含密钥与对话正文的脱敏运行时诊断摘要'
        ));

        if (!this._sessionDeleteConfirming) {
            const delBtn = createStButton(
                '🗑 删除',
                () => {
                    this._sessionDeleteConfirming = true;
                    this.renderSessionMenuState({
                        currentSessionId,
                        messageCount,
                        archivedCount,
                        previousSessionId,
                        previousPreview,
                        cleanupPlan,
                        saveWarning,
                        canUndoLastRewind,
                    });
                },
                'qc-copy-btn',
                '删除当前会话本地历史文件'
            );
            delBtn.reactive = !this._isBusy?.();
            actionsRow.add_child(delBtn);
        } else {
            actionsRow.add_child(createStButton(
                '确认删除当前会话？',
                () => {
                    this._sessionDeleteConfirming = false;
                    this.toggleSessionMenu(false);
                    this._onDeleteCurrentSession?.();
                },
                'qc-copy-btn qc-danger-btn',
                '确认永久删除当前会话磁盘记录'
            ));
            actionsRow.add_child(createStButton(
                '取消',
                () => {
                    this._sessionDeleteConfirming = false;
                    this.renderSessionMenuState({
                        currentSessionId,
                        messageCount,
                        archivedCount,
                        previousSessionId,
                        previousPreview,
                        cleanupPlan,
                        saveWarning,
                        canUndoLastRewind,
                    });
                },
                'qc-copy-btn',
                '取消删除'
            ));
        }

        this._sessionMenuBox.add_child(actionsRow);

        const expiredCount = cleanupPlan?.candidatesToDelete?.length || 0;
        if (expiredCount > 0) {
            const cleanupRow = new St.BoxLayout({
                orientation: H,
                style_class: 'qc-session-actions',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const sizeSummary = cleanupPlan?.candidateSizeSummary || '0 B';
            cleanupRow.add_child(createWrapLabel(
                `发现 ${expiredCount} 个超出保留策略（${cleanupPlan.policySummary}，共约 ${sizeSummary}）的旧会话`,
                'qc-mini-label'
            ));
            cleanupRow.add_child(createStButton(
                `同意清理 (${expiredCount} / ${sizeSummary})`,
                () => {
                    const ids = cleanupPlan.candidatesToDelete.map(c => c.sessionId);
                    this.toggleSessionMenu(false);
                    this._onApproveRetentionCleanup?.(ids);
                },
                'qc-copy-btn qc-danger-btn',
                '经您明确同意后清理超出保留范围的旧会话'
            ));
            this._sessionMenuBox.add_child(cleanupRow);
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

        const quickPrompts = parseQuickPromptsConfig(this._getSettingString('quick-prompts-json', ''));
        for (const item of quickPrompts) {
            const chip = createStButton(item.label, () => {
                // Stage F1 hard rule: quick actions fill input draft ONLY and NEVER auto-send!
                this.applyQuickPromptItem(item);
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

    applyDimensions() {
        if (!this.wrapper || !this.chatBox || !this.scroll) return;
        const width = this._getSettingInt('panel-width', 460);
        const height = this._getSettingInt('panel-height', 380);
        this.wrapper.set_width(width);
        this.chatBox.set_width(Math.max(300, width - 16));
        this.scroll.set_height(height);
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
        if (this._sessionMenuBtn) this._sessionMenuBtn.reactive = !busy;
        if (busy && this.isSessionMenuOpen) {
            this.toggleSessionMenu(false);
        }
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
            rawPromptText = '',
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
                text: rawPromptText || card.text,
                ...(rawPromptText && rawPromptText !== card.text ? {displayText: card.text} : {}),
                thinking: card.thinking,
                createdAt: card.createdAt,
                ts: card.effectiveTs,
                backend: card.backend,
                modelId: card.modelId,
                status: card.status || 'completed',
                ...(card.partial ? {partial: true} : {}),
                ...(card.finishReason ? {finishReason: card.finishReason} : {}),
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

    /**
     * Truncates mounted cards and `HistoryWindowController` in place for Regenerate (`keepUserCard: true`)
     * or Edit Question (`keepUserCard: false`), never appending duplicate user cards!
     */
    truncateMessagesFromId(startMessageId, {keepStartMessage = false} = {}) {
        if (!this.historyWindow) return false;
        const {removedCards, truncated, needsRemountWindow} = this.historyWindow.truncateFromMessageId(
            startMessageId,
            {keepStartMessage}
        );
        if (!truncated) return false;
        for (const c of removedCards) {
            this._cardFactory.destroyCardActor(c);
        }
        if (needsRemountWindow) {
            this.restoreLatestHistoryWindow();
        } else {
            this.syncHistoryWindowButtons();
            if (this.historyWindow.allMessages.length === 0 && !this.historyWindow.externalArchivedCount) {
                this.buildEmptyState();
            }
        }
        return true;
    }

    renderInitialHistory(allDetailed, onUserPromptSeen, {externalArchivedCount = 0} = {}) {
        if (!this.messagesBox || !this.historyWindow) return;
        this.clearMessages({buildEmpty: false});
        const normalized = Array.isArray(allDetailed) ? allDetailed : [];
        for (const msg of normalized) {
            if (msg.role === 'user' && msg.text) {
                onUserPromptSeen?.(msg.text);
            }
        }
        const {initialSlice} = this.historyWindow.reset(normalized, {externalArchivedCount});
        if (!initialSlice.length) {
            this.buildEmptyState();
            this.syncHistoryWindowButtons();
            return;
        }

        const mounted = initialSlice.map(msg => this.addMessage(msg.role, msg.displayText || msg.text, {
            rawPromptText: msg.text,
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
            status: msg.status || 'completed',
            partial: Boolean(msg.partial),
            finishReason: msg.finishReason || '',
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

    async prependOlderHistoryBatch() {
        if (!this.historyWindow?.hasOlder || !this.messagesBox || this._archivePageLoading) return;

        if (
            this.historyWindow.windowStart === 0 &&
            this.historyWindow.externalArchivedCount > 0 &&
            typeof this._onLoadOlderArchivePage === 'function'
        ) {
            this._archivePageLoading = true;
            try {
                const archivePage = await this._onLoadOlderArchivePage(DEFAULT_HISTORY_PAGE_SIZE);
                if (!this.historyWindow || !this.messagesBox) return;
                if (archivePage && Array.isArray(archivePage.messages)) {
                    this.historyWindow.prependArchivedMessages(archivePage.messages, {
                        remainingExternalCount: Number(archivePage.olderRemainingCount ?? 0),
                    });
                }
            } catch (_) {
                // Keep UI responsive even if archive read fails
            } finally {
                this._archivePageLoading = false;
            }
        }

        if (!this.historyWindow?.hasOlder || !this.messagesBox) {
            this.syncHistoryWindowButtons();
            return;
        }
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
        if (!slice.length) {
            this.syncHistoryWindowButtons();
            return;
        }

        const baseInsertIdx = this._loadMoreBtn ? 1 : 0;
        const prependedCards = slice.map((msg, offset) => this.addMessage(msg.role, msg.displayText || msg.text, {
            rawPromptText: msg.text,
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
            status: msg.status || 'completed',
            partial: Boolean(msg.partial),
            finishReason: msg.finishReason || '',
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
        const prevArchivedCount = this.historyWindow.externalArchivedCount;
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
            const {initialSlice} = this.historyWindow.reset(all, {externalArchivedCount: prevArchivedCount});
            const mounted = initialSlice.map(msg => this.addMessage(msg.role, msg.displayText || msg.text, {
                rawPromptText: msg.text,
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
                status: msg.status || 'completed',
                partial: Boolean(msg.partial),
                finishReason: msg.finishReason || '',
                errorMessage: msg.errorMessage || '',
            }));
            this.historyWindow.registerMountedInitialCards(mounted);
        } else {
            const liveMsgIdx = liveCard.messageId
                ? all.findIndex(m => m && m.id === liveCard.messageId)
                : -1;
            const beforeLive = liveMsgIdx >= 0 ? all.slice(0, liveMsgIdx) : all;
            const startIdx = Math.max(0, beforeLive.length - (DEFAULT_INITIAL_HISTORY_COUNT - 1));
            const mountedBefore = beforeLive.slice(startIdx).map(msg => this.addMessage(msg.role, msg.displayText || msg.text, {
                rawPromptText: msg.text,
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
                status: msg.status || 'completed',
                partial: Boolean(msg.partial),
                finishReason: msg.finishReason || '',
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

    clearMessages({buildEmpty = true} = {}) {
        this.setMemoryReceipt();
        for (const c of this.mountedCards) {
            this._cardFactory.destroyCardActor(c);
        }
        this.historyWindow?.clear();
        this._loadMoreBtn = null;
        this._loadNewerBtn = null;
        this._empty = null;
        this.messagesBox?.destroy_all_children();
        if (buildEmpty) this.buildEmptyState();
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
        if (this._entryTextChangedSig && this.entry?.clutter_text) {
            try { this.entry.clutter_text.disconnect(this._entryTextChangedSig); } catch (_) {}
            this._entryTextChangedSig = 0;
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
        this._aiTab = this._aiBadge = null;
        this._reconnectButton = this._status = this._statusDot = null;
        this._sendButton = this._stopButton = this._newButton = this._sessionMenuBtn = null;
        this._sessionMenuBox = this._editBanner = this._editBannerLabel = null;
        this._routeBanner = this._routeBannerLabel = this._currentRouteSuggestion = null;
        this._fileAttachBar = this._filePathEntry = this._attachmentBar = this._slashMenuBox = null;
        this._jumpBottomBtn = this._loadMoreBtn = this._loadNewerBtn = this._empty = null;
    }
}
