import {
    SecretKeyManager,
    SecretWriteQueue,
    inspectEndpointSecurity,
    normalizeEndpointKeyIdentity,
    shouldStripAuthOnRedirect,
} from './secretPolicy.js';

export {
    SecretKeyManager,
    SecretWriteQueue,
    inspectEndpointSecurity,
    normalizeEndpointKeyIdentity,
    shouldStripAuthOnRedirect,
};

let Secret = null;
try {
    Secret = (await import('gi://Secret')).default;
} catch (_) {
    Secret = null;
}

// Legacy v1 schema (single global account attribute) kept strictly for one-time migration/clear
const SECRET_SCHEMA_V1 = Secret
    ? new Secret.Schema(
        'org.gnome.shell.extensions.quick-chat.apikey',
        Secret.SchemaFlags.NONE,
        {account: Secret.SchemaAttributeType.STRING}
    )
    : null;

// Per-endpoint v2 schema isolating credentials by normalized endpoint URL
const SECRET_SCHEMA_V2 = Secret
    ? new Secret.Schema(
        'org.gnome.shell.extensions.quick-chat.endpoint-apikey',
        Secret.SchemaFlags.NONE,
        {
            account: Secret.SchemaAttributeType.STRING,
            endpoint: Secret.SchemaAttributeType.STRING,
        }
    )
    : null;

const LEGACY_ATTRS = Object.freeze({account: 'openai-compatible-api-key'});
const ENDPOINT_ACCOUNT = 'openai-endpoint-api-key';

function makeEndpointAttrs(endpointSlot) {
    return {
        account: ENDPOINT_ACCOUNT,
        endpoint: String(endpointSlot || ''),
    };
}

function createLibsecretAdapter() {
    if (!Secret || !SECRET_SCHEMA_V2) {
        return {available: false};
    }

    return {
        available: true,

        lookupEndpoint(endpointSlot) {
            return new Promise((resolve, reject) => {
                Secret.password_lookup(
                    SECRET_SCHEMA_V2,
                    makeEndpointAttrs(endpointSlot),
                    null,
                    (_, res) => {
                        try {
                            const val = Secret.password_lookup_finish(res);
                            resolve(typeof val === 'string' ? val : '');
                        } catch (err) {
                            reject(err);
                        }
                    }
                );
            });
        },

        storeEndpoint(endpointSlot, secretValue) {
            const label = `Quick Chat · 随问 API Key (${endpointSlot})`;
            return new Promise((resolve, reject) => {
                Secret.password_store(
                    SECRET_SCHEMA_V2,
                    makeEndpointAttrs(endpointSlot),
                    Secret.COLLECTION_DEFAULT,
                    label,
                    secretValue,
                    null,
                    (_, res) => {
                        try {
                            const ok = Secret.password_store_finish(res);
                            resolve(Boolean(ok));
                        } catch (err) {
                            reject(err);
                        }
                    }
                );
            });
        },

        clearEndpoint(endpointSlot) {
            return new Promise((resolve, reject) => {
                Secret.password_clear(
                    SECRET_SCHEMA_V2,
                    makeEndpointAttrs(endpointSlot),
                    null,
                    (_, res) => {
                        try {
                            // Note: libsecret returns `true` if >=1 item was deleted, `false` if none matched,
                            // and throws GLib.Error if D-Bus / unlocked-keyring deletion failed!
                            const removed = Secret.password_clear_finish(res);
                            resolve(Boolean(removed));
                        } catch (err) {
                            reject(err);
                        }
                    }
                );
            });
        },

        lookupLegacyGlobal() {
            if (!SECRET_SCHEMA_V1) return Promise.resolve('');
            return new Promise((resolve, reject) => {
                Secret.password_lookup(
                    SECRET_SCHEMA_V1,
                    LEGACY_ATTRS,
                    null,
                    (_, res) => {
                        try {
                            const val = Secret.password_lookup_finish(res);
                            resolve(typeof val === 'string' ? val : '');
                        } catch (err) {
                            reject(err);
                        }
                    }
                );
            });
        },

        clearLegacyGlobal() {
            if (!SECRET_SCHEMA_V1) return Promise.resolve(false);
            return new Promise((resolve, reject) => {
                Secret.password_clear(
                    SECRET_SCHEMA_V1,
                    LEGACY_ATTRS,
                    null,
                    (_, res) => {
                        try {
                            const removed = Secret.password_clear_finish(res);
                            resolve(Boolean(removed));
                        } catch (err) {
                            reject(err);
                        }
                    }
                );
            });
        },
    };
}

function wrapSettingsAdapter(settings) {
    const hasKey = key => Boolean(settings?.settings_schema?.has_key?.(key));
    return {
        getBaseUrl() {
            try {
                return hasKey('openai-base-url') ? (settings.get_string('openai-base-url') || '').trim() : '';
            } catch (_) {
                return '';
            }
        },
        getLegacyPlaintext() {
            try {
                return hasKey('openai-api-key') ? (settings.get_string('openai-api-key') || '').trim() : '';
            } catch (_) {
                return '';
            }
        },
        setLegacyPlaintext(nextVal) {
            if (!hasKey('openai-api-key')) return;
            const clean = String(nextVal ?? '');
            if (settings.get_string('openai-api-key') !== clean) {
                settings.set_string('openai-api-key', clean);
            }
        },
        getAllowPlaintextFallback() {
            try {
                return hasKey('allow-plaintext-key-fallback')
                    ? Boolean(settings.get_boolean('allow-plaintext-key-fallback'))
                    : false;
            } catch (_) {
                return false;
            }
        },
    };
}

const sharedRuntimeMemorySecrets = new Map();
const defaultSecretManager = new SecretKeyManager({
    keyring: createLibsecretAdapter(),
    memoryStore: sharedRuntimeMemorySecrets,
});

export async function loadOpenAIApiKeyDetailed(settings, baseUrl = '') {
    return defaultSecretManager.loadKey(wrapSettingsAdapter(settings), baseUrl);
}

export async function loadOpenAIApiKey(settings, baseUrl = '') {
    const res = await loadOpenAIApiKeyDetailed(settings, baseUrl);
    return res.apiKey || '';
}

export async function storeOpenAIApiKey(settings, apiKey, baseUrl = '') {
    return defaultSecretManager.storeKey(wrapSettingsAdapter(settings), baseUrl, apiKey);
}

export async function clearOpenAIApiKey(settings, baseUrl = '') {
    return defaultSecretManager.clearKey(wrapSettingsAdapter(settings), baseUrl);
}

/**
 * Purges strictly extension-owned secrets (`account=openai-endpoint-api-key` and legacy `account=openai-compatible-api-key`).
 * Never uses broad attribute queries that could touch other applications' credentials.
 */
export async function clearAllExtensionSecrets(settings = null) {
    sharedRuntimeMemorySecrets.clear();
    if (settings) {
        try {
            wrapSettingsAdapter(settings).setLegacyPlaintext('');
        } catch (_) {}
    }
    if (!Secret) {
        return {ok: true, error: ''};
    }
    try {
        if (SECRET_SCHEMA_V2) {
            await new Promise((resolve, reject) => {
                Secret.password_clear(
                    SECRET_SCHEMA_V2,
                    {account: ENDPOINT_ACCOUNT},
                    null,
                    (_, res) => {
                        try {
                            Secret.password_clear_finish(res);
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                    }
                );
            });
        }
        if (SECRET_SCHEMA_V1) {
            await new Promise((resolve, reject) => {
                Secret.password_clear(
                    SECRET_SCHEMA_V1,
                    LEGACY_ATTRS,
                    null,
                    (_, res) => {
                        try {
                            Secret.password_clear_finish(res);
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                    }
                );
            });
        }
        return {ok: true, error: ''};
    } catch (err) {
        return {ok: false, error: err?.message || String(err)};
    }
}
