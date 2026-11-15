// Pure-JS ChatController coordinating BackendRegistry, single-flight connection lifecycle,
// transactional config reconnects, security-context scope revocation, and turn identity isolation (Stage E).
// Zero GNOME/GJS imports so Node unit tests exercise real connection & turn coordination directly.

export class ChatController {
    constructor({
        registry,
        createClient,
        loadRuntimeEnvironment,
        onEvent = () => {},
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
        this._onEvent = onEvent;
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
        return this._ready;
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

    set needsReconnect(val) {
        this._needsReconnect = Boolean(val);
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
        if (this._busy) {
            this._needsReconnect = true;
            return;
        }
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
        if (this._disposed || this._busy) return null;
        if (this._cancelReconnectTimer) {
            this._cancelReconnectTimer();
            this._cancelReconnectTimer = null;
        }
        const prevClient = this._client;
        if (prevClient) {
            try { await prevClient.request('flush_session'); } catch (_) {}
        }
        if (this._disposed || this._busy) return null;
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
        if (this._client && this._ready) {
            return Promise.resolve({state: this._lastState, reused: true});
        }
        if (this._ensurePromise) {
            return this._ensurePromise;
        }

        const lifeGen = this._lifecycleGeneration;
        const generation = ++this._clientGeneration;
        this._ready = false;

        const task = (async () => {
            try {
                const env = await this._loadRuntimeEnvironment();
                if (this._disposed || this._lifecycleGeneration !== lifeGen || generation !== this._clientGeneration || !canConnect()) {
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
                client.start(config, workspace, sessionsDir, sessionId, {clientGeneration: generation});

                const state = await client.request('get_state');
                const data = await client.request('get_messages');
                if (this._disposed || this._lifecycleGeneration !== lifeGen || generation !== this._clientGeneration || !canConnect()) {
                    try { client.close?.(); } catch (_) {}
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
                if (!this._disposed && this._lifecycleGeneration === lifeGen && generation === this._clientGeneration) {
                    this.stopClient();
                    this._onConnectionError(err);
                }
                return null;
            } finally {
                if (this._ensurePromise === task) {
                    this._ensurePromise = null;
                }
            }
        })();

        this._ensurePromise = task;
        return task;
    }

    stopClient() {
        ++this._clientGeneration;
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
        if (this._cancelReconnectTimer) {
            this._cancelReconnectTimer();
            this._cancelReconnectTimer = null;
        }
        this.stopClient();
    }
}
