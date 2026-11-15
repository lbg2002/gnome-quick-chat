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

    if (GLib.chmod(dir, 0o700) !== 0) {
        throw new Error(`无法将运行时目录权限设为 0700：${dir}`);
    }
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
    GLib.chmod(parent, 0o700);

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
    if (GLib.chmod(filePath, 0o600) !== 0) {
        removeFileQuietly(filePath);
        throw new Error(`无法将敏感临时文件设为 0600 权限：${filePath}`);
    }
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
    GLib.mkdir_with_parents(parent, 0o700);
    GLib.chmod(parent, 0o700);

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
                    if (GLib.chmod(filePath, 0o600) !== 0) {
                        failAndCleanup(new Error(`无法将敏感临时文件设为 0600 权限：${filePath}`));
                        return;
                    }
                    resolve(filePath);
                });
            };

            if (payload.byteLength === 0) {
                finalizeClose();
                return;
            }

            outStream.write_all_async(payload, GLib.PRIORITY_DEFAULT, cancellable, (st, writeRes) => {
                try {
                    st.write_all_finish(writeRes);
                } catch (writeErr) {
                    try { st.close_async(GLib.PRIORITY_DEFAULT, null, () => {}); } catch (_) {}
                    failAndCleanup(writeErr);
                    return;
                }
                finalizeClose();
            });
        });
    });
}

/**
 * Reads a regular file asynchronously with a strict byte ceiling (`maxBytes`) before loading contents,
 * preventing abnormally large files from blocking the GJS main thread.
 * Returns `{exists: boolean, tooLarge: boolean, bytes: Uint8Array | null}`.
 */
export function readFileBytesBoundedAsync(filePath, maxBytes = 4 * 1024 * 1024, cancellable = null) {
    if (!filePath) {
        return Promise.resolve({exists: false, tooLarge: false, bytes: null});
    }
    const gfile = Gio.File.new_for_path(filePath);
    return new Promise(resolve => {
        gfile.query_info_async(
            'standard::type,standard::size',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (f, infoRes) => {
                let info = null;
                try {
                    info = f.query_info_finish(infoRes);
                } catch (_) {
                    resolve({exists: false, tooLarge: false, bytes: null});
                    return;
                }
                if (!info || info.get_file_type() === Gio.FileType.DIRECTORY) {
                    resolve({exists: false, tooLarge: false, bytes: null});
                    return;
                }
                const size = Number(info.get_size?.() || 0);
                if (maxBytes > 0 && size > maxBytes) {
                    resolve({exists: true, tooLarge: true, bytes: null});
                    return;
                }
                f.load_contents_async(cancellable, (lf, loadRes) => {
                    try {
                        const [ok, raw] = lf.load_contents_finish(loadRes);
                        if (!ok || !raw) {
                            resolve({exists: false, tooLarge: false, bytes: null});
                            return;
                        }
                        const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
                        if (maxBytes > 0 && data.byteLength > maxBytes) {
                            resolve({exists: true, tooLarge: true, bytes: null});
                            return;
                        }
                        resolve({exists: true, tooLarge: false, bytes: data});
                    } catch (_) {
                        resolve({exists: false, tooLarge: false, bytes: null});
                    }
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
