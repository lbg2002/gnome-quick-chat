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

const Decoder = new TextDecoder('utf-8');
const cliCapabilitiesCache = new Map();

export function readJsonFileSync(path) {
    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) return null;
    try {
        const [ok, raw] = GLib.file_get_contents(path);
        if (!ok || !raw) return null;
        return JSON.parse(Decoder.decode(raw));
    } catch (_) {
        return null;
    }
}

export function readTextFileSync(path) {
    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) return '';
    try {
        const [ok, raw] = GLib.file_get_contents(path);
        return ok && raw ? Decoder.decode(raw) : '';
    } catch (_) {
        return '';
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
        // Skip binary ELF executables
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

export function buildSearchPath(extraExecutable = '') {
    const home = GLib.get_home_dir();
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

    for (const nvmBin of listNvmBinDirs(home)) pushDir(nvmBin);
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

export function createGioCliEnv(extraExecutable = '') {
    const home = GLib.get_home_dir() || '';
    const pathDirs = buildSearchPath(extraExecutable);

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

export function detectBackendSelection({
    configuredBackend = 'auto',
    zcodePath = '',
    codexPath = '',
    openaiBaseUrl = '',
} = {}) {
    const extra = zcodePath || codexPath || '';
    const cliEnv = createGioCliEnv(extra);
    return resolveBackendSelection(
        {configuredBackend, zcodePath, codexPath, openaiBaseUrl},
        cliEnv
    );
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

export function loadLocalBackendCatalog(effectiveBackend) {
    const home = GLib.get_home_dir();
    if (effectiveBackend === 'zcode') {
        const personalPath = GLib.build_filenamev([home, '.zcode', 'v2', 'provider_config.json']);
        const builtinPath = '/opt/ZCode/resources/config/provider/zcode-builtin.json';
        const personalObj = readJsonFileSync(personalPath);
        const builtinObj = readJsonFileSync(builtinPath);
        const cat = parseZCodeProviderCatalog(personalObj, builtinObj);
        return {
            backendLabel: 'ZCode CLI',
            providers: cat.providers,
            defaultProviderId: cat.defaultSelection?.providerId || '',
            defaultModelId: cat.defaultSelection?.modelId || '',
        };
    }

    if (effectiveBackend === 'codex') {
        const tomlPath = GLib.build_filenamev([home, '.codex', 'config.toml']);
        const cachePath = GLib.build_filenamev([home, '.codex', 'models_cache.json']);
        const cat = parseCodexProviderCatalog(readTextFileSync(tomlPath), readJsonFileSync(cachePath));
        return {
            backendLabel: 'Codex CLI',
            providers: cat.providers,
            defaultProviderId: cat.defaultProvider || 'openai',
            defaultModelId: cat.defaultModel || '',
        };
    }

    if (effectiveBackend === 'unconfigured') {
        return {
            backendLabel: '未配置后端',
            providers: [],
            defaultProviderId: '',
            defaultModelId: '',
        };
    }

    return {
        backendLabel: '自定义 OpenAI API',
        providers: [],
        defaultProviderId: '',
        defaultModelId: '',
    };
}
