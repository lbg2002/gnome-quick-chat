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
    matchesDshHeadlessHelp,
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
import {extractDshConfiguredModel, makeDshModelCatalog} from './dshModelCatalog.js';
import {
    buildProcessGroupKillArgv,
    isSafeProcessGroupId,
    parseLinuxProcStat,
    wrapArgvWithSetsid,
} from '../runtime/cliProcessRunner.js';

const Decoder = new TextDecoder('utf-8');
const cliCapabilitiesCache = new Map();
const cliCapabilitiesResourceCache = new ExpiringResourceCache({defaultTtlMs: DEFAULT_CLI_CACHE_TTL_MS});
const searchPathCache = new ExpiringResourceCache({defaultTtlMs: DEFAULT_CLI_CACHE_TTL_MS});
const cliDetectionCache = new ExpiringResourceCache({defaultTtlMs: DEFAULT_CLI_CACHE_TTL_MS});
const backendCatalogCache = new ExpiringResourceCache({defaultTtlMs: DEFAULT_CATALOG_CACHE_TTL_MS});

/**
 * Invalidates cached CLI detection, PATH/NVM scan, CLI capabilities, and/or model catalogs
 * when relevant GSettings change or when the user triggers a manual refresh (Stage D4 / R4).
 */
export function invalidateBackendDetectionCaches(scope = 'all') {
    if (scope === 'catalog') {
        backendCatalogCache.invalidate();
        return;
    }
    if (scope === 'cli') {
        cliCapabilitiesCache.clear();
        cliCapabilitiesResourceCache.invalidate();
        searchPathCache.invalidate();
        cliDetectionCache.invalidate();
        return;
    }
    cliCapabilitiesCache.clear();
    cliCapabilitiesResourceCache.invalidate();
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

function readFileHeadAsync(path, maxBytes = 2048, cancellable = null) {
    if (!path || cancellable?.is_cancelled?.()) return Promise.resolve('');
    const file = Gio.File.new_for_path(path);
    return new Promise(resolve => {
        file.read_async(GLib.PRIORITY_DEFAULT, cancellable, (f, readRes) => {
            let stream = null;
            try {
                stream = f.read_finish(readRes);
            } catch (_) {
                resolve('');
                return;
            }
            stream.read_bytes_async(maxBytes, GLib.PRIORITY_DEFAULT, cancellable, (s, bytesRes) => {
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

function resolveProbeSetsidExecutable() {
    for (const candidate of ['/usr/bin/setsid', '/bin/setsid']) {
        if (GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE)) {
            return candidate;
        }
    }
    return '';
}

function readProbeProcStatSync(pidOrSelf = 'self') {
    try {
        const statPath = `/proc/${pidOrSelf}/stat`;
        if (!GLib.file_test(statPath, GLib.FileTest.EXISTS)) return null;
        const [ok, rawBytes] = GLib.file_get_contents(statPath);
        if (!ok || !rawBytes) return null;
        return parseLinuxProcStat(Decoder.decode(rawBytes));
    } catch (_) {
        return null;
    }
}

function signalProbeProcessGroupAsync(pgid, sig = 'TERM') {
    let argv;
    try {
        argv = buildProcessGroupKillArgv(pgid, sig);
    } catch (_) {
        return;
    }
    try {
        const killProc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDERR_SILENCE);
        killProc.wait_async(null, (kp, res) => {
            try { kp.wait_finish(res); } catch (_) {}
        });
    } catch (_) {}
}

function terminateProbeProcessGroup(proc, {
    isolatedProcessGroup = false,
    processGroupId = 0,
    leaderStartTime = '',
} = {}) {
    const canSignalGroup = () => {
        if (!isolatedProcessGroup || !Number.isInteger(processGroupId) || processGroupId <= 1) {
            return false;
        }
        const selfStat = readProbeProcStatSync('self');
        if (!isSafeProcessGroupId(processGroupId, {
            selfPid: selfStat?.pid || 0,
            selfPgid: selfStat?.pgrp || 0,
        })) {
            return false;
        }
        if (leaderStartTime) {
            const currentLeader = readProbeProcStatSync(processGroupId);
            if (currentLeader && currentLeader.startTime && currentLeader.startTime !== leaderStartTime) {
                return false;
            }
        }
        return true;
    };

    if (canSignalGroup()) {
        signalProbeProcessGroupAsync(processGroupId, 'TERM');
    } else {
        try { proc?.send_signal?.(15); } catch (_) {}
    }

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
        if (canSignalGroup()) {
            signalProbeProcessGroupAsync(processGroupId, 'KILL');
        }
        try { proc?.force_exit?.(); } catch (_) {}
        return GLib.SOURCE_REMOVE;
    });
}

function queryFileSignatureSync(filePath) {
    if (!filePath) return 'none';
    try {
        const info = Gio.File.new_for_path(filePath).query_info(
            'standard::size,time::modified,time::modified-usec',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        if (!info) return 'missing';
        const size = Number(info.get_size?.() || 0);
        const mtimeSec = String(info.get_attribute_uint64?.('time::modified') ?? 0n);
        const mtimeUsec = Number(info.get_attribute_uint32?.('time::modified-usec') ?? 0);
        return `${size}:${mtimeSec}:${mtimeUsec}`;
    } catch (_) {
        return 'err';
    }
}

function queryFileSignatureAsync(filePath, cancellable = null) {
    if (!filePath) return Promise.resolve('none');
    const gfile = Gio.File.new_for_path(filePath);
    return new Promise(resolve => {
        gfile.query_info_async(
            'standard::size,time::modified,time::modified-usec',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (f, res) => {
                try {
                    const info = f.query_info_finish(res);
                    if (!info) {
                        resolve('missing');
                        return;
                    }
                    const size = Number(info.get_size?.() || 0);
                    const mtimeSec = String(info.get_attribute_uint64?.('time::modified') ?? 0n);
                    const mtimeUsec = Number(info.get_attribute_uint32?.('time::modified-usec') ?? 0);
                    resolve(`${size}:${mtimeSec}:${mtimeUsec}`);
                } catch (_) {
                    resolve('err');
                }
            }
        );
    });
}

/**
 * Synchronous probe helper kept ONLY for offline unit tests / non-Shell CLI scripts.
 * Production GNOME Shell code paths MUST use `runShortProbeCommandAsync` / `probeCliCapabilitiesAsync`.
 */
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

/**
 * Bounded, deadline-enforced, cancellable short CLI probe that spawns inside an isolated
 * `setsid` process group and reads stdout/stderr in bounded byte chunks (never calling
 * unbounded `communicate_utf8_async`).
 */
export function runShortProbeCommandWithMetaAsync(argv, extraEnv = {}, maxChars = 8192, options = {}) {
    const {
        timeoutMs = 1400,
        maxBytes = 0,
        cancellable = null,
        setsidPath = undefined,
    } = options || {};

    if (!Array.isArray(argv) || !argv.length || !argv[0] || !GLib.file_test(argv[0], GLib.FileTest.IS_EXECUTABLE)) {
        return Promise.resolve({output: '', timedOut: false, cancelled: false, ok: false});
    }
    if (cancellable?.is_cancelled?.()) {
        return Promise.resolve({output: '', timedOut: false, cancelled: true, ok: false});
    }

    const effectiveMaxBytes = maxBytes > 0 ? Number(maxBytes) : Math.max(4096, maxChars * 4);
    const readChunkSize = Math.min(4096, effectiveMaxBytes);

    return new Promise(resolve => {
        let proc = null;
        let isolatedProcessGroup = false;
        let processGroupId = 0;
        let leaderStartTime = '';

        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            launcher.setenv('NO_COLOR', '1', true);
            for (const [k, v] of Object.entries(extraEnv)) {
                launcher.setenv(k, String(v), true);
            }
            const effectiveSetsid = setsidPath !== undefined ? setsidPath : resolveProbeSetsidExecutable();
            const wrapped = wrapArgvWithSetsid(argv, effectiveSetsid);
            proc = launcher.spawnv(wrapped.argv);

            const rawPid = Number.parseInt(proc.get_identifier?.() || '', 10) || 0;
            const selfStat = readProbeProcStatSync('self');
            const leaderStat = rawPid > 1 ? readProbeProcStatSync(rawPid) : null;
            isolatedProcessGroup = Boolean(
                wrapped.isolatedProcessGroup &&
                isSafeProcessGroupId(rawPid, {
                    selfPid: selfStat?.pid || 0,
                    selfPgid: selfStat?.pgrp || 0,
                })
            );
            processGroupId = isolatedProcessGroup ? rawPid : 0;
            leaderStartTime = leaderStat?.startTime ? String(leaderStat.startTime) : '';
        } catch (_) {
            resolve({output: '', timedOut: false, cancelled: false, ok: false});
            return;
        }

        const stdoutPipe = proc.get_stdout_pipe();
        const stderrPipe = proc.get_stderr_pipe();
        const streamCancellable = new Gio.Cancellable();

        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let byteCapReached = false;
        let stdoutDone = !stdoutPipe;
        let stderrDone = !stderrPipe;
        let procExited = false;
        let totalBytes = 0;
        const outChunks = [];
        const errChunks = [];
        let killTimerId = 0;
        let postExitDrainTimerId = 0;
        let cancelListenerId = 0;

        const closePipesQuietly = () => {
            if (stdoutPipe) {
                try {
                    stdoutPipe.close_async(GLib.PRIORITY_DEFAULT, null, (s, r) => {
                        try { s.close_finish(r); } catch (_) {}
                    });
                } catch (_) {}
            }
            if (stderrPipe) {
                try {
                    stderrPipe.close_async(GLib.PRIORITY_DEFAULT, null, (s, r) => {
                        try { s.close_finish(r); } catch (_) {}
                    });
                } catch (_) {}
            }
        };

        const cleanupTimersAndListeners = () => {
            if (killTimerId) {
                try { GLib.source_remove(killTimerId); } catch (_) {}
                killTimerId = 0;
            }
            if (postExitDrainTimerId) {
                try { GLib.source_remove(postExitDrainTimerId); } catch (_) {}
                postExitDrainTimerId = 0;
            }
            if (cancelListenerId && cancellable?.disconnect) {
                try { cancellable.disconnect(cancelListenerId); } catch (_) {}
                cancelListenerId = 0;
            }
        };

        const decodeChunks = chunks => {
            if (!chunks.length) return '';
            const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const c of chunks) {
                merged.set(c, offset);
                offset += c.byteLength;
            }
            try {
                return Decoder.decode(merged);
            } catch (_) {
                return '';
            }
        };

        const finalizeProbe = forceKill => {
            if (settled) return;
            settled = true;
            cleanupTimersAndListeners();
            try { streamCancellable.cancel(); } catch (_) {}
            closePipesQuietly();
            if (forceKill) {
                terminateProbeProcessGroup(proc, {
                    isolatedProcessGroup,
                    processGroupId,
                    leaderStartTime,
                });
            }
            if (timedOut || cancelled) {
                resolve({output: '', timedOut, cancelled, ok: false});
                return;
            }
            const stdoutText = decodeChunks(outChunks);
            const stderrText = decodeChunks(errChunks);
            const output = `${stdoutText}\n${stderrText}`.trim().slice(0, maxChars);
            resolve({output, timedOut: false, cancelled: false, ok: true});
        };

        const checkNormalCompletion = () => {
            if (settled) return;
            if (byteCapReached) {
                finalizeProbe(true);
                return;
            }
            if (procExited && stdoutDone && stderrDone) {
                finalizeProbe(false);
            }
        };

        const effectiveTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 1400;
        killTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, effectiveTimeoutMs, () => {
            killTimerId = 0;
            timedOut = true;
            finalizeProbe(true);
            return GLib.SOURCE_REMOVE;
        });

        if (cancellable?.connect) {
            cancelListenerId = cancellable.connect(() => {
                cancelled = true;
                finalizeProbe(true);
            });
        }

        proc.wait_async(null, (p, res) => {
            try { p.wait_finish(res); } catch (_) {}
            procExited = true;
            if (!settled && (!stdoutDone || !stderrDone)) {
                postExitDrainTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    postExitDrainTimerId = 0;
                    stdoutDone = true;
                    stderrDone = true;
                    finalizeProbe(true);
                    return GLib.SOURCE_REMOVE;
                });
            }
            checkNormalCompletion();
        });

        const pumpPipe = (pipe, targetChunks, onDone) => {
            if (!pipe || settled) {
                onDone();
                checkNormalCompletion();
                return;
            }
            const remaining = effectiveMaxBytes - totalBytes;
            if (remaining <= 0) {
                byteCapReached = true;
                onDone();
                checkNormalCompletion();
                return;
            }
            const toRead = Math.min(readChunkSize, remaining);
            pipe.read_bytes_async(toRead, GLib.PRIORITY_DEFAULT, streamCancellable, (stream, res) => {
                let gbytes = null;
                try {
                    gbytes = stream.read_bytes_finish(res);
                } catch (_) {
                    onDone();
                    checkNormalCompletion();
                    return;
                }
                if (settled) return;
                const data = gbytes ? gbytes.get_data() : null;
                if (!data || data.byteLength === 0) {
                    onDone();
                    checkNormalCompletion();
                    return;
                }
                const copy = data instanceof Uint8Array ? data : new Uint8Array(data);
                targetChunks.push(copy);
                totalBytes += copy.byteLength;
                if (totalBytes >= effectiveMaxBytes) {
                    byteCapReached = true;
                    onDone();
                    checkNormalCompletion();
                    return;
                }
                pumpPipe(pipe, targetChunks, onDone);
            });
        };

        pumpPipe(stdoutPipe, outChunks, () => { stdoutDone = true; });
        pumpPipe(stderrPipe, errChunks, () => { stderrDone = true; });
    });
}

export async function runShortProbeCommandAsync(argv, extraEnv = {}, maxChars = 8192, options = {}) {
    const res = await runShortProbeCommandWithMetaAsync(argv, extraEnv, maxChars, options);
    return res.output;
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

    const sigParts = prefix.map(p => `${p}@${queryFileSignatureSync(p)}`);
    const envSig = Object.entries(extraEnv || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
    const cacheKey = `${backend}:${sigParts.join('\u0000')}:${envSig}`;
    const legacyKey = `${backend}:${prefix.join('\u0000')}`;
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
    cliCapabilitiesCache.set(legacyKey, parsed);
    return parsed;
}

export async function probeCliCapabilitiesAsync(backend, commandPrefixOrExe, extraEnv = {}, options = {}) {
    const {
        timeoutMs = 1400,
        cancellable = null,
        forceRefresh = false,
        setsidPath = undefined,
    } = options || {};

    const prefix = Array.isArray(commandPrefixOrExe)
        ? commandPrefixOrExe.filter(Boolean)
        : [String(commandPrefixOrExe || '').trim()].filter(Boolean);
    if (!prefix.length) {
        return backend === 'zcode'
            ? parseZCodeHelpCapabilities('', '')
            : parseCodexHelpCapabilities('', '');
    }
    if (cancellable?.is_cancelled?.()) {
        throw new Error('CLI capability probe cancelled');
    }

    const sigs = await Promise.all(prefix.map(p => queryFileSignatureAsync(p, cancellable)));
    if (cancellable?.is_cancelled?.()) {
        throw new Error('CLI capability probe cancelled');
    }
    const sigParts = prefix.map((p, i) => `${p}@${sigs[i]}`);
    const envSig = Object.entries(extraEnv || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
    const cacheKey = `caps:${backend}:${sigParts.join('\u0000')}:${envSig}`;
    const legacyKey = `${backend}:${prefix.join('\u0000')}`;

    return cliCapabilitiesResourceCache.getOrLoadAsync(
        cacheKey,
        async () => {
            if (cancellable?.is_cancelled?.()) {
                throw new Error('CLI capability probe cancelled');
            }
            const verRes = await runShortProbeCommandWithMetaAsync(
                [...prefix, '--version'],
                extraEnv,
                500,
                {timeoutMs, cancellable, setsidPath}
            );
            if (verRes.cancelled || cancellable?.is_cancelled?.()) {
                throw new Error('CLI capability probe cancelled');
            }

            const helpArgs = backend === 'codex' ? [...prefix, 'exec', '--help'] : [...prefix, '--help'];
            let helpRes = await runShortProbeCommandWithMetaAsync(
                helpArgs,
                extraEnv,
                12000,
                {timeoutMs, cancellable, setsidPath}
            );
            if (helpRes.cancelled || cancellable?.is_cancelled?.()) {
                throw new Error('CLI capability probe cancelled');
            }

            if (!helpRes.output && !helpRes.timedOut && backend === 'codex') {
                helpRes = await runShortProbeCommandWithMetaAsync(
                    [...prefix, '--help'],
                    extraEnv,
                    12000,
                    {timeoutMs, cancellable, setsidPath}
                );
                if (helpRes.cancelled || cancellable?.is_cancelled?.()) {
                    throw new Error('CLI capability probe cancelled');
                }
            }

            const parsed = backend === 'zcode'
                ? parseZCodeHelpCapabilities(helpRes.output, verRes.output)
                : parseCodexHelpCapabilities(helpRes.output, verRes.output);
            cliCapabilitiesCache.set(`${backend}:${sigParts.join('\u0000')}:${envSig}`, parsed);
            cliCapabilitiesCache.set(legacyKey, parsed);
            return parsed;
        },
        {forceRefresh}
    );
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
        hasDsh(customDshPath = '') {
            const name = String(customDshPath || '').trim() || 'dsh';
            const candidate = resolveCandidate(name);
            return Boolean(candidate && baseEnv.isExecutable(candidate) &&
                /^(dsh|dsh-cli)$/.test(candidate.split('/').pop()));
        },
    };
}

export function migrateGSettingsIfNeeded(settings) {
    if (!settings) return {migrated: false, migratedFromPi: false, migratedCliIdentity: 'none'};
    const store = createGSettingsStoreAdapter(settings);
    const hasVer = store.hasKey('config-version') && store.getInt('config-version') >= 1;
    if (hasVer) {
        return {migrated: false, migratedFromPi: false, migratedCliIdentity: 'none'};
    }
    const legacyHint = store.hasKey('pi-path') ? store.getString('pi-path') : '';
    const cliEnv = createGioCliEnv(legacyHint);
    return migrateLegacyConfig(store, cliEnv);
}

function makeSelectionCacheKey({
    configuredBackend = 'auto',
    zcodePath = '',
    codexPath = '',
    dshPath = '',
    openaiBaseUrl = '',
} = {}) {
    return `sel:${configuredBackend}\u0000${zcodePath}\u0000${codexPath}\u0000${dshPath}\u0000${openaiBaseUrl}`;
}

export function peekBackendSelection({
    configuredBackend = 'auto',
    zcodePath = '',
    codexPath = '',
    dshPath = '',
    openaiBaseUrl = '',
} = {}) {
    const cacheKey = makeSelectionCacheKey({configuredBackend, zcodePath, codexPath, dshPath, openaiBaseUrl});
    const cached = cliDetectionCache.peek(cacheKey);
    if (cached.hit && cached.value) {
        return {
            ...cached.value,
            fromCache: true,
            stale: cached.stale,
            detecting: false,
        };
    }
    const mode = ['auto', 'zcode', 'codex', 'dsh', 'openai'].includes(configuredBackend)
        ? configuredBackend
        : 'auto';
    const hasOpenAI = Boolean(String(openaiBaseUrl || '').trim());
    if (mode === 'openai') {
        return {
            configuredBackend: mode,
            effectiveBackend: 'openai',
            available: hasOpenAI,
            reason: hasOpenAI ? '' : '正在检测…',
            fromCache: false,
            stale: true,
            detecting: !hasOpenAI,
        };
    }
    if (mode === 'zcode' || mode === 'codex' || mode === 'dsh') {
        return {
            configuredBackend: mode,
            effectiveBackend: mode,
            available: true,
            reason: '正在检测…',
            fromCache: false,
            stale: true,
            detecting: true,
        };
    }
    return {
        configuredBackend: 'auto',
        effectiveBackend: hasOpenAI ? 'openai' : 'zcode',
        available: true,
        reason: '正在检测…',
        fromCache: false,
        stale: true,
        detecting: true,
    };
}

export function peekEffectiveBackend(configuredBackend = 'auto', options = {}) {
    const selectionOpts = typeof configuredBackend === 'object' && configuredBackend !== null
        ? configuredBackend
        : {
            configuredBackend,
            zcodePath: options?.zcodePath || '',
            codexPath: options?.codexPath || '',
            dshPath: options?.dshPath || '',
            openaiBaseUrl: options?.openaiBaseUrl || '',
        };
    return peekBackendSelection(selectionOpts).effectiveBackend;
}

export function detectBackendSelection({
    configuredBackend = 'auto',
    zcodePath = '',
    codexPath = '',
    dshPath = '',
    openaiBaseUrl = '',
} = {}) {
    const cacheKey = makeSelectionCacheKey({configuredBackend, zcodePath, codexPath, dshPath, openaiBaseUrl});
    const cached = cliDetectionCache.peek(cacheKey);
    if (cached.hit && !cached.stale && cached.value) {
        return {...cached.value};
    }
    const extra = zcodePath || codexPath || dshPath || '';
    const cliEnv = createGioCliEnv(extra);
    const resolved = resolveBackendSelection(
        {configuredBackend, zcodePath, codexPath, dshPath, openaiBaseUrl},
        cliEnv
    );
    // Synchronous inspection must never seed the async detection cache: a transient
    // miss (CLI not yet discovered, PATH not initialized, probe timeout) could
    // otherwise suppress the authoritative asynchronous discovery for its TTL.
    return {...resolved};
}

/**
 * Verify the exact headless JSONL and permission capabilities used by our DSH
 * adapter. Do not reject a user-provided executable merely because its wrapper
 * filename isn't "dsh", and do not accept a random executable named "dsh".
 * This probe is bounded, cancellable, and never blocks the Shell main loop.
 */
async function probeDshHeadlessCandidateAsync(dshPath = '', {cancellable = null, forceRefresh = false, timeoutMs = 1400} = {}) {
    const dirs = await buildSearchPathAsync(dshPath, {forceRefresh});
    if (cancellable?.is_cancelled?.()) throw new Error('Backend detection cancelled');
    const cliEnv = createGioCliEnv(dshPath, dirs);
    const candidate = dshPath ? cliEnv.resolveCandidate(dshPath)
        : findExecutableInDirs('dsh', dirs);
    if (!candidate || !cliEnv.isExecutable(candidate)) return {available: false, executable: ''};

    const probe = await runShortProbeCommandWithMetaAsync(
        [candidate, '--profile', 'headless', '--help'],
        {}, 8192,
        {timeoutMs: Math.max(5000, Number(timeoutMs) || 0), cancellable}
    );
    if (probe.cancelled || cancellable?.is_cancelled?.()) throw new Error('Backend detection cancelled');
    return {available: Boolean(probe.ok && matchesDshHeadlessHelp(probe.output)), executable: candidate};
}

export async function detectBackendSelectionAsync({
    configuredBackend = 'auto',
    zcodePath = '',
    codexPath = '',
    dshPath = '',
    openaiBaseUrl = '',
} = {}, {
    forceRefresh = false,
    cancellable = null,
    timeoutMs = 1400,
} = {}) {
    if (cancellable?.is_cancelled?.()) {
        throw new Error('Backend detection cancelled');
    }
    const cacheKey = makeSelectionCacheKey({configuredBackend, zcodePath, codexPath, dshPath, openaiBaseUrl});
    const resolved = await cliDetectionCache.getOrLoadAsync(
        cacheKey,
        async () => {
            if (cancellable?.is_cancelled?.()) {
                throw new Error('Backend detection cancelled');
            }
            // An explicitly configured HTTP API must never wait for the local
            // ZCode/Codex PATH scan, binary header reads, or CLI --version.
            if (configuredBackend === 'openai') {
                return resolveBackendSelection(
                    {configuredBackend, zcodePath, codexPath, dshPath, openaiBaseUrl},
                    {hasZCode: () => false, hasCodex: () => false, hasDsh: () => false}
                );
            }
            if (configuredBackend === 'dsh') {
                const dsh = await probeDshHeadlessCandidateAsync(dshPath, {
                    cancellable, forceRefresh, timeoutMs,
                });
                return {
                    ...resolveBackendSelection(
                        {configuredBackend, zcodePath, codexPath, dshPath, openaiBaseUrl},
                        {hasDsh: () => dsh.available}
                    ),
                    ...(dsh.available ? {executable: dsh.executable} : {}),
                };
            }
            const extra = configuredBackend === 'zcode' ? zcodePath
                : configuredBackend === 'codex' ? codexPath
                : (zcodePath || codexPath);
            const pathDirs = await buildSearchPathAsync(extra, {forceRefresh});
            if (cancellable?.is_cancelled?.()) {
                throw new Error('Backend detection cancelled');
            }

            const syncEnv = createGioCliEnv(extra, pathDirs);
            const headPreload = new Map();
            const verPreload = new Map();

            const preloadCandidate = async raw => {
                const candidate = syncEnv.resolveCandidate(raw);
                if (!candidate || headPreload.has(candidate)) return;
                const head = await readFileHeadAsync(candidate, 2048, cancellable);
                if (cancellable?.is_cancelled?.()) {
                    throw new Error('Backend detection cancelled');
                }
                headPreload.set(candidate, head);

                if (syncEnv.isExecutable(candidate) && !candidate.endsWith('.cjs')) {
                    const hasClearBrandInHead =
                        /@mariozechner\/pi|pi-coding-agent|\b@zcode\/cli\b|\bzcode\b|@openai\/codex|codex-cli/i.test(head);
                    if (hasClearBrandInHead) {
                        verPreload.set(candidate, '');
                    } else {
                        const verRes = await runShortProbeCommandWithMetaAsync(
                            [candidate, '--version'],
                            {},
                            400,
                            {timeoutMs, cancellable}
                        );
                        if (verRes.cancelled || cancellable?.is_cancelled?.()) {
                            throw new Error('Backend detection cancelled');
                        }
                        verPreload.set(candidate, verRes.output);
                    }
                }
            };

            const rawCandidates = new Set(
                configuredBackend === 'zcode' ? ['zcode']
                    : configuredBackend === 'codex' ? ['codex']
                    : ['zcode', 'codex']
            );
            if (zcodePath && configuredBackend !== 'codex') rawCandidates.add(zcodePath);
            if (codexPath && configuredBackend !== 'zcode') rawCandidates.add(codexPath);

            await Promise.all(Array.from(rawCandidates).map(c => preloadCandidate(c)));
            if (cancellable?.is_cancelled?.()) {
                throw new Error('Backend detection cancelled');
            }

            // R4: Never fall back to synchronous readFileHeadSync or probeCliVersionSync!
            const asyncAwareEnv = {
                ...syncEnv,
                readFileHead: p => (headPreload.has(p) ? headPreload.get(p) : ''),
                probeVersion: p => (verPreload.has(p) ? verPreload.get(p) : ''),
            };
            const selectionEnv = {
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
                };
            // In automatic mode DSH is considered only after ZCode and Codex.
            // The old selection environment omitted hasDsh entirely, so the
            // runtime never chose an installed DSH without manual selection.
            if (configuredBackend === 'auto' &&
                !selectionEnv.hasZCode(zcodePath) &&
                !selectionEnv.hasCodex(codexPath)) {
                const dsh = await probeDshHeadlessCandidateAsync(dshPath, {
                    cancellable, forceRefresh, timeoutMs,
                });
                selectionEnv.hasDsh = () => dsh.available;
                const selected = resolveBackendSelection(
                    {configuredBackend, zcodePath, codexPath, dshPath, openaiBaseUrl},
                    selectionEnv
                );
                return {
                    ...selected,
                    ...(selected.effectiveBackend === 'dsh' ? {executable: dsh.executable} : {}),
                };
            }
            return resolveBackendSelection(
                {configuredBackend, zcodePath, codexPath, dshPath, openaiBaseUrl},
                selectionEnv
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
/**
 * Immediate UI hint only. Do not run synchronous CLI probes in the GNOME Shell
 * main thread. Actual executable availability is confirmed by
 * detectBackendSelectionAsync during connection.
 */
export function detectEffectiveBackend(configuredBackend = 'auto', options = {}) {
    const selectionOpts = typeof configuredBackend === 'object' && configuredBackend !== null
        ? configuredBackend
        : {
            configuredBackend,
            zcodePath: options?.zcodePath || '',
            codexPath: options?.codexPath || '',
            dshPath: options?.dshPath || '',
            openaiBaseUrl: options?.openaiBaseUrl || '',
        };
    return peekBackendSelection(selectionOpts).effectiveBackend;
}

function emptyCatalogSkeleton(effectiveBackend) {
    const labels = {
        zcode: 'ZCode CLI',
        codex: 'Codex CLI',
        dsh: 'DeepSeek Harness',
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
        ...(effectiveBackend === 'dsh'
            ? makeDshModelCatalog()
            : emptyCatalogSkeleton(effectiveBackend)),
        fromCache: false,
        stale: true,
    };
}

/**
 * Asynchronous Gio I/O loader for ZCode / Codex local model catalogs (Stage D4).
 * Strips all secret fields before caching in memory.
 */
export async function loadLocalBackendCatalogAsync(effectiveBackend, {
    forceRefresh = false, dshPath = '', cancellable = null,
} = {}) {
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

            if (effectiveBackend === 'dsh') {
                const pathDirs = await buildSearchPathAsync(dshPath, {forceRefresh});
                const env = createGioCliEnv(dshPath, pathDirs);
                const executable = dshPath ? env.resolveCandidate(dshPath)
                    : findExecutableInDirs('dsh', pathDirs);
                if (!executable || !env.isExecutable(executable)) {
                    return makeDshModelCatalog();
                }
                // DSH headless deliberately exposes no "list models" command.
                // Dump layered config without starting an Agent and retain only
                // validated provider/model ids; the raw YAML may include secrets.
                const probe = await runShortProbeCommandWithMetaAsync(
                    [executable, '--profile', 'headless', '--dump-config'],
                    {}, 96000, {
                        timeoutMs: 8000, maxBytes: 128 * 1024, cancellable,
                    }
                );
                if (probe.cancelled || cancellable?.is_cancelled?.()) {
                    throw new Error('DSH model scan cancelled');
                }
                return sanitizeProviderCatalogSecrets(
                    makeDshModelCatalog(
                        probe.ok ? extractDshConfiguredModel(probe.output) : {}
                    )
                );
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
    } else if (effectiveBackend === 'dsh') {
        result = sanitizeProviderCatalogSecrets(makeDshModelCatalog());
    } else {
        result = sanitizeProviderCatalogSecrets(emptyCatalogSkeleton(effectiveBackend));
    }

    backendCatalogCache.set(key, result);
    return result;
}
