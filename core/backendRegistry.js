// Pure-JS BackendRegistry managing isolated per-backend configurations (ZCode / Codex / OpenAI),
// atomic GSettings batch transactions, and configuration generation tracking (Stage E).
// Zero GNOME/GJS imports so Node.js unit tests validate real production logic directly.

import {makeModelEntryKey, recordRecentModelKey} from './modelCatalogCache.js';
import {normalizeDshProviderId} from './dshModelCatalog.js';

export const REGISTERED_BACKENDS = Object.freeze(['zcode', 'codex', 'dsh', 'openai']);

const VALID_MODES = new Set(['chat', 'readonly', 'smart', 'full']);
const VALID_EFFORTS = new Set(['default', 'fast', 'standard', 'deep']);

function hasSchemaKey(settings, key) {
    if (!settings) return false;
    if (typeof settings.hasKey === 'function') return Boolean(settings.hasKey(key));
    if (settings.settings_schema && typeof settings.settings_schema.has_key === 'function') {
        return Boolean(settings.settings_schema.has_key(key));
    }
    return true;
}

function readString(settings, key, fallback = '') {
    if (!settings || !hasSchemaKey(settings, key)) return fallback;
    if (typeof settings.get_string === 'function') {
        return String(settings.get_string(key) ?? fallback);
    }
    return fallback;
}

function writeString(settings, key, value) {
    if (!settings || !hasSchemaKey(settings, key)) return false;
    const next = String(value ?? '');
    if (typeof settings.get_string === 'function' && settings.get_string(key) === next) {
        return false;
    }
    if (typeof settings.set_string === 'function') {
        settings.set_string(key, next);
        return true;
    }
    return false;
}

function readBoolean(settings, key, fallback = false) {
    return settings && hasSchemaKey(settings, key) && typeof settings.get_boolean === 'function'
        ? Boolean(settings.get_boolean(key)) : fallback;
}

function readStrv(settings, key) {
    if (!settings || !hasSchemaKey(settings, key)) return [];
    if (typeof settings.get_strv === 'function') {
        const arr = settings.get_strv(key);
        return Array.isArray(arr) ? arr.map(String) : [];
    }
    return [];
}

function writeStrv(settings, key, values) {
    if (!settings || !hasSchemaKey(settings, key)) return false;
    const next = Array.isArray(values) ? values.map(String) : [];
    if (typeof settings.get_strv === 'function') {
        const cur = settings.get_strv(key) || [];
        if (cur.length === next.length && cur.every((v, i) => v === next[i])) {
            return false;
        }
    }
    if (typeof settings.set_strv === 'function') {
        settings.set_strv(key, next);
        return true;
    }
    return false;
}

/**
 * Executes multiple GSettings writes inside a single delayed transaction (`delay()` -> `apply()`)
 * when supported by Gio.Settings, preventing redundant intermediate `changed::` signal storms.
 */
export function runSettingsTransaction(settings, fn) {
    if (!settings || typeof fn !== 'function') return undefined;
    const canDelay =
        typeof settings.delay === 'function' &&
        typeof settings.apply === 'function';
    let delayedHere = false;
    try {
        if (canDelay && !settings.get_has_unapplied?.()) {
            settings.delay();
            delayedHere = true;
        }
        return fn();
    } finally {
        if (delayedHere) {
            try {
                settings.apply();
            } catch (_) {}
        }
    }
}

/**
 * In-memory mock GSettings implementation for pure-JS tests with full `delay()`/`apply()` support.
 */
export class MemorySettingsStore {
    constructor(initial = {}) {
        this._values = new Map(Object.entries(initial));
        this._staged = null;
        this._listeners = new Map();
        this.applyCount = 0;
        this.signalEvents = [];
    }

    hasKey(key) {
        return true;
    }

    get_has_unapplied() {
        return this._staged !== null && this._staged.size > 0;
    }

    delay() {
        if (!this._staged) {
            this._staged = new Map();
        }
    }

    apply() {
        if (!this._staged) return;
        const pending = Array.from(this._staged.entries());
        this._staged = null;
        this.applyCount++;
        const changedKeys = [];
        for (const [k, v] of pending) {
            const prev = this._values.get(k);
            const same = Array.isArray(prev) && Array.isArray(v)
                ? prev.length === v.length && prev.every((x, i) => x === v[i])
                : prev === v;
            if (!same) {
                this._values.set(k, v);
                changedKeys.push(k);
            }
        }
        for (const k of changedKeys) {
            this.signalEvents.push(k);
            for (const cb of this._listeners.get(k) || []) cb(this, k);
            for (const cb of this._listeners.get('*') || []) cb(this, k);
        }
    }

    get_string(key) {
        if (this._staged?.has(key)) return String(this._staged.get(key) ?? '');
        return String(this._values.get(key) ?? '');
    }

    set_string(key, val) {
        const next = String(val ?? '');
        if (this._staged) {
            this._staged.set(key, next);
            return;
        }
        if (this.get_string(key) === next) return;
        this._values.set(key, next);
        this.signalEvents.push(key);
        for (const cb of this._listeners.get(key) || []) cb(this, key);
        for (const cb of this._listeners.get('*') || []) cb(this, key);
    }

    get_boolean(key) {
        if (this._staged?.has(key)) return Boolean(this._staged.get(key));
        return Boolean(this._values.get(key));
    }

    set_boolean(key, val) {
        const next = Boolean(val);
        if (this._staged) {
            this._staged.set(key, next);
            return;
        }
        if (this.get_boolean(key) === next) return;
        this._values.set(key, next);
        this.signalEvents.push(key);
        for (const cb of this._listeners.get(key) || []) cb(this, key);
    }

    get_strv(key) {
        const src = this._staged?.has(key) ? this._staged.get(key) : this._values.get(key);
        return Array.isArray(src) ? [...src] : [];
    }

    set_strv(key, arr) {
        const next = Array.isArray(arr) ? arr.map(String) : [];
        if (this._staged) {
            this._staged.set(key, next);
            return;
        }
        this._values.set(key, next);
        this.signalEvents.push(key);
        for (const cb of this._listeners.get(key) || []) cb(this, key);
        for (const cb of this._listeners.get('*') || []) cb(this, key);
    }

    connect(signalSpec, cb) {
        const key = signalSpec.startsWith('changed::')
            ? signalSpec.slice('changed::'.length)
            : '*';
        if (!this._listeners.has(key)) this._listeners.set(key, new Set());
        this._listeners.get(key).add(cb);
        return {key, cb};
    }

    disconnect(handle) {
        if (handle && this._listeners.has(handle.key)) {
            this._listeners.get(handle.key).delete(handle.cb);
        }
    }
}

/**
 * Manages independent configuration profiles for `zcode`, `codex`, and `openai` so switching
 * backends restores that backend's last selected provider/model/effort/workspace/mode without
 * polluting any other backend's profile.
 */
export class BackendRegistry {
    constructor(settings, {adapters = {}} = {}) {
        this._settings = settings;
        this._adapters = {...adapters};
        this._generation = 0;
    }

    get generation() {
        return this._generation;
    }

    bumpGeneration() {
        this._generation += 1;
        return this._generation;
    }

    registerAdapter(backendId, adapterFactory) {
        this._adapters[backendId] = adapterFactory;
    }

    createAdapter(backendId, options = {}) {
        const factory = this._adapters[backendId];
        if (!factory) return null;
        return typeof factory === 'function' ? factory(options) : factory;
    }

    getConfiguredBackend() {
        return readString(this._settings, 'backend', 'auto').trim() || 'auto';
    }

    /**
     * Reads the isolated profile for `backend` (`zcode`, `codex`, or `openai`).
     * Legacy shared keys (`provider`, `model`, `reasoning-effort`, `workspace`, `agent-mode`)
     * are used ONLY as read-only fallbacks when a backend's own key has not yet been set.
     */
    getBackendProfile(backend) {
        const clean = String(backend || '').trim();
        const sharedEffort = readString(this._settings, 'reasoning-effort', 'default').trim() || 'default';
        const sharedWorkspace = readString(this._settings, 'workspace', '').trim();
        const sharedModeRaw = readString(this._settings, 'agent-mode', 'readonly').trim() || 'readonly';
        const sharedMode = VALID_MODES.has(sharedModeRaw) ? sharedModeRaw : 'readonly';

        if (clean === 'zcode') {
            const effortRaw = readString(this._settings, 'zcode-reasoning-effort', 'default').trim();
            const modeRaw = readString(this._settings, 'zcode-agent-mode', '').trim();
            const hasDedicatedSelection = Boolean(
                readString(this._settings, 'zcode-provider', '').trim() ||
                readString(this._settings, 'zcode-model', '').trim()
            );
            return {
                backend: 'zcode',
                executablePath: readString(this._settings, 'zcode-path', '').trim(),
                provider: readString(this._settings, 'zcode-provider', '').trim() ||
                    (!hasDedicatedSelection && this.getConfiguredBackend() === 'zcode'
                        ? readString(this._settings, 'provider', '').trim()
                        : ''),
                model: readString(this._settings, 'zcode-model', '').trim() ||
                    (!hasDedicatedSelection && this.getConfiguredBackend() === 'zcode'
                        ? readString(this._settings, 'model', '').trim()
                        : ''),
                reasoningEffort: effortRaw && effortRaw !== 'default' && VALID_EFFORTS.has(effortRaw)
                    ? effortRaw
                    : sharedEffort,
                workspace: readString(this._settings, 'zcode-workspace', '').trim() || sharedWorkspace,
                mode: VALID_MODES.has(modeRaw) ? modeRaw : sharedMode,
            };
        }

        if (clean === 'codex') {
            const effortRaw = readString(this._settings, 'codex-reasoning-effort', 'default').trim();
            const modeRaw = readString(this._settings, 'codex-agent-mode', '').trim();
            const hasDedicatedSelection = Boolean(
                readString(this._settings, 'codex-provider', '').trim() ||
                readString(this._settings, 'codex-model', '').trim()
            );
            const rawMode = VALID_MODES.has(modeRaw) ? modeRaw : sharedMode;
            return {
                backend: 'codex',
                executablePath: readString(this._settings, 'codex-path', '').trim(),
                provider: readString(this._settings, 'codex-provider', '').trim() ||
                    (!hasDedicatedSelection && this.getConfiguredBackend() === 'codex'
                        ? readString(this._settings, 'provider', '').trim()
                        : ''),
                model: readString(this._settings, 'codex-model', '').trim() ||
                    (!hasDedicatedSelection && this.getConfiguredBackend() === 'codex'
                        ? readString(this._settings, 'model', '').trim()
                        : ''),
                reasoningEffort: effortRaw && effortRaw !== 'default' && VALID_EFFORTS.has(effortRaw)
                    ? effortRaw
                    : sharedEffort,
                workspace: readString(this._settings, 'codex-workspace', '').trim() || sharedWorkspace,
                mode: rawMode === 'chat' ? 'readonly' : rawMode,
            };
        }

        if (clean === 'dsh') {
            const modeRaw = readString(this._settings, 'dsh-agent-mode', '').trim();
            return {
                backend: 'dsh',
                executablePath: readString(this._settings, 'dsh-path', '').trim(),
                provider: normalizeDshProviderId(readString(this._settings, 'dsh-provider', '')),
                model: readString(this._settings, 'dsh-model', '').trim(),
                reasoningEffort: 'default',
                autoReview: readBoolean(this._settings, 'dsh-auto-review', false),
                workspace: readString(this._settings, 'dsh-workspace', '').trim() || sharedWorkspace,
                mode: VALID_MODES.has(modeRaw) ? modeRaw : 'readonly',
            };
        }

        if (clean === 'openai') {
            const effortRaw = readString(this._settings, 'openai-reasoning-effort', 'default').trim();
            return {
                backend: 'openai',
                executablePath: '',
                baseUrl: readString(this._settings, 'openai-base-url', '').trim(),
                provider: 'openai',
                model: readString(this._settings, 'openai-model', '').trim() ||
                    (this.getConfiguredBackend() === 'openai'
                        ? readString(this._settings, 'model', '').trim()
                        : ''),
                reasoningEffort: effortRaw && effortRaw !== 'default' && VALID_EFFORTS.has(effortRaw)
                    ? effortRaw
                    : sharedEffort,
                systemPrompt: readString(this._settings, 'system-prompt', '').trim(),
            assistantInstructions: readString(this._settings, 'desktop-assistant-prompt', '').trim(),
            dshAutoReview: readBoolean(this._settings, 'dsh-auto-review', false),
                workspace: sharedWorkspace,
                mode: 'chat',
            };
        }

        return {
            backend: 'unconfigured',
            executablePath: '',
            provider: '',
            model: '',
            reasoningEffort: sharedEffort,
            workspace: sharedWorkspace,
            mode: 'chat',
        };
    }

    /**
     * Atomically updates a backend's isolated profile WITHOUT writing to shared `provider`/`model`
     * keys that could contaminate another backend's profile upon switching.
     */
    updateBackendProfile(backend, patch = {}, {recordRecent = false} = {}) {
        const clean = String(backend || '').trim();
        if (!REGISTERED_BACKENDS.includes(clean)) return this.generation;

        runSettingsTransaction(this._settings, () => {
            if (clean === 'zcode') {
                if ('executablePath' in patch) writeString(this._settings, 'zcode-path', patch.executablePath);
                if ('provider' in patch) writeString(this._settings, 'zcode-provider', patch.provider);
                if ('model' in patch) writeString(this._settings, 'zcode-model', patch.model);
                if ('reasoningEffort' in patch && VALID_EFFORTS.has(patch.reasoningEffort)) {
                    writeString(this._settings, 'zcode-reasoning-effort', patch.reasoningEffort);
                }
                if ('workspace' in patch) writeString(this._settings, 'zcode-workspace', patch.workspace);
                if ('mode' in patch && VALID_MODES.has(patch.mode)) {
                    writeString(this._settings, 'zcode-agent-mode', patch.mode);
                    writeString(this._settings, 'agent-mode', patch.mode);
                }
            } else if (clean === 'codex') {
                if ('executablePath' in patch) writeString(this._settings, 'codex-path', patch.executablePath);
                if ('provider' in patch) writeString(this._settings, 'codex-provider', patch.provider);
                if ('model' in patch) writeString(this._settings, 'codex-model', patch.model);
                if ('reasoningEffort' in patch && VALID_EFFORTS.has(patch.reasoningEffort)) {
                    writeString(this._settings, 'codex-reasoning-effort', patch.reasoningEffort);
                }
                if ('workspace' in patch) writeString(this._settings, 'codex-workspace', patch.workspace);
                if ('mode' in patch && VALID_MODES.has(patch.mode)) {
                    const safeMode = patch.mode === 'chat' ? 'readonly' : patch.mode;
                    writeString(this._settings, 'codex-agent-mode', safeMode);
                    writeString(this._settings, 'agent-mode', safeMode);
                }
            } else if (clean === 'dsh') {
                if ('executablePath' in patch) writeString(this._settings, 'dsh-path', patch.executablePath);
                if ('provider' in patch) writeString(this._settings, 'dsh-provider', normalizeDshProviderId(patch.provider));
                if ('model' in patch) writeString(this._settings, 'dsh-model', patch.model);
                if ('workspace' in patch) writeString(this._settings, 'dsh-workspace', patch.workspace);
                if ('mode' in patch && VALID_MODES.has(patch.mode)) {
                    const safeMode = patch.mode === 'chat' ? 'readonly' : patch.mode;
                    writeString(this._settings, 'dsh-agent-mode', safeMode);
                    writeString(this._settings, 'agent-mode', safeMode);
                }
            } else if (clean === 'openai') {
                if ('baseUrl' in patch) writeString(this._settings, 'openai-base-url', patch.baseUrl);
                if ('model' in patch) writeString(this._settings, 'openai-model', patch.model);
                if ('reasoningEffort' in patch && VALID_EFFORTS.has(patch.reasoningEffort)) {
                    writeString(this._settings, 'openai-reasoning-effort', patch.reasoningEffort);
                }
                if ('systemPrompt' in patch) writeString(this._settings, 'system-prompt', patch.systemPrompt);
            }

            if (recordRecent && patch.model) {
                const prov = String(patch.provider ?? this.getBackendProfile(clean).provider ?? '').trim();
                const curRecents = readStrv(this._settings, 'recent-models');
                const nextRecents = recordRecentModelKey(
                    curRecents,
                    makeModelEntryKey(clean, prov, patch.model)
                );
                writeStrv(this._settings, 'recent-models', nextRecents);
            }
        });

        return this.bumpGeneration();
    }

    selectBackend(nextBackend, {clearMigrationNotice = true} = {}) {
        const target = ['auto', 'zcode', 'codex', 'dsh', 'openai'].includes(nextBackend)
            ? nextBackend
            : 'auto';
        runSettingsTransaction(this._settings, () => {
            writeString(this._settings, 'backend', target);
            if (clearMigrationNotice) {
                writeString(this._settings, 'migration-notice', '');
            }
        });
        return this.bumpGeneration();
    }

    buildRuntimeConfig(effectiveBackend, {apiKey = ''} = {}) {
        const profile = this.getBackendProfile(effectiveBackend);
        const configuredBackend = this.getConfiguredBackend();
        return {
            backend: configuredBackend,
            effectiveBackend,
            zcodePath: readString(this._settings, 'zcode-path', '').trim(),
            codexPath: readString(this._settings, 'codex-path', '').trim(),
            dshPath: readString(this._settings, 'dsh-path', '').trim(),
            provider: profile.provider || '',
            model: profile.model || '',
            openaiBaseUrl: readString(this._settings, 'openai-base-url', '').trim(),
            openaiApiKey: String(apiKey || '').trim(),
            openaiModel: readString(this._settings, 'openai-model', '').trim() ||
                (effectiveBackend === 'openai' ? profile.model : ''),
            systemPrompt: readString(this._settings, 'system-prompt', '').trim(),
            reasoningEffort: profile.reasoningEffort || 'default',
            assistantInstructions: readString(this._settings, 'desktop-assistant-prompt', '').trim(),
            dshAutoReview: effectiveBackend === 'dsh'
                ? readBoolean(this._settings, 'dsh-auto-review', false) : false,
            mode: profile.mode || 'readonly',
            workspace: profile.workspace || '',
            configGeneration: this._generation,
        };
    }
}
