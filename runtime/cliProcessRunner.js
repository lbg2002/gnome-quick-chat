import {
    buildZCodePersonalConfigOverride,
    mapReasoningEffort,
    normalizeEvent,
    stripAnsi,
} from '../protocol.js';

const UTF8_ENCODER = new TextEncoder();

export const MAX_CLI_ARGV_PROMPT_BYTES = 32 * 1024;
export const MAX_CLI_TOTAL_PROMPT_BYTES = 512 * 1024;
export const BRIDGE_EXPECTED_PROTOCOL_VERSION = 1;
export const DEFAULT_BRIDGE_HANDSHAKE_TIMEOUT_MS = 5000;
export const DEFAULT_KILL_GRACE_MS = 800;
export const DEFAULT_POST_EXIT_PIPE_DRAIN_MS = 250;
export const DEFAULT_PIPE_CHUNK_BYTES = 16 * 1024;

export const DEFAULT_STREAM_LIMITS = Object.freeze({
    maxLineBytes: 512 * 1024,
    maxStderrBytes: 32 * 1024,
    maxStderrLines: 20,
    maxJsonParseErrors: 32,
});

/**
 * Incremental UTF-8 line assembler with strict in-stream byte ceiling (`maxLineBytes`).
 *
 * - Reads fixed `Uint8Array` chunks (`8–32 KiB`) from `read_bytes_async`.
 * - Decodes UTF-8 incrementally with `{stream: true}` so multi-byte sequences split across
 *   chunk boundaries are preserved without corruption.
 * - Accumulates decoded fragments in an array (`_pendingParts`) and joins ONLY once per `\n`
 *   line completion, avoiding O(N^2) string re-concatenation across chunks.
 * - Enforces `maxLineBytes` BEFORE buffering an unbounded newline-less payload into RAM!
 */
export class IncrementalBoundedLineReader {
    constructor({maxLineBytes = DEFAULT_STREAM_LIMITS.maxLineBytes} = {}) {
        this.maxLineBytes = Math.max(256, Number(maxLineBytes) || DEFAULT_STREAM_LIMITS.maxLineBytes);
        this._decoder = new TextDecoder('utf-8', {fatal: false});
        this._pendingParts = [];
        this._pendingBytes = 0;
        this.overflowed = false;
        this.overflowBytes = 0;
    }

    get pendingBytes() {
        return this._pendingBytes;
    }

    pushChunk(rawChunk) {
        if (this.overflowed || !rawChunk) {
            return {lines: [], overflowed: this.overflowed, overflowBytes: this.overflowBytes};
        }
        const chunk = rawChunk instanceof Uint8Array
            ? rawChunk
            : new Uint8Array(rawChunk);
        if (chunk.byteLength === 0) {
            return {lines: [], overflowed: false, overflowBytes: 0};
        }

        const lines = [];
        let cursor = 0;
        const len = chunk.byteLength;

        while (cursor < len) {
            let nlIdx = -1;
            for (let i = cursor; i < len; i++) {
                if (chunk[i] === 0x0a) {
                    nlIdx = i;
                    break;
                }
            }

            if (nlIdx === -1) {
                const segLen = len - cursor;
                const nextBytes = this._pendingBytes + segLen;
                if (nextBytes > this.maxLineBytes) {
                    this.overflowed = true;
                    this.overflowBytes = nextBytes;
                    this._pendingParts = [];
                    this._pendingBytes = 0;
                    return {lines, overflowed: true, overflowBytes: this.overflowBytes};
                }
                const slice = chunk.subarray(cursor, len);
                const decoded = this._decoder.decode(slice, {stream: true});
                if (decoded) {
                    this._pendingParts.push(decoded);
                }
                this._pendingBytes = nextBytes;
                break;
            }

            const segLen = nlIdx - cursor;
            const nextBytes = this._pendingBytes + segLen;
            if (nextBytes > this.maxLineBytes) {
                this.overflowed = true;
                this.overflowBytes = nextBytes;
                this._pendingParts = [];
                this._pendingBytes = 0;
                return {lines, overflowed: true, overflowBytes: this.overflowBytes};
            }

            const slice = chunk.subarray(cursor, nlIdx);
            const tailDecoded = this._decoder.decode(slice, {stream: false});
            if (tailDecoded) {
                this._pendingParts.push(tailDecoded);
            }
            let fullLine = this._pendingParts.length === 1
                ? this._pendingParts[0]
                : this._pendingParts.join('');
            if (fullLine.endsWith('\r')) {
                fullLine = fullLine.slice(0, -1);
            }
            lines.push(fullLine);
            this._pendingParts = [];
            this._pendingBytes = 0;
            cursor = nlIdx + 1;
        }

        return {lines, overflowed: false, overflowBytes: 0};
    }

    flush() {
        if (this.overflowed) {
            return {lines: [], overflowed: true, overflowBytes: this.overflowBytes};
        }
        const tail = this._decoder.decode();
        if (tail) {
            this._pendingParts.push(tail);
        }
        if (this._pendingParts.length === 0 && this._pendingBytes === 0) {
            return {lines: [], overflowed: false, overflowBytes: 0};
        }
        let fullLine = this._pendingParts.length === 1
            ? this._pendingParts[0]
            : this._pendingParts.join('');
        if (fullLine.endsWith('\r')) {
            fullLine = fullLine.slice(0, -1);
        }
        this._pendingParts = [];
        this._pendingBytes = 0;
        return {lines: fullLine ? [fullLine] : [], overflowed: false, overflowBytes: 0};
    }

    takePendingPrefix(maxChars = 256) {
        const prefix = this._pendingParts.join('').slice(0, maxChars);
        this._pendingParts = [];
        this._pendingBytes = 0;
        return prefix;
    }
}

export const MANAGED_TEMP_RUNTIME_FILE_RE = /^zcode-(?:provider|prompt)-[0-9a-fA-F-]{8,64}\.(?:json|txt)$/;

export function utf8ByteLength(text) {
    return UTF8_ENCODER.encode(String(text ?? '')).byteLength;
}

export function validateCliPromptLength(promptText, {viaArgv = false} = {}) {
    const bytes = utf8ByteLength(promptText);
    if (bytes > MAX_CLI_TOTAL_PROMPT_BYTES) {
        throw new Error(`输入内容过长（${Math.ceil(bytes / 1024)} KB），超出单次请求上限（${MAX_CLI_TOTAL_PROMPT_BYTES / 1024} KB）`);
    }
    if (viaArgv && bytes > MAX_CLI_ARGV_PROMPT_BYTES) {
        throw new Error(`当前 CLI 参数模式单次提问上限为 ${MAX_CLI_ARGV_PROMPT_BYTES / 1024} KB，请精简内容后重试`);
    }
    return bytes;
}

export function isManagedTempRuntimeFilename(name) {
    const clean = String(name || '').trim();
    if (!clean || clean.includes('/') || clean.includes('..')) return false;
    return MANAGED_TEMP_RUNTIME_FILE_RE.test(clean);
}

/**
 * Cleans up orphaned temporary ZCode override/prompt files inside the private runtime directory.
 * Never touches symlinks, directories, or files not matching our strict UUID naming pattern.
 */
export function cleanupStaleRuntimeFilesWithEnv(runtimeDir, fsAdapter, {
    nowMs = Date.now(),
    maxAgeMs = 3600 * 1000,
} = {}) {
    if (!runtimeDir || !fsAdapter) return {removed: [], skipped: []};
    const removed = [];
    const skipped = [];

    try {
        if (fsAdapter.isSymlink?.(runtimeDir) || !fsAdapter.isDir?.(runtimeDir)) {
            return {removed, skipped};
        }
        const entries = fsAdapter.listEntries?.(runtimeDir) || [];
        for (const name of entries) {
            if (!isManagedTempRuntimeFilename(name)) {
                skipped.push(name);
                continue;
            }
            const fullPath = `${runtimeDir.replace(/\/+$/, '')}/${name}`;
            try {
                if (fsAdapter.isSymlink?.(fullPath) || fsAdapter.isDir?.(fullPath)) {
                    skipped.push(name);
                    continue;
                }
                const mtimeMs = Number(fsAdapter.getMtimeMs?.(fullPath) ?? 0);
                if (mtimeMs > 0 && nowMs - mtimeMs < maxAgeMs) {
                    skipped.push(name);
                    continue;
                }
                if (fsAdapter.unlink?.(fullPath)) {
                    removed.push(fullPath);
                }
            } catch (_) {
                skipped.push(name);
            }
        }
    } catch (_) {}

    return {removed, skipped};
}

export function wrapArgvWithSetsid(argv, setsidPath = '') {
    if (!Array.isArray(argv) || argv.length === 0) {
        throw new Error('CLI 启动参数不能为空');
    }
    const cleanSetsid = String(setsidPath || '').trim();
    if (cleanSetsid) {
        return {
            argv: [cleanSetsid, '--', ...argv],
            isolatedProcessGroup: true,
        };
    }
    return {
        argv: [...argv],
        isolatedProcessGroup: false,
    };
}

/**
 * Parses `/proc/<pid>/stat` content safely even when `(comm)` contains spaces or parentheses.
 */
export function parseLinuxProcStat(statText) {
    const raw = String(statText || '').trim();
    if (!raw) return null;
    const firstParen = raw.indexOf('(');
    const lastParen = raw.lastIndexOf(')');
    if (firstParen <= 0 || lastParen <= firstParen) return null;

    const pid = Number.parseInt(raw.slice(0, firstParen).trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;

    const comm = raw.slice(firstParen + 1, lastParen);
    const rest = raw.slice(lastParen + 1).trim().split(/\s+/);
    if (rest.length < 20) return null;

    const state = rest[0] || '';
    const ppid = Number.parseInt(rest[1], 10) || 0;
    const pgrp = Number.parseInt(rest[2], 10) || 0;
    const session = Number.parseInt(rest[3], 10) || 0;
    const startTime = String(rest[19] || '');

    return {
        pid,
        comm,
        state,
        ppid,
        pgrp,
        session,
        startTime,
    };
}

export function isSafeProcessGroupId(pgid, {selfPid = 0, selfPgid = 0} = {}) {
    if (!Number.isInteger(pgid) || pgid <= 1) return false;
    if (selfPid > 0 && pgid === selfPid) return false;
    if (selfPgid > 0 && pgid === selfPgid) return false;
    return true;
}

export function buildProcessGroupKillArgv(pgid, signalName = 'TERM', killBinPath = '/bin/kill') {
    if (!isSafeProcessGroupId(pgid)) {
        throw new Error(`不安全的进程组 ID: ${pgid}`);
    }
    if (signalName === '0' || signalName === 0) {
        return [killBinPath, '-0', '--', `-${pgid}`];
    }
    const sig = signalName === 'KILL' || signalName === 9 || signalName === '9' ? 'KILL' : 'TERM';
    return [killBinPath, '-s', sig, '--', `-${pgid}`];
}

/**
 * Per-turn isolated stdout/stderr parser, resource capper, and ZCode bridge handshake validator.
 */
export class CliTurnMonitor {
    constructor({
        turnId,
        backend,
        requireBridgeHandshake = false,
        expectedBridgeVersion = BRIDGE_EXPECTED_PROTOCOL_VERSION,
        limits = {},
    }) {
        this.turnId = String(turnId || '');
        this.backend = String(backend || '');
        this.requireBridgeHandshake = Boolean(requireBridgeHandshake);
        this.expectedBridgeVersion = expectedBridgeVersion;
        this.limits = {...DEFAULT_STREAM_LIMITS, ...limits};

        this.handshakeState = this.requireBridgeHandshake ? 'pending' : 'not_required';
        this.handshakeError = '';
        this.stderrLines = [];
        this.stderrBytes = 0;
        this.stderrTruncated = false;
        this.jsonParseErrors = 0;
        this.stdoutLineOverflow = false;
        this.fatalError = '';
        this._stdoutLineReader = new IncrementalBoundedLineReader({
            maxLineBytes: this.limits.maxLineBytes,
        });
        this._stderrLineReader = new IncrementalBoundedLineReader({
            maxLineBytes: Math.max(4096, Math.min(this.limits.maxLineBytes, this.limits.maxStderrBytes * 2)),
        });
    }

    get isHandshakePending() {
        return this.handshakeState === 'pending';
    }

    get isHandshakeVerified() {
        return this.handshakeState === 'verified' || this.handshakeState === 'not_required';
    }

    markHandshakeTimedOut() {
        if (this.handshakeState !== 'pending') return false;
        this.handshakeState = 'failed';
        this.handshakeError = 'ZCode 审批桥接握手超时，已安全阻止在需审批模式下执行任务';
        this.fatalError = this.handshakeError;
        return true;
    }

    pushStderrLine(forTurnId, rawLine) {
        if (forTurnId !== this.turnId || rawLine === null || rawLine === undefined) return false;
        if (this.stderrTruncated) return true;
        const clean = stripAnsi(String(rawLine)).trim();
        if (!clean) return true;

        const lineBytes = utf8ByteLength(clean);
        if (this.stderrBytes + lineBytes > this.limits.maxStderrBytes) {
            const remaining = Math.max(0, this.limits.maxStderrBytes - this.stderrBytes);
            if (remaining > 32 && !this.stderrTruncated) {
                this.stderrLines.push(`${clean.slice(0, Math.min(clean.length, remaining))}… [stderr 已截断]`);
                this.stderrBytes = this.limits.maxStderrBytes;
            }
            this.stderrTruncated = true;
            return true;
        }

        this.stderrBytes += lineBytes;
        this.stderrLines.push(clean);
        if (this.stderrLines.length > this.limits.maxStderrLines) {
            this.stderrLines.shift();
        }
        return true;
    }

    pushStderrChunk(forTurnId, uint8Chunk) {
        if (forTurnId !== this.turnId || !uint8Chunk) return false;
        if (this.stderrTruncated) {
            return true;
        }
        const remainingBudget = Math.max(0, this.limits.maxStderrBytes - this.stderrBytes);
        const chunk = uint8Chunk instanceof Uint8Array ? uint8Chunk : new Uint8Array(uint8Chunk);
        const allowedSlice = chunk.byteLength > remainingBudget + 256
            ? chunk.subarray(0, remainingBudget + 256)
            : chunk;

        const res = this._stderrLineReader.pushChunk(allowedSlice);
        for (const line of res.lines) {
            this.pushStderrLine(forTurnId, line);
            if (this.stderrTruncated) break;
        }
        if (res.overflowed || chunk.byteLength > allowedSlice.byteLength) {
            if (!this.stderrTruncated) {
                const partial = stripAnsi(this._stderrLineReader.takePendingPrefix(256)).trim();
                if (partial) {
                    this.stderrLines.push(`${partial}… [stderr 已截断]`);
                } else if (this.stderrLines.length === 0) {
                    const fallbackText = stripAnsi(new TextDecoder('utf-8', {fatal: false}).decode(allowedSlice.subarray(0, Math.min(256, allowedSlice.byteLength)))).trim();
                    if (fallbackText) {
                        this.stderrLines.push(`${fallbackText}… [stderr 已截断]`);
                    }
                }
                this.stderrBytes = this.limits.maxStderrBytes;
                this.stderrTruncated = true;
            }
        }
        return true;
    }

    flushStderr(forTurnId) {
        if (forTurnId !== this.turnId || this.stderrTruncated) return false;
        const res = this._stderrLineReader.flush();
        for (const line of res.lines) {
            this.pushStderrLine(forTurnId, line);
        }
        return true;
    }

    getStderrSummary(maxLines = 3) {
        if (!this.stderrLines.length) return '';
        return this.stderrLines.slice(-maxLines).join(' ').slice(0, 480);
    }

    /**
     * Feeds a raw `Uint8Array` chunk from `stdout.read_bytes_async` into the bounded line reader
     * and processes any completed lines. Immediately sets `fatalError` if an unterminated line
     * exceeds `maxLineBytes` mid-stream!
     */
    pushStdoutChunk(forTurnId, uint8Chunk) {
        if (forTurnId !== this.turnId || !uint8Chunk) {
            return {ignore: true, results: [], fatalError: ''};
        }
        const res = this._stdoutLineReader.pushChunk(uint8Chunk);
        const results = [];
        for (const line of res.lines) {
            const checked = this.processStdoutLine(forTurnId, line);
            results.push(checked);
            if (checked.fatalError) {
                return {ignore: false, results, fatalError: checked.fatalError};
            }
        }
        if (res.overflowed) {
            this.stdoutLineOverflow = true;
            this.fatalError = `CLI 单行输出超过安全上限（${Math.ceil(res.overflowBytes / 1024)} KB > ${Math.ceil(this.limits.maxLineBytes / 1024)} KB）`;
            return {ignore: false, results, fatalError: this.fatalError};
        }
        return {ignore: false, results, fatalError: ''};
    }

    flushStdout(forTurnId) {
        if (forTurnId !== this.turnId) {
            return {ignore: true, results: [], fatalError: ''};
        }
        const res = this._stdoutLineReader.flush();
        if (res.overflowed) {
            this.stdoutLineOverflow = true;
            this.fatalError = `CLI 单行输出超过安全上限（${Math.ceil(res.overflowBytes / 1024)} KB > ${Math.ceil(this.limits.maxLineBytes / 1024)} KB）`;
            return {ignore: false, results: [], fatalError: this.fatalError};
        }
        const results = [];
        for (const line of res.lines) {
            const checked = this.processStdoutLine(forTurnId, line);
            results.push(checked);
            if (checked.fatalError) {
                return {ignore: false, results, fatalError: checked.fatalError};
            }
        }
        return {ignore: false, results, fatalError: ''};
    }

    /**
     * Processes one stdout line belonging to `forTurnId`.
     * Returns `{ignore, normalized, fatalError}`.
     */
    processStdoutLine(forTurnId, rawLine) {
        if (forTurnId !== this.turnId || rawLine === null || rawLine === undefined) {
            return {ignore: true, normalized: null, fatalError: ''};
        }

        const lineStr = String(rawLine);
        const bytes = utf8ByteLength(lineStr);
        if (bytes > this.limits.maxLineBytes) {
            this.stdoutLineOverflow = true;
            this.fatalError = `CLI 单行输出超过安全上限（${Math.ceil(bytes / 1024)} KB > ${Math.ceil(this.limits.maxLineBytes / 1024)} KB）`;
            return {ignore: false, normalized: null, fatalError: this.fatalError};
        }

        const trimmed = lineStr.trim();
        if (!trimmed || !trimmed.startsWith('{')) {
            return {ignore: false, normalized: null, fatalError: ''};
        }

        let record;
        try {
            record = JSON.parse(trimmed);
        } catch (_) {
            this.jsonParseErrors++;
            if (this.jsonParseErrors > this.limits.maxJsonParseErrors) {
                this.fatalError = `CLI JSON 事件流连续解析失败超过上限（${this.limits.maxJsonParseErrors} 次）`;
                return {ignore: false, normalized: null, fatalError: this.fatalError};
            }
            return {ignore: false, normalized: null, fatalError: ''};
        }

        const norm = normalizeEvent(this.backend, record);
        if (!norm) {
            return {ignore: false, normalized: null, fatalError: ''};
        }

        if (norm.type === 'bridge_ready') {
            if (this.requireBridgeHandshake) {
                if (
                    norm.fatal ||
                    norm.protocolVersion !== this.expectedBridgeVersion ||
                    !norm.patched
                ) {
                    this.handshakeState = 'failed';
                    this.handshakeError = norm.error ||
                        (norm.protocolVersion !== this.expectedBridgeVersion
                            ? `ZCode 审批桥接协议版本不兼容（收到 v${norm.protocolVersion}，需要 v${this.expectedBridgeVersion}）`
                            : '当前 ZCode 版本未命中交互审批钩子，已阻止在需审批模式下执行任务');
                    this.fatalError = this.handshakeError;
                    return {ignore: false, normalized: norm, fatalError: this.fatalError};
                }
                this.handshakeState = 'verified';
            }
            return {ignore: false, normalized: norm, fatalError: ''};
        }

        // Fail closed if ZCode emits tool execution or output events before completing required bridge handshake!
        if (
            this.requireBridgeHandshake &&
            this.handshakeState !== 'verified' &&
            (
                norm.type === 'tool_execution_start' ||
                norm.type === 'permission_request' ||
                norm.type === 'message_start' ||
                norm.type === 'message_update' ||
                norm.type === 'turn_result'
            )
        ) {
            this.handshakeState = 'failed';
            this.handshakeError = 'ZCode 未完成审批桥接安全握手即开始执行任务，已主动中止以保护系统安全';
            this.fatalError = this.handshakeError;
            return {ignore: false, normalized: null, fatalError: this.fatalError};
        }

        return {ignore: false, normalized: norm, fatalError: ''};
    }
}

/**
 * Computes the authoritative terminal status of a CLI subprocess turn.
 * Never marks non-zero exits, signal kills, or missing done markers as `completed`.
 */
export function evaluateSubprocessOutcome({
    exitCode = null,
    termSignal = null,
    sawDoneMarker = false,
    turnError = '',
    fatalError = '',
    aborted = false,
    timedOut = false,
    timeoutMessage = '响应超时',
    stderrSummary = '',
} = {}) {
    if (timedOut) {
        return {
            status: 'timed_out',
            timedOut: true,
            aborted: false,
            interrupted: false,
            errorMessage: timeoutMessage || '响应超时',
        };
    }
    if (aborted) {
        return {
            status: 'cancelled',
            timedOut: false,
            aborted: true,
            interrupted: false,
            errorMessage: '',
        };
    }
    if (fatalError) {
        return {
            status: 'failed',
            timedOut: false,
            aborted: false,
            interrupted: false,
            errorMessage: fatalError,
        };
    }
    if (turnError) {
        return {
            status: 'failed',
            timedOut: false,
            aborted: false,
            interrupted: false,
            errorMessage: turnError,
        };
    }
    if (termSignal !== null && termSignal !== undefined && termSignal !== '' && termSignal !== 0) {
        return {
            status: 'failed',
            timedOut: false,
            aborted: false,
            interrupted: false,
            errorMessage: stderrSummary || `CLI 子进程被信号中断 (${termSignal})`,
        };
    }
    if (typeof exitCode === 'number' && exitCode !== 0) {
        return {
            status: 'failed',
            timedOut: false,
            aborted: false,
            interrupted: false,
            errorMessage: stderrSummary || `CLI 子进程异常退出（退出码 ${exitCode}）`,
        };
    }
    if (!sawDoneMarker) {
        return {
            status: 'interrupted',
            timedOut: false,
            aborted: false,
            interrupted: true,
            errorMessage: stderrSummary || 'CLI 输出流提前结束（未收到完成标记，输出可能被截断）',
        };
    }
    return {
        status: 'completed',
        timedOut: false,
        aborted: false,
        interrupted: false,
        errorMessage: '',
    };
}

export const MAX_ZCODE_CONFIG_BYTES = 4 * 1024 * 1024; // 4 MiB ceiling on provider_config.json

function validateAndBuildZCodeOverrideObject(personalObj, config) {
    const desiredProvider = String(config?.provider || '').trim();
    const desiredModel = String(config?.model || '').trim();
    const reasoningEffort = String(config?.reasoningEffort || 'default').trim();
    const mappedEffort = mapReasoningEffort(reasoningEffort);

    const override = buildZCodePersonalConfigOverride(personalObj, {
        provider: desiredProvider,
        model: desiredModel,
        reasoningEffort,
    });
    if (!override || !override.configObj) {
        throw new Error('构建 ZCode 临时模型配置失败，已阻止静默回退至默认模型');
    }

    const catalog = Array.isArray(override.configObj?.config?.providerConfigRules?.providerRules)
        ? override.configObj.config.providerConfigRules.providerRules
        : [];
    const providerExists = catalog.some(
        r => String(r?.providerId || '').toLowerCase() === String(override.providerId || '').toLowerCase()
    );
    const appliedSel = override.configObj?.config?.defaultModelSelection;
    if (
        (desiredProvider || desiredModel) &&
        (!override.providerId || !override.modelId || !appliedSel?.providerId || !appliedSel?.modelId || (desiredProvider && !providerExists))
    ) {
        throw new Error(
            `无法将所选模型应用到 ZCode 配置（provider=${desiredProvider || '默认'}，model=${desiredModel || '默认'}），请在设置中重新选择可用模型`
        );
    }

    return {override, mappedEffort};
}

/**
 * Pure-JS fail-closed ZCode personal config override builder + read-back verifier.
 * Never mutates ~/.zcode/v2/provider_config.json; throws explicit Error if user-selected
 * model/provider/reasoningEffort cannot be read, applied, written, or verified on disk.
 */
export function prepareZCodeConfigOverride(config, io) {
    if (!io || typeof io !== 'object') {
        throw new Error('缺少 ZCode 配置文件 I/O 适配器');
    }
    const home = String(io.homeDir || '').trim();
    const personalPath = `${home.replace(/\/+$/, '')}/.zcode/v2/provider_config.json`;

    const desiredProvider = String(config?.provider || '').trim();
    const desiredModel = String(config?.model || '').trim();
    const reasoningEffort = String(config?.reasoningEffort || 'default').trim();
    const mappedEffort = mapReasoningEffort(reasoningEffort);
    const hasExplicitSelection = Boolean(desiredProvider || desiredModel || mappedEffort);

    if (!io.fileExists(personalPath)) {
        if (hasExplicitSelection) {
            throw new Error(
                '无法读取 ZCode 个人模型配置文件（~/.zcode/v2/provider_config.json），已阻止静默使用其他模型；请先在 ZCode 中完成登录与模型配置'
            );
        }
        return {env: {}, tempFilePath: '', resolvedProvider: '', resolvedModel: ''};
    }

    const personalObj = io.readJson(personalPath);
    if (!personalObj || typeof personalObj !== 'object') {
        if (hasExplicitSelection) {
            throw new Error(
                '解析 ZCode 个人模型配置文件失败（~/.zcode/v2/provider_config.json 格式损坏），已阻止静默回退至未知模型'
            );
        }
        return {env: {}, tempFilePath: '', resolvedProvider: '', resolvedModel: ''};
    }

    if (!hasExplicitSelection) {
        const defSel = personalObj?.config?.defaultModelSelection;
        return {
            env: {},
            tempFilePath: '',
            resolvedProvider: defSel?.providerId || '',
            resolvedModel: defSel?.modelId || '',
        };
    }

    const {override} = validateAndBuildZCodeOverrideObject(personalObj, config);

    let tempFilePath = '';
    try {
        const runtimeDir = io.getRuntimeDir();
        tempFilePath = `${runtimeDir.replace(/\/+$/, '')}/zcode-provider-${io.makeUuid()}.json`;
        const bytes = UTF8_ENCODER.encode(JSON.stringify(override.configObj, null, 2));
        if (bytes.byteLength > MAX_ZCODE_CONFIG_BYTES) {
            throw new Error(`ZCode 临时配置文件超出大小上限（>${MAX_ZCODE_CONFIG_BYTES} 字节）`);
        }
        io.writePrivateFile(tempFilePath, bytes);

        const verified = io.readJson(tempFilePath);
        const verifiedSel = verified?.config?.defaultModelSelection;
        if (
            !verified ||
            (override.providerId && verifiedSel?.providerId !== override.providerId) ||
            (override.modelId && verifiedSel?.modelId !== override.modelId) ||
            (mappedEffort && verifiedSel?.options?.reasoningLevel !== mappedEffort)
        ) {
            throw new Error('临时配置文件回读校验不一致');
        }

        return {
            env: {ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: tempFilePath},
            tempFilePath,
            resolvedProvider: override.providerId,
            resolvedModel: override.modelId,
        };
    } catch (err) {
        if (tempFilePath) {
            try { io.removeFile(tempFilePath); } catch (_) {}
        }
        throw new Error(`写入 ZCode 临时模型配置失败（${err.message}），已阻止使用未确认模型执行任务`);
    }
}

/**
 * Asynchronous version of `prepareZCodeConfigOverride` (Stage D4) so ZCode turns never
 * block the GNOME Shell main thread with synchronous JSON file reads or writes.
 */
export async function prepareZCodeConfigOverrideAsync(config, asyncIo) {
    if (!asyncIo || typeof asyncIo !== 'object') {
        throw new Error('缺少异步 ZCode 配置文件 I/O 适配器');
    }
    const home = String(asyncIo.homeDir || '').trim();
    const personalPath = `${home.replace(/\/+$/, '')}/.zcode/v2/provider_config.json`;

    const desiredProvider = String(config?.provider || '').trim();
    const desiredModel = String(config?.model || '').trim();
    const reasoningEffort = String(config?.reasoningEffort || 'default').trim();
    const mappedEffort = mapReasoningEffort(reasoningEffort);
    const hasExplicitSelection = Boolean(desiredProvider || desiredModel || mappedEffort);

    const exists = await asyncIo.fileExistsAsync(personalPath);
    if (!exists) {
        if (hasExplicitSelection) {
            throw new Error(
                '无法读取 ZCode 个人模型配置文件（~/.zcode/v2/provider_config.json），已阻止静默使用其他模型；请先在 ZCode 中完成登录与模型配置'
            );
        }
        return {env: {}, tempFilePath: '', resolvedProvider: '', resolvedModel: ''};
    }

    const personalObj = await asyncIo.readJsonAsync(personalPath, {maxBytes: MAX_ZCODE_CONFIG_BYTES});
    if (!personalObj || typeof personalObj !== 'object') {
        if (hasExplicitSelection) {
            throw new Error(
                '解析 ZCode 个人模型配置文件失败（~/.zcode/v2/provider_config.json 格式损坏或超出体积上限），已阻止静默回退至未知模型'
            );
        }
        return {env: {}, tempFilePath: '', resolvedProvider: '', resolvedModel: ''};
    }

    if (!hasExplicitSelection) {
        const defSel = personalObj?.config?.defaultModelSelection;
        return {
            env: {},
            tempFilePath: '',
            resolvedProvider: defSel?.providerId || '',
            resolvedModel: defSel?.modelId || '',
        };
    }

    const {override} = validateAndBuildZCodeOverrideObject(personalObj, config);

    let tempFilePath = '';
    try {
        const runtimeDir = asyncIo.getRuntimeDir();
        tempFilePath = `${runtimeDir.replace(/\/+$/, '')}/zcode-provider-${asyncIo.makeUuid()}.json`;
        const bytes = UTF8_ENCODER.encode(JSON.stringify(override.configObj, null, 2));
        if (bytes.byteLength > MAX_ZCODE_CONFIG_BYTES) {
            throw new Error(`ZCode 临时配置文件超出大小上限（>${MAX_ZCODE_CONFIG_BYTES} 字节）`);
        }
        await asyncIo.writePrivateFileAsync(tempFilePath, bytes);

        const verified = await asyncIo.readJsonAsync(tempFilePath, {maxBytes: MAX_ZCODE_CONFIG_BYTES});
        const verifiedSel = verified?.config?.defaultModelSelection;
        if (
            !verified ||
            (override.providerId && verifiedSel?.providerId !== override.providerId) ||
            (override.modelId && verifiedSel?.modelId !== override.modelId) ||
            (mappedEffort && verifiedSel?.options?.reasoningLevel !== mappedEffort)
        ) {
            throw new Error('临时配置文件回读校验不一致');
        }

        return {
            env: {ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: tempFilePath},
            tempFilePath,
            resolvedProvider: override.providerId,
            resolvedModel: override.modelId,
        };
    } catch (err) {
        if (tempFilePath) {
            try { asyncIo.removeFile(tempFilePath); } catch (_) {}
        }
        throw new Error(`写入 ZCode 临时模型配置失败（${err.message}），已阻止使用未确认模型执行任务`);
    }
}

