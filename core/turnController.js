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
            promptText: meta.promptText || '',
            cancellable: meta.cancellable || null,
            process: null,
            processGroupId: 0,
            stdin: null,
            tempFiles: [],
            deferTempCleanupUntilProcessExit: Boolean(meta.deferTempCleanupUntilProcessExit),
            text: '',
            thinking: '',
            error: '',
            aborted: false,
            timedOut: false,
            interrupted: false,
            finalized: false,
            sawDoneMarker: false,
            sawMessageEnd: false,
            pendingApprovals: new Set(),
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

    enterApproval(turn, requestId) {
        if (!this.isCurrent(turn)) return false;
        const wasEmpty = turn.pendingApprovals.size === 0;
        if (requestId) turn.pendingApprovals.add(requestId);
        turn.state = 'awaiting_approval';
        turn.pauseWatchdog?.();
        if (wasEmpty || turn.pendingApprovals.size > 0) {
            turn.startApprovalWatchdog?.();
        }
        return true;
    }

    leaveApproval(turn, requestId) {
        if (!this.isCurrent(turn)) return false;
        if (requestId) {
            turn.pendingApprovals.delete(requestId);
        }
        if (turn.pendingApprovals.size === 0) {
            turn.clearApprovalWatchdog?.();
            turn.state = 'streaming';
            turn.resetWatchdog?.();
        }
        return true;
    }

    appendText(turn, delta) {
        if (!this.isCurrent(turn) || !delta) return false;
        if (turn.pendingApprovals.size === 0 && turn.state !== 'cancelling') {
            turn.state = 'streaming';
        }
        turn.text += delta;
        this._onEvent?.({
            turnId: turn.id,
            messageId: turn.messageId,
            sessionId: turn.sessionId,
            clientGeneration: turn.clientGeneration,
            type: 'message_update',
            assistantMessageEvent: {type: 'text_delta', delta},
        });
        return true;
    }

    replaceText(turn, nextText) {
        if (!this.isCurrent(turn) || typeof nextText !== 'string') return false;
        if (turn.pendingApprovals.size === 0 && turn.state !== 'cancelling') {
            turn.state = 'streaming';
        }
        if (nextText === turn.text) return true;
        if (nextText.startsWith(turn.text)) {
            const delta = nextText.slice(turn.text.length);
            turn.text = nextText;
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
        turn.text = nextText;
        this._onEvent?.({
            turnId: turn.id,
            messageId: turn.messageId,
            sessionId: turn.sessionId,
            clientGeneration: turn.clientGeneration,
            type: 'message_update',
            assistantMessageEvent: {type: 'text_replace', text: nextText},
        });
        return true;
    }

    appendThinking(turn, delta) {
        if (!this.isCurrent(turn) || !delta) return false;
        if (turn.pendingApprovals.size === 0 && turn.state !== 'cancelling') {
            turn.state = 'streaming';
        }
        turn.thinking += delta;
        this._onEvent?.({
            turnId: turn.id,
            messageId: turn.messageId,
            sessionId: turn.sessionId,
            clientGeneration: turn.clientGeneration,
            type: 'message_update',
            assistantMessageEvent: {type: 'thinking_delta', delta},
        });
        return true;
    }

    replaceThinking(turn, nextThinking) {
        if (!this.isCurrent(turn) || typeof nextThinking !== 'string') return false;
        if (turn.pendingApprovals.size === 0 && turn.state !== 'cancelling') {
            turn.state = 'streaming';
        }
        if (nextThinking === turn.thinking) return true;
        if (nextThinking.startsWith(turn.thinking)) {
            const delta = nextThinking.slice(turn.thinking.length);
            turn.thinking = nextThinking;
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
        turn.thinking = nextThinking;
        this._onEvent?.({
            turnId: turn.id,
            messageId: turn.messageId,
            sessionId: turn.sessionId,
            clientGeneration: turn.clientGeneration,
            type: 'message_update',
            assistantMessageEvent: {type: 'thinking_replace', thinking: nextThinking},
        });
        return true;
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
            aborted = turn.aborted,
            timedOut = turn.timedOut,
            interrupted = turn.interrupted,
            onPersistAssistant = null,
            onTerminateProcess = null,
            onCleanupTempFiles = null,
        } = options;

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
                role: 'assistant',
                content: contentParts,
                status: turn.state,
                ...(isPartial ? {partial: true} : {}),
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
                    message: {
                        id: turn.messageId,
                        role: 'assistant',
                        content: contentParts,
                        status: turn.state,
                        ...(isPartial ? {partial: true} : {}),
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
