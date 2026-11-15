/**
 * Pure-JS API Key security, per-endpoint isolation, redirect guard, and serial write queue
 * (Stage C4, zero GJS dependencies).
 *
 * Guarantees:
 * 1. Canonical per-endpoint secret identity (`scheme://host[:nonDefaultPort][/basePath]`) so
 *    switching Base URL never leaks an old endpoint's API Key to a new host.
 * 2. Honest libsecret semantics: `store` checks boolean return, `clear` distinguishes
 *    "item removed (`true`)" vs "already absent (`false` + lookup empty)" vs "clear failed
 *    (thrown error or item still present after clear)", never claiming success on failure.
 * 3. Zero silent plaintext fallback: if Keyring is unavailable, secrets stay in process memory
 *    for the current runtime only unless `allowPlaintextFallback === true` was explicitly enabled.
 *    Legacy GSettings plaintext is erased strictly AFTER verified Keyring migration.
 * 4. Remote plaintext `http://` warning detection and cross-origin redirect `Authorization` stripping.
 * 5. Versioned serial `SecretWriteQueue` preventing slow async `load()` or out-of-order `store()`
 *    from overwriting newer user input, with `flush()` for window close safety.
 */

const LOOPBACK_HOSTS = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '[::1]',
    '0.0.0.0',
]);

function isLoopbackHostname(hostname = '') {
    const clean = String(hostname || '').trim().toLowerCase();
    if (!clean) return false;
    if (LOOPBACK_HOSTS.has(clean)) return true;
    if (/^127(?:\.\d{1,3}){3}$/.test(clean)) return true;
    if (clean.endsWith('.localhost')) return true;
    return false;
}

function normalizeEffectivePort(protocol, rawPort) {
    const port = String(rawPort || '').trim();
    if (!port) {
        return protocol === 'https:' ? '443' : (protocol === 'http:' ? '80' : '');
    }
    return port;
}

/**
 * Normalizes an OpenAI-compatible Base URL into a canonical secret lookup key.
 * Strips `/chat/completions`, `/models`, and trailing `/v1` so equivalent URLs for the same
 * service share one key while distinct hosts, ports, schemes, or tenant prefixes stay isolated.
 */
export function normalizeEndpointKeyIdentity(rawBaseUrl = '') {
    const trimmed = String(rawBaseUrl || '').trim();
    if (!trimmed) return '';
    try {
        const u = new URL(trimmed);
        const protocol = u.protocol.toLowerCase();
        if (protocol !== 'http:' && protocol !== 'https:') {
            return '';
        }
        const host = u.hostname.toLowerCase();
        if (!host) return '';
        const effPort = normalizeEffectivePort(protocol, u.port);
        const defaultPort = protocol === 'https:' ? '443' : '80';
        const portSuffix = effPort && effPort !== defaultPort ? `:${effPort}` : '';

        let path = u.pathname || '';
        path = path
            .replace(/\/chat\/completions\/?$/i, '')
            .replace(/\/models\/?$/i, '')
            .replace(/\/v1\/?$/i, '')
            .replace(/\/+$/, '');

        return `${protocol}//${host}${portSuffix}${path}`;
    } catch (_) {
        return '';
    }
}

/**
 * Inspects transport security of an OpenAI-compatible Base URL.
 * Never disables TLS; flags remote plaintext `http://` endpoints explicitly.
 */
export function inspectEndpointSecurity(rawBaseUrl = '') {
    const trimmed = String(rawBaseUrl || '').trim();
    if (!trimmed) {
        return {
            isValid: false,
            isEmpty: true,
            scheme: '',
            origin: '',
            endpointKey: '',
            isLoopback: false,
            isRemotePlaintextHttp: false,
            warning: '',
        };
    }

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch (_) {
        return {
            isValid: false,
            isEmpty: false,
            scheme: '',
            origin: '',
            endpointKey: '',
            isLoopback: false,
            isRemotePlaintextHttp: false,
            warning: '接口地址格式无效，请填写完整的 https:// 或 http:// 地址',
        };
    }

    const scheme = parsed.protocol.toLowerCase();
    if (scheme !== 'https:' && scheme !== 'http:') {
        return {
            isValid: false,
            isEmpty: false,
            scheme,
            origin: '',
            endpointKey: '',
            isLoopback: false,
            isRemotePlaintextHttp: false,
            warning: `不支持的协议类型 (${scheme})，仅允许 https:// 或本地 http://`,
        };
    }

    const loopback = isLoopbackHostname(parsed.hostname);
    const effPort = normalizeEffectivePort(scheme, parsed.port);
    const origin = `${scheme}//${parsed.hostname.toLowerCase()}:${effPort}`;
    const endpointKey = normalizeEndpointKeyIdentity(trimmed);
    const isRemotePlaintextHttp = scheme === 'http:' && !loopback;

    return {
        isValid: true,
        isEmpty: false,
        scheme,
        origin,
        endpointKey,
        isLoopback: loopback,
        isRemotePlaintextHttp,
        warning: isRemotePlaintextHttp
            ? '⚠️ 当前远程接口使用明文 HTTP，API Key 与对话内容可能被窃听；强烈建议改用 HTTPS（仅在您确认受控内网环境时继续使用）'
            : '',
    };
}

/**
 * Returns `true` if an HTTP redirect changes `scheme`, `hostname`, or effective `port`
 * (including any `https:` -> `http:` downgrade), requiring `Authorization` to be stripped!
 */
export function shouldStripAuthOnRedirect(initialUrl, redirectedUrl) {
    try {
        const a = new URL(String(initialUrl || ''));
        const b = new URL(String(redirectedUrl || ''));
        const schemeA = a.protocol.toLowerCase();
        const schemeB = b.protocol.toLowerCase();
        if (schemeA !== schemeB) return true;
        if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return true;
        if (normalizeEffectivePort(schemeA, a.port) !== normalizeEffectivePort(schemeB, b.port)) return true;
        return false;
    } catch (_) {
        // Fail closed: strip Authorization if either URL cannot be parsed cleanly
        return true;
    }
}

function encodePlaintextMap(mapObj) {
    const clean = {};
    for (const [k, v] of Object.entries(mapObj || {})) {
        if (k && typeof v === 'string' && v.trim()) {
            clean[k] = v.trim();
        }
    }
    const keys = Object.keys(clean);
    return keys.length > 0 ? JSON.stringify(clean) : '';
}

function decodePlaintextMap(rawStr, configuredEndpointKey = '') {
    const trimmed = String(rawStr || '').trim();
    if (!trimmed) return {map: {}, isLegacyRawString: false, legacyKey: ''};
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const map = {};
                for (const [k, v] of Object.entries(parsed)) {
                    if (typeof v === 'string' && v.trim()) {
                        map[k] = v.trim();
                    }
                }
                return {map, isLegacyRawString: false, legacyKey: ''};
            }
        } catch (_) {}
    }
    // Pre-v2 single plaintext string: bind ONLY to the currently configured endpoint during migration
    const map = {};
    if (configuredEndpointKey) {
        map[configuredEndpointKey] = trimmed;
    }
    return {map, isLegacyRawString: true, legacyKey: trimmed};
}

export const DEFAULT_KEY_SLOT = '__default_openai_endpoint__';

/**
 * Backend-agnostic secret manager supporting per-endpoint Keyring isolation,
 * runtime-only memory fallback, explicit opt-in plaintext fallback, and honest deletion.
 */
export class SecretKeyManager {
    constructor({
        keyring = null,
        memoryStore = new Map(),
    } = {}) {
        this._keyring = keyring;
        this._memory = memoryStore;
    }

    _resolveSlotKey(baseUrl, settingsAdapter) {
        const explicit = normalizeEndpointKeyIdentity(baseUrl);
        if (explicit) return explicit;
        const configuredUrl = settingsAdapter?.getBaseUrl?.() || '';
        const fromSettings = normalizeEndpointKeyIdentity(configuredUrl);
        return fromSettings || DEFAULT_KEY_SLOT;
    }

    /**
     * Loads the API key strictly for `baseUrl` (or the configured `openai-base-url` if omitted).
     * Never returns another endpoint's key when `baseUrl` is changed!
     */
    async loadKey(settingsAdapter, baseUrl = '') {
        const hasExplicitUrl = Boolean(String(baseUrl || '').trim());
        const explicitEndpointKey = hasExplicitUrl ? normalizeEndpointKeyIdentity(baseUrl) : '';
        if (hasExplicitUrl && !explicitEndpointKey) {
            // Invalid URL entered: never leak any stored key!
            return {
                apiKey: '',
                storage: 'none',
                endpointKey: '',
                migrated: false,
                warning: '',
            };
        }

        const configuredUrl = settingsAdapter?.getBaseUrl?.() || '';
        const configuredEndpointKey = normalizeEndpointKeyIdentity(configuredUrl) || DEFAULT_KEY_SLOT;
        const slotKey = explicitEndpointKey || configuredEndpointKey;
        const isCurrentConfiguredEndpoint = slotKey === configuredEndpointKey;

        // 1. Check runtime memory cache first if Keyring previously fell back to memory in this session
        if (this._memory.has(slotKey)) {
            return {
                apiKey: this._memory.get(slotKey) || '',
                storage: 'memory',
                endpointKey: slotKey,
                migrated: false,
                warning: '',
            };
        }

        const rawFallbackSetting = settingsAdapter?.getLegacyPlaintext?.() || '';
        const decodedFallback = decodePlaintextMap(rawFallbackSetting, isCurrentConfiguredEndpoint ? slotKey : '');
        const allowPlaintext = Boolean(settingsAdapter?.getAllowPlaintextFallback?.());

        // 2. Query GNOME Keyring for this exact endpoint slot
        let keyringOperational = Boolean(this._keyring?.available);
        if (keyringOperational) {
            try {
                const found = await this._keyring.lookupEndpoint(slotKey);
                if (found) {
                    // Clean up leftover legacy raw plaintext ONLY if it belonged to this endpoint
                    if (decodedFallback.isLegacyRawString && isCurrentConfiguredEndpoint && decodedFallback.legacyKey) {
                        settingsAdapter?.setLegacyPlaintext?.('');
                    } else if (decodedFallback.map[slotKey] && !allowPlaintext) {
                        delete decodedFallback.map[slotKey];
                        settingsAdapter?.setLegacyPlaintext?.(encodePlaintextMap(decodedFallback.map));
                    }
                    return {
                        apiKey: found,
                        storage: 'keyring',
                        endpointKey: slotKey,
                        migrated: false,
                        warning: '',
                    };
                }

                // One-time migration from legacy v1 global keyring entry ONLY for the user's configured endpoint
                if (isCurrentConfiguredEndpoint && typeof this._keyring.lookupLegacyGlobal === 'function') {
                    const legacyKeyringVal = await this._keyring.lookupLegacyGlobal();
                    if (legacyKeyringVal) {
                        const storedOk = await this._keyring.storeEndpoint(slotKey, legacyKeyringVal);
                        if (storedOk) {
                            try { await this._keyring.clearLegacyGlobal?.(); } catch (_) {}
                            if (decodedFallback.isLegacyRawString) {
                                settingsAdapter?.setLegacyPlaintext?.('');
                            }
                            return {
                                apiKey: legacyKeyringVal,
                                storage: 'keyring',
                                endpointKey: slotKey,
                                migrated: true,
                                warning: '',
                            };
                        }
                    }
                }

                // One-time migration from legacy GSettings plaintext ONLY for the user's configured endpoint
                const candidatePlaintext = decodedFallback.map[slotKey] || '';
                if (candidatePlaintext) {
                    const storedOk = await this._keyring.storeEndpoint(slotKey, candidatePlaintext);
                    if (storedOk) {
                        delete decodedFallback.map[slotKey];
                        settingsAdapter?.setLegacyPlaintext?.(
                            decodedFallback.isLegacyRawString ? '' : encodePlaintextMap(decodedFallback.map)
                        );
                        return {
                            apiKey: candidatePlaintext,
                            storage: 'keyring',
                            endpointKey: slotKey,
                            migrated: true,
                            warning: '',
                        };
                    }
                }
            } catch (err) {
                keyringOperational = false;
            }
        }

        // 3. Keyring unavailable or empty: only read plaintext if explicitly allowed OR migrating pre-existing legacy key into memory
        const existingPlain = decodedFallback.map[slotKey] || '';
        if (existingPlain) {
            if (allowPlaintext) {
                return {
                    apiKey: existingPlain,
                    storage: 'plaintext_opt_in',
                    endpointKey: slotKey,
                    migrated: false,
                    warning: '当前使用用户显式开启的本地兼容存储（非系统密钥环加密）',
                };
            }
            // Keep pre-existing legacy key in memory for current session without silently writing new plaintext
            this._memory.set(slotKey, existingPlain);
            return {
                apiKey: existingPlain,
                storage: 'memory',
                endpointKey: slotKey,
                migrated: false,
                warning: '系统密钥环不可用，已将旧配置密钥临时加载至本次运行内存',
            };
        }

        return {
            apiKey: '',
            storage: 'none',
            endpointKey: slotKey,
            migrated: false,
            warning: '',
        };
    }

    /**
     * Stores an API key for `baseUrl`. If `apiKey` is empty, delegates to `clearKey`.
     */
    async storeKey(settingsAdapter, baseUrl, apiKey) {
        const trimmed = String(apiKey ?? '').trim();
        if (!trimmed) {
            return this.clearKey(settingsAdapter, baseUrl);
        }

        const slotKey = this._resolveSlotKey(baseUrl, settingsAdapter);
        const allowPlaintext = Boolean(settingsAdapter?.getAllowPlaintextFallback?.());
        const rawFallbackSetting = settingsAdapter?.getLegacyPlaintext?.() || '';
        const decodedFallback = decodePlaintextMap(rawFallbackSetting, slotKey);

        if (this._keyring?.available) {
            try {
                const storedOk = await this._keyring.storeEndpoint(slotKey, trimmed);
                if (storedOk === true) {
                    this._memory.delete(slotKey);
                    // Erase any plaintext copy strictly AFTER verified Keyring store!
                    if (decodedFallback.isLegacyRawString || decodedFallback.map[slotKey]) {
                        delete decodedFallback.map[slotKey];
                        settingsAdapter?.setLegacyPlaintext?.(
                            decodedFallback.isLegacyRawString ? '' : encodePlaintextMap(decodedFallback.map)
                        );
                    }
                    return {
                        ok: true,
                        persisted: true,
                        storage: 'keyring',
                        endpointKey: slotKey,
                        warning: '',
                    };
                }
            } catch (_) {
                // Fall through to non-silent memory/opt-in handling below
            }
        }

        if (allowPlaintext) {
            this._memory.delete(slotKey);
            const nextMap = decodedFallback.isLegacyRawString ? {} : {...decodedFallback.map};
            nextMap[slotKey] = trimmed;
            settingsAdapter?.setLegacyPlaintext?.(encodePlaintextMap(nextMap));
            return {
                ok: true,
                persisted: true,
                storage: 'plaintext_opt_in',
                endpointKey: slotKey,
                warning: '系统密钥环不可用，已按您的显式授权保存在本地兼容配置中',
            };
        }

        // Default safe behavior when Keyring fails: keep ONLY in runtime memory, NEVER silently write GSettings plaintext!
        this._memory.set(slotKey, trimmed);
        return {
            ok: true,
            persisted: false,
            storage: 'memory',
            endpointKey: slotKey,
            warning: '系统密钥环当前不可用，密钥仅保存在本次运行内存中（重启后需重新输入，拒绝静默回退明文）',
        };
    }

    /**
     * Honestly clears the stored API key for `baseUrl` across Keyring, runtime memory, and opt-in fallback.
     * Never swallows Keyring deletion failures and never allows a deleted key to be resurrected on reload!
     */
    async clearKey(settingsAdapter, baseUrl = '') {
        const slotKey = this._resolveSlotKey(baseUrl, settingsAdapter);
        const configuredUrl = settingsAdapter?.getBaseUrl?.() || '';
        const configuredEndpointKey = normalizeEndpointKeyIdentity(configuredUrl) || DEFAULT_KEY_SLOT;
        const isCurrentConfiguredEndpoint = slotKey === configuredEndpointKey;

        // Always purge runtime memory and local fallback first so deleted values cannot resurrect from fallback
        this._memory.delete(slotKey);
        const rawFallbackSetting = settingsAdapter?.getLegacyPlaintext?.() || '';
        if (rawFallbackSetting) {
            const decodedFallback = decodePlaintextMap(rawFallbackSetting, isCurrentConfiguredEndpoint ? slotKey : '');
            if (decodedFallback.isLegacyRawString && isCurrentConfiguredEndpoint) {
                settingsAdapter?.setLegacyPlaintext?.('');
            } else if (decodedFallback.map[slotKey]) {
                delete decodedFallback.map[slotKey];
                settingsAdapter?.setLegacyPlaintext?.(encodePlaintextMap(decodedFallback.map));
            }
        }

        if (!this._keyring?.available) {
            return {
                ok: true,
                removedFromKeyring: false,
                alreadyAbsent: true,
                endpointKey: slotKey,
                error: '',
            };
        }

        try {
            const removedEndpoint = await this._keyring.clearEndpoint(slotKey);
            let removedLegacy = false;
            if (isCurrentConfiguredEndpoint && typeof this._keyring.clearLegacyGlobal === 'function') {
                removedLegacy = Boolean(await this._keyring.clearLegacyGlobal());
            }

            // Distinguish libsecret `false` ("no matching item existed") vs "item still stuck in keyring"!
            if (!removedEndpoint) {
                const stillThere = await this._keyring.lookupEndpoint(slotKey);
                if (stillThere) {
                    return {
                        ok: false,
                        removedFromKeyring: false,
                        alreadyAbsent: false,
                        endpointKey: slotKey,
                        error: '系统密钥环未能删除该密钥（密钥环可能已锁定或拒绝访问）',
                    };
                }
            }
            if (isCurrentConfiguredEndpoint && !removedLegacy && typeof this._keyring.lookupLegacyGlobal === 'function') {
                const legacyStillThere = await this._keyring.lookupLegacyGlobal();
                if (legacyStillThere) {
                    return {
                        ok: false,
                        removedFromKeyring: false,
                        alreadyAbsent: false,
                        endpointKey: slotKey,
                        error: '系统密钥环未能清除旧版密钥项',
                    };
                }
            }

            return {
                ok: true,
                removedFromKeyring: Boolean(removedEndpoint || removedLegacy),
                alreadyAbsent: !removedEndpoint && !removedLegacy,
                endpointKey: slotKey,
                error: '',
            };
        } catch (err) {
            return {
                ok: false,
                removedFromKeyring: false,
                alreadyAbsent: false,
                endpointKey: slotKey,
                error: `清除系统密钥环密钥失败：${err?.message || String(err)}`,
            };
        }
    }
}

/**
 * Versioned serial async queue for API Key UI editing (`prefs.js`).
 * - Prevents slow initial/endpoint `load()` responses from overwriting newer user edits.
 * - Serializes `store`/`clear` operations in strict edit order.
 * - Exposes `flush()` so window close awaits all pending writes cleanly.
 */
export class SecretWriteQueue {
    constructor() {
        this._editVersion = 0;
        this._chain = Promise.resolve({ok: true});
        this._pendingCount = 0;
    }

    get editVersion() {
        return this._editVersion;
    }

    get hasPendingWrites() {
        return this._pendingCount > 0;
    }

    bumpEditVersion() {
        return ++this._editVersion;
    }

    beginLoad(baseUrl = '') {
        return {
            version: this._editVersion,
            endpointKey: normalizeEndpointKeyIdentity(baseUrl) || DEFAULT_KEY_SLOT,
        };
    }

    shouldApplyLoad(loadToken, currentBaseUrl = '') {
        if (!loadToken) return false;
        const currentEndpointKey = normalizeEndpointKeyIdentity(currentBaseUrl) || DEFAULT_KEY_SLOT;
        return (
            loadToken.version === this._editVersion &&
            loadToken.endpointKey === currentEndpointKey
        );
    }

    enqueue(taskFn) {
        const scheduledVersion = ++this._editVersion;
        this._pendingCount++;
        const run = this._chain
            .catch(() => {})
            .then(async () => {
                try {
                    const res = await taskFn(scheduledVersion);
                    return {
                        ...(res && typeof res === 'object' ? res : {ok: true}),
                        version: scheduledVersion,
                        isLatest: scheduledVersion === this._editVersion,
                    };
                } finally {
                    this._pendingCount = Math.max(0, this._pendingCount - 1);
                }
            });
        this._chain = run;
        return run;
    }

    flush() {
        return this._chain.catch(() => ({ok: false}));
    }
}
