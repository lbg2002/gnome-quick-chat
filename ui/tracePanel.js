import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {
    applyQuestionKeyboardShortcut,
    computePermissionScope,
} from '../protocol.js';
import {
    UI_BUFFER_CAPS,
    computeToolDotVisualState,
    formatDisplayBufferWithCap,
    formatToolApprovalInspectorDetails,
    partitionToolDotsForLayout,
} from '../core/renderScheduler.js';

export const V = Clutter.Orientation.VERTICAL;
export const H = Clutter.Orientation.HORIZONTAL;

export function createStButton(label, callback, styleClass = 'button qc-button', tooltip = '') {
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

export function createWrapLabel(text, style = '') {
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

/**
 * Manages colored circle tool/thinking trace dots, per-node style diffing, horizontal `+N`
 * overflow folding, and lazy allocation of the detail/approval/AskUserQuestion drawer (Stage E).
 */
export class TracePanelController {
    constructor({
        copyWithFeedback,
        onSubmitToolDecision,
        onSubmitQuestionDecision,
    }) {
        this._copyWithFeedback = copyWithFeedback;
        this._onSubmitToolDecision = onSubmitToolDecision;
        this._onSubmitQuestionDecision = onSubmitQuestionDecision;
    }

    formatShortHint(text, maxLen = 34) {
        const clean = String(text || '').replace(/\s+/g, ' ').trim();
        if (!clean) return '';
        return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
    }

    hasPendingApprovalNodes(card) {
        return Boolean(
            card?.toolNodes?.some(
                n => n.status === 'pending_approval' || n.status === 'sending_approval'
            )
        );
    }

    ensureCardTraceHeader(card) {
        if (!card || card.role !== 'assistant' || card.traceBox || !card.box) {
            return card?.traceBox || null;
        }
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
            this.updateCardActivity(card);
        });
        thinkingDot.connect('notify::hover', () => {
            card.hoveredNodeId = thinkingDot.hover
                ? 'thinking'
                : (card.hoveredNodeId === 'thinking' ? null : card.hoveredNodeId);
            this.updateTraceHint(card);
        });
        dotsRow.add_child(thinkingDot);

        const toolDotsBox = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-tool-dots-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        dotsRow.add_child(toolDotsBox);

        const foldedDotsBtn = createStButton('+0', () => {
            card.dotsExpanded = !card.dotsExpanded;
            card.allToolDotsDirty = true;
            this.updateCardActivity(card);
        }, 'qc-dot-folded-pill', '展开或收起折叠的工具轨迹圆点');
        foldedDotsBtn.visible = false;
        dotsRow.add_child(foldedDotsBtn);

        const traceHintLabel = new St.Label({
            text: '',
            style_class: 'qc-trace-hint',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        dotsRow.add_child(traceHintLabel);
        traceBox.add_child(dotsRow);

        card.box.insert_child_at_index(traceBox, 1);

        card.traceBox = traceBox;
        card.dotsRow = dotsRow;
        card.thinkingDot = thinkingDot;
        card.toolDotsBox = toolDotsBox;
        card.foldedDotsBtn = foldedDotsBtn;
        card.traceHintLabel = traceHintLabel;
        return traceBox;
    }

    ensureCardDetailDrawer(card) {
        if (!card || card.role !== 'assistant' || card.detailDrawer) {
            return card?.detailDrawer || null;
        }
        const traceBox = this.ensureCardTraceHeader(card);
        if (!traceBox) return null;

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
        const drawerTitle = createWrapLabel('', 'qc-drawer-title');
        drawerTitle.x_expand = true;
        drawerHeader.add_child(drawerTitle);

        const drawerCopyBtn = createStButton('复制详情', () => {
            if (card.selectedNodeId === 'thinking') {
                this._copyWithFeedback(drawerCopyBtn, () => card.thinking || '', '复制详情');
                return;
            }
            const sel = (card.toolNodes || []).find(n => n.id === card.selectedNodeId);
            if (!sel) return;
            const fullDetail = [
                sel.fullCommand || sel.displayPath || sel.summary || sel.toolName,
                sel.detail || '',
            ].filter(Boolean).join('\n\n');
            this._copyWithFeedback(drawerCopyBtn, () => fullDetail, '复制详情');
        }, 'qc-drawer-close', '复制完整思考或工具详情');
        drawerHeader.add_child(drawerCopyBtn);

        const drawerCloseBtn = createStButton('收起', () => {
            card.selectedNodeId = null;
            this.updateCardActivity(card);
        }, 'qc-drawer-close', '收起详情');
        drawerHeader.add_child(drawerCloseBtn);
        detailDrawer.add_child(drawerHeader);

        const drawerSummary = createWrapLabel('', 'qc-approval-summary');
        drawerSummary.visible = false;
        detailDrawer.add_child(drawerSummary);

        const drawerExpandBtn = createStButton('▼ 展开完整内容', () => {
            if (card.selectedNodeId === 'thinking') {
                card.thinkingExpanded = !card.thinkingExpanded;
                this.updateCardActivity(card);
                return;
            }
            const sel = (card.toolNodes || []).find(n => n.id === card.selectedNodeId);
            if (sel) {
                sel.detailsExpanded = !sel.detailsExpanded;
                this.updateCardActivity(card);
            }
        }, 'qc-drawer-close', '展开或收起完整长文本');
        drawerExpandBtn.visible = false;
        detailDrawer.add_child(drawerExpandBtn);

        const questionFormBox = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-question-form',
            x_expand: true,
            visible: false,
        });
        detailDrawer.add_child(questionFormBox);

        const drawerBody = createWrapLabel('', 'qc-drawer-body');
        drawerBody.visible = false;
        detailDrawer.add_child(drawerBody);

        const drawerActions = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-approval-actions',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        const allowBtn = createStButton(
            '✓ 仅本次允许',
            () => this._onSubmitToolDecision(card, 'allow', false),
            'qc-approval-btn qc-approval-allow',
            '仅允许本次工具调用，不记住范围'
        );
        const alwaysBtn = createStButton(
            '✓ 范围允许',
            () => this._onSubmitToolDecision(card, 'allow', true),
            'qc-approval-btn qc-approval-always',
            '在当前会话内对明确绑定的安全范围授权'
        );
        const denyBtn = createStButton(
            '✕ 拒绝',
            () => this._onSubmitToolDecision(card, 'deny', false),
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
        const submitAnswerBtn = createStButton(
            '✓ 提交回答',
            () => this._onSubmitQuestionDecision(card, 'answer'),
            'qc-approval-btn qc-approval-allow',
            '提交所选回答并继续'
        );
        const skipAnswerBtn = createStButton(
            '⏭ 交由 AI 判断',
            () => this._onSubmitQuestionDecision(card, 'skip'),
            'qc-approval-btn qc-approval-always',
            '不指定偏好，交由 AI 自行判断'
        );
        const cancelQuestionBtn = createStButton(
            '✕ 取消',
            () => this._onSubmitQuestionDecision(card, 'deny'),
            'qc-approval-btn qc-approval-deny',
            '取消本次提问'
        );
        questionActions.add_child(submitAnswerBtn);
        questionActions.add_child(skipAnswerBtn);
        questionActions.add_child(cancelQuestionBtn);
        detailDrawer.add_child(questionActions);

        traceBox.add_child(detailDrawer);

        card.detailDrawer = detailDrawer;
        card.drawerTitle = drawerTitle;
        card.drawerCopyBtn = drawerCopyBtn;
        card.drawerSummary = drawerSummary;
        card.drawerExpandBtn = drawerExpandBtn;
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
        return detailDrawer;
    }

    _syncToolNodeDotStyle(card, node) {
        const btn = node?.dotBtn;
        if (!btn) return;
        const vis = computeToolDotVisualState(node, card.selectedNodeId);
        if (node._lastStyleKey === vis.styleKey) return;
        node._lastStyleKey = vis.styleKey;
        for (const cls of [
            'qc-dot-tool-ok',
            'qc-dot-tool-pending',
            'qc-dot-tool-running',
            'qc-dot-tool-error',
            'qc-dot-tool-interrupted',
            'qc-dot-selected',
        ]) {
            btn.remove_style_class_name(cls);
        }
        btn.add_style_class_name(vis.colorClass);
        if (vis.isSelected) {
            btn.add_style_class_name('qc-dot-selected');
        }
    }

    updateTraceHint(card) {
        if (!card?.traceHintLabel) return;
        const hasThinking = Boolean(card.thinking && card.thinking.trim());
        const tools = card.toolNodes || [];

        const targetId = card.hoveredNodeId || card.selectedNodeId;
        if (targetId === 'thinking') {
            const next = card.selectedNodeId === 'thinking'
                ? '思考过程（点击灰圆收起）'
                : '思考过程（点击展开）';
            if (card.traceHintLabel.text !== next) card.traceHintLabel.text = next;
            return;
        }
        if (targetId) {
            const node = tools.find(n => n.id === targetId);
            if (node) {
                const brief = this.formatShortHint(node.summary, 28);
                const next = node.isQuestion
                    ? (brief ? `问答: ${brief}` : '交互式提问（点击小圆查看）')
                    : (brief ? `${node.toolName}: ${brief}` : `${node.toolName}（点击小圆切换详情）`);
                if (card.traceHintLabel.text !== next) card.traceHintLabel.text = next;
                return;
            }
        }

        const pendingNode = tools.find(n => n.status === 'pending_approval' || n.status === 'sending_approval');
        if (pendingNode) {
            let next = '';
            if (pendingNode.isQuestion) {
                const brief = this.formatShortHint(pendingNode.summary, 24);
                next = pendingNode.status === 'sending_approval'
                    ? '⏳ 正在提交回答…'
                    : (brief ? `💬 待回答: ${brief}` : '💬 待您回答问题');
            } else {
                next = pendingNode.status === 'sending_approval'
                    ? `⏳ 正在发送授权: ${pendingNode.toolName}`
                    : `⚠️ 待审批: ${pendingNode.toolName}`;
            }
            if (card.traceHintLabel.text !== next) card.traceHintLabel.text = next;
            return;
        }
        const runningNode = tools.find(n => n.status === 'running');
        if (runningNode) {
            const next = runningNode.isQuestion
                ? '正在提交回答并继续…'
                : `正在执行 ${runningNode.toolName}…`;
            if (card.traceHintLabel.text !== next) card.traceHintLabel.text = next;
            return;
        }

        const segs = [];
        if (hasThinking) segs.push('思考');
        if (tools.length > 0) segs.push(`${tools.length} 项工具`);
        const next = segs.length ? `${segs.join(' · ')}（点击小圆查看）` : '';
        if (card.traceHintLabel.text !== next) card.traceHintLabel.text = next;
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

    syncQuestionFormState(card, node) {
        if (!card || !node) return;
        const interactive = node.status === 'pending_approval';
        for (const w of card.renderedQuestionWidgets || []) {
            const draft = node.questionDrafts?.[w.question] || {selectedLabels: [], customText: ''};
            w.optionRefs.forEach((oRef, idx) => {
                const selected = draft.selectedLabels.includes(oRef.label);
                oRef.indLbl.text = w.multiSelect ? (selected ? '☑' : '☐') : (selected ? '●' : '○');
                if (selected) oRef.btn.add_style_class_name('qc-question-opt-selected');
                else oRef.btn.remove_style_class_name('qc-question-opt-selected');
                oRef.btn.reactive = interactive;
                oRef.btn.accessible_name = `选项 ${idx + 1}（${selected ? '已选' : '未选'}）：${oRef.label}`;
            });
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
        if (!node.questionDrafts) node.questionDrafts = Object.create(null);

        if (card.renderedQuestionNodeId === node.id && Array.isArray(card.renderedQuestionWidgets)) {
            this.syncQuestionFormState(card, node);
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
                text: `${q.multiSelect ? '可多选' : '单选'} · 数字键 1-9 / ↑↓ / Space 选择`,
                style_class: 'qc-question-mode',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            itemBox.add_child(metaRow);
            itemBox.add_child(createWrapLabel(q.question, 'qc-question-prompt'));

            const optsBox = new St.BoxLayout({
                orientation: V,
                style_class: 'qc-question-options',
                x_expand: true,
            });
            const optionRefs = [];
            (q.options || []).forEach((opt, optIdx) => {
                const shortcutPrefix = optIdx < 9 ? `${optIdx + 1}. ` : '';
                const optBtn = new St.Button({
                    style_class: 'qc-question-opt',
                    x_expand: true,
                    can_focus: true,
                    reactive: true,
                    track_hover: true,
                    accessible_name: `选项 ${optIdx + 1}：${opt.label}`,
                });
                const optRow = new St.BoxLayout({
                    orientation: H,
                    style_class: 'qc-question-opt-row',
                    x_expand: true,
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
                txtCol.add_child(createWrapLabel(`${shortcutPrefix}${opt.label}`, 'qc-question-opt-label'));
                if (opt.description) {
                    txtCol.add_child(createWrapLabel(opt.description, 'qc-question-opt-desc'));
                }
                optRow.add_child(indLbl);
                optRow.add_child(txtCol);
                optBtn.set_child(optRow);

                optBtn.connect('clicked', () => {
                    if (node.status !== 'pending_approval') return;
                    node.validationHint = '';
                    const res = applyQuestionKeyboardShortcut(draft, q, 'Space', {focusedOptionIndex: optIdx});
                    if (res.handled) {
                        draft.selectedLabels = res.draft.selectedLabels;
                        this.syncQuestionFormState(card, node);
                    }
                });

                optBtn.connect('key-press-event', (_, event) => {
                    if (node.status !== 'pending_approval') return Clutter.EVENT_PROPAGATE;
                    const sym = event.get_key_symbol();
                    let keyName = '';
                    if (sym >= Clutter.KEY_1 && sym <= Clutter.KEY_9) {
                        keyName = String(sym - Clutter.KEY_1 + 1);
                    } else if (sym === Clutter.KEY_Up || sym === Clutter.KEY_KP_Up) {
                        keyName = 'Up';
                    } else if (sym === Clutter.KEY_Down || sym === Clutter.KEY_KP_Down) {
                        keyName = 'Down';
                    } else if (sym === Clutter.KEY_space) {
                        keyName = 'Space';
                    } else if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                        keyName = 'Return';
                    } else if (sym === Clutter.KEY_Escape) {
                        keyName = 'Escape';
                    }
                    if (!keyName) return Clutter.EVENT_PROPAGATE;

                    const res = applyQuestionKeyboardShortcut(draft, q, keyName, {focusedOptionIndex: optIdx});
                    if (!res.handled) return Clutter.EVENT_PROPAGATE;

                    node.validationHint = '';
                    if (res.action === 'toggled') {
                        draft.selectedLabels = res.draft.selectedLabels;
                        this.syncQuestionFormState(card, node);
                        if (res.nextFocusIndex >= 0 && optionRefs[res.nextFocusIndex]?.btn) {
                            optionRefs[res.nextFocusIndex].btn.grab_key_focus?.();
                        }
                        return Clutter.EVENT_STOP;
                    }
                    if (res.action === 'focus_option') {
                        if (res.nextFocusIndex >= 0 && optionRefs[res.nextFocusIndex]?.btn) {
                            optionRefs[res.nextFocusIndex].btn.grab_key_focus?.();
                        }
                        return Clutter.EVENT_STOP;
                    }
                    if (res.action === 'cancel') {
                        this._onSubmitQuestionDecision(card, 'deny');
                        return Clutter.EVENT_STOP;
                    }
                    return Clutter.EVENT_PROPAGATE;
                });

                optsBox.add_child(optBtn);
                optionRefs.push({label: opt.label, btn: optBtn, indLbl});
            });
            if (optionRefs.length > 0) {
                itemBox.add_child(optsBox);
            }

            const customEntry = new St.Entry({
                style_class: 'qc-question-entry',
                hint_text: '或直接在此输入自定义回答（回车提交）…',
                can_focus: true,
                x_expand: true,
                accessible_name: `自定义回答输入：${q.question}`,
            });
            if (draft.customText) customEntry.set_text(draft.customText);
            const ct = customEntry.clutter_text;
            ct.connect('text-changed', () => {
                draft.customText = customEntry.get_text();
                if (node.validationHint && draft.customText.trim()) {
                    node.validationHint = '';
                }
                this.syncQuestionFormState(card, node);
            });
            ct.connect('activate', () => {
                if (node.status === 'pending_approval') {
                    this._onSubmitQuestionDecision(card, 'answer');
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

        this.syncQuestionFormState(card, node);
    }

    updateCardActivity(card) {
        if (!card || card.role !== 'assistant') return;
        const hasThinking = Boolean(card.thinking && card.thinking.trim());
        const tools = card.toolNodes || [];
        if (!hasThinking && tools.length === 0) {
            if (card.traceBox) card.traceBox.visible = false;
            return;
        }

        this.ensureCardTraceHeader(card);
        if (!card.traceBox) return;
        card.traceBox.visible = true;

        if (card.thinkingDot) {
            const thinkingSel = card.selectedNodeId === 'thinking';
            const thinkingKey = `${hasThinking ? '1' : '0'}|${thinkingSel ? 'sel' : 'nosel'}`;
            if (card._lastThinkingDotKey !== thinkingKey) {
                card._lastThinkingDotKey = thinkingKey;
                card.thinkingDot.visible = hasThinking;
                if (thinkingSel) card.thinkingDot.add_style_class_name('qc-dot-selected');
                else card.thinkingDot.remove_style_class_name('qc-dot-selected');
            }
        }

        const selectionChanged = card._lastSelectedNodeId !== card.selectedNodeId;
        if (selectionChanged && card._lastSelectedNodeId && card._lastSelectedNodeId !== 'thinking') {
            card.dirtyToolNodeIds.add(card._lastSelectedNodeId);
        }
        if (selectionChanged && card.selectedNodeId && card.selectedNodeId !== 'thinking') {
            card.dirtyToolNodeIds.add(card.selectedNodeId);
        }
        card._lastSelectedNodeId = card.selectedNodeId;

        const foldLayout = partitionToolDotsForLayout(tools, {
            expanded: Boolean(card.dotsExpanded),
            selectedNodeId: card.selectedNodeId,
        });
        const needFullDotSweep = Boolean(
            card.allToolDotsDirty ||
            card._lastFoldCount !== foldLayout.foldedCount ||
            card._lastIsFolded !== foldLayout.isFolded
        );
        card._lastFoldCount = foldLayout.foldedCount;
        card._lastIsFolded = foldLayout.isFolded;

        if (card.foldedDotsBtn) {
            if (foldLayout.isFolded) {
                const foldLbl = `+${foldLayout.foldedCount}`;
                if (card.foldedDotsBtn.label !== foldLbl) card.foldedDotsBtn.label = foldLbl;
                card.foldedDotsBtn.visible = true;
            } else if (card.dotsExpanded && tools.length > 10) {
                if (card.foldedDotsBtn.label !== '收起') card.foldedDotsBtn.label = '收起';
                card.foldedDotsBtn.visible = true;
            } else {
                card.foldedDotsBtn.visible = false;
            }
        }

        if (needFullDotSweep) {
            for (const node of tools) {
                if (node.dotBtn) {
                    const shouldShow = foldLayout.visibleIds.has(node.id);
                    if (node.dotBtn.visible !== shouldShow) node.dotBtn.visible = shouldShow;
                }
                this._syncToolNodeDotStyle(card, node);
            }
        } else if (card.dirtyToolNodeIds.size > 0) {
            for (const node of tools) {
                if (card.dirtyToolNodeIds.has(node.id)) {
                    if (node.dotBtn) {
                        const shouldShow = foldLayout.visibleIds.has(node.id);
                        if (node.dotBtn.visible !== shouldShow) node.dotBtn.visible = shouldShow;
                    }
                    this._syncToolNodeDotStyle(card, node);
                }
            }
        }
        card.dirtyToolNodeIds.clear();
        card.allToolDotsDirty = false;

        this.updateTraceHint(card);

        const selId = card.selectedNodeId;
        if (!selId) {
            if (card.detailDrawer) {
                this._hideQuestionForm(card);
                card.detailDrawer.visible = false;
            }
            return;
        }

        this.ensureCardDetailDrawer(card);
        if (!card.detailDrawer) return;

        if (selId === 'thinking') {
            this._hideQuestionForm(card);
            if (!hasThinking) {
                if (card.drawerExpandBtn) card.drawerExpandBtn.visible = false;
                card.detailDrawer.visible = false;
                return;
            }
            card.detailDrawer.visible = true;
            card.detailDrawer.remove_style_class_name('qc-drawer-pending');
            card.drawerTitle.text = '💭 思考过程';
            card.drawerSummary.visible = false;
            const cappedThinking = formatDisplayBufferWithCap(card.thinking.trim(), {
                maxDisplayBytes: UI_BUFFER_CAPS.maxThinkingDisplayBytes,
                expanded: Boolean(card.thinkingExpanded),
            });
            card.drawerBody.text = cappedThinking.displayText;
            card.drawerBody.visible = true;
            if (card.drawerExpandBtn) {
                const showExpand = cappedThinking.isTruncatedForUi || Boolean(card.thinkingExpanded);
                card.drawerExpandBtn.visible = showExpand;
                if (showExpand) {
                    card.drawerExpandBtn.label = card.thinkingExpanded ? '▲ 收起长思考' : '▼ 展开完整思考';
                }
            }
            card.drawerActions.visible = false;
            return;
        }

        const node = tools.find(n => n.id === selId);
        if (!node) {
            this._hideQuestionForm(card);
            if (card.drawerExpandBtn) card.drawerExpandBtn.visible = false;
            card.detailDrawer.visible = false;
            return;
        }

        card.detailDrawer.visible = true;
        const isAwaiting = node.status === 'pending_approval' || node.status === 'sending_approval';
        if (isAwaiting) card.detailDrawer.add_style_class_name('qc-drawer-pending');
        else card.detailDrawer.remove_style_class_name('qc-drawer-pending');

        const durSuffix = node.duration > 0 ? ` (${(node.duration / 1000).toFixed(1)}s)` : '';

        if (node.isQuestion && Array.isArray(node.questions) && node.questions.length > 0) {
            if (card.drawerExpandBtn) card.drawerExpandBtn.visible = false;
            let qTitle = '💬 交互式提问';
            if (node.status === 'sending_approval') {
                qTitle = node.approvalPhase === 'awaiting_ack'
                    ? '⏳ 已发送回答，等待桥接确认…'
                    : '⏳ 正在提交您的回答…';
            } else if (node.status === 'pending_approval') {
                qTitle = node.questions.length > 1
                    ? `💬 请回答以下问题（共 ${node.questions.length} 项）`
                    : '💬 请选择或输入您的回答';
            } else if (node.status === 'running') qTitle = '⏳ 已收到回答，AI 正在继续处理…';
            else if (node.status === 'interrupted') qTitle = '⏹ 提问已中断（未确认完成）';
            else if (node.status === 'unknown') qTitle = '❓ 提问状态未知（未收到完成事件）';
            else if (node.status === 'denied') qTitle = '✕ 已取消本次提问';
            else if (node.status === 'error') qTitle = `⚠️ 提问处理异常${durSuffix}`;
            else if (node.approvalState === 'skipped') qTitle = `⏭ 已交由 AI 自行判断${durSuffix}`;
            else qTitle = `✓ 已回答问题${durSuffix}`;
            card.drawerTitle.text = qTitle;

            if (isAwaiting) {
                card.drawerSummary.visible = false;
                card.drawerActions.visible = false;
                card.questionFormBox.visible = true;
                card.questionActions.visible = true;
                card.skipAnswerBtn.visible = node.allowSkip !== false;
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
            if (node.userAnswerSummary) doneLines.push(node.userAnswerSummary);
            if (node.status === 'error' && node.detail) doneLines.push(`⚠️ ${node.detail}`);
            if (doneLines.length > 0) {
                card.drawerBody.text = doneLines.join('\n');
                card.drawerBody.visible = true;
            } else {
                card.drawerBody.visible = false;
            }
            return;
        }

        this._hideQuestionForm(card);
        const riskBadge = node.riskLabel ? ` · ${node.riskLabel}` : '';
        let statusTitle = `🔧 ${node.toolName}`;
        if (node.status === 'sending_approval') {
            statusTitle = node.approvalPhase === 'awaiting_ack'
                ? `⏳ 已发送授权，等待桥接确认：${node.toolName}…`
                : `⏳ 正在发送授权：${node.toolName}…`;
        } else if (node.status === 'pending_approval') statusTitle = `🛡️ 请求授权：${node.operationLabel || node.toolName}${riskBadge}`;
        else if (node.status === 'running') {
            statusTitle = node.approvalState
                ? `⏳ 已授权，正在执行：${node.toolName}`
                : `⏳ 正在执行：${node.toolName}`;
        } else if (node.status === 'interrupted') statusTitle = `⏹ 已中断（未确认完成）：${node.toolName}`;
        else if (node.status === 'unknown') statusTitle = `❓ 状态未知（未确认结果）：${node.toolName}`;
        else if (node.status === 'denied') statusTitle = `✕ 已拒绝调用：${node.toolName}`;
        else if (node.status === 'error') statusTitle = `⚠️ 执行异常：${node.toolName}${durSuffix}`;
        else if (node.approvalState === 'always') statusTitle = `✓ 已按范围授权完成：${node.toolName}${durSuffix}`;
        else if (node.approvalState === 'allowed') statusTitle = `✓ 仅本次允许并完成：${node.toolName}${durSuffix}`;
        else statusTitle = `✓ 已执行工具：${node.toolName}${durSuffix}`;
        card.drawerTitle.text = statusTitle;

        const inspector = formatToolApprovalInspectorDetails(node, {
            expanded: Boolean(node.detailsExpanded),
        });
        card.drawerSummary.text = inspector.summaryText;
        card.drawerSummary.visible = inspector.summaryVisible;
        card.drawerBody.text = inspector.bodyText;
        card.drawerBody.visible = inspector.bodyVisible;

        if (card.drawerExpandBtn) {
            card.drawerExpandBtn.visible = inspector.showExpandBtn;
            if (inspector.showExpandBtn) {
                card.drawerExpandBtn.label = node.detailsExpanded ? '▲ 收起长文本' : '▼ 展开完整内容';
            }
        }

        card.drawerActions.visible = isAwaiting;
        if (isAwaiting) {
            const buttonsInteractive = node.status === 'pending_approval';
            card.allowBtn.reactive = buttonsInteractive;
            card.allowBtn.label = '✓ 仅本次允许';
            card.denyBtn.reactive = buttonsInteractive;
            if (!node.allowSessionRule || !node.scopeKey) {
                card.alwaysBtn.visible = false;
            } else {
                card.alwaysBtn.visible = true;
                card.alwaysBtn.reactive = buttonsInteractive;
                card.alwaysBtn.label = node.sessionRuleLabel
                    ? `✓ 范围允许（${node.sessionRuleLabel.replace(/^✓\s*/, '')}）`
                    : '✓ 范围允许（当前会话）';
            }
        }
    }

    findOrCreateToolNode(card, info = {}) {
        if (!card?.toolNodes) return null;
        const {
            requestId = '',
            toolCallId = '',
            toolName = '',
            matchPendingWithoutToolCallId = false,
        } = info;
        let node = null;

        if (requestId) {
            node = card.toolNodes.find(n => n.requestId && n.requestId === requestId);
        }
        if (!node && toolCallId) {
            node = card.toolNodes.find(n => n.toolCallId && n.toolCallId === toolCallId);
        }
        if (!node && matchPendingWithoutToolCallId && toolName && toolName !== '工具') {
            for (let i = card.toolNodes.length - 1; i >= 0; i--) {
                const cand = card.toolNodes[i];
                if (
                    cand.toolName === toolName &&
                    (cand.status === 'pending_approval' || cand.status === 'sending_approval') &&
                    !cand.toolCallId
                ) {
                    node = cand;
                    break;
                }
            }
        }

        if (!node) {
            this.ensureCardTraceHeader(card);
            const index = card.toolNodes.length + 1;
            const id = `tool_${index}_${Date.now()}`;
            const defaultScope = computePermissionScope(toolName || '工具', info.summary || '');
            node = {
                id,
                index,
                requestId: requestId || '',
                toolCallId: toolCallId || '',
                toolName: toolName || '工具',
                operationLabel: String(info.operationLabel || defaultScope.operationLabel || ''),
                riskLevel: String(info.riskLevel || defaultScope.riskLevel || 'medium'),
                riskLabel: String(info.riskLabel || defaultScope.riskLabel || ''),
                riskWarnings: Array.isArray(info.riskWarnings)
                    ? [...info.riskWarnings]
                    : [...(defaultScope.riskWarnings || [])],
                fullCommand: String(info.fullCommand || defaultScope.fullCommand || ''),
                cwd: String(info.cwd || defaultScope.cwd || ''),
                realCwd: String(info.realCwd || defaultScope.realCwd || ''),
                displayPath: String(info.displayPath || defaultScope.displayPath || ''),
                realPath: String(info.realPath || defaultScope.realPath || ''),
                networkOrigin: String(info.networkOrigin || defaultScope.networkOrigin || ''),
                targetMismatch: Boolean(info.targetMismatch || defaultScope.targetMismatch),
                symlinkEscape: Boolean(info.symlinkEscape || defaultScope.symlinkEscape),
                detailsExpanded: false,
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
                _lastStyleKey: '',
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
                    this.updateCardActivity(card);
                });
                dotBtn.connect('notify::hover', () => {
                    card.hoveredNodeId = dotBtn.hover
                        ? node.id
                        : (card.hoveredNodeId === node.id ? null : card.hoveredNodeId);
                    this.updateTraceHint(card);
                });
                node.dotBtn = dotBtn;
                node._lastStyleKey = 'qc-dot-tool-running|nosel';
                card.toolDotsBox.add_child(dotBtn);
            }

            card.toolNodes.push(node);
            if (card.toolNodes.length > 10) {
                card.allToolDotsDirty = true;
            }
        } else {
            if (requestId && !node.requestId) node.requestId = requestId;
            if (toolCallId && !node.toolCallId) node.toolCallId = toolCallId;
            if (toolName && toolName !== '工具' && (!node.toolName || node.toolName === '工具')) {
                node.toolName = toolName;
            }
        }

        if (info.operationLabel) node.operationLabel = String(info.operationLabel);
        if (info.riskLevel) node.riskLevel = String(info.riskLevel);
        if (info.riskLabel) node.riskLabel = String(info.riskLabel);
        if (Array.isArray(info.riskWarnings) && info.riskWarnings.length > 0) {
            node.riskWarnings = [...info.riskWarnings];
        }
        if (info.fullCommand) node.fullCommand = String(info.fullCommand);
        if (info.cwd) node.cwd = String(info.cwd);
        if (info.realCwd) node.realCwd = String(info.realCwd);
        if (info.displayPath) node.displayPath = String(info.displayPath);
        if (info.realPath) node.realPath = String(info.realPath);
        if (info.networkOrigin) node.networkOrigin = String(info.networkOrigin);
        if (info.targetMismatch) node.targetMismatch = true;
        if (info.symlinkEscape) node.symlinkEscape = true;

        if (info.isQuestion) {
            node.isQuestion = true;
            node.allowSessionRule = false;
            node.scopeKey = '';
            node.sessionRuleLabel = '';
            if (Array.isArray(info.questions) && info.questions.length > 0) node.questions = info.questions;
            if (info.rawInput && typeof info.rawInput === 'object') node.rawInput = info.rawInput;
            if (info.summary) node.summary = info.summary;
        } else if (info.summary && !node.summary) {
            node.summary = info.summary;
        }
        if (info.reason && !node.reason) node.reason = info.reason;
        if (info.detail) node.detail = info.detail;
        if (!node.isQuestion && typeof info.scopeKey === 'string') node.scopeKey = info.scopeKey;
        if (!node.isQuestion && typeof info.allowSessionRule === 'boolean') node.allowSessionRule = info.allowSessionRule;
        if (!node.isQuestion && typeof info.sessionRuleLabel === 'string') node.sessionRuleLabel = info.sessionRuleLabel;
        if (typeof info.duration === 'number' && info.duration > 0) node.duration = info.duration;

        card.dirtyToolNodeIds?.add(node.id);
        return node;
    }
}
