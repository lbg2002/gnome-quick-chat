// Pure-JS Context Attachment Manager (Stage F2).
// Handles multiple independent text/file/log references without clobbering user input drafts
// or silently truncating clipboard text at 4,000 chars.
// Enforces strict file size limits, binary content detection, Wayland explicit-user-selection boundaries,
// and outbound cloud scope disclosure.

import {parseUrlPortable} from './permissionPolicy.js';

export const MAX_ATTACHMENTS_COUNT = 8;
export const MAX_ATTACHMENT_FILE_BYTES = 128 * 1024; // 128 KiB per file content
export const MAX_CLIPBOARD_TEXT_BYTES = 192 * 1024; // 192 KiB per clipboard/log snippet
export const MAX_TOTAL_ATTACHMENTS_BYTES = 256 * 1024; // 256 KiB combined per turn
export const PREVIEW_MAX_LINES = 4;
export const PREVIEW_MAX_CHARS = 280;

const UTF8_ENCODER = new TextEncoder();
const UTF8_FATAL_DECODER = new TextDecoder('utf-8', {fatal: true});

const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.avif',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt',
    '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.zst', '.rar', '.deb', '.rpm', '.iso',
    '.so', '.o', '.a', '.bin', '.exe', '.dll', '.dylib', '.wasm', '.elf', '.pyc', '.class',
    '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.mp4', '.mkv', '.webm', '.avi', '.mov',
    '.ttf', '.otf', '.woff', '.woff2', '.sqlite', '.sqlite3', '.db',
]);

// Matches ANSI CSI/OSC terminal escape sequences so copied terminal logs stay readable
const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;

let nextAttachmentSeq = 1;

export function formatByteSize(byteLength) {
    const bytes = Math.max(0, Number(byteLength) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) {
        const kb = bytes / 1024;
        return `${kb >= 10 ? kb.toFixed(0) : kb.toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function stripAnsiEscapes(text) {
    return String(text ?? '').replace(ANSI_ESCAPE_RE, '');
}

export function extractFileExtension(filePathOrName = '') {
    const clean = String(filePathOrName || '').trim();
    const base = clean.split('/').pop() || clean;
    const dotIdx = base.lastIndexOf('.');
    if (dotIdx <= 0) return '';
    return base.slice(dotIdx).toLowerCase();
}

/**
 * Determines whether a file is binary by extension OR byte inspection (NUL byte scan + fatal UTF-8 check).
 */
export function detectBinaryFile(bytesOrNull, filePathOrName = '') {
    const ext = extractFileExtension(filePathOrName);
    if (ext && BINARY_EXTENSIONS.has(ext)) {
        return {isBinary: true, reason: `二进制文件类型 (${ext})`};
    }
    if (!bytesOrNull) {
        return {isBinary: false, reason: ''};
    }
    const buf = bytesOrNull instanceof Uint8Array ? bytesOrNull : new Uint8Array(bytesOrNull);
    const sampleLen = Math.min(buf.byteLength, 8192);
    for (let i = 0; i < sampleLen; i++) {
        if (buf[i] === 0) {
            return {isBinary: true, reason: '包含二进制空字节 (NUL)'};
        }
    }
    try {
        const text = UTF8_FATAL_DECODER.decode(buf);
        return {isBinary: false, reason: '', decodedText: text};
    } catch (_) {
        return {isBinary: true, reason: '非 UTF-8 文本编码'};
    }
}

/**
 * Parses Nautilus / GNOME Files copied file lists (`x-special/gnome-copied-files`, `file://` URI lists,
 * or explicit multi-line absolute file paths) without scraping any Wayland window state.
 */
export function extractCopiedFilePaths(rawClipboardText) {
    const raw = String(rawClipboardText || '').trim();
    if (!raw || raw.length > 32768) return [];

    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0 || lines.length > 16) return [];

    let candidateLines = lines;
    if ((lines[0] === 'copy' || lines[0] === 'cut') && lines.length >= 2) {
        candidateLines = lines.slice(1);
    }

    const paths = [];
    for (const line of candidateLines) {
        if (line.startsWith('#')) continue;
        if (line.startsWith('file://')) {
            try {
                const url = parseUrlPortable(line);
                if (url.protocol !== 'file:') return [];
                const decoded = decodeURIComponent(url.pathname || '');
                if (!decoded.startsWith('/')) return [];
                paths.push(decoded);
                continue;
            } catch (_) {
                return [];
            }
        }
        // Single-line or multi-line explicit Unix paths without spaces/prose Sentences
        if (
            line.startsWith('/') &&
            !line.startsWith('//') &&
            line.length > 1 &&
            line.length <= 1024 &&
            !/[\t\r\n]/.test(line)
        ) {
            paths.push(line);
            continue;
        }
        // Mixed prose + path is normal clipboard text, NOT a Nautilus file selection
        return [];
    }

    return Array.from(new Set(paths));
}

/**
 * Classifies a text selection into `terminal_log` vs `clipboard` and builds a concise preview.
 */
export function classifyTextSnippet(rawText, {fromPrimarySelection = false, sourceHint = ''} = {}) {
    const hadAnsi = ANSI_ESCAPE_RE.test(String(rawText || ''));
    ANSI_ESCAPE_RE.lastIndex = 0;
    const cleaned = stripAnsiEscapes(rawText).replace(/\0/g, '').replace(/\r\n/g, '\n');

    const logPatterns = [
        /^\s*(?:\$ |# |❯ |>>> )/m,
        /\b(?:Traceback \(most recent call last\)|Error:|Exception:|panicked at|Segmentation fault|ENOENT|EACCES|exit code \d+)/i,
        /^\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+\S+\[\d+\]:/m,
        /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/m,
        /^\s+at\s+\S+\s+\([^)]+:\d+:\d+\)/m,
    ];
    const looksLikeLog = hadAnsi || logPatterns.some(re => re.test(cleaned));
    const kind = sourceHint === 'terminal_log' || looksLikeLog
        ? 'terminal_log'
        : 'clipboard';
    const sourceLabel = kind === 'terminal_log'
        ? (fromPrimarySelection ? '终端选中日志' : '终端日志')
        : (fromPrimarySelection ? '选中文本引用' : '剪贴板文本');

    return {
        kind,
        sourceLabel,
        cleanedText: cleaned,
    };
}

export function buildAttachmentPreview(text, maxLines = PREVIEW_MAX_LINES, maxChars = PREVIEW_MAX_CHARS) {
    const clean = String(text || '').trim();
    if (!clean) return '（空内容）';
    const lines = clean.split('\n');
    const slicedLines = lines.slice(0, maxLines).join('\n');
    const truncatedByLines = lines.length > maxLines;
    if (slicedLines.length > maxChars) {
        return `${slicedLines.slice(0, maxChars)}…`;
    }
    return truncatedByLines ? `${slicedLines}\n…（共 ${lines.length} 行）` : slicedLines;
}

function summarizeSnippetTitle(text) {
    const firstNonEmpty = String(text || '')
        .split('\n')
        .map(l => l.trim())
        .find(Boolean) || '文本片段';
    return firstNonEmpty.length > 26 ? `${firstNonEmpty.slice(0, 26)}…` : firstNonEmpty;
}

/**
 * Stateful manager for per-turn context attachments.
 */
export class AttachmentManager {
    constructor({
        maxCount = MAX_ATTACHMENTS_COUNT,
        maxFileBytes = MAX_ATTACHMENT_FILE_BYTES,
        maxClipboardBytes = MAX_CLIPBOARD_TEXT_BYTES,
        maxTotalBytes = MAX_TOTAL_ATTACHMENTS_BYTES,
    } = {}) {
        this._maxCount = maxCount;
        this._maxFileBytes = maxFileBytes;
        this._maxClipboardBytes = maxClipboardBytes;
        this._maxTotalBytes = maxTotalBytes;
        this._items = [];
    }

    get items() {
        return this._items;
    }

    get count() {
        return this._items.length;
    }

    get totalBytes() {
        return this._items.reduce((sum, it) => sum + (it.payloadBytes || 0), 0);
    }

    clear() {
        this._items = [];
    }

    remove(id) {
        const before = this._items.length;
        this._items = this._items.filter(it => it.id !== id);
        return this._items.length !== before;
    }

    togglePreview(id) {
        const item = this._items.find(it => it.id === id);
        if (!item) return false;
        item.previewExpanded = !item.previewExpanded;
        return item.previewExpanded;
    }

    /**
     * Adds a clipboard or terminal-selection text snippet WITHOUT truncating at 4,000 chars
     * and WITHOUT touching the caller's input entry draft!
     */
    addTextSnippet(rawText, {fromPrimarySelection = false, sourceHint = ''} = {}) {
        const classified = classifyTextSnippet(rawText, {fromPrimarySelection, sourceHint});
        const text = classified.cleanedText.trim();
        if (!text) {
            return {ok: false, error: '未检测到可引用的文本内容'};
        }
        if (this._items.length >= this._maxCount) {
            return {ok: false, error: `单次最多附加 ${this._maxCount} 个上下文引用`};
        }

        // Deduplicate exact same text snippet
        const existing = this._items.find(
            it => (it.kind === 'clipboard' || it.kind === 'terminal_log') && it.content === text
        );
        if (existing) {
            return {ok: true, deduplicated: true, item: existing};
        }

        const byteLength = UTF8_ENCODER.encode(text).byteLength;
        if (byteLength > this._maxClipboardBytes) {
            return {
                ok: false,
                error: `引用文本过大（${formatByteSize(byteLength)}），超出单条上限 ${formatByteSize(this._maxClipboardBytes)}`,
            };
        }
        if (this.totalBytes + byteLength > this._maxTotalBytes) {
            return {
                ok: false,
                error: `已附加引用总大小将超出 ${formatByteSize(this._maxTotalBytes)} 上限，请先移除部分附件`,
            };
        }

        const lineCount = text.split('\n').length;
        const item = {
            id: `att_${nextAttachmentSeq++}`,
            kind: classified.kind,
            sourceLabel: classified.sourceLabel,
            title: summarizeSnippetTitle(text),
            filePath: '',
            content: text,
            byteLength,
            payloadBytes: byteLength,
            sizeLabel: `${formatByteSize(byteLength)} · ${lineCount} 行`,
            previewText: buildAttachmentPreview(text),
            previewExpanded: false,
            isBinary: false,
            canToggleContent: false,
            warning: '',
        };
        this._items.push(item);
        return {ok: true, deduplicated: false, item};
    }

    /**
     * Adds a user-selected file (from Nautilus copied URI/path or explicit path input).
     * Automatically downgrades binary files or files exceeding `maxFileBytes` to safe path-only references
     * (`kind: 'file_path'`) with a clear explanation instead of reading/sending raw binary or huge payloads!
     */
    addFileCandidate({
        filePath,
        fileSize = 0,
        exists = true,
        isDirectory = false,
        tooLarge = false,
        bytes = null,
        preferPathOnly = false,
        sourceOrigin = 'Nautilus 选中文件',
    } = {}) {
        const cleanPath = String(filePath || '').trim();
        if (!cleanPath || !cleanPath.startsWith('/')) {
            return {ok: false, error: '文件路径必须是有效的本地绝对路径'};
        }
        if (!exists) {
            return {ok: false, error: `文件不存在：${cleanPath}`};
        }
        if (this._items.length >= this._maxCount) {
            return {ok: false, error: `单次最多附加 ${this._maxCount} 个上下文引用`};
        }

        const existing = this._items.find(it => it.filePath === cleanPath);
        if (existing) {
            return {ok: true, deduplicated: true, item: existing};
        }

        const baseName = cleanPath.split('/').pop() || cleanPath;

        if (isDirectory) {
            const metaLine = `目录路径: ${cleanPath}`;
            const payloadBytes = UTF8_ENCODER.encode(metaLine).byteLength;
            const item = {
                id: `att_${nextAttachmentSeq++}`,
                kind: 'file_path',
                sourceLabel: '目录路径引用',
                title: baseName,
                filePath: cleanPath,
                content: '',
                byteLength: 0,
                payloadBytes,
                sizeLabel: '仅路径',
                previewText: cleanPath,
                previewExpanded: false,
                isBinary: false,
                canToggleContent: false,
                warning: '目录仅发送路径标识，不会自动遍历上传目录内文件',
            };
            this._items.push(item);
            return {ok: true, deduplicated: false, item};
        }

        const binaryCheck = detectBinaryFile(bytes, cleanPath);
        const actualBytes = bytes instanceof Uint8Array
            ? bytes.byteLength
            : (Number(fileSize) || 0);
        const exceedsFileCap = Boolean(tooLarge || actualBytes > this._maxFileBytes);

        if (preferPathOnly || binaryCheck.isBinary || exceedsFileCap || !bytes) {
            let reasonNote = '仅发送路径';
            let warning = '';
            if (binaryCheck.isBinary) {
                reasonNote = '二进制 · 仅路径';
                warning = `检测到${binaryCheck.reason}，已自动转为仅引用路径，不会读取或上传二进制内容`;
            } else if (exceedsFileCap) {
                reasonNote = `超限 (${formatByteSize(actualBytes)}) · 仅路径`;
                warning = `文件超过 ${formatByteSize(this._maxFileBytes)} 正文内联上限，仅附带文件路径`;
            }
            const payloadBytes = UTF8_ENCODER.encode(cleanPath).byteLength;
            const item = {
                id: `att_${nextAttachmentSeq++}`,
                kind: 'file_path',
                sourceLabel: `${sourceOrigin}（路径）`,
                title: baseName,
                filePath: cleanPath,
                content: '',
                byteLength: actualBytes,
                payloadBytes,
                sizeLabel: actualBytes > 0 ? `${formatByteSize(actualBytes)} · ${reasonNote}` : reasonNote,
                previewText: warning ? `${cleanPath}\n（${warning}）` : cleanPath,
                previewExpanded: false,
                isBinary: binaryCheck.isBinary,
                canToggleContent: Boolean(!binaryCheck.isBinary && !exceedsFileCap && bytes),
                _cachedText: (!binaryCheck.isBinary && !exceedsFileCap && binaryCheck.decodedText) ? binaryCheck.decodedText : '',
                warning,
            };
            this._items.push(item);
            return {ok: true, deduplicated: false, item};
        }

        const decodedText = binaryCheck.decodedText ?? new TextDecoder('utf-8').decode(bytes);
        const contentBytes = UTF8_ENCODER.encode(decodedText).byteLength;
        if (this.totalBytes + contentBytes > this._maxTotalBytes) {
            return {
                ok: false,
                error: `附加文件正文后总大小将超出 ${formatByteSize(this._maxTotalBytes)} 上限，可改用「仅路径」或移除部分附件`,
            };
        }

        const lineCount = decodedText.split('\n').length;
        const item = {
            id: `att_${nextAttachmentSeq++}`,
            kind: 'file_content',
            sourceLabel: `${sourceOrigin}（正文）`,
            title: baseName,
            filePath: cleanPath,
            content: decodedText,
            byteLength: contentBytes,
            payloadBytes: contentBytes,
            sizeLabel: `${formatByteSize(contentBytes)} · ${lineCount} 行`,
            previewText: buildAttachmentPreview(decodedText),
            previewExpanded: false,
            isBinary: false,
            canToggleContent: true,
            _cachedText: decodedText,
            warning: '',
        };
        this._items.push(item);
        return {ok: true, deduplicated: false, item};
    }

    /**
     * Toggles a text file attachment between `file_content` (inlining file body) and `file_path` (path only).
     */
    toggleFileMode(id) {
        const item = this._items.find(it => it.id === id);
        if (!item || !item.filePath || !item.canToggleContent) {
            return {ok: false, error: '该文件不支持切换正文内联模式'};
        }
        if (item.kind === 'file_content') {
            item.kind = 'file_path';
            item.content = '';
            item.payloadBytes = UTF8_ENCODER.encode(item.filePath).byteLength;
            item.sourceLabel = '文件引用（仅路径）';
            item.sizeLabel = `${formatByteSize(item.byteLength)} · 仅路径`;
            item.previewText = item.filePath;
            return {ok: true, mode: 'file_path'};
        }

        const text = item._cachedText || '';
        const textBytes = UTF8_ENCODER.encode(text).byteLength;
        const otherBytes = this.totalBytes - item.payloadBytes;
        if (otherBytes + textBytes > this._maxTotalBytes) {
            return {ok: false, error: `切换为正文将超出 ${formatByteSize(this._maxTotalBytes)} 总附件上限`};
        }
        item.kind = 'file_content';
        item.content = text;
        item.payloadBytes = textBytes;
        item.sourceLabel = '文件引用（正文）';
        item.sizeLabel = `${formatByteSize(textBytes)} · ${text.split('\n').length} 行`;
        item.previewText = buildAttachmentPreview(text);
        return {ok: true, mode: 'file_content'};
    }

    /**
     * Generates an explicit outbound scope notice BEFORE sending so the user clearly sees
     * what local data will leave the machine or enter the model context.
     */
    buildOutboundScopeNotice(effectiveBackend = 'openai', {endpointUrl = ''} = {}) {
        if (this._items.length === 0) return '';
        const totalStr = formatByteSize(this.totalBytes);
        const kinds = new Set(this._items.map(it => it.kind));
        const parts = [];
        if (kinds.has('file_content')) parts.push('文件正文');
        if (kinds.has('file_path')) parts.push('文件路径');
        if (kinds.has('terminal_log')) parts.push('终端日志');
        if (kinds.has('clipboard')) parts.push('剪贴板文本');
        const summaryDesc = `${this._items.length} 项（含${parts.join('、')}，共 ${totalStr}）`;

        if (effectiveBackend === 'openai') {
            let hostLabel = '远程 API 接口';
            try {
                if (endpointUrl) {
                    const u = parseUrlPortable(endpointUrl);
                    hostLabel = u.host || hostLabel;
                }
            } catch (_) {}
            return `☁️ 发送范围确认：发送时将向 ${hostLabel} 上传以上 ${summaryDesc}，点击 ✕ 可移除敏感项`;
        }
        const backendName = effectiveBackend === 'codex' ? 'Codex CLI' : 'ZCode CLI';
        return `📎 发送范围确认：发送时将向 ${backendName} 模型上下文附带以上 ${summaryDesc}`;
    }

    /**
     * Composes the outbound model prompt and compact UI user card display text.
     */
    composeTurnPayload(userDraft = '') {
        const cleanDraft = String(userDraft || '').trim();
        if (this._items.length === 0) {
            return {
                hasAttachments: false,
                promptForModel: cleanDraft,
                displayUserText: cleanDraft,
            };
        }

        const effectiveQuestion = cleanDraft || '请帮我分析、解释或处理所附带的上下文内容。';
        const contextBlocks = this._items.map((it, idx) => {
            if (it.kind === 'file_path') {
                const note = it.isBinary ? ' (二进制文件，仅提供路径)' : '';
                return `[附件 ${idx + 1} · ${it.sourceLabel}]\n路径: ${it.filePath}${note}`;
            }
            const pathHeader = it.filePath ? `\n路径: ${it.filePath}` : '';
            return `[附件 ${idx + 1} · ${it.sourceLabel} · ${it.title} (${it.sizeLabel})]${pathHeader}\n\`\`\`\n${it.content}\n\`\`\``;
        });

        const promptForModel = `${effectiveQuestion}\n\n---\n以下为用户主动附带的上下文引用（共 ${this._items.length} 项）：\n\n${contextBlocks.join('\n\n')}`;
        const badgeSummary = this._items
            .map(it => `📎 ${it.sourceLabel}: ${it.title} (${it.sizeLabel})`)
            .join('\n');
        const displayUserText = `${badgeSummary}\n\n${effectiveQuestion}`;

        return {
            hasAttachments: true,
            promptForModel,
            displayUserText,
        };
    }
}
