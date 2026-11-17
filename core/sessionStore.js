import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
    getDataDir,
    getSessionsDir,
    readFileBytesBoundedAsync,
    setPrivateUnixMode,
    writeAllBytesAsync,
} from './paths.js';
import {
    buildBudgetedContextMessages,
    buildCrossBackendPromptWithContext,
    buildRuntimeContextSignature,
} from './contextManager.js';
import {buildModelSignature} from '../protocol.js';
import {
    DEFAULT_HOT_MESSAGE_LIMIT,
    MAX_SESSION_ARCHIVE_FILE_BYTES,
    MAX_SESSION_ARCHIVE_MESSAGES,
    MAX_SESSION_CORRUPT_BACKUP_BYTES,
    MAX_SESSION_HOT_FILE_BYTES,
    MAX_SESSION_LINE_BYTES,
    MAX_SESSION_META_BYTES,
    MAX_SESSION_REWOUND_FILE_BYTES,
    MAX_SESSION_REWOUND_MESSAGES,
    SessionStoreEngine,
    buildContinuationPrompt,
    deleteSessionDirectoryWithIo,
    exportSessionFormatted,
    formatSessionByteSize,
    importLegacyPiSessionWithIo,
    inspectSessionsWithIo,
    planSessionRetentionCleanup,
    resolvePreviousSessionId,
    resolveSafeSessionPaths,
    validateSessionId,
} from './sessionEngine.js';

export {
    buildBudgetedContextMessages,
    buildContinuationPrompt,
    buildCrossBackendPromptWithContext,
    buildModelSignature,
    buildRuntimeContextSignature,
    exportSessionFormatted,
    formatSessionByteSize,
    planSessionRetentionCleanup,
    resolvePreviousSessionId,
    resolveSafeSessionPaths,
    validateSessionId,
};

const Decoder = new TextDecoder('utf-8');
const Encoder = new TextEncoder();

function ensurePrivateParentDir(filePath) {
    const parent = GLib.path_get_dirname(filePath);
    if (GLib.file_test(parent, GLib.FileTest.IS_SYMLINK)) {
        throw new Error(`拒绝向符号链接会话目录写入：${parent}`);
    }
    if (GLib.mkdir_with_parents(parent, 0o700) !== 0) {
        throw new Error(`无法创建会话目录：${parent}`);
    }
    setPrivateUnixMode(parent, 0o700);
    if (GLib.file_test(filePath, GLib.FileTest.IS_SYMLINK)) {
        throw new Error(`拒绝写入符号链接会话文件：${filePath}`);
    }
}

async function readFileAsync(filePath, maxBytes = MAX_SESSION_HOT_FILE_BYTES) {
    const res = await readFileBytesBoundedAsync(filePath, maxBytes, null);
    if (res.nonRegular) {
        throw new Error(res.error || `拒绝读取非普通会话文件：${filePath}`);
    }
    if (res.permissionDenied) {
        throw new Error(res.error || `会话文件权限不足：${filePath}`);
    }
    if (res.tooLarge) {
        throw new Error(res.error || `会话文件超过安全上限：${filePath}`);
    }
    if (!res.exists || !res.bytes) {
        return '';
    }
    return Decoder.decode(res.bytes);
}

/**
 * Streams a JSONL session file in fixed 16 KiB chunks with strict in-stream caps on both
 * single-line byte length (`maxLineBytes`) and total file bytes (`maxTotalBytes`),
 * plus bounded line pagination (`maxRetainedLines`) so corrupted or oversized files
 * never buffer unboundedly into GNOME Shell RAM (Stage R5).
 */
function readJsonlBoundedAsync(filePath, {
    maxTotalBytes = MAX_SESSION_HOT_FILE_BYTES,
    maxLineBytes = MAX_SESSION_LINE_BYTES,
    maxRetainedLines = 600,
} = {}) {
    if (!filePath) {
        return Promise.resolve({
            lines: [],
            corruptLines: [],
            endsWithNewline: true,
            truncatedTotalBytes: false,
        });
    }
    const effectiveMaxTotal = Math.max(4096, Number(maxTotalBytes) || MAX_SESSION_HOT_FILE_BYTES);
    const effectiveMaxLine = Math.max(512, Number(maxLineBytes) || MAX_SESSION_LINE_BYTES);
    const effectiveMaxRetained = Math.max(20, Number(maxRetainedLines) || 600);
    const chunkSize = 16 * 1024;
    const gfile = Gio.File.new_for_path(filePath);

    return new Promise((resolve, reject) => {
        gfile.query_info_async(
            'standard::type,unix::mode',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            (f, infoRes) => {
                let info = null;
                try {
                    info = f.query_info_finish(infoRes);
                } catch (_) {
                    resolve({
                        lines: [],
                        corruptLines: [],
                        endsWithNewline: true,
                        truncatedTotalBytes: false,
                    });
                    return;
                }
                if (!info) {
                    resolve({
                        lines: [],
                        corruptLines: [],
                        endsWithNewline: true,
                        truncatedTotalBytes: false,
                    });
                    return;
                }
                const fileType = info.get_file_type?.();
                let unixMode = 0;
                try {
                    unixMode = Number(info.get_attribute_uint32?.('unix::mode') || 0);
                } catch (_) {}
                const modeBits = unixMode & 0o170000;
                if (fileType !== Gio.FileType.REGULAR || (modeBits !== 0 && modeBits !== 0o100000)) {
                    reject(new Error(`拒绝读取非普通会话历史文件：${filePath}`));
                    return;
                }

                f.read_async(GLib.PRIORITY_DEFAULT, null, (rf, openRes) => {
                    let stream = null;
                    try {
                        stream = rf.read_finish(openRes);
                    } catch (err) {
                        reject(err);
                        return;
                    }
                    if (!stream) {
                        resolve({
                            lines: [],
                            corruptLines: [],
                            endsWithNewline: true,
                            truncatedTotalBytes: false,
                        });
                        return;
                    }

                    const lineDecoder = new TextDecoder('utf-8', {fatal: false});
                    const lines = [];
                    const corruptLines = [];
                    let pendingParts = [];
                    let pendingBytes = 0;
                    let skippingOversized = false;
                    let oversizedPrefix = '';
                    let lineNumber = 0;
                    let totalBytesRead = 0;
                    let lastByteWasNewline = true;
                    let truncatedTotalBytes = false;
                    let settled = false;

                    const pushRetainedLine = (lineNum, text) => {
                        lines.push({lineNumber: lineNum, text, raw: text});
                        if (lines.length > effectiveMaxRetained) {
                            lines.shift();
                        }
                    };

                    const finishStream = () => {
                        if (settled) return;
                        settled = true;
                        try {
                            stream.close_async(GLib.PRIORITY_DEFAULT, null, (st, cr) => {
                                try { st.close_finish(cr); } catch (_) {}
                            });
                        } catch (_) {}
                        resolve({
                            lines,
                            corruptLines,
                            endsWithNewline: lastByteWasNewline,
                            truncatedTotalBytes,
                            truncatedFile: truncatedTotalBytes,
                            totalBytesRead,
                        });
                    };

                    const readChunk = () => {
                        if (settled) return;
                        stream.read_bytes_async(chunkSize, GLib.PRIORITY_DEFAULT, null, (s, bytesRes) => {
                            let gbytes = null;
                            try {
                                gbytes = s.read_bytes_finish(bytesRes);
                            } catch (err) {
                                settled = true;
                                try { stream.close_async(GLib.PRIORITY_DEFAULT, null, () => {}); } catch (_) {}
                                reject(err);
                                return;
                            }
                            if (settled) return;

                            const raw = gbytes ? gbytes.get_data() : null;
                            if (!raw || raw.byteLength === 0) {
                                if (skippingOversized) {
                                    lineNumber++;
                                    corruptLines.push({
                                        lineNumber,
                                        reason: 'line_too_large',
                                        raw: `${oversizedPrefix}… [oversized line > ${effectiveMaxLine}B]`,
                                    });
                                } else if (pendingBytes > 0 || pendingParts.length > 0) {
                                    const tail = lineDecoder.decode();
                                    if (tail) pendingParts.push(tail);
                                    let fullLine = pendingParts.join('');
                                    if (fullLine.endsWith('\r')) fullLine = fullLine.slice(0, -1);
                                    pendingParts = [];
                                    pendingBytes = 0;
                                    if (fullLine.trim()) {
                                        lineNumber++;
                                        pushRetainedLine(lineNumber, fullLine);
                                    }
                                }
                                finishStream();
                                return;
                            }

                            const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
                            lastByteWasNewline = chunk[chunk.byteLength - 1] === 0x0a;
                            let cursor = 0;
                            const len = chunk.byteLength;

                            while (cursor < len) {
                                if (totalBytesRead >= effectiveMaxTotal) {
                                    truncatedTotalBytes = true;
                                    lineNumber++;
                                    corruptLines.push({
                                        lineNumber,
                                        reason: 'file_too_large',
                                        raw: `[session file exceeded maxTotalBytes (${effectiveMaxTotal}B), trailing bytes skipped]`,
                                    });
                                    pendingParts = [];
                                    pendingBytes = 0;
                                    finishStream();
                                    return;
                                }

                                let nlIdx = -1;
                                for (let i = cursor; i < len; i++) {
                                    if (chunk[i] === 0x0a) {
                                        nlIdx = i;
                                        break;
                                    }
                                }

                                const segEnd = nlIdx === -1 ? len : nlIdx;
                                const segLen = segEnd - cursor;
                                totalBytesRead += segLen + (nlIdx === -1 ? 0 : 1);

                                if (skippingOversized) {
                                    if (nlIdx !== -1) {
                                        lineNumber++;
                                        corruptLines.push({
                                            lineNumber,
                                            reason: 'line_too_large',
                                            raw: `${oversizedPrefix}… [oversized line > ${effectiveMaxLine}B]`,
                                        });
                                        skippingOversized = false;
                                        oversizedPrefix = '';
                                        pendingParts = [];
                                        pendingBytes = 0;
                                        cursor = nlIdx + 1;
                                        continue;
                                    }
                                    cursor = len;
                                    break;
                                }

                                if (pendingBytes + segLen > effectiveMaxLine) {
                                    const allowed = Math.max(0, Math.min(256 - pendingBytes, segLen));
                                    if (allowed > 0) {
                                        pendingParts.push(lineDecoder.decode(chunk.subarray(cursor, cursor + allowed), {stream: false}));
                                    } else {
                                        lineDecoder.decode();
                                    }
                                    oversizedPrefix = pendingParts.join('').slice(0, 256);
                                    pendingParts = [];
                                    pendingBytes = 0;
                                    if (nlIdx !== -1) {
                                        lineNumber++;
                                        corruptLines.push({
                                            lineNumber,
                                            reason: 'line_too_large',
                                            raw: `${oversizedPrefix}… [oversized line > ${effectiveMaxLine}B]`,
                                        });
                                        cursor = nlIdx + 1;
                                        continue;
                                    }
                                    skippingOversized = true;
                                    cursor = len;
                                    break;
                                }

                                const slice = chunk.subarray(cursor, segEnd);
                                if (nlIdx === -1) {
                                    const decoded = lineDecoder.decode(slice, {stream: true});
                                    if (decoded) pendingParts.push(decoded);
                                    pendingBytes += segLen;
                                    cursor = len;
                                    break;
                                }

                                const decoded = lineDecoder.decode(slice, {stream: false});
                                if (decoded) pendingParts.push(decoded);
                                let fullLine = pendingParts.length === 1 ? pendingParts[0] : pendingParts.join('');
                                if (fullLine.endsWith('\r')) fullLine = fullLine.slice(0, -1);
                                pendingParts = [];
                                pendingBytes = 0;
                                lineNumber++;
                                if (fullLine.trim()) {
                                    pushRetainedLine(lineNumber, fullLine);
                                }
                                cursor = nlIdx + 1;
                            }

                            readChunk();
                        });
                    };

                    readChunk();
                });
            }
        );
    });
}

function replaceFileAsync(filePath, contentStr) {
    try {
        ensurePrivateParentDir(filePath);
    } catch (err) {
        return Promise.reject(err);
    }
    const file = Gio.File.new_for_path(filePath);
    const bytes = new GLib.Bytes(Encoder.encode(contentStr));
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
            (src, res) => {
                try {
                    const ret = src.replace_contents_finish(res);
                    const ok = Array.isArray(ret) ? ret[0] : ret;
                    if (ok === false) {
                        reject(new Error(`原子替换文件返回失败：${filePath}`));
                        return;
                    }
                    setPrivateUnixMode(filePath, 0o600);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            }
        );
    });
}

/**
 * Appends line(s) to a private 0600 file and strictly checks BOTH `write_all_finish`
 * AND `close_finish` so buffered kernel/stream flush errors are never silently lost!
 */
function appendLineAsync(filePath, lineStr) {
    try {
        ensurePrivateParentDir(filePath);
    } catch (err) {
        return Promise.reject(err);
    }
    const file = Gio.File.new_for_path(filePath);
    const bytes = Encoder.encode(lineStr.endsWith('\n') ? lineStr : `${lineStr}\n`);
    return new Promise((resolve, reject) => {
        file.append_to_async(
            Gio.FileCreateFlags.PRIVATE,
            GLib.PRIORITY_DEFAULT,
            null,
            (src, res) => {
                let outStream;
                try {
                    outStream = src.append_to_finish(res);
                } catch (err) {
                    reject(err);
                    return;
                }
                const closeAndFinish = writeError => {
                    outStream.close_async(GLib.PRIORITY_DEFAULT, null, (st, cRes) => {
                        let closeError = null;
                        try {
                            const closedOk = st.close_finish(cRes);
                            if (closedOk === false) {
                                closeError = new Error(`关闭追加输出流失败：${filePath}`);
                            }
                        } catch (err) {
                            closeError = err;
                        }

                        if (writeError || closeError) {
                            reject(writeError || closeError);
                            return;
                        }
                        try {
                            setPrivateUnixMode(filePath, 0o600);
                        } catch (modeErr) {
                            reject(modeErr);
                            return;
                        }
                        resolve();
                    });
                };

                writeAllBytesAsync(outStream, bytes, GLib.PRIORITY_DEFAULT, null).then(
                    () => closeAndFinish(null),
                    writeErr => closeAndFinish(writeErr)
                );
            }
        );
    });
}

function listDirectoryAsync(dirPath) {
    if (!dirPath || !GLib.file_test(dirPath, GLib.FileTest.IS_DIR)) {
        return Promise.resolve([]);
    }
    const gdir = Gio.File.new_for_path(dirPath);
    return new Promise(resolve => {
        gdir.enumerate_children_async(
            'standard::name,standard::type,standard::is-symlink',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT,
            null,
            (src, res) => {
                let enumerator = null;
                try {
                    enumerator = src.enumerate_children_finish(res);
                } catch (_) {
                    resolve([]);
                    return;
                }
                const entries = [];
                const nextBatch = () => {
                    enumerator.next_files_async(32, GLib.PRIORITY_DEFAULT, null, (en, nRes) => {
                        let infos = [];
                        try {
                            infos = en.next_files_finish(nRes) || [];
                        } catch (_) {
                            infos = [];
                        }
                        if (!infos.length) {
                            try { en.close_async(GLib.PRIORITY_DEFAULT, null, () => {}); } catch (_) {}
                            resolve(entries);
                            return;
                        }
                        for (const info of infos) {
                            entries.push({
                                name: info.get_name(),
                                isDir: info.get_file_type() === Gio.FileType.DIRECTORY,
                                isSymlink: Boolean(info.get_is_symlink?.()),
                            });
                        }
                        nextBatch();
                    });
                };
                nextBatch();
            }
        );
    });
}

export function createGioSessionIo() {
    return {
        exists(filePath) {
            return Promise.resolve(Boolean(filePath && GLib.file_test(filePath, GLib.FileTest.EXISTS)));
        },
        readText(filePath, maxBytes = MAX_SESSION_HOT_FILE_BYTES) {
            return readFileAsync(filePath, maxBytes);
        },
        readJsonlBounded(filePath, opts = {}) {
            return readJsonlBoundedAsync(filePath, opts);
        },
        replaceFile(filePath, contentStr) {
            return replaceFileAsync(filePath, contentStr);
        },
        appendLine(filePath, lineStr) {
            return appendLineAsync(filePath, lineStr);
        },
        listDir(dirPath) {
            return listDirectoryAsync(dirPath);
        },
        statMtimeMs(filePath) {
            return new Promise(resolve => {
                if (!filePath) {
                    resolve(0);
                    return;
                }
                Gio.File.new_for_path(filePath).query_info_async(
                    'time::modified',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (f, res) => {
                        try {
                            const info = f.query_info_finish(res);
                            const dt = info?.get_modification_date_time?.();
                            resolve(dt ? dt.to_unix() * 1000 : 0);
                        } catch (_) {
                            resolve(0);
                        }
                    }
                );
            });
        },
        unlink(filePath) {
            try {
                if (filePath && GLib.file_test(filePath, GLib.FileTest.EXISTS) && !GLib.file_test(filePath, GLib.FileTest.IS_DIR)) {
                    GLib.unlink(filePath);
                }
            } catch (_) {}
            return Promise.resolve();
        },
        rmdir(dirPath) {
            try {
                if (dirPath && GLib.file_test(dirPath, GLib.FileTest.IS_DIR) && !GLib.file_test(dirPath, GLib.FileTest.IS_SYMLINK)) {
                    GLib.rmdir(dirPath);
                }
            } catch (_) {}
            return Promise.resolve();
        },
    };
}

export async function listStoredSessionsAsync(sessionsRootDir = '') {
    return inspectSessionsWithIo(sessionsRootDir || getSessionsDir(), createGioSessionIo());
}

export async function deleteStoredSessionAsync(sessionId, {sessionsRootDir = '', protectedIds = []} = {}) {
    return deleteSessionDirectoryWithIo(
        sessionsRootDir || getSessionsDir(),
        sessionId,
        createGioSessionIo(),
        {protectedIds}
    );
}

export async function executeApprovedSessionCleanupAsync(candidateSessionIds = [], {
    sessionsRootDir = '',
    protectedIds = [],
} = {}) {
    const io = createGioSessionIo();
    const root = sessionsRootDir || getSessionsDir();
    let deletedCount = 0;
    const errors = [];
    for (const sid of Array.isArray(candidateSessionIds) ? candidateSessionIds : []) {
        const res = await deleteSessionDirectoryWithIo(root, sid, io, {protectedIds});
        if (res.ok) deletedCount++;
        else if (res.error) errors.push(res.error);
    }
    return {deletedCount, errors};
}

export async function exportSessionToPrivateFileAsync(messages, meta = {}, {
    sessionId = '',
    format = 'markdown',
    includeRewound = false,
    rewoundMessages = [],
    archivedCount = 0,
} = {}) {
    const formatted = exportSessionFormatted(messages, meta, {
        sessionId,
        format,
        includeRewound,
        rewoundMessages,
        archivedCount,
    });
    const exportsDir = GLib.build_filenamev([getDataDir(), 'exports']);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const shortId = String(sessionId || 'session').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'session';
    const ext = format === 'json' ? 'json' : 'md';
    const filePath = GLib.build_filenamev([exportsDir, `quick-chat-${stamp}-${shortId}.${ext}`]);
    await replaceFileAsync(filePath, formatted);
    return {
        filePath,
        content: formatted,
    };
}

export function listLegacyPiSessionFiles() {
    const sessionsDir = getSessionsDir();
    if (!GLib.file_test(sessionsDir, GLib.FileTest.IS_DIR)) return [];
    const found = [];
    try {
        const dir = GLib.Dir.open(sessionsDir, 0);
        let name;
        while ((name = dir.read_name()) !== null) {
            if (!name.endsWith('.jsonl')) continue;
            const fullPath = GLib.build_filenamev([sessionsDir, name]);
            if (!GLib.file_test(fullPath, GLib.FileTest.IS_DIR)) {
                found.push({name, path: fullPath});
            }
        }
        dir.close();
    } catch (_) {}
    found.sort((a, b) => b.name.localeCompare(a.name));
    return found;
}

export async function importLegacyPiSessionFileReadOnly(sourceFilePath, targetSessionId = '') {
    const newSessionId = targetSessionId || GLib.uuid_string_random();
    return importLegacyPiSessionWithIo({
        sourceFilePath,
        targetSessionId: newSessionId,
        sessionsRootDir: getSessionsDir(),
        io: createGioSessionIo(),
        maxHotMessages: DEFAULT_HOT_MESSAGE_LIMIT,
    });
}

/**
 * Gio-backed SessionStore wrapping pure-JS `SessionStoreEngine` (Stage C1/C2/F3/F4/R8).
 */
export class SessionStore extends SessionStoreEngine {
    constructor(sessionId, options = {}) {
        super(sessionId, {
            sessionsRootDir: options.sessionsRootDir || getSessionsDir(),
            io: options.io || createGioSessionIo(),
            maxHotMessages: options.maxHotMessages ?? DEFAULT_HOT_MESSAGE_LIMIT,
            maxLineBytes: options.maxLineBytes ?? MAX_SESSION_LINE_BYTES,
            maxHotFileBytes: options.maxHotFileBytes ?? MAX_SESSION_HOT_FILE_BYTES,
            maxArchiveFileBytes: options.maxArchiveFileBytes ?? MAX_SESSION_ARCHIVE_FILE_BYTES,
            maxArchiveMessages: options.maxArchiveMessages ?? MAX_SESSION_ARCHIVE_MESSAGES,
            maxRewoundFileBytes: options.maxRewoundFileBytes ?? MAX_SESSION_REWOUND_FILE_BYTES,
            maxRewoundMessages: options.maxRewoundMessages ?? MAX_SESSION_REWOUND_MESSAGES,
            maxCorruptBackupBytes: options.maxCorruptBackupBytes ?? MAX_SESSION_CORRUPT_BACKUP_BYTES,
            maxRetainedLines: options.maxRetainedLines ?? 600,
            keepArchive: options.keepArchive ?? true,
            maxWriteRetries: options.maxWriteRetries ?? 2,
            retryDelayMs: options.retryDelayMs ?? 25,
            onSaveError: options.onSaveError || null,
            buildContextSignature: buildRuntimeContextSignature,
        });
    }
}
