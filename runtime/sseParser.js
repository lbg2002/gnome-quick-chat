/**
 * Pure-JS event-based OpenAI SSE parser, `/models` validator, error redactor,
 * and split timeout policy (Stage C3, zero GJS dependencies).
 *
 * Handles:
 * - Arbitrary TCP byte-chunk boundaries across multi-byte UTF-8 (Chinese, emoji) and `\r\n` splits
 * - Blank-line event framing (`\n\n`, `\r\n\r\n`, `\r\r`), multi-line `data:`, `: comment` lines, `event:`
 * - `[DONE]`, `finish_reason`, `usage`, mid-stream API `error`, and valid non-SSE JSON fallback
 * - Strict byte caps on SSE events, non-SSE JSON bodies, HTTP error bodies, and `/models` responses
 * - Redaction of API keys / Bearer tokens before surfacing errors to UI or logs
 */

const UTF8_ENCODER = new TextEncoder();

export const DEFAULT_SSE_LIMITS = Object.freeze({
    maxEventBytes: 512 * 1024,       // 512 KiB per SSE event frame
    maxNonSseBytes: 2 * 1024 * 1024, // 2 MiB for non-streaming JSON fallback body
    maxErrorBodyBytes: 32 * 1024,    // 32 KiB for HTTP non-2xx error body
    maxModelsBodyBytes: 1024 * 1024, // 1 MiB for GET /models catalog response
});

export const DEFAULT_TIMEOUT_POLICY = Object.freeze({
    connectTimeoutSec: 20,
    firstByteTimeoutSec: 45,
    streamIdleTimeoutSec: 90,
    toolExecutionTimeoutSec: 300,
    approvalTimeoutSec: 300,
    totalTurnTimeoutSec: 900,
});

const TERMINAL_FINISH_REASONS = new Set([
    'stop',
    'length',
    'content_filter',
    'tool_calls',
    'function_call',
    'end_turn',
]);

// Known OpenAI-compatible model prefixes/ids that accept the `reasoning_effort` field
const REASONING_EFFORT_MODEL_RE = /^(?:o1|o3|o4|gpt-5|codex-mini|qwq)(?:[-._:/]|$)|(?:^|\/)(?:o1|o3|o4|gpt-5|deepseek-reasoner|qwq)(?:[-._:]|$)/i;

export function redactSensitiveText(rawText, {apiKey = '', maxChars = 320} = {}) {
    let text = String(rawText ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim();
    if (!text) return '';

    const cleanKey = String(apiKey || '').trim();
    if (cleanKey.length >= 6) {
        text = text.split(cleanKey).join('[REDACTED_KEY]');
    }

    text = text
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, 'sk-[REDACTED]')
        .replace(/([?&](?:api_key|apikey|key|access_token|token)=)[^&\s"']+/gi, '$1[REDACTED]')
        .replace(/("?(?:apiKey|api_key|authorization|access_token)"?\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');

    if (maxChars > 0 && text.length > maxChars) {
        return `${text.slice(0, maxChars)}…`;
    }
    return text;
}

export function supportsOpenAIReasoningEffort(modelId, explicitCapability = null) {
    if (typeof explicitCapability === 'boolean') {
        return explicitCapability;
    }
    const clean = String(modelId || '').trim();
    if (!clean) return false;
    return REASONING_EFFORT_MODEL_RE.test(clean);
}

export function formatSanitizedHttpError(status, reasonPhrase = '', rawBody = '', {apiKey = ''} = {}) {
    const base = `HTTP ${status}${reasonPhrase ? ` (${reasonPhrase})` : ''}`;
    const trimmed = String(rawBody || '').trim();
    if (!trimmed) return base;

    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            const msg = parsed?.error?.message || parsed?.message || parsed?.detail || '';
            if (msg) {
                return redactSensitiveText(`${base}: ${msg}`, {apiKey, maxChars: 280});
            }
        } catch (_) {}
    }
    return redactSensitiveText(`${base}: ${trimmed.replace(/\s+/g, ' ')}`, {apiKey, maxChars: 240});
}

/**
 * Validates HTTP status BEFORE parsing `/models` JSON, enforces byte ceiling,
 * and prioritizes the user's configured model over `data[0].id`.
 */
export function parseModelsResponse(status, rawBytesOrText, {
    preferredModel = '',
    maxBytes = DEFAULT_SSE_LIMITS.maxModelsBodyBytes,
    apiKey = '',
} = {}) {
    const isBytes = rawBytesOrText instanceof Uint8Array;
    const byteLength = isBytes
        ? rawBytesOrText.byteLength
        : UTF8_ENCODER.encode(String(rawBytesOrText ?? '')).byteLength;

    if (status < 200 || status >= 300) {
        const preview = isBytes
            ? new TextDecoder('utf-8', {fatal: false}).decode(rawBytesOrText.subarray(0, 4096))
            : String(rawBytesOrText ?? '').slice(0, 4096);
        throw new Error(`拉取 /models 失败（${formatSanitizedHttpError(status, '', preview, {apiKey})}）`);
    }

    if (byteLength > maxBytes) {
        throw new Error(`/models 响应体积超过安全上限（${Math.ceil(byteLength / 1024)} KB > ${Math.ceil(maxBytes / 1024)} KB）`);
    }

    const bodyText = isBytes
        ? new TextDecoder('utf-8', {fatal: false}).decode(rawBytesOrText)
        : String(rawBytesOrText ?? '');

    let parsed;
    try {
        parsed = JSON.parse(bodyText);
    } catch (_) {
        throw new Error('/models 返回了非法的 JSON 格式');
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('/models 响应结构无效');
    }
    if (parsed.error) {
        const errMsg = parsed.error?.message || JSON.stringify(parsed.error);
        throw new Error(`拉取 /models 失败：${redactSensitiveText(errMsg, {apiKey, maxChars: 200})}`);
    }

    const rawItems = Array.isArray(parsed.data)
        ? parsed.data
        : (Array.isArray(parsed.models) ? parsed.models : []);

    const models = [];
    const metadataById = {};
    const seen = new Set();

    for (const item of rawItems) {
        const id = String(item?.id || item?.name || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push(id);
        const contextWindow = Number(
            item?.context_length ||
            item?.context_window ||
            item?.max_context_length ||
            item?.input_token_limit ||
            0
        );
        if (contextWindow > 0) {
            metadataById[id] = {contextWindowTokens: contextWindow};
        }
    }

    const userSelected = String(preferredModel || '').trim();
    const selectedModel = userSelected || models[0] || '';

    return {
        models,
        selectedModel,
        metadataById,
    };
}

/**
 * Resolves phase-appropriate timeout values so long CLI tool executions and user approvals
 * are never prematurely aborted by short stream-token timeouts.
 */
export function resolveSplitTimeouts(custom = {}) {
    return {
        connectTimeoutSec: Math.max(5, Number(custom.connectTimeoutSec) || DEFAULT_TIMEOUT_POLICY.connectTimeoutSec),
        firstByteTimeoutSec: Math.max(10, Number(custom.firstByteTimeoutSec) || DEFAULT_TIMEOUT_POLICY.firstByteTimeoutSec),
        streamIdleTimeoutSec: Math.max(15, Number(custom.streamIdleTimeoutSec) || DEFAULT_TIMEOUT_POLICY.streamIdleTimeoutSec),
        toolExecutionTimeoutSec: Math.max(30, Number(custom.toolExecutionTimeoutSec) || DEFAULT_TIMEOUT_POLICY.toolExecutionTimeoutSec),
        approvalTimeoutSec: Math.max(30, Number(custom.approvalTimeoutSec) || DEFAULT_TIMEOUT_POLICY.approvalTimeoutSec),
        totalTurnTimeoutSec: Math.max(60, Number(custom.totalTurnTimeoutSec) || DEFAULT_TIMEOUT_POLICY.totalTurnTimeoutSec),
    };
}

function extractThinkingString(sourceObj) {
    if (!sourceObj || typeof sourceObj !== 'object') return '';
    const candidate = sourceObj.reasoning_content ?? sourceObj.reasoning ?? sourceObj.thinking ?? '';
    return typeof candidate === 'string' ? candidate : '';
}

function extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(part => (typeof part === 'string' ? part : (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')))
            .join('');
    }
    return '';
}

/**
 * Incremental W3C SSE + Non-SSE JSON Fallback Parser for OpenAI-compatible `/chat/completions`.
 */
export class OpenAISseParser {
    constructor({
        limits = {},
        apiKey = '',
    } = {}) {
        this._limits = {...DEFAULT_SSE_LIMITS, ...limits};
        this._apiKey = String(apiKey || '');
        this._decoder = new TextDecoder('utf-8', {fatal: false});

        this._lineBuffer = '';
        this._pendingCR = false;

        this._currentEventType = '';
        this._currentDataLines = [];
        this._currentEventBytes = 0;

        this._sawSseFraming = false;
        this._nonSseLines = [];
        this._nonSseBytes = 0;

        this.sawDone = false;
        this.finishReason = '';
        this.model = '';
        this.usage = null;
        this.fatalError = '';
    }

    /**
     * Feeds a raw `Uint8Array` chunk from the network socket and returns normalized SSE records:
     * `{type: 'delta'|'done'|'error', textDelta?, thinkingDelta?, finishReason?, usage?, model?, error?}`
     */
    pushBytes(chunk) {
        if (!chunk || chunk.byteLength === 0) return [];
        const decoded = this._decoder.decode(chunk, {stream: true});
        return this.pushText(decoded);
    }

    pushText(chunkStr) {
        if (this.fatalError || !chunkStr) return [];
        let str = String(chunkStr);
        if (this._pendingCR) {
            this._pendingCR = false;
            if (str.startsWith('\n')) {
                str = str.slice(1);
            }
        }
        if (str.endsWith('\r')) {
            this._pendingCR = true;
            str = `${str.slice(0, -1)}\n`;
        }
        str = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        this._lineBuffer += str;

        // Guard against unbounded single line without newline
        const bufBytes = UTF8_ENCODER.encode(this._lineBuffer).byteLength;
        const maxSingleBuf = Math.max(this._limits.maxEventBytes, this._limits.maxNonSseBytes);
        if (bufBytes > maxSingleBuf) {
            this.fatalError = `响应流单段体积超过安全上限（>${Math.ceil(maxSingleBuf / 1024)} KB）`;
            this._lineBuffer = '';
            return [{type: 'error', error: this.fatalError}];
        }

        const out = [];
        let nlIdx;
        while ((nlIdx = this._lineBuffer.indexOf('\n')) !== -1) {
            const line = this._lineBuffer.slice(0, nlIdx);
            this._lineBuffer = this._lineBuffer.slice(nlIdx + 1);
            this._processLine(line, out);
            if (this.fatalError || this.sawDone) break;
        }
        return out;
    }

    _processLine(line, out) {
        // Blank line = end of current SSE event!
        if (line === '') {
            if (this._currentDataLines.length > 0 || this._currentEventType) {
                this._dispatchCurrentEvent(out);
            }
            return;
        }

        // Comment / heartbeat line (`: ping`)
        if (line.startsWith(':')) {
            this._sawSseFraming = true;
            return;
        }

        if (line.startsWith('event:')) {
            this._sawSseFraming = true;
            this._currentEventType = line.slice(6).trim();
            return;
        }

        if (line.startsWith('id:') || line.startsWith('retry:')) {
            this._sawSseFraming = true;
            return;
        }

        if (line.startsWith('data:')) {
            this._sawSseFraming = true;
            let value = line.slice(5);
            if (value.startsWith(' ')) value = value.slice(1);
            const addedBytes = UTF8_ENCODER.encode(value).byteLength + 1;
            if (this._currentEventBytes + addedBytes > this._limits.maxEventBytes) {
                this.fatalError = `单条 SSE 事件超过大小上限（>${Math.ceil(this._limits.maxEventBytes / 1024)} KB）`;
                out.push({type: 'error', error: this.fatalError});
                return;
            }
            this._currentEventBytes += addedBytes;
            this._currentDataLines.push(value);
            return;
        }

        // Non-SSE line (e.g. a proxy returning `application/json` despite `stream: true`)
        if (!this._sawSseFraming) {
            const addedBytes = UTF8_ENCODER.encode(line).byteLength + 1;
            if (this._nonSseBytes + addedBytes > this._limits.maxNonSseBytes) {
                this.fatalError = `非流式响应超过大小上限（>${Math.ceil(this._limits.maxNonSseBytes / 1024)} KB）`;
                out.push({type: 'error', error: this.fatalError});
                return;
            }
            this._nonSseBytes += addedBytes;
            this._nonSseLines.push(line);
        }
    }

    _dispatchCurrentEvent(out) {
        const eventType = this._currentEventType;
        const dataPayload = this._currentDataLines.join('\n').trim();
        this._currentEventType = '';
        this._currentDataLines = [];
        this._currentEventBytes = 0;

        if (!dataPayload) return;
        if (dataPayload === '[DONE]') {
            this.sawDone = true;
            out.push({type: 'done', finishReason: this.finishReason || 'stop', usage: this.usage});
            return;
        }

        let obj;
        try {
            obj = JSON.parse(dataPayload);
        } catch (_) {
            if (eventType === 'error') {
                const msg = redactSensitiveText(dataPayload, {apiKey: this._apiKey, maxChars: 240});
                this.fatalError = msg || 'SSE 错误事件';
                out.push({type: 'error', error: this.fatalError});
            }
            return;
        }

        if (!obj || typeof obj !== 'object') return;

        if (obj.error || eventType === 'error') {
            const rawErr = obj.error?.message || obj.message || JSON.stringify(obj.error || obj);
            this.fatalError = redactSensitiveText(rawErr, {apiKey: this._apiKey, maxChars: 280});
            out.push({type: 'error', error: this.fatalError});
            return;
        }

        if (typeof obj.model === 'string' && obj.model) {
            this.model = obj.model;
        }
        if (obj.usage && typeof obj.usage === 'object') {
            this.usage = obj.usage;
        }

        const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
        if (choice && typeof choice === 'object') {
            if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
                this.finishReason = choice.finish_reason;
            }
            const delta = choice.delta || {};
            const textDelta = extractTextContent(delta.content);
            const thinkingDelta = extractThinkingString(delta);

            if (textDelta || thinkingDelta || choice.finish_reason || obj.usage) {
                out.push({
                    type: 'delta',
                    model: this.model,
                    textDelta,
                    thinkingDelta,
                    finishReason: this.finishReason,
                    usage: this.usage,
                });
            }
        } else if (obj.usage) {
            out.push({
                type: 'delta',
                model: this.model,
                textDelta: '',
                thinkingDelta: '',
                finishReason: this.finishReason,
                usage: this.usage,
            });
        }
    }

    /**
     * Flushes decoder tail at EOF and determines whether the stream completed cleanly,
     * fell back to a valid non-SSE JSON response, or terminated prematurely (`interrupted`).
     * Never injects network warning strings into assistant message text!
     */
    finish() {
        const trailingEvents = [];
        if (!this.fatalError && !this.sawDone) {
            const tail = this._decoder.decode(new Uint8Array(0), {stream: false});
            if (tail) {
                trailingEvents.push(...this.pushText(tail));
            }
            if (!this.fatalError && !this.sawDone) {
                if (this._lineBuffer.length > 0) {
                    const lastLine = this._lineBuffer;
                    this._lineBuffer = '';
                    this._processLine(lastLine, trailingEvents);
                }
                if (!this.fatalError && !this.sawDone && (this._currentDataLines.length > 0 || this._currentEventType)) {
                    this._dispatchCurrentEvent(trailingEvents);
                }
            }
        }

        if (this.fatalError) {
            return {
                events: trailingEvents,
                completedCleanly: false,
                interrupted: false,
                finishReason: this.finishReason,
                usage: this.usage,
                model: this.model,
                error: this.fatalError,
            };
        }

        // Valid non-SSE JSON fallback (when server returned a single `application/json` ChatCompletion)
        if (!this._sawSseFraming && this._nonSseLines.length > 0) {
            const joined = this._nonSseLines.join('\n').trim();
            if (joined.startsWith('{')) {
                try {
                    const obj = JSON.parse(joined);
                    if (obj?.error) {
                        const errMsg = redactSensitiveText(
                            obj.error?.message || JSON.stringify(obj.error),
                            {apiKey: this._apiKey, maxChars: 280}
                        );
                        return {
                            events: trailingEvents,
                            completedCleanly: false,
                            interrupted: false,
                            finishReason: '',
                            usage: null,
                            model: this.model,
                            error: errMsg,
                        };
                    }
                    const choice = Array.isArray(obj?.choices) ? obj.choices[0] : null;
                    const message = choice?.message || {};
                    const fullText = extractTextContent(message.content);
                    const fullThinking = extractThinkingString(message);
                    if (typeof obj?.model === 'string' && obj.model) this.model = obj.model;
                    if (obj?.usage && typeof obj.usage === 'object') this.usage = obj.usage;
                    if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
                        this.finishReason = choice.finish_reason;
                    }
                    if (choice && (fullText || fullThinking || choice.finish_reason)) {
                        return {
                            events: trailingEvents,
                            completedCleanly: true,
                            interrupted: false,
                            isNonSseJson: true,
                            nonSseText: fullText,
                            nonSseThinking: fullThinking,
                            finishReason: this.finishReason || 'stop',
                            usage: this.usage,
                            model: this.model,
                            error: '',
                        };
                    }
                } catch (_) {
                    return {
                        events: trailingEvents,
                        completedCleanly: false,
                        interrupted: true,
                        finishReason: '',
                        usage: null,
                        model: this.model,
                        error: '响应连接在完整 JSON 返回前中断',
                    };
                }
            }
        }

        const hasCleanTerminalMarker = Boolean(
            this.sawDone ||
            (this._sawSseFraming && TERMINAL_FINISH_REASONS.has(this.finishReason))
        );

        return {
            events: trailingEvents,
            completedCleanly: hasCleanTerminalMarker,
            interrupted: !hasCleanTerminalMarker,
            finishReason: this.finishReason,
            usage: this.usage,
            model: this.model,
            error: hasCleanTerminalMarker ? '' : '响应流未正常结束（未收到 [DONE] 或完成标记，回答可能不完整）',
        };
    }
}
