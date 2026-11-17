/**
 * Pure-JS Unified Render Scheduler, Tool Dot Differ/Folder, UI Buffer Capper,
 * and Windowed History Actor Controller (Stage D2 & D3, zero GJS dependencies).
 */
import {formatAskUserAnswerSummary, isSideEffectingToolExecution} from '../protocol.js';
import {extractUserQuestionAndAttachmentsFromPrompt} from './attachmentManager.js';

const UTF8_ENCODER = new TextEncoder();

export const DEFAULT_INITIAL_HISTORY_COUNT = 24;
export const DEFAULT_HISTORY_PAGE_SIZE = 24;
export const DEFAULT_MAX_MOUNTED_ACTORS = 48;
export const DEFAULT_MAX_VISIBLE_TOOL_DOTS = 10;
export const DEFAULT_HOT_DATA_CACHE_LIMIT = 120;
export const DEFAULT_MAX_INDEXED_MESSAGES = 1200;

export const UI_BUFFER_CAPS = Object.freeze({
    maxThinkingDisplayBytes: 24 * 1024, // 24 KiB in thinking drawer unless expanded
    maxToolDetailDisplayBytes: 16 * 1024, // 16 KiB in tool drawer unless expanded
    maxCardStreamingBytes: 96 * 1024, // 96 KiB in live card body during streaming unless expanded
    maxInMemoryFieldChars: 512 * 1024, // 512K chars safety ceiling against runaway infinite output
    maxSingleMessageDataBytes: 128 * 1024, // 128 KiB per message record in HistoryWindowController data layer
    maxHistoryDataBytes: 2 * 1024 * 1024, // 2 MiB cumulative data-layer budget for HistoryWindowController.allMessages
});

const UTF8_DECODER = new TextDecoder('utf-8', {fatal: false});

function estimateMessageDataBytes(msg) {
    if (!msg || typeof msg !== 'object') return 0;
    let total = 64;
    if (typeof msg.text === 'string' && msg.text) {
        total += UTF8_ENCODER.encode(msg.text).byteLength;
    }
    if (typeof msg.displayText === 'string' && msg.displayText && msg.displayText !== msg.text) {
        total += UTF8_ENCODER.encode(msg.displayText).byteLength;
    }
    if (typeof msg.thinking === 'string' && msg.thinking) {
        total += UTF8_ENCODER.encode(msg.thinking).byteLength;
    }
    return total;
}

function capMessageRecordBytes(msg, maxFieldBytes) {
    if (!msg || typeof msg !== 'object') return msg;
    let cloned = null;
    for (const key of ['text', 'displayText', 'thinking']) {
        if (typeof msg[key] === 'string' && msg[key].length > 0) {
            const encoded = UTF8_ENCODER.encode(msg[key]);
            if (encoded.byteLength > maxFieldBytes) {
                if (!cloned) cloned = {...msg};
                const suffix = '\n… [历史数据层已按内存上限截断]';
                const suffixBytes = UTF8_ENCODER.encode(suffix);
                let endIdx = Math.max(0, Math.min(encoded.byteLength, maxFieldBytes - suffixBytes.byteLength));
                while (endIdx > 0 && (encoded[endIdx] & 0xc0) === 0x80) {
                    endIdx--;
                }
                cloned[key] = `${UTF8_DECODER.decode(encoded.subarray(0, endIdx))}${suffix}`;
                cloned.dataBudgetTruncated = true;
            }
        }
    }
    return cloned || msg;
}

function demoteMessageToIndexEntry(msg, compactPreviewBytes = 1024) {
    if (!msg || typeof msg !== 'object') return msg;
    if (msg.isPagedIndexEntry && !msg.thinking) {
        return capMessageRecordBytes(msg, compactPreviewBytes);
    }
    const capped = capMessageRecordBytes(
        {
            id: String(msg.id || ''),
            ...(msg.revision ? {revision: Number(msg.revision)} : {}),
            ...(msg.turnId ? {turnId: String(msg.turnId)} : {}),
            ...(msg.replyTo ? {replyTo: String(msg.replyTo)} : {}),
            role: msg.role || 'assistant',
            text: String(msg.text || ''),
            ...(msg.displayText && msg.displayText !== msg.text ? {displayText: String(msg.displayText)} : {}),
            thinking: '',
            createdAt: String(msg.createdAt || ''),
            ts: Number(msg.ts || 0),
            backend: String(msg.backend || ''),
            modelId: String(msg.modelId || ''),
            status: String(msg.status || 'completed'),
            ...(msg.partial ? {partial: true} : {}),
            ...(msg.finishReason ? {finishReason: String(msg.finishReason)} : {}),
            ...(msg.errorMessage ? {errorMessage: String(msg.errorMessage)} : {}),
            compactedInDataLayer: true,
            isPagedIndexEntry: true,
        },
        compactPreviewBytes
    );
    capped.compactedInDataLayer = true;
    capped.isPagedIndexEntry = true;
    return capped;
}

/**
 * Releases all Actor, trace node, renderState, closure, and timer references on an evicted or destroyed card (Stage R8).
 */
export function releaseCardRuntimeReferences(card, {clearTimer = null} = {}) {
    if (!card || typeof card !== 'object') return;
    if (card.renderTimer) {
        if (typeof clearTimer === 'function') {
            try { clearTimer(card.renderTimer); } catch (_) {}
        }
        card.renderTimer = 0;
    }
    if (card.copyBtn?._copyResetTimer) {
        if (typeof clearTimer === 'function') {
            try { clearTimer(card.copyBtn._copyResetTimer); } catch (_) {}
        }
        card.copyBtn._copyResetTimer = 0;
    }
    if (card.drawerCopyBtn?._copyResetTimer) {
        if (typeof clearTimer === 'function') {
            try { clearTimer(card.drawerCopyBtn._copyResetTimer); } catch (_) {}
        }
        card.drawerCopyBtn._copyResetTimer = 0;
    }
    if (Array.isArray(card.toolNodes)) {
        for (const node of card.toolNodes) {
            if (!node || typeof node !== 'object') continue;
            node.dot = null;
            node.questionOptionButtons = null;
            node.customAnswerEntry = null;
            node.input = null;
        }
        card.toolNodes = [];
    }
    try { card.dirtyToolNodeIds?.clear?.(); } catch (_) {}
    if (card.box) {
        try { card.box.remove_all_transitions?.(); } catch (_) {}
        try { card.box.destroy?.(); } catch (_) {}
        card.box = null;
    }
    card.renderState = null;
    card.traceBox = null;
    card.dotsFlow = null;
    card.detailDrawer = null;
    card.bodyBox = null;
    card.roleLabel = null;
    card.copyBtn = null;
    card.continueBtn = null;
    card.drawerCopyBtn = null;
    card.flushRender = null;
    card.scheduleRender = null;
    card.syncContinueVisibility = null;
    card.released = true;
}

const BACKEND_FALLBACK_LABELS = Object.freeze({
    zcode: 'ZCode',
    codex: 'Codex',
    openai: 'OpenAI API',
});

/**
 * Computes adaptive render batching delay (ms):
 * - Immediate (`0ms`) for the very first visible token or urgent approval/terminal states.
 * - `60ms` (50–100ms target) for normal short/medium streaming.
 * - `95ms–165ms` (100–200ms target) when text is long or main-thread render duration rises.
 */
export function computeAdaptiveRenderDelayMs({
    isFirstVisibleRender = false,
    urgentImmediate = false,
    textLength = 0,
    lastRenderDurationMs = 0,
} = {}) {
    if (urgentImmediate || isFirstVisibleRender) {
        return 0;
    }
    if (lastRenderDurationMs >= 14 || textLength > 12000) {
        return 165;
    }
    if (lastRenderDurationMs >= 9 || textLength > 6000) {
        return 130;
    }
    if (lastRenderDurationMs >= 5 || textLength > 2000) {
        return 90;
    }
    return 60;
}

/**
 * Computes canonical CSS class set & signature for a single tool dot so callers only touch St.Widget
 * style classes when `styleKey` actually changed.
 */
export function computeToolDotVisualState(node, selectedNodeId = null) {
    let colorClass = 'qc-dot-tool-ok';
    const status = node?.status || 'done';
    if (status === 'pending_approval' || status === 'sending_approval') {
        colorClass = 'qc-dot-tool-pending';
    } else if (status === 'denied' || status === 'error') {
        colorClass = 'qc-dot-tool-error';
    } else if (status === 'interrupted' || status === 'unknown' || status === 'cancelled') {
        colorClass = 'qc-dot-tool-interrupted';
    } else if (status === 'running') {
        colorClass = 'qc-dot-tool-running';
    }
    const isSelected = Boolean(node?.id && selectedNodeId === node.id);
    const styleKey = `${colorClass}|${isSelected ? 'sel' : 'nosel'}`;
    return {
        colorClass,
        isSelected,
        styleKey,
    };
}

/**
 * Deterministic card-level tool trace state transition engine (R7).
 * Handles:
 *  - Idempotent `tool_execution_start` / `tool_execution_update`
 *  - Concurrent same-name tools (strict ID matching, never guessing by `toolName` on end)
 *  - `tool_execution_end` arriving before `permission_resolved` ACK (result-before-ACK)
 *  - Duplicate `tool_execution_end` events
 *  - `tool_execution_end` without a prior `tool_execution_start`
 *  - Cross-batch `tool_batch_end` (only updates explicit `toolCallIds`; missing IDs never mark all tools done;
 *    unconfirmed batch endings mark still-running tools in that batch as `'unknown'`)
 *  - Turn cancellation / settlement in intermediate states (`'interrupted'` / `'unknown'` / `'denied'`)
 */
export function applyToolTraceEventToCard(card, event, {
    findOrCreateNode = null,
    activeTurn = null,
} = {}) {
    if (!card || !Array.isArray(card.toolNodes) || !event || typeof event !== 'object') {
        return {node: null, nextPending: null, stillWaiting: false};
    }

    const markDirty = node => {
        if (node?.id) {
            card.dirtyToolNodeIds?.add(node.id);
        }
    };
    const syncCardActiveTool = () => {
        card.activeTool = card.toolNodes.some(
            n => n.status === 'running' || n.status === 'pending_approval' || n.status === 'sending_approval'
        );
        if (card.dirty && typeof card.dirty === 'object') {
            card.dirty.tools = true;
        }
    };
    const findNextPending = () => card.toolNodes.find(
        n => n.status === 'pending_approval' || n.status === 'sending_approval'
    ) || null;

    const defaultCreateNode = (targetCard, info = {}) => {
        const index = targetCard.toolNodes.length + 1;
        const node = {
            id: `tool_${index}_${Date.now()}`,
            index,
            requestId: String(info.requestId || ''),
            toolCallId: String(info.toolCallId || ''),
            toolName: String(info.toolName || '工具'),
            operationLabel: String(info.operationLabel || ''),
            riskLevel: String(info.riskLevel || 'medium'),
            riskLabel: String(info.riskLabel || ''),
            riskWarnings: Array.isArray(info.riskWarnings) ? [...info.riskWarnings] : [],
            fullCommand: String(info.fullCommand || ''),
            cwd: String(info.cwd || ''),
            realCwd: String(info.realCwd || ''),
            displayPath: String(info.displayPath || ''),
            realPath: String(info.realPath || ''),
            networkOrigin: String(info.networkOrigin || ''),
            targetMismatch: Boolean(info.targetMismatch),
            symlinkEscape: Boolean(info.symlinkEscape),
            summary: String(info.summary || ''),
            reason: String(info.reason || ''),
            detail: String(info.detail || ''),
            duration: typeof info.duration === 'number' && info.duration > 0 ? info.duration : 0,
            status: 'running',
            approvalState: '',
            approvalPhase: '',
            scopeKey: String(info.scopeKey || ''),
            allowSessionRule: Boolean(info.allowSessionRule),
            sessionRuleLabel: String(info.sessionRuleLabel || ''),
            isQuestion: Boolean(info.isQuestion),
            questions: Array.isArray(info.questions) ? info.questions : [],
            rawInput: info.rawInput && typeof info.rawInput === 'object' ? info.rawInput : null,
            deliveryError: '',
        };
        targetCard.toolNodes.push(node);
        markDirty(node);
        return node;
    };

    const resolveOrCreate = info => {
        if (typeof findOrCreateNode === 'function') {
            return findOrCreateNode(card, info);
        }
        const reqId = String(info.requestId || '').trim();
        const tcId = String(info.toolCallId || '').trim();
        let existing = null;
        if (reqId) {
            existing = card.toolNodes.find(n => n.requestId && n.requestId === reqId) || null;
        }
        if (!existing && tcId) {
            existing = card.toolNodes.find(n => n.toolCallId && n.toolCallId === tcId) || null;
        }
        if (!existing && info.matchPendingWithoutToolCallId && info.toolName && info.toolName !== '工具') {
            for (let i = card.toolNodes.length - 1; i >= 0; i--) {
                const cand = card.toolNodes[i];
                if (
                    cand.toolName === info.toolName &&
                    (cand.status === 'pending_approval' || cand.status === 'sending_approval') &&
                    !cand.toolCallId
                ) {
                    existing = cand;
                    break;
                }
            }
        }
        if (existing) {
            if (reqId && !existing.requestId) existing.requestId = reqId;
            if (tcId && !existing.toolCallId) existing.toolCallId = tcId;
            if (info.toolName && info.toolName !== '工具' && (!existing.toolName || existing.toolName === '工具')) {
                existing.toolName = String(info.toolName);
            }
            if (info.summary && !existing.summary) existing.summary = String(info.summary);
            if (info.detail) existing.detail = String(info.detail);
            markDirty(existing);
            return existing;
        }
        return defaultCreateNode(card, info);
    };

    const type = String(event.type || '');

    if (type === 'tool_execution_start' || type === 'tool_execution_update') {
        if (type === 'tool_execution_update' && !event.toolCallId && !event.requestId) {
            const nextPending = findNextPending();
            return {node: null, nextPending, stillWaiting: Boolean(nextPending)};
        }
        const node = resolveOrCreate({
            requestId: event.requestId || '',
            toolCallId: event.toolCallId || '',
            toolName: event.toolName || '工具',
            summary: event.summary || '',
            detail: event.detail || '',
            isQuestion: Boolean(event.isQuestion),
            questions: event.questions,
            rawInput: event.rawInput,
            matchPendingWithoutToolCallId: type === 'tool_execution_start',
        });
        if (node) {
            const isTerminal =
                node.status === 'done' ||
                node.status === 'error' ||
                node.status === 'denied' ||
                node.status === 'interrupted' ||
                node.status === 'unknown';
            if (
                !isTerminal &&
                node.status !== 'pending_approval' &&
                node.status !== 'sending_approval'
            ) {
                node.status = 'running';
            }
            markDirty(node);
        }
        syncCardActiveTool();
        const nextPending = findNextPending();
        return {node, nextPending, stillWaiting: Boolean(nextPending), allToolDotsDirty: Boolean(card.allToolDotsDirty)};
    }

    if (type === 'permission_request' || type === 'tool_approval_needed') {
        const hadPendingBefore = Boolean(findNextPending());
        const node = resolveOrCreate({
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
            if (node.status !== 'done' && node.status !== 'error' && node.status !== 'denied') {
                node.status = 'pending_approval';
            }
            node.approvalState = 'pending';
            markDirty(node);
            if (!hadPendingBefore || !card.selectedNodeId) {
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
        syncCardActiveTool();
        if (card.dirty && typeof card.dirty === 'object') {
            card.dirty.toolsUrgent = true;
        }
        const nextPending = findNextPending();
        return {node, nextPending, stillWaiting: Boolean(nextPending)};
    }

    if (type === 'permission_resolved') {
        let node = card.toolNodes.find(
            n => (event.requestId && n.requestId === event.requestId) ||
                 (event.toolCallId && n.toolCallId === event.toolCallId)
        ) || null;
        if (!node && event.autoApproved && event.requestId) {
            node = resolveOrCreate({
                requestId: event.requestId,
                toolCallId: event.toolCallId || '',
                toolName: event.toolName || '工具',
                scopeKey: event.scopeKey || '',
            });
        }
        const allow = (event.decision === 'allow' || event.decision === 'modify') && !event.timedOut;
        if (node) {
            node.deliveryError = '';
            node.approvalPhase = 'resolved';
            if (!allow) {
                node.status = 'denied';
                node.approvalState = event.timedOut ? 'timed_out' : 'denied';
            } else {
                if (node.status !== 'done' && node.status !== 'error') {
                    if (node.earlyExecutionEnd) {
                        node.status = node.earlyExecutionEnd.isError ? 'error' : 'done';
                    } else {
                        node.status = 'running';
                    }
                }
                if (event.autoApproved) {
                    node.approvalState = 'always';
                } else if (node.isQuestion) {
                    const hasAns = Boolean(
                        event.answers &&
                        typeof event.answers === 'object' &&
                        Object.keys(event.answers).length > 0
                    );
                    node.approvalState = hasAns
                        ? 'answered'
                        : (node.pendingApprovalAction || 'skipped');
                    if (hasAns) {
                        node.userAnswerSummary = formatAskUserAnswerSummary(
                            node.questions || [],
                            {answers: event.answers}
                        ) || node.pendingUserAnswerSummary || '';
                    } else if (node.pendingUserAnswerSummary) {
                        node.userAnswerSummary = node.pendingUserAnswerSummary;
                    } else {
                        node.userAnswerSummary = formatAskUserAnswerSummary(node.questions || [], {answers: {}});
                    }
                    node.pendingUserAnswerSummary = '';
                } else {
                    node.approvalState = (event.sessionScopeSaved || node.pendingApprovalAction === 'always')
                        ? 'always'
                        : 'allowed';
                }
            }
            markDirty(node);
            if (card.selectedNodeId === node.id) {
                const nextPendingSel = findNextPending();
                card.selectedNodeId = nextPendingSel ? nextPendingSel.id : null;
            }
        }
        const nextPending = findNextPending();
        const stillWaiting = Boolean(nextPending);
        if (activeTurn) {
            activeTurn.state = stillWaiting ? 'awaiting_approval' : 'streaming';
        }
        syncCardActiveTool();
        if (card.dirty && typeof card.dirty === 'object') {
            card.dirty.toolsUrgent = true;
        }
        return {node, nextPending, stillWaiting, allow};
    }

    if (type === 'tool_execution_end') {
        const tcId = String(event.toolCallId || '').trim();
        const reqId = String(event.requestId || '').trim();
        let node = null;
        if (tcId) {
            node = card.toolNodes.find(n => n.toolCallId && n.toolCallId === tcId) || null;
        }
        if (!node && reqId) {
            node = card.toolNodes.find(n => n.requestId && n.requestId === reqId) || null;
        }
        if (!node) {
            node = resolveOrCreate({
                toolCallId: tcId,
                requestId: reqId,
                toolName: event.toolName || '工具',
                summary: event.summary || '',
                detail: event.detail || '',
                duration: event.duration || 0,
                matchPendingWithoutToolCallId: false,
            });
            if (node) {
                node.startedWithoutStartEvent = true;
            }
        }
        if (node) {
            const isAlreadyFinal =
                node.status === 'done' ||
                node.status === 'error' ||
                node.status === 'denied';
            if (event.detail && (!isAlreadyFinal || !node.detail)) {
                node.detail = String(event.detail);
            }
            if (typeof event.duration === 'number' && event.duration > 0 && (!isAlreadyFinal || !node.duration)) {
                node.duration = event.duration;
            }
            if (!isAlreadyFinal) {
                node.earlyExecutionEnd = {
                    isError: Boolean(event.isError),
                    detail: node.detail || '',
                    duration: node.duration || 0,
                };
                node.status = event.isError ? 'error' : 'done';
            }
            markDirty(node);
        }
        syncCardActiveTool();
        const nextPending = findNextPending();
        return {node, nextPending, stillWaiting: Boolean(nextPending), allToolDotsDirty: Boolean(card.allToolDotsDirty)};
    }

    if (type === 'tool_batch_end') {
        const ids = Array.isArray(event.toolCallIds)
            ? event.toolCallIds.map(id => String(id || '').trim()).filter(Boolean)
            : [];
        if (ids.length > 0) {
            const confirmedIds = new Set(ids);
            for (const node of card.toolNodes) {
                if (node.status === 'running' && node.toolCallId && confirmedIds.has(node.toolCallId)) {
                    const perIdStatus = event.statusById && typeof event.statusById === 'object'
                        ? String(event.statusById[node.toolCallId] || '')
                        : '';
                    const batchStatus = String(event.batchStatus || '');
                    if (
                        perIdStatus === 'done' ||
                        perIdStatus === 'completed' ||
                        perIdStatus === 'success' ||
                        event.allSucceeded === true ||
                        batchStatus === 'done' ||
                        batchStatus === 'completed'
                    ) {
                        node.status = 'done';
                    } else if (
                        perIdStatus === 'error' ||
                        perIdStatus === 'failed' ||
                        batchStatus === 'error' ||
                        batchStatus === 'failed'
                    ) {
                        node.status = 'error';
                    } else if (perIdStatus === 'interrupted' || batchStatus === 'interrupted') {
                        node.status = 'interrupted';
                    } else {
                        node.status = 'unknown';
                    }
                    markDirty(node);
                }
            }
        }
        syncCardActiveTool();
        const nextPending = findNextPending();
        return {node: null, nextPending, stillWaiting: Boolean(nextPending), allToolDotsDirty: Boolean(card.allToolDotsDirty)};
    }

    if (type === 'agent_settled' || type === 'turn_settled') {
        const terminalStatus = event.status || (event.aborted ? 'cancelled' : 'completed');
        const isAbnormalExit = terminalStatus !== 'completed';
        const isCancelledOrInterrupted = terminalStatus === 'cancelled' || terminalStatus === 'interrupted';
        for (const node of card.toolNodes) {
            if (node.status === 'pending_approval' || node.status === 'sending_approval') {
                node.status = isCancelledOrInterrupted ? 'interrupted' : 'denied';
                node.approvalState = terminalStatus === 'timed_out'
                    ? 'timed_out'
                    : (isCancelledOrInterrupted ? 'cancelled' : 'denied');
                markDirty(node);
                if (card.selectedNodeId === node.id) {
                    card.selectedNodeId = null;
                }
            } else if (node.status === 'running') {
                node.status = isAbnormalExit ? 'interrupted' : 'unknown';
                markDirty(node);
            }
        }
        card.activeTool = false;
        if (card.dirty && typeof card.dirty === 'object') {
            card.dirty.tools = true;
            card.dirty.toolsUrgent = true;
        }
        return {node: null, nextPending: null, stillWaiting: false, allToolDotsDirty: Boolean(card.allToolDotsDirty)};
    }

    const nextPending = findNextPending();
    return {node: null, nextPending, stillWaiting: Boolean(nextPending), allToolDotsDirty: Boolean(card.allToolDotsDirty)};
}

/**
 * Partitions tool nodes into visible dots vs folded older completed dots so `dotsRow` never
 * overflows horizontally when an Agent executes dozens of tools in one turn.
 */
export function partitionToolDotsForLayout(toolNodes, {
    maxVisibleDots = DEFAULT_MAX_VISIBLE_TOOL_DOTS,
    maxVisible = undefined,
    expanded = false,
    dotsExpanded = undefined,
    selectedNodeId = null,
} = {}) {
    const list = Array.isArray(toolNodes) ? toolNodes : [];
    const effectiveMaxVisible = Math.max(4, Number(maxVisible ?? maxVisibleDots) || DEFAULT_MAX_VISIBLE_TOOL_DOTS);
    const effectiveExpanded = Boolean(dotsExpanded ?? expanded);
    if (effectiveExpanded || list.length <= effectiveMaxVisible) {
        const visibleIds = new Set(list.map(n => n.id));
        return {
            isFolded: false,
            foldedCount: 0,
            visibleIds,
            visibleNodes: list,
        };
    }

    const pinnedIds = new Set();
    for (const n of list) {
        if (
            n.id === selectedNodeId ||
            n.status === 'pending_approval' ||
            n.status === 'sending_approval' ||
            n.status === 'running' ||
            n.status === 'error' ||
            n.status === 'denied' ||
            n.status === 'interrupted' ||
            n.status === 'unknown'
        ) {
            pinnedIds.add(n.id);
        }
    }

    const budget = Math.max(4, effectiveMaxVisible - 1);
    const visibleIds = new Set(pinnedIds);
    for (let i = list.length - 1; i >= 0 && visibleIds.size < budget; i--) {
        visibleIds.add(list[i].id);
    }

    const foldedCount = Math.max(0, list.length - visibleIds.size);
    if (foldedCount <= 1) {
        const allIds = new Set(list.map(n => n.id));
        return {
            isFolded: false,
            foldedCount: 0,
            visibleIds: allIds,
            visibleNodes: list,
        };
    }

    return {
        isFolded: true,
        foldedCount,
        visibleIds,
        visibleNodes: list.filter(n => visibleIds.has(n.id)),
    };
}

/**
 * Caps live UI buffer display by UTF-8 byte budget without mutating the underlying raw text
 * used for copying or disk persistence.
 */
export function formatDisplayBufferWithCap(rawText, {
    maxDisplayBytes = UI_BUFFER_CAPS.maxThinkingDisplayBytes,
    expanded = false,
    tailPreview = false,
} = {}) {
    const str = String(rawText ?? '');
    if (!str) {
        return {displayText: '', isTruncatedForUi: false, fullByteLength: 0};
    }
    const encoded = UTF8_ENCODER.encode(str);
    if (expanded || encoded.byteLength <= maxDisplayBytes) {
        return {displayText: str, isTruncatedForUi: false, fullByteLength: encoded.byteLength};
    }

    const approxRatio = Math.max(0.05, maxDisplayBytes / encoded.byteLength);
    const sliceChars = Math.max(256, Math.floor(str.length * approxRatio));
    const kbTotal = Math.ceil(encoded.byteLength / 1024);

    if (tailPreview) {
        const tail = str.slice(Math.max(0, str.length - sliceChars));
        return {
            displayText: `… [前文已折叠，共 ${kbTotal} KB，可点击复制完整内容]\n${tail}`,
            isTruncatedForUi: true,
            fullByteLength: encoded.byteLength,
        };
    }

    const head = str.slice(0, sliceChars);
    return {
        displayText: `${head}\n\n… [内容较长共 ${kbTotal} KB，UI 仅展示摘要；可展开或点击复制获取完整原文]`,
        isTruncatedForUi: true,
        fullByteLength: encoded.byteLength,
    };
}

export function appendBoundedInMemoryText(existingText, deltaText, maxChars = UI_BUFFER_CAPS.maxInMemoryFieldChars) {
    const next = String(existingText || '') + String(deltaText || '');
    if (next.length <= maxChars) return next;
    return `${next.slice(0, maxChars)}\n… [内存缓冲已达安全上限]`;
}

/**
 * Formats complete, un-hidden security inspector details for a tool trace node (R11.4).
 * During `pending_approval` / `sending_approval` (`isAwaiting`), NEVER truncates `fullCommand` at 260 chars
 * and always surfaces the real command, real working directory, normalized target path, and all risk warnings.
 */
export function formatToolApprovalInspectorDetails(node, {expanded = false} = {}) {
    if (!node || typeof node !== 'object') {
        return {
            summaryText: '',
            summaryVisible: false,
            bodyText: '',
            bodyVisible: false,
            showExpandBtn: false,
            isAwaiting: false,
        };
    }

    const isAwaiting = node.status === 'pending_approval' || node.status === 'sending_approval';
    const primaryTargetText = String(
        node.fullCommand ||
        node.displayPath ||
        node.networkOrigin ||
        (node.summary && node.summary !== node.toolName ? node.summary : '')
    ).trim();

    let summaryText = '';
    let isSummaryTruncated = false;
    const isLongPrimary = primaryTargetText.length > 260 || primaryTargetText.split('\n').length > 6;

    if (primaryTargetText) {
        if (!isAwaiting && isLongPrimary && !expanded) {
            const lines = primaryTargetText.split('\n');
            const preview = lines.length > 6
                ? `${lines.slice(0, 6).join('\n')}…`
                : `${primaryTargetText.slice(0, 260)}…`;
            summaryText = `${preview}（共 ${primaryTargetText.length} 字符，可展开查看完整内容）`;
            isSummaryTruncated = true;
        } else {
            const cappedPrimary = formatDisplayBufferWithCap(primaryTargetText, {
                maxDisplayBytes: UI_BUFFER_CAPS.maxToolDetailDisplayBytes,
                expanded: Boolean(expanded),
            });
            summaryText = cappedPrimary.displayText;
            isSummaryTruncated = cappedPrimary.isTruncatedForUi;
        }
    }

    const extraLines = [];
    if (node.deliveryError) extraLines.push(`⚠️ ${node.deliveryError}`);
    if (node.operationLabel && node.toolName) {
        extraLines.push(`工具与操作：${node.toolName}（${node.operationLabel}${node.riskLabel ? ` · ${node.riskLabel}` : ''}）`);
    } else if (node.riskLabel) {
        extraLines.push(`风险等级：${node.riskLabel}`);
    }
    if (isAwaiting && node.fullCommand && primaryTargetText !== node.fullCommand) {
        extraLines.push(`真实命令：${node.fullCommand}`);
    }
    const effectiveCwd = node.realCwd || node.cwd;
    if (effectiveCwd) {
        extraLines.push(
            node.cwd && node.realCwd && node.cwd !== node.realCwd
                ? `真实工作目录：${node.realCwd}（请求路径：${node.cwd}）`
                : `工作目录：${effectiveCwd}`
        );
    }
    if (node.realPath) {
        extraLines.push(
            node.displayPath && node.displayPath !== node.realPath
                ? `规范化真实路径：${node.realPath}（原始参数：${node.displayPath}）`
                : `目标真实路径：${node.realPath}`
        );
    } else if (node.displayPath && primaryTargetText !== node.displayPath) {
        extraLines.push(`目标路径：${node.displayPath}`);
    }
    if (node.networkOrigin && primaryTargetText !== node.networkOrigin) {
        extraLines.push(`网络目标来源：${node.networkOrigin}`);
    }
    if (Array.isArray(node.riskWarnings) && node.riskWarnings.length > 0) {
        for (const w of node.riskWarnings) {
            extraLines.push(`⚠️ 风险提示：${w}`);
        }
    }
    if (isAwaiting) {
        if (node.reason && node.reason !== primaryTargetText) {
            extraLines.push(`说明：${node.reason}`);
        }
    } else if (node.detail && node.detail !== primaryTargetText) {
        extraLines.push(node.detail);
    }

    let bodyText = '';
    let isExtraTruncated = false;
    if (extraLines.length > 0) {
        const cappedExtra = formatDisplayBufferWithCap(extraLines.join('\n'), {
            maxDisplayBytes: UI_BUFFER_CAPS.maxToolDetailDisplayBytes,
            expanded: Boolean(expanded || isAwaiting),
        });
        bodyText = cappedExtra.displayText;
        isExtraTruncated = cappedExtra.isTruncatedForUi;
    } else if (!summaryText) {
        bodyText = `工具名称：${node.toolName || '工具'}`;
    }

    const showExpandBtn = Boolean(
        isSummaryTruncated ||
        isExtraTruncated ||
        (Boolean(expanded) && ((!isAwaiting && isLongPrimary) || extraLines.join('\n').length > 260))
    );

    return {
        summaryText,
        summaryVisible: Boolean(summaryText),
        bodyText,
        bodyVisible: Boolean(bodyText),
        showExpandBtn,
        isAwaiting,
    };
}

/**
 * Formats a stored message's real `createdAt` / `ts` instead of stamping current time on reload.
 */
export function formatMessageTimestamp(msgOrRaw, nowMs = Date.now()) {
    let tsMs = 0;
    if (msgOrRaw && typeof msgOrRaw === 'object') {
        if (typeof msgOrRaw.ts === 'number' && Number.isFinite(msgOrRaw.ts) && msgOrRaw.ts > 0) {
            tsMs = msgOrRaw.ts;
        } else if (typeof msgOrRaw.createdAt === 'string' && msgOrRaw.createdAt.trim()) {
            const parsed = Date.parse(msgOrRaw.createdAt);
            if (!Number.isNaN(parsed)) tsMs = parsed;
        }
    } else if (typeof msgOrRaw === 'number' && Number.isFinite(msgOrRaw) && msgOrRaw > 0) {
        tsMs = msgOrRaw;
    } else if (typeof msgOrRaw === 'string' && msgOrRaw.trim()) {
        const parsed = Date.parse(msgOrRaw);
        if (!Number.isNaN(parsed)) tsMs = parsed;
    }

    const d = new Date(tsMs > 0 ? tsMs : nowMs);
    const now = new Date(nowMs);
    const pad = n => String(n).padStart(2, '0');
    const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

    if (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
    ) {
        return hhmm;
    }
    if (d.getFullYear() === now.getFullYear()) {
        return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`;
    }
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`;
}

export function resolveAssistantDisplayModel(msg, fallbackModelLabel = '随问') {
    if (msg && typeof msg === 'object') {
        const explicit = String(msg.modelId || '').trim();
        if (explicit) return explicit;
        const backend = String(msg.backend || '').trim().toLowerCase();
        if (BACKEND_FALLBACK_LABELS[backend]) return BACKEND_FALLBACK_LABELS[backend];
    }
    return String(fallbackModelLabel || '随问');
}

/**
 * Manages the full session history (`allMessages`) while keeping at most `maxMountedActors` (~48)
 * message card Actors mounted in the GNOME Shell St.BoxLayout at any moment!
 *
 * Strictly maintains chronological order in BOTH `allMessages` and `mountedRefs`,
 * fixing the `_prependOlderHistoryBatch` `unshift` order-inversion defect.
 */
export class HistoryWindowController {
    constructor({
        initialPageSize = DEFAULT_INITIAL_HISTORY_COUNT,
        pageSize = DEFAULT_HISTORY_PAGE_SIZE,
        maxMountedActors = DEFAULT_MAX_MOUNTED_ACTORS,
        maxSingleMessageDataBytes = UI_BUFFER_CAPS.maxSingleMessageDataBytes,
        maxHistoryDataBytes = UI_BUFFER_CAPS.maxHistoryDataBytes,
        maxHotCachedMessages = DEFAULT_HOT_DATA_CACHE_LIMIT,
        maxHotDataMessages = null,
        maxIndexedMessages = DEFAULT_MAX_INDEXED_MESSAGES,
        clearTimer = null,
    } = {}) {
        this._initialPageSize = Math.max(2, Number(initialPageSize) || DEFAULT_INITIAL_HISTORY_COUNT);
        this._pageSize = Math.max(2, Number(pageSize) || DEFAULT_HISTORY_PAGE_SIZE);
        this._maxMounted = Math.max(this._initialPageSize, Number(maxMountedActors) || DEFAULT_MAX_MOUNTED_ACTORS);
        this._maxSingleMessageDataBytes = Math.max(
            1024,
            Number(maxSingleMessageDataBytes) || UI_BUFFER_CAPS.maxSingleMessageDataBytes
        );
        this._maxHistoryDataBytes = Math.max(
            4096,
            Number(maxHistoryDataBytes) || UI_BUFFER_CAPS.maxHistoryDataBytes
        );
        this._maxHotCachedMessages = Math.max(
            this._maxMounted,
            Number(maxHotDataMessages ?? maxHotCachedMessages) || DEFAULT_HOT_DATA_CACHE_LIMIT
        );
        this._maxIndexedMessages = Math.max(
            this._maxHotCachedMessages,
            Number(maxIndexedMessages) || DEFAULT_MAX_INDEXED_MESSAGES
        );
        this._clearTimer = typeof clearTimer === 'function' ? clearTimer : null;

        this.allMessages = [];
        this.paginationIndex = new Map();
        this.mountedCards = [];
        this.windowStart = 0;
        this.windowEnd = 0;
        this.totalDataBytes = 0;
        this.compactedCount = 0;
        this.hotCachedCount = 0;
        this.pagedIndexEntryCount = 0;
        this.externalArchivedCount = 0;
    }

    get mountedCount() {
        return this.mountedCards.length;
    }

    get hasOlder() {
        return this.windowStart > 0 || this.externalArchivedCount > 0;
    }

    get olderRemainingCount() {
        return Math.max(0, this.windowStart) + Math.max(0, this.externalArchivedCount);
    }

    get totalLogicalCount() {
        return this.allMessages.length + Math.max(0, this.externalArchivedCount);
    }

    get hasNewer() {
        return this.windowEnd < this.allMessages.length;
    }

    get newerRemainingCount() {
        return Math.max(0, this.allMessages.length - this.windowEnd);
    }

    setExternalArchivedCount(count = 0) {
        this.externalArchivedCount = Math.max(0, Number(count) || 0);
    }

    _rebuildPaginationIndex() {
        this.paginationIndex.clear();
        let hotCount = 0;
        let pagedCount = 0;
        for (let i = 0; i < this.allMessages.length; i++) {
            const msg = this.allMessages[i];
            if (!msg || typeof msg !== 'object') continue;
            const isPaged = Boolean(msg.isPagedIndexEntry);
            if (isPaged) pagedCount++;
            else hotCount++;
            if (msg.id) {
                this.paginationIndex.set(msg.id, {
                    id: msg.id,
                    revision: Number(msg.revision || 0),
                    index: i,
                    role: msg.role || 'assistant',
                    turnId: msg.turnId || '',
                    replyTo: msg.replyTo || '',
                    createdAt: msg.createdAt || '',
                    ts: Number(msg.ts || 0),
                    modelId: msg.modelId || '',
                    backend: msg.backend || '',
                    status: msg.status || 'completed',
                    isHotCached: !isPaged,
                    isPagedIndexEntry: isPaged,
                });
            }
        }
        this.hotCachedCount = hotCount;
        this.pagedIndexEntryCount = pagedCount;
    }

    _enforceDataBudget() {
        const compactPreviewBytes = Math.min(2048, Math.max(256, Math.floor(this._maxSingleMessageDataBytes / 8)));
        const hotTailStart = Math.max(0, this.allMessages.length - this._maxHotCachedMessages);

        // Pass 0 (R8): Demote off-window older messages outside the hot cache window into compact index entries!
        for (let i = 0; i < this.allMessages.length; i++) {
            const inMountedWindow = i >= this.windowStart && i < this.windowEnd;
            const inHotTail = i >= hotTailStart;
            if (!inMountedWindow && !inHotTail) {
                const prev = this.allMessages[i];
                if (prev && !prev.isPagedIndexEntry) {
                    this.allMessages[i] = demoteMessageToIndexEntry(prev, compactPreviewBytes);
                    this.compactedCount++;
                }
            } else {
                this.allMessages[i] = capMessageRecordBytes(this.allMessages[i], this._maxSingleMessageDataBytes);
            }
        }

        let total = 0;
        for (let i = 0; i < this.allMessages.length; i++) {
            total += estimateMessageDataBytes(this.allMessages[i]);
        }

        if (total > this._maxHistoryDataBytes) {
            // Pass 1: compact off-window older messages first (indices < windowStart)
            for (let i = 0; i < this.windowStart && total > this._maxHistoryDataBytes; i++) {
                const msg = this.allMessages[i];
                if (!msg || msg.compactedInDataLayer) continue;
                const beforeBytes = estimateMessageDataBytes(msg);
                const compacted = demoteMessageToIndexEntry(msg, compactPreviewBytes);
                if (compacted !== msg) {
                    this.allMessages[i] = compacted;
                    const afterBytes = estimateMessageDataBytes(compacted);
                    total -= Math.max(0, beforeBytes - afterBytes);
                    this.compactedCount++;
                }
            }
            // Pass 2: if still exceeding budget, compact older messages from index 0 up to allMessages.length - 2
            for (let i = 0; i < this.allMessages.length - 2 && total > this._maxHistoryDataBytes; i++) {
                const msg = this.allMessages[i];
                if (!msg || msg.compactedInDataLayer) continue;
                const beforeBytes = estimateMessageDataBytes(msg);
                const compacted = capMessageRecordBytes(msg, compactPreviewBytes);
                if (compacted !== msg) {
                    compacted.compactedInDataLayer = true;
                    this.allMessages[i] = compacted;
                    const afterBytes = estimateMessageDataBytes(compacted);
                    total -= Math.max(0, beforeBytes - afterBytes);
                    this.compactedCount++;
                }
            }
        }

        // Pass 3: if exceeding byte budget or maxIndexedMessages and there are unmounted older entries before windowStart,
        // evict oldest unmounted entries from memory into externalArchivedCount
        while (
            this.windowStart > 0 &&
            this.allMessages.length > this._maxMounted &&
            (total > this._maxHistoryDataBytes || this.allMessages.length > this._maxIndexedMessages)
        ) {
            const removed = this.allMessages.shift();
            total -= estimateMessageDataBytes(removed);
            this.windowStart = Math.max(0, this.windowStart - 1);
            this.windowEnd = Math.max(this.windowStart, this.windowEnd - 1);
            this.externalArchivedCount++;
            this.compactedCount++;
        }

        this.totalDataBytes = Math.max(0, total);
        this._rebuildPaginationIndex();
    }

    clear() {
        for (const card of this.mountedCards) {
            releaseCardRuntimeReferences(card, {clearTimer: this._clearTimer});
        }
        this.allMessages = [];
        this.paginationIndex.clear();
        this.mountedCards = [];
        this.windowStart = 0;
        this.windowEnd = 0;
        this.totalDataBytes = 0;
        this.compactedCount = 0;
        this.hotCachedCount = 0;
        this.pagedIndexEntryCount = 0;
        this.externalArchivedCount = 0;
    }

    reset(allDetailedMessages = [], {externalArchivedCount = 0} = {}) {
        for (const card of this.mountedCards) {
            releaseCardRuntimeReferences(card, {clearTimer: this._clearTimer});
        }
        this.allMessages = Array.isArray(allDetailedMessages)
            ? allDetailedMessages.map(m => capMessageRecordBytes(m, this._maxSingleMessageDataBytes))
            : [];
        this.mountedCards = [];
        const total = this.allMessages.length;
        this.windowStart = Math.max(0, total - this._initialPageSize);
        this.windowEnd = total;
        this.compactedCount = 0;
        this.externalArchivedCount = Math.max(0, Number(externalArchivedCount) || 0);
        this._enforceDataBudget();
        return {
            initialSlice: this.allMessages.slice(this.windowStart, this.windowEnd),
            windowStart: this.windowStart,
            windowEnd: this.windowEnd,
        };
    }

    /**
     * Prepends a page of older archived messages loaded from `archive.jsonl` into the front
     * of `allMessages` without losing current scroll window offsets (Stage R8).
     */
    prependArchivedMessages(archivedDetailedMessages = [], {remainingOlderCount = null} = {}) {
        const list = Array.isArray(archivedDetailedMessages) ? archivedDetailedMessages : [];
        if (list.length === 0) {
            if (remainingOlderCount !== null) {
                this.externalArchivedCount = Math.max(0, Number(remainingOlderCount) || 0);
            }
            return {insertedCount: 0};
        }

        const existingIds = new Set(this.allMessages.map(m => m?.id).filter(Boolean));
        const toInsert = [];
        for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            if (item.id && existingIds.has(item.id)) continue;
            if (item.id) existingIds.add(item.id);
            toInsert.push(capMessageRecordBytes(item, this._maxSingleMessageDataBytes));
        }

        if (toInsert.length > 0) {
            this.allMessages.splice(0, 0, ...toInsert);
            this.windowStart += toInsert.length;
            this.windowEnd += toInsert.length;
        }

        if (remainingOlderCount !== null) {
            this.externalArchivedCount = Math.max(0, Number(remainingOlderCount) || 0);
        } else {
            this.externalArchivedCount = Math.max(0, this.externalArchivedCount - toInsert.length);
        }

        this._enforceDataBudget();
        return {insertedCount: toInsert.length};
    }

    registerMountedInitialCards(cards) {
        this.mountedCards = Array.isArray(cards) ? [...cards] : [];
    }

    /**
     * Computes the next older chronological slice to prepend at index 0, and trims off-screen
     * bottom cards if `mountedCards.length > maxMountedActors` (never evicting `protectedCard`).
     */
    planPrependOlderBatch({protectedCard = null} = {}) {
        if (this.windowStart <= 0) {
            return {slice: [], newWindowStart: this.windowStart, evictBottomCount: 0};
        }
        const nextStart = Math.max(0, this.windowStart - this._pageSize);
        const slice = this.allMessages.slice(nextStart, this.windowStart);
        const projectedMounted = this.mountedCards.length + slice.length;
        let evictBottomCount = Math.max(0, projectedMounted - this._maxMounted);

        // Never evict a protected live streaming card from the bottom!
        if (evictBottomCount > 0 && protectedCard) {
            const maxSafeEvict = Math.max(0, this.mountedCards.indexOf(protectedCard));
            if (this.mountedCards.includes(protectedCard)) {
                evictBottomCount = Math.min(evictBottomCount, maxSafeEvict);
            }
        }
        return {
            slice,
            newWindowStart: nextStart,
            evictBottomCount,
        };
    }

    /**
     * Commits prepended cards in exact chronological order (`[...prependedCardsInChronoOrder, ...existing]`)
     * — NEVER reversing order via looped `unshift`!
     */
    commitPrependedBatch(prependedCardsInChronoOrder, newWindowStart, evictBottomCount = 0) {
        this.windowStart = newWindowStart;
        // Insert in exact chronological order at the front of `mountedCards`
        this.mountedCards.splice(0, 0, ...prependedCardsInChronoOrder);

        const evictedBottomCards = [];
        while (evictBottomCount > 0 && this.mountedCards.length > 1) {
            const removed = this.mountedCards.pop();
            releaseCardRuntimeReferences(removed, {clearTimer: this._clearTimer});
            evictedBottomCards.push(removed);
            this.windowEnd = Math.max(this.windowStart, this.windowEnd - 1);
            evictBottomCount--;
        }
        this._enforceDataBudget();
        return evictedBottomCards;
    }

    /**
     * Appends a newly created runtime message & card at the end of the session, recycling oldest
     * mounted Actors from the top when exceeding `maxMountedActors` (unless user is scrolled up reading).
     */
    appendRuntimeCard(msgRecord, card, {allowRecycleTop = true, protectedCard = null} = {}) {
        // If user had paged way up (`hasNewer === true`), snap back to tail window first or append to data only
        const wasAtTail = !this.hasNewer;
        const cappedRecord = capMessageRecordBytes(msgRecord, this._maxSingleMessageDataBytes);
        this.allMessages.push(cappedRecord);

        if (!wasAtTail) {
            this._enforceDataBudget();
            return {mountedAtTail: false, evictedTopCards: []};
        }

        this.mountedCards.push(card);
        this.windowEnd = this.allMessages.length;

        const evictedTopCards = [];
        if (allowRecycleTop) {
            while (this.mountedCards.length > this._maxMounted) {
                const candidate = this.mountedCards[0];
                if (!candidate || candidate === protectedCard || candidate === card) {
                    break;
                }
                this.mountedCards.shift();
                this.windowStart++;
                releaseCardRuntimeReferences(candidate, {clearTimer: this._clearTimer});
                evictedTopCards.push(candidate);
            }
        }

        this._enforceDataBudget();

        return {
            mountedAtTail: true,
            evictedTopCards,
        };
    }

    updateStoredMessageById(messageId, patch) {
        if (!messageId || !patch) return false;
        for (let i = this.allMessages.length - 1; i >= 0; i--) {
            if (this.allMessages[i]?.id === messageId) {
                this.allMessages[i] = capMessageRecordBytes(
                    {
                        ...this.allMessages[i],
                        ...patch,
                        isPagedIndexEntry: false,
                        compactedInDataLayer: false,
                    },
                    this._maxSingleMessageDataBytes
                );
                this._enforceDataBudget();
                return true;
            }
        }
        return false;
    }

    /**
     * Resolves the exact user prompt text to retry for a given assistant card using `replyTo` / `messageId`
     * across the FULL `allMessages` history (even if the user card was recycled out of `mountedCards`).
     */
    findRetryPromptForCard(assistantCard) {
        if (!assistantCard) return '';

        const replyToId = String(assistantCard.replyTo || '').trim();
        if (replyToId) {
            const indexHit = this.paginationIndex.get(replyToId);
            if (indexHit && this.allMessages[indexHit.index]?.role === 'user') {
                const exactUser = this.allMessages[indexHit.index];
                if (exactUser?.text?.trim()) {
                    return exactUser.text.trim();
                }
            }
            const exactUser = this.allMessages.find(m => m && m.id === replyToId && m.role === 'user');
            if (exactUser && exactUser.text?.trim()) {
                return exactUser.text.trim();
            }
            const mountedUser = this.mountedCards.find(c => c && c.messageId === replyToId && c.role === 'user');
            if (mountedUser && mountedUser.text?.trim()) {
                return mountedUser.text.trim();
            }
        }

        // Fallback 1: locate `assistantCard.messageId` in `allMessages` and walk backwards
        if (assistantCard.messageId) {
            const msgIdx = this.allMessages.findIndex(m => m && m.id === assistantCard.messageId);
            if (msgIdx > 0) {
                for (let i = msgIdx - 1; i >= 0; i--) {
                    const m = this.allMessages[i];
                    if (m?.role === 'user' && m.text?.trim()) {
                        return m.text.trim();
                    }
                }
            }
        }

        // Fallback 2: walk backwards in `mountedCards` (now guaranteed strictly chronological!)
        const cardIdx = this.mountedCards.indexOf(assistantCard);
        if (cardIdx >= 0) {
            const globalIdx = this.windowStart + cardIdx;
            for (let i = globalIdx - 1; i >= 0; i--) {
                const m = this.allMessages[i];
                if (m?.role === 'user' && m.text?.trim()) {
                    return m.text.trim();
                }
            }
            for (let i = cardIdx - 1; i >= 0; i--) {
                const c = this.mountedCards[i];
                if (c?.role === 'user' && c.text?.trim()) {
                    return c.text.trim();
                }
            }
        }

        return '';
    }

    /**
     * Resolves the exact user message record `{userMessageId, promptText, displayText, createdAt, ts, userIndex}`
     * paired with an assistant card (or user card) so in-place Regenerate / Edit Question can rewind
     * without appending a duplicate user message, while preserving attachment envelopes and detecting
     * discarded subsequent turns or side-effecting tool executions (R11.3)!
     */
    findRetryTurnInfoForCard(card) {
        if (!card) return null;

        const buildEnrichedTurnInfo = ({
            userMessageId = '',
            promptText = '',
            displayText = '',
            createdAt = '',
            ts = 0,
            userIndex = -1,
        } = {}) => {
            const parsedPrompt = extractUserQuestionAndAttachmentsFromPrompt(promptText, displayText);
            const discardedSubsequentCount = userIndex >= 0
                ? Math.max(0, this.allMessages.length - 1 - userIndex)
                : 0;

            let hadSideEffectTools = false;
            if (Array.isArray(card.toolNodes) && card.toolNodes.some(n => isSideEffectingToolExecution(n))) {
                hadSideEffectTools = true;
            }
            if (!hadSideEffectTools && userIndex >= 0) {
                for (let i = userIndex + 1; i < this.allMessages.length; i++) {
                    const msg = this.allMessages[i];
                    if (Array.isArray(msg?.toolNodes) && msg.toolNodes.some(n => isSideEffectingToolExecution(n))) {
                        hadSideEffectTools = true;
                        break;
                    }
                }
                for (const mc of this.mountedCards) {
                    if (!mc || mc.role !== 'assistant' || !Array.isArray(mc.toolNodes)) continue;
                    const mcIdx = mc.messageId
                        ? this.allMessages.findIndex(m => m && m.id === mc.messageId)
                        : -1;
                    if (mcIdx > userIndex && mc.toolNodes.some(n => isSideEffectingToolExecution(n))) {
                        hadSideEffectTools = true;
                        break;
                    }
                }
            }

            return {
                userMessageId,
                promptText,
                displayText,
                editableQuestionText: parsedPrompt.questionText || displayText || promptText,
                hasPreservedAttachments: parsedPrompt.hasPreservedAttachments,
                recomposePrompt: parsedPrompt.recomposePrompt,
                recomposeDisplayText: parsedPrompt.recomposeDisplayText,
                discardedSubsequentCount,
                hadSideEffectTools,
                createdAt,
                ts,
                userIndex,
            };
        };

        if (card.role === 'user') {
            const exactIdx = card.messageId
                ? this.allMessages.findIndex(m => m && m.id === card.messageId && m.role === 'user')
                : -1;
            const stored = exactIdx >= 0 ? this.allMessages[exactIdx] : null;
            return buildEnrichedTurnInfo({
                userMessageId: String(stored?.id || card.messageId || ''),
                promptText: String(stored?.text || card.rawPromptText || card.text || '').trim(),
                displayText: String(stored?.displayText || card.text || '').trim(),
                createdAt: stored?.createdAt || card.createdAt || '',
                ts: stored?.ts || card.effectiveTs || 0,
                userIndex: exactIdx,
            });
        }

        const replyToId = String(card.replyTo || '').trim();
        if (replyToId) {
            const exactIdx = this.allMessages.findIndex(m => m && m.id === replyToId && m.role === 'user');
            if (exactIdx >= 0) {
                const stored = this.allMessages[exactIdx];
                return buildEnrichedTurnInfo({
                    userMessageId: stored.id,
                    promptText: String(stored.text || '').trim(),
                    displayText: String(stored.displayText || stored.text || '').trim(),
                    createdAt: stored.createdAt || '',
                    ts: stored.ts || 0,
                    userIndex: exactIdx,
                });
            }
        }

        const asstIdx = card.messageId
            ? this.allMessages.findIndex(m => m && m.id === card.messageId)
            : -1;
        const searchStart = asstIdx > 0
            ? asstIdx - 1
            : (this.mountedCards.indexOf(card) >= 0 ? this.windowStart + this.mountedCards.indexOf(card) - 1 : -1);

        for (let i = searchStart; i >= 0; i--) {
            const m = this.allMessages[i];
            if (m?.role === 'user' && m.text?.trim()) {
                return buildEnrichedTurnInfo({
                    userMessageId: String(m.id || ''),
                    promptText: m.text.trim(),
                    displayText: String(m.displayText || m.text || '').trim(),
                    createdAt: m.createdAt || '',
                    ts: m.ts || 0,
                    userIndex: i,
                });
            }
        }
        return null;
    }

    /**
     * Truncates `allMessages` and `mountedCards` starting from `startMessageId`
     * (inclusive when `keepStartMessage === false`, or strictly AFTER `startMessageId` when `keepStartMessage === true`).
     * Returns `{removedCards}` so the UI can destroy only the removed St Actors cleanly!
     */
    truncateFromMessageId(startMessageId, {keepStartMessage = false} = {}) {
        const cleanId = String(startMessageId || '').trim();
        if (!cleanId) return {removedCards: [], truncated: false};

        const msgIdx = this.allMessages.findIndex(m => m && m.id === cleanId);
        if (msgIdx < 0) {
            return {removedCards: [], truncated: false};
        }

        const cutAllIdx = keepStartMessage ? msgIdx + 1 : msgIdx;
        if (cutAllIdx >= this.allMessages.length) {
            return {removedCards: [], truncated: false};
        }

        this.allMessages = this.allMessages.slice(0, cutAllIdx);
        const removedCards = [];

        if (cutAllIdx <= this.windowStart) {
            // Cut point is earlier than the currently mounted window: clear all mounted cards and reset window to tail!
            for (const c of this.mountedCards) {
                releaseCardRuntimeReferences(c, {clearTimer: this._clearTimer});
                removedCards.push(c);
            }
            this.mountedCards = [];
            this.windowStart = Math.max(0, this.allMessages.length - this._initialPageSize);
            this.windowEnd = this.allMessages.length;
            this._enforceDataBudget();
            return {removedCards, truncated: true, needsRemountWindow: true};
        }

        const mountedCutOffset = cutAllIdx - this.windowStart;
        if (mountedCutOffset < this.mountedCards.length) {
            const tailRemoved = this.mountedCards.splice(mountedCutOffset);
            for (const c of tailRemoved) {
                releaseCardRuntimeReferences(c, {clearTimer: this._clearTimer});
                removedCards.push(c);
            }
        }
        this.windowEnd = Math.min(this.allMessages.length, this.windowStart + this.mountedCards.length);
        this._enforceDataBudget();
        return {removedCards, truncated: true, needsRemountWindow: false};
    }
}

/**
 * Derives a unified, single-source-of-truth runtime & UI state from `TurnController` and `card` (Stage R12.3).
 * Guarantees:
 * 1. `TurnController.state`, `activeToolIds`, `pendingApprovals`, and `card.toolNodes` are derived from the same
 *    event stream without divergent mutable boolean flags.
 * 2. Permission confirmation transitions (`pending_approval` / `sending_approval` -> `running` / `denied`)
 *    are driven strictly by authoritative `permission_resolved` bridge events.
 */
export function deriveUnifiedTurnRuntimeState({
    turnController = null,
    card = null,
    connectionError = '',
    saveWarning = '',
} = {}) {
    const activeTurn = turnController?.activeTurn || turnController || null;
    const tcState = turnController
        ? String(turnController.state || activeTurn?.state || 'idle')
        : 'idle';
    const tcBusy = Boolean(
        turnController &&
        (tcState === 'starting' || tcState === 'streaming' || tcState === 'awaiting_approval')
    );
    const tcActiveToolCount = activeTurn?.activeToolIds instanceof Set
        ? activeTurn.activeToolIds.size
        : Number(turnController?.activeToolCount || 0);
    const tcPendingApprovalCount = activeTurn?.pendingApprovals instanceof Set
        ? activeTurn.pendingApprovals.size
        : Number(turnController?.pendingApprovalCount || 0);

    const toolNodes = Array.isArray(card?.toolNodes) ? card.toolNodes : [];
    const cardRunningNodes = toolNodes.filter(n => n && n.status === 'running');
    const cardAwaitingNodes = toolNodes.filter(
        n => n && (n.status === 'pending_approval' || n.status === 'sending_approval')
    );
    const firstAwaiting = cardAwaitingNodes[0] || null;
    const lastRunning = cardRunningNodes[cardRunningNodes.length - 1] || null;

    const hasPendingApproval = tcPendingApprovalCount > 0 || cardAwaitingNodes.length > 0;
    let phase = 'ready';
    if (hasPendingApproval) {
        phase = 'waiting_approval';
    } else if (tcBusy) {
        phase = (tcState === 'starting' && tcActiveToolCount === 0 && cardRunningNodes.length === 0)
            ? 'sending'
            : 'executing';
    } else if (saveWarning && !connectionError) {
        phase = 'save_failed';
    } else if (connectionError) {
        phase = /network|timeout|connection|reset|stream|eof|broken pipe|网络|连接|中断|超时/i.test(connectionError)
            ? 'network_interrupted'
            : 'error';
    }

    const inSync = !turnController || !card || (
        cardRunningNodes.length === tcActiveToolCount &&
        cardAwaitingNodes.length === tcPendingApprovalCount &&
        Boolean(card.activeTool) === (cardRunningNodes.length > 0 || cardAwaitingNodes.length > 0)
    );

    return {
        phase,
        busy: tcBusy,
        turnState: tcState,
        hasPendingApproval,
        pendingApprovalCount: Math.max(tcPendingApprovalCount, cardAwaitingNodes.length),
        activeToolCount: Math.max(tcActiveToolCount, cardRunningNodes.length),
        pendingToolName: firstAwaiting?.toolName || '',
        pendingIsQuestion: Boolean(firstAwaiting?.isQuestion),
        activeToolName: lastRunning?.toolName || '',
        inSync,
    };
}

