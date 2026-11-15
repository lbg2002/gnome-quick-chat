import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
    expandHomePath,
    parseCodexHelpCapabilities,
    parseCodexProviderCatalog,
    parseZCodeHelpCapabilities,
    parseZCodeProviderCatalog,
} from '../protocol.js';
import {
    createGSettingsStoreAdapter,
    identifyCliCandidate,
    migrateLegacyConfig,
    resolveBackendSelection,
} from './configMigration.js';
import {
    DEFAULT_CATALOG_CACHE_TTL_MS,
    DEFAULT_CLI_CACHE_TTL_MS,
    ExpiringResourceCache,
    MAX_PROVIDER_CONFIG_BYTES,
    sanitizeProviderCatalogSecrets,
} from './modelCatalogCache.js';
import {readFileBytesBoundedAsync} from './paths.js';

const Decoder = new TextDecoder('utf-8');
const cliCapabilitiesCache = new Map();
const searchPathCache = new ExpiringResourceCache({defaultTtlMs: DEFAULT_CLI_CACHE_TTL_MS});
const cliDetectionCache = new ExpiringResourceCache({defaultTtlMs: DEFAULT_CLI_CACHE_TTL_MS});
const backendCatalogCache = new ExpiringResourceCache({defaultTtlMs: DEFAULT_CATALOG_CACHE_TTL_MS});

/**
 * Invalidates cached CLI detection, PATH/NVM scan, CLI capabilities, and/or model catalogs
 * when relevant GSettings change or when the user triggers a manual refresh (Stage D4).
 */
export function invalidateBackendDetectionCaches(scope = 'all') {
    if (scope === 'catalog') {
        backendCatalogCache.invalidate();
        return;
    }
    if (scope === 'cli') {
        cliCapabilitiesCache.clear();
        searchPathCache.invalidate();
        cliDetectionCache.invalidate();
        return;
    }
    cliCapabilitiesCache.clear();
    searchPathCache.invalidate();
    cliDetectionCache.invalidate();
    backendCatalogCache.invalidate();
}

export function readJsonFileSync(path, maxBytes = MAX_PROVIDER_CONFIG_BYTES) {
    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) return null;
    try {
        if (maxBytes > 0) {
            const info = Gio.File.new_for_path(path).query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
            if (info && Number(info.get_size?.() || 0) > maxBytes) {
                return null;
            }
        }
        const [ok, raw] = GLib.file_get_contents(path);
        if (!ok || !raw || (maxBytes > 0 && raw.byteLength > maxBytes)) return null;
        return JSON.parse(Decoder.decode(raw));
    } catch (_) {
        return null;
    }
}

export function readTextFileSync(path, maxBytes = MAX_PROVIDER_CONFIG_BYTES) {
    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) return '';
    try {
        if (maxBytes > 0) {
            const info = Gio.File.new_for_path(path).query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
            if (info && Number(info.get_size?.() || 0) > maxBytes) {
                return '';
            }
        }
        const [ok, raw] = GLib.file_get_contents(path);
        return ok && raw && (!maxBytes || raw.byteLength <= maxBytes) ? Decoder.decode(raw) : '';
    } catch (_) {
        return '';
    }
}

export async function readTextFileAsync(path, maxBytes = MAX_PROVIDER_CONFIG_BYTES, cancellable = null) {
    const res = await readFileBytesBoundedAsync(path, maxBytes, cancellable);
    if (!res.exists || res.tooLarge || !res.bytes) {
        return '';
    }
    try {
        return Decoder.decode(res.bytes);
    } catch (_) {
        return '';
    }
}

export async function readJsonFileAsync(path, maxBytes = MAX_PROVIDER_CONFIG_BYTES, cancellable = null) {
    const res = await readFileBytesBoundedAsync(path, maxBytes, cancellable);
    if (!res.exists || res.tooLarge || !res.bytes) {
        return null;
    }
    try {
        return JSON.parse(Decoder.decode(res.bytes));
    } catch (_) {
        return null;
    }
}

function readFileHeadSync(path, maxBytes = 2048) {
    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS) || GLib.file_test(path, GLib.FileTest.IS_DIR)) {
        return '';
    }
    let stream = null;
    try {
        const file = Gio.File.new_for_path(path);
        stream = file.read(null);
        const bytes = stream.read_bytes(maxBytes, null);
        const data = bytes ? bytes.get_data() : null;
        if (!data || !data.length) return '';
        if (data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46) {
            return '';
        }
        return Decoder.decode(data);
    } catch (_) {
        return '';
    } finally {
        try { stream?.close(null); } catch (_) {}
    }
}

function readFileHeadAsync(path, maxBytes = 2048) {
    if (!path) return Promise.resolve('');
    const file = Gio.File.new_for_path(path);
    return new Promise(resolve => {
        file.read_async(GLib.PRIORITY_DEFAULT, null, (f, readRes) => {
            let stream = null;
            try {
                stream = f.read_finish(readRes);
            } catch (_) {
                resolve('');
                return;
            }
            stream.read_bytes_async(maxBytes, GLib.PRIORITY_DEFAULT, null, (s, bytesRes) => {
                let text = '';
                try {
                    const gbytes = s.read_bytes_finish(bytesRes);
                    const data = gbytes ? gbytes.get_data() : null;
                    if (data && data.length && !(data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46)) {
                        text = Decoder.decode(data);
                    }
                } catch (_) {}
                try {
                    s.close_async(GLib.PRIORITY_DEFAULT, null, (st, cr) => {
                        try { st.close_finish(cr); } catch (_) {}
                    });
                } catch (_) {}
                resolve(text);
            });
        });
    });
}

function runShortProbeCommandSync(argv, extraEnv = {}, maxChars = 8192) {
    if (!Array.isArray(argv) || !argv.length || !argv[0] || !GLib.file_test(argv[0], GLib.FileTest.IS_EXECUTABLE)) {
        return '';
    }
    try {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        launcher.setenv('NO_COLOR', '1', true);
        for (const [k, v] of Object.entries(extraEnv)) {
            launcher.setenv(k, String(v), true);
        }
        const proc = launcher.spawnv(argv);
        let timedOut = false;
        const killTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1400, () => {
            timedOut = true;
            try { proc.force_exit(); } catch (_) {}
            return GLib.SOURCE_REMOVE;
        });
        let stdout = '';
        let stderr = '';
        try {
            const [, outStr, errStr] = proc.communicate_utf8(null, null);
            stdout = outStr || '';
            stderr = errStr || '';
        } finally {
            try { GLib.source_remove(killTimer); } catch (_) {}
        }
        if (timedOut) return '';
        return `${stdout}\n${stderr}`.trim().slice(0, maxChars);
    } catch (_) {
        return '';
    }
}

export function runShortProbeCommandAsync(argv, extraEnv = {}, maxChars = 8192) {
    if (!Array.isArray(argv) || !argv.length || !argv[0] || !GLib.file_test(argv[0], GLib.FileTest.IS_EXECUTABLE)) {
        return Promise.resolve('');
    }
    return new Promise(resolve => {
        let proc = null;
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            launcher.setenv('NO_COLOR', '1', true);
            for (const [k, v] of Object.entries(extraEnv)) {
                launcher.setenv(k, String(v), true);
            }
            proc = launcher.spawnv(argv);
        } catch (_) {
            resolve('');
            return;
        }

        let timedOut = false;
        const killTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1400, () => {
            timedOut = true;
            try { proc.force_exit(); } catch (_) {}
            return GLib.SOURCE_REMOVE;
        });

        proc.communicate_utf8_async(null, null, (p, res) => {
            try { GLib.source_remove(killTimer); } catch (_) {}
            try {
                const [, outStr, errStr] = p.communicate_utf8_finish(res);
                if (timedOut) {
                    resolve('');
                    return;
                }
                resolve(`${outStr || ''}\n${errStr || ''}`.trim().slice(0, maxChars));
            } catch (_) {
                resolve('');
            }
        });
    });
}

function probeCliVersionSync(executablePath) {
    return runShortProbeCommandSync([executablePath, '--version'], {}, 400);
}

/**
 * Probes and caches actual CLI flags (`--help` / `exec --help` + `--version`) so Quick Chat
 * validates supported arguments rather than assuming all CLI versions accept identical flags.
 */
export function probeCliCapabilities(backend, commandPrefixOrExe, extraEnv = {}) {
    const prefix = Array.isArray(commandPrefixOrExe)
        ? commandPrefixOrExe.filter(Boolean)
        : [String(commandPrefixOrExe || '').trim()].filter(Boolean);
    if (!prefix.length) {
        return backend === 'zcode'
            ? parseZCodeHelpCapabilities('', '')
            : parseCodexHelpCapabilities('', '');
    }

    const cacheKey = `${backend}:${prefix.join('\u0000')}`;
    if (cliCapabilitiesCache.has(cacheKey)) {
        return cliCapabilitiesCache.get(cacheKey);
    }

    const versionOut = runShortProbeCommandSync([...prefix, '--version'], extraEnv, 500);
    const helpArgs = backend === 'codex' ? [...prefix, 'exec', '--help'] : [...prefix, '--help'];
    let helpOut = runShortProbeCommandSync(helpArgs, extraEnv, 12000);
    if (!helpOut && backend === 'codex') {
        helpOut = runShortProbeCommandSync([...prefix, '--help'], extraEnv, 12000);
    }

    const parsed = backend === 'zcode'
        ? parseZCodeHelpCapabilities(helpOut, versionOut)
        : parseCodexHelpCapabilities(helpOut, versionOut);
    cliCapabilitiesCache.set(cacheKey, parsed);
    return parsed;
}

export async function probeCliCapabilitiesAsync(backend, commandPrefixOrExe, extraEnv = {}) {
    const prefix = Array.isArray(commandPrefixOrExe)
        ? commandPrefixOrExe.filter(Boolean)
        : [String(commandPrefixOrExe || '').trim()].filter(Boolean);
    if (!prefix.length) {
        return backend === 'zcode'
            ? parseZCodeHelpCapabilities('', '')
            : parseCodexHelpCapabilities('', '');
    }

    const cacheKey = `${backend}:${prefix.join('\u0000')}`;
    if (cliCapabilitiesCache.has(cacheKey)) {
        return cliCapabilitiesCache.get(cacheKey);
    }

    const versionOut = await runShortProbeCommandAsync([...prefix, '--version'], extraEnv, 500);
    const helpArgs = backend === 'codex' ? [...prefix, 'exec', '--help'] : [...prefix, '--help'];
    let helpOut = await runShortProbeCommandAsync(helpArgs, extraEnv, 12000);
    if (!helpOut && backend === 'codex') {
        helpOut = await runShortProbeCommandAsync([...prefix, '--help'], extraEnv, 12000);
    }

    const parsed = backend === 'zcode'
        ? parseZCodeHelpCapabilities(helpOut, versionOut)
        : parseCodexHelpCapabilities(helpOut, versionOut);
    cliCapabilitiesCache.set(cacheKey, parsed);
    return parsed;
}

export function listNvmBinDirs(homeDir) {
    const nvmNodeDir = GLib.build_filenamev([homeDir, '.nvm', 'versions', 'node']);
    if (!GLib.file_test(nvmNodeDir, GLib.FileTest.IS_DIR)) return [];
    const versions = [];
    try {
        const dir = GLib.Dir.open(nvmNodeDir, 0);
        let name;
        while ((name = dir.read_name()) !== null) {
            const binDir = GLib.build_filenamev([nvmNodeDir, name, 'bin']);
            if (GLib.file_test(binDir, GLib.FileTest.IS_DIR)) {
                versions.push({name, binDir});
            }
        }
        dir.close();
    } catch (_) {}
    versions.sort((a, b) => b.name.localeCompare(a.name, undefined, {numeric: true}));
    return versions.map(v => v.binDir);
}

export function listNvmBinDirsAsync(homeDir) {
    const nvmNodeDir = GLib.build_filenamev([homeDir, '.nvm', 'versions', 'node']);
    const dirFile = Gio.File.new_for_path(nvmNodeDir);
    return new Promise(resolve => {
        dirFile.enumerate_children_async(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            (f, enumRes) => {
                let enumerator = null;
                try {
                    enumerator = f.enumerate_children_finish(enumRes);
                } catch (_) {
                    resolve([]);
                    return;
                }
                const versions = [];
                const pump = () => {
                    enumerator.next_files_async(32, GLib.PRIORITY_DEFAULT, null, (en, nextRes) => {
                        let infos = [];
                        try {
                            infos = en.next_files_finish(nextRes) || [];
                        } catch (_) {
                            infos = [];
                        }
                        if (!infos.length) {
                            try { en.close_async(GLib.PRIORITY_DEFAULT, null, () => {}); } catch (_) {}
                            versions.sort((a, b) => b.name.localeCompare(a.name, undefined, {numeric: true}));
                            resolve(versions.map(v => v.binDir));
                            return;
                        }
                        for (const info of infos) {
                            const name = info.get_name?.() || '';
                            if (!name) continue;
                            const binDir = GLib.build_filenamev([nvmNodeDir, name, 'bin']);
                            if (GLib.file_test(binDir, GLib.FileTest.IS_DIR)) {
                                versions.push({name, binDir});
                            }
                        }
                        pump();
                    });
                };
                pump();
            }
        );
    });
}

function assembleSearchDirs(home, extraExecutable, nvmBinDirs) {
    const sysPath = (GLib.getenv('PATH') || '/usr/local/bin:/usr/bin:/bin').split(':').filter(Boolean);
    const dirs = [];
    const pushDir = d => {
        if (d && !dirs.includes(d) && GLib.file_test(d, GLib.FileTest.IS_DIR)) {
            dirs.push(d);
        }
    };

    const expandedExtra = extraExecutable ? expandHomePath(extraExecutable, home) : '';
    if (expandedExtra && expandedExtra.startsWith('/')) {
        pushDir(GLib.path_get_dirname(expandedExtra));
        try {
            const linkTarget = GLib.file_read_link(expandedExtra);
            const resolved = linkTarget.startsWith('/')
                ? linkTarget
                : GLib.build_filenamev([GLib.path_get_dirname(expandedExtra), linkTarget]);
            pushDir(GLib.path_get_dirname(resolved));
        } catch (_) {}
    }

    for (const nvmBin of nvmBinDirs) pushDir(nvmBin);
    pushDir(GLib.build_filenamev([home, '.local', 'bin']));
    pushDir(GLib.build_filenamev([home, 'bin']));
    pushDir(GLib.build_filenamev([home, '.opencode', 'bin']));
    pushDir(GLib.build_filenamev([home, '.local', 'share', 'pnpm']));
    pushDir(GLib.build_filenamev([home, '.bun', 'bin']));
    pushDir(GLib.build_filenamev([home, '.npm-global', 'bin']));
    pushDir(GLib.build_filenamev([home, '.volta', 'bin']));
    pushDir(GLib.build_filenamev([home, '.cargo', 'bin']));
    pushDir('/usr/local/bin');
    for (const p of sysPath) pushDir(p);
    return dirs;
}

export function buildSearchPath(extraExecutable = '') {
    const cacheKey = `path:${String(extraExecutable || '').trim()}`;
    const cached = searchPathCache.peek(cacheKey);
    if (cached.hit && !cached.stale && Array.isArray(cached.value)) {
        return [...cached.value];
    }
    const home = GLib.get_home_dir();
    const dirs = assembleSearchDirs(home, extraExecutable, listNvmBinDirs(home));
    searchPathCache.set(cacheKey, dirs);
    return [...dirs];
}

export async function buildSearchPathAsync(extraExecutable = '', {forceRefresh = false} = {}) {
    const cacheKey = `path:${String(extraExecutable || '').trim()}`;
    const dirs = await searchPathCache.getOrLoadAsync(
        cacheKey,
        async () => {
            const home = GLib.get_home_dir();
            const nvmDirs = await listNvmBinDirsAsync(home);
            return assembleSearchDirs(home, extraExecutable, nvmDirs);
        },
        {forceRefresh}
    );
    return [...dirs];
}

export function findExecutableInDirs(nameOrPath, pathDirs) {
    if (!nameOrPath) return null;
    const home = GLib.get_home_dir() || '';
    const expanded = nameOrPath.startsWith('~') || nameOrPath.startsWith('$')
        ? expandHomePath(nameOrPath, home)
        : nameOrPath;
    if (expanded.includes('/')) {
        return GLib.file_test(expanded, GLib.FileTest.IS_EXECUTABLE) &&
            !GLib.file_test(expanded, GLib.FileTest.IS_DIR)
            ? expanded
            : null;
    }
    for (const dir of pathDirs) {
        const candidate = GLib.build_filenamev([dir, expanded]);
        if (GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE) &&
            !GLib.file_test(candidate, GLib.FileTest.IS_DIR)) {
            return candidate;
        }
    }
    return null;
}

export function createGioCliEnv(extraExecutable = '', precomputedPathDirs = null) {
    const home = GLib.get_home_dir() || '';
    const pathDirs = Array.isArray(precomputedPathDirs)
        ? precomputedPathDirs
        : buildSearchPath(extraExecutable);

    const resolveCandidate = raw => {
        const trimmed = String(raw || '').trim();
        if (!trimmed) return '';
        const expanded = trimmed.startsWith('~') || trimmed.startsWith('$')
            ? expandHomePath(trimmed, home)
            : trimmed;
        if (expanded.includes('/')) {
            return expanded;
        }
        return findExecutableInDirs(expanded, pathDirs) || '';
    };

    const readLink = p => {
        try {
            const target = GLib.file_read_link(p);
            if (!target) return '';
            return target.startsWith('/')
                ? target
                : GLib.build_filenamev([GLib.path_get_dirname(p), target]);
        } catch (_) {
            return '';
        }
    };

    const hasZCodeNodeRuntime = () => Boolean(
        findExecutableInDirs('node', pathDirs) ||
        GLib.file_test('/opt/ZCode/zcode', GLib.FileTest.IS_EXECUTABLE)
    );

    const baseEnv = {
        pathDirs,
        resolveCandidate,
        fileExists: p => Boolean(p && GLib.file_test(p, GLib.FileTest.EXISTS)),
        isDir: p => Boolean(p && GLib.file_test(p, GLib.FileTest.IS_DIR)),
        isExecutable: p => Boolean(
            p &&
            GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE) &&
            !GLib.file_test(p, GLib.FileTest.IS_DIR)
        ),
        readLink,
        readFileHead: readFileHeadSync,
        probeVersion: probeCliVersionSync,
        hasZCodeNodeRuntime,
    };

    return {
        ...baseEnv,
        hasZCode(customZCodePath = '') {
            const custom = String(customZCodePath || '').trim();
            if (custom) {
                return identifyCliCandidate(custom, baseEnv) === 'zcode';
            }
            const bundledZCode = '/opt/ZCode/resources/glm/zcode.cjs';
            if (GLib.file_test(bundledZCode, GLib.FileTest.EXISTS) && hasZCodeNodeRuntime()) {
                return true;
            }
            const pathZCode = findExecutableInDirs('zcode', pathDirs);
            return Boolean(pathZCode && identifyCliCandidate(pathZCode, baseEnv) === 'zcode');
        },
        hasCodex(customCodexPath = '') {
            const custom = String(customCodexPath || '').trim();
            if (custom) {
                return identifyCliCandidate(custom, baseEnv) === 'codex';
            }
            const pathCodex = findExecutableInDirs('codex', pathDirs);
            return Boolean(pathCodex && identifyCliCandidate(pathCodex, baseEnv) === 'codex');
        },
    };
}

export function migrateGSettingsIfNeeded(settings) {
    if (!settings) return {migrated: false, migratedFromPi: false, migratedCliIdentity: 'none'};
    const store = createGSettingsStoreAdapter(settings);
    const hasVer = store.hasKey('config-version') && store.getInt('config-version') >= 1;
    const legacyHint = !hasVer && store.hasKey('pi-path') ? store.getString('pi-path') : '';
    const cliEnv = createGioCliEnv(legacyHint);
    return migrateLegacyConfig(store, cliEnv);
}

function makeSelectionCacheKey({
    configuredBackend = 'auto',
    zcodePath = '',
    codexPath = '',
    openaiBaseUrl = '',
} = {}) {
    return `sel:${configuredBackend}\u0000${zcodePath}\u0000${codexPath}\u0000${openaiBaseUrl}`;
}

export function detectBackendSelection({
    configuredBackend = 'auto',
    zcodePath = '',
    codexPath = '',
    openaiBaseUrl = '',
} = {}) {
    const cacheKey = makeSelectionCacheKey({configuredBackend, zcodePath, codexPath, openaiBaseUrl});
    const cached = cliDetectionCache.peek(cacheKey);
    if (cached.hit && !cached.stale && cached.value) {
        return {...cached.value};
    }
    const extra = zcodePath || codexPath || '';
    const cliEnv = createGioCliEnv(extra);
    const resolved = resolveBackendSelection(
        {configuredBackend, zcodePath, codexPath, openaiBaseUrl},
        cliEnv
    );
    cliDetectionCache.set(cacheKey, resolved);
    return {...resolved};
}

export async function detectBackendSelectionAsync({
    configuredBackend = 'auto',
    zcodePath = '',
    codexPath = '',
    openaiBaseUrl = '',
} = {}, {forceRefresh = false} = {}) {
    const cacheKey = makeSelectionCacheKey({configuredBackend, zcodePath, codexPath, openaiBaseUrl});
    const resolved = await cliDetectionCache.getOrLoadAsync(
        cacheKey,
        async () => {
            const extra = zcodePath || codexPath || '';
            const pathDirs = await buildSearchPathAsync(extra, {forceRefresh});
            const headPreload = new Map();
            const verPreload = new Map();

            const preloadCandidate = async raw => {
                const candidate = raw
                    ? (raw.includes('/') ? raw : findExecutableInDirs(raw, pathDirs))
                    : '';
                if (!candidate || headPreload.has(candidate)) return;
                const head = await readFileHeadAsync(candidate);
                headPreload.set(candidate, head);
                if (!head && GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE)) {
                    const ver = await runShortProbeCommandAsync([candidate, '--version'], {}, 400);
                    verPreload.set(candidate, ver);
                }
            };

            await Promise.all([
                preloadCandidate(zcodePath || 'zcode'),
                preloadCandidate(codexPath || 'codex'),
            ]);

            const syncEnv = createGioCliEnv(extra, pathDirs);
            const asyncAwareEnv = {
                ...syncEnv,
                readFileHead: p => (headPreload.has(p) ? headPreload.get(p) : readFileHeadSync(p)),
                probeVersion: p => (verPreload.has(p) ? verPreload.get(p) : probeCliVersionSync(p)),
            };
            return resolveBackendSelection(
                {configuredBackend, zcodePath, codexPath, openaiBaseUrl},
                {
                    ...asyncAwareEnv,
                    hasZCode(customZCodePath = '') {
                        const custom = String(customZCodePath || '').trim();
                        if (custom) {
                            return identifyCliCandidate(custom, asyncAwareEnv) === 'zcode';
                        }
                        const bundledZCode = '/opt/ZCode/resources/glm/zcode.cjs';
                        if (GLib.file_test(bundledZCode, GLib.FileTest.EXISTS) && asyncAwareEnv.hasZCodeNodeRuntime()) {
                            return true;
                        }
                        const pathZCode = findExecutableInDirs('zcode', pathDirs);
                        return Boolean(pathZCode && identifyCliCandidate(pathZCode, asyncAwareEnv) === 'zcode');
                    },
                    hasCodex(customCodexPath = '') {
                        const custom = String(customCodexPath || '').trim();
                        if (custom) {
                            return identifyCliCandidate(custom, asyncAwareEnv) === 'codex';
                        }
                        const pathCodex = findExecutableInDirs('codex', pathDirs);
                        return Boolean(pathCodex && identifyCliCandidate(pathCodex, asyncAwareEnv) === 'codex');
                    },
                }
            );
        },
        {forceRefresh}
    );
    return {...resolved};
}

/**
 * Shared backend detection logic used identically by Preferences UI, Quick Model Switcher, and Runtime.
 * Returns 'zcode' | 'codex' | 'openai' | 'unconfigured'.
 */
export function detectEffectiveBackend(configuredBackend = 'auto', options = {}) {
    const normalizedOpts = typeof options === 'object' && options !== null
        ? options
        : {openaiBaseUrl: ''};
    return detectBackendSelection({
        configuredBackend,
        zcodePath: normalizedOpts.zcodePath || '',
        codexPath: normalizedOpts.codexPath || '',
        openaiBaseUrl: normalizedOpts.openaiBaseUrl || '',
    }).effectiveBackend;
}

function emptyCatalogSkeleton(effectiveBackend) {
    const labels = {
        zcode: 'ZCode CLI',
        codex: 'Codex CLI',
        unconfigured: '未配置后端',
        openai: '自定义 OpenAI API',
    };
    return {
        backendLabel: labels[effectiveBackend] || '自定义 OpenAI API',
        providers: [],
        defaultProviderId: effectiveBackend === 'codex' ? 'openai' : '',
        defaultModelId: '',
    };
}

/**
 * Zero-I/O synchronous peek into the sanitized local model catalog cache so opening the
 * panel or model picker renders cached models immediately without touching disk (Stage D4).
 */
export function peekCachedBackendCatalog(effectiveBackend) {
    const key = `catalog:${effectiveBackend}`;
    const cached = backendCatalogCache.peek(key);
    if (cached.hit && cached.value) {
        return {
            ...cached.value,
            fromCache: true,
            stale: cached.stale,
        };
    }
    return {
        ...emptyCatalogSkeleton(effectiveBackend),
        fromCache: false,
        stale: true,
    };
}

/**
 * Asynchronous Gio I/O loader for ZCode / Codex local model catalogs (Stage D4).
 * Strips all secret fields before caching in memory.
 */
export async function loadLocalBackendCatalogAsync(effectiveBackend, {forceRefresh = false} = {}) {
    const key = `catalog:${effectiveBackend}`;
    return backendCatalogCache.getOrLoadAsync(
        key,
        async () => {
            const home = GLib.get_home_dir();
            if (effectiveBackend === 'zcode') {
                const personalPath = GLib.build_filenamev([home, '.zcode', 'v2', 'provider_config.json']);
                const builtinPath = '/opt/ZCode/resources/config/provider/zcode-builtin.json';
                const [personalObj, builtinObj] = await Promise.all([
                    readJsonFileAsync(personalPath),
                    readJsonFileAsync(builtinPath),
                ]);
                const cat = parseZCodeProviderCatalog(personalObj, builtinObj);
                return sanitizeProviderCatalogSecrets({
                    backendLabel: 'ZCode CLI',
                    providers: cat.providers,
                    defaultProviderId: cat.defaultSelection?.providerId || '',
                    defaultModelId: cat.defaultSelection?.modelId || '',
                });
            }

            if (effectiveBackend === 'codex') {
                const tomlPath = GLib.build_filenamev([home, '.codex', 'config.toml']);
                const cachePath = GLib.build_filenamev([home, '.codex', 'models_cache.json']);
                const [tomlText, cacheObj] = await Promise.all([
                    readTextFileAsync(tomlPath),
                    readJsonFileAsync(cachePath),
                ]);
                const cat = parseCodexProviderCatalog(tomlText, cacheObj);
                return sanitizeProviderCatalogSecrets({
                    backendLabel: 'Codex CLI',
                    providers: cat.providers,
                    defaultProviderId: cat.defaultProvider || 'openai',
                    defaultModelId: cat.defaultModel || '',
                });
            }

            return sanitizeProviderCatalogSecrets(emptyCatalogSkeleton(effectiveBackend));
        },
        {forceRefresh}
    );
}

export function loadLocalBackendCatalog(effectiveBackend) {
    const key = `catalog:${effectiveBackend}`;
    const cached = backendCatalogCache.peek(key);
    if (cached.hit && !cached.stale && cached.value) {
        return cached.value;
    }

    const home = GLib.get_home_dir();
    let result;
    if (effectiveBackend === 'zcode') {
        const personalPath = GLib.build_filenamev([home, '.zcode', 'v2', 'provider_config.json']);
        const builtinPath = '/opt/ZCode/resources/config/provider/zcode-builtin.json';
        const personalObj = readJsonFileSync(personalPath);
        const builtinObj = readJsonFileSync(builtinPath);
        const cat = parseZCodeProviderCatalog(personalObj, builtinObj);
        result = sanitizeProviderCatalogSecrets({
            backendLabel: 'ZCode CLI',
            providers: cat.providers,
            defaultProviderId: cat.defaultSelection?.providerId || '',
            defaultModelId: cat.defaultSelection?.modelId || '',
        });
    } else if (effectiveBackend === 'codex') {
        const tomlPath = GLib.build_filenamev([home, '.codex', 'config.toml']);
        const cachePath = GLib.build_filenamev([home, '.codex', 'models_cache.json']);
        const cat = parseCodexProviderCatalog(readTextFileSync(tomlPath), readJsonFileSync(cachePath));
        result = sanitizeProviderCatalogSecrets({
            backendLabel: 'Codex CLI',
            providers: cat.providers,
            defaultProviderId: cat.defaultProvider || 'openai',
            defaultModelId: cat.defaultModel || '',
        });
    } else {
        result = sanitizeProviderCatalogSecrets(emptyCatalogSkeleton(effectiveBackend));
    }

    backendCatalogCache.set(key, result);
    return result;
}
