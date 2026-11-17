// Managed CLI Subprocess & Watchdog Runtime for GNOME Shell (Stage E).
// Consolidates isolated `setsid` process groups, graceful SIGTERM -> SIGKILL escalation,
// phase-aware turn & approval watchdogs, `wait_async` exit status collection, post-exit
// 0600 temp-file cleanup, and per-turn bounded stdout/stderr readers.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {findExecutableInDirs} from '../core/backendDetect.js';
import {removeFileQuietly, writeAllBytesAsync} from '../core/paths.js';
import {
    BRIDGE_EXPECTED_PROTOCOL_VERSION,
    CliTurnMonitor,
    DEFAULT_BRIDGE_HANDSHAKE_TIMEOUT_MS,
    DEFAULT_KILL_GRACE_MS,
    buildProcessGroupKillArgv,
    evaluateSubprocessOutcome,
    isSafeProcessGroupId,
    wrapArgvWithSetsid,
} from './cliProcessRunner.js';
import {
    redactSensitiveText,
    resolveSplitTimeouts,
} from './sseParser.js';

const Encoder = new TextEncoder();

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

export function signalIsolatedProcessGroup(pgid, signalName, killBin) {
    if (!killBin || !isSafeProcessGroupId(pgid)) return false;
    try {
        const argv = buildProcessGroupKillArgv(pgid, signalName, killBin);
        const killer = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        killer.wait_async(null, (p, res) => {
            try { p.wait_finish(res); } catch (_) {}
        });
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Terminates a CLI subprocess and its isolated `setsid` process group cleanly:
 * sends SIGTERM first, gives DEFAULT_KILL_GRACE_MS (800ms) for clean exit,
 * and escalates to SIGKILL ONLY within the child's own isolated process group.
 */
export function terminateProcessTreeGracefully(proc, {pgid = 0, isolatedProcessGroup = false} = {}) {
    if (!proc) return;
    const killBin = isolatedProcessGroup ? resolveKillExecutable() : '';
    const canKillGroup = Boolean(isolatedProcessGroup && killBin && isSafeProcessGroupId(pgid));

    let exited = false;
    try {
        proc.wait_async(null, (p, res) => {
            exited = true;
            try { p.wait_finish(res); } catch (_) {}
        });
    } catch (_) {}

    if (canKillGroup) {
        signalIsolatedProcessGroup(pgid, 'TERM', killBin);
    }
    try {
        proc.send_signal(15); // SIGTERM
    } catch (_) {
        if (canKillGroup) signalIsolatedProcessGroup(pgid, 'KILL', killBin);
        try { proc.force_exit(); } catch (__) {}
        return;
    }

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEFAULT_KILL_GRACE_MS, () => {
        if (!exited) {
            if (canKillGroup) {
                signalIsolatedProcessGroup(pgid, 'KILL', killBin);
            }
            try { proc.force_exit(); } catch (_) {}
        }
        return GLib.SOURCE_REMOVE;
    });
}

export function terminateTurnProcess(turn, proc) {
    terminateProcessTreeGracefully(proc || turn?.process, {
        pgid: turn?.processGroupId || 0,
        isolatedProcessGroup: Boolean(turn?.isolatedProcessGroup),
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
 * timeouts plus an independent total turn ceiling.
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
}) {
    let phaseTimerId = 0;
    let totalTimerId = 0;
    let currentTimeoutSec = Math.max(5, Number(initialTimeoutSec) || 60);
    let currentMessage = String(initialMessage || '请求响应超时');

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

    const fireTimeout = msgText => {
        clearAll();
        if (turns.isCurrent(turn)) {
            turn.timedOut = true;
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
        }
    };

    const reset = () => {
        clearPhase();
        if (!turns.isCurrent(turn)) return;
        phaseTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, currentTimeoutSec, () => {
            phaseTimerId = 0;
            fireTimeout(currentMessage);
            return GLib.SOURCE_REMOVE;
        });
    };

    const setWatchdogPhase = (nextTimeoutSec, nextMessage) => {
        currentTimeoutSec = Math.max(5, Number(nextTimeoutSec) || currentTimeoutSec);
        if (nextMessage) currentMessage = String(nextMessage);
        if (turn.state !== 'awaiting_approval') {
            reset();
        }
    };

    if (totalTurnTimeoutSec > 0) {
        totalTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, totalTurnTimeoutSec, () => {
            totalTimerId = 0;
            fireTimeout(`单轮任务总时长超出安全上限（${totalTurnTimeoutSec}s）`);
            return GLib.SOURCE_REMOVE;
        });
    }

    turn.pauseWatchdog = clearPhase;
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
        approvalTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSec, () => {
            approvalTimerId = 0;
            if (turns.isCurrent(turn)) {
                turn.timedOut = true;
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
    runtime,
    config,
    workspace,
    sessionId,
    specialDirs,
    turns,
    turn,
    store,
    approvedScopes = null,
    getSessionContextConfig,
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
}) {
    const launcher = new Gio.SubprocessLauncher({
        flags:
            Gio.SubprocessFlags.STDIN_PIPE |
            Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE,
    });
    launcher.set_cwd(workspace);
    launcher.setenv('PATH', runtime.pathEnv || '', true);
    launcher.setenv('NO_COLOR', '1', true);

    const envMap = {
        ...buildXdgEnvVars(specialDirs),
        ...(runtime.extraEnv || {}),
        ...turnExtraEnv,
        QUICK_CHAT_SESSION_ID: String(sessionId || ''),
        QUICK_CHAT_TURN_ID: String(turn.id || ''),
        QUICK_CHAT_WORKSPACE: String(workspace || ''),
        ...(requireBridgeHandshake
            ? {
                QUICK_CHAT_REQUIRE_BRIDGE: '1',
                QUICK_CHAT_BRIDGE_PROTOCOL: String(BRIDGE_EXPECTED_PROTOCOL_VERSION),
            }
            : {}),
    };
    for (const [k, v] of Object.entries(envMap)) {
        launcher.setenv(k, String(v), true);
    }

    const wrappedSpawn = wrapArgvWithSetsid(rawArgv, runtime.setsidPath);
    const turnTempFiles = [...turn.tempFiles];

    let proc;
    try {
        proc = launcher.spawnv(wrappedSpawn.argv);
        turn.process = proc;
        turn.isolatedProcessGroup = wrappedSpawn.isolatedProcessGroup;
        turn.processGroupId = Number.parseInt(proc.get_identifier?.() || '', 10) || 0;
    } catch (spawnErr) {
        turns.finalizeTurn(turn, {
            status: 'failed',
            errorText: spawnErr.message,
            onCleanupTempFiles: files => files.forEach(removeFileQuietly),
        });
        return Promise.reject(spawnErr);
    }

    const stdinPipe = proc.get_stdin_pipe();
    if (keepStdinOpenForApproval) {
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

    const stdout = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
    const stderr = new Gio.DataInputStream({base_stream: proc.get_stderr_pipe()});

    const monitor = new CliTurnMonitor({
        turnId: turn.id,
        backend,
        requireBridgeHandshake,
    });

    let handshakeTimerId = 0;
    const clearHandshakeTimer = () => {
        if (handshakeTimerId) {
            try { GLib.source_remove(handshakeTimerId); } catch (_) {}
            handshakeTimerId = 0;
        }
    };

    let stdoutDone = false;
    let stderrDone = false;
    let processExited = false;
    let exitCode = null;
    let termSignal = null;
    let streamsClosed = false;
    let activeRunningTools = 0;

    const closeIoPipes = () => {
        if (streamsClosed) return;
        streamsClosed = true;
        try { stdout.close_async(GLib.PRIORITY_DEFAULT, null, (s, r) => { try { s.close_finish(r); } catch (_) {} }); } catch (_) {}
        try { stderr.close_async(GLib.PRIORITY_DEFAULT, null, (s, r) => { try { s.close_finish(r); } catch (_) {} }); } catch (_) {}
        if (turn.stdin) {
            const st = turn.stdin;
            turn.stdin = null;
            try { st.close_async(GLib.PRIORITY_DEFAULT, null, (s, r) => { try { s.close_finish(r); } catch (_) {} }); } catch (_) {}
        }
    };

    const abortTurnForFatalMonitorError = () => {
        clearHandshakeTimer();
        if (!turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
            return;
        }
        closeIoPipes();
        const persistCfg = getSessionContextConfig();
        turns.finalizeTurn(turn, {
            status: 'failed',
            errorText: redactSensitiveText(monitor.fatalError || 'CLI 安全校验未通过'),
            onPersistAssistant: m => store?.appendMessage(m, backend, persistCfg),
            onTerminateProcess: p => terminateTurnProcess(turn, p),
            onCleanupTempFiles: files => files.forEach(removeFileQuietly),
        });
    };

    const trySettleWhenComplete = () => {
        if (!stdoutDone || !stderrDone || !processExited) return;
        clearHandshakeTimer();
        closeIoPipes();

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

        const persistCfg = getSessionContextConfig();
        turns.finalizeTurn(turn, {
            status: outcome.status,
            aborted: outcome.aborted,
            timedOut: outcome.timedOut,
            interrupted: outcome.interrupted,
            errorText: finalErrorMessage,
            onPersistAssistant: m => store?.appendMessage(m, backend, persistCfg),
            onTerminateProcess: p => terminateTurnProcess(turn, p),
            onCleanupTempFiles: files => files.forEach(removeFileQuietly),
        });
    };

    if (requireBridgeHandshake) {
        handshakeTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            DEFAULT_BRIDGE_HANDSHAKE_TIMEOUT_MS,
            () => {
                handshakeTimerId = 0;
                if (monitor.markHandshakeTimedOut()) {
                    abortTurnForFatalMonitorError();
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

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
        trySettleWhenComplete();
    });

    const readStderrLoop = () => {
        if (isDisposedFn() || turn.aborted || turn.timedOut) {
            stderrDone = true;
            trySettleWhenComplete();
            return;
        }
        stderr.read_line_async(GLib.PRIORITY_DEFAULT, turn.cancellable, (src, res) => {
            if (isDisposedFn()) {
                stderrDone = true;
                return;
            }
            try {
                const [line] = src.read_line_finish_utf8(res);
                if (line === null) {
                    stderrDone = true;
                    trySettleWhenComplete();
                    return;
                }
                if (turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
                    monitor.pushStderrLine(turn.id, line);
                }
                readStderrLoop();
            } catch (_) {
                stderrDone = true;
                trySettleWhenComplete();
            }
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
        if (activeRunningTools > 0) {
            turn.setWatchdogPhase?.(
                resolvedTimeouts.toolExecutionTimeoutSec,
                `工具执行超时（${resolvedTimeouts.toolExecutionTimeoutSec}s 无状态更新）`
            );
        } else {
            turn.setWatchdogPhase?.(
                resolvedTimeouts.streamIdleTimeoutSec,
                `CLI 响应空闲超时（${resolvedTimeouts.streamIdleTimeoutSec}s 无输出）`
            );
        }
    };

    const readStdoutLoop = () => {
        if (!turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
            stdoutDone = true;
            trySettleWhenComplete();
            return;
        }
        stdout.read_line_async(GLib.PRIORITY_DEFAULT, turn.cancellable, (stream, res) => {
            if (!turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
                stdoutDone = true;
                trySettleWhenComplete();
                return;
            }
            try {
                const [line] = stream.read_line_finish_utf8(res);
                if (line === null) {
                    stdoutDone = true;
                    trySettleWhenComplete();
                    return;
                }
                if (turn.state !== 'awaiting_approval') {
                    turn.resetWatchdog?.();
                }

                const checked = monitor.processStdoutLine(turn.id, line);
                if (checked.fatalError) {
                    abortTurnForFatalMonitorError();
                    return;
                }
                if (monitor.isHandshakeVerified) {
                    clearHandshakeTimer();
                }

                const norm = checked.normalized;
                if (norm) {
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
                        }
                        turns.emitForTurn(turn, norm);
                    } else if (norm.type === 'permission_response_rejected') {
                        if (norm.requestId && typeof turns.rejectApprovalResponseFromBridge === 'function') {
                            turns.rejectApprovalResponseFromBridge(turn, norm);
                        }
                        turns.emitForTurn(turn, norm);
                    } else if (norm.type === 'tool_execution_start') {
                        activeRunningTools++;
                        syncCliToolTimeoutPhase();
                        turns.emitForTurn(turn, norm);
                    } else if (norm.type === 'tool_execution_end') {
                        activeRunningTools = Math.max(0, activeRunningTools - 1);
                        syncCliToolTimeoutPhase();
                        turns.emitForTurn(turn, norm);
                    } else if (norm.type === 'tool_batch_end') {
                        activeRunningTools = 0;
                        syncCliToolTimeoutPhase();
                        turns.emitForTurn(turn, norm);
                    } else if (norm.type === 'session_bound' && norm.sessionId) {
                        store?.setRemoteSessionId(norm.sessionId, backend, segCfg);
                    } else if (norm.type === 'turn_completed') {
                        turn.sawDoneMarker = true;
                    } else if (norm.type === 'turn_result') {
                        if (norm.sessionId) {
                            store?.setRemoteSessionId(norm.sessionId, backend, segCfg);
                        }
                        if (norm.isError) {
                            turn.error = norm.errorMessage || `${backend.toUpperCase()} 执行返回错误`;
                        } else {
                            turn.sawDoneMarker = true;
                            if (norm.text && !turn.text) {
                                turns.replaceText(turn, norm.text, norm.segmentId || '');
                            }
                        }
                    } else if (norm.type === 'text_snapshot') {
                        turns.replaceText(turn, norm.text, norm.segmentId || '');
                    } else if (norm.type === 'thinking_snapshot') {
                        turns.replaceThinking(turn, norm.text, norm.segmentId || '');
                    } else if (norm.type === 'message_update') {
                        if (norm.sessionId) {
                            store?.setRemoteSessionId(norm.sessionId, backend, segCfg);
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
                            store?.setRemoteSessionId(norm.sessionId, backend, segCfg);
                        }
                        if (typeof norm.message.content === 'string' && norm.message.content) {
                            turns.replaceText(turn, norm.message.content, norm.segmentId || norm.message.id || '');
                        }
                        if (norm.message.errorMessage) {
                            turn.error = norm.message.errorMessage;
                        }
                    } else {
                        if (norm.sessionId) {
                            store?.setRemoteSessionId(norm.sessionId, backend, segCfg);
                        }
                        if (norm.type === 'message_start' && norm.modelId) {
                            turn.modelId = norm.modelId;
                        }
                        turns.emitForTurn(turn, norm);
                    }
                }
                readStdoutLoop();
            } catch (err) {
                stdoutDone = true;
                if (!turn.aborted && !turn.timedOut && !turn.error) {
                    turn.error = err.message;
                }
                trySettleWhenComplete();
            }
        });
    };

    readStderrLoop();
    readStdoutLoop();
    return Promise.resolve({disposition: 'streaming', turnId: turn.id});
}
