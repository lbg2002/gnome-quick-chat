import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {getSessionsDir} from './paths.js';
import {
    buildBudgetedContextMessages,
    buildCrossBackendPromptWithContext,
    buildRuntimeContextSignature,
} from './contextManager.js';
import {buildModelSignature} from '../protocol.js';
import {
    DEFAULT_HOT_MESSAGE_LIMIT,
    SessionStoreEngine,
    importLegacyPiSessionWithIo,
    resolveSafeSessionPaths,
    validateSessionId,
} from './sessionEngine.js';

export {
    buildBudgetedContextMessages,
    buildCrossBackendPromptWithContext,
    buildModelSignature,
    buildRuntimeContextSignature,
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
    GLib.chmod(parent, 0o700);
    if (GLib.file_test(filePath, GLib.FileTest.IS_SYMLINK)) {
        throw new Error(`拒绝写入符号链接会话文件：${filePath}`);
    }
}

function readFileAsync(filePath) {
    const file = Gio.File.new_for_path(filePath);
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (src, res) => {
            try {
                const [ok, bytes] = src.load_contents_finish(res);
                if (!ok || !bytes) {
                    resolve('');
                    return;
                }
                resolve(Decoder.decode(bytes));
            } catch (err) {
                reject(err);
            }
        });
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
                    const [ok] = src.replace_contents_finish(res);
                    if (ok === false) {
                        reject(new Error(`原子替换文件返回失败：${filePath}`));
                        return;
                    }
                    GLib.chmod(filePath, 0o600);
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
                outStream.write_all_async(bytes, GLib.PRIORITY_DEFAULT, null, (stream, wRes) => {
                    let writeError = null;
                    try {
                        const [ok] = stream.write_all_finish(wRes);
                        if (ok === false) {
                            writeError = new Error(`追加写入未完成：${filePath}`);
                        }
                    } catch (err) {
                        writeError = err;
                    }

                    stream.close_async(GLib.PRIORITY_DEFAULT, null, (st, cRes) => {
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
                        GLib.chmod(filePath, 0o600);
                        resolve();
                    });
                });
            }
        );
    });
}

function createGioSessionIo() {
    return {
        exists(filePath) {
            return Promise.resolve(Boolean(filePath && GLib.file_test(filePath, GLib.FileTest.EXISTS)));
        },
        readText(filePath) {
            return readFileAsync(filePath);
        },
        replaceFile(filePath, contentStr) {
            return replaceFileAsync(filePath, contentStr);
        },
        appendLine(filePath, lineStr) {
            return appendLineAsync(filePath, lineStr);
        },
        unlink(filePath) {
            try {
                if (filePath && GLib.file_test(filePath, GLib.FileTest.EXISTS)) {
                    GLib.unlink(filePath);
                }
            } catch (_) {}
            return Promise.resolve();
        },
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
 * Gio-backed SessionStore wrapping pure-JS `SessionStoreEngine` (Stage C1/C2).
 */
export class SessionStore extends SessionStoreEngine {
    constructor(sessionId, options = {}) {
        super(sessionId, {
            sessionsRootDir: options.sessionsRootDir || getSessionsDir(),
            io: options.io || createGioSessionIo(),
            maxHotMessages: options.maxHotMessages ?? DEFAULT_HOT_MESSAGE_LIMIT,
            keepArchive: options.keepArchive ?? true,
            maxWriteRetries: options.maxWriteRetries ?? 2,
            retryDelayMs: options.retryDelayMs ?? 25,
            onSaveError: options.onSaveError || null,
            buildContextSignature: buildRuntimeContextSignature,
        });
    }
}
