// OpenAI-Compatible HTTP Streaming Backend Adapter (Stage E).
// Pure Q&A over Soup 3.0 HTTP/SSE with strict TLS, cross-origin redirect Authorization guard,
// cancellable `/models` discovery, whole-turn context budgeting, and split timeouts.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {BaseBackendAdapter} from './baseAdapter.js';
import {
    buildBudgetedContextMessages,
    inspectCrossContextAttachmentPrivacy,
    normalizeOpenAIEndpoint,
    preparePromptWithinBudget,
} from '../protocol.js';
import {
    evaluateRedirectPolicy,
    inspectEndpointSecurity,
    normalizeEndpointKeyIdentity,
    shouldStripAuthOnRedirect,
} from '../core/secretPolicy.js';
import {
    defaultEndpointModelMetadataCache,
} from '../core/modelCatalogCache.js';
import {
    DEFAULT_SSE_LIMITS,
    OpenAISseParser,
    formatSanitizedHttpError,
    normalizeOpenAIUsage,
    parseModelsResponse,
    redactSensitiveText,
    resolveSplitTimeouts,
    supportsOpenAIReasoningEffort,
} from '../runtime/sseParser.js';
import {attachTurnWatchdog} from '../runtime/processManager.js';

const Encoder = new TextEncoder();
const Decoder = new TextDecoder('utf-8');

function createLinkedCancellable(...parents) {
    const child = new Gio.Cancellable();
    const cleanups = [];
    const cancelChild = () => {
        try { child.cancel(); } catch (_) {}
    };
    for (const parent of parents) {
        if (!parent) continue;
        if (parent.is_cancelled?.()) {
            cancelChild();
            break;
        }
        if (typeof parent.connect === 'function') {
            try {
                const id = parent.connect(cancelChild);
                cleanups.push(() => {
                    try { if (id) parent.disconnect?.(id); } catch (_) {}
                });
            } catch (_) {}
        }
    }
    return {
        cancellable: child,
        dispose() {
            while (cleanups.length > 0) {
                const fn = cleanups.pop();
                try { fn(); } catch (_) {}
            }
        },
    };
}

/**
 * Guards HTTP 30x redirects on `Soup.Message` (Stage R9):
 * 1. Always strips `Authorization`, `Cookie`, `X-Api-Key`, and `Proxy-Authorization` on any
 *    cross-origin redirect or scheme change (`shouldStripAuthOnRedirect`).
 * 2. Blocks `https:// -> http://` downgrade redirects on ALL methods (`GET`, `POST`, etc.).
 * 3. Blocks cross-origin redirects on `POST` (or non-GET/HEAD requests such as `POST /chat/completions`
 *    carrying user prompts and embedded attachments) by default (`allowCrossOriginPostRedirect === false`),
 *    clearing the request body and cancelling the request BEFORE the foreign origin is contacted.
 */
export function attachCrossOriginRedirectGuard(msg, initialUrl, {
    method = '',
    cancellable = null,
    allowCrossOriginPostRedirect = false,
    onBlockedRedirect = null,
    state = null,
} = {}) {
    if (!msg || typeof msg.connect !== 'function') return 0;
    const effectiveMethod = String(method || msg?.get_method?.() || 'GET').trim().toUpperCase();
    const guardState = state && typeof state === 'object'
        ? state
        : {blockedError: null, policy: null, strippedAuth: false, signalIds: []};
    if (!Array.isArray(guardState.signalIds)) {
        guardState.signalIds = [];
    }

    const stripSensitiveHeaders = m => {
        const reqHeaders = m?.get_request_headers?.();
        reqHeaders?.remove?.('Authorization');
        reqHeaders?.remove?.('authorization');
        reqHeaders?.remove?.('X-Api-Key');
        reqHeaders?.remove?.('x-api-key');
        reqHeaders?.remove?.('Cookie');
        reqHeaders?.remove?.('cookie');
        reqHeaders?.remove?.('Proxy-Authorization');
        guardState.strippedAuth = true;
    };

    const inspectAndEnforceRedirect = (m, nextUri, status = 0) => {
        if (!nextUri) return;
        const policy = evaluateRedirectPolicy(initialUrl, nextUri, {
            method: effectiveMethod,
            status: status || Number(m?.get_status?.() || 302),
            allowCrossOriginPost: Boolean(allowCrossOriginPostRedirect),
        });
        guardState.policy = policy;
        if (policy.stripAuthorization || shouldStripAuthOnRedirect(initialUrl, nextUri)) {
            stripSensitiveHeaders(m);
        }
        if (!policy.allowed && !guardState.blockedError) {
            if (policy.clearRequestBody) {
                try { m?.set_request_body_from_bytes?.(null, null); } catch (_) {}
            }
            const err = new Error(policy.message || '拒绝不安全的跨源重定向');
            err.code = policy.reason || 'blocked_redirect';
            err.redirectPolicy = policy;
            guardState.blockedError = err;
            try { onBlockedRedirect?.(err, policy); } catch (_) {}
            try { cancellable?.cancel?.(); } catch (_) {}
        }
    };

    let gotHeadersId = 0;
    try {
        gotHeadersId = msg.connect('got-headers', m => {
            try {
                const status = Number(m?.get_status?.() || 0);
                if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
                    const respHeaders = m?.get_response_headers?.();
                    const location = respHeaders?.get_one?.('Location') || respHeaders?.get_one?.('location') || '';
                    if (location) {
                        inspectAndEnforceRedirect(m, location, status);
                    }
                }
            } catch (_) {
                try { stripSensitiveHeaders(m); } catch (__) {}
            }
        });
        if (gotHeadersId) guardState.signalIds.push(gotHeadersId);
    } catch (_) {}

    const restartedId = msg.connect('restarted', m => {
        try {
            const nextUri = m?.get_uri?.()?.to_string?.() || '';
            inspectAndEnforceRedirect(m, nextUri, Number(m?.get_status?.() || 302));
        } catch (_) {
            try { stripSensitiveHeaders(m); } catch (__) {}
        }
    });
    if (restartedId) guardState.signalIds.push(restartedId);

    return restartedId || gotHeadersId || 0;
}

/**
 * Reads an HTTP response body via `Soup.Session.send_async` + bounded `read_bytes_async` chunks.
 *
 * - Uses `Content-Length` only as an early rejection hint.
 * - Reads at most `maxBytes + 1` bytes in fixed chunks (`16 KiB`) and aborts/closes the stream
 *   immediately if the body exceeds `maxBytes`, preventing chunked or dishonest servers from
 *   exhausting GNOME Shell memory (Stage R5).
 * - Surfaces blocked redirect errors from `redirectGuardState` explicitly (Stage R9).
 */
export function readSoupResponseBytesBoundedAsync(session, msg, {
    maxBytes = DEFAULT_SSE_LIMITS.maxModelsResponseBytes,
    chunkBytes = 16 * 1024,
    cancellable = null,
    redirectGuardState = null,
} = {}) {
    if (!session || !msg) {
        return Promise.reject(new Error('无效的 HTTP 会话或请求对象'));
    }
    const effectiveMaxBytes = Math.max(1024, Number(maxBytes) || DEFAULT_SSE_LIMITS.maxModelsResponseBytes);
    const effectiveChunkBytes = Math.max(512, Math.min(Number(chunkBytes) || (16 * 1024), effectiveMaxBytes + 1));

    return new Promise((resolve, reject) => {
        let settled = false;
        let bodyStream = null;

        const closeBodyStream = () => {
            if (!bodyStream) return;
            const s = bodyStream;
            bodyStream = null;
            try {
                s.close_async(GLib.PRIORITY_DEFAULT, null, (st, r) => {
                    try { st.close_finish(r); } catch (_) {}
                });
            } catch (_) {}
        };

        const failWith = err => {
            if (settled) return;
            settled = true;
            closeBodyStream();
            const prioritizedErr = redirectGuardState?.blockedError || err;
            reject(prioritizedErr instanceof Error ? prioritizedErr : new Error(String(prioritizedErr)));
        };

        session.send_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (sess, sendRes) => {
            try {
                bodyStream = sess.send_finish(sendRes);
            } catch (err) {
                failWith(err);
                return;
            }
            if (redirectGuardState?.blockedError) {
                failWith(redirectGuardState.blockedError);
                return;
            }
            if (!bodyStream) {
                failWith(new Error('HTTP 响应流为空'));
                return;
            }

            // Early rejection check on Content-Length header (never the sole guard!)
            try {
                const respHeaders = msg.get_response_headers?.();
                let declaredLen = 0;
                const clHeader = respHeaders?.get_one?.('Content-Length') || respHeaders?.get_one?.('content-length');
                if (clHeader !== null && clHeader !== undefined && String(clHeader).trim() !== '') {
                    declaredLen = Number.parseInt(String(clHeader).trim(), 10) || 0;
                } else if (typeof respHeaders?.get_content_length === 'function') {
                    declaredLen = Number(respHeaders.get_content_length() || 0);
                }
                if (declaredLen > effectiveMaxBytes) {
                    failWith(new Error(`/models 响应体积超过上限（Content-Length ${Math.ceil(declaredLen / 1024)} KB > ${Math.ceil(effectiveMaxBytes / 1024)} KB）`));
                    return;
                }
            } catch (_) {}

            const chunks = [];
            let totalBytes = 0;

            const readNextChunk = () => {
                if (settled || !bodyStream) return;
                if (redirectGuardState?.blockedError) {
                    failWith(redirectGuardState.blockedError);
                    return;
                }
                if (cancellable?.is_cancelled?.()) {
                    failWith(new Error('Operation was cancelled'));
                    return;
                }
                const remainingPlusOne = (effectiveMaxBytes - totalBytes) + 1;
                const toRead = Math.max(1, Math.min(effectiveChunkBytes, remainingPlusOne));
                bodyStream.read_bytes_async(toRead, GLib.PRIORITY_DEFAULT, cancellable, (stream, readRes) => {
                    let gbytes = null;
                    try {
                        gbytes = stream.read_bytes_finish(readRes);
                    } catch (err) {
                        failWith(err);
                        return;
                    }
                    if (settled) return;
                    if (redirectGuardState?.blockedError) {
                        failWith(redirectGuardState.blockedError);
                        return;
                    }
                    const data = gbytes ? gbytes.get_data() : null;
                    if (!data || data.byteLength === 0) {
                        settled = true;
                        closeBodyStream();
                        const merged = new Uint8Array(totalBytes);
                        let offset = 0;
                        for (const c of chunks) {
                            merged.set(c, offset);
                            offset += c.byteLength;
                        }
                        resolve({
                            status: msg.get_status(),
                            reasonPhrase: msg.get_reason_phrase?.() || '',
                            bytes: merged,
                        });
                        return;
                    }

                    const copy = data instanceof Uint8Array ? data : new Uint8Array(data);
                    totalBytes += copy.byteLength;
                    if (totalBytes > effectiveMaxBytes) {
                        failWith(new Error(`/models 响应体积超过上限（>${Math.ceil(effectiveMaxBytes / 1024)} KB）`));
                        return;
                    }
                    chunks.push(copy);
                    readNextChunk();
                });
            };

            readNextChunk();
        });
    });
}

export class OpenAIAdapter extends BaseBackendAdapter {
    constructor({
        turns,
        store,
        getSessionContextConfig,
        emitEvent,
        clientGeneration = 0,
        metadataCache = defaultEndpointModelMetadataCache,
    } = {}) {
        super('openai', {emitEvent});
        this._turns = turns;
        this._store = store;
        this._getSessionContextConfig = getSessionContextConfig || (() => ({}));
        this._clientGeneration = clientGeneration;
        this._metadataCache = metadataCache || defaultEndpointModelMetadataCache;
        this._httpSession = null;
        this._modelsCancellable = null;
        this._modelsRequestSeq = 0;
        this._configGeneration = 0;
        this._endpointKey = '';
        this._userConfiguredModelId = '';
        this._hasExplicitUserModel = false;
    }

    _resolveCurrentEndpointKey(urlOverride = '') {
        const raw = String(
            urlOverride ||
            this._runtime?.baseUrl ||
            this._runtime?.modelsUrl ||
            this._runtime?.chatUrl ||
            ''
        ).trim();
        return normalizeEndpointKeyIdentity(raw) || raw.toLowerCase() || '__default__';
    }

    initialize(runtime, config = {}, {timeouts = null} = {}) {
        super.initialize(runtime, config);
        const resolved = timeouts || resolveSplitTimeouts(config);
        this._httpSession = new Soup.Session({
            timeout: resolved.streamIdleTimeoutSec,
        });
        this._configGeneration = Number(config?.configGeneration ?? runtime?.configGeneration ?? 0);

        const explicitModel = String(config?.openaiModel || config?.model || runtime?.modelId || '').trim();
        this._userConfiguredModelId = explicitModel;
        this._hasExplicitUserModel = Boolean(explicitModel);

        if (this._runtime) {
            const base = String(this._runtime.baseUrl || config?.openaiBaseUrl || '').trim();
            if (base && !this._runtime.baseUrl) {
                this._runtime.baseUrl = base;
            }
            if (!this._runtime.chatUrl) {
                this._runtime.chatUrl = String(
                    this._runtime.endpoint ||
                    (base ? normalizeOpenAIEndpoint(base, '/chat/completions') : '')
                ).trim();
            }
            if (!this._runtime.modelsUrl && base) {
                this._runtime.modelsUrl = normalizeOpenAIEndpoint(base, '/models');
            }
            if (!this._runtime.reasoningEffort) {
                const rawThinking = String(config?.thinkingLevel || config?.reasoningEffort || '').trim().toLowerCase();
                if (rawThinking === 'low' || rawThinking === 'medium' || rawThinking === 'high') {
                    this._runtime.reasoningEffort = rawThinking;
                }
            }
            this._endpointKey = this._resolveCurrentEndpointKey();
            if (!this._runtime.modelMetadataByEndpoint || typeof this._runtime.modelMetadataByEndpoint !== 'object') {
                this._runtime.modelMetadataByEndpoint = {};
            }
            if (this._runtime.modelMetadata && typeof this._runtime.modelMetadata === 'object') {
                const seedEndpointKey = this._runtime.modelMetadataEndpointKey || this._endpointKey;
                if (seedEndpointKey === this._endpointKey) {
                    this._metadataCache.setBatch(this._endpointKey, this._runtime.modelMetadata);
                    this._runtime.modelMetadataByEndpoint[this._endpointKey] = {
                        ...(this._runtime.modelMetadataByEndpoint[this._endpointKey] || {}),
                        ...this._runtime.modelMetadata,
                    };
                }
            }
            this._runtime.modelMetadataEndpointKey = this._endpointKey;
            this._runtime.modelMetadata = {
                ...this._metadataCache.getEndpointMap(this._endpointKey),
                ...(this._runtime.modelMetadataByEndpoint[this._endpointKey] || {}),
            };
        } else {
            this._endpointKey = this._resolveCurrentEndpointKey();
        }
        return this;
    }

    getModelMetadata(modelId, endpointOrUrl = '') {
        const cleanModel = String(modelId || '').trim();
        if (!cleanModel) return null;
        const epKey = this._resolveCurrentEndpointKey(endpointOrUrl);
        const fromRuntimeEndpointMap = this._runtime?.modelMetadataByEndpoint?.[epKey]?.[cleanModel];
        if (fromRuntimeEndpointMap && typeof fromRuntimeEndpointMap === 'object') {
            return fromRuntimeEndpointMap;
        }
        const fromSharedCache = this._metadataCache?.get?.(epKey, cleanModel);
        if (fromSharedCache && typeof fromSharedCache === 'object') {
            return fromSharedCache;
        }
        if (
            this._runtime?.modelMetadata?.[cleanModel] &&
            (!this._runtime.modelMetadataEndpointKey || this._runtime.modelMetadataEndpointKey === epKey)
        ) {
            return this._runtime.modelMetadata[cleanModel];
        }
        return null;
    }

    updateApiKey(apiKey) {
        const clean = String(apiKey || '').trim();
        if (this._config) this._config.openaiApiKey = clean;
        if (this._runtime) this._runtime.apiKey = clean;
    }

    /**
     * Switches endpoint or configuration generation on an existing adapter instance,
     * cancelling in-flight `/models` requests and isolating model metadata per endpoint (Stage R9).
     */
    updateEndpoint(baseUrlOrRuntime, options = {}) {
        const isObj = typeof baseUrlOrRuntime === 'object' && baseUrlOrRuntime !== null;
        const cleanBaseUrl = String(
            isObj
                ? (baseUrlOrRuntime.baseUrl || options?.openaiBaseUrl || '')
                : (baseUrlOrRuntime || '')
        ).trim();
        const apiKey = isObj
            ? (baseUrlOrRuntime.apiKey ?? options?.openaiApiKey ?? options?.apiKey)
            : options?.apiKey;
        const modelId = isObj
            ? (baseUrlOrRuntime.modelId ?? options?.openaiModel ?? options?.modelId)
            : options?.modelId;
        const configGeneration = isObj
            ? (baseUrlOrRuntime.configGeneration ?? options?.configGeneration)
            : options?.configGeneration;

        const nextEndpointKey = this._resolveCurrentEndpointKey(cleanBaseUrl);
        const endpointChanged = nextEndpointKey !== this._endpointKey;

        if (configGeneration !== undefined) {
            this._configGeneration = Number(configGeneration);
        } else if (endpointChanged) {
            this._configGeneration += 1;
        }

        if (endpointChanged || configGeneration !== undefined) {
            this._modelsRequestSeq += 1;
            try { this._modelsCancellable?.cancel?.(); } catch (_) {}
            this._modelsCancellable = null;
        }

        this._endpointKey = nextEndpointKey;
        if (this._config && cleanBaseUrl) {
            this._config.openaiBaseUrl = cleanBaseUrl;
        }
        if (this._runtime) {
            if (cleanBaseUrl) {
                this._runtime.baseUrl = cleanBaseUrl;
                this._runtime.chatUrl = (isObj && (baseUrlOrRuntime.chatUrl || baseUrlOrRuntime.endpoint))
                    ? String(baseUrlOrRuntime.chatUrl || baseUrlOrRuntime.endpoint).trim()
                    : normalizeOpenAIEndpoint(cleanBaseUrl, '/chat/completions');
                this._runtime.modelsUrl = (isObj && baseUrlOrRuntime.modelsUrl)
                    ? String(baseUrlOrRuntime.modelsUrl).trim()
                    : normalizeOpenAIEndpoint(cleanBaseUrl, '/models');
            }
            if (apiKey !== undefined) {
                this.updateApiKey(apiKey);
            }
            if (modelId !== undefined) {
                const cleanModel = String(modelId || '').trim();
                this._userConfiguredModelId = cleanModel;
                this._hasExplicitUserModel = Boolean(cleanModel);
                this._runtime.modelId = cleanModel;
                this._runtime.resolvedModel = cleanModel;
                this._runtime.label = cleanModel || 'OpenAI API';
            } else if (endpointChanged && !this._hasExplicitUserModel) {
                // Clear auto-discovered model from old endpoint while preserving any manual user model
                this._runtime.modelId = '';
                this._runtime.resolvedModel = '';
                this._runtime.label = 'OpenAI API';
            }
            if (!this._runtime.modelMetadataByEndpoint) {
                this._runtime.modelMetadataByEndpoint = {};
            }
            this._runtime.modelMetadataEndpointKey = nextEndpointKey;
            this._runtime.modelMetadata = {
                ...this._metadataCache.getEndpointMap(nextEndpointKey),
                ...(this._runtime.modelMetadataByEndpoint[nextEndpointKey] || {}),
            };
        }
    }

    async getModels({
        cancellable = null,
        maxBytes = DEFAULT_SSE_LIMITS.maxModelsResponseBytes,
        forceRefresh = false,
        configGeneration = undefined,
    } = {}) {
        if (!this._httpSession || this._disposed) {
            throw new Error('OpenAI HTTP 会话已关闭');
        }
        if (configGeneration !== undefined) {
            this._configGeneration = Number(configGeneration);
        }

        const currentEndpointKey = this._resolveCurrentEndpointKey();
        if (currentEndpointKey !== this._endpointKey) {
            this._endpointKey = currentEndpointKey;
            try { this._modelsCancellable?.cancel?.(); } catch (_) {}
            this._modelsCancellable = null;
        } else if (forceRefresh && this._modelsCancellable) {
            try { this._modelsCancellable.cancel(); } catch (_) {}
            this._modelsCancellable = null;
        }

        const reqSeq = ++this._modelsRequestSeq;
        const reqClientGen = this._clientGeneration;
        const reqConfigGen = this._configGeneration;
        const reqEndpointKey = this._endpointKey;

        const internalModelsCancellable = new Gio.Cancellable();
        this._modelsCancellable = internalModelsCancellable;
        const linked = createLinkedCancellable(cancellable, internalModelsCancellable);

        const userPreferredModel = this._hasExplicitUserModel
            ? this._userConfiguredModelId
            : String(this._runtime?.modelId || '').trim();
        const modelsUrl = this._runtime?.modelsUrl || '';
        const apiKey = this._runtime?.apiKey || '';

        const msg = Soup.Message.new('GET', modelsUrl);
        if (!msg) {
            linked.dispose();
            throw new Error(`无效的接口地址：${modelsUrl}`);
        }
        const redirectGuardState = {blockedError: null, policy: null, strippedAuth: false, signalIds: []};
        attachCrossOriginRedirectGuard(msg, modelsUrl, {
            method: 'GET',
            cancellable: linked.cancellable,
            state: redirectGuardState,
        });
        const headers = msg.get_request_headers();
        headers.append('Accept', 'application/json');
        if (apiKey) {
            headers.append('Authorization', `Bearer ${apiKey}`);
        }

        try {
            const {status, bytes: rawData} = await readSoupResponseBytesBoundedAsync(
                this._httpSession,
                msg,
                {
                    maxBytes,
                    cancellable: linked.cancellable,
                    redirectGuardState,
                }
            );
            const parsed = parseModelsResponse(status, rawData, {
                preferredModel: userPreferredModel,
                apiKey,
                maxResponseBytes: maxBytes,
            });

            // R9.2: Verify adapter lifecycle, client/config generation, and endpoint identity before applying
            const isStale = Boolean(
                this._disposed ||
                linked.cancellable.is_cancelled?.() ||
                reqSeq !== this._modelsRequestSeq ||
                reqClientGen !== this._clientGeneration ||
                reqConfigGen !== this._configGeneration ||
                reqEndpointKey !== this._resolveCurrentEndpointKey()
            );
            if (isStale) {
                return {
                    backend: 'openai',
                    models: [],
                    selectedModel: userPreferredModel || '',
                    stale: true,
                };
            }

            if (parsed.metadataById && Object.keys(parsed.metadataById).length > 0) {
                this._metadataCache.setBatch(reqEndpointKey, parsed.metadataById);
            }
            if (this._runtime) {
                if (!this._runtime.modelMetadataByEndpoint) {
                    this._runtime.modelMetadataByEndpoint = {};
                }
                this._runtime.modelMetadataByEndpoint[reqEndpointKey] = {
                    ...(this._runtime.modelMetadataByEndpoint[reqEndpointKey] || {}),
                    ...(parsed.metadataById || {}),
                };
                this._runtime.modelMetadataEndpointKey = reqEndpointKey;
                this._runtime.modelMetadata = {
                    ...this._metadataCache.getEndpointMap(reqEndpointKey),
                    ...this._runtime.modelMetadataByEndpoint[reqEndpointKey],
                };
                // Never overwrite a manually specified user model with auto-discovered models[0]
                if (this._hasExplicitUserModel && this._userConfiguredModelId) {
                    this._runtime.modelId = this._userConfiguredModelId;
                    this._runtime.resolvedModel = this._userConfiguredModelId;
                    this._runtime.label = this._userConfiguredModelId;
                }
            }

            const effectiveSelectedModel = (this._hasExplicitUserModel && this._userConfiguredModelId)
                ? this._userConfiguredModelId
                : (parsed.selectedModel || '');

            if (!this._disposed && Array.isArray(parsed.models) && parsed.models.length > 0) {
                this._emitEvent?.({
                    type: 'models_discovered',
                    backend: 'openai',
                    endpointKey: reqEndpointKey,
                    baseUrl: this._runtime?.baseUrl || '',
                    models: parsed.models.slice(0, 200),
                    metadataById: parsed.metadataById || {},
                    selectedModel: effectiveSelectedModel,
                    clientGeneration: reqClientGen,
                    configGeneration: reqConfigGen,
                });
            }
            return {
                backend: 'openai',
                endpointKey: reqEndpointKey,
                models: parsed.models || [],
                selectedModel: effectiveSelectedModel,
                metadataById: parsed.metadataById || {},
            };
        } catch (e) {
            if (
                !redirectGuardState.blockedError &&
                (
                    this._disposed ||
                    reqSeq !== this._modelsRequestSeq ||
                    reqClientGen !== this._clientGeneration ||
                    reqConfigGen !== this._configGeneration ||
                    reqEndpointKey !== this._resolveCurrentEndpointKey()
                )
            ) {
                return {
                    backend: 'openai',
                    models: [],
                    selectedModel: userPreferredModel || '',
                    stale: true,
                    cancelled: true,
                };
            }
            const rawErr = redirectGuardState.blockedError || e;
            const cleanMsg = redactSensitiveText(rawErr?.message || String(rawErr), {apiKey, maxChars: 240});
            throw new Error(cleanMsg);
        } finally {
            linked.dispose();
            if (this._modelsCancellable === internalModelsCancellable) {
                this._modelsCancellable = null;
            }
        }
    }

    async _discoverModelIfNeeded(cancellable) {
        if (this._hasExplicitUserModel && this._userConfiguredModelId) {
            if (this._runtime) {
                this._runtime.modelId = this._userConfiguredModelId;
                this._runtime.resolvedModel = this._userConfiguredModelId;
                this._runtime.label = this._userConfiguredModelId;
            }
            return this._userConfiguredModelId;
        }
        const currentModelId = String(this._runtime?.modelId || '').trim();
        if (currentModelId && this._resolveCurrentEndpointKey() === this._endpointKey) {
            return currentModelId;
        }

        try {
            const parsed = await this.getModels({cancellable});
            if (parsed.stale) {
                throw new Error('模型发现请求已被新端点配置取代');
            }
            if (!parsed.selectedModel) {
                throw new Error('未指定模型 ID，且 /models 未返回可用模型；请在设置中填写模型 ID');
            }
            if (!this._hasExplicitUserModel && this._runtime) {
                this._runtime.modelId = parsed.selectedModel;
                this._runtime.resolvedModel = parsed.selectedModel;
                this._runtime.label = parsed.selectedModel;
            }
            return this._hasExplicitUserModel ? this._userConfiguredModelId : parsed.selectedModel;
        } catch (e) {
            const cleanMsg = redactSensitiveText(e?.message || String(e), {
                apiKey: this._runtime?.apiKey || '',
                maxChars: 240,
            });
            throw new Error(`请在设置中填写模型 ID（${cleanMsg}）`);
        }
    }

    async sendMessage(rawOptions = {}) {
        const opts = typeof rawOptions === 'string'
            ? {promptText: rawOptions}
            : (rawOptions || {});
        const {
            promptText: rawPromptText,
            text: fallbackText,
            memoryContext = '',
            turnMeta = {},
            sessionId = '',
            timeouts = null,
        } = opts;
        const promptText = rawPromptText ?? fallbackText ?? '';
        const baseSystemPrompt = this._runtime.systemPrompt ||
            '你是 Ubuntu 26 / GNOME 50 桌面顶栏中的「随问」AI 助手。请用清晰、简明、准确的中文回答问题。';
        const initialModelId = this._hasExplicitUserModel
            ? this._userConfiguredModelId
            : String(this._runtime?.modelId || '').trim();
        const initialMeta = initialModelId ? this.getModelMetadata(initialModelId) : null;
        const knownCtxWindow = Number(initialMeta?.contextWindowTokens || this._config?.contextWindowTokens || 0) || undefined;
        const configuredReserveOutput = Number(this._config?.reserveOutputTokens || 0) || undefined;
        const allowPromptTruncate = Boolean(this._config?.allowPromptTruncate);

        let systemPrompt = baseSystemPrompt;
        const initialBudgetCheck = preparePromptWithinBudget(promptText, {
            systemPrompt,
            ...(knownCtxWindow ? {contextWindowTokens: knownCtxWindow} : {}),
            ...(configuredReserveOutput ? {reserveOutputTokens: configuredReserveOutput} : {}),
            allowTruncate: allowPromptTruncate,
        });
        if (!initialBudgetCheck.ok) {
            throw new Error(initialBudgetCheck.warning || '当前提问内容超出上下文预算');
        }

        const cancellable = new Gio.Cancellable();
        const turn = this._turns.beginTurn({
            replyMarker: turnMeta.replyMarker,
            allowedMemoryReferences: turnMeta.allowedMemoryReferences,
            turnId: turnMeta.turnId,
            messageId: turnMeta.messageId,
            replyTo: turnMeta.userMessageId || '',
            modelId: initialModelId,
            sessionId,
            clientGeneration: turnMeta.clientGeneration ?? this._clientGeneration,
            lifecycleGeneration: turnMeta.lifecycleGeneration ?? 0,
            backend: 'openai',
            promptText: initialBudgetCheck.promptText,
            cancellable,
        });

        const resolvedTimeouts = timeouts || resolveSplitTimeouts(this._config);
        attachTurnWatchdog({
            turns: this._turns,
            turn,
            backend: 'openai',
            store: this._store,
            getSessionContextConfig: this._getSessionContextConfig,
            initialTimeoutSec: resolvedTimeouts.connectTimeoutSec,
            initialMessage: `连接 OpenAI 接口超时（${resolvedTimeouts.connectTimeoutSec}s）`,
            totalTurnTimeoutSec: resolvedTimeouts.totalTurnTimeoutSec,
        });

        let modelId;
        try {
            modelId = await this._discoverModelIfNeeded(turn.cancellable);
            turn.selectedModelId = turn.modelId = modelId;
        } catch (err) {
            const cleanErr = redactSensitiveText(err?.message || String(err), {apiKey: this._runtime.apiKey});
            this._turns.finalizeTurn(turn, {status: 'failed', errorText: cleanErr});
            throw new Error(cleanErr);
        }

        if (!this._turns.isCurrent(turn)) {
            return {disposition: 'handled'};
        }

        const modelMeta = this.getModelMetadata(modelId);
        const effectiveCtxWindow = Number(
            modelMeta?.contextWindowTokens || knownCtxWindow || 0
        ) || undefined;

        // R9.1: Re-verify current prompt against the discovered model's context window BEFORE persisting/sending!
        const budgetCheck = preparePromptWithinBudget(promptText, {
            systemPrompt,
            ...(effectiveCtxWindow ? {contextWindowTokens: effectiveCtxWindow} : {}),
            ...(configuredReserveOutput ? {reserveOutputTokens: configuredReserveOutput} : {}),
            allowTruncate: allowPromptTruncate,
        });
        if (!budgetCheck.ok) {
            const budgetErr = budgetCheck.warning || '当前提问内容超出模型上下文预算';
            this._turns.finalizeTurn(turn, {status: 'failed', errorText: budgetErr});
            return {
                disposition: 'rejected_budget',
                turnId: turn.id,
                error: budgetErr,
            };
        }
        if (memoryContext) {
            const candidate = `${baseSystemPrompt}\n\n${memoryContext}`;
            if (preparePromptWithinBudget(promptText, {
                systemPrompt: candidate, contextWindowTokens: effectiveCtxWindow || undefined,
                reserveOutputTokens: configuredReserveOutput, allowTruncate: false,
            }).ok) systemPrompt = candidate;
        }
        turn.promptText = budgetCheck.promptText;
        turn.contextWindowTokens = effectiveCtxWindow || budgetCheck.contextWindowTokens || 0;

        const effectiveUserMessageId = turnMeta.userMessageId || `u_${turn.id}`;
        const targetEndpoint = this._runtime?.baseUrl || '';
        const ctxCfg = this._getSessionContextConfig();
        if (this._store?.appendMessage) {
            await this._store.appendMessage(
                {
                    id: effectiveUserMessageId,
                    turnId: turn.id,
                    role: 'user',
                    content: budgetCheck.promptText,
                    endpoint: targetEndpoint,
                    ...(turnMeta.displayUserText ? {displayText: turnMeta.displayUserText} : {}),
                    ...(turnMeta.userCreatedAt ? {createdAt: turnMeta.userCreatedAt} : {}),
                    ...(turnMeta.userTs ? {ts: turnMeta.userTs} : {}),
                },
                'openai',
                ctxCfg
            );
        }

        const allowCrossAttachments = Boolean(this._config?.allowCrossContextAttachments);
        const privacyInspection = inspectCrossContextAttachmentPrivacy(this._store?.messages || [], {
            targetBackend: 'openai',
            targetEndpoint,
            excludeMessageId: effectiveUserMessageId,
        });
        if (!allowCrossAttachments && privacyInspection.hasCrossContextAttachments && privacyInspection.privacyNotice) {
            this._turns.emitForTurn(turn, {
                type: 'mode_notice',
                message: privacyInspection.privacyNotice,
            });
        }

        let budgetedHistoryMessages;
        try {
            budgetedHistoryMessages = buildBudgetedContextMessages(this._store?.messages || [], {
                maxMessages: 24,
                maxChars: 28000,
                systemPrompt,
                targetBackend: 'openai',
                targetEndpoint,
                allowCrossContextAttachments: allowCrossAttachments,
                preserveAttachmentMessageId: effectiveUserMessageId,
                currentUserMessageId: effectiveUserMessageId,
                rejectOversizedCurrentPrompt: !allowPromptTruncate,
                ...(effectiveCtxWindow ? {contextWindowTokens: effectiveCtxWindow} : {}),
                ...(configuredReserveOutput ? {reserveOutputTokens: configuredReserveOutput} : {}),
            });
        } catch (ctxErr) {
            const errMsg = ctxErr?.message || String(ctxErr);
            this._turns.finalizeTurn(turn, {status: 'failed', errorText: errMsg});
            return {
                disposition: 'rejected_budget',
                turnId: turn.id,
                error: errMsg,
            };
        }

        if (budgetedHistoryMessages.length === 0) {
            budgetedHistoryMessages = [{role: 'user', content: budgetCheck.promptText}];
        }

        if (systemPrompt !== baseSystemPrompt) {
            const lastUser = budgetedHistoryMessages.findLast(message => message.role === 'user');
            if (lastUser) lastUser.content = `${memoryContext}\n\n本轮请求\n${lastUser.content}`;
        }
        const apiMessages = [
            {role: 'system', content: baseSystemPrompt},
            ...budgetedHistoryMessages,
        ];

        const chatUrl = this._runtime.chatUrl;
        const msg = Soup.Message.new('POST', chatUrl);
        if (!msg) {
            const err = new Error(`无效的 OpenAI 接口地址：${chatUrl}`);
            this._turns.finalizeTurn(turn, {status: 'failed', errorText: err.message});
            throw err;
        }

        const linkedRequestCancel = createLinkedCancellable(turn.cancellable);
        const redirectGuardState = {blockedError: null, policy: null, strippedAuth: false, signalIds: []};
        attachCrossOriginRedirectGuard(msg, chatUrl, {
            method: 'POST',
            cancellable: linkedRequestCancel.cancellable,
            allowCrossOriginPostRedirect: Boolean(this._config?.allowCrossOriginPostRedirect),
            state: redirectGuardState,
        });

        const reqHeaders = msg.get_request_headers();
        reqHeaders.append('Content-Type', 'application/json');
        reqHeaders.append('Accept', 'text/event-stream, application/json');
        if (this._runtime.apiKey) {
            reqHeaders.append('Authorization', `Bearer ${this._runtime.apiKey}`);
        }

        const explicitReasoningSupport = typeof this._config?.supportsReasoningEffort === 'boolean'
            ? this._config.supportsReasoningEffort
            : (typeof modelMeta?.supportsReasoningEffort === 'boolean' ? modelMeta.supportsReasoningEffort : null);
        const canSendReasoningEffort = Boolean(
            this._runtime.reasoningEffort &&
            supportsOpenAIReasoningEffort(modelId, explicitReasoningSupport)
        );
        const reqBody = {
            model: modelId,
            stream: true,
            messages: apiMessages,
        };
        if (canSendReasoningEffort) {
            reqBody.reasoning_effort = this._runtime.reasoningEffort;
            turn.reasoningEffort = this._runtime.reasoningEffort;
        }
        msg.set_request_body_from_bytes('application/json', new GLib.Bytes(Encoder.encode(JSON.stringify(reqBody))));

        const endpointSecurity = inspectEndpointSecurity(this._runtime.baseUrl || '');
        if (endpointSecurity.isRemotePlaintextHttp && endpointSecurity.warning) {
            this._turns.emitForTurn(turn, {
                type: 'mode_notice',
                message: endpointSecurity.warning,
            });
        }

        this._turns.markStreaming(turn);
        this._turns.emitForTurn(turn, {
            type: 'message_start',
            modelId,
            contextWindowTokens: turn.contextWindowTokens || 0,
            reasoningEffort: turn.reasoningEffort || '',
            message: {role: 'assistant'},
        });
        turn.setWatchdogPhase?.(
            resolvedTimeouts.connectTimeoutSec,
            `连接 OpenAI 接口超时（${resolvedTimeouts.connectTimeoutSec}s）`
        );

        let activeBaseStream = null;
        const closeOpenAIStream = () => {
            linkedRequestCancel.dispose();
            if (!activeBaseStream) return;
            const s = activeBaseStream;
            activeBaseStream = null;
            try {
                s.close_async(GLib.PRIORITY_DEFAULT, null, (st, r) => {
                    try { st.close_finish(r); } catch (_) {}
                });
            } catch (_) {}
        };

        const sseParser = new OpenAISseParser({
            apiKey: this._runtime.apiKey,
        });

        const settleOpenAI = ({
            status = '',
            interrupted = false,
            errorText = '',
            finishReason = '',
            usage = null,
        } = {}) => {
            closeOpenAIStream();
            if (!this._turns.isCurrent(turn)) return;

            const effectiveErrorText = redirectGuardState.blockedError?.message || errorText;
            const cleanError = effectiveErrorText
                ? redactSensitiveText(effectiveErrorText, {apiKey: this._runtime.apiKey, maxChars: 300})
                : '';

            let finalStatus = status;
            let finalInterrupted = Boolean(interrupted);
            if (redirectGuardState.blockedError) {
                finalStatus = 'failed';
                finalInterrupted = false;
            } else if (turn.timedOut) {
                finalStatus = 'timed_out';
            } else if (turn.aborted) {
                finalStatus = 'cancelled';
            } else if (!finalStatus) {
                if (cleanError) {
                    finalStatus = 'failed';
                } else if (!turn.sawDoneMarker) {
                    finalStatus = 'interrupted';
                    finalInterrupted = true;
                } else {
                    finalStatus = 'completed';
                }
            }

            const effectiveFinishReason = finishReason || sseParser.finishReason || turn.finishReason || '';
            const effectiveUsage = normalizeOpenAIUsage(usage || sseParser.usage || turn.usage || null);
            const persistCfg = this._getSessionContextConfig();
            this._turns.finalizeTurn(turn, {
                status: finalStatus,
                interrupted: finalInterrupted,
                finishReason: effectiveFinishReason,
                usage: effectiveUsage,
                contextWindowTokens: turn.contextWindowTokens || 0,
                reasoningEffort: turn.reasoningEffort || '',
                errorText: cleanError,
                onPersistAssistant: m => this._store?.appendMessage(m, 'openai', persistCfg),
            });
            if (finalStatus === 'completed') {
                this._store?.markRemoteTurnSynced?.(this._store.revision);
            }
        };

        const applyParsedSseEvents = events => {
            for (const evt of events) {
                if (!this._turns.isCurrent(turn)) return false;
                if (evt.usage) {
                    turn.usage = normalizeOpenAIUsage(evt.usage);
                }
                if (evt.type === 'error') {
                    settleOpenAI({status: 'failed', errorText: evt.error});
                    return false;
                }
                if (evt.type === 'done') {
                    turn.sawDoneMarker = true;
                    if (evt.finishReason) turn.finishReason = evt.finishReason;
                    settleOpenAI({
                        status: 'completed',
                        finishReason: evt.finishReason || sseParser.finishReason || '',
                        usage: evt.usage || sseParser.usage || turn.usage || null,
                    });
                    return false;
                }
                if (evt.type === 'delta') {
                    if (evt.model) turn.reportedModelId = turn.modelId = String(evt.model).slice(0, 160);
                    if (evt.finishReason) turn.finishReason = evt.finishReason;
                    if (evt.thinkingDelta) this._turns.appendThinking(turn, evt.thinkingDelta);
                    if (evt.textDelta) this._turns.appendText(turn, evt.textDelta);
                }
            }
            return true;
        };

        this._httpSession.send_async(msg, GLib.PRIORITY_DEFAULT, linkedRequestCancel.cancellable, (sess, res) => {
            let baseStream = null;
            try {
                baseStream = sess.send_finish(res);
            } catch (err) {
                if (this._turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
                    if (redirectGuardState.blockedError) {
                        settleOpenAI({
                            status: 'failed',
                            errorText: redirectGuardState.blockedError.message,
                        });
                    } else {
                        settleOpenAI({
                            status: turn.aborted ? 'cancelled' : 'failed',
                            errorText: turn.aborted ? '' : `请求失败：${err.message}`,
                        });
                    }
                }
                return;
            }

            if (!this._turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
                linkedRequestCancel.dispose();
                try {
                    baseStream?.close_async(GLib.PRIORITY_DEFAULT, null, (st, r) => {
                        try { st.close_finish(r); } catch (_) {}
                    });
                } catch (_) {}
                return;
            }

            activeBaseStream = baseStream;
            if (redirectGuardState.blockedError) {
                settleOpenAI({
                    status: 'failed',
                    errorText: redirectGuardState.blockedError.message,
                });
                return;
            }

            const status = msg.get_status();

            if (status < 200 || status >= 300) {
                const errorByteChunks = [];
                let errorBytes = 0;
                const readErrorChunks = () => {
                    if (!this._turns.isCurrent(turn) || !activeBaseStream) {
                        closeOpenAIStream();
                        return;
                    }
                    activeBaseStream.read_bytes_async(8192, GLib.PRIORITY_DEFAULT, linkedRequestCancel.cancellable, (s, r) => {
                        let gbytes = null;
                        try { gbytes = s.read_bytes_finish(r); } catch (_) {}

                        if (!this._turns.isCurrent(turn)) {
                            closeOpenAIStream();
                            return;
                        }
                        const chunk = gbytes ? gbytes.get_data() : null;
                        if (chunk && chunk.byteLength > 0 && errorBytes < DEFAULT_SSE_LIMITS.maxErrorBodyBytes) {
                            const allowed = chunk.slice(0, DEFAULT_SSE_LIMITS.maxErrorBodyBytes - errorBytes);
                            errorByteChunks.push(allowed);
                            errorBytes += allowed.byteLength;
                            if (errorBytes < DEFAULT_SSE_LIMITS.maxErrorBodyBytes) {
                                readErrorChunks();
                                return;
                            }
                        }
                        const merged = new Uint8Array(errorBytes);
                        let offset = 0;
                        for (const part of errorByteChunks) {
                            merged.set(part, offset);
                            offset += part.byteLength;
                        }
                        const detail = formatSanitizedHttpError(
                            status,
                            msg.get_reason_phrase() || '',
                            errorBytes > 0 ? Decoder.decode(merged) : '',
                            {apiKey: this._runtime.apiKey}
                        );
                        settleOpenAI({status: 'failed', errorText: detail});
                    });
                };
                readErrorChunks();
                return;
            }

            let sawFirstPayloadChunk = false;
            turn.setWatchdogPhase?.(
                resolvedTimeouts.firstByteTimeoutSec,
                `等待模型首字响应超时（${resolvedTimeouts.firstByteTimeoutSec}s）`
            );

            const readSseChunks = () => {
                if (!this._turns.isCurrent(turn) || !activeBaseStream) {
                    closeOpenAIStream();
                    return;
                }
                activeBaseStream.read_bytes_async(16384, GLib.PRIORITY_DEFAULT, linkedRequestCancel.cancellable, (s, r) => {
                    let gbytes = null;
                    try {
                        gbytes = s.read_bytes_finish(r);
                    } catch (err) {
                        if (!this._turns.isCurrent(turn)) {
                            closeOpenAIStream();
                            return;
                        }
                        if (redirectGuardState.blockedError) {
                            settleOpenAI({
                                status: 'failed',
                                errorText: redirectGuardState.blockedError.message,
                            });
                            return;
                        }
                        settleOpenAI({
                            status: turn.aborted ? 'cancelled' : 'failed',
                            errorText: turn.aborted ? '' : err.message,
                        });
                        return;
                    }

                    if (!this._turns.isCurrent(turn)) {
                        closeOpenAIStream();
                        return;
                    }

                    const rawChunk = gbytes ? gbytes.get_data() : null;
                    if (!rawChunk || rawChunk.byteLength === 0) {
                        const fin = sseParser.finish();
                        if (fin.usage) {
                            turn.usage = normalizeOpenAIUsage(fin.usage);
                        }
                        if (!applyParsedSseEvents(fin.events)) return;
                        if (fin.isNonSseJson) {
                            if (fin.model) turn.reportedModelId = turn.modelId = String(fin.model).slice(0, 160);
                            if (fin.finishReason) turn.finishReason = fin.finishReason;
                            if (fin.nonSseThinking) this._turns.replaceThinking(turn, fin.nonSseThinking);
                            if (fin.nonSseText) this._turns.replaceText(turn, fin.nonSseText);
                            turn.sawDoneMarker = true;
                            settleOpenAI({
                                status: 'completed',
                                finishReason: fin.finishReason || '',
                                usage: fin.usage || null,
                            });
                            return;
                        }
                        if (fin.completedCleanly) {
                            turn.sawDoneMarker = true;
                            settleOpenAI({
                                status: 'completed',
                                finishReason: fin.finishReason || '',
                                usage: fin.usage || null,
                            });
                            return;
                        }
                        if (fin.interrupted) {
                            settleOpenAI({
                                status: 'interrupted',
                                interrupted: true,
                                finishReason: fin.finishReason || '',
                                usage: fin.usage || null,
                                errorText: fin.error,
                            });
                            return;
                        }
                        settleOpenAI({
                            status: 'failed',
                            finishReason: fin.finishReason || '',
                            usage: fin.usage || null,
                            errorText: fin.error || '响应解析失败',
                        });
                        return;
                    }

                    if (!sawFirstPayloadChunk) {
                        sawFirstPayloadChunk = true;
                        turn.setWatchdogPhase?.(
                            resolvedTimeouts.streamIdleTimeoutSec,
                            `流式响应空闲超时（${resolvedTimeouts.streamIdleTimeoutSec}s）`
                        );
                    } else {
                        turn.resetWatchdog?.();
                    }

                    const parsedEvents = sseParser.pushBytes(rawChunk);
                    if (!applyParsedSseEvents(parsedEvents)) return;
                    readSseChunks();
                });
            };
            readSseChunks();
        });

        return {disposition: 'streaming', turnId: turn.id};
    }

    async cancel(turnId = '') {
        const active = this._turns?.activeTurn;
        if (!active || active.finalized) return {aborted: false};
        if (turnId && active.id !== String(turnId)) return {aborted: false, stale: true};
        const ctxCfg = this._getSessionContextConfig();
        this._turns.cancelActiveTurn({
            onPersistAssistant: m => this._store?.appendMessage(m, 'openai', ctxCfg),
        });
        return {aborted: true, turnId: active.id};
    }

    dispose() {
        super.dispose();
        this._modelsRequestSeq += 1;
        try { this._modelsCancellable?.cancel?.(); } catch (_) {}
        this._modelsCancellable = null;
        try { this._httpSession?.abort(); } catch (_) {}
        this._httpSession = null;
    }
}

