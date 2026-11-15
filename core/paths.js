import GLib from 'gi://GLib';
import {expandHomePath} from '../protocol.js';

export const APP_DIR_NAME = 'gnome-quick-chat';

export function getDataDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), APP_DIR_NAME]);
}

export function getSessionsDir() {
    return GLib.build_filenamev([getDataDir(), 'sessions']);
}

export function getSessionDir(sessionId) {
    return GLib.build_filenamev([getSessionsDir(), sessionId]);
}

export function getLegacySessionFile(sessionId) {
    return GLib.build_filenamev([getSessionsDir(), `${sessionId}.qc.json`]);
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

/**
 * Returns a strictly user-private runtime directory (0700).
 * Never falls back to shared world-writable /tmp paths.
 */
export function getPrivateRuntimeDir() {
    const xdgRuntime = GLib.get_user_runtime_dir();
    const base = xdgRuntime && GLib.file_test(xdgRuntime, GLib.FileTest.IS_DIR)
        ? xdgRuntime
        : GLib.get_user_cache_dir();
    const dir = GLib.build_filenamev([base, APP_DIR_NAME]);
    GLib.mkdir_with_parents(dir, 0o700);
    try {
        GLib.chmod(dir, 0o700);
    } catch (_) {}
    return dir;
}

export function writePrivateFileSync(filePath, bytes) {
    const parent = GLib.path_get_dirname(filePath);
    GLib.mkdir_with_parents(parent, 0o700);
    GLib.file_set_contents(filePath, bytes);
    try {
        GLib.chmod(filePath, 0o600);
    } catch (_) {}
}

export function removeFileQuietly(filePath) {
    if (!filePath) return;
    try {
        if (GLib.file_test(filePath, GLib.FileTest.EXISTS)) {
            GLib.unlink(filePath);
        }
    } catch (_) {}
}
