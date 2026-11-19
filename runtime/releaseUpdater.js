import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {readSoupResponseBytesBoundedAsync} from '../backends/openaiAdapter.js';
import {getPrivateRuntimeDir, writePrivateFileAsync, removeFileQuietly} from '../core/paths.js';
import {
    RELEASE_API,
    RELEASE_ZIP_NAME,
    RELEASE_PAGE,
    MAX_RELEASE_RESPONSE_BYTES,
    MAX_ARCHIVE_BYTES,
    compareVersions,
    readReleaseInfo,
    parseSha256Sums,
    classifyInstallMode,
} from '../core/updateManager.js';

const decoder = new TextDecoder();

function ensureNotCancelled(cancellable) {
    if (cancellable?.is_cancelled?.()) throw new Error('更新操作已取消');
}

export function getInstalledExtensionMode() {
    const user = Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', 'quick-chat@lbg2002.github.io'])
    ).query_exists(null);
    const system = Gio.File.new_for_path(
        '/usr/share/gnome-shell/extensions/quick-chat@lbg2002.github.io'
    ).query_exists(null);
    return classifyInstallMode(user, system);
}

async function downloadTrustedBytes(url, {cancellable, maxBytes, session}) {
    ensureNotCancelled(cancellable);
    const msg = Soup.Message.new('GET', url);
    if (!msg) throw new Error('无法创建安全更新请求');
    msg.get_request_headers().append('Accept', 'application/octet-stream');
    msg.get_request_headers().append('User-Agent', 'Quick-Chat-GNOME-Updater');
    const {status, bytes} = await readSoupResponseBytesBoundedAsync(session, msg, {
        maxBytes, cancellable,
    });
    ensureNotCancelled(cancellable);
    if (status < 200 || status >= 300) {
        throw new Error(status === 404 ? '尚未发布 GitHub Release' : `GitHub 请求失败（HTTP ${status}）`);
    }
    return bytes;
}

export async function checkGitHubRelease(currentVersion, {cancellable = null} = {}) {
    const session = new Soup.Session({timeout: 20, user_agent: 'Quick Chat GNOME updater'});
    try {
        const bytes = await downloadTrustedBytes(RELEASE_API, {
            cancellable, maxBytes: MAX_RELEASE_RESPONSE_BYTES, session,
        });
        let parsed;
        try { parsed = JSON.parse(decoder.decode(bytes)); }
        catch (_) { throw new Error('GitHub Release 返回了无法解析的 JSON'); }
        const release = readReleaseInfo(parsed);
        return {...release, hasUpdate: compareVersions(release.version, currentVersion) > 0};
    } finally {
        try { session.abort(); } catch (_) {}
    }
}

function runInstallCommand(zipPath, cancellable) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['gnome-extensions', 'install', '--force', zipPath],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (err) {
            reject(new Error(`启动 GNOME 扩展安装器失败：${err.message}`));
            return;
        }
        proc.communicate_utf8_async(null, cancellable, (p, result) => {
            try {
                const [_ok, _stdout, stderr] = p.communicate_utf8_finish(result);
                if (!p.get_successful()) {
                    throw new Error(`扩展安装失败（退出码 ${p.get_exit_status()}）：${String(stderr || '').slice(0, 300)}`);
                }
                resolve(true);
            } catch (err) {
                reject(err);
            }
        });
    });
}

/**
 * User-controlled install. Never invokes pkexec/sudo and never writes to dpkg
 * managed system locations. Release ZIP must match a SHA256SUMS file from the
 * same trusted GitHub tag. Does not enable a previously disabled extension.
 */
export async function installUserRelease(release, {currentVersion, cancellable = null} = {}) {
    if (getInstalledExtensionMode() !== 'user') {
        throw new Error('当前为系统安装或混合安装；请通过发布页下载 .deb 更新，不允许覆盖系统托管文件');
    }
    if (!release?.hasUpdate || compareVersions(release.version, currentVersion) <= 0) {
        throw new Error('没有可安装的新版本');
    }
    if (!release.zip || !release.checksum) {
        throw new Error('发布缺少扩展 ZIP 或 SHA256SUMS，拒绝未经验证的更新');
    }
    const session = new Soup.Session({timeout: 60, user_agent: 'Quick Chat GNOME updater'});
    let tmpPath = '';
    try {
        const sumBytes = await downloadTrustedBytes(release.checksum.url, {
            cancellable, maxBytes: 64 * 1024, session,
        });
        const expected = parseSha256Sums(decoder.decode(sumBytes), RELEASE_ZIP_NAME);
        if (!expected) throw new Error('发布校验清单无有效 ZIP SHA-256，已拒绝安装');
        const zipBytes = await downloadTrustedBytes(release.zip.url, {
            cancellable, maxBytes: MAX_ARCHIVE_BYTES, session,
        });
        const actual = GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, zipBytes).toLowerCase();
        if (actual !== expected) throw new Error('下载 ZIP 的 SHA-256 校验失败，已拒绝安装');
        ensureNotCancelled(cancellable);
        tmpPath = GLib.build_filenamev([getPrivateRuntimeDir(), `update-${GLib.uuid_string_random()}.zip`]);
        await writePrivateFileAsync(tmpPath, zipBytes, cancellable);
        await runInstallCommand(tmpPath, cancellable);
        return {installed: true, needsRelogin: true};
    } finally {
        try { session.abort(); } catch (_) {}
        if (tmpPath) removeFileQuietly(tmpPath);
    }
}

export {RELEASE_PAGE};
