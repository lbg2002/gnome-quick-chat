// Pure configuration migration, CLI identity verification, backend resolution,
// and read-only legacy Pi session parser (zero GJS dependencies so Node unit tests verify production logic directly).

import {messageText, messageThinking} from '../protocol.js';

export const SUPPORTED_BACKENDS = Object.freeze(['auto', 'zcode', 'codex', 'dsh', 'openai']);
export const CURRENT_CONFIG_VERSION = 1;

export const PI_MIGRATION_NOTICE =
    '旧版 Pi 后端已移除，已安全迁移为「自动检测」；请确认或重新选择 ZCode、Codex 或 OpenAI 兼容 API。';

export const UNCONFIGURED_BACKEND_MESSAGE =
    '未检测到可用后端：请安装 ZCode CLI / Codex CLI / DeepSeek Harness (dsh)，或在设置（⚙）中配置自定义 OpenAI 兼容 API。';

function pathBasename(p) {
    const clean = String(p || '').trim().replace(/\/+$/, '');
    if (!clean) return '';
    const idx = clean.lastIndexOf('/');
    return idx >= 0 ? clean.slice(idx + 1) : clean;
}

/**
 * Verifies the actual identity of a CLI candidate path so a legacy `pi` path
 * or arbitrary unrelated binary is NEVER misclassified as ZCode or Codex.
 *
 * @param {string} candidatePath
 * @param {object} env
 * @returns {'zcode' | 'codex' | 'pi' | 'unknown'}
 */
export function identifyCliCandidate(candidatePath, env = {}) {
    const raw = String(candidatePath || '').trim();
    if (!raw) return 'unknown';
    if (raw === 'pi') return 'pi';

    const fileExists = env.fileExists || (() => false);
    const isDir = env.isDir || (() => false);
    const isExecutable = env.isExecutable || (() => false);
    const readLink = env.readLink || (() => '');
    const readFileHead = env.readFileHead || (() => '');
    const probeVersion = env.probeVersion || (() => '');
    const hasZCodeNodeRuntime = env.hasZCodeNodeRuntime || (() => true);

    const resolvedPath = env.resolveCandidate ? (env.resolveCandidate(raw) || '') : raw;
    if (!resolvedPath || !fileExists(resolvedPath) || isDir(resolvedPath)) {
        return 'unknown';
    }

    const base = pathBasename(resolvedPath).toLowerCase();
    const linkTarget = String(readLink(resolvedPath) || '').trim();
    const linkBase = pathBasename(linkTarget).toLowerCase();
    const combinedPathLower = `${resolvedPath} ${linkTarget}`.toLowerCase();

    // Explicitly recognize Pi so it is never migrated into zcode-path or codex-path
    if (
        base === 'pi' ||
        linkBase === 'pi' ||
        combinedPathLower.includes('pi-coding-agent') ||
        combinedPathLower.includes('/.pi/')
    ) {
        return 'pi';
    }

    // ZCode CJS bundle script
    if (resolvedPath.endsWith('.cjs')) {
        if (!hasZCodeNodeRuntime()) return 'unknown';
        if (base === 'zcode.cjs' || combinedPathLower.includes('/zcode/')) {
            return 'zcode';
        }
        const head = String(readFileHead(resolvedPath, 2048) || '');
        if (/zcode/i.test(head)) {
            return 'zcode';
        }
        return 'unknown';
    }

    if (!isExecutable(resolvedPath)) {
        return 'unknown';
    }

    const head = String(readFileHead(resolvedPath, 2048) || '');
    if (/@mariozechner\/pi|pi-coding-agent/i.test(head)) {
        return 'pi';
    }

    if (
        resolvedPath === '/opt/ZCode/zcode' ||
        base === 'zcode' ||
        linkBase === 'zcode' ||
        linkBase === 'zcode.cjs' ||
        /\bzcode\b/i.test(head)
    ) {
        if (head && !/\bzcode\b/i.test(head) && base !== 'zcode' && resolvedPath !== '/opt/ZCode/zcode') {
            return 'unknown';
        }
        const ver = String(probeVersion(resolvedPath) || '');
        if (ver && /\bpi\b/i.test(ver) && !/\bzcode\b/i.test(ver)) {
            return 'pi';
        }
        return 'zcode';
    }

    if (
        base === 'codex' ||
        linkBase === 'codex' ||
        /@openai\/codex|codex-cli/i.test(head)
    ) {
        const ver = String(probeVersion(resolvedPath) || '');
        if (ver && /\bpi\b/i.test(ver) && !/\bcodex\b/i.test(ver)) {
            return 'pi';
        }
        return 'codex';
    }

    // Custom wrapper name: require explicit version/identity confirmation
    const versionOut = String(probeVersion(resolvedPath) || '').trim();
    if (versionOut) {
        if (/pi-coding-agent|\bpi\s+\d/i.test(versionOut)) return 'pi';
        if (/\bzcode\b/i.test(versionOut)) return 'zcode';
        if (/\bcodex(?:-cli)?\b/i.test(versionOut)) return 'codex';
    }

    return 'unknown';
}

/**
 * Check the documented dsh headless command surface, not just the CLI file
 * name. This also admits user-configured wrappers with arbitrary filenames,
 * but only when the helper actually advertises the expected JSONL protocol
 * and safety mode flags. Use only after an asynchronous, bounded --help probe.
 */
export function matchesDshHeadlessHelp(helpText) {
    const help = String(helpText || '');
    return /Usage:\s*dsh\s+(?:--profile\s+headless|headless)\b/i.test(help) &&
        /--json\b/.test(help) &&
        /--session-id\b/.test(help) &&
        /--permission-mode\b/.test(help) &&
        /--approval-policy\b/.test(help);
}

/**
 * Resolves effective backend without ever silently switching an explicitly selected backend
 * and without returning a phantom ZCode when no backend is configured.
 *
 * Auto order: ZCode -> Codex -> DSH -> configured OpenAI -> 'unconfigured'.
 */
export function resolveBackendSelection(
    {
        configuredBackend = 'auto',
        zcodePath = '',
        codexPath = '',
        dshPath = '',
        openaiBaseUrl = '',
    } = {},
    env = {}
) {
    const rawBackend = String(configuredBackend || 'auto').trim() || 'auto';
    const normalizedConfigured = SUPPORTED_BACKENDS.includes(rawBackend) ? rawBackend : 'auto';
    const hasZCode = Boolean(env.hasZCode?.(String(zcodePath || '').trim()));
    const hasCodex = Boolean(env.hasCodex?.(String(codexPath || '').trim()));
    const hasDsh = Boolean(env.hasDsh?.(String(dshPath || '').trim()));
    const hasOpenAI = Boolean(String(openaiBaseUrl || '').trim());

    if (normalizedConfigured === 'zcode') {
        return {
            configuredBackend: 'zcode',
            effectiveBackend: 'zcode',
            available: hasZCode,
            reason: hasZCode
                ? ''
                : (String(zcodePath || '').trim()
                    ? `指定的 ZCode CLI 路径无效或不可执行：${String(zcodePath).trim()}`
                    : '未检测到本机 ZCode CLI，请安装 ZCode 或在设置中检查路径/切换后端'),
        };
    }

    if (normalizedConfigured === 'codex') {
        return {
            configuredBackend: 'codex',
            effectiveBackend: 'codex',
            available: hasCodex,
            reason: hasCodex
                ? ''
                : (String(codexPath || '').trim()
                    ? `指定的 Codex CLI 路径无效或不可执行：${String(codexPath).trim()}`
                    : '未检测到本机 Codex CLI，请安装 Codex 或在设置中检查路径/切换后端'),
        };
    }

    if (normalizedConfigured === 'dsh') {
        return {
            configuredBackend: 'dsh', effectiveBackend: 'dsh', available: hasDsh,
            reason: hasDsh ? '' : '未检测到 DeepSeek Harness CLI (dsh)，请安装 dsh 或设置自定义路径',
        };
    }
    if (normalizedConfigured === 'openai') {
        return {
            configuredBackend: 'openai',
            effectiveBackend: 'openai',
            available: hasOpenAI,
            reason: hasOpenAI
                ? ''
                : '已选择「自定义 OpenAI 兼容 API」，请先在随问设置（⚙）中填写 API 地址 (Base URL)',
        };
    }

    // Auto detection: ZCode -> Codex -> DSH -> configured OpenAI -> unconfigured
    if (hasZCode) {
        return {configuredBackend: 'auto', effectiveBackend: 'zcode', available: true, reason: ''};
    }
    if (hasCodex) {
        return {configuredBackend: 'auto', effectiveBackend: 'codex', available: true, reason: ''};
    }
    if (hasDsh) {
        return {configuredBackend: 'auto', effectiveBackend: 'dsh', available: true, reason: ''};
    }
    if (hasOpenAI) {
        return {configuredBackend: 'auto', effectiveBackend: 'openai', available: true, reason: ''};
    }

    return {
        configuredBackend: 'auto',
        effectiveBackend: 'unconfigured',
        available: false,
        reason: UNCONFIGURED_BACKEND_MESSAGE,
    };
}

/**
 * Idempotent one-time configuration migration from legacy v0.1/v0.2 schemas.
 * - Migrates `backend = 'pi'` -> `'auto'` with an explicit user-facing notice.
 * - Migrates `pi-path` -> `zcode-path` or `codex-path` ONLY when CLI identity is verified.
 * - Preserves shared `provider`/`model` without wiping them, while seeding per-backend keys for verified old backends.
 * - Never touches `pi-idle-minutes` and stops reading `pi-path` once `config-version >= 1`.
 */
export function migrateLegacyConfig(store, env = {}) {
    if (!store) {
        return {migrated: false, migratedFromPi: false, migratedCliIdentity: 'none'};
    }

    const getStr = (k, fb = '') => (store.hasKey(k) ? String(store.getString(k) ?? fb) : fb);
    const setStr = (k, v) => {
        if (store.hasKey(k) && store.getString(k) !== v) {
            store.setString(k, v);
        }
    };
    const getInt = (k, fb = 0) => (store.hasKey(k) ? Number(store.getInt(k) ?? fb) : fb);
    const setInt = (k, v) => {
        if (store.hasKey(k) && store.getInt(k) !== v) {
            store.setInt(k, v);
        }
    };

    const currentVersion = getInt('config-version', 0);
    const rawBackend = getStr('backend', 'auto').trim() || 'auto';

    // Even after v1 migration, guard against manual dconf `backend = 'pi'` or unknown backend values
    if (currentVersion >= CURRENT_CONFIG_VERSION) {
        if (rawBackend === 'pi') {
            setStr('backend', 'auto');
            setStr('migration-notice', PI_MIGRATION_NOTICE);
            return {migrated: true, migratedFromPi: true, migratedCliIdentity: 'none'};
        }
        if (!SUPPORTED_BACKENDS.includes(rawBackend)) {
            setStr('backend', 'auto');
            return {migrated: true, migratedFromPi: false, migratedCliIdentity: 'none'};
        }
        return {migrated: false, migratedFromPi: false, migratedCliIdentity: 'none'};
    }

    let migratedCliIdentity = 'none';
    const legacyPiPath = getStr('pi-path', '').trim();
    if (legacyPiPath && legacyPiPath !== 'pi') {
        const identity = identifyCliCandidate(legacyPiPath, env);
        if (identity === 'zcode') {
            if (!getStr('zcode-path', '').trim()) {
                setStr('zcode-path', legacyPiPath);
            }
            migratedCliIdentity = 'zcode';
        } else if (identity === 'codex') {
            if (!getStr('codex-path', '').trim()) {
                setStr('codex-path', legacyPiPath);
            }
            migratedCliIdentity = 'codex';
        }
    }

    // Preserve original shared provider/model while seeding per-backend keys for verified old backends
    const sharedProvider = getStr('provider', '').trim();
    const sharedModel = getStr('model', '').trim();
    const sharedEffort = getStr('reasoning-effort', 'default').trim() || 'default';

    if (rawBackend === 'zcode') {
        if (sharedProvider && !getStr('zcode-provider', '').trim()) {
            setStr('zcode-provider', sharedProvider);
        }
        if (sharedModel && !getStr('zcode-model', '').trim()) {
            setStr('zcode-model', sharedModel);
        }
        if (sharedEffort !== 'default' && getStr('zcode-reasoning-effort', 'default') === 'default') {
            setStr('zcode-reasoning-effort', sharedEffort);
        }
    } else if (rawBackend === 'codex') {
        if (sharedProvider && !getStr('codex-provider', '').trim()) {
            setStr('codex-provider', sharedProvider);
        }
        if (sharedModel && !getStr('codex-model', '').trim()) {
            setStr('codex-model', sharedModel);
        }
        if (sharedEffort !== 'default' && getStr('codex-reasoning-effort', 'default') === 'default') {
            setStr('codex-reasoning-effort', sharedEffort);
        }
    } else if (rawBackend === 'openai') {
        const oaiModel = getStr('openai-model', '').trim() || sharedModel;
        if (oaiModel && !getStr('openai-model', '').trim()) {
            setStr('openai-model', oaiModel);
        }
        if (sharedEffort !== 'default' && getStr('openai-reasoning-effort', 'default') === 'default') {
            setStr('openai-reasoning-effort', sharedEffort);
        }
    }

    const migratedFromPi = rawBackend === 'pi';
    if (migratedFromPi) {
        setStr('backend', 'auto');
        setStr('migration-notice', PI_MIGRATION_NOTICE);
    } else if (!SUPPORTED_BACKENDS.includes(rawBackend)) {
        setStr('backend', 'auto');
    }

    setInt('config-version', CURRENT_CONFIG_VERSION);
    return {
        migrated: true,
        migratedFromPi,
        migratedCliIdentity,
    };
}

/**
 * Wraps a GJS Gio.Settings object in the portable store interface used by `migrateLegacyConfig`.
 */
export function createGSettingsStoreAdapter(settings) {
    if (!settings) return null;
    return {
        hasKey(key) {
            return Boolean(settings.settings_schema?.has_key?.(key));
        },
        getString(key) {
            return settings.get_string(key);
        },
        setString(key, val) {
            settings.set_string(key, String(val ?? ''));
        },
        getInt(key) {
            return settings.get_int(key);
        },
        setInt(key, val) {
            settings.set_int(key, Math.trunc(Number(val) || 0));
        },
    };
}

/**
 * Checks if stored SessionStore metadata came from a legacy Pi session so its
 * remoteSessionId is never mistakenly passed to ZCode (`--resume`) or Codex (`exec resume`).
 */
export function isLegacyPiSessionMeta(meta) {
    if (!meta || typeof meta !== 'object') return false;
    if (meta.backend === 'pi') return true;
    const sig = String(meta.modelSignature || '');
    return sig.startsWith('pi:');
}

/**
 * Safely parses a legacy Pi local session file (JSON or JSONL) into plain read-only
 * Quick Chat history messages (`user` and `assistant` text/thinking only).
 * Never executes anything or mutates the source content.
 */
export function parseLegacyPiSessionContent(rawContent) {
    if (typeof rawContent !== 'string' || !rawContent.trim()) {
        return {
            ok: false,
            messages: [],
            error: '旧版 Pi 会话文件为空，无法导入。',
        };
    }
    if (rawContent.includes('\u0000')) {
        return {
            ok: false,
            messages: [],
            error: '检测到二进制内容，无法作为文本会话解析，已保留原文件。',
        };
    }

    const extracted = [];
    let parsedAnyStructure = false;

    const pushCandidateMessage = (msg, tsFallback = 0) => {
        if (!msg || typeof msg !== 'object') return;
        const role = msg.role;
        if (role !== 'user' && role !== 'assistant') return;
        const text = messageText(msg).trim();
        const thinking = role === 'assistant' ? messageThinking(msg).trim() : '';
        if (!text && !thinking) return;
        const contentParts = [];
        if (thinking) contentParts.push({type: 'thinking', thinking});
        if (text) contentParts.push({type: 'text', text});
        const rawTs = msg.ts || msg.timestamp || tsFallback;
        const parsedTs = typeof rawTs === 'number'
            ? rawTs
            : (typeof rawTs === 'string' && Date.parse(rawTs) ? Date.parse(rawTs) : 0);
        extracted.push({
            role,
            content: role === 'user' ? text : contentParts,
            ...(parsedTs > 0 ? {ts: parsedTs} : {}),
            importedFrom: 'pi-readonly',
        });
    };

    const trimmed = rawContent.trim();
    if (trimmed.startsWith('{') && !trimmed.includes('\n{')) {
        try {
            const singleObj = JSON.parse(trimmed);
            if (Array.isArray(singleObj.messages)) {
                parsedAnyStructure = true;
                for (const m of singleObj.messages) {
                    pushCandidateMessage(m, singleObj.updatedAt || 0);
                }
            }
        } catch (_) {
            // Fall through to line-by-line JSONL parsing
        }
    }

    if (!parsedAnyStructure) {
        const lines = rawContent.split(/\r?\n/);
        for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            try {
                const entry = JSON.parse(t);
                if (!entry || typeof entry !== 'object') continue;
                parsedAnyStructure = true;
                if (entry.type === 'message' && entry.message) {
                    pushCandidateMessage(entry.message, entry.timestamp || entry.ts || 0);
                } else if (entry.role === 'user' || entry.role === 'assistant') {
                    pushCandidateMessage(entry, entry.timestamp || entry.ts || 0);
                }
            } catch (_) {
                // Ignore malformed lines unless zero valid structures exist
            }
        }
    }

    if (!parsedAnyStructure || extracted.length === 0) {
        return {
            ok: false,
            messages: [],
            error: '无法识别该旧版 Pi 会话格式或其中不含可导入的对话内容，已保留原始文件未作修改。',
        };
    }

    return {
        ok: true,
        messages: extracted,
        error: '',
    };
}
