// Pure JavaScript update policy. No network or filesystem side effects.
export const RELEASE_REPOSITORY = 'lbg2002/gnome-quick-chat';
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
export const RELEASE_PAGE = `https://github.com/${RELEASE_REPOSITORY}/releases`;
export const EXTENSION_UUID = 'quick-chat@lbg2002.github.io';
export const RELEASE_ZIP_NAME = `${EXTENSION_UUID}.shell-extension.zip`;
export const RELEASE_SUMS_NAME = 'SHA256SUMS';
export const MAX_RELEASE_RESPONSE_BYTES = 256 * 1024;
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;

export function parseSemver(raw) {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(raw || '').trim());
    if (!match) return null;
    return {major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3])};
}

export function compareVersions(a, b) {
    const left = parseSemver(a), right = parseSemver(b);
    if (!left || !right) throw new Error('无法比较不符合 X.Y.Z 格式的版本号');
    for (const key of ['major', 'minor', 'patch']) {
        if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
    }
    return 0;
}

function readAsset(assets, tag, name, limit) {
    const asset = assets.find(a => a?.name === name);
    if (!asset) return null;
    // GitHub may return a literal '@' or a percent-encoded '%40' in asset URLs.
    // Accept only those two exact representations; reject foreign hosts, queries
    // and paths with traversal/extra segments.
    const prefix = `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}/`;
    const url = String(asset.browser_download_url || '');
    const exactPaths = [prefix + name, prefix + encodeURIComponent(name)];
    const size = Number(asset.size || 0);
    if (!exactPaths.includes(url) || !Number.isSafeInteger(size) || size <= 0 || size > limit) {
        return null;
    }
    return {name, url, size};
}

export function readReleaseInfo(data) {
    const tag = String(data?.tag_name || '');
    const version = parseSemver(tag);
    if (!version || !tag.startsWith('v') || data?.draft || data?.prerelease) {
        throw new Error('GitHub 发布版本格式不受支持');
    }
    const pageUrl = `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${tag}`;
    if (data.html_url && data.html_url !== pageUrl) {
        throw new Error('发布页面不属于预期 GitHub 仓库');
    }
    const assets = Array.isArray(data.assets) ? data.assets : [];
    return {
        version: tag.slice(1),
        tag,
        pageUrl,
        zip: readAsset(assets, tag, RELEASE_ZIP_NAME, MAX_ARCHIVE_BYTES),
        checksum: readAsset(assets, tag, RELEASE_SUMS_NAME, 64 * 1024),
        deb: assets.map(a => a?.name || '')
            .filter(n => /^gnome-shell-extension-quick-chat_[0-9]+\.[0-9]+\.[0-9]+_all\.deb$/.test(n))
            .map(n => readAsset(assets, tag, n, MAX_ARCHIVE_BYTES))
            .find(Boolean) || null,
    };
}

export function parseSha256Sums(content, fileName) {
    if (![RELEASE_ZIP_NAME, RELEASE_SUMS_NAME].includes(fileName) &&
        !/^gnome-shell-extension-quick-chat_[0-9]+\.[0-9]+\.[0-9]+_all\.deb$/.test(fileName)) {
        return null;
    }
    const matches = [];
    for (const line of String(content || '').split(/\r?\n/)) {
        const match = /^([a-fA-F0-9]{64})\s+\*?([^\\/\s]+)$/.exec(line.trim());
        if (match && match[2] === fileName) matches.push(match[1].toLowerCase());
    }
    return matches.length === 1 ? matches[0] : null;
}

export function classifyInstallMode(hasUserExtension, hasSystemExtension) {
    if (hasUserExtension && hasSystemExtension) return 'mixed';
    if (hasUserExtension) return 'user';
    if (hasSystemExtension) return 'system';
    return 'unknown';
}
