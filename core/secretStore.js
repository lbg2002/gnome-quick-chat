import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

let Secret = null;
try {
    Secret = (await import('gi://Secret')).default;
} catch (_) {
    Secret = null;
}

const SECRET_SCHEMA = Secret
    ? new Secret.Schema(
        'org.gnome.shell.extensions.quick-chat.apikey',
        Secret.SchemaFlags.NONE,
        {account: Secret.SchemaAttributeType.STRING}
    )
    : null;

const SECRET_ATTRS = {account: 'openai-compatible-api-key'};
const SECRET_LABEL = 'Quick Chat · 随问 OpenAI API Key';

export async function loadOpenAIApiKey(settings) {
    const legacyPlaintext = settings?.get_string?.('openai-api-key')?.trim?.() || '';

    if (Secret && SECRET_SCHEMA) {
        try {
            const stored = await new Promise((resolve, reject) => {
                Secret.password_lookup(
                    SECRET_SCHEMA,
                    SECRET_ATTRS,
                    null,
                    (_, res) => {
                        try {
                            resolve(Secret.password_lookup_finish(res) || '');
                        } catch (err) {
                            reject(err);
                        }
                    }
                );
            });
            if (stored) {
                // Migrate/clear leftover plaintext GSettings key if keyring already holds a value
                if (legacyPlaintext) {
                    try { settings.set_string('openai-api-key', ''); } catch (_) {}
                }
                return stored;
            }
            if (legacyPlaintext) {
                const migrated = await storeOpenAIApiKey(settings, legacyPlaintext);
                if (migrated) return legacyPlaintext;
            }
        } catch (err) {
            console.warn(`[Quick Chat] Keyring lookup unavailable, falling back: ${err.message}`);
        }
    }

    return legacyPlaintext;
}

export async function storeOpenAIApiKey(settings, apiKey) {
    const trimmed = String(apiKey || '').trim();
    if (Secret && SECRET_SCHEMA) {
        try {
            if (!trimmed) {
                await new Promise(resolve => {
                    Secret.password_clear(SECRET_SCHEMA, SECRET_ATTRS, null, (_, res) => {
                        try { Secret.password_clear_finish(res); } catch (_) {}
                        resolve();
                    });
                });
            } else {
                await new Promise((resolve, reject) => {
                    Secret.password_store(
                        SECRET_SCHEMA,
                        SECRET_ATTRS,
                        Secret.COLLECTION_DEFAULT,
                        SECRET_LABEL,
                        trimmed,
                        null,
                        (_, res) => {
                            try {
                                Secret.password_store_finish(res);
                                resolve();
                            } catch (err) {
                                reject(err);
                            }
                        }
                    );
                });
            }
            // Clear plaintext GSettings once stored safely in GNOME Keyring
            if (settings && settings.get_string('openai-api-key') !== '') {
                settings.set_string('openai-api-key', '');
            }
            return true;
        } catch (err) {
            console.warn(`[Quick Chat] Keyring store failed, keeping fallback setting: ${err.message}`);
        }
    }

    if (settings && settings.get_string('openai-api-key') !== trimmed) {
        settings.set_string('openai-api-key', trimmed);
    }
    return false;
}
