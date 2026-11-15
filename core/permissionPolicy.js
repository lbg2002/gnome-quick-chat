/**
 * Portable, conservative permission policy & canonical scope key generator.
 * Zero external or GNOME dependencies so both GJS (ESM) and zcodeBridge.cjs (Node/Electron CJS)
 * execute the exact same source of truth.
 */

const UTF8_ENCODER = new TextEncoder();

// FIPS 180-4 SHA-256 round constants
const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// Regex is ONLY used as a UI display risk hint — never as a permission widening boundary.
export const DISPLAY_HIGH_RISK_SHELL_RE = /(?:^|[;&|()`\n]\s*)(?:sudo|su\b|pkexec|doas|rm\s+(?:-[a-zA-Z]*[rf]|--recursive|--force)|mkfs|dd\s+|fdisk|parted|sfdisk|wipefs|shred|shutdown|reboot|poweroff|init\s+[06]|systemctl\s+(?:stop|disable|mask|poweroff|reboot)|chmod\s+(?:-R|[0-7]*7[0-7]*)|chown\s+-R|curl\b[^|\n]*\|\s*(?:ba)?sh|wget\b[^|\n]*\|\s*(?:ba)?sh|>\s*\/(?:etc|dev|boot|proc|sys)\/)/i;

const SYSTEM_SENSITIVE_PREFIXES = [
    '/etc',
    '/usr',
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/boot',
    '/proc',
    '/sys',
    '/dev',
    '/root',
    '/var',
    '/opt',
    '/run/systemd',
];

const HOME_SENSITIVE_REL_PREFIXES = [
    '.ssh',
    '.gnupg',
    '.aws',
    '.kube',
    '.docker',
    '.netrc',
    '.git-credentials',
    '.bashrc',
    '.bash_profile',
    '.profile',
    '.zshrc',
    '.zprofile',
    '.zcode',
    '.codex',
    '.config/autostart',
    '.config/systemd',
    '.local/share/keyrings',
    '.local/share/gnome-shell/extensions',
    '.local/share/gnome-quick-chat',
];

const REDIRECT_QUERY_KEY_RE = /^(?:redirect|redirect_uri|redirect_url|return|return_to|returnurl|next|url|target|dest|destination|continue|goto)$/i;

/**
 * Pure JavaScript FIPS 180-4 SHA-256 hex digest over UTF-8 bytes.
 */
export function sha256Hex(input) {
    const msg = UTF8_ENCODER.encode(String(input ?? ''));
    const bitLenHi = Math.floor(msg.length / 0x20000000);
    const bitLenLo = (msg.length << 3) >>> 0;
    const totalLen = (((msg.length + 9 + 63) >> 6) << 6);
    const padded = new Uint8Array(totalLen);
    padded.set(msg);
    padded[msg.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(totalLen - 8, bitLenHi, false);
    view.setUint32(totalLen - 4, bitLenLo, false);

    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;

    const w = new Uint32Array(64);

    for (let offset = 0; offset < totalLen; offset += 64) {
        for (let i = 0; i < 16; i++) {
            w[i] = view.getUint32(offset + i * 4, false);
        }
        for (let i = 16; i < 64; i++) {
            const v15 = w[i - 15];
            const s0 = (((v15 >>> 7) | (v15 << 25)) ^ ((v15 >>> 18) | (v15 << 14)) ^ (v15 >>> 3)) >>> 0;
            const v2 = w[i - 2];
            const s1 = (((v2 >>> 17) | (v2 << 15)) ^ ((v2 >>> 19) | (v2 << 13)) ^ (v2 >>> 10)) >>> 0;
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }

        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;
        let f = h5;
        let g = h6;
        let h = h7;

        for (let i = 0; i < 64; i++) {
            const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
            const ch = ((e & f) ^ ((~e) & g)) >>> 0;
            const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
            const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
            const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
            const temp2 = (S0 + maj) >>> 0;

            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }

        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
        h5 = (h5 + f) >>> 0;
        h6 = (h6 + g) >>> 0;
        h7 = (h7 + h) >>> 0;
    }

    return [h0, h1, h2, h3, h4, h5, h6, h7]
        .map(v => v.toString(16).padStart(8, '0'))
        .join('');
}

/**
 * Deterministic JSON serializer with sorted object keys and lossless string preservation.
 */
export function canonicalizeJson(value) {
    if (value === null || value === undefined) return 'null';
    const t = typeof value;
    if (t === 'boolean' || t === 'number') {
        return Number.isFinite(value) || t === 'boolean' ? JSON.stringify(value) : 'null';
    }
    if (t === 'string') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(item => canonicalizeJson(item)).join(',')}]`;
    }
    if (t === 'object') {
        const keys = Object.keys(value)
            .filter(k => value[k] !== undefined)
            .sort();
        const pairs = keys.map(k => `${JSON.stringify(k)}:${canonicalizeJson(value[k])}`);
        return `{${pairs.join(',')}}`;
    }
    return JSON.stringify(String(value));
}

export function normalizePosixPath(rawPath, baseDir = '') {
    const raw = String(rawPath ?? '').trim();
    if (!raw || raw.includes('\u0000')) return '';
    let combined = raw;
    if (!raw.startsWith('/')) {
        const base = String(baseDir ?? '').trim();
        if (!base || !base.startsWith('/')) return '';
        combined = `${base}/${raw}`;
    }
    const parts = combined.split('/');
    const stack = [];
    for (const seg of parts) {
        if (!seg || seg === '.') continue;
        if (seg === '..') {
            stack.pop();
        } else {
            stack.push(seg);
        }
    }
    return `/${stack.join('/')}`;
}

export function isPathEqualOrInside(targetPath, dirPath) {
    const target = normalizePosixPath(targetPath);
    const dir = normalizePosixPath(dirPath);
    if (!target || !dir) return false;
    if (dir === '/') return true;
    return target === dir || target.startsWith(`${dir}/`);
}

export function isPathStrictlyInsideDir(targetPath, dirPath) {
    const target = normalizePosixPath(targetPath);
    const dir = normalizePosixPath(dirPath);
    if (!target || !dir || dir === '/') return false;
    return target.startsWith(`${dir}/`);
}

export function isSensitivePath(absPath, homeDir = '') {
    const norm = normalizePosixPath(absPath);
    if (!norm || norm === '/') return true;

    for (const prefix of SYSTEM_SENSITIVE_PREFIXES) {
        if (norm === prefix || norm.startsWith(`${prefix}/`)) {
            return true;
        }
    }

    const baseName = norm.slice(norm.lastIndexOf('/') + 1);
    if (baseName === '.env' || baseName.startsWith('.env.')) {
        return true;
    }
    if (norm.includes('/.git/hooks/') || norm.endsWith('/.git/hooks') || norm.endsWith('/.git/config')) {
        return true;
    }

    const normHome = homeDir ? normalizePosixPath(homeDir) : '';
    if (normHome && normHome !== '/') {
        for (const rel of HOME_SENSITIVE_REL_PREFIXES) {
            const full = `${normHome}/${rel}`;
            if (norm === full || norm.startsWith(`${full}/`)) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Resolves all symbolic link components along an absolute POSIX path (up to 40 symlink hops,
 * matching POSIX MAXSYMLINKS / ELOOP) for runtimes like GJS that expose `isSymlink`, `readLink`,
 * and `exists` rather than libc `realpath(3)`.
 */
export function resolveRealPathWithLinkOps(absPath, {exists, isSymlink, readLink, maxHops = 40} = {}) {
    const initial = normalizePosixPath(absPath);
    if (!initial || typeof exists !== 'function' || typeof isSymlink !== 'function' || typeof readLink !== 'function') {
        throw new Error('缺少路径解析接口');
    }
    if (initial === '/') return '/';

    const queue = initial.split('/').filter(Boolean);
    const resolvedSegments = [];
    let hops = 0;

    while (queue.length > 0) {
        const seg = queue.shift();
        if (!seg || seg === '.') continue;
        if (seg === '..') {
            resolvedSegments.pop();
            continue;
        }

        const candidate = `/${[...resolvedSegments, seg].join('/')}`;
        if (isSymlink(candidate)) {
            if (++hops > maxHops) {
                throw new Error('符号链接层级过深 (ELOOP)');
            }
            const linkTarget = String(readLink(candidate) || '');
            if (!linkTarget) {
                throw new Error(`无法读取符号链接目标: ${candidate}`);
            }
            if (linkTarget.startsWith('/')) {
                resolvedSegments.length = 0;
                queue.unshift(...linkTarget.split('/').filter(Boolean));
            } else {
                queue.unshift(...linkTarget.split('/').filter(Boolean));
            }
            continue;
        }

        if (!exists(candidate)) {
            throw new Error(`路径不存在: ${candidate}`);
        }
        resolvedSegments.push(seg);
    }

    const finalPath = `/${resolvedSegments.join('/')}`;
    if (!exists(finalPath)) {
        throw new Error(`目标不存在: ${finalPath}`);
    }
    return finalPath;
}

/**
 * Resolves a candidate file path using an injected filesystem environment (`realpath`, `isSymlink`, `exists`).
 * Fails closed (`resolvedOk: false`) whenever real path resolution cannot be verified.
 */
export function resolveFileTargetWithEnv(rawPath, {
    cwd = '',
    workspace = '',
    homeDir = '',
    fsEnv = null,
} = {}) {
    const raw = String(rawPath ?? '').trim();
    if (!raw || raw.includes('\u0000')) {
        return {
            lexicalPath: '',
            realPath: '',
            realWorkspace: '',
            resolvedOk: false,
            isSymlink: false,
            symlinkEscape: false,
            outsideWorkspace: true,
            sensitive: true,
        };
    }

    let expanded = raw;
    const normHome = homeDir ? normalizePosixPath(homeDir) : '';
    if (normHome && (raw === '~' || raw.startsWith('~/'))) {
        expanded = raw === '~' ? normHome : `${normHome}${raw.slice(1)}`;
    }

    const effectiveBase = normalizePosixPath(cwd || workspace);
    const lexicalPath = normalizePosixPath(expanded, effectiveBase);
    const lexicalWorkspace = normalizePosixPath(workspace);

    if (!lexicalPath || !fsEnv || typeof fsEnv.realpath !== 'function') {
        return {
            lexicalPath,
            realPath: '',
            realWorkspace: '',
            resolvedOk: false,
            isSymlink: false,
            symlinkEscape: false,
            outsideWorkspace: true,
            sensitive: isSensitivePath(lexicalPath, normHome),
        };
    }

    let realWorkspace = '';
    if (lexicalWorkspace && lexicalWorkspace !== '/') {
        try {
            const wr = fsEnv.realpath(lexicalWorkspace);
            realWorkspace = wr ? normalizePosixPath(wr) : '';
        } catch (_) {
            realWorkspace = '';
        }
    }

    let isSymlink = false;
    try {
        if (typeof fsEnv.isSymlink === 'function') {
            isSymlink = Boolean(fsEnv.isSymlink(lexicalPath));
        }
    } catch (_) {
        isSymlink = false;
    }

    let realPath = '';
    let resolvedOk = false;
    try {
        const directReal = fsEnv.realpath(lexicalPath);
        if (directReal) {
            realPath = normalizePosixPath(directReal);
            resolvedOk = Boolean(realPath);
        }
    } catch (_) {
        realPath = '';
    }

    // If the file itself does not exist yet (e.g. Write creating a new file),
    // walk up to the nearest existing ancestor directory and resolve its realpath,
    // PROVIDED the target itself is not a dangling symlink!
    if (!resolvedOk && !isSymlink) {
        const segments = lexicalPath.split('/').filter(Boolean);
        for (let depth = segments.length - 1; depth >= 1; depth--) {
            const ancestor = `/${segments.slice(0, depth).join('/')}`;
            try {
                if (typeof fsEnv.isSymlink === 'function' && fsEnv.isSymlink(ancestor)) {
                    isSymlink = true;
                }
                const ancestorReal = fsEnv.realpath(ancestor);
                if (ancestorReal) {
                    const normAncestor = normalizePosixPath(ancestorReal);
                    const tail = segments.slice(depth).join('/');
                    realPath = normalizePosixPath(`${normAncestor}/${tail}`);
                    resolvedOk = Boolean(realPath);
                    break;
                }
            } catch (_) {
                // Keep walking up until an existing parent is found
            }
        }
    }

    const lexicalInsideWs = Boolean(
        lexicalWorkspace &&
        lexicalWorkspace !== '/' &&
        isPathStrictlyInsideDir(lexicalPath, lexicalWorkspace)
    );
    const realInsideWs = Boolean(
        resolvedOk &&
        realWorkspace &&
        realWorkspace !== '/' &&
        isPathStrictlyInsideDir(realPath, realWorkspace)
    );
    const symlinkEscape = Boolean(
        (lexicalInsideWs && resolvedOk && !realInsideWs) ||
        (isSymlink && resolvedOk && realPath !== lexicalPath && !realInsideWs)
    );
    const sensitive = isSensitivePath(lexicalPath, normHome) ||
        (resolvedOk ? isSensitivePath(realPath, normHome) : true);

    return {
        lexicalPath,
        realPath,
        realWorkspace,
        resolvedOk,
        isSymlink: isSymlink || Boolean(resolvedOk && realWorkspace && lexicalInsideWs && realPath !== lexicalPath),
        symlinkEscape,
        outsideWorkspace: !realInsideWs,
        sensitive,
    };
}

function isPrivateOrLoopbackHost(hostname) {
    const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return true;
    if (
        h === 'localhost' ||
        h.endsWith('.localhost') ||
        h.endsWith('.local') ||
        h === '0.0.0.0' ||
        h === '::1' ||
        h === '0:0:0:0:0:0:0:1' ||
        h.startsWith('fe80:') ||
        h.startsWith('fc') ||
        h.startsWith('fd')
    ) {
        return true;
    }

    // IPv4 literal check
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (ipv4) {
        const octets = [Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4])];
        if (octets.some(n => n > 255)) return true;
        const [a, b] = octets;
        if (a === 0 || a === 10 || a === 127) return true;
        if (a === 169 && b === 254) return true; // Cloud metadata / link-local
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b >= 64 && b <= 127) return true;
    }

    // Any other non-DNS literal (e.g. hex/octal integer IP like 2130706433 or 0x7f000001)
    if (/^(?:0x[0-9a-f]+|\d+)$/i.test(h)) {
        return true;
    }

    return false;
}

function decodeQueryComponent(str) {
    const plusAsSpace = String(str || '').replace(/\+/g, ' ');
    try {
        return decodeURIComponent(plusAsSpace);
    } catch (_) {
        return plusAsSpace;
    }
}

function createPortableSearchParams(rawQuery = '') {
    const pairs = [];
    if (rawQuery) {
        for (const seg of String(rawQuery).split('&')) {
            if (!seg) continue;
            const eqIdx = seg.indexOf('=');
            if (eqIdx >= 0) {
                pairs.push([
                    decodeQueryComponent(seg.slice(0, eqIdx)),
                    decodeQueryComponent(seg.slice(eqIdx + 1)),
                ]);
            } else {
                pairs.push([decodeQueryComponent(seg), '']);
            }
        }
    }
    return {
        entries() {
            return pairs[Symbol.iterator]();
        },
    };
}

/**
 * Portable, zero-dependency RFC 3986 URL parser compatible with both GJS (where `globalThis.URL`
 * is absent in GJS 1.80) and Node.js.
 */
export function parseUrlPortable(rawInput) {
    const trimmed = String(rawInput ?? '').trim();
    if (!trimmed || /[\x00-\x20\x7f\\]/.test(trimmed)) {
        throw new TypeError('Invalid URL');
    }

    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(trimmed);
    if (!schemeMatch) {
        throw new TypeError('Invalid URL');
    }

    const protocol = `${schemeMatch[1].toLowerCase()}:`;
    const afterScheme = schemeMatch[2];
    const requiresHierarchical =
        protocol === 'http:' ||
        protocol === 'https:' ||
        protocol === 'ws:' ||
        protocol === 'wss:' ||
        protocol === 'ftp:' ||
        protocol === 'file:';

    if (!afterScheme.startsWith('//')) {
        if (requiresHierarchical) {
            throw new TypeError('Invalid URL');
        }
        return {
            protocol,
            username: '',
            password: '',
            hostname: '',
            host: '',
            port: '',
            pathname: afterScheme,
            search: '',
            hash: '',
            href: `${protocol}${afterScheme}`,
            searchParams: createPortableSearchParams(''),
        };
    }

    let rest = afterScheme.slice(2);
    const hashIdx = rest.indexOf('#');
    const hash = hashIdx >= 0 ? rest.slice(hashIdx) : '';
    if (hashIdx >= 0) rest = rest.slice(0, hashIdx);

    const queryIdx = rest.indexOf('?');
    const rawQuery = queryIdx >= 0 ? rest.slice(queryIdx + 1) : '';
    const search = queryIdx >= 0 && rawQuery.length > 0 ? `?${rawQuery}` : '';
    if (queryIdx >= 0) rest = rest.slice(0, queryIdx);

    const slashIdx = rest.indexOf('/');
    const authority = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
    const pathname = slashIdx >= 0 ? rest.slice(slashIdx) : '/';

    if (protocol === 'file:') {
        if (authority && authority.toLowerCase() !== 'localhost') {
            throw new TypeError('Unsupported non-local file URL authority');
        }
        return {
            protocol: 'file:',
            username: '',
            password: '',
            hostname: '',
            host: '',
            port: '',
            pathname,
            search,
            hash,
            href: `file://${pathname}${search}${hash}`,
            searchParams: createPortableSearchParams(rawQuery),
        };
    }

    let username = '';
    let password = '';
    let hostPort = authority;
    const atIdx = authority.lastIndexOf('@');
    if (atIdx >= 0) {
        const userinfo = authority.slice(0, atIdx);
        hostPort = authority.slice(atIdx + 1);
        const colonIdx = userinfo.indexOf(':');
        if (colonIdx >= 0) {
            username = userinfo.slice(0, colonIdx);
            password = userinfo.slice(colonIdx + 1);
        } else {
            username = userinfo;
        }
    }

    let hostname = '';
    let rawPort = '';
    if (hostPort.startsWith('[')) {
        const m6 = /^(\[[0-9a-fA-F:.]+\])(?::(\d*))?$/.exec(hostPort);
        if (!m6) throw new TypeError('Invalid IPv6 host in URL');
        hostname = m6[1].toLowerCase();
        rawPort = m6[2] || '';
    } else {
        if (hostPort.includes('[') || hostPort.includes(']')) {
            throw new TypeError('Invalid host in URL');
        }
        const mHost = /^([^:]+)(?::(\d*))?$/.exec(hostPort);
        if (!mHost) throw new TypeError('Invalid host in URL');
        hostname = mHost[1].toLowerCase();
        rawPort = mHost[2] || '';
    }

    if (!hostname) {
        throw new TypeError('Empty hostname in URL');
    }

    let port = '';
    if (rawPort !== '') {
        const portNum = Number(rawPort);
        if (!Number.isInteger(portNum) || portNum < 0 || portNum > 65535) {
            throw new TypeError('Invalid port in URL');
        }
        const isDefault =
            (protocol === 'https:' && portNum === 443) ||
            (protocol === 'http:' && portNum === 80);
        port = isDefault ? '' : String(portNum);
    }

    const host = port ? `${hostname}:${port}` : hostname;
    const authPart = username || password
        ? `${username}${password ? `:${password}` : ''}@`
        : '';

    return {
        protocol,
        username,
        password,
        hostname,
        host,
        port,
        pathname,
        search,
        hash,
        href: `${protocol}//${authPart}${host}${pathname}${search}${hash}`,
        searchParams: createPortableSearchParams(rawQuery),
    };
}

export function parseNetworkTarget(rawUrl, extraInput = null) {
    const text = String(rawUrl ?? '').trim();
    if (!text) {
        return {valid: false, reason: '缺少明确目标 URL'};
    }
    let parsed;
    try {
        parsed = parseUrlPortable(text);
    } catch (_) {
        return {valid: false, reason: 'URL 无法解析'};
    }

    const scheme = parsed.protocol.toLowerCase();
    if (scheme !== 'https:' && scheme !== 'http:') {
        return {valid: false, scheme, reason: `不支持的网络协议 ${scheme}`};
    }
    if (parsed.username || parsed.password) {
        return {valid: false, scheme, reason: 'URL 含内嵌认证凭据'};
    }

    const host = parsed.hostname.toLowerCase();
    if (!host) {
        return {valid: false, scheme, reason: '缺少目标主机名'};
    }
    const port = parsed.port || (scheme === 'https:' ? '443' : '80');
    const privateHost = isPrivateOrLoopbackHost(host);

    let hasRedirectParam = false;
    try {
        for (const [k, v] of parsed.searchParams.entries()) {
            if (REDIRECT_QUERY_KEY_RE.test(k) && /(?:https?:\/\/|^\/\/)/i.test(String(v || '').trim())) {
                hasRedirectParam = true;
                break;
            }
        }
    } catch (_) {}

    const method = String(extraInput?.method || 'GET').trim().toUpperCase();
    const hasCustomHeaders = Boolean(
        extraInput?.headers &&
        typeof extraInput.headers === 'object' &&
        Object.keys(extraInput.headers).length > 0
    );
    const followsCrossOriginRedirects = Boolean(
        extraInput?.followRedirects === true ||
        extraInput?.allowCrossOriginRedirect === true
    );

    const origin = `${scheme}//${host}${(scheme === 'https:' && port === '443') || (scheme === 'http:' && port === '80') ? '' : `:${port}`}`;

    return {
        valid: true,
        scheme,
        host,
        port,
        origin,
        href: parsed.href,
        method,
        privateHost,
        hasRedirectParam,
        hasCustomHeaders,
        followsCrossOriginRedirects,
    };
}

export function isInteractiveQuestionTool(toolName, input = null, ruleId = '') {
    const lower = String(toolName || '').trim().toLowerCase();
    if (lower === 'askuserquestion' || ruleId === 'tool.userInteraction') return true;
    return Boolean(input && typeof input === 'object' && Array.isArray(input.questions) && input.questions.length > 0);
}

export function classifyTool(toolName, input = null, ruleId = '') {
    if (isInteractiveQuestionTool(toolName, input, ruleId)) {
        return {kind: 'question', canonicalTool: 'askuserquestion', operationLabel: '交互式提问'};
    }
    const raw = String(toolName || '').trim();
    const lower = raw.toLowerCase();
    if (!lower || lower === '工具' || lower === 'tool') {
        return {kind: 'unknown', canonicalTool: lower || 'unknown', operationLabel: '未知工具'};
    }
    if (
        lower === 'bash' ||
        lower === 'sh' ||
        lower === 'zsh' ||
        lower === 'shell' ||
        lower === 'command_execution' ||
        lower === 'run_command' ||
        lower.includes('shell') ||
        lower.includes('exec') ||
        lower.includes('repl')
    ) {
        return {kind: 'shell', canonicalTool: lower, operationLabel: 'Shell 命令执行'};
    }
    if (lower === 'delete' || lower === 'remove_file' || lower === 'unlink' || lower === 'notebookedit') {
        return {kind: 'file_high_risk', canonicalTool: lower, operationLabel: '高风险文件操作'};
    }
    if (
        lower === 'write' ||
        lower === 'edit' ||
        lower === 'multiedit' ||
        lower === 'write_to_file' ||
        lower === 'replace_file_content' ||
        lower === 'create_file' ||
        lower === 'file_change'
    ) {
        return {kind: 'file_write', canonicalTool: lower, operationLabel: '文件修改 / 写入'};
    }
    if (lower === 'read' || lower === 'view_file' || lower === 'glob' || lower === 'grep' || lower === 'ls') {
        return {kind: 'file_read', canonicalTool: lower, operationLabel: '文件读取 / 检索'};
    }
    if (lower === 'webfetch') {
        return {kind: 'network_fetch', canonicalTool: 'webfetch', operationLabel: '网络读取 (WebFetch)'};
    }
    if (lower === 'websearch') {
        return {kind: 'network_search', canonicalTool: 'websearch', operationLabel: '联网搜索'};
    }
    return {kind: 'unknown', canonicalTool: lower, operationLabel: `外部或未知工具 (${raw})`};
}

export function summarizeToolInput(toolName, input) {
    if (input === null || input === undefined) return '';
    if (typeof input !== 'object') return String(input);
    if (Array.isArray(input.questions) && input.questions.length > 0) {
        return input.questions
            .map(q => {
                const header = String(q?.header || '').trim();
                const question = String(q?.question || '').trim();
                if (!question && !header) return '';
                return header && question ? `[${header}] ${question}` : (question || header);
            })
            .filter(Boolean)
            .join(' · ')
            .slice(0, 200);
    }
    if (typeof input.command === 'string') return input.command;
    if (typeof input.url === 'string') return input.url;
    if (typeof input.file_path === 'string') return input.file_path;
    if (typeof input.path === 'string') return input.path;
    if (typeof input.notebook_path === 'string') return input.notebook_path;
    if (typeof input.pattern === 'string') return input.pattern;
    if (typeof input.query === 'string') return input.query;
    if (typeof input.title === 'string') return input.title;
    try {
        return JSON.stringify(input).slice(0, 240);
    } catch (_) {
        return '';
    }
}

function extractFilePathsFromInput(input) {
    if (!input || typeof input !== 'object') return [];
    const paths = [];
    for (const key of ['file_path', 'path', 'notebook_path', 'target_file', 'destination']) {
        if (typeof input[key] === 'string' && input[key].trim()) {
            paths.push(input[key].trim());
        }
    }
    if (Array.isArray(input.edits)) {
        for (const ed of input.edits) {
            if (typeof ed?.file_path === 'string' && ed.file_path.trim()) {
                paths.push(ed.file_path.trim());
            } else if (typeof ed?.path === 'string' && ed.path.trim()) {
                paths.push(ed.path.trim());
            }
        }
    }
    return Array.from(new Set(paths));
}

function extractShellExtraParams(input) {
    if (!input || typeof input !== 'object') return {};
    const extra = {};
    for (const [k, v] of Object.entries(input)) {
        if (k === 'command' || k === 'description' || v === undefined) continue;
        extra[k] = v;
    }
    return extra;
}

function formatRiskLabel(level) {
    switch (level) {
        case 'critical':
            return '极高风险';
        case 'high':
            return '高风险';
        case 'low':
            return '低风险';
        default:
            return '中风险';
    }
}

/**
 * Authoritative conservative permission policy evaluator.
 *
 * Security invariants (Stage B1):
 * 1. Shell commands default to allow-once (`allowSessionRule: false`).
 *    Even when `allowRepeatShellInSession: true` is explicitly opted into, the key is a lossless
 *    SHA-256 over canonical `{v:1, kind:'shell', sessionId, tool, cwd, command, params}` —
 *    NEVER whitespace-compressed and NEVER truncated to 120 chars.
 * 2. Unknown tools, interactive questions (`AskUserQuestion`), and high-risk operations
 *    strictly disallow session-wide rules (`allowSessionRule: false, scopeKey: ''`).
 * 3. File permissions require resolved real paths inside a resolved non-root workspace,
 *    blocking relative escapes, symlink escapes, sensitive paths, or display/input mismatches.
 * 4. Network permissions require parsed `https://host:port` without embedded credentials,
 *    private/loopback literals, non-GET methods, custom headers, or redirect parameters.
 */
export function evaluatePermissionPolicy({
    toolName = '',
    input = null,
    summary = '',
    ruleId = '',
    reportedRiskLevel = '',
    sessionId = '',
    cwd = '',
    workspace = '',
    homeDir = '',
    fsEnv = null,
    allowRepeatShellInSession = false,
} = {}) {
    const tool = String(toolName || '工具').trim() || '工具';
    const cleanSessionId = String(sessionId || '').trim();
    const {kind, canonicalTool, operationLabel} = classifyTool(tool, input, ruleId);
    const riskWarnings = [];
    let riskLevel = ['low', 'medium', 'high', 'critical'].includes(reportedRiskLevel)
        ? reportedRiskLevel
        : 'medium';

    const escalateRisk = next => {
        const order = {low: 0, medium: 1, high: 2, critical: 3};
        if ((order[next] ?? 1) > (order[riskLevel] ?? 1)) {
            riskLevel = next;
        }
    };

    // 1. Interactive user questions: never session-scoped
    if (kind === 'question') {
        return {
            toolName: tool,
            kind,
            operationLabel,
            riskLevel: 'low',
            riskLabel: formatRiskLabel('low'),
            riskWarnings: [],
            fullCommand: '',
            cwd: '',
            realCwd: '',
            displayPath: '',
            realPath: '',
            networkOrigin: '',
            targetMismatch: false,
            symlinkEscape: false,
            scopeKey: '',
            allowSessionRule: false,
            sessionRuleLabel: '',
        };
    }

    // 2. Shell command execution
    if (kind === 'shell') {
        const hasObjectCommand = Boolean(input && typeof input === 'object' && typeof input.command === 'string');
        const fullCommand = hasObjectCommand
            ? input.command
            : (typeof input === 'string' ? input : String(summary || ''));
        const rawCwd = (input && typeof input === 'object' && typeof input.cwd === 'string' && input.cwd.trim())
            ? input.cwd.trim()
            : String(cwd || workspace || '').trim();

        let realCwd = '';
        if (rawCwd && fsEnv && typeof fsEnv.realpath === 'function') {
            try {
                const resolved = fsEnv.realpath(normalizePosixPath(rawCwd, workspace));
                if (resolved) realCwd = normalizePosixPath(resolved);
            } catch (_) {
                realCwd = '';
            }
        }

        const displaySummary = String(summary || '').trim();
        const targetMismatch = Boolean(
            hasObjectCommand &&
            displaySummary &&
            displaySummary !== fullCommand.trim() &&
            !fullCommand.startsWith(displaySummary.replace(/…$/, ''))
        );
        if (targetMismatch) {
            escalateRisk('high');
            riskWarnings.push('展示摘要与实际待执行命令不一致');
        }

        const matchesHighRiskPattern = DISPLAY_HIGH_RISK_SHELL_RE.test(fullCommand);
        if (matchesHighRiskPattern) {
            escalateRisk('high');
            riskWarnings.push('包含高风险系统或破坏性命令特征');
        }
        if (!rawCwd) {
            riskWarnings.push('未确认命令工作目录 (cwd)');
        }

        // Default: Shell commands ONLY allow one-time execution!
        let scopeKey = '';
        let allowSessionRule = false;
        let sessionRuleLabel = '';

        if (
            allowRepeatShellInSession &&
            fullCommand.length > 0 &&
            cleanSessionId &&
            realCwd &&
            !matchesHighRiskPattern &&
            !targetMismatch
        ) {
            const payload = canonicalizeJson({
                v: 1,
                kind: 'shell',
                sessionId: cleanSessionId,
                tool: canonicalTool,
                cwd: realCwd,
                command: fullCommand,
                params: extractShellExtraParams(input),
            });
            scopeKey = `qc_scope_v1_shell_${sha256Hex(payload)}`;
            allowSessionRule = true;
            sessionRuleLabel = '✓ 本次会话允许此完整命令 (同目录)';
        }

        return {
            toolName: tool,
            kind,
            operationLabel,
            riskLevel,
            riskLabel: formatRiskLabel(riskLevel),
            riskWarnings,
            fullCommand,
            cwd: rawCwd,
            realCwd,
            displayPath: '',
            realPath: '',
            networkOrigin: '',
            targetMismatch,
            symlinkEscape: false,
            scopeKey,
            allowSessionRule,
            sessionRuleLabel,
        };
    }

    // 3. File operations (write/edit/read/high-risk)
    if (kind === 'file_write' || kind === 'file_read' || kind === 'file_high_risk') {
        const extractedPaths = extractFilePathsFromInput(input);
        const rawPath = extractedPaths.length === 1
            ? extractedPaths[0]
            : (extractedPaths.length === 0 && typeof input === 'string'
                ? input.trim()
                : (extractedPaths.length === 0 ? String(summary || '').trim() : ''));
        const multiFileAmbiguous = extractedPaths.length > 1;
        const displaySummary = String(summary || '').trim();
        const targetMismatch = Boolean(
            extractedPaths.length === 1 &&
            displaySummary &&
            displaySummary !== extractedPaths[0] &&
            !displaySummary.includes(extractedPaths[0])
        );

        const resolved = resolveFileTargetWithEnv(rawPath, {
            cwd,
            workspace,
            homeDir,
            fsEnv,
        });

        if (kind === 'file_high_risk') {
            escalateRisk('high');
            riskWarnings.push('涉及删除文件或高风险笔记本修改');
        }
        if (multiFileAmbiguous) {
            escalateRisk('high');
            riskWarnings.push(`单次调用涉及多个文件路径 (${extractedPaths.length} 项)`);
        }
        if (targetMismatch) {
            escalateRisk('high');
            riskWarnings.push('展示路径与实际目标文件不一致');
        }
        if (resolved.symlinkEscape) {
            escalateRisk('critical');
            riskWarnings.push('检测到符号链接越界指向工作目录之外');
        } else if (resolved.isSymlink) {
            escalateRisk('high');
            riskWarnings.push('目标路径包含符号链接');
        }
        if (resolved.sensitive) {
            escalateRisk('high');
            riskWarnings.push('目标位于系统目录或敏感配置路径');
        } else if (!resolved.resolvedOk) {
            riskWarnings.push('未能解析规范化真实路径，仅允许单次审批');
        } else if (resolved.outsideWorkspace) {
            escalateRisk('high');
            riskWarnings.push('目标路径位于当前工作目录之外');
        }

        const canGrantSessionScope = Boolean(
            (kind === 'file_write' || kind === 'file_read') &&
            cleanSessionId &&
            !multiFileAmbiguous &&
            !targetMismatch &&
            resolved.resolvedOk &&
            resolved.realPath &&
            resolved.realWorkspace &&
            !resolved.outsideWorkspace &&
            !resolved.symlinkEscape &&
            !resolved.sensitive
        );

        let scopeKey = '';
        let sessionRuleLabel = '';
        if (canGrantSessionScope) {
            const payload = canonicalizeJson({
                v: 1,
                kind: 'file',
                op: kind,
                sessionId: cleanSessionId,
                tool: canonicalTool,
                workspace: resolved.realWorkspace,
                realPath: resolved.realPath,
            });
            scopeKey = `qc_scope_v1_file_${sha256Hex(payload)}`;
            sessionRuleLabel = kind === 'file_read'
                ? '✓ 本次会话允许读取该文件'
                : '✓ 本次会话允许修改该文件';
        }

        return {
            toolName: tool,
            kind,
            operationLabel,
            riskLevel: kind === 'file_read' && riskWarnings.length === 0 ? 'low' : riskLevel,
            riskLabel: formatRiskLabel(kind === 'file_read' && riskWarnings.length === 0 ? 'low' : riskLevel),
            riskWarnings,
            fullCommand: '',
            cwd: String(cwd || workspace || '').trim(),
            realCwd: resolved.realWorkspace,
            displayPath: rawPath || extractedPaths.join(', '),
            realPath: resolved.realPath,
            networkOrigin: '',
            targetMismatch,
            symlinkEscape: resolved.symlinkEscape,
            scopeKey,
            allowSessionRule: canGrantSessionScope,
            sessionRuleLabel,
        };
    }

    // 4. Network fetch (WebFetch)
    if (kind === 'network_fetch') {
        const displaySummary = String(summary || '').trim();
        const rawUrl = (input && typeof input === 'object')
            ? (typeof input.url === 'string' ? input.url.trim() : '')
            : (typeof input === 'string'
                ? input.trim()
                : ((input === null || input === undefined) ? displaySummary : ''));
        const targetMismatch = Boolean(
            rawUrl &&
            displaySummary &&
            displaySummary !== rawUrl &&
            !rawUrl.startsWith(displaySummary.replace(/…$/, ''))
        );

        const net = parseNetworkTarget(rawUrl, input && typeof input === 'object' ? input : null);
        if (!net.valid) {
            escalateRisk('high');
            riskWarnings.push(net.reason || '无法确认实际网络目标');
        } else {
            if (net.scheme !== 'https:') {
                escalateRisk('high');
                riskWarnings.push('使用未加密 HTTP 明文传输');
            }
            if (net.privateHost) {
                escalateRisk('high');
                riskWarnings.push('目标为本机回环或内网地址');
            }
            if (net.hasRedirectParam || net.followsCrossOriginRedirects) {
                escalateRisk('high');
                riskWarnings.push('URL 含重定向参数或允许跨域跳转，需逐次确认实际目标');
            }
            if (net.method !== 'GET' || net.hasCustomHeaders) {
                escalateRisk('high');
                riskWarnings.push('包含非 GET 请求方法或自定义请求头');
            }
        }
        if (targetMismatch) {
            escalateRisk('high');
            riskWarnings.push('展示地址与实际请求 URL 不一致');
        }

        const canGrantSessionScope = Boolean(
            cleanSessionId &&
            net.valid &&
            net.scheme === 'https:' &&
            !net.privateHost &&
            !net.hasRedirectParam &&
            !net.followsCrossOriginRedirects &&
            net.method === 'GET' &&
            !net.hasCustomHeaders &&
            !targetMismatch
        );

        let scopeKey = '';
        let sessionRuleLabel = '';
        if (canGrantSessionScope) {
            const payload = canonicalizeJson({
                v: 1,
                kind: 'net',
                sessionId: cleanSessionId,
                tool: canonicalTool,
                scheme: net.scheme,
                host: net.host,
                port: net.port,
            });
            scopeKey = `qc_scope_v1_net_${sha256Hex(payload)}`;
            const hostPort = net.port === '443' ? net.host : `${net.host}:${net.port}`;
            sessionRuleLabel = `✓ 本次会话允许访问 https://${hostPort}`;
        }

        return {
            toolName: tool,
            kind,
            operationLabel,
            riskLevel: canGrantSessionScope && riskWarnings.length === 0 ? 'low' : riskLevel,
            riskLabel: formatRiskLabel(canGrantSessionScope && riskWarnings.length === 0 ? 'low' : riskLevel),
            riskWarnings,
            fullCommand: '',
            cwd: '',
            realCwd: '',
            displayPath: rawUrl || displaySummary,
            realPath: '',
            networkOrigin: net.valid ? net.origin : '',
            targetMismatch,
            symlinkEscape: false,
            scopeKey,
            allowSessionRule: canGrantSessionScope,
            sessionRuleLabel,
        };
    }

    // 5. Network search or unknown / MCP / third-party tools: NEVER allow session-wide auto-approval!
    escalateRisk(kind === 'network_search' ? 'medium' : 'high');
    if (kind === 'unknown') {
        riskWarnings.push('未知或外部扩展工具，禁止会话级自动放行');
    }

    return {
        toolName: tool,
        kind,
        operationLabel,
        riskLevel,
        riskLabel: formatRiskLabel(riskLevel),
        riskWarnings,
        fullCommand: '',
        cwd: String(cwd || workspace || '').trim(),
        realCwd: '',
        displayPath: summarizeToolInput(tool, input) || String(summary || '').trim(),
        realPath: '',
        networkOrigin: '',
        targetMismatch: false,
        symlinkEscape: false,
        scopeKey: '',
        allowSessionRule: false,
        sessionRuleLabel: '',
    };
}

/**
 * Backwards-compatible wrapper used by protocol.js and UI helpers.
 */
export function computePermissionScope(toolName, summaryOrInput = '', context = {}) {
    const isObj = Boolean(summaryOrInput && typeof summaryOrInput === 'object');
    return evaluatePermissionPolicy({
        toolName,
        input: isObj ? summaryOrInput : null,
        summary: isObj ? (context.summary || summarizeToolInput(toolName, summaryOrInput)) : String(summaryOrInput ?? ''),
        ...context,
    });
}
