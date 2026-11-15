/**
 * Pure-JS Incremental Streaming Markdown-to-Pango Parser (Stage D1, zero GJS dependencies).
 *
 * Key optimizations over full-string `parseMarkdownBlocks(rawText)`:
 * 1. Maintains a checkpoint at the start of the active trailing line (`_checkpointOffset`):
 *    - Completed blocks (`_confirmedBlocks`) are frozen and NEVER re-parsed on subsequent `append`/`update` calls.
 *    - Completed lines inside an open text block cache their `formatLineToPango(line)` output so appending tokens
 *      to line N never re-runs regexes on lines `0 .. N - 1`.
 * 2. Handles arbitrary chunk boundaries cleanly: `\r\n` split across chunks, multi-byte Chinese/emoji characters,
 *    split ```` ```lang ```` fences, unclosed inline formatting, and Pango/XML tag injection.
 * 3. Supports `text_replace` (non-prefix updates) via automatic reset + re-parse (`replaced: true`).
 * 4. Defers expensive inline regex formatting on huge streaming paragraphs (`> deferFormattingThresholdChars`)
 *    until stream completion (`finalize: true`), while ALWAYS preserving exact raw copyable text/code.
 */

export const DEFAULT_DEFER_MARKUP_CHARS = 12000;

export function escapePango(text) {
    if (typeof text !== 'string' || !text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function inlineMarkdownToPango(text) {
    if (typeof text !== 'string' || !text) return '';
    const codeSpans = [];
    // Extract inline code spans into placeholders first so outer **bold** / *italic* can wrap them cleanly.
    const withPlaceholders = text.replace(/`([^`\n]+)`/g, (_, inner) => {
        const idx = codeSpans.length;
        codeSpans.push(`<tt>${escapePango(inner)}</tt>`);
        return `\u0000CODE_${idx}\u0000`;
    });

    let escaped = escapePango(withPlaceholders);
    // Markdown links [label](url) -> underlined label (url)
    escaped = escaped.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<u>$1</u> <small>($2)</small>');
    // Bold **text** or __text__
    escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    escaped = escaped.replace(/__([^_\n]+)__/g, '<b>$1</b>');
    // Italic *text*
    escaped = escaped.replace(/(^|[\s(（])\*([^*\n]+)\*(?=$|[\s).,!?:;，。！？：；）])/g, '$1<i>$2</i>');
    // Strikethrough ~~text~~
    escaped = escaped.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

    return escaped.replace(/\u0000CODE_(\d+)\u0000/g, (_, idx) => codeSpans[Number(idx)] ?? '');
}

export function formatLineToPango(line) {
    const trimmed = line.trimStart();
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
        const content = inlineMarkdownToPango(headingMatch[2].trim());
        return `<b>${content}</b>`;
    }
    const bulletMatch = /^(\s*)([-*+])\s+(.+)$/.exec(line);
    if (bulletMatch) {
        const indent = '  '.repeat(Math.min(4, Math.floor(bulletMatch[1].length / 2)));
        return `${indent}• ${inlineMarkdownToPango(bulletMatch[3])}`;
    }
    const orderedMatch = /^(\s*)(\d+[.)])\s+(.+)$/.exec(line);
    if (orderedMatch) {
        const indent = '  '.repeat(Math.min(4, Math.floor(orderedMatch[1].length / 2)));
        return `${indent}<b>${escapePango(orderedMatch[2])}</b> ${inlineMarkdownToPango(orderedMatch[3])}`;
    }
    const quoteMatch = /^>\s?(.*)$/.exec(trimmed);
    if (quoteMatch) {
        return `┃ <i>${inlineMarkdownToPango(quoteMatch[1])}</i>`;
    }
    if (/^([-*_])\1{2,}\s*$/.test(trimmed)) {
        return '────────────';
    }
    return inlineMarkdownToPango(line);
}

const OPEN_FENCE_RE = /^\s*```([\w.+-]*)\s*$/;
const CLOSE_FENCE_RE = /^\s*```\s*$/;

function buildTextBlockFromLines(rawLines, pangoLines, {deferFormatting = false} = {}) {
    if (!rawLines.length) return null;
    let start = 0;
    let end = rawLines.length - 1;
    // Strip leading & trailing empty lines identically to `raw.replace(/^\n+|\n+$/g, '')`
    while (start <= end && rawLines[start] === '') start++;
    while (end >= start && rawLines[end] === '') end--;
    if (start > end) return null;

    const slicedRaw = rawLines.slice(start, end + 1);
    const raw = slicedRaw.join('\n');
    if (!raw) return null;

    if (deferFormatting) {
        return {
            type: 'text',
            raw,
            pango: escapePango(raw),
            deferredFormatting: true,
        };
    }

    const pangoParts = [];
    for (let i = start; i <= end; i++) {
        let formatted = pangoLines[i];
        if (formatted === null || formatted === undefined) {
            formatted = formatLineToPango(rawLines[i]);
            pangoLines[i] = formatted;
        }
        pangoParts.push(formatted);
    }
    return {
        type: 'text',
        raw,
        pango: pangoParts.join('\n'),
    };
}

export function parseMarkdownBlocks(markdown) {
    if (typeof markdown !== 'string' || !markdown) return [];
    const parser = new StreamingMarkdownParser({deferMarkupThresholdChars: Infinity});
    return parser.update(markdown, {finalize: true}).blocks;
}

export class StreamingMarkdownParser {
    constructor({
        deferMarkupThresholdChars = DEFAULT_DEFER_MARKUP_CHARS,
    } = {}) {
        this._deferThreshold = Math.max(1024, Number(deferMarkupThresholdChars) || DEFAULT_DEFER_MARKUP_CHARS);
        this.reset();
    }

    reset() {
        this._rawInput = '';
        this._normalizedPrefix = '';
        this._checkpointOffset = 0;

        this._confirmedBlocks = [];
        this._inCode = false;
        this._codeLang = '';
        this._codeLines = [];
        this._codeCharCount = 0;

        this._textRawLines = [];
        this._textPangoLines = [];
        this._textCharCount = 0;

        this.stats = {
            incrementalUpdates: 0,
            fullResets: 0,
            linesFormatted: 0,
        };
    }

    get confirmedBlockCount() {
        return this._confirmedBlocks.length;
    }

    _consumeCompletedLine(line, allowLazyTextPango) {
        if (!this._inCode) {
            const fenceMatch = OPEN_FENCE_RE.exec(line);
            if (fenceMatch) {
                const flushed = buildTextBlockFromLines(this._textRawLines, this._textPangoLines, {deferFormatting: false});
                if (flushed) {
                    this._confirmedBlocks.push(flushed);
                }
                this._textRawLines = [];
                this._textPangoLines = [];
                this._textCharCount = 0;

                this._inCode = true;
                this._codeLang = (fenceMatch[1] || '').trim().toLowerCase();
                this._codeLines = [];
                this._codeCharCount = 0;
                return;
            }

            this._textRawLines.push(line);
            this._textCharCount += line.length + 1;
            if (allowLazyTextPango && this._textCharCount > this._deferThreshold) {
                this._textPangoLines.push(null);
            } else {
                this._textPangoLines.push(formatLineToPango(line));
                this.stats.linesFormatted++;
            }
            return;
        }

        if (CLOSE_FENCE_RE.test(line)) {
            this._confirmedBlocks.push({
                type: 'code',
                lang: this._codeLang || 'code',
                code: this._codeLines.join('\n'),
                closed: true,
            });
            this._inCode = false;
            this._codeLang = '';
            this._codeLines = [];
            this._codeCharCount = 0;
            return;
        }

        this._codeLines.push(line);
        this._codeCharCount += line.length + 1;
    }

    /**
     * Updates the parser state for `nextRawMarkdown` (either a prefix extension or a full replacement)
     * and returns `{blocks, confirmedCount, tailBlocks, replaced}`.
     */
    update(nextRawMarkdown, {finalize = false} = {}) {
        const raw = typeof nextRawMarkdown === 'string' ? nextRawMarkdown : '';
        if (!raw) {
            const hadPrior = this._rawInput.length > 0;
            this.reset();
            return {
                blocks: [],
                confirmedCount: 0,
                tailBlocks: [],
                replaced: hadPrior,
            };
        }

        let replaced = false;
        // Detect non-prefix replacement (`text_replace`) OR `\r` at boundary where `\n` arrived next
        if (this._rawInput && !raw.startsWith(this._rawInput)) {
            this.reset();
            this.stats.fullResets++;
            replaced = true;
        } else if (this._rawInput && raw.length > this._rawInput.length) {
            this.stats.incrementalUpdates++;
        }

        // Normalize only the newly appended suffix from `_checkpointOffset`!
        // Because `_checkpointOffset` always points to the start of the last (unterminated) line in `_normalizedPrefix`,
        // we compute normalized text only from the raw equivalent or incrementally normalize delta.
        if (this._rawInput === '') {
            this._normalizedPrefix = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        } else if (raw.length > this._rawInput.length) {
            let delta = raw.slice(this._rawInput.length);
            if (this._rawInput.endsWith('\r') && delta.startsWith('\n')) {
                // Previous trailing `\r` was already normalized to `\n` in `_normalizedPrefix`; drop the paired `\n`!
                delta = delta.slice(1);
            }
            if (delta) {
                this._normalizedPrefix += delta.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            }
        }
        this._rawInput = raw;

        const allowLazyTextPango = !finalize;

        // Consume all newly completed `\n`-terminated lines starting from `_checkpointOffset`
        let nlIdx = this._normalizedPrefix.indexOf('\n', this._checkpointOffset);
        // Note: if the normalized string ends right at `\n` AND raw ended with `\r` (possible `\r\n` split across chunks),
        // hold off committing that last line until we know whether `\n` follows or more chars arrive?
        // Actually even if `\n` follows `\r`, the line before `\r` IS already terminated! Dropping the paired `\n` above
        // keeps `_normalizedPrefix` 100% identical!
        while (nlIdx !== -1) {
            const line = this._normalizedPrefix.slice(this._checkpointOffset, nlIdx);
            this._checkpointOffset = nlIdx + 1;
            this._consumeCompletedLine(line, allowLazyTextPango);
            nlIdx = this._normalizedPrefix.indexOf('\n', this._checkpointOffset);
        }

        // Handle the single unterminated trailing line (`_checkpointOffset .. end`) WITHOUT mutating committed state!
        const hasTailSlice = this._checkpointOffset <= this._normalizedPrefix.length;
        const tailLine = hasTailSlice ? this._normalizedPrefix.slice(this._checkpointOffset) : '';
        // Note: `split('\n')` on `"abc\n"` has a trailing `""` element after `\n`!
        // Let's match `markdown.replace(/\r\n/g, '\n').split('\n')` semantics 100%:
        const tailBlocks = this._computeTailBlocks(tailLine, finalize);

        // Ensure any deferred formatting on already-confirmed blocks is not possible (flushed with deferFormatting: false),
        // and on `finalize === true`, tailBlocks also have `deferFormatting: false`.
        const blocks = this._confirmedBlocks.concat(tailBlocks);

        return {
            blocks,
            confirmedCount: this._confirmedBlocks.length,
            tailBlocks,
            replaced,
        };
    }

    _computeTailBlocks(tailLine, finalize) {
        const deferFormatting = !finalize && (this._textCharCount + tailLine.length > this._deferThreshold);

        if (!this._inCode) {
            const fenceMatch = OPEN_FENCE_RE.exec(tailLine);
            if (fenceMatch) {
                const out = [];
                const flushed = buildTextBlockFromLines(
                    this._textRawLines,
                    [...this._textPangoLines],
                    {deferFormatting: false}
                );
                if (flushed) out.push(flushed);
                out.push({
                    type: 'code',
                    lang: (fenceMatch[1] || '').trim().toLowerCase() || 'code',
                    code: '',
                    closed: false,
                });
                return out;
            }

            const combinedRaw = [...this._textRawLines, tailLine];
            const combinedPango = [
                ...this._textPangoLines,
                deferFormatting ? null : formatLineToPango(tailLine),
            ];
            if (!deferFormatting) {
                this.stats.linesFormatted++;
            }
            const textBlock = buildTextBlockFromLines(combinedRaw, combinedPango, {deferFormatting});
            return textBlock ? [textBlock] : [];
        }

        // Currently inside a fenced code block (`this._inCode === true`)
        if (CLOSE_FENCE_RE.test(tailLine)) {
            return [{
                type: 'code',
                lang: this._codeLang || 'code',
                code: this._codeLines.join('\n'),
                closed: true,
            }];
        }

        const combinedCode = [...this._codeLines, tailLine].join('\n');
        return [{
            type: 'code',
            lang: this._codeLang || 'code',
            code: combinedCode,
            closed: false,
        }];
    }
}
