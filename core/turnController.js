/**
 * Pure JavaScript TurnContext & TurnController state machine (zero GJS dependencies).
 * Guarantees per-turn identity isolation, idempotent finalization, and single-settlement semantics.
 *
 * Canonical states (Stage B3):
 *   idle | starting | streaming | awaiting_approval | cancelling
 *   -> completed | cancelled | failed | interrupted | timed_out
 */

import {getToolBatchStatus, getToolEndStatus} from '../protocol.js';

export const TURN_STATES = Object.freeze([
    'idle',
    'starting',
    'streaming',
    'awaiting_approval',
    'cancelling',
    'completed',
    'cancelled',
    'failed',
    'interrupted',
    'timed_out',
]);

export const TERMINAL_TURN_STATES = new Set([
    'completed',
    'cancelled',
    'failed',
    'interrupted',
    'timed_out',
]);

export const STREAM_EVENT_TYPES = Object.freeze({
    TEXT_DELTA: 'text_delta',
    TEXT_REPLACE: 'text_replace',
    THINKING_DELTA: 'thinking_delta',
    THINKING_REPLACE: 'thinking_replace',
    MESSAGE_FINAL: 'message_end',
    TOOL_START: 'tool_execution_start',
    TOOL_UPDATE: 'tool_execution_update',
    TOOL_END: 'tool_execution_end',
    PERMISSION_REQUEST: 'permission_request',
    PERMISSION_RESOLVED: 'permission_resolved',
    TURN_SETTLED: 'agent_settled',
});

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', {fatal: false});

export const DEFAULT_TURN_BUDGETS = Object.freeze({
    maxTurnTextBytes: 512 * 1024, // 512 KiB cumulative assistant text per turn
    maxTurnThinkingBytes: 256 * 1024, // 256 KiB cumulative thinking text per turn
    maxToolDetailBytesPerEvent: 4 * 1024, // 4 KiB per tool event detail
    maxTurnToolEventsBytes: 128 * 1024, // 128 KiB cumulative tool event details per turn
});

function truncateUtf8ToBytes(str, maxBytes, suffix = '') {
    const raw = String(str ?? '');
    const encoded = UTF8_ENCODER.encode(raw);
    if (encoded.byteLength <= maxBytes) {
        return {text: raw, truncated: false, byteLength: encoded.byteLength};
    }
    const suffixBytes = suffix ? UTF8_ENCODER.encode(suffix) : new Uint8Array(0);
    let endIdx = Math.max(0, Math.min(encoded.byteLength, maxBytes - suffixBytes.byteLength));
    while (endIdx > 0 && (encoded[endIdx] & 0xc0) === 0x80) {
        endIdx--;
    }
    const prefix = UTF8_DECODER.decode(encoded.subarray(0, endIdx));
    const combined = `${prefix}${suffix}`;
    return {
        text: combined,
        truncated: true,
        byteLength: UTF8_ENCODER.encode(combined).byteLength,
    };
}

export class TurnController {
    constructor(onEvent, budgets = {}) {
        this._onEvent = onEvent;
        this._budgets = {
            ...DEFAULT_TURN_BUDGETS,
            ...(budgets || {}),
        };
        this._seq = 0;
        this._activeTurn = null;
        this._disposed = false;
    }

    get activeTurn() {
        return this._activeTurn;
    }

    get state() {
        return this._activeTurn && !this._activeTurn.finalized ? this._activeTurn.state : 'idle';
    }

    get isBusy() {
        return Boolean(this._activeTurn && !this._activeTurn.finalized);
    }

    beginTurn(meta = {}) {
        if (this._disposed) {
            throw new Error('客户端已关闭');
        }
        if (this._activeTurn && !this._activeTurn.finalized) {
            throw new Error('上一轮请求仍在执行中');
        }
        const seq = ++this._seq;
        const turnId = String(meta.turnId || '').trim() || `turn_${seq}`;
        const messageId = String(meta.messageId || '').trim() || `msg_${seq}`;
        const budgets = {
            ...this._budgets,
            ...(meta.budgets || {}),
        };
        const turn = {
            id: turnId,
            messageId,
            sessionId: String(meta.sessionId || ''),
            clientGeneration: Number(meta.clientGeneration || 0),
            lifecycleGeneration: Number(meta.lifecycleGeneration || 0),
            state: 'starting',
            backend: meta.backend || '',
            modelId: String(meta.modelId || ''),
            replyTo: String(meta.replyTo || ''),
            promptText: meta.promptText || '',
            cancellable: meta.cancellable || null,
            process: null,
            processGroupId: 0,
            stdin: null,
            tempFiles: [],
            deferTempCleanupUntilProcessExit: Boolean(meta.deferTempCleanupUntilProcessExit),
            budgets,
            text: '',
            thinking: '',
            textSegments: new Map(),
            thinkingSegments: new Map(),
            textBytesUsed: 0,
            thinkingBytesUsed: 0,
            toolEventsBytesUsed: 0,
            textBudgetTruncated: false,
            thinkingBudgetTruncated: false,
            toolEventsBudgetTruncated: false,
            error: '',
            aborted: false,
            timedOut: false,
            interrupted: false,
            finalized: false,
            sawDoneMarker: false,
            sawMessageEnd: false,
            pendingApprovals: new Set(),
            approvalRequests: new Map(),
            toolExecutions: new Map(),
            activeToolIds: new Set(),
            anonToolSeq: 0,
            watchdogPhase: 'stream_idle',
            activeTimeoutSec: 0,
            totalTurnTimeoutSec: 0,
            timedOutPhase: '',
            stdinWriteChain: Promise.resolve(),
            cleanupWatchdog: null,
            resetWatchdog: null,
            pauseWatchdog: null,
            setWatchdogPhase: null,
            startApprovalWatchdog: null,
            clearApprovalWatchdog: null,
        };
        this._activeTurn = turn;
        return turn;
    }

    isCurrent(turn) {
        return Boolean(!this._disposed && turn && !turn.finalized && this._activeTurn === turn);
    }

    matchesIdentity(turn, {turnId = '', clientGeneration = null, sessionId = ''} = {}) {
        if (!this.isCurrent(turn)) return false;
        if (turnId && turn.id !== turnId) return false;
        if (clientGeneration !== null && clientGeneration !== undefined && turn.clientGeneration !== Number(clientGeneration)) {
            return false;
        }
        if (sessionId && turn.sessionId && turn.sessionId !== sessionId) return false;
        return true;
    }

    getEffectiveWatchdogPhase(turn) {
        if (!turn || turn.finalized) return 'settled';
        if (turn.pendingApprovals && turn.pendingApprovals.size > 0) return 'approval_wait';
        if (turn.activeToolIds && turn.activeToolIds.size > 0) return 'tool_execution';
        return 'stream_idle';
    }

    markStreaming(turn) {
        if (!this.isCurrent(turn)) return false;
        if (turn.pendingApprovals.size > 0) {
            turn.state = 'awaiting_approval';
            turn.watchdogPhase = 'approval_wait';
            return true;
        }
        if (turn.state === 'starting' || turn.state === 'awaiting_approval') {
            turn.state = 'streaming';
        }
        turn.watchdogPhase = this.getEffectiveWatchdogPhase(turn);
        return true;
    }

    enterApproval(turn, requestId, meta = {}) {
        if (!this.isCurrent(turn)) return false;
        const cleanId = String(requestId || '').trim();
        const wasEmpty = turn.pendingApprovals.size === 0;
        const cleanToolCallId = String(meta?.toolCallId || '').trim();
        if (cleanId) {
            turn.pendingApprovals.add(cleanId);
            const existing = turn.approvalRequests.get(cleanId);
            if (!existing) {
                turn.approvalRequests.set(cleanId, {
                    requestId: cleanId,
                    turnId: turn.id,
                    toolCallId: cleanToolCallId,
                    toolName: String(meta?.toolName || ''),
                    input: meta?.rawInput ?? meta?.input ?? null,
                    questions: Array.isArray(meta?.questions) ? meta.questions : null,
                    isQuestion: Boolean(meta?.isQuestion),
                    scopeKey: String(meta?.scopeKey || ''),
                    allowSessionRule: Boolean(meta?.allowSessionRule),
                    state: 'pending_approval',
                    requestedDecision: '',
                    requestedAlwaysAllow: false,
                    requestedScopeKey: '',
                    requestedModifiedInput: undefined,
                    inFlightPromise: null,
                    clearAckTimer: null,
                    ackWaiters: [],
                    resolvedPayload: null,
                });
            } else {
                if (cleanToolCallId && !existing.toolCallId) existing.toolCallId = cleanToolCallId;
                if (meta?.toolName && !existing.toolName) existing.toolName = String(meta.toolName);
                if ((meta?.rawInput || meta?.input) && !existing.input) existing.input = meta.rawInput ?? meta.input;
                if (Array.isArray(meta?.questions) && !existing.questions) existing.questions = meta.questions;
                if (meta?.isQuestion) existing.isQuestion = true;
                if (meta?.scopeKey && !existing.scopeKey) existing.scopeKey = String(meta.scopeKey);
                if (typeof meta?.allowSessionRule === 'boolean') existing.allowSessionRule = meta.allowSessionRule;
            }
            if (cleanToolCallId) {
                const toolEntry = turn.toolExecutions.get(cleanToolCallId);
                if (!toolEntry) {
                    turn.toolExecutions.set(cleanToolCallId, {
                        toolCallId: cleanToolCallId,
                        requestId: cleanId,
                        toolName: String(meta?.toolName || '工具'),
                        status: 'pending_approval',
                        approvalState: 'pending',
                        summary: String(meta?.summary || ''),
                        detail: '',
                        isError: false,
                        duration: 0,
                        syntheticId: false,
                    });
                } else {
                    toolEntry.requestId = cleanId;
                    if (toolEntry.status !== 'done' && toolEntry.status !== 'error' && toolEntry.status !== 'denied') {
                        toolEntry.status = 'pending_approval';
                        toolEntry.approvalState = 'pending';
                        turn.activeToolIds.delete(cleanToolCallId);
                    }
                }
            }
        }
        turn.state = 'awaiting_approval';
        turn.watchdogPhase = 'approval_wait';
        turn.pauseWatchdog?.();
        if (wasEmpty || turn.pendingApprovals.size > 0) {
            turn.startApprovalWatchdog?.();
        }
        return true;
    }

    getApprovalEntry(turn, requestId) {
        if (!turn?.approvalRequests) return null;
        return turn.approvalRequests.get(String(requestId || '').trim()) || null;
    }

    markApprovalWriteCompleted(turn, requestId) {
        if (!this.isCurrent(turn)) {
            return {ok: false, stale: true, state: 'cancelled'};
        }
        const cleanId = String(requestId || '').trim();
        const entry = turn.approvalRequests.get(cleanId);
        if (!entry) {
            return {ok: false, state: 'unknown'};
        }
        if (entry.state !== 'sending_approval') {
            return {ok: true, alreadySettled: true, state: entry.state};
        }
        entry.state = 'awaiting_ack';
        return {ok: true, alreadySettled: false, state: 'awaiting_ack'};
    }

    markApprovalAckTimedOut(turn, requestId, reason = 'bridge_ack_timeout') {
        if (!this.isCurrent(turn)) return false;
        const cleanId = String(requestId || '').trim();
        const entry = turn.approvalRequests.get(cleanId);
        if (!entry || (entry.state !== 'sending_approval' && entry.state !== 'awaiting_ack')) {
            return false;
        }
        try { entry.clearAckTimer?.(); } catch (_) {}
        entry.clearAckTimer = null;
        entry.inFlightPromise = null;
        entry.state = 'ack_timeout';
        const waiters = entry.ackWaiters.splice(0);
        for (const resolve of waiters) {
            try { resolve({acked: false, timedOut: true, reason}); } catch (_) {}
        }
        this.emitForTurn(turn, {
            type: 'permission_ack_timeout',
            requestId: cleanId,
            toolCallId: entry.toolCallId || '',
            toolName: entry.toolName || '',
            reason,
        });
        return true;
    }

    resolveApprovalFromBridge(turn, event = {}, {approvedScopes = null} = {}) {
        if (!this.isCurrent(turn)) return false;
        const cleanId = String(event.requestId || '').trim();
        if (!cleanId) return false;
        const entry = turn.approvalRequests.get(cleanId);
        const ackDecision = String(event.decision || '');
        const allow = (ackDecision === 'allow' || ackDecision === 'modify') && !event.timedOut;
        const toolCallId = String(event.toolCallId || entry?.toolCallId || '').trim();

        if (entry) {
            try { entry.clearAckTimer?.(); } catch (_) {}
            entry.clearAckTimer = null;
            entry.inFlightPromise = null;
            entry.state = event.timedOut ? 'timed_out' : 'resolved';
            entry.resolvedPayload = event;

            const ackScopeKey = String(event.scopeKey || '').trim();
            if (
                approvedScopes &&
                ackDecision === 'allow' &&
                !event.timedOut &&
                ackScopeKey &&
                (!entry.scopeKey || entry.scopeKey === ackScopeKey) &&
                (entry.allowSessionRule || event.sessionScopeSaved) &&
                (entry.requestedAlwaysAllow || event.sessionScopeSaved || event.autoApproved)
            ) {
                approvedScopes.add(ackScopeKey);
            }

            const waiters = entry.ackWaiters.splice(0);
            for (const resolve of waiters) {
                try {
                    resolve({
                        acked: true,
                        decision: ackDecision,
                        timedOut: Boolean(event.timedOut),
                        autoApproved: Boolean(event.autoApproved),
                        scopeKey: ackScopeKey,
                    });
                } catch (_) {}
            }
        }

        if (toolCallId) {
            const toolEntry = turn.toolExecutions.get(toolCallId);
            if (toolEntry) {
                toolEntry.approvalState = !allow
                    ? (event.timedOut ? 'timed_out' : 'denied')
                    : (event.autoApproved || event.sessionScopeSaved ? 'always' : 'allowed');
                if (!allow) {
                    toolEntry.status = 'denied';
                    turn.activeToolIds.delete(toolCallId);
                } else if (toolEntry.status === 'pending_approval' || toolEntry.status === 'sending_approval') {
                    if (toolEntry.earlyExecutionEnd) {
                        toolEntry.status = toolEntry.earlyExecutionEnd.status;
                        turn.activeToolIds.delete(toolCallId);
                    } else {
                        toolEntry.status = 'running';
                        turn.activeToolIds.add(toolCallId);
                    }
                }
            }
        }

        return this.leaveApproval(turn, cleanId);
    }

    rejectApprovalResponseFromBridge(turn, event = {}) {
        if (!this.isCurrent(turn)) return false;
        const cleanId = String(event.requestId || '').trim();
        if (!cleanId) return false;
        const reason = String(event.reason || 'rejected');
        const entry = turn.approvalRequests.get(cleanId);
        if (entry) {
            try { entry.clearAckTimer?.(); } catch (_) {}
            entry.clearAckTimer = null;
            entry.inFlightPromise = null;
            entry.state = 'rejected';
            const waiters = entry.ackWaiters.splice(0);
            for (const resolve of waiters) {
                try {
                    resolve({
                        acked: false,
                        rejected: reason,
                    });
                } catch (_) {}
            }
        }
        if (reason === 'unknown_or_expired_request_id') {
            this.leaveApproval(turn, cleanId);
        }
        return true;
    }

    leaveApproval(turn, requestId) {
        if (!this.isCurrent(turn)) return false;
        const cleanId = String(requestId || '').trim();
        if (cleanId) {
            turn.pendingApprovals.delete(cleanId);
            const entry = turn.approvalRequests.get(cleanId);
            if (entry) {
                try { entry.clearAckTimer?.(); } catch (_) {}
                entry.clearAckTimer = null;
                entry.inFlightPromise = null;
                if (entry.state === 'pending_approval' || entry.state === 'sending_approval' || entry.state === 'awaiting_ack') {
                    entry.state = 'resolved';
                }
            }
        }
        if (turn.pendingApprovals.size === 0) {
            turn.clearApprovalWatchdog?.();
            turn.state = 'streaming';
            turn.watchdogPhase = this.getEffectiveWatchdogPhase(turn);
            turn.resetWatchdog?.();
        } else {
            turn.state = 'awaiting_approval';
            turn.watchdogPhase = 'approval_wait';
            turn.pauseWatchdog?.();
        }
        return true;
    }

    /**
     * Records a `tool_execution_start` event idempotently in `turn.toolExecutions` (`Map<toolCallId, state>`)
     * and `turn.activeToolIds` (`Set<toolCallId>`). Duplicate start events for the same `toolCallId`
     * update metadata without double-counting or resurrecting already-finished tools (R7).
     */
    recordToolStart(turn, event = {}) {
        if (!this.isCurrent(turn)) return null;
        const explicitId = String(event.toolCallId || event.requestId || '').trim();
        const isSynthetic = !explicitId;
        const toolCallId = explicitId || `anon_tool_${++turn.anonToolSeq}`;
        let entry = turn.toolExecutions.get(toolCallId);

        if (!entry) {
            entry = {
                toolCallId,
                requestId: String(event.requestId || ''),
                toolName: String(event.toolName || '工具'),
                status: 'running',
                approvalState: '',
                summary: String(event.summary || ''),
                detail: String(event.detail || ''),
                isError: false,
                duration: 0,
                syntheticId: isSynthetic,
            };
            turn.toolExecutions.set(toolCallId, entry);
            turn.activeToolIds.add(toolCallId);
        } else {
            if (event.toolName && event.toolName !== '工具' && (!entry.toolName || entry.toolName === '工具')) {
                entry.toolName = String(event.toolName);
            }
            if (event.summary && !entry.summary) {
                entry.summary = String(event.summary);
            }
            if (event.detail) {
                entry.detail = String(event.detail);
            }
            const isTerminal =
                entry.status === 'done' ||
                entry.status === 'error' ||
                entry.status === 'denied' ||
                entry.status === 'interrupted' ||
                entry.status === 'unknown';
            if (!isTerminal && entry.status !== 'pending_approval' && entry.status !== 'sending_approval') {
                entry.status = 'running';
                turn.activeToolIds.add(toolCallId);
            }
        }
        turn.watchdogPhase = this.getEffectiveWatchdogPhase(turn);
        return entry;
    }

    /**
     * Records a `tool_execution_update` event idempotently in `turn.toolExecutions` without
     * incrementing active tool counts when the tool is already running (R7).
     */
    recordToolUpdate(turn, event = {}) {
        if (!this.isCurrent(turn)) return null;
        const explicitId = String(event.toolCallId || event.requestId || '').trim();
        if (!explicitId) {
            turn.watchdogPhase = this.getEffectiveWatchdogPhase(turn);
            return null;
        }
        return this.recordToolStart(turn, event);
    }

    /**
     * Records a `tool_execution_end` event strictly by `toolCallId` (never guessing by `toolName`).
     * Handles result-before-ACK, duplicate `tool_execution_end`, and `tool_execution_end` without a prior start (R7).
     */
    recordToolEnd(turn, event = {}) {
        if (!this.isCurrent(turn)) return null;
        const explicitId = String(event.toolCallId || event.requestId || '').trim();
        const nextStatus = getToolEndStatus(event);
        const isError = nextStatus === 'error';

        if (!explicitId) {
            const orphanId = `unmatched_end_${++turn.anonToolSeq}`;
            const orphanEntry = {
                toolCallId: orphanId,
                requestId: '',
                toolName: String(event.toolName || '工具'),
                status: nextStatus,
                approvalState: '',
                summary: String(event.summary || ''),
                detail: String(event.detail || ''),
                isError,
                duration: typeof event.duration === 'number' && event.duration > 0 ? event.duration : 0,
                syntheticId: true,
                startedWithoutStartEvent: true,
            };
            turn.toolExecutions.set(orphanId, orphanEntry);
            turn.watchdogPhase = this.getEffectiveWatchdogPhase(turn);
            return orphanEntry;
        }

        let entry = turn.toolExecutions.get(explicitId);
        if (!entry) {
            entry = {
                toolCallId: explicitId,
                requestId: String(event.requestId || ''),
                toolName: String(event.toolName || '工具'),
                status: nextStatus,
                approvalState: '',
                summary: String(event.summary || ''),
                detail: String(event.detail || ''),
                isError,
                duration: typeof event.duration === 'number' && event.duration > 0 ? event.duration : 0,
                syntheticId: false,
                startedWithoutStartEvent: true,
            };
            turn.toolExecutions.set(explicitId, entry);
        } else {
            turn.activeToolIds.delete(explicitId);
            if (event.detail && !entry.detail) {
                entry.detail = String(event.detail);
            }
            if (typeof event.duration === 'number' && event.duration > 0 && !entry.duration) {
                entry.duration = event.duration;
            }
            entry.earlyExecutionEnd = {
                status: nextStatus,
                detail: entry.detail || '',
                duration: entry.duration || 0,
            };
            if (entry.status !== 'done' && entry.status !== 'error' && entry.status !== 'denied') {
                entry.status = nextStatus;
                entry.isError = isError;
            }
        }
        turn.watchdogPhase = this.getEffectiveWatchdogPhase(turn);
        return entry;
    }

    /**
     * Records a `tool_batch_end` event. Only updates tools whose `toolCallId` is explicitly listed
     * in `event.toolCallIds`. Missing/empty `toolCallIds` never marks all running tools as done,
     * and running tools in the batch without an explicit individual result transition to `'unknown'`
     * unless the batch explicitly specifies their status (R7).
     */
    recordToolBatchEnd(turn, event = {}) {
        if (!this.isCurrent(turn)) return [];
        const ids = Array.isArray(event.toolCallIds)
            ? event.toolCallIds.map(id => String(id || '').trim()).filter(Boolean)
            : [];
        if (ids.length === 0) {
            turn.watchdogPhase = this.getEffectiveWatchdogPhase(turn);
            return [];
        }
        const updated = [];
        for (const id of ids) {
            const entry = turn.toolExecutions.get(id);
            if (!entry) continue;
            turn.activeToolIds.delete(id);
            if (entry.status === 'running') {
                entry.status = getToolBatchStatus(event, id);
                entry.isError = entry.status === 'error';
                updated.push(entry);
            }
        }
        turn.watchdogPhase = this.getEffectiveWatchdogPhase(turn);
        return updated;
    }

    _applyAggregatedText(turn, nextAggregated) {
        if (nextAggregated === turn.text) return true;
        if (nextAggregated.startsWith(turn.text)) {
            const delta = nextAggregated.slice(turn.text.length);
            turn.text = nextAggregated;
            if (delta) {
                this._onEvent?.({
                    turnId: turn.id,
                    messageId: turn.messageId,
                    sessionId: turn.sessionId,
                    clientGeneration: turn.clientGeneration,
                    type: 'message_update',
                    assistantMessageEvent: {type: 'text_delta', delta},
                });
            }
            return true;
        }
        turn.text = nextAggregated;
        this._onEvent?.({
            turnId: turn.id,
            messageId: turn.messageId,
            sessionId: turn.sessionId,
            clientGeneration: turn.clientGeneration,
            type: 'message_update',
            assistantMessageEvent: {type: 'text_replace', text: nextAggregated},
        });
        return true;
    }

    _applyAggregatedThinking(turn, nextAggregated) {
        if (nextAggregated === turn.thinking) return true;
        if (nextAggregated.startsWith(turn.thinking)) {
            const delta = nextAggregated.slice(turn.thinking.length);
            turn.thinking = nextAggregated;
            if (delta) {
                this._onEvent?.({
                    turnId: turn.id,
                    messageId: turn.messageId,
                    sessionId: turn.sessionId,
                    clientGeneration: turn.clientGeneration,
                    type: 'message_update',
                    assistantMessageEvent: {type: 'thinking_delta', delta},
                });
            }
            return true;
        }
        turn.thinking = nextAggregated;
        this._onEvent?.({
            turnId: turn.id,
            messageId: turn.messageId,
            sessionId: turn.sessionId,
            clientGeneration: turn.clientGeneration,
            type: 'message_update',
            assistantMessageEvent: {type: 'thinking_replace', thinking: nextAggregated},
        });
        return true;
    }

    appendText(turn, delta, segmentId = '') {
        if (!this.isCurrent(turn) || !delta) return false;
        if (turn.pendingApprovals.size === 0 && turn.state !== 'cancelling') {
            turn.state = 'streaming';
        }
        if (turn.textBudgetTruncated) {
            return true;
        }
        const segKey = String(segmentId || '__primary__');
        turn.textSegments.set(segKey, (turn.textSegments.get(segKey) || '') + delta);
        let aggregated = turn.textSegments.size <= 1
            ? (turn.textSegments.get(segKey) || '')
            : Array.from(turn.textSegments.values()).filter(Boolean).join('\n\n');
        const maxBytes = Math.max(1024, Number(turn.budgets?.maxTurnTextBytes) || DEFAULT_TURN_BUDGETS.maxTurnTextBytes);
        const capped = truncateUtf8ToBytes(
            aggregated,
            maxBytes,
            '\n\n… [输出已达单轮内存上限，已截断]'
        );
        if (capped.truncated) {
            turn.textBudgetTruncated = true;
            aggregated = capped.text;
            turn.textSegments.clear();
            turn.textSegments.set('__primary__', aggregated);
        }
        turn.textBytesUsed = capped.byteLength;
        return this._applyAggregatedText(turn, aggregated);
    }

    replaceText(turn, nextText, segmentId = '') {
        if (!this.isCurrent(turn) || typeof nextText !== 'string') return false;
        if (turn.pendingApprovals.size === 0 && turn.state !== 'cancelling') {
            turn.state = 'streaming';
        }
        const segKey = String(segmentId || '__primary__');
        turn.textSegments.set(segKey, nextText);
        let aggregated = turn.textSegments.size <= 1
            ? nextText
            : Array.from(turn.textSegments.values()).filter(Boolean).join('\n\n');
        const maxBytes = Math.max(1024, Number(turn.budgets?.maxTurnTextBytes) || DEFAULT_TURN_BUDGETS.maxTurnTextBytes);
        const capped = truncateUtf8ToBytes(
            aggregated,
            maxBytes,
            '\n\n… [输出已达单轮内存上限，已截断]'
        );
        if (capped.truncated) {
            turn.textBudgetTruncated = true;
            aggregated = capped.text;
            turn.textSegments.clear();
            turn.textSegments.set('__primary__', aggregated);
        } else {
            turn.textBudgetTruncated = false;
        }
        turn.textBytesUsed = capped.byteLength;
        return this._applyAggregatedText(turn, aggregated);
    }

    appendThinking(turn, delta, segmentId = '') {
        if (!this.isCurrent(turn) || !delta) return false;
        if (turn.pendingApprovals.size === 0 && turn.state !== 'cancelling') {
            turn.state = 'streaming';
        }
        if (turn.thinkingBudgetTruncated) {
            return true;
        }
        const segKey = String(segmentId || '__primary__');
        turn.thinkingSegments.set(segKey, (turn.thinkingSegments.get(segKey) || '') + delta);
        let aggregated = turn.thinkingSegments.size <= 1
            ? (turn.thinkingSegments.get(segKey) || '')
            : Array.from(turn.thinkingSegments.values()).filter(Boolean).join('\n\n');
        const maxBytes = Math.max(1024, Number(turn.budgets?.maxTurnThinkingBytes) || DEFAULT_TURN_BUDGETS.maxTurnThinkingBytes);
        const capped = truncateUtf8ToBytes(
            aggregated,
            maxBytes,
            '\n\n… [思考过程已达单轮内存上限，已截断]'
        );
        if (capped.truncated) {
            turn.thinkingBudgetTruncated = true;
            aggregated = capped.text;
            turn.thinkingSegments.clear();
            turn.thinkingSegments.set('__primary__', aggregated);
        }
        turn.thinkingBytesUsed = capped.byteLength;
        return this._applyAggregatedThinking(turn, aggregated);
    }

    replaceThinking(turn, nextThinking, segmentId = '') {
        if (!this.isCurrent(turn) || typeof nextThinking !== 'string') return false;
        if (turn.pendingApprovals.size === 0 && turn.state !== 'cancelling') {
            turn.state = 'streaming';
        }
        const segKey = String(segmentId || '__primary__');
        turn.thinkingSegments.set(segKey, nextThinking);
        let aggregated = turn.thinkingSegments.size <= 1
            ? nextThinking
            : Array.from(turn.thinkingSegments.values()).filter(Boolean).join('\n\n');
        const maxBytes = Math.max(1024, Number(turn.budgets?.maxTurnThinkingBytes) || DEFAULT_TURN_BUDGETS.maxTurnThinkingBytes);
        const capped = truncateUtf8ToBytes(
            aggregated,
            maxBytes,
            '\n\n… [思考过程已达单轮内存上限，已截断]'
        );
        if (capped.truncated) {
            turn.thinkingBudgetTruncated = true;
            aggregated = capped.text;
            turn.thinkingSegments.clear();
            turn.thinkingSegments.set('__primary__', aggregated);
        } else {
            turn.thinkingBudgetTruncated = false;
        }
        turn.thinkingBytesUsed = capped.byteLength;
        return this._applyAggregatedThinking(turn, aggregated);
    }

    emitForTurn(turn, event) {
        if (!this.isCurrent(turn) || !event) return false;
        let normalizedEvent = event;
        if (
            event.type === 'tool_execution_start' ||
            event.type === 'tool_execution_update' ||
            event.type === 'tool_execution_end'
        ) {
            const perEventCap = Math.max(
                256,
                Number(turn.budgets?.maxToolDetailBytesPerEvent) || DEFAULT_TURN_BUDGETS.maxToolDetailBytesPerEvent
            );
            const totalToolCap = Math.max(
                1024,
                Number(turn.budgets?.maxTurnToolEventsBytes) || DEFAULT_TURN_BUDGETS.maxTurnToolEventsBytes
            );
            normalizedEvent = {...event};
            for (const field of ['detail', 'output', 'result']) {
                if (typeof normalizedEvent[field] === 'string' && normalizedEvent[field].length > 0) {
                    const remainingBudget = Math.max(0, totalToolCap - turn.toolEventsBytesUsed);
                    if (remainingBudget <= 128) {
                        turn.toolEventsBudgetTruncated = true;
                        normalizedEvent[field] = '… [工具日志累计已达单轮上限，已省略详细输出]';
                        normalizedEvent.detailTruncated = true;
                    } else {
                        const effectiveCap = Math.min(perEventCap, remainingBudget);
                        const capped = truncateUtf8ToBytes(
                            normalizedEvent[field],
                            effectiveCap,
                            ' … [工具明细已按上限截断]'
                        );
                        normalizedEvent[field] = capped.text;
                        turn.toolEventsBytesUsed += capped.byteLength;
                        if (capped.truncated) {
                            normalizedEvent.detailTruncated = true;
                            if (effectiveCap < perEventCap) {
                                turn.toolEventsBudgetTruncated = true;
                            }
                        }
                    }
                }
            }
        }
        this._onEvent?.({
            ...normalizedEvent,
            turnId: turn.id,
            messageId: normalizedEvent.messageId || turn.messageId,
            sessionId: normalizedEvent.sessionId || turn.sessionId,
            clientGeneration: turn.clientGeneration,
        });
        return true;
    }

    /**
     * Cancels the active turn immediately so the user can send a new prompt right away,
     * while isolating any late async callbacks belonging to the cancelled turn.
     */
    cancelActiveTurn(options = {}) {
        const turn = this._activeTurn;
        if (!turn || turn.finalized) return null;
        turn.state = 'cancelling';
        turn.aborted = true;
        const normalized = typeof options === 'function' ? {onTerminateProcess: options} : (options || {});
        return this.finalizeTurn(turn, {
            ...normalized,
            status: 'cancelled',
            aborted: true,
        });
    }

    /**
     * Strictly idempotent turn finalizer.
     * Ensures `message_end` and `agent_settled` are emitted at most once per turn,
     * and never corrupts a subsequent turn started after cancellation.
     */
    finalizeTurn(turn, options = {}) {
        if (!turn || turn.finalized) return false;
        turn.finalized = true;

        const {
            status: explicitStatus = '',
            errorText = '',
            finishReason = turn.finishReason || '',
            usage = turn.usage || null,
            contextWindowTokens = turn.contextWindowTokens || 0,
            reasoningEffort = turn.reasoningEffort || '',
            aborted = turn.aborted,
            timedOut = turn.timedOut,
            interrupted = turn.interrupted,
            onPersistAssistant = null,
            onTerminateProcess = null,
            onCleanupTempFiles = null,
            onBeforeSettle = null,
        } = options;

        const cleanFinishReason = typeof finishReason === 'string' ? finishReason.trim() : '';
        if (cleanFinishReason) {
            turn.finishReason = cleanFinishReason;
        }
        if (usage && typeof usage === 'object') {
            turn.usage = usage;
        }
        if (Number(contextWindowTokens) > 0) {
            turn.contextWindowTokens = Number(contextWindowTokens);
        }
        if (typeof reasoningEffort === 'string' && reasoningEffort.trim()) {
            turn.reasoningEffort = reasoningEffort.trim();
        }
        turn.aborted = Boolean(aborted || explicitStatus === 'cancelled');
        turn.timedOut = Boolean(timedOut || explicitStatus === 'timed_out');
        turn.interrupted = Boolean(interrupted || explicitStatus === 'interrupted');
        turn.pendingApprovals.clear();

        if (errorText && !turn.error) {
            turn.error = String(errorText);
        }

        try { turn.cleanupWatchdog?.(); } catch (_) {}
        try { turn.clearApprovalWatchdog?.(); } catch (_) {}
        turn.cleanupWatchdog = null;
        turn.resetWatchdog = null;
        turn.pauseWatchdog = null;
        turn.setWatchdogPhase = null;
        turn.startApprovalWatchdog = null;
        turn.clearApprovalWatchdog = null;

        if (turn.aborted || turn.timedOut) {
            try { turn.cancellable?.cancel?.(); } catch (_) {}
        }

        const hadRunningProcess = Boolean(turn.process);
        if (turn.process && onTerminateProcess) {
            try { onTerminateProcess(turn.process, turn.aborted || turn.timedOut); } catch (_) {}
        }
        turn.process = null;
        turn.stdin = null;

        if (
            turn.tempFiles?.length &&
            onCleanupTempFiles &&
            !(turn.deferTempCleanupUntilProcessExit && hadRunningProcess)
        ) {
            try { onCleanupTempFiles(turn.tempFiles); } catch (_) {}
            turn.tempFiles = [];
        }

        if (TERMINAL_TURN_STATES.has(explicitStatus)) {
            turn.state = explicitStatus;
        } else if (turn.timedOut) {
            turn.state = 'timed_out';
        } else if (turn.aborted) {
            turn.state = 'cancelled';
        } else if (turn.interrupted) {
            turn.state = 'interrupted';
        } else if (turn.error) {
            turn.state = 'failed';
        } else {
            turn.state = 'completed';
        }

        turn.activeToolIds?.clear?.();
        if (turn.toolExecutions instanceof Map) {
            const isAbnormalExit = turn.state !== 'completed';
            for (const entry of turn.toolExecutions.values()) {
                if (entry.status === 'pending_approval' || entry.status === 'sending_approval') {
                    entry.status = (turn.state === 'cancelled' || turn.state === 'interrupted') ? 'interrupted' : 'denied';
                    entry.approvalState = turn.state === 'timed_out'
                        ? 'timed_out'
                        : ((turn.state === 'cancelled' || turn.state === 'interrupted') ? 'cancelled' : 'denied');
                } else if (entry.status === 'running') {
                    entry.status = isAbnormalExit ? 'interrupted' : 'unknown';
                }
            }
        }
        turn.watchdogPhase = 'settled';

        const wasActive = this._activeTurn === turn;
        if (wasActive) {
            this._activeTurn = null;
        }

        if (this._disposed || !wasActive) {
            return false;
        }

        const isPartial = turn.state !== 'completed' || turn.finishReason === 'length';

        if (turn.text) {
            const contentParts = [];
            if (turn.thinking) contentParts.push({type: 'thinking', thinking: turn.thinking});
            contentParts.push({type: 'text', text: turn.text});
            const persistedMsg = {
                id: turn.messageId,
                turnId: turn.id,
                ...(turn.replyTo ? {replyTo: turn.replyTo} : {}),
                ...(turn.modelId ? {modelId: turn.modelId} : {}),
                role: 'assistant',
                content: contentParts,
                status: turn.state,
                ...(isPartial ? {partial: true} : {}),
                ...(turn.finishReason ? {finishReason: turn.finishReason} : {}),
                ...(turn.usage ? {usage: turn.usage} : {}),
                ...(turn.contextWindowTokens ? {contextWindowTokens: turn.contextWindowTokens} : {}),
                ...(turn.reasoningEffort ? {reasoningEffort: turn.reasoningEffort} : {}),
                ...(turn.error && !turn.aborted ? {errorMessage: turn.error} : {}),
            };
            try { onPersistAssistant?.(persistedMsg); } catch (_) {}
            if (!turn.sawMessageEnd) {
                turn.sawMessageEnd = true;
                this._onEvent?.({
                    turnId: turn.id,
                    messageId: turn.messageId,
                    sessionId: turn.sessionId,
                    clientGeneration: turn.clientGeneration,
                    type: 'message_end',
                    status: turn.state,
                    partial: isPartial,
                    ...(turn.finishReason ? {finishReason: turn.finishReason} : {}),
                    ...(turn.usage ? {usage: turn.usage} : {}),
                    ...(turn.contextWindowTokens ? {contextWindowTokens: turn.contextWindowTokens} : {}),
                    ...(turn.reasoningEffort ? {reasoningEffort: turn.reasoningEffort} : {}),
                    message: {
                        id: turn.messageId,
                        role: 'assistant',
                        content: contentParts,
                        status: turn.state,
                        ...(isPartial ? {partial: true} : {}),
                        ...(turn.finishReason ? {finishReason: turn.finishReason} : {}),
                        ...(turn.usage ? {usage: turn.usage} : {}),
                        ...(turn.contextWindowTokens ? {contextWindowTokens: turn.contextWindowTokens} : {}),
                        ...(turn.reasoningEffort ? {reasoningEffort: turn.reasoningEffort} : {}),
                        ...(turn.error && !turn.aborted ? {errorMessage: turn.error} : {}),
                    },
                });
            }
        } else if (!turn.aborted && turn.error && !turn.sawMessageEnd) {
            turn.sawMessageEnd = true;
            this._onEvent?.({
                turnId: turn.id,
                messageId: turn.messageId,
                sessionId: turn.sessionId,
                clientGeneration: turn.clientGeneration,
                type: 'message_end',
                status: turn.state,
                partial: true,
                message: {
                    id: turn.messageId,
                    role: 'assistant',
                    content: '',
                    status: turn.state,
                    errorMessage: turn.error,
                },
            });
        }

        if (typeof onBeforeSettle === 'function') {
            try { onBeforeSettle(turn.state, turn); } catch (_) {}
        }

        this._onEvent?.({
            turnId: turn.id,
            messageId: turn.messageId,
            sessionId: turn.sessionId,
            clientGeneration: turn.clientGeneration,
            type: 'agent_settled',
            status: turn.state,
            ...(turn.finishReason === 'length' ? {partial: true} : {}),
            aborted: turn.state === 'cancelled',
            timedOut: turn.state === 'timed_out',
            interrupted: turn.state === 'interrupted',
            ...(turn.finishReason ? {finishReason: turn.finishReason} : {}),
            ...(turn.usage ? {usage: turn.usage} : {}),
            ...(turn.contextWindowTokens ? {contextWindowTokens: turn.contextWindowTokens} : {}),
            ...(turn.reasoningEffort ? {reasoningEffort: turn.reasoningEffort} : {}),
            errorMessage: turn.error || '',
        });
        return true;
    }

    dispose(onTerminateProcess = null, onCleanupTempFiles = null) {
        this._disposed = true;
        const turn = this._activeTurn;
        this._activeTurn = null;
        if (turn && !turn.finalized) {
            turn.finalized = true;
            turn.state = 'cancelled';
            if (turn.approvalRequests) {
                for (const entry of turn.approvalRequests.values()) {
                    try { entry.clearAckTimer?.(); } catch (_) {}
                    entry.clearAckTimer = null;
                    entry.inFlightPromise = null;
                    const waiters = entry.ackWaiters ? entry.ackWaiters.splice(0) : [];
                    for (const resolve of waiters) {
                        try { resolve({acked: false, cancelled: true}); } catch (_) {}
                    }
                }
                turn.approvalRequests.clear();
            }
            turn.pendingApprovals.clear();
            try { turn.cleanupWatchdog?.(); } catch (_) {}
            try { turn.clearApprovalWatchdog?.(); } catch (_) {}
            try { turn.cancellable?.cancel?.(); } catch (_) {}
            const hadRunningProcess = Boolean(turn.process);
            if (turn.process && onTerminateProcess) {
                try { onTerminateProcess(turn.process, true); } catch (_) {}
            }
            turn.process = null;
            turn.stdin = null;
            if (
                turn.tempFiles?.length &&
                onCleanupTempFiles &&
                !(turn.deferTempCleanupUntilProcessExit && hadRunningProcess)
            ) {
                try { onCleanupTempFiles(turn.tempFiles); } catch (_) {}
                turn.tempFiles = [];
            }
        }
    }
}
