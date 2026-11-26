import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {expandHomePath} from '../protocol.js';
import {resolveRealPathWithLinkOps} from './permissionPolicy.js';
import {resolveSafeSessionPaths} from './sessionEngine.js';
import {cleanupStaleRuntimeFilesWithEnv} from '../runtime/cliProcessRunner.js';

export const APP_DIR_NAME = 'gnome-quick-chat';

export function getDataDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), APP_DIR_NAME]);
}

export function getSessionsDir() {
    return GLib.build_filenamev([getDataDir(), 'sessions']);
}

export function getSessionDir(sessionId) {
    return resolveSafeSessionPaths(getSessionsDir(), sessionId).dir;
}

export function getLegacySessionFile(sessionId) {
    return resolveSafeSessionPaths(getSessionsDir(), sessionId).legacyPath;
}

export function resolveWorkspacePath(rawWorkspace = '') {
    const home = GLib.get_home_dir() || '';
    const fallback = home || GLib.build_filenamev([getDataDir(), 'workspace']);
    const resolved = expandHomePath(rawWorkspace, home);
    return resolved || fallback;
}

export function requireWorkspaceDirectory(rawWorkspace = '') {
    const workspace = resolveWorkspacePath(rawWorkspace);
    if (!GLib.path_is_absolute(workspace) || !GLib.file_test(workspace, GLib.FileTest.IS_DIR)) {
        throw new Error('工作目录必须是已存在的绝对路径：' + workspace);
    }
    return workspace;
}

export function getUserSpecialDirs() {
    const home = GLib.get_home_dir() || '';
    const safeSpecial = dirEnum => {
        try {
            return GLib.get_user_special_dir(dirEnum) || '';
        } catch (_) {
            return '';
        }
    };
    const desktop = safeSpecial(GLib.UserDirectory.DIRECTORY_DESKTOP);
    const downloads = safeSpecial(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
    const documents = safeSpecial(GLib.UserDirectory.DIRECTORY_DOCUMENTS);
    const pictures = safeSpecial(GLib.UserDirectory.DIRECTORY_PICTURES);
    const music = safeSpecial(GLib.UserDirectory.DIRECTORY_MUSIC);
    const videos = safeSpecial(GLib.UserDirectory.DIRECTORY_VIDEOS);

    const englishDesktop = home ? GLib.build_filenamev([home, 'Desktop']) : '';
    const hasLegacyEnglishDesktop = Boolean(
        englishDesktop &&
        desktop &&
        desktop !== englishDesktop &&
        GLib.file_test(englishDesktop, GLib.FileTest.IS_DIR)
    );

    return {
        home,
        desktop,
        downloads,
        documents,
        pictures,
        music,
        videos,
        hasLegacyEnglishDesktop,
    };
}

export function createGioFsEnv() {
    const exists = p => Boolean(p && GLib.file_test(p, GLib.FileTest.EXISTS));
    const isSymlink = p => Boolean(p && GLib.file_test(p, GLib.FileTest.IS_SYMLINK));
    const readLink = p => GLib.file_read_link(p);
    return {
        exists,
        isSymlink,
        realpath(targetPath) {
            return resolveRealPathWithLinkOps(targetPath, {exists, isSymlink, readLink});
        },
    };
}

export function isDshWriteWorkspace(configuredWorkspace, workspace) {
    if (!String(configuredWorkspace || '').trim() || !workspace) return false;
    try {
        const fs = createGioFsEnv();
        const home = fs.realpath(GLib.get_home_dir());
        const root = fs.realpath(workspace);
        return Boolean(home && root && root !== '/' && root !== home && !home.startsWith(root + '/') &&
            root === GLib.canonicalize_filename(resolveWorkspacePath(configuredWorkspace), null) &&
            root === GLib.canonicalize_filename(workspace, null) && GLib.file_test(root, GLib.FileTest.IS_DIR));
    } catch (_) {
        return false;
    }
}

/**
 * Enforces POSIX file/directory mode (`0o700` / `0o600`) via `Gio.File.set_attribute_uint32('unix::mode', ...)`
 * with `NOFOLLOW_SYMLINKS`. (`g_chmod` is in `<glib/gstdio.h>` and is NOT introspected in `GLib-2.0.gir`.)
 */
export function setPrivateUnixMode(targetPath, mode) {
    if (!targetPath) {
        throw new Error('缺少目标路径，无法设置权限');
    }
    if (GLib.file_test(targetPath, GLib.FileTest.IS_SYMLINK)) {
        throw new Error(`拒绝修改符号链接权限：${targetPath}`);
    }
    const ok = Gio.File.new_for_path(targetPath).set_attribute_uint32(
        'unix::mode',
        mode,
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null
    );
    if (ok === false) {
        throw new Error(`无法将路径权限设为 0o${mode.toString(8)}：${targetPath}`);
    }
}

/**
 * Returns a strictly user-private runtime directory (0700).
 * Refuses symlinked directories and never falls back to shared world-writable /tmp paths.
 */
export function getPrivateRuntimeDir() {
    const xdgRuntime = GLib.get_user_runtime_dir();
    const base = xdgRuntime &&
        GLib.file_test(xdgRuntime, GLib.FileTest.IS_DIR) &&
        !GLib.file_test(xdgRuntime, GLib.FileTest.IS_SYMLINK)
        ? xdgRuntime
        : GLib.get_user_cache_dir();

    if (!base || GLib.file_test(base, GLib.FileTest.IS_SYMLINK)) {
        throw new Error('运行时父目录不可信（存在符号链接）');
    }

    const dir = GLib.build_filenamev([base, APP_DIR_NAME]);
    if (GLib.file_test(dir, GLib.FileTest.IS_SYMLINK)) {
        throw new Error(`拒绝使用符号链接运行时目录：${dir}`);
    }

    GLib.mkdir_with_parents(dir, 0o700);
    if (GLib.file_test(dir, GLib.FileTest.IS_SYMLINK) || !GLib.file_test(dir, GLib.FileTest.IS_DIR)) {
        throw new Error(`运行时目录状态异常：${dir}`);
    }

    setPrivateUnixMode(dir, 0o700);
    return dir;
}

/**
 * Creates a fresh private 0600 file exclusively without following symlinks (`Gio.FileCreateFlags.PRIVATE`).
 * Throws on any permission or symlink violation instead of silently ignoring errors.
 */
export function writePrivateFileSync(filePath, bytes) {
    if (!filePath) {
        throw new Error('缺少私有文件写入路径');
    }
    const parent = GLib.path_get_dirname(filePath);
    if (GLib.file_test(parent, GLib.FileTest.IS_SYMLINK)) {
        throw new Error(`拒绝在符号链接目录中写入敏感文件：${parent}`);
    }
    GLib.mkdir_with_parents(parent, 0o700);
    setPrivateUnixMode(parent, 0o700);

    if (GLib.file_test(filePath, GLib.FileTest.IS_SYMLINK) || GLib.file_test(filePath, GLib.FileTest.EXISTS)) {
        throw new Error(`目标临时文件已存在或为符号链接，已拒绝覆盖：${filePath}`);
    }

    const gfile = Gio.File.new_for_path(filePath);
    let outStream = null;
    try {
        outStream = gfile.create(Gio.FileCreateFlags.PRIVATE, null);
        const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        if (payload.byteLength > 0) {
            outStream.write_all(payload, null);
        }
        outStream.close(null);
        outStream = null;
    } catch (err) {
        try { outStream?.close(null); } catch (_) {}
        removeFileQuietly(filePath);
        throw err;
    }

    if (GLib.file_test(filePath, GLib.FileTest.IS_SYMLINK)) {
        removeFileQuietly(filePath);
        throw new Error(`检测到符号链接替换，已中止敏感临时文件创建：${filePath}`);
    }
    try {
        setPrivateUnixMode(filePath, 0o600);
    } catch (modeErr) {
        removeFileQuietly(filePath);
        throw modeErr;
    }
}

/**
 * Safely writes an entire `Uint8Array` asynchronously to a `Gio.OutputStream` using ref-counted
 * `GLib.Bytes` + `write_bytes_async` in a loop until all bytes are written.
 *
 * Why NOT `outStream.write_all_async(uint8array, ...)`:
 * In GJS (`gi/arg.cpp`), `(transfer none)` byte-array arguments to `_async` C functions are marshaled
 * into a temporary C buffer freed as soon as `write_all_async()` returns to JS, causing GLib's
 * worker thread to write freed C heap garbage (GNOME gjs#72). `GLib.Bytes` is ref-counted by the
 * `GTask` across threads until `write_bytes_finish()` completes.
 */
export function writeAllBytesAsync(outStream, rawBytes, priority = GLib.PRIORITY_DEFAULT, cancellable = null) {
    const payload = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes || []);
    if (payload.byteLength === 0) {
        return Promise.resolve(0);
    }
    return new Promise((resolve, reject) => {
        let offset = 0;
        const total = payload.byteLength;

        const step = () => {
            const slice = offset === 0 ? payload : payload.subarray(offset);
            const gbytes = new GLib.Bytes(slice);
            outStream.write_bytes_async(gbytes, priority, cancellable, (stream, res) => {
                let written = 0;
                try {
                    written = Number(stream.write_bytes_finish(res));
                } catch (err) {
                    reject(err);
                    return;
                }
                if (!Number.isFinite(written) || written <= 0) {
                    reject(new Error(`异步流写入提前中断（已写 ${offset}/${total} 字节）`));
                    return;
                }
                offset += written;
                if (offset >= total) {
                    resolve(total);
                    return;
                }
                step();
            });
        };

        step();
    });
}

/**
 * Asynchronous counterpart to `writePrivateFileSync` (Stage D4) so sensitive 0600 temp files
 * are created without synchronous stream writes on the GNOME Shell main thread.
 */
export function writePrivateFileAsync(filePath, bytes, cancellable = null) {
    if (!filePath) {
        return Promise.reject(new Error('缺少私有文件写入路径'));
    }
    const parent = GLib.path_get_dirname(filePath);
    if (GLib.file_test(parent, GLib.FileTest.IS_SYMLINK)) {
        return Promise.reject(new Error(`拒绝在符号链接目录中写入敏感文件：${parent}`));
    }
    try {
        GLib.mkdir_with_parents(parent, 0o700);
        setPrivateUnixMode(parent, 0o700);
    } catch (dirErr) {
        return Promise.reject(dirErr);
    }

    if (GLib.file_test(filePath, GLib.FileTest.IS_SYMLINK) || GLib.file_test(filePath, GLib.FileTest.EXISTS)) {
        return Promise.reject(new Error(`目标临时文件已存在或为符号链接，已拒绝覆盖：${filePath}`));
    }

    const gfile = Gio.File.new_for_path(filePath);
    const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);

    return new Promise((resolve, reject) => {
        const failAndCleanup = err => {
            removeFileQuietly(filePath);
            reject(err);
        };

        gfile.create_async(Gio.FileCreateFlags.PRIVATE, GLib.PRIORITY_DEFAULT, cancellable, (f, createRes) => {
            let outStream = null;
            try {
                outStream = f.create_finish(createRes);
            } catch (createErr) {
                failAndCleanup(createErr);
                return;
            }

            const finalizeClose = () => {
                outStream.close_async(GLib.PRIORITY_DEFAULT, cancellable, (st, closeRes) => {
                    try {
                        st.close_finish(closeRes);
                    } catch (closeErr) {
                        failAndCleanup(closeErr);
                        return;
                    }
                    if (GLib.file_test(filePath, GLib.FileTest.IS_SYMLINK)) {
                        failAndCleanup(new Error(`检测到符号链接替换，已中止敏感临时文件创建：${filePath}`));
                        return;
                    }
                    try {
                        setPrivateUnixMode(filePath, 0o600);
                    } catch (modeErr) {
                        failAndCleanup(modeErr);
                        return;
                    }
                    resolve(filePath);
                });
            };

            if (payload.byteLength === 0) {
                finalizeClose();
                return;
            }

            writeAllBytesAsync(outStream, payload, GLib.PRIORITY_DEFAULT, cancellable).then(
                () => finalizeClose(),
                writeErr => {
                    try { outStream.close_async(GLib.PRIORITY_DEFAULT, null, () => {}); } catch (_) {}
                    failAndCleanup(writeErr);
                }
            );
        });
    });
}

/**
 * Reads a regular file asynchronously in fixed-size chunks (`16 KiB`) up to `maxBytes + 1`,
 * preventing non-regular files (FIFOs, character/block devices, sockets, directories) or files
 * that grow after `stat()` from exhausting GNOME Shell memory or blocking on an endless stream (Stage R5).
 *
 * Returns `{exists, tooLarge, nonRegular, cancelled, permissionDenied, grewDuringRead, bytes, error}`.
 */
export function readFileBytesBoundedAsync(filePath, maxBytes = 4 * 1024 * 1024, cancellable = null) {
    if (!filePath) {
        return Promise.resolve({
            exists: false,
            tooLarge: false,
            nonRegular: false,
            cancelled: false,
            permissionDenied: false,
            bytes: null,
            error: '文件路径为空',
        });
    }
    if (cancellable?.is_cancelled?.()) {
        return Promise.resolve({
            exists: false,
            tooLarge: false,
            nonRegular: false,
            cancelled: true,
            permissionDenied: false,
            bytes: null,
            error: '读取已取消',
        });
    }

    const classifyGioError = err => {
        if (cancellable?.is_cancelled?.() || /cancelled|canceled/i.test(String(err?.message || ''))) {
            return {
                exists: false,
                tooLarge: false,
                nonRegular: false,
                cancelled: true,
                permissionDenied: false,
                bytes: null,
                error: '读取已取消',
            };
        }
        const msg = String(err?.message || err || '');
        if (/eacces|eperm|permission denied|权限/i.test(msg) || err?.code === 'EACCES' || err?.code === 'EPERM') {
            return {
                exists: true,
                tooLarge: false,
                nonRegular: false,
                cancelled: false,
                permissionDenied: true,
                bytes: null,
                error: '文件权限不足',
            };
        }
        return {
            exists: false,
            tooLarge: false,
            nonRegular: false,
            cancelled: false,
            permissionDenied: false,
            bytes: null,
            error: msg || '读取文件失败',
        };
    };

    const effectiveMaxBytes = maxBytes > 0 ? Number(maxBytes) : 4 * 1024 * 1024;
    const chunkSize = Math.max(512, Math.min(16 * 1024, effectiveMaxBytes + 1));
    const gfile = Gio.File.new_for_path(filePath);

    return new Promise(resolve => {
        gfile.query_info_async(
            'standard::type,standard::size,unix::mode',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (f, infoRes) => {
                let info = null;
                try {
                    info = f.query_info_finish(infoRes);
                } catch (err) {
                    resolve(classifyGioError(err));
                    return;
                }
                if (!info) {
                    resolve({
                        exists: false,
                        tooLarge: false,
                        nonRegular: false,
                        cancelled: false,
                        permissionDenied: false,
                        bytes: null,
                        error: '文件不存在',
                    });
                    return;
                }

                const fileType = info.get_file_type?.();
                let unixMode = 0;
                try {
                    unixMode = Number(info.get_attribute_uint32?.('unix::mode') || 0);
                } catch (_) {}
                const modeTypeBits = unixMode & 0o170000;
                const isNonRegularByMode = modeTypeBits !== 0 && modeTypeBits !== 0o100000;
                if (fileType !== Gio.FileType.REGULAR || isNonRegularByMode) {
                    resolve({
                        exists: true,
                        tooLarge: false,
                        nonRegular: true,
                        cancelled: false,
                        permissionDenied: false,
                        fileType,
                        bytes: null,
                        error: '拒绝读取非普通文件（FIFO、设备、套接字或目录）',
                    });
                    return;
                }

                const initialSize = Number(info.get_size?.() || 0);
                if (effectiveMaxBytes > 0 && initialSize > effectiveMaxBytes) {
                    resolve({
                        exists: true,
                        tooLarge: true,
                        nonRegular: false,
                        cancelled: false,
                        permissionDenied: false,
                        bytes: null,
                        error: `文件超过大小上限（${Math.ceil(initialSize / 1024)} KB > ${Math.ceil(effectiveMaxBytes / 1024)} KB）`,
                    });
                    return;
                }

                f.read_async(GLib.PRIORITY_DEFAULT, cancellable, (rf, openRes) => {
                    let stream = null;
                    try {
                        stream = rf.read_finish(openRes);
                    } catch (err) {
                        resolve(classifyGioError(err));
                        return;
                    }
                    if (!stream) {
                        resolve({
                            exists: false,
                            tooLarge: false,
                            nonRegular: false,
                            cancelled: false,
                            permissionDenied: false,
                            bytes: null,
                            error: '打开文件读取流失败',
                        });
                        return;
                    }

                    const chunks = [];
                    let totalBytes = 0;
                    let settled = false;

                    const closeAndResolve = payload => {
                        if (settled) return;
                        settled = true;
                        try {
                            stream.close_async(GLib.PRIORITY_DEFAULT, null, (st, cr) => {
                                try { st.close_finish(cr); } catch (_) {}
                            });
                        } catch (_) {}
                        resolve(payload);
                    };

                    const readNextChunk = () => {
                        if (settled) return;
                        if (cancellable?.is_cancelled?.()) {
                            closeAndResolve({
                                exists: true,
                                tooLarge: false,
                                nonRegular: false,
                                cancelled: true,
                                permissionDenied: false,
                                bytes: null,
                                error: '读取已取消',
                            });
                            return;
                        }

                        const remainingPlusOne = (effectiveMaxBytes - totalBytes) + 1;
                        const toRead = Math.max(1, Math.min(chunkSize, remainingPlusOne));
                        stream.read_bytes_async(toRead, GLib.PRIORITY_DEFAULT, cancellable, (s, bytesRes) => {
                            let gbytes = null;
                            try {
                                gbytes = s.read_bytes_finish(bytesRes);
                            } catch (err) {
                                closeAndResolve(classifyGioError(err));
                                return;
                            }
                            if (settled) return;

                            const data = gbytes ? gbytes.get_data() : null;
                            if (!data || data.byteLength === 0) {
                                const merged = new Uint8Array(totalBytes);
                                let offset = 0;
                                for (const c of chunks) {
                                    merged.set(c, offset);
                                    offset += c.byteLength;
                                }
                                closeAndResolve({
                                    exists: true,
                                    tooLarge: false,
                                    nonRegular: false,
                                    cancelled: false,
                                    permissionDenied: false,
                                    bytes: merged,
                                });
                                return;
                            }

                            const copy = data instanceof Uint8Array ? data : new Uint8Array(data);
                            totalBytes += copy.byteLength;
                            if (totalBytes > effectiveMaxBytes) {
                                closeAndResolve({
                                    exists: true,
                                    tooLarge: true,
                                    grewDuringRead: initialSize <= effectiveMaxBytes,
                                    nonRegular: false,
                                    cancelled: false,
                                    permissionDenied: false,
                                    bytes: null,
                                    error: `文件读取过程中超出大小上限（>${Math.ceil(effectiveMaxBytes / 1024)} KB）`,
                                });
                                return;
                            }
                            chunks.push(copy);
                            readNextChunk();
                        });
                    };

                    readNextChunk();
                });
            }
        );
    });
}

export function removeFileQuietly(filePath) {
    if (!filePath) return;
    try {
        // Unlink directly if regular file or symlink (unlink removes link itself, never target)
        if (
            GLib.file_test(filePath, GLib.FileTest.IS_SYMLINK) ||
            (GLib.file_test(filePath, GLib.FileTest.EXISTS) && !GLib.file_test(filePath, GLib.FileTest.IS_DIR))
        ) {
            GLib.unlink(filePath);
        }
    } catch (_) {}
}

export function cleanupStaleRuntimeFiles(maxAgeMs = 3600 * 1000) {
    let runtimeDir = '';
    try {
        runtimeDir = getPrivateRuntimeDir();
    } catch (_) {
        return {removed: [], skipped: []};
    }

    const fsAdapter = {
        isSymlink: p => Boolean(p && GLib.file_test(p, GLib.FileTest.IS_SYMLINK)),
        isDir: p => Boolean(p && GLib.file_test(p, GLib.FileTest.IS_DIR)),
        listEntries(dirPath) {
            const out = [];
            let dir = null;
            try {
                dir = GLib.Dir.open(dirPath, 0);
                let name;
                while ((name = dir.read_name()) !== null) {
                    out.push(name);
                }
            } finally {
                try { dir?.close(); } catch (_) {}
            }
            return out;
        },
        getMtimeMs(fullPath) {
            try {
                const info = Gio.File.new_for_path(fullPath).query_info(
                    'time::modified',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                    null
                );
                const dt = info?.get_modification_date_time?.();
                return dt ? dt.to_unix() * 1000 : 0;
            } catch (_) {
                return 0;
            }
        },
        unlink(fullPath) {
            if (GLib.file_test(fullPath, GLib.FileTest.IS_SYMLINK) || GLib.file_test(fullPath, GLib.FileTest.IS_DIR)) {
                return false;
            }
            return GLib.unlink(fullPath) === 0;
        },
    };

    return cleanupStaleRuntimeFilesWithEnv(runtimeDir, fsAdapter, {maxAgeMs});
}
