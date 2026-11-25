// Pure-JS ChatController coordinating BackendRegistry, single-flight connection lifecycle,
// transactional config reconnects, security-context scope revocation, and turn identity isolation (Stage E).
// Zero GNOME/GJS imports so Node unit tests exercise real connection & turn coordination directly.

function createConnectionCancellable() {
    let cancelled = false;
    const listeners = [];
    return {
        is_cancelled() {
            return cancelled;
        },
        cancel() {
            if (cancelled) return;
            cancelled = true;
            while (listeners.length > 0) {
                const fn = listeners.shift();
                try { fn(); } catch (_) {}
            }
        },
        connect(fn) {
            if (typeof fn !== 'function') return 0;
            if (cancelled) {
                try { fn(); } catch (_) {}
                return 0;
            }
            listeners.push(fn);
            return listeners.length;
        },
        disconnect() {},
    };
}

export class ChatController {
    constructor({
        registry,
        createClient,
        loadRuntimeEnvironment,
        createCancellable = createConnectionCancellable,
        onEvent = () => {},
        onConnecting = () => {},
        onStateChanged = () => {},
        onConnectionError = () => {},
        scheduleDelay = (ms, cb) => {
            const t = setTimeout(cb, ms);
            return () => clearTimeout(t);
        },
    }) {
        this._registry = registry;
        this._createClient = createClient;
        this._loadRuntimeEnvironment = loadRuntimeEnvironment;
        this._createCancellable = createCancellable;
        this._onEvent = onEvent;
        this._onConnecting = onConnecting;
        this._onStateChanged = onStateChanged;
        this._onConnectionError = onConnectionError;
        this._scheduleDelay = scheduleDelay;

        this._disposed = false;
        this._lifecycleGeneration = 1;
        this._clientGeneration = 0;
        this._client = null;
        this._ready = false;
        this._busy = false;
        this._needsReconnect = false;
        this._ensurePromise = null;
        this._reconnectPromise = null;
        this._connectCancellable = null;
        this._cancelReconnectTimer = null;
        this._lastSecurityContextKey = '';
        this._activeTurnState = null;
        this._currentSessionId = '';
        this._lastState = null;
    }

    get client() {
        return this._client;
    }

    get ready() {
        return this._ready && !this._needsReconnect;
    }

    get busy() {
        return this._busy;
    }

    set busy(val) {
        this._busy = Boolean(val);
    }

    get clientGeneration() {
        return this._clientGeneration;
    }

    get lifecycleGeneration() {
        return this._lifecycleGeneration;
    }

    get activeTurnState() {
        return this._activeTurnState;
    }

    set activeTurnState(val) {
        this._activeTurnState = val;
    }

    get currentSessionId() {
        return this._currentSessionId;
    }

    get lastState() {
        return this._lastState;
    }

    get needsReconnect() {
        return this._needsReconnect;
    }

    beginLifecycle(lifeGen) {
        this._disposed = false;
        this._lifecycleGeneration = Number(lifeGen) || (this._lifecycleGeneration + 1);
    }

    scheduleConfigReconnect({debounceMs = 60, revokeScopes = false, isLocked = false} = {}) {
        if (this._disposed) return;
        if (revokeScopes) {
            this._client?.revokeApprovedScopes?.();
        }
        this._needsReconnect = true;
        if (this._busy) return;
        if (this._cancelReconnectTimer) {
            this._cancelReconnectTimer();
            this._cancelReconnectTimer = null;
        }
        const lifeGen = this._lifecycleGeneration;
        this._cancelReconnectTimer = this._scheduleDelay(debounceMs, () => {
            this._cancelReconnectTimer = null;
            if (this._disposed || this._lifecycleGeneration !== lifeGen || isLocked) return;
            if (this._busy) {
                this._needsReconnect = true;
            } else {
                this.reconnectNow().catch(() => {});
            }
        });
    }

    async reconnectNow({canConnect = () => true} = {}) {
        if (this._disposed || this._busy || !canConnect()) return null;
        if (this._reconnectPromise) return this._reconnectPromise;
        const task = this._replaceConnection(canConnect);
        this._reconnectPromise = task;
        try {
            return await task;
        } finally {
            if (this._reconnectPromise === task) this._reconnectPromise = null;
        }
    }

    async _replaceConnection(canConnect) {
        const generation = this._clientGeneration;
        const isCurrent = () => !this._disposed && !this._busy &&
            generation === this._clientGeneration && canConnect();
        if (this._cancelReconnectTimer) {
            this._cancelReconnectTimer();
            this._cancelReconnectTimer = null;
        }
        const prevClient = this._client;
        if (prevClient) {
            try {
                const flushed = await prevClient.request('flush_session');
                if (!isCurrent()) return null;
                if (!flushed?.ok || flushed?.hasUnsavedChanges) {
                    this._onConnectionError(new Error(
                        `切换后端已暂停：当前会话历史尚未保存。请先重试保存或导出（${flushed?.error || '写入未完成'}）`
                    ));
                    return null;
                }
            } catch (err) {
                if (!isCurrent()) return null;
                this._onConnectionError(new Error(
                    `切换后端已暂停：无法确认会话已保存（${err?.message || err}）`
                ));
                return null;
            }
        }
        if (!isCurrent() || this._client !== prevClient) return null;
        this.stopClient();
        if (!canConnect()) return null;
        return this.ensureConnected({canConnect});
    }

    /**
     * Coalesces concurrent connection requests into a single in-flight Promise and verifies
     * both `lifecycleGeneration` and `clientGeneration` across every `await` boundary.
     */
    ensureConnected({canConnect = () => true} = {}) {
        if (this._disposed || !canConnect()) {
            return Promise.resolve(null);
        }
        if (this._needsReconnect) return this.reconnectNow({canConnect});
        if (this._client && this._ready) {
            return Promise.resolve({state: this._lastState, reused: true});
        }
        if (this._ensurePromise) {
            return this._ensurePromise;
        }

        const lifeGen = this._lifecycleGeneration;
        const generation = ++this._clientGeneration;
        this._ready = false;
        try { this._connectCancellable?.cancel?.(); } catch (_) {}
        // Production injects a genuine Gio.Cancellable; pure-JS tests may use
        // a lightweight implementation, but it must never reach native Gio APIs.
        const connectCancellable = this._createCancellable();
        this._connectCancellable = connectCancellable;
        try {
            this._onConnecting({generation, lifecycleGeneration: lifeGen, reason: '正在检测…'});
        } catch (_) {}

        const isStale = () => (
            this._disposed ||
            this._lifecycleGeneration !== lifeGen ||
            generation !== this._clientGeneration ||
            connectCancellable.is_cancelled() ||
            !canConnect()
        );

        const task = (async () => {
            let connectionPhase = '读取设置与密钥';
            try {
                const env = await this._loadRuntimeEnvironment({cancellable: connectCancellable});
                if (isStale()) {
                    return null;
                }

                const {config, workspace, sessionsDir, sessionId} = env;
                this._currentSessionId = sessionId;

                const client = this._createClient(
                    event => {
                        if (!this._disposed && this._lifecycleGeneration === lifeGen && this._clientGeneration === generation) {
                            this._onEvent(event);
                        }
                    },
                    error => {
                        if (this._disposed || this._lifecycleGeneration !== lifeGen || this._clientGeneration !== generation) {
                            return;
                        }
                        this._client = null;
                        this._ready = false;
                        this._activeTurnState = null;
                        this._busy = false;
                        this._onConnectionError(error);
                    }
                );

                this._client = client;
                connectionPhase = '后端检测与初始化';
                if (typeof client.startAsync === 'function') {
                    await client.startAsync(config, workspace, sessionsDir, sessionId, {
                        clientGeneration: generation,
                        cancellable: connectCancellable,
                    });
                } else {
                    client.start(config, workspace, sessionsDir, sessionId, {clientGeneration: generation});
                }
                if (isStale()) {
                    try { client.close?.(); } catch (_) {}
                    if (this._client === client) this._client = null;
                    return null;
                }

                connectionPhase = '读取后端状态';
                const state = await client.request('get_state');
                if (isStale()) {
                    try { client.close?.(); } catch (_) {}
                    if (this._client === client) this._client = null;
                    return null;
                }
                connectionPhase = '加载本地会话';
                const data = await client.request('get_messages');
                if (isStale()) {
                    try { client.close?.(); } catch (_) {}
                    if (this._client === client) this._client = null;
                    return null;
                }

                const securityContextKey = `${state.backend}::${workspace}::${state.effectiveMode || config.mode}::${sessionId}`;
                if (this._lastSecurityContextKey && this._lastSecurityContextKey !== securityContextKey) {
                    client.revokeApprovedScopes?.();
                }
                this._lastSecurityContextKey = securityContextKey;

                this._lastState = state;
                this._ready = !(state.unconfigured || state.backend === 'unconfigured');
                this._onStateChanged({
                    state,
                    messages: data?.messages || [],
                    config,
                    workspace,
                    sessionId,
                    generation,
                });
                return {state, messages: data?.messages || [], reused: false};
            } catch (err) {
                if (!this._disposed && this._lifecycleGeneration === lifeGen && generation === this._clientGeneration && !connectCancellable.is_cancelled()) {
                    this.stopClient();
                    const detail = err?.message || String(err || '未知错误');
                    this._onConnectionError(new Error(`连接阶段「${connectionPhase}」失败：${detail}`));
                }
                return null;
            } finally {
                if (this._ensurePromise === task) {
                    this._ensurePromise = null;
                }
                if (this._connectCancellable === connectCancellable) {
                    this._connectCancellable = null;
                }
            }
        })();

        this._ensurePromise = task;
        return task;
    }

    stopClient() {
        this._reconnectPromise = null;
        ++this._clientGeneration;
        this._cancelReconnectTimer?.();
        this._cancelReconnectTimer = null;
        this._needsReconnect = false;
        try { this._connectCancellable?.cancel?.(); } catch (_) {}
        this._connectCancellable = null;
        this._ensurePromise = null;
        this._activeTurnState = null;
        this._ready = false;
        this._busy = false;
        const c = this._client;
        this._client = null;
        try { c?.close?.(); } catch (_) {}
    }

    dispose() {
        this._disposed = true;
        ++this._lifecycleGeneration;
        this.stopClient();
    }
}
