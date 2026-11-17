/**
 * Pure JavaScript TurnContext & TurnController state machine (zero GJS dependencies).
 * Guarantees per-turn identity isolation, idempotent finalization, and single-settlement semantics.
 *
 * Canonical states (Stage B3):
 *   idle | starting | streaming | awaiting_approval | cancelling
 *   -> completed | cancelled | failed | interrupted | timed_out
 */

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

export class TurnController {
    constructor(onEvent) {
        this._onEvent = onEvent;
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
            text: '',
            thinking: '',
            textSegments: new Map(),
            thinkingSegments: new Map(),
            error: '',
            aborted: false,
            timedOut: false,
            interrupted: false,
            finalized: false,
            sawDoneMarker: false,
            sawMessageEnd: false,
            pendingApprovals: new Set(),
            approvalRequests: new Map(),
            stdinWriteChain: Promise.resolve(),
            cleanupWatchdog: null,
            resetWatchdog: null,
            pauseWatchdog: null,
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

    markStreaming(turn) {
        if (!this.isCurrent(turn)) return false;
        if (turn.pendingApprovals.size > 0) {
            turn.state = 'awaiting_approval';
            return true;
        }
        if (turn.state === 'starting' || turn.state === 'awaiting_approval') {
            turn.state = 'streaming';
        }
        return true;
    }

    enterApproval(turn, requestId, meta = {}) {
        if (!this.isCurrent(turn)) return false;
        const cleanId = String(requestId || '').trim();
        const wasEmpty = turn.pendingApprovals.size === 0;
        if (cleanId) {
            turn.pendingApprovals.add(cleanId);
            const existing = turn.approvalRequests.get(cleanId);
            if (!existing) {
                turn.approvalRequests.set(cleanId, {
                    requestId: cleanId,
                    turnId: turn.id,
                    toolCallId: String(meta?.toolCallId || ''),
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
                if (meta?.toolName && !existing.toolName) existing.toolName = String(meta.toolName);
                if ((meta?.rawInput || meta?.input) && !existing.input) existing.input = meta.rawInput ?? meta.input;
                if (Array.isArray(meta?.questions) && !existing.questions) existing.questions = meta.questions;
                if (meta?.isQuestion) existing.isQuestion = true;
                if (meta?.scopeKey && !existing.scopeKey) existing.scopeKey = String(meta.scopeKey);
                if (typeof meta?.allowSessionRule === 'boolean') existing.allowSessionRule = meta.allowSessionRule;
            }
        }
        turn.state = 'awaiting_approval';
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
        if (entry) {
            try { entry.clearAckTimer?.(); } catch (_) {}
            entry.clearAckTimer = null;
            entry.inFlightPromise = null;
            entry.state = event.timedOut ? 'timed_out' : 'resolved';
            entry.resolvedPayload = event;

            const ackDecision = String(event.decision || '');
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
            turn.resetWatchdog?.();
        }
        return true;
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
        const segKey = String(segmentId || '__primary__');
        turn.textSegments.set(segKey, (turn.textSegments.get(segKey) || '') + delta);
        const aggregated = turn.textSegments.size <= 1
            ? (turn.textSegments.get(segKey) || '')
            : Array.from(turn.textSegments.values()).filter(Boolean).join('\n\n');
        return this._applyAggregatedText(turn, aggregated);
    }

    replaceText(turn, nextText, segmentId = '') {
        if (!this.isCurrent(turn) || typeof nextText !== 'string') return false;
        if (turn.pendingApprovals.size === 0 && turn.state !== 'cancelling') {
            turn.state = 'streaming';
        }
        const segKey = String(segmentId || '__primary__');
        turn.textSegments.set(segKey, nextText);
        const aggregated = turn.textSegments.size <= 1
            ? nextText
            : Array.from(turn.textSegments.values()).filter(Boolean).join('\n\n');
        return this._applyAggregatedText(turn, aggregated);
    }

    appendThinking(turn, delta, segmentId = '') {
        if (!this.isCurrent(turn) || !delta) return false;
        if (turn.pendingApprovals.size === 0 && turn.state !== 'cancelling') {
            turn.state = 'streaming';
        }
        const segKey = String(segmentId || '__primary__');
        turn.thinkingSegments.set(segKey, (turn.thinkingSegments.get(segKey) || '') + delta);
        const aggregated = turn.thinkingSegments.size <= 1
            ? (turn.thinkingSegments.get(segKey) || '')
            : Array.from(turn.thinkingSegments.values()).filter(Boolean).join('\n\n');
        return this._applyAggregatedThinking(turn, aggregated);
    }

    replaceThinking(turn, nextThinking, segmentId = '') {
        if (!this.isCurrent(turn) || typeof nextThinking !== 'string') return false;
        if (turn.pendingApprovals.size === 0 && turn.state !== 'cancelling') {
            turn.state = 'streaming';
        }
        const segKey = String(segmentId || '__primary__');
        turn.thinkingSegments.set(segKey, nextThinking);
        const aggregated = turn.thinkingSegments.size <= 1
            ? nextThinking
            : Array.from(turn.thinkingSegments.values()).filter(Boolean).join('\n\n');
        return this._applyAggregatedThinking(turn, aggregated);
    }

    emitForTurn(turn, event) {
        if (!this.isCurrent(turn) || !event) return false;
        this._onEvent?.({
            ...event,
            turnId: turn.id,
            messageId: event.messageId || turn.messageId,
            sessionId: event.sessionId || turn.sessionId,
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
            aborted = turn.aborted,
            timedOut = turn.timedOut,
            interrupted = turn.interrupted,
            onPersistAssistant = null,
            onTerminateProcess = null,
            onCleanupTempFiles = null,
        } = options;

        const cleanFinishReason = typeof finishReason === 'string' ? finishReason.trim() : '';
        if (cleanFinishReason) {
            turn.finishReason = cleanFinishReason;
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

        const wasActive = this._activeTurn === turn;
        if (wasActive) {
            this._activeTurn = null;
        }

        if (this._disposed || !wasActive) {
            return false;
        }

        const isPartial = turn.state !== 'completed';

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
                    message: {
                        id: turn.messageId,
                        role: 'assistant',
                        content: contentParts,
                        status: turn.state,
                        ...(isPartial ? {partial: true} : {}),
                        ...(turn.finishReason ? {finishReason: turn.finishReason} : {}),
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

        this._onEvent?.({
            turnId: turn.id,
            messageId: turn.messageId,
            sessionId: turn.sessionId,
            clientGeneration: turn.clientGeneration,
            type: 'agent_settled',
            status: turn.state,
            aborted: turn.state === 'cancelled',
            timedOut: turn.state === 'timed_out',
            interrupted: turn.state === 'interrupted',
            ...(turn.finishReason ? {finishReason: turn.finishReason} : {}),
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
