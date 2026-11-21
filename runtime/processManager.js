// Managed CLI Subprocess & Watchdog Runtime for GNOME Shell (Stage E).
// Consolidates isolated `setsid` process groups, graceful SIGTERM -> SIGKILL escalation,
// phase-aware turn & approval watchdogs, `wait_async` exit status collection, post-exit
// 0600 temp-file cleanup, and per-turn bounded stdout/stderr readers.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {findExecutableInDirs} from '../core/backendDetect.js';
import {removeFileQuietly, writeAllBytesAsync} from '../core/paths.js';
import {isMeaningfulProgressEvent} from '../protocol.js';
import {
    BRIDGE_EXPECTED_PROTOCOL_VERSION,
    CliTurnMonitor,
    DEFAULT_BRIDGE_HANDSHAKE_TIMEOUT_MS,
    DEFAULT_KILL_GRACE_MS,
    DEFAULT_PIPE_CHUNK_BYTES,
    DEFAULT_POST_EXIT_PIPE_DRAIN_MS,
    buildProcessGroupKillArgv,
    evaluateSubprocessOutcome,
    isSafeProcessGroupId,
    parseLinuxProcStat,
    wrapArgvWithSetsid,
} from './cliProcessRunner.js';
import {
    redactSensitiveText,
    resolveSplitTimeouts,
} from './sseParser.js';

const Encoder = new TextEncoder();
const Decoder = new TextDecoder('utf-8', {fatal: false});

export function readProcStatSync(pidOrSelf = 'self') {
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

export function getSelfProcessIdentity() {
    const selfStat = readProcStatSync('self');
    return {
        selfPid: selfStat?.pid || 0,
        selfPgid: selfStat?.pgrp || 0,
    };
}

export function isProcessGroupReused(pgid, recordedLeaderStartTime = '') {
    if (!Number.isInteger(pgid) || pgid <= 1) return true;
    const currentStat = readProcStatSync(pgid);
    if (!currentStat) return false;
    if (recordedLeaderStartTime && currentStat.startTime && currentStat.startTime !== String(recordedLeaderStartTime)) {
        return true;
    }
    const selfIdentity = getSelfProcessIdentity();
    if (
        pgid !== selfIdentity.selfPid &&
        pgid !== selfIdentity.selfPgid &&
        currentStat.pgrp &&
        currentStat.pgrp === selfIdentity.selfPgid
    ) {
        return true;
    }
    return false;
}

export function resolveKillExecutable() {
    if (GLib.file_test('/bin/kill', GLib.FileTest.IS_EXECUTABLE)) return '/bin/kill';
    if (GLib.file_test('/usr/bin/kill', GLib.FileTest.IS_EXECUTABLE)) return '/usr/bin/kill';
    return '';
}

export function resolveSetsidExecutable(pathDirs = []) {
    if (GLib.file_test('/usr/bin/setsid', GLib.FileTest.IS_EXECUTABLE)) return '/usr/bin/setsid';
    if (GLib.file_test('/bin/setsid', GLib.FileTest.IS_EXECUTABLE)) return '/bin/setsid';
    return findExecutableInDirs('setsid', pathDirs) || '';
}

export function signalIsolatedProcessGroup(pgid, signalName, killBin, onComplete = null) {
    const selfIdentity = getSelfProcessIdentity();
    if (!killBin || !isSafeProcessGroupId(pgid, selfIdentity)) {
        onComplete?.({started: false, ok: false, exitStatus: -1});
        return false;
    }
    try {
        const argv = buildProcessGroupKillArgv(pgid, signalName, killBin);
        const killer = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        killer.wait_async(null, (p, res) => {
            let ok = false;
            let exitStatus = -1;
            try {
                p.wait_finish(res);
                if (p.get_if_exited?.()) {
                    exitStatus = p.get_exit_status();
                    ok = exitStatus === 0;
                } else if (p.get_successful?.()) {
                    exitStatus = 0;
                    ok = true;
                }
            } catch (_) {}
            onComplete?.({started: true, ok, exitStatus});
        });
        return true;
    } catch (_) {
        onComplete?.({started: false, ok: false, exitStatus: -1});
        return false;
    }
}

export function signalIsolatedProcessGroupAsync(pgid, signalName, killBin) {
    return new Promise(resolve => {
        signalIsolatedProcessGroup(pgid, signalName, killBin, result => resolve(result));
    });
}

/**
 * Terminates a CLI subprocess and its isolated `setsid` process group cleanly:
 * sends SIGTERM first, gives `graceMs` (default 800ms) for clean exit,
 * and escalates to SIGKILL within the child's isolated process group even if
 * the leader process exited early on SIGTERM while a child process ignored SIGTERM.
 */
export function terminateProcessTreeGracefully(
    proc,
    {
        pgid = 0,
        isolatedProcessGroup = false,
        leaderStartTime = '',
        graceMs = DEFAULT_KILL_GRACE_MS,
        onComplete = null,
    } = {}
) {
    if (!proc && !pgid) {
        onComplete?.({termSent: false, killSent: false});
        return;
    }
    const selfIdentity = getSelfProcessIdentity();
    const killBin = isolatedProcessGroup ? resolveKillExecutable() : '';
    const canKillGroup = Boolean(
        isolatedProcessGroup &&
        killBin &&
        isSafeProcessGroupId(pgid, selfIdentity) &&
        !isProcessGroupReused(pgid, leaderStartTime)
    );

    let leaderExited = Boolean(proc?.get_if_exited?.() || proc?.get_if_signaled?.());
    if (proc && !leaderExited) {
        try {
            proc.wait_async(null, (p, res) => {
                leaderExited = true;
                try { p.wait_finish(res); } catch (_) {}
            });
        } catch (_) {}
    }

    if (canKillGroup) {
        signalIsolatedProcessGroup(pgid, 'TERM', killBin);
    }
    if (proc && !leaderExited) {
        try {
            proc.send_signal(15); // SIGTERM
        } catch (_) {
            if (canKillGroup && !isProcessGroupReused(pgid, leaderStartTime)) {
                signalIsolatedProcessGroup(pgid, 'KILL', killBin, r => {
                    onComplete?.({termSent: true, killSent: true, killResult: r});
                });
            } else {
                onComplete?.({termSent: false, killSent: false});
            }
            try { proc.force_exit(); } catch (__) {}
            return;
        }
    }

    const effectiveGraceMs = Math.max(20, Number(graceMs) || DEFAULT_KILL_GRACE_MS);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, effectiveGraceMs, () => {
        // R2: Do NOT rely solely on `!leaderExited` to decide whether to send group SIGKILL!
        // A leader may exit immediately on SIGTERM while its child traps/ignores SIGTERM.
        // `/bin/kill -s KILL -- -<pgid>` atomically kills any remaining members (exit 0)
        // or returns non-zero (ESRCH) if the group is already empty.
        if (canKillGroup && !isProcessGroupReused(pgid, leaderStartTime)) {
            signalIsolatedProcessGroup(pgid, 'KILL', killBin, killRes => {
                onComplete?.({
                    termSent: true,
                    killSent: true,
                    hadRemainingMembers: killRes.ok,
                    killResult: killRes,
                });
            });
        } else {
            onComplete?.({termSent: true, killSent: false, hadRemainingMembers: false});
        }
        if (proc && !leaderExited) {
            try { proc.force_exit(); } catch (_) {}
        }
        return GLib.SOURCE_REMOVE;
    });
}

export function terminateTurnProcess(turn, proc, opts = {}) {
    if (turn?.terminationInitiated && !opts.force) {
        return;
    }
    if (turn) {
        turn.terminationInitiated = true;
    }
    terminateProcessTreeGracefully(proc || turn?.process, {
        pgid: turn?.processGroupId || 0,
        isolatedProcessGroup: Boolean(turn?.isolatedProcessGroup),
        leaderStartTime: turn?.leaderStartTime || '',
        graceMs: opts.graceMs ?? turn?.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
        onComplete: opts.onComplete || null,
    });
}

export function buildXdgEnvVars(specialDirs = {}) {
    const d = specialDirs || {};
    const env = {};
    if (d.home) env.HOME = d.home;
    if (d.desktop) env.XDG_DESKTOP_DIR = d.desktop;
    if (d.downloads) env.XDG_DOWNLOAD_DIR = d.downloads;
    if (d.documents) env.XDG_DOCUMENTS_DIR = d.documents;
    if (d.pictures) env.XDG_PICTURES_DIR = d.pictures;
    if (d.music) env.XDG_MUSIC_DIR = d.music;
    if (d.videos) env.XDG_VIDEOS_DIR = d.videos;
    return env;
}

/**
 * Phase-aware watchdog supporting separated connect / first-byte / stream-idle / tool-execution
 * timeouts plus an independent total turn ceiling (R7).
 */
export function attachTurnWatchdog({
    turns,
    turn,
    backend,
    store,
    getSessionContextConfig,
    initialTimeoutSec,
    initialMessage,
    totalTurnTimeoutSec = 0,
    initialPhase = 'stream_idle',
}) {
    let phaseTimerId = 0;
    let totalTimerId = 0;
    let currentTimeoutSec = Math.max(1, Number(initialTimeoutSec) || 60);
    let currentMessage = String(initialMessage || '请求响应超时');
    let currentPhaseName = String(initialPhase || 'stream_idle');
    turn.totalTurnTimeoutSec = totalTurnTimeoutSec > 0 ? Number(totalTurnTimeoutSec) : 0;

    const clearPhase = () => {
        if (phaseTimerId) {
            try { GLib.source_remove(phaseTimerId); } catch (_) {}
            phaseTimerId = 0;
        }
    };
    const clearAll = () => {
        clearPhase();
        if (totalTimerId) {
            try { GLib.source_remove(totalTimerId); } catch (_) {}
            totalTimerId = 0;
        }
    };

    const fireTimeout = (msgText, timedOutPhase = '') => {
        clearAll();
        if (turns.isCurrent(turn)) {
            turn.timedOut = true;
            turn.timedOutPhase = String(timedOutPhase || currentPhaseName || 'stream_idle');
            turn.watchdogPhase = 'settled';
            try { turn.cancellable?.cancel?.(); } catch (_) {}
            const ctxCfg = getSessionContextConfig();
            turns.finalizeTurn(turn, {
                status: 'timed_out',
                timedOut: true,
                aborted: false,
                errorText: msgText,
                onPersistAssistant: msg => store?.appendMessage(msg, backend, ctxCfg),
                onTerminateProcess: proc => terminateTurnProcess(turn, proc),
                onCleanupTempFiles: files => files.forEach(removeFileQuietly),
            });
            store?.clearRemoteSessionId('turn_timed_out');
        }
    };

    const isWaitingApproval = () => Boolean(
        turn.state === 'awaiting_approval' ||
        (turn.pendingApprovals && turn.pendingApprovals.size > 0)
    );

    const reset = () => {
        clearPhase();
        if (!turns.isCurrent(turn)) return;
        if (isWaitingApproval()) {
            turn.watchdogPhase = 'approval_wait';
            return;
        }
        turn.watchdogPhase = currentPhaseName;
        turn.activeTimeoutSec = currentTimeoutSec;
        phaseTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, currentTimeoutSec, () => {
            phaseTimerId = 0;
            fireTimeout(currentMessage, currentPhaseName);
            return GLib.SOURCE_REMOVE;
        });
    };

    const pauseWatchdog = () => {
        clearPhase();
        if (isWaitingApproval()) {
            turn.watchdogPhase = 'approval_wait';
        }
    };

    const setWatchdogPhase = (nextTimeoutSec, nextMessage, nextPhaseName = '') => {
        currentTimeoutSec = Math.max(1, Number(nextTimeoutSec) || currentTimeoutSec);
        if (nextMessage) currentMessage = String(nextMessage);
        if (nextPhaseName) currentPhaseName = String(nextPhaseName);
        if (!isWaitingApproval()) {
            reset();
        } else {
            clearPhase();
            turn.watchdogPhase = 'approval_wait';
        }
    };

    if (totalTurnTimeoutSec > 0) {
        totalTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, totalTurnTimeoutSec, () => {
            totalTimerId = 0;
            fireTimeout(`单轮任务总时长超出安全上限（${totalTurnTimeoutSec}s）`, 'total_turn');
            return GLib.SOURCE_REMOVE;
        });
    }

    turn.pauseWatchdog = pauseWatchdog;
    turn.resetWatchdog = reset;
    turn.setWatchdogPhase = setWatchdogPhase;
    turn.cleanupWatchdog = clearAll;
    reset();
}

export function attachApprovalWatchdog({
    turns,
    turn,
    backend,
    store,
    getSessionContextConfig,
    timeoutSec = 300,
}) {
    let approvalTimerId = 0;
    const clearApproval = () => {
        if (approvalTimerId) {
            try { GLib.source_remove(approvalTimerId); } catch (_) {}
            approvalTimerId = 0;
        }
    };
    const startApproval = () => {
        clearApproval();
        if (!turns.isCurrent(turn) || timeoutSec <= 0) return;
        turn.watchdogPhase = 'approval_wait';
        turn.activeTimeoutSec = timeoutSec;
        approvalTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSec, () => {
            approvalTimerId = 0;
            if (turns.isCurrent(turn)) {
                turn.timedOut = true;
                turn.timedOutPhase = 'approval_wait';
                turn.watchdogPhase = 'settled';
                try { turn.cancellable?.cancel?.(); } catch (_) {}
                const ctxCfg = getSessionContextConfig();
                turns.finalizeTurn(turn, {
                    status: 'timed_out',
                    timedOut: true,
                    aborted: false,
                    errorText: `等待工具审批超时（${timeoutSec}s），已安全拒绝并终止本轮任务`,
                    onPersistAssistant: msg => store?.appendMessage(msg, backend, ctxCfg),
                    onTerminateProcess: proc => terminateTurnProcess(turn, proc),
                    onCleanupTempFiles: files => files.forEach(removeFileQuietly),
                });
                store?.clearRemoteSessionId('approval_timed_out');
            }
            return GLib.SOURCE_REMOVE;
        });
    };
    turn.startApprovalWatchdog = startApproval;
    turn.clearApprovalWatchdog = clearApproval;
}

/**
 * Spawns and monitors a single-turn CLI subprocess (ZCode or Codex) with isolated process group,
 * bounded stdout/stderr readers, bridge handshake verification, and post-exit temp cleanup.
 */
export function spawnManagedCliTurn({
    backend,
    runtime = {},
    config = {},
    workspace,
    sessionId,
    specialDirs = {},
    turns,
    turn,
    store = null,
    approvedScopes = null,
    getSessionContextConfig = () => ({}),
    isDisposedFn = () => false,
    rawArgv,
    turnExtraEnv = {},
    stdinPromptText = '',
    keepStdinOpenForApproval = false,
    requireBridgeHandshake = false,
    remoteId = '',
    modeNotice = '',
    effectiveMode = 'readonly',
    timeouts = null,
    streamLimits = null,
    conversationTransport = null,
}) {
    const launcher = new Gio.SubprocessLauncher({
        flags:
            Gio.SubprocessFlags.STDIN_PIPE |
            Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE,
    });
    launcher.set_cwd(workspace);
    launcher.setenv('PATH', runtime.pathEnv ?? (GLib.getenv('PATH') || ''), true);
    launcher.setenv('NO_COLOR', '1', true);

    const envMap = {
        ...buildXdgEnvVars(specialDirs),
        ...(runtime.extraEnv || {}),
        ...turnExtraEnv,
        QUICK_CHAT_SESSION_ID: String(sessionId || ''),
        QUICK_CHAT_TURN_ID: String(turn.id || ''),
        QUICK_CHAT_WORKSPACE: String(workspace || ''),
        ...(backend === 'zcode' && (requireBridgeHandshake || runtime?.bridgePath)
            ? {
                QUICK_CHAT_FORCE_BRIDGE: '1',
            }
            : {}),
        ...(requireBridgeHandshake
            ? {
                QUICK_CHAT_REQUIRE_BRIDGE: '1',
                QUICK_CHAT_BRIDGE_PROTOCOL: String(BRIDGE_EXPECTED_PROTOCOL_VERSION),
            }
            : {}),
    };
    if (
        backend === 'zcode' &&
        runtime?.bridgePath &&
        !String(runtime.bridgePath).includes('"') &&
        !rawArgv.includes(runtime.bridgePath) &&
        !String(envMap.NODE_OPTIONS || '').includes(runtime.bridgePath)
    ) {
        const existingNodeOpts = String(envMap.NODE_OPTIONS || GLib.getenv('NODE_OPTIONS') || '').trim();
        envMap.NODE_OPTIONS = `${existingNodeOpts} --require "${runtime.bridgePath}"`.trim();
    }
    for (const [k, v] of Object.entries(envMap)) {
        launcher.setenv(k, String(v), true);
    }

    const effectiveSetsidPath = runtime.setsidPath !== undefined
        ? runtime.setsidPath
        : resolveSetsidExecutable();
    const wrappedSpawn = wrapArgvWithSetsid(rawArgv, effectiveSetsidPath);
    const turnTempFiles = [...turn.tempFiles];

    let proc;
    try {
        proc = launcher.spawnv(wrappedSpawn.argv);
        turn.process = proc;
        const rawPid = Number.parseInt(proc.get_identifier?.() || '', 10) || 0;
        const selfIdentity = getSelfProcessIdentity();
        const statAfterSpawn = rawPid > 1 ? readProcStatSync(rawPid) : null;
        const verifiedIsolatedGroup = Boolean(
            wrappedSpawn.isolatedProcessGroup &&
            isSafeProcessGroupId(rawPid, selfIdentity)
        );
        turn.isolatedProcessGroup = verifiedIsolatedGroup;
        turn.processGroupId = verifiedIsolatedGroup ? rawPid : 0;
        turn.leaderStartTime = statAfterSpawn?.startTime || '';
    } catch (spawnErr) {
        store?.clearRemoteSessionId('spawn_failed');
        turns.finalizeTurn(turn, {
            status: 'failed',
            errorText: spawnErr.message,
            onCleanupTempFiles: files => files.forEach(removeFileQuietly),
        });
        return Promise.reject(spawnErr);
    }

    const stdinPipe = proc.get_stdin_pipe();
    if (keepStdinOpenForApproval || conversationTransport) {
        turn.stdin = stdinPipe;
    } else if (stdinPromptText && stdinPipe) {
        const promptBytes = Encoder.encode(stdinPromptText);
        writeAllBytesAsync(stdinPipe, promptBytes, GLib.PRIORITY_DEFAULT, turn.cancellable)
            .catch(writeErr => {
                if (turns.isCurrent(turn) && !turn.aborted) {
                    turn.error = `向 CLI 写入提问内容失败：${writeErr.message}`;
                }
            })
            .finally(() => {
                try {
                    stdinPipe.close_async(GLib.PRIORITY_DEFAULT, null, (st, cr) => {
                        try { st.close_finish(cr); } catch (_) {}
                    });
                } catch (_) {}
            });
    } else if (stdinPipe) {
        try { stdinPipe.close(null); } catch (_) {}
    }

    const stdoutStream = proc.get_stdout_pipe();
    const stderrStream = proc.get_stderr_pipe();

    const monitor = new CliTurnMonitor({
        turnId: turn.id,
        backend,
        requireBridgeHandshake,
        limits: streamLimits || {},
        decodeRecord: conversationTransport ? frame => conversationTransport.read(frame) : null,
    });
    const pipeChunkBytes = Math.max(
        1024,
        Math.min(
            DEFAULT_PIPE_CHUNK_BYTES,
            Number(monitor.limits?.maxLineBytes || DEFAULT_PIPE_CHUNK_BYTES)
        )
    );

    let handshakeTimerId = 0;
    const clearHandshakeTimer = () => {
        if (handshakeTimerId) {
            try { GLib.source_remove(handshakeTimerId); } catch (_) {}
            handshakeTimerId = 0;
        }
    };

    let postExitDrainTimerId = 0;
    const clearPostExitDrainTimer = () => {
        if (postExitDrainTimerId) {
            try { GLib.source_remove(postExitDrainTimerId); } catch (_) {}
            postExitDrainTimerId = 0;
        }
    };

    let stdoutDone = !stdoutStream;
    let stderrDone = !stderrStream;
    let processExited = false;
    let leakedChildPipeDetected = false;
    let exitCode = null;
    let termSignal = null;
    let streamsClosed = false;

    const closeIoPipes = () => {
        if (streamsClosed) return;
        streamsClosed = true;
        if (stdoutStream) {
            try { stdoutStream.close_async(GLib.PRIORITY_DEFAULT, null, (s, r) => { try { s.close_finish(r); } catch (_) {} }); } catch (_) {}
        }
        if (stderrStream) {
            try { stderrStream.close_async(GLib.PRIORITY_DEFAULT, null, (s, r) => { try { s.close_finish(r); } catch (_) {} }); } catch (_) {}
        }
        if (turn.stdin) {
            const st = turn.stdin;
            turn.stdin = null;
            try { st.close_async(GLib.PRIORITY_DEFAULT, null, (s, r) => { try { s.close_finish(r); } catch (_) {} }); } catch (_) {}
        }
    };

    const cleanupAllTurnAsyncResources = () => {
        clearHandshakeTimer();
        clearPostExitDrainTimer();
        closeIoPipes();
    };

    const abortTurnForFatalMonitorError = () => {
        cleanupAllTurnAsyncResources();
        if (!turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
            return;
        }
        const persistCfg = getSessionContextConfig();
        turns.finalizeTurn(turn, {
            status: 'failed',
            errorText: redactSensitiveText(monitor.fatalError || 'CLI 安全校验未通过'),
            onPersistAssistant: m => store?.appendMessage(m, backend, persistCfg),
            onTerminateProcess: p => terminateTurnProcess(turn, p),
            onCleanupTempFiles: files => files.forEach(removeFileQuietly),
        });
        store?.clearRemoteSessionId('fatal_monitor_error');
    };

    const trySettleWhenComplete = () => {
        if (!stdoutDone || !stderrDone || !processExited) return;
        cleanupAllTurnAsyncResources();

        if (!turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
            return;
        }

        if (requireBridgeHandshake && monitor.isHandshakePending) {
            monitor.markHandshakeTimedOut();
        }

        const outcome = evaluateSubprocessOutcome({
            exitCode,
            termSignal,
            sawDoneMarker: turn.sawDoneMarker,
            turnError: turn.error,
            fatalError: monitor.fatalError,
            aborted: turn.aborted,
            timedOut: turn.timedOut,
            stderrSummary: monitor.getStderrSummary(),
        });

        let finalErrorMessage = redactSensitiveText(outcome.errorMessage || '', {maxChars: 280});
        if (remoteId && outcome.status !== 'completed' && !turn.aborted && !turn.timedOut && !turn.text) {
            store?.clearRemoteSessionId('remote_resume_failed');
            finalErrorMessage = finalErrorMessage
                ? `远端会话恢复失败（已重置为本地上下文，请重试）：${finalErrorMessage}`
                : '远端会话恢复失败，已自动切换为本地历史上下文，请重新发送当前问题';
        }

        // R2: Separate normal clean exit from forced termination so normal completion
        // does not send SIGTERM/SIGKILL to an already-exited or reused PGID.
        const isCleanNormalCompletion =
            outcome.status === 'completed' &&
            !leakedChildPipeDetected &&
            !turn.aborted &&
            !turn.timedOut &&
            !monitor.fatalError;

        const persistCfg = getSessionContextConfig();
        turns.finalizeTurn(turn, {
            status: outcome.status,
            aborted: outcome.aborted,
            timedOut: outcome.timedOut,
            interrupted: outcome.interrupted,
            errorText: finalErrorMessage,
            onPersistAssistant: m => store?.appendMessage(m, backend, persistCfg),
            onTerminateProcess: isCleanNormalCompletion ? null : (p => terminateTurnProcess(turn, p)),
            onCleanupTempFiles: files => files.forEach(removeFileQuietly),
            onBeforeSettle: finalStatus => {
                // R3: Advance remoteSyncedRevision ONLY when the backend protocol confirms clean completion!
                if (finalStatus === 'completed') {
                    const confirmedRemoteId = conversationTransport
                        ? '' : (turn.boundRemoteSessionId || store?.remoteSessionId || remoteId);
                    if (confirmedRemoteId) {
                        store?.confirmRemoteTurnSynced?.(confirmedRemoteId, backend, persistCfg);
                    }
                } else {
                    store?.clearRemoteSessionId(`turn_${finalStatus || 'incomplete'}`);
                }
            },
        });
    };

    const handshakeTimeoutMs = Number(timeouts?.bridgeHandshakeTimeoutMs) > 0
        ? Number(timeouts.bridgeHandshakeTimeoutMs)
        : DEFAULT_BRIDGE_HANDSHAKE_TIMEOUT_MS;
    if (requireBridgeHandshake) {
        handshakeTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            handshakeTimeoutMs,
            () => {
                handshakeTimerId = 0;
                if (monitor.markHandshakeTimedOut()) {
                    abortTurnForFatalMonitorError();
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    const postExitDrainMs = Number(timeouts?.postExitDrainMs) > 0
        ? Number(timeouts.postExitDrainMs)
        : DEFAULT_POST_EXIT_PIPE_DRAIN_MS;

    proc.wait_async(null, (p, res) => {
        try {
            p.wait_finish(res);
            if (p.get_if_exited()) exitCode = p.get_exit_status();
            if (p.get_if_signaled()) termSignal = p.get_term_sig();
        } catch (_) {}

        for (const f of turnTempFiles) {
            removeFileQuietly(f);
        }
        turn.tempFiles = [];

        processExited = true;
        if (!stdoutDone || !stderrDone) {
            clearPostExitDrainTimer();
            postExitDrainTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, postExitDrainMs, () => {
                postExitDrainTimerId = 0;
                if (!stdoutDone || !stderrDone) {
                    leakedChildPipeDetected = true;
                    stdoutDone = true;
                    stderrDone = true;
                    closeIoPipes();
                    terminateTurnProcess(turn, proc);
                    trySettleWhenComplete();
                }
                return GLib.SOURCE_REMOVE;
            });
        }
        trySettleWhenComplete();
    });

    const readStderrLoop = () => {
        if (!stderrStream || isDisposedFn() || turn.aborted || turn.timedOut) {
            stderrDone = true;
            trySettleWhenComplete();
            return;
        }
        stderrStream.read_bytes_async(pipeChunkBytes, GLib.PRIORITY_DEFAULT, turn.cancellable, (src, res) => {
            let gbytes = null;
            try {
                gbytes = src.read_bytes_finish(res);
            } catch (_) {
                stderrDone = true;
                trySettleWhenComplete();
                return;
            }
            if (isDisposedFn() || turn.aborted || turn.timedOut) {
                stderrDone = true;
                trySettleWhenComplete();
                return;
            }
            const chunk = gbytes ? gbytes.get_data() : null;
            if (!chunk || chunk.byteLength === 0) {
                if (turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
                    monitor.flushStderr(turn.id);
                }
                stderrDone = true;
                trySettleWhenComplete();
                return;
            }
            if (turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
                monitor.pushStderrChunk(turn.id, chunk);
            }
            readStderrLoop();
        });
    };

    const resolvedTimeouts = timeouts || resolveSplitTimeouts(config);
    turns.markStreaming(turn);
    attachTurnWatchdog({
        turns,
        turn,
        backend,
        store,
        getSessionContextConfig,
        initialTimeoutSec: resolvedTimeouts.streamIdleTimeoutSec,
        initialMessage: `CLI 响应空闲超时（${resolvedTimeouts.streamIdleTimeoutSec}s 无输出）`,
        totalTurnTimeoutSec: resolvedTimeouts.totalTurnTimeoutSec,
        initialPhase: 'stream_idle',
    });
    attachApprovalWatchdog({
        turns,
        turn,
        backend,
        store,
        getSessionContextConfig,
        timeoutSec: Number(config?.approvalTimeoutSec) > 0
            ? Number(config.approvalTimeoutSec)
            : resolvedTimeouts.approvalTimeoutSec,
    });

    if (modeNotice) {
        turns.emitForTurn(turn, {
            type: 'mode_notice',
            effectiveMode,
            message: modeNotice,
        });
    }

    const seenPermissionIds = new Set();
    const syncCliToolTimeoutPhase = () => {
        const activeCount = turn.activeToolIds instanceof Set ? turn.activeToolIds.size : 0;
        if (activeCount > 0) {
            turn.setWatchdogPhase?.(
                resolvedTimeouts.toolExecutionTimeoutSec,
                `工具执行超时（${resolvedTimeouts.toolExecutionTimeoutSec}s 无状态更新）`,
                'tool_execution'
            );
        } else {
            turn.setWatchdogPhase?.(
                resolvedTimeouts.streamIdleTimeoutSec,
                `CLI 响应空闲超时（${resolvedTimeouts.streamIdleTimeoutSec}s 无输出）`,
                'stream_idle'
            );
        }
    };

    const applyCheckedStdoutResults = results => {
        for (const checked of results) {
            if (checked.fatalError) {
                abortTurnForFatalMonitorError();
                return false;
            }
            if (monitor.isHandshakeVerified) {
                clearHandshakeTimer();
            }

            const norm = checked.normalized;
            if (!norm) continue;

            // R7: Only meaningful semantic progress events extend the phase watchdog;
            // ordinary logs, pings, heartbeats, or empty lines do not extend it.
            // Moreover, while any approval is pending, the phase watchdog stays paused in approval_wait.
            if (
                isMeaningfulProgressEvent(norm) &&
                norm.type !== 'permission_request' &&
                norm.type !== 'permission_resolved' &&
                norm.type !== 'tool_execution_start' &&
                norm.type !== 'tool_execution_update' &&
                norm.type !== 'tool_execution_end' &&
                norm.type !== 'tool_batch_end'
            ) {
                turn.resetWatchdog?.();
            }

            const segCfg = getSessionContextConfig();
            if (norm.type === 'bridge_ready') {
                turns.emitForTurn(turn, norm);
            } else if (norm.type === 'permission_request') {
                if (norm.requestId && !seenPermissionIds.has(norm.requestId)) {
                    seenPermissionIds.add(norm.requestId);
                    turns.enterApproval(turn, norm.requestId, norm);
                    turns.emitForTurn(turn, norm);
                }
            } else if (norm.type === 'permission_resolved') {
                if (norm.requestId) {
                    if (typeof turns.resolveApprovalFromBridge === 'function') {
                        turns.resolveApprovalFromBridge(turn, norm, {approvedScopes});
                    } else {
                        turns.leaveApproval(turn, norm.requestId);
                    }
                    syncCliToolTimeoutPhase();
                }
                turns.emitForTurn(turn, norm);
            } else if (norm.type === 'permission_response_rejected') {
                if (norm.requestId && typeof turns.rejectApprovalResponseFromBridge === 'function') {
                    turns.rejectApprovalResponseFromBridge(turn, norm);
                }
                turns.emitForTurn(turn, norm);
            } else if (norm.type === 'tool_execution_start') {
                turns.recordToolStart?.(turn, norm);
                syncCliToolTimeoutPhase();
                turns.emitForTurn(turn, norm);
            } else if (norm.type === 'tool_execution_update') {
                turns.recordToolUpdate?.(turn, norm);
                syncCliToolTimeoutPhase();
                turns.emitForTurn(turn, norm);
            } else if (norm.type === 'tool_execution_end') {
                turns.recordToolEnd?.(turn, norm);
                syncCliToolTimeoutPhase();
                turns.emitForTurn(turn, norm);
            } else if (norm.type === 'tool_batch_end') {
                turns.recordToolBatchEnd?.(turn, norm);
                syncCliToolTimeoutPhase();
                turns.emitForTurn(turn, norm);
            } else if (norm.type === 'session_bound' && norm.sessionId) {
                turn.boundRemoteSessionId = norm.sessionId;
                store?.setRemoteSessionId(norm.sessionId, backend, segCfg, {markSynced: false});
            } else if (norm.type === 'turn_completed') {
                turn.sawDoneMarker = true;
            } else if (norm.type === 'turn_result') {
                if (norm.sessionId) {
                    turn.boundRemoteSessionId = norm.sessionId;
                    store?.setRemoteSessionId(norm.sessionId, backend, segCfg, {markSynced: false});
                }
                if (norm.isError) {
                    turn.error = norm.errorMessage || `${backend.toUpperCase()} 执行返回错误`;
                } else {
                    turn.sawDoneMarker = true;
                    if (norm.authoritative || (norm.text && !turn.text)) {
                        // DSH final carries the lossless committed answer and may correct
                        // text previously emitted as bounded JSON events.
                        turns.replaceText(turn, norm.text || '', norm.segmentId || '');
                    }
                }
            } else if (norm.type === 'text_snapshot') {
                turns.replaceText(turn, norm.text, norm.segmentId || '');
            } else if (norm.type === 'thinking_snapshot') {
                turns.replaceThinking(turn, norm.text, norm.segmentId || '');
            } else if (norm.type === 'message_update') {
                if (norm.sessionId) {
                    turn.boundRemoteSessionId = norm.sessionId;
                    store?.setRemoteSessionId(norm.sessionId, backend, segCfg, {markSynced: false});
                }
                const ev = norm.assistantMessageEvent;
                if (ev?.type === 'text_delta') {
                    turns.appendText(turn, ev.delta || '', norm.segmentId || '');
                } else if (ev?.type === 'thinking_delta') {
                    turns.appendThinking(turn, ev.delta || '', norm.segmentId || '');
                } else {
                    turns.emitForTurn(turn, norm);
                }
            } else if (norm.type === 'message_end' && norm.message) {
                if (norm.sessionId) {
                    turn.boundRemoteSessionId = norm.sessionId;
                    store?.setRemoteSessionId(norm.sessionId, backend, segCfg, {markSynced: false});
                }
                if (typeof norm.message.content === 'string' && norm.message.content) {
                    turns.replaceText(turn, norm.message.content, norm.segmentId || norm.message.id || '');
                }
                if (norm.message.errorMessage) {
                    turn.error = norm.message.errorMessage;
                }
            } else {
                if (norm.sessionId) {
                    turn.boundRemoteSessionId = norm.sessionId;
                    store?.setRemoteSessionId(norm.sessionId, backend, segCfg, {markSynced: false});
                }
                if (norm.type === 'message_start' && norm.modelId) {
                    turn.modelId = norm.modelId;
                }
                turns.emitForTurn(turn, norm);
            }
        }
        return true;
    };

    const readStdoutLoop = () => {
        if (!stdoutStream || isDisposedFn() || !turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
            stdoutDone = true;
            trySettleWhenComplete();
            return;
        }
        stdoutStream.read_bytes_async(pipeChunkBytes, GLib.PRIORITY_DEFAULT, turn.cancellable, (stream, res) => {
            let gbytes = null;
            let readErr = null;
            try {
                gbytes = stream.read_bytes_finish(res);
            } catch (err) {
                readErr = err;
            }
            if (isDisposedFn() || !turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
                stdoutDone = true;
                trySettleWhenComplete();
                return;
            }
            if (readErr) {
                stdoutDone = true;
                if (!turn.aborted && !turn.timedOut && !turn.error && !leakedChildPipeDetected) {
                    turn.error = readErr.message;
                }
                trySettleWhenComplete();
                return;
            }
            try {
                const chunk = gbytes ? gbytes.get_data() : null;
                if (!chunk || chunk.byteLength === 0) {
                    const flushed = monitor.flushStdout(turn.id);
                    if (flushed.results.length > 0) {
                        if (!applyCheckedStdoutResults(flushed.results)) {
                            return;
                        }
                    }
                    if (flushed.fatalError) {
                        abortTurnForFatalMonitorError();
                        return;
                    }
                    stdoutDone = true;
                    trySettleWhenComplete();
                    return;
                }

                const chunkRes = monitor.pushStdoutChunk(turn.id, chunk);
                if (chunkRes.results.length > 0) {
                    if (!applyCheckedStdoutResults(chunkRes.results)) {
                        return;
                    }
                }
                if (chunkRes.fatalError) {
                    abortTurnForFatalMonitorError();
                    return;
                }
                readStdoutLoop();
            } catch (err) {
                if (turn.aborted || turn.timedOut) return;
                monitor.fatalError = err.message;
                abortTurnForFatalMonitorError();
            }
        });
    };

    if (conversationTransport) {
        let chain = Promise.resolve();
        const send = frame => {
            const write = chain.then(() => {
                if (!turns.isCurrent(turn) || !turn.stdin) throw new Error('后端交互已结束');
                return writeAllBytesAsync(turn.stdin, Encoder.encode(JSON.stringify(frame) + '\n'),
                    GLib.PRIORITY_DEFAULT, turn.cancellable);
            });
            chain = write.catch(err => {
                if (!turns.isCurrent(turn) || turn.aborted || !turn.stdin) return;
                turn.error = '后端交互管道写入失败：' + err.message;
                terminateTurnProcess(turn, proc);
            });
            return write;
        };
        turn.applyInteractionResolution = event => applyCheckedStdoutResults([{normalized: event}]);
        conversationTransport.start(send).catch(() => {});
    }

    readStderrLoop();
    readStdoutLoop();
    return Promise.resolve({disposition: 'streaming', turnId: turn.id});
}
