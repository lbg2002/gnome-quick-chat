import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {
    computeAdaptiveRenderDelayMs,
    formatMessageTimestamp,
    releaseCardRuntimeReferences,
    resolveAssistantDisplayModel,
} from '../core/renderScheduler.js';
import {renderCardBodyIncremental} from './markdownRenderer.js';
import {H, V, createStButton} from './tracePanel.js';

/**
 * Factory and lifecycle helper for user & assistant message cards (Stage E).
 * Handles historical timestamp/model preservation, adaptive render batching,
 * copy feedback, and clean Actor/timer/transition teardown.
 */
export class MessageCardFactory {
    constructor({
        tracePanel,
        isChatVisible,
        isMarkdownEnabled,
        isAnimEnabled,
        isCardStreaming,
        getFallbackModelLabel,
        scheduleTimeout,
        clearTimer,
        easeActor,
        onMarkBackgroundDirty,
        onScrollBottom,
        onRetryAssistantCard,
        onContinueAssistantCard = null,
        onEditUserCard = null,
    }) {
        this._tracePanel = tracePanel;
        this._isChatVisible = isChatVisible;
        this._isMarkdownEnabled = isMarkdownEnabled;
        this._isAnimEnabled = isAnimEnabled;
        this._isCardStreaming = isCardStreaming;
        this._getFallbackModelLabel = getFallbackModelLabel;
        this._scheduleTimeout = scheduleTimeout;
        this._clearTimer = clearTimer;
        this._easeActor = easeActor;
        this._onMarkBackgroundDirty = onMarkBackgroundDirty;
        this._onScrollBottom = onScrollBottom;
        this._onRetryAssistantCard = onRetryAssistantCard;
        this._onContinueAssistantCard = onContinueAssistantCard;
        this._onEditUserCard = onEditUserCard;
    }

    copyWithFeedback(btn, getTextFn, defaultLabel = '复制') {
        const text = typeof getTextFn === 'function' ? getTextFn() : String(getTextFn ?? '');
        if (!text) return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        btn.label = '✓ 已复制';
        btn.add_style_class_name('qc-copied');
        if (this._isAnimEnabled()) {
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

    renderCardBody(card) {
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

        const isStreaming = Boolean(this._isCardStreaming(card));
        renderCardBodyIncremental(card, {
            markdownEnabled: this._isMarkdownEnabled(),
            placeholderText,
            isStreaming,
            isFinal: !isStreaming,
            onCreateCodeCopyButton: getCodeTextFn => {
                const codeCopyBtn = createStButton('复制代码', () => {
                    this.copyWithFeedback(codeCopyBtn, getCodeTextFn, '复制代码');
                }, 'qc-copy-btn', '复制代码片段');
                return codeCopyBtn;
            },
        });
    }

    destroyCardActor(card) {
        if (!card) return;
        releaseCardRuntimeReferences(card, {clearTimer: this._clearTimer});
    }

    createCard(role, text, options = {}) {
        const {
            rawPromptText = '',
            thinking = '',
            turnId = '',
            messageId = '',
            replyTo = '',
            createdAt = '',
            ts = 0,
            modelId = '',
            backend = '',
            status = 'completed',
            partial = false,
            finishReason = '',
            errorMessage = '',
        } = options;

        const box = new St.BoxLayout({
            orientation: V,
            style_class: role === 'user' ? 'qc-message qc-user' : 'qc-message qc-assistant',
            x_expand: true,
        });

        const fallbackLabel = this._getFallbackModelLabel() || '随问';
        const displayModel = role === 'user'
            ? '我'
            : resolveAssistantDisplayModel({modelId, backend}, fallbackLabel);
        const effectiveTs = ts > 0 ? ts : (createdAt ? Date.parse(createdAt) || Date.now() : Date.now());
        const displayTime = formatMessageTimestamp({ts: effectiveTs, createdAt});

        const top = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-message-header',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const name = new St.Label({
            text: displayModel,
            style_class: 'qc-role',
            y_align: Clutter.ActorAlign.CENTER,
        });
        top.add_child(name);

        const time = new St.Label({
            text: displayTime,
            style_class: 'qc-time',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        top.add_child(time);

        const initialText = text || (errorMessage ? `⚠️ ${errorMessage}` : '');
        if (errorMessage && !text) {
            box.add_style_class_name('qc-message-error');
        }

        const effectiveMsgId = String(messageId || `${role}_${GLib.uuid_string_random()}`);
        const card = {
            role,
            turnId: String(turnId || ''),
            messageId: effectiveMsgId,
            replyTo: String(replyTo || ''),
            modelId: String(modelId || (role === 'assistant' ? fallbackLabel : '')),
            backend: String(backend || ''),
            effectiveTs,
            createdAt: createdAt || new Date(effectiveTs).toISOString(),
            status: String(status || 'completed'),
            partial: Boolean(partial),
            finishReason: String(finishReason || ''),
            rawPromptText: String(rawPromptText || text || ''),
            roleLabel: name,
            box,
            text: initialText,
            thinking: thinking || '',
            thinkingHadContent: Boolean(thinking && thinking.trim()),
            thinkingExpanded: false,
            toolNodes: [],
            dirtyToolNodeIds: new Set(),
            allToolDotsDirty: false,
            dotsExpanded: false,
            selectedNodeId: null,
            _lastSelectedNodeId: null,
            _lastThinkingDotKey: '',
            _lastFoldCount: 0,
            _lastIsFolded: false,
            hoveredNodeId: null,
            activeTool: false,
            traceBox: null,
            detailDrawer: null,
            copyBtn: null,
            continueBtn: null,
            renderTimer: 0,
            renderState: null,
            hasRenderedFirstToken: Boolean(initialText && initialText.trim()),
            lastRenderDurationMs: 0,
            dirty: {
                text: true,
                thinking: Boolean(thinking),
                tools: Boolean(thinking),
                toolsUrgent: false,
            },
        };

        card.syncContinueVisibility = () => {
            if (!card.continueBtn) return;
            const canContinue = Boolean(
                role === 'assistant' &&
                !this._isCardStreaming(card) &&
                card.text &&
                card.text.trim() &&
                !card.text.startsWith('⚠️ ') &&
                (
                    card.partial ||
                    card.finishReason === 'length' ||
                    card.status === 'interrupted' ||
                    card.status === 'cancelled' ||
                    card.status === 'timed_out'
                )
            );
            card.continueBtn.visible = canContinue;
        };

        if (role === 'user' && this._onEditUserCard) {
            const editBtn = createStButton('✎', () => this._onEditUserCard(card), 'qc-copy-btn', '编辑此问题并从此处重新生成');
            top.add_child(editBtn);
        }

        if (role === 'assistant') {
            if (this._onContinueAssistantCard) {
                const continueBtn = createStButton(
                    '⤵ 继续',
                    () => this._onContinueAssistantCard(card),
                    'qc-copy-btn',
                    '继续生成未完成或截断的回答'
                );
                card.continueBtn = continueBtn;
                card.syncContinueVisibility();
                top.add_child(continueBtn);
            }
            const retryBtn = createStButton('↻', () => this._onRetryAssistantCard(card), 'qc-copy-btn', '使用原问题在当前历史位置重新生成');
            top.add_child(retryBtn);
        }

        const copyBtn = createStButton('复制', () => {
            this.copyWithFeedback(copyBtn, () => card.text, '复制');
        }, 'qc-copy-btn', '复制消息原文');
        card.copyBtn = copyBtn;
        top.add_child(copyBtn);
        box.add_child(top);

        const bodyBox = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-message-body',
            x_expand: true,
        });
        box.add_child(bodyBox);
        card.bodyBox = bodyBox;

        const executeFlushPass = (forceAll = false) => {
            const t0 = GLib.get_monotonic_time();
            if (
                forceAll ||
                card.dirty.tools ||
                card.dirty.toolsUrgent ||
                (card.dirty.thinking && card.selectedNodeId === 'thinking')
            ) {
                this._tracePanel.updateCardActivity(card);
                card.dirty.tools = false;
                card.dirty.toolsUrgent = false;
                card.dirty.thinking = false;
            }
            if (forceAll || card.dirty.text) {
                this.renderCardBody(card);
                card.dirty.text = false;
                if (card.text && card.text.trim()) {
                    card.hasRenderedFirstToken = true;
                }
            }
            card.lastRenderDurationMs = Math.max(0, (GLib.get_monotonic_time() - t0) / 1000);
        };

        card.flushRender = (forceAll = false) => {
            if (card.renderTimer) {
                this._clearTimer(card.renderTimer);
                card.renderTimer = 0;
            }
            // R12: When the panel is hidden (`!this._isChatVisible()`) and not explicitly forced on open,
            // never create or layout body/trace Actors! Defer until `flushPendingBackgroundWork` when opened.
            if (!this._isChatVisible() && !forceAll) {
                this._onMarkBackgroundDirty();
                return;
            }
            executeFlushPass(forceAll);
        };

        card.scheduleRender = () => {
            if (!this._isChatVisible()) {
                this._onMarkBackgroundDirty();
                return;
            }
            const needsTools = card.dirty.tools || card.dirty.toolsUrgent || (card.dirty.thinking && card.selectedNodeId === 'thinking');
            const needsText = card.dirty.text;
            if (!needsTools && !needsText) return;

            const delayMs = computeAdaptiveRenderDelayMs({
                isFirstVisibleRender: Boolean(needsText && !card.hasRenderedFirstToken && card.text.length > 0),
                urgentImmediate: Boolean(card.dirty.toolsUrgent),
                textLength: card.text.length,
                lastRenderDurationMs: card.lastRenderDurationMs,
            });

            if (delayMs <= 0) {
                if (card.renderTimer) {
                    this._clearTimer(card.renderTimer);
                    card.renderTimer = 0;
                }
                executeFlushPass(false);
                this._onScrollBottom(false, false);
                return;
            }

            if (card.renderTimer) return;
            card.renderTimer = this._scheduleTimeout(delayMs, () => {
                card.renderTimer = 0;
                if (!this._isChatVisible()) {
                    this._onMarkBackgroundDirty();
                    return;
                }
                executeFlushPass(false);
                this._onScrollBottom(false, false);
            });
        };

        if (this._isChatVisible()) {
            card.flushRender(true);
        } else {
            this._onMarkBackgroundDirty();
        }
        return card;
    }
}
