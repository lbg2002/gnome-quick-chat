// Pure-JS Background Notification Policy & Rate-Limiting Gate (Stage F5).
// Supports strictly 3 background events:
//   - `approval_needed` (等待审批 / 交互提问)
//   - `turn_failed` (任务失败 / 超时 / 中断)
//   - `turn_completed` (回答完成)
// Enforces lock-screen/greeter suppression, visible-chat suppression, rate-limiting, deduplication,
// zero sensitive transcript/prompt exposure, and safe click-to-return navigation resolution.

export const DEFAULT_NOTIFICATION_COOLDOWN_MS = 4000;

export class BackgroundNotificationGate {
    constructor({
        cooldownMs = DEFAULT_NOTIFICATION_COOLDOWN_MS,
        maxRememberedKeys = 256,
    } = {}) {
        this._cooldownMs = Math.max(0, Number(cooldownMs ?? DEFAULT_NOTIFICATION_COOLDOWN_MS));
        this._maxRememberedKeys = Math.max(32, Number(maxRememberedKeys) || 256);
        this._seenKeys = new Set();
        this._lastSentByKindMs = new Map();
    }

    reset() {
        this._seenKeys.clear();
        this._lastSentByKindMs.clear();
    }

    _rememberKey(key) {
        if (this._seenKeys.has(key)) return;
        if (this._seenKeys.size >= this._maxRememberedKeys) {
            const oldest = this._seenKeys.values().next().value;
            if (oldest !== undefined) this._seenKeys.delete(oldest);
        }
        this._seenKeys.add(key);
    }

    /**
     * Evaluates whether a background status notification should be dispatched.
     * NEVER includes prompt text, model response正文, shell commands, or file paths in `title` or `body`!
     */
    evaluate({
        kind,
        sessionId = '',
        turnId = '',
        requestId = '',
        isQuestion = false,
        isChatVisible = false,
        isLocked = false,
        isGreeter = false,
        enabledSettings = {},
        nowMs = Date.now(),
    } = {}) {
        // Hard privacy boundary: NEVER notify or expose anything on lock screen / greeter
        if (isLocked || isGreeter) {
            return {shouldNotify: false, reason: 'locked'};
        }
        if (isChatVisible) {
            return {shouldNotify: false, reason: 'chat_visible'};
        }

        let enabled = false;
        let title = '';
        let body = '';

        if (kind === 'approval_needed') {
            enabled = enabledSettings.notifyOnApproval !== false;
            title = isQuestion ? '随问 · 等待您回答问题' : '随问 · 等待工具审批';
            body = isQuestion
                ? '后台任务需要您补充信息后继续，点击返回对应任务'
                : '后台任务正在等待您的安全审批，点击返回对应任务';
        } else if (kind === 'turn_failed') {
            enabled = enabledSettings.notifyOnError !== false;
            title = '随问 · 后台任务未完成';
            body = '后台任务执行失败或已超时，点击返回对应会话查看状态';
        } else if (kind === 'turn_completed') {
            enabled = Boolean(enabledSettings.notifyOnComplete);
            title = '随问 · 回答已完成';
            body = '后台回答已生成完毕，点击返回对应会话查看';
        } else {
            return {shouldNotify: false, reason: 'unknown_kind'};
        }

        if (!enabled) {
            return {shouldNotify: false, reason: 'disabled_by_setting'};
        }

        // Deduplicate per turn (and for burst parallel approvals within the same turn, notify once per turn
        // unless a new distinct turn requests approval, preventing multi-tool notification spam!)
        const dedupeKey = kind === 'approval_needed'
            ? `${kind}:${sessionId}:${turnId || requestId}`
            : `${kind}:${sessionId}:${turnId}`;

        if (dedupeKey && this._seenKeys.has(dedupeKey)) {
            return {shouldNotify: false, reason: 'deduplicated'};
        }

        const lastKindSent = this._lastSentByKindMs.get(kind) ?? -Infinity;
        if (this._cooldownMs > 0 && nowMs - lastKindSent < this._cooldownMs) {
            return {shouldNotify: false, reason: 'rate_limited'};
        }

        if (dedupeKey) {
            this._rememberKey(dedupeKey);
        }
        this._lastSentByKindMs.set(kind, nowMs);

        return {
            shouldNotify: true,
            reason: 'ok',
            title,
            body,
            target: {
                kind,
                sessionId: String(sessionId || ''),
                turnId: String(turnId || ''),
                requestId: String(requestId || ''),
            },
        };
    }
}

/**
 * Resolves what UI action to take when the user clicks a background notification.
 */
export function resolveNotificationClickTarget(target, {
    isLocked = false,
    isGreeter = false,
    isBusy = false,
    currentSessionId = '',
    activeTurnId = '',
    mountedTurnIds = [],
    storedTurnIds = [],
    existingSessionIds = [],
} = {}) {
    if (isLocked || isGreeter || !target) {
        return {action: 'ignore'};
    }

    const targetSessionId = String(target.sessionId || '');
    const targetTurnId = String(target.turnId || '');

    if (!targetSessionId || targetSessionId === currentSessionId) {
        if (targetTurnId) {
            const existsInCurrent =
                targetTurnId === activeTurnId ||
                mountedTurnIds.includes(targetTurnId) ||
                storedTurnIds.includes(targetTurnId);
            if (!existsInCurrent) {
                return {
                    action: 'open_current_missing_turn',
                    statusHint: '对应后台任务已结束或已被清理',
                };
            }
        }
        return {
            action: 'focus_current_turn',
            sessionId: currentSessionId,
            turnId: targetTurnId,
            requestId: String(target.requestId || ''),
        };
    }

    const sessionStillExists = existingSessionIds.includes(targetSessionId);
    if (!sessionStillExists) {
        return {
            action: 'open_current_missing_session',
            statusHint: '通知对应的历史会话已删除',
        };
    }

    if (isBusy) {
        return {
            action: 'open_current_busy',
            statusHint: '当前会话正在执行任务，完成后可切换回原会话查看',
        };
    }

    return {
        action: 'switch_session_and_focus',
        sessionId: targetSessionId,
        turnId: targetTurnId,
        requestId: String(target.requestId || ''),
    };
}
