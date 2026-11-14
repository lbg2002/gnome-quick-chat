/**
 * Pure JavaScript TurnContext & TurnController state machine (zero GJS dependencies).
 * Guarantees per-turn cancellation isolation, idempotent finalization, and single-settlement semantics.
 *
 * State transitions:
 *   idle -> starting -> streaming <-> awaiting_approval -> cancelling -> completed | failed
 */
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
        const turn = {
            id: `turn_${++this._seq}`,
            state: 'starting',
            backend: meta.backend || '',
            promptText: meta.promptText || '',
            cancellable: meta.cancellable || null,
            process: null,
            stdin: null,
            tempFiles: [],
            text: '',
            thinking: '',
            error: '',
            aborted: false,
            finalized: false,
            sawDoneMarker: false,
            sawMessageEnd: false,
            pendingApprovals: new Set(),
            cleanupWatchdog: null,
            resetWatchdog: null,
            pauseWatchdog: null,
        };
        this._activeTurn = turn;
        return turn;
    }

    isCurrent(turn) {
        return Boolean(!this._disposed && turn && !turn.finalized && this._activeTurn === turn);
    }

    markStreaming(turn) {
        if (!this.isCurrent(turn)) return false;
        if (turn.state === 'starting' || turn.state === 'awaiting_approval') {
            turn.state = 'streaming';
        }
        return true;
    }

    enterApproval(turn, requestId) {
        if (!this.isCurrent(turn)) return false;
        if (requestId) turn.pendingApprovals.add(requestId);
        turn.state = 'awaiting_approval';
        turn.pauseWatchdog?.();
        return true;
    }

    leaveApproval(turn, requestId) {
        if (!this.isCurrent(turn)) return false;
        if (requestId) turn.pendingApprovals.delete(requestId);
        if (turn.pendingApprovals.size === 0) {
            turn.state = 'streaming';
            turn.resetWatchdog?.();
        }
        return true;
    }

    appendText(turn, delta) {
        if (!this.isCurrent(turn) || !delta) return false;
        turn.state = 'streaming';
        turn.text += delta;
        this._onEvent?.({
            turnId: turn.id,
            type: 'message_update',
            assistantMessageEvent: {type: 'text_delta', delta},
        });
        return true;
    }

    appendThinking(turn, delta) {
        if (!this.isCurrent(turn) || !delta) return false;
        turn.state = 'streaming';
        turn.thinking += delta;
        this._onEvent?.({
            turnId: turn.id,
            type: 'message_update',
            assistantMessageEvent: {type: 'thinking_delta', delta},
        });
        return true;
    }

    emitForTurn(turn, event) {
        if (!this.isCurrent(turn) || !event) return false;
        this._onEvent?.({...event, turnId: turn.id});
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
            errorText = '',
            aborted = turn.aborted,
            onPersistAssistant = null,
            onTerminateProcess = null,
            onCleanupTempFiles = null,
        } = options;

        turn.aborted = Boolean(aborted);
        if (errorText && !turn.error) {
            turn.error = String(errorText);
        }

        try { turn.cleanupWatchdog?.(); } catch (_) {}
        turn.cleanupWatchdog = null;
        turn.resetWatchdog = null;
        turn.pauseWatchdog = null;

        if (turn.aborted) {
            try { turn.cancellable?.cancel?.(); } catch (_) {}
        }

        if (turn.process && onTerminateProcess) {
            try { onTerminateProcess(turn.process, turn.aborted); } catch (_) {}
        }
        turn.process = null;
        turn.stdin = null;

        if (turn.tempFiles?.length && onCleanupTempFiles) {
            try { onCleanupTempFiles(turn.tempFiles); } catch (_) {}
            turn.tempFiles = [];
        }

        turn.state = turn.error && !turn.aborted ? 'failed' : 'completed';

        const wasActive = this._activeTurn === turn;
        if (wasActive) {
            this._activeTurn = null;
        }

        if (this._disposed || !wasActive) {
            return false;
        }

        // Persist assistant response if non-empty
        if (turn.text) {
            const contentParts = [];
            if (turn.thinking) contentParts.push({type: 'thinking', thinking: turn.thinking});
            contentParts.push({type: 'text', text: turn.text});
            try { onPersistAssistant?.({role: 'assistant', content: contentParts}); } catch (_) {}
            if (!turn.sawMessageEnd) {
                turn.sawMessageEnd = true;
                this._onEvent?.({
                    turnId: turn.id,
                    type: 'message_end',
                    message: {
                        role: 'assistant',
                        content: contentParts,
                        ...(turn.error && !turn.aborted ? {errorMessage: turn.error} : {}),
                    },
                });
            }
        } else if (!turn.aborted && turn.error && !turn.sawMessageEnd) {
            turn.sawMessageEnd = true;
            this._onEvent?.({
                turnId: turn.id,
                type: 'message_end',
                message: {role: 'assistant', content: '', errorMessage: turn.error},
            });
        }

        this._onEvent?.({
            turnId: turn.id,
            type: 'agent_settled',
            aborted: Boolean(turn.aborted),
        });
        return true;
    }

    dispose(onTerminateProcess = null, onCleanupTempFiles = null) {
        this._disposed = true;
        const turn = this._activeTurn;
        this._activeTurn = null;
        if (turn && !turn.finalized) {
            turn.finalized = true;
            try { turn.cleanupWatchdog?.(); } catch (_) {}
            try { turn.cancellable?.cancel?.(); } catch (_) {}
            if (turn.process && onTerminateProcess) {
                try { onTerminateProcess(turn.process, true); } catch (_) {}
            }
            if (turn.tempFiles?.length && onCleanupTempFiles) {
                try { onCleanupTempFiles(turn.tempFiles); } catch (_) {}
            }
        }
    }
}
