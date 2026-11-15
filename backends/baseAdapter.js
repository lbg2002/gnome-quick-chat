// Unified Backend Adapter Contract (Stage E).
// Shared across ZCodeAdapter, CodexAdapter, and OpenAIAdapter.
// Pure JS so adapter contract, capability guards, and mock adapters run directly in Node tests.

import {getBackendCapabilities} from '../protocol.js';

export class BaseBackendAdapter {
    constructor(backendId, {emitEvent = () => {}} = {}) {
        this.backendId = String(backendId || 'unconfigured');
        this._emitEvent = emitEvent;
        this._runtime = null;
        this._config = null;
        this._disposed = false;
    }

    get isDisposed() {
        return this._disposed;
    }

    get runtime() {
        return this._runtime;
    }

    initialize(runtime, config = {}) {
        this._runtime = runtime;
        this._config = {...config};
        this._disposed = false;
        return this;
    }

    configure(partialConfig = {}) {
        this._config = {
            ...(this._config || {}),
            ...partialConfig,
        };
        return this._config;
    }

    getCapabilities() {
        if (this._runtime?.capabilities) {
            return this._runtime.capabilities;
        }
        const mode = this._runtime?.effectiveModeInfo?.effectiveMode || this._config?.mode || 'readonly';
        return getBackendCapabilities(this.backendId, mode, this._runtime?.cliCapabilities || null);
    }

    async getModels(_options = {}) {
        return {
            backend: this.backendId,
            catalog: {backendLabel: this.backendId, providers: []},
            models: [],
        };
    }

    async restoreSession(sessionStore, contextConfig = {}) {
        if (!sessionStore) {
            return {messages: [], remoteSessionId: ''};
        }
        await sessionStore.load(this.backendId, contextConfig);
        return {
            messages: [...sessionStore.messages],
            remoteSessionId: sessionStore.remoteSessionId || '',
        };
    }

    async sendMessage(_turnRequest) {
        throw new Error(`Adapter ${this.backendId} must implement sendMessage(turnRequest)`);
    }

    async cancel(_turnId) {
        return {aborted: false};
    }

    /**
     * Only adapters whose `getCapabilities().supportsApproval` is true implement interactive
     * tool permission responses (currently ZCode CLI with verified bridge).
     */
    async respondPermission(_request) {
        const caps = this.getCapabilities();
        if (!caps?.supportsApproval) {
            return {
                sent: false,
                rejected: 'capability_not_supported',
                reason: `${this.backendId} 后端不支持会话内交互式工具审批`,
            };
        }
        return {sent: false, rejected: 'not_implemented'};
    }

    dispose() {
        this._disposed = true;
    }
}
