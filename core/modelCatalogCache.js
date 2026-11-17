/**
 * Pure-JS CLI/Catalog Async Cache & Searchable/Favorite Model Picker Engine
 * (Stage D4, zero GJS dependencies).
 *
 * Guarantees:
 * 1. Zero synchronous filesystem/PATH scanning on panel/picker open critical path:
 *    callers read `peek()` immediately and trigger single-flight `getOrLoadAsync()` in background.
 * 2. Explicit invalidation on GSettings changes or manual refresh (`invalidate()` / `invalidatePrefix()`).
 * 3. Strips secret fields (`apiKey`, `secret`, `token`) before storing provider catalogs in cache,
 *    and enforces byte ceilings (`MAX_PROVIDER_CONFIG_BYTES`) before `JSON.parse`.
 * 4. Searchable, filterable, paginated model ranking with `★` favorites and recent-model priority —
 *    never trapping models beyond the first 10 items!
 */

import {normalizeEndpointKeyIdentity} from './secretPolicy.js';

export const DEFAULT_CLI_CACHE_TTL_MS = 60_000;
export const DEFAULT_CATALOG_CACHE_TTL_MS = 45_000;
export const MAX_PROVIDER_CONFIG_BYTES = 4 * 1024 * 1024; // 4 MiB ceiling on local config JSON/TOML
export const DEFAULT_PICKER_PAGE_SIZE = 8;

export function makeModelEntryKey(backend, providerId, modelId) {
    return `${String(backend || '').trim()}::${String(providerId || '').trim()}::${String(modelId || '').trim()}`;
}

export function makeEndpointModelMetadataKey(endpointOrUrl, modelId) {
    const cleanEndpoint = normalizeEndpointKeyIdentity(endpointOrUrl) || String(endpointOrUrl || '').trim().toLowerCase() || '__default__';
    const cleanModel = String(modelId || '').trim();
    return `${cleanEndpoint}::${cleanModel}`;
}

export function sanitizeProviderCatalogSecrets(catalog) {
    if (!catalog || typeof catalog !== 'object') return catalog;
    const providers = Array.isArray(catalog.providers)
        ? catalog.providers.map(p => ({
            id: String(p?.id || ''),
            name: String(p?.name || p?.id || ''),
            baseUrl: String(p?.baseUrl || ''),
            apiKey: '', // Never retain plaintext API keys in catalog cache!
            models: Array.isArray(p?.models) ? p.models.map(String).filter(Boolean) : [],
        }))
        : [];
    return {
        backendLabel: String(catalog.backendLabel || ''),
        providers,
        defaultProviderId: String(catalog.defaultProviderId || ''),
        defaultModelId: String(catalog.defaultModelId || ''),
    };
}

export class ExpiringResourceCache {
    constructor({defaultTtlMs = DEFAULT_CATALOG_CACHE_TTL_MS, nowFn = () => Date.now()} = {}) {
        this._defaultTtlMs = Math.max(1000, Number(defaultTtlMs) || DEFAULT_CATALOG_CACHE_TTL_MS);
        this._nowFn = nowFn;
        this._entries = new Map();
        this._inflight = new Map();
        this._epoch = 0;
    }

    /**
     * Returns `{hit, stale, value}` synchronously with zero I/O so UI renders cached state immediately.
     */
    peek(key) {
        const rec = this._entries.get(key);
        if (!rec) {
            return {hit: false, stale: true, value: undefined};
        }
        const stale = this._nowFn() > rec.expiresAt;
        return {hit: true, stale, value: rec.value};
    }

    set(key, value, ttlMs = this._defaultTtlMs) {
        this._entries.set(key, {
            value,
            storedAt: this._nowFn(),
            expiresAt: this._nowFn() + Math.max(250, Number(ttlMs) || this._defaultTtlMs),
        });
        return value;
    }

    /**
     * Single-flight async loader: coalesces concurrent background refreshes for the same `key`,
     * and discards results if `invalidate()` bumped `_epoch` while the async read was in flight.
     */
    getOrLoadAsync(key, loaderFn, {ttlMs = this._defaultTtlMs, forceRefresh = false} = {}) {
        if (!forceRefresh) {
            const cached = this.peek(key);
            if (cached.hit && !cached.stale) {
                return Promise.resolve(cached.value);
            }
        }
        if (!forceRefresh && this._inflight.has(key)) {
            return this._inflight.get(key);
        }

        const startEpoch = this._epoch;
        const promise = (async () => {
            const loaded = await loaderFn();
            if (this._epoch === startEpoch) {
                this.set(key, loaded, ttlMs);
            }
            return loaded;
        })().finally(() => {
            if (this._inflight.get(key) === promise) {
                this._inflight.delete(key);
            }
        });

        this._inflight.set(key, promise);
        return promise;
    }

    invalidate(key = '') {
        this._epoch++;
        if (!key) {
            this._entries.clear();
            this._inflight.clear();
            return;
        }
        this._entries.delete(key);
        this._inflight.delete(key);
    }

    invalidatePrefix(prefix) {
        this._epoch++;
        for (const k of Array.from(this._entries.keys())) {
            if (k.startsWith(prefix)) this._entries.delete(k);
        }
        for (const k of Array.from(this._inflight.keys())) {
            if (k.startsWith(prefix)) this._inflight.delete(k);
        }
    }
}

export function flattenCatalogModelEntries(catalog, {
    backend = '',
    extraModels = [],
} = {}) {
    const out = [];
    const seen = new Set();
    const providers = Array.isArray(catalog?.providers) ? catalog.providers : [];

    for (const prov of providers) {
        const providerId = String(prov?.id || '').trim();
        const providerName = String(prov?.name || providerId || '').trim();
        for (const rawModel of prov?.models || []) {
            const modelId = String(rawModel || '').trim();
            if (!modelId) continue;
            const key = makeModelEntryKey(backend, providerId, modelId);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                key,
                backend,
                providerId,
                providerName,
                modelId,
            });
        }
    }

    for (const extra of extraModels || []) {
        const modelId = typeof extra === 'string' ? extra.trim() : String(extra?.modelId || '').trim();
        const providerId = typeof extra === 'object' && extra ? String(extra.providerId || '').trim() : '';
        if (!modelId) continue;
        const alreadyByModel = out.some(
            e => e.modelId === modelId && (!providerId || e.providerId === providerId)
        );
        if (alreadyByModel) continue;
        const key = makeModelEntryKey(backend, providerId, modelId);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            key,
            backend,
            providerId,
            providerName: providerId,
            modelId,
        });
    }

    return out;
}

/**
 * Filters, ranks (favorites -> recent -> active -> catalog order), and paginates model entries
 * so users can access ANY model in arbitrarily large catalogs without blocking or overflowing UI.
 */
export function filterAndRankModels(entries, {
    query = '',
    favoriteKeys = [],
    recentKeys = [],
    selectedProviderId = '',
    selectedModelId = '',
    page = 0,
    pageSize = DEFAULT_PICKER_PAGE_SIZE,
} = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const favSet = new Set(Array.isArray(favoriteKeys) ? favoriteKeys : []);
    const recentList = Array.isArray(recentKeys) ? recentKeys : [];
    const recentRank = new Map();
    recentList.forEach((k, idx) => {
        if (!recentRank.has(k)) recentRank.set(k, idx);
    });

    const tokens = String(query || '')
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);

    const decorated = [];
    list.forEach((entry, originalIndex) => {
        const hayModel = entry.modelId.toLowerCase();
        const hayProv = `${entry.providerId} ${entry.providerName}`.toLowerCase();
        const hayCombined = `${hayModel} ${hayProv}`;

        if (tokens.length > 0) {
            const allMatch = tokens.every(tok => hayCombined.includes(tok));
            if (!allMatch) return;
        }

        const isFavorite = favSet.has(entry.key) || favSet.has(makeModelEntryKey(entry.backend, '', entry.modelId));
        const recIdx = recentRank.has(entry.key)
            ? recentRank.get(entry.key)
            : (recentRank.has(makeModelEntryKey(entry.backend, '', entry.modelId))
                ? recentRank.get(makeModelEntryKey(entry.backend, '', entry.modelId))
                : -1);
        const isSelected = Boolean(
            selectedModelId &&
            entry.modelId === selectedModelId &&
            (!selectedProviderId || !entry.providerId || entry.providerId === selectedProviderId)
        );

        let queryScore = 0;
        if (tokens.length > 0) {
            const firstTok = tokens[0];
            if (hayModel === firstTok) queryScore = 300;
            else if (hayModel.startsWith(firstTok)) queryScore = 200;
            else if (hayModel.includes(firstTok)) queryScore = 100;
            else queryScore = 50;
        }

        decorated.push({
            ...entry,
            isFavorite,
            isRecent: recIdx >= 0,
            recentOrder: recIdx >= 0 ? recIdx : 9999,
            isSelected,
            queryScore,
            originalIndex,
        });
    });

    decorated.sort((a, b) => {
        if (tokens.length > 0 && a.queryScore !== b.queryScore) {
            return b.queryScore - a.queryScore;
        }
        if (a.isFavorite !== b.isFavorite) {
            return a.isFavorite ? -1 : 1;
        }
        if (a.isSelected !== b.isSelected) {
            return a.isSelected ? -1 : 1;
        }
        if (a.isRecent !== b.isRecent) {
            return a.isRecent ? -1 : 1;
        }
        if (a.isRecent && b.isRecent && a.recentOrder !== b.recentOrder) {
            return a.recentOrder - b.recentOrder;
        }
        return a.originalIndex - b.originalIndex;
    });

    const safePageSize = Math.max(2, Number(pageSize) || DEFAULT_PICKER_PAGE_SIZE);
    const totalFiltered = decorated.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / safePageSize));
    const safePage = Math.min(Math.max(0, Number(page) || 0), totalPages - 1);
    const start = safePage * safePageSize;
    const pageItems = decorated.slice(start, start + safePageSize);

    return {
        totalCount: list.length,
        totalFiltered,
        page: safePage,
        pageSize: safePageSize,
        totalPages,
        hasPrevPage: safePage > 0,
        hasNextPage: safePage < totalPages - 1,
        items: pageItems,
    };
}

export function toggleFavoriteModelKey(favoriteKeys, targetKey, maxFavorites = 30) {
    const cleanTarget = String(targetKey || '').trim();
    const current = Array.isArray(favoriteKeys) ? favoriteKeys.filter(Boolean) : [];
    if (!cleanTarget) return current;
    const idx = current.indexOf(cleanTarget);
    if (idx >= 0) {
        const next = [...current];
        next.splice(idx, 1);
        return next;
    }
    return [cleanTarget, ...current].slice(0, maxFavorites);
}

export function recordRecentModelKey(recentKeys, targetKey, maxRecent = 12) {
    const cleanTarget = String(targetKey || '').trim();
    const current = Array.isArray(recentKeys) ? recentKeys.filter(Boolean) : [];
    if (!cleanTarget) return current;
    const without = current.filter(k => k !== cleanTarget);
    return [cleanTarget, ...without].slice(0, maxRecent);
}

/**
 * Per-endpoint + model metadata cache (`contextWindowTokens`, `supportsReasoningEffort`, etc.).
 * Ensures two different OpenAI-compatible endpoints sharing the same model name (e.g. `gpt-4o` or `qwen-coder`)
 * never overwrite or pollute each other's context window or capability metadata (Stage R9).
 */
export class EndpointModelMetadataCache {
    constructor({maxEntries = 1000} = {}) {
        this._maxEntries = Math.max(32, Number(maxEntries) || 1000);
        this._byEndpointAndModel = new Map();
    }

    _resolveEndpointKey(endpointOrUrl) {
        return normalizeEndpointKeyIdentity(endpointOrUrl) || String(endpointOrUrl || '').trim().toLowerCase() || '__default__';
    }

    set(endpointOrUrl, modelId, metadata = {}) {
        const cleanModel = String(modelId || '').trim();
        if (!cleanModel || !metadata || typeof metadata !== 'object') return null;
        const endpointKey = this._resolveEndpointKey(endpointOrUrl);
        const compositeKey = `${endpointKey}::${cleanModel}`;
        const existing = this._byEndpointAndModel.get(compositeKey) || {};
        const merged = {
            ...existing,
            ...metadata,
            endpointKey,
            modelId: cleanModel,
        };
        if (this._byEndpointAndModel.has(compositeKey)) {
            this._byEndpointAndModel.delete(compositeKey);
        } else if (this._byEndpointAndModel.size >= this._maxEntries) {
            const oldestKey = this._byEndpointAndModel.keys().next().value;
            if (oldestKey !== undefined) {
                this._byEndpointAndModel.delete(oldestKey);
            }
        }
        this._byEndpointAndModel.set(compositeKey, merged);
        return merged;
    }

    setBatch(endpointOrUrl, metadataById = {}) {
        if (!metadataById || typeof metadataById !== 'object') return;
        for (const [modelId, meta] of Object.entries(metadataById)) {
            this.set(endpointOrUrl, modelId, meta);
        }
    }

    get(endpointOrUrl, modelId) {
        const cleanModel = String(modelId || '').trim();
        if (!cleanModel) return null;
        const endpointKey = this._resolveEndpointKey(endpointOrUrl);
        return this._byEndpointAndModel.get(`${endpointKey}::${cleanModel}`) || null;
    }

    getEndpointMap(endpointOrUrl) {
        const endpointKey = this._resolveEndpointKey(endpointOrUrl);
        const prefix = `${endpointKey}::`;
        const out = {};
        for (const [key, value] of this._byEndpointAndModel.entries()) {
            if (key.startsWith(prefix)) {
                out[value.modelId] = {...value};
            }
        }
        return out;
    }

    clearEndpoint(endpointOrUrl) {
        const endpointKey = this._resolveEndpointKey(endpointOrUrl);
        const prefix = `${endpointKey}::`;
        for (const key of Array.from(this._byEndpointAndModel.keys())) {
            if (key.startsWith(prefix)) {
                this._byEndpointAndModel.delete(key);
            }
        }
    }

    clearAll() {
        this._byEndpointAndModel.clear();
    }
}

export const defaultEndpointModelMetadataCache = new EndpointModelMetadataCache();

const KNOWN_NON_REASONING_OPENAI_MODEL_RE =
    /^(?:gpt-3\.5|gpt-4-turbo|gpt-4-0613|gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?|chatgpt-4o-latest|text-embedding|whisper|tts|dall-e)/i;
const KNOWN_NON_REASONING_ANTHROPIC_MODEL_RE =
    /^(?:claude-3-haiku|claude-3-5-haiku|claude-2|claude-instant)/i;

/**
 * Determines whether the currently active backend + model supports reasoning effort (`思考强度`),
 * allowing the UI to hide or disable thinking chips when unsupported (Stage R11.1).
 */
export function resolveModelThinkingCapability(backendOrOptions = {}, maybeModelId = '', maybeOptions = {}) {
    const isFirstObj = backendOrOptions && typeof backendOrOptions === 'object';
    const {
        effectiveBackend = isFirstObj ? 'unconfigured' : String(backendOrOptions || 'unconfigured'),
        modelId = isFirstObj ? '' : String(maybeModelId || ''),
        endpointUrl = '',
        runtimeCapabilities = null,
        metadataCache = defaultEndpointModelMetadataCache,
    } = isFirstObj ? backendOrOptions : (maybeOptions || {});

    const cleanBackend = String(effectiveBackend || 'unconfigured').trim();
    const cleanModel = String(modelId || '').trim();
    if (!cleanBackend || cleanBackend === 'unconfigured') {
        return {
            supported: false,
            reason: '未配置可用后端，不支持思考强度调节',
        };
    }
    if (
        runtimeCapabilities &&
        typeof runtimeCapabilities === 'object' &&
        (runtimeCapabilities.supportsThinking === false || runtimeCapabilities.supportsReasoningEffort === false)
    ) {
        return {
            supported: false,
            reason: '当前后端版本不支持思考强度调节',
        };
    }

    if (cleanBackend === 'openai') {
        const meta = metadataCache?.get?.(endpointUrl, cleanModel) || null;
        if (meta && meta.supportsReasoningEffort === false) {
            return {
                supported: false,
                reason: `模型 ${cleanModel || '当前模型'} 不支持思考强度参数`,
            };
        }
        if (cleanModel && KNOWN_NON_REASONING_OPENAI_MODEL_RE.test(cleanModel) && meta?.supportsReasoningEffort !== true) {
            return {
                supported: false,
                reason: `模型 ${cleanModel} 为非推理模型，不支持思考强度调节`,
            };
        }
    }

    if (cleanModel && KNOWN_NON_REASONING_ANTHROPIC_MODEL_RE.test(cleanModel)) {
        return {
            supported: false,
            reason: `模型 ${cleanModel} 不支持思考强度调节`,
        };
    }

    return {
        supported: true,
        reason: '',
    };
}

/**
 * Computes the complete model picker presentation state (Stage R11.1):
 * - Current real resolved model (`activeModelId` / `realActiveModel` even when `profile.model` is empty)
 * - Per-backend installation/configuration badges (`未安装` / `未配置`)
 * - Explicit unsupported capability summary
 * - Model-aware thinking effort availability (`thinkingSupport` / `thinkingSupported`)
 * - Favorites -> Recent -> Active -> Catalog ranked model page
 */
export function resolveModelPickerState({
    configuredBackend = 'auto',
    effectiveBackend = 'unconfigured',
    profile = {},
    configuredModel = '',
    currentResolvedModel = '',
    configuredEffort = '',
    backendAvailable = undefined,
    unavailableReason = '',
    catalog = null,
    cachedOpenAiModels = [],
    favoriteKeys = [],
    recentKeys = [],
    query = '',
    page = 0,
    pageSize = DEFAULT_PICKER_PAGE_SIZE,
    availableBackends = null,
    runtimeModelId = '',
    runtimeProviderId = '',
    runtimeCapabilities = null,
    endpointUrl = '',
    metadataCache = defaultEndpointModelMetadataCache,
} = {}) {
    const configured = String(configuredBackend || 'auto').trim() || 'auto';
    const eff = String(effectiveBackend || 'unconfigured').trim() || 'unconfigured';
    const explicitModelId = String(profile?.model || configuredModel || '').trim();
    const explicitProviderId = String(profile?.provider || '').trim();

    const activeModelId =
        explicitModelId ||
        String(runtimeModelId || currentResolvedModel || '').trim() ||
        String(catalog?.defaultModelId || '').trim();
    const activeProviderId =
        explicitProviderId ||
        String(runtimeProviderId || '').trim() ||
        String(catalog?.defaultProviderId || '').trim();
    const isUsingDefaultModel = !explicitModelId && Boolean(activeModelId);

    const hasAvailabilityInfo =
        availableBackends instanceof Set || Array.isArray(availableBackends);
    const availSet = availableBackends instanceof Set
        ? availableBackends
        : new Set(Array.isArray(availableBackends) ? availableBackends : []);
    if (eff !== 'unconfigured' && backendAvailable !== false) {
        availSet.add(eff);
    }

    const isBackendAvailable = backendAvailable !== undefined
        ? Boolean(backendAvailable)
        : (eff !== 'unconfigured' && (!hasAvailabilityInfo || availSet.has(eff)));

    const backendChips = [
        {id: 'auto', label: '自动'},
        {id: 'zcode', label: 'ZCode'},
        {id: 'codex', label: 'Codex'},
        {id: 'openai', label: 'OpenAI'},
    ].map(item => {
        const active = configured === item.id;
        let installed = true;
        let statusTag = '';
        if (item.id !== 'auto') {
            if (backendAvailable === false && (item.id === eff || item.id === configured)) {
                installed = false;
            } else if (hasAvailabilityInfo) {
                installed = availSet.has(item.id);
            }
            if (!installed) {
                statusTag = item.id === 'openai' ? '未配置' : '未安装';
            }
        }
        return {
            id: item.id,
            label: item.label,
            displayLabel: statusTag ? `${item.label} (${statusTag})` : item.label,
            active,
            installed,
            statusTag,
        };
    });

    const extraModels = [];
    if (eff === 'openai' && Array.isArray(cachedOpenAiModels)) {
        for (const m of cachedOpenAiModels) {
            if (m) extraModels.push({providerId: '', modelId: String(m).trim()});
        }
    }
    if (activeModelId) {
        extraModels.push({providerId: activeProviderId, modelId: activeModelId});
    }

    const allEntries = flattenCatalogModelEntries(catalog, {
        backend: eff,
        extraModels,
    });
    const ranked = filterAndRankModels(allEntries, {
        query,
        favoriteKeys,
        recentKeys,
        selectedProviderId: activeProviderId,
        selectedModelId: activeModelId,
        page,
        pageSize,
    });

    const thinkingSupport = isBackendAvailable
        ? resolveModelThinkingCapability({
            effectiveBackend: eff,
            modelId: activeModelId,
            endpointUrl,
            runtimeCapabilities,
            metadataCache,
        })
        : {supported: false, reason: unavailableReason || '当前后端未安装或未配置'};

    let capabilityNotice = '';
    if (!isBackendAvailable) {
        capabilityNotice = unavailableReason
            ? (unavailableReason.includes('未安装') || unavailableReason.includes('未配置')
                ? `⚠️ ${unavailableReason}`
                : `⚠️ 未安装/不可用：${unavailableReason}`)
            : '⚠️ 未检测到已安装或已配置的后端（ZCode / Codex 未安装，OpenAI 未配置）';
    } else if (configured !== 'auto' && hasAvailabilityInfo && !availSet.has(configured)) {
        capabilityNotice = configured === 'openai'
            ? '⚠️ OpenAI API 尚未配置 Base URL，请点击「更多设置…」配置'
            : `⚠️ 所选 ${configured === 'zcode' ? 'ZCode' : 'Codex'} CLI 未安装或路径无效`;
    } else if (eff === 'openai') {
        capabilityNotice = '能力: 纯对话 API（不支持本地工具执行与会话内审批）';
    } else if (eff === 'codex') {
        capabilityNotice = '能力: 只读沙箱工具调用（不支持会话内交互式审批提问）';
    } else if (eff === 'zcode') {
        const supportsTools = runtimeCapabilities?.supportsTools !== false;
        const supportsApproval = runtimeCapabilities?.supportsApproval !== false;
        capabilityNotice = supportsTools
            ? `能力: 工具调用 · ${supportsApproval ? '支持交互审批与提问' : '仅只读（不支持交互审批）'}`
            : '能力: 纯对话模式（已禁用工具执行）';
    }

    const rawEffort = String(configuredEffort || profile?.effort || 'default').trim() || 'default';
    const effectiveEffort = thinkingSupport.supported ? rawEffort : 'default';
    const activeModelSummary = activeModelId
        ? `当前真实模型：${activeModelId}${activeProviderId ? ` (${activeProviderId})` : ''}${isUsingDefaultModel ? ' [默认]' : ''}`
        : (eff === 'unconfigured' || !isBackendAvailable ? '当前真实模型：未配置' : '当前真实模型：自动默认');

    return {
        configuredBackend: configured,
        effectiveBackend: eff,
        backendAvailable: isBackendAvailable,
        activeModelId,
        realActiveModel: activeModelId,
        activeProviderId,
        isUsingDefaultModel,
        currentModelSummary: activeModelId
            ? `当前模型: ${activeModelId}${activeProviderId ? ` (${activeProviderId})` : ''}${isUsingDefaultModel ? ' [默认]' : ''}`
            : (eff === 'unconfigured' || !isBackendAvailable ? '当前模型: 未配置' : '当前模型: 自动默认'),
        activeModelSummary,
        backendChips,
        capabilityNotice,
        statusBanner: capabilityNotice,
        thinkingSupport,
        thinkingSupported: thinkingSupport.supported,
        effectiveEffort,
        ranked,
    };
}

