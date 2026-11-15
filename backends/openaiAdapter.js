// OpenAI-Compatible HTTP Streaming Backend Adapter (Stage E).
// Pure Q&A over Soup 3.0 HTTP/SSE with strict TLS, cross-origin redirect Authorization guard,
// cancellable `/models` discovery, whole-turn context budgeting, and split timeouts.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {BaseBackendAdapter} from './baseAdapter.js';
import {
    buildBudgetedContextMessages,
    preparePromptWithinBudget,
} from '../protocol.js';
import {
    inspectEndpointSecurity,
    shouldStripAuthOnRedirect,
} from '../core/secretPolicy.js';
import {
    DEFAULT_SSE_LIMITS,
    OpenAISseParser,
    formatSanitizedHttpError,
    parseModelsResponse,
    redactSensitiveText,
    resolveSplitTimeouts,
    supportsOpenAIReasoningEffort,
} from '../runtime/sseParser.js';
import {attachTurnWatchdog} from '../runtime/processManager.js';

const Encoder = new TextEncoder();
const Decoder = new TextDecoder('utf-8');

/**
 * Strips the `Authorization` header automatically if an HTTP 30x redirect crosses origins
 * or downgrades `https://` -> `http://`.
 */
export function attachCrossOriginRedirectGuard(msg, initialUrl) {
    if (!msg || typeof msg.connect !== 'function') return 0;
    return msg.connect('restarted', m => {
        try {
            const nextUri = m.get_uri?.()?.to_string?.() || '';
            if (shouldStripAuthOnRedirect(initialUrl, nextUri)) {
                m.get_request_headers?.()?.remove?.('Authorization');
            }
        } catch (_) {
            try { m.get_request_headers?.()?.remove?.('Authorization'); } catch (__) {}
        }
    });
}

export class OpenAIAdapter extends BaseBackendAdapter {
    constructor({
        turns,
        store,
        getSessionContextConfig,
        emitEvent,
        clientGeneration = 0,
    } = {}) {
        super('openai', {emitEvent});
        this._turns = turns;
        this._store = store;
        this._getSessionContextConfig = getSessionContextConfig || (() => ({}));
        this._clientGeneration = clientGeneration;
        this._httpSession = null;
    }

    initialize(runtime, config = {}, {timeouts = null} = {}) {
        super.initialize(runtime, config);
        const resolved = timeouts || resolveSplitTimeouts(config);
        this._httpSession = new Soup.Session({
            timeout: resolved.streamIdleTimeoutSec,
        });
        if (this._runtime && !this._runtime.modelMetadata) {
            this._runtime.modelMetadata = {};
        }
        return this;
    }

    updateApiKey(apiKey) {
        const clean = String(apiKey || '').trim();
        if (this._config) this._config.openaiApiKey = clean;
        if (this._runtime) this._runtime.apiKey = clean;
    }

    getModels({cancellable = null} = {}) {
        if (!this._httpSession || this._disposed) {
            return Promise.reject(new Error('OpenAI HTTP 会话已关闭'));
        }
        const userPreferredModel = String(this._runtime?.modelId || '').trim();
        const modelsUrl = this._runtime?.modelsUrl || '';
        const apiKey = this._runtime?.apiKey || '';

        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', modelsUrl);
            if (!msg) {
                reject(new Error(`无效的接口地址：${modelsUrl}`));
                return;
            }
            attachCrossOriginRedirectGuard(msg, modelsUrl);
            const headers = msg.get_request_headers();
            headers.append('Accept', 'application/json');
            if (apiKey) {
                headers.append('Authorization', `Bearer ${apiKey}`);
            }
            this._httpSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (sess, res) => {
                try {
                    const bytes = sess.send_and_read_finish(res);
                    const rawData = bytes?.get_data?.() || new Uint8Array(0);
                    const status = msg.get_status();
                    const parsed = parseModelsResponse(status, rawData, {
                        preferredModel: userPreferredModel,
                        apiKey,
                    });
                    if (this._runtime) {
                        this._runtime.modelMetadata = {
                            ...(this._runtime.modelMetadata || {}),
                            ...(parsed.metadataById || {}),
                        };
                    }
                    if (!this._disposed && Array.isArray(parsed.models) && parsed.models.length > 0) {
                        this._emitEvent?.({
                            type: 'models_discovered',
                            backend: 'openai',
                            models: parsed.models.slice(0, 200),
                            clientGeneration: this._clientGeneration,
                        });
                    }
                    resolve({
                        backend: 'openai',
                        models: parsed.models || [],
                        selectedModel: parsed.selectedModel || '',
                    });
                } catch (e) {
                    const cleanMsg = redactSensitiveText(e?.message || String(e), {apiKey, maxChars: 240});
                    reject(new Error(cleanMsg));
                }
            });
        });
    }

    async _discoverModelIfNeeded(cancellable) {
        const userPreferredModel = String(this._runtime?.modelId || '').trim();
        if (userPreferredModel) return userPreferredModel;

        try {
            const parsed = await this.getModels({cancellable});
            if (!parsed.selectedModel) {
                throw new Error('未指定模型 ID，且 /models 未返回可用模型；请在设置中填写模型 ID');
            }
            this._runtime.modelId = parsed.selectedModel;
            this._runtime.resolvedModel = parsed.selectedModel;
            this._runtime.label = parsed.selectedModel;
            return parsed.selectedModel;
        } catch (e) {
            const cleanMsg = redactSensitiveText(e?.message || String(e), {
                apiKey: this._runtime?.apiKey || '',
                maxChars: 240,
            });
            throw new Error(`请在设置中填写模型 ID（${cleanMsg}）`);
        }
    }

    async sendMessage({
        promptText,
        turnMeta = {},
        sessionId = '',
        timeouts = null,
    }) {
        const systemPrompt = this._runtime.systemPrompt ||
            '你是 Ubuntu 26 / GNOME 50 桌面顶栏中的「随问」AI 助手。请用清晰、简明、准确的中文回答问题。';
        const knownCtxWindow = Number(
            this._runtime?.modelMetadata?.[this._runtime.modelId]?.contextWindowTokens || 0
        ) || undefined;

        const budgetCheck = preparePromptWithinBudget(promptText, {
            systemPrompt,
            ...(knownCtxWindow ? {contextWindowTokens: knownCtxWindow} : {}),
            allowTruncate: false,
        });
        if (!budgetCheck.ok) {
            throw new Error(budgetCheck.warning || '当前提问内容超出上下文预算');
        }

        const cancellable = new Gio.Cancellable();
        const turn = this._turns.beginTurn({
            turnId: turnMeta.turnId,
            messageId: turnMeta.messageId,
            replyTo: turnMeta.userMessageId || '',
            modelId: this._runtime.modelId || '',
            sessionId,
            clientGeneration: turnMeta.clientGeneration ?? this._clientGeneration,
            lifecycleGeneration: turnMeta.lifecycleGeneration ?? 0,
            backend: 'openai',
            promptText: budgetCheck.promptText,
            cancellable,
        });

        const ctxCfg = this._getSessionContextConfig();
        this._store?.appendMessage(
            {
                id: turnMeta.userMessageId,
                turnId: turn.id,
                role: 'user',
                content: budgetCheck.promptText,
            },
            'openai',
            ctxCfg
        );

        const resolvedTimeouts = timeouts || resolveSplitTimeouts(this._config);
        attachTurnWatchdog({
            turns: this._turns,
            turn,
            backend: 'openai',
            store: this._store,
            getSessionContextConfig: this._getSessionContextConfig,
            initialTimeoutSec: resolvedTimeouts.connectTimeoutSec,
            initialMessage: `连接 OpenAI 接口超时（${resolvedTimeouts.connectTimeoutSec}s）`,
            totalTurnTimeoutSec: resolvedTimeouts.totalTurnTimeoutSec,
        });

        let modelId;
        try {
            modelId = await this._discoverModelIfNeeded(turn.cancellable);
            turn.modelId = modelId;
        } catch (err) {
            const cleanErr = redactSensitiveText(err?.message || String(err), {apiKey: this._runtime.apiKey});
            this._turns.finalizeTurn(turn, {status: 'failed', errorText: cleanErr});
            throw new Error(cleanErr);
        }

        if (!this._turns.isCurrent(turn)) {
            return {disposition: 'handled'};
        }

        const effectiveCtxWindow = Number(
            this._runtime?.modelMetadata?.[modelId]?.contextWindowTokens || knownCtxWindow || 0
        ) || undefined;

        const apiMessages = [
            {role: 'system', content: systemPrompt},
            ...buildBudgetedContextMessages(this._store?.messages || [], {
                maxMessages: 24,
                maxChars: 28000,
                systemPrompt,
                ...(effectiveCtxWindow ? {contextWindowTokens: effectiveCtxWindow} : {}),
            }),
        ];

        const chatUrl = this._runtime.chatUrl;
        const msg = Soup.Message.new('POST', chatUrl);
        if (!msg) {
            const err = new Error(`无效的 OpenAI 接口地址：${chatUrl}`);
            this._turns.finalizeTurn(turn, {status: 'failed', errorText: err.message});
            throw err;
        }
        attachCrossOriginRedirectGuard(msg, chatUrl);

        const reqHeaders = msg.get_request_headers();
        reqHeaders.append('Content-Type', 'application/json');
        reqHeaders.append('Accept', 'text/event-stream, application/json');
        if (this._runtime.apiKey) {
            reqHeaders.append('Authorization', `Bearer ${this._runtime.apiKey}`);
        }

        const reqBody = {
            model: modelId,
            stream: true,
            messages: apiMessages,
        };
        if (
            this._runtime.reasoningEffort &&
            supportsOpenAIReasoningEffort(modelId, this._config?.supportsReasoningEffort)
        ) {
            reqBody.reasoning_effort = this._runtime.reasoningEffort;
        }
        msg.set_request_body_from_bytes('application/json', new GLib.Bytes(Encoder.encode(JSON.stringify(reqBody))));

        const endpointSecurity = inspectEndpointSecurity(this._runtime.baseUrl || '');
        if (endpointSecurity.isRemotePlaintextHttp && endpointSecurity.warning) {
            this._turns.emitForTurn(turn, {
                type: 'mode_notice',
                message: endpointSecurity.warning,
            });
        }

        this._turns.markStreaming(turn);
        this._turns.emitForTurn(turn, {type: 'message_start', modelId, message: {role: 'assistant'}});
        turn.setWatchdogPhase?.(
            resolvedTimeouts.connectTimeoutSec,
            `连接 OpenAI 接口超时（${resolvedTimeouts.connectTimeoutSec}s）`
        );

        let activeBaseStream = null;
        const closeOpenAIStream = () => {
            if (!activeBaseStream) return;
            const s = activeBaseStream;
            activeBaseStream = null;
            try {
                s.close_async(GLib.PRIORITY_DEFAULT, null, (st, r) => {
                    try { st.close_finish(r); } catch (_) {}
                });
            } catch (_) {}
        };

        const sseParser = new OpenAISseParser({
            apiKey: this._runtime.apiKey,
        });

        const settleOpenAI = ({status = '', interrupted = false, errorText = ''} = {}) => {
            closeOpenAIStream();
            if (!this._turns.isCurrent(turn)) return;

            const cleanError = errorText
                ? redactSensitiveText(errorText, {apiKey: this._runtime.apiKey, maxChars: 280})
                : '';

            let finalStatus = status;
            let finalInterrupted = Boolean(interrupted);
            if (turn.timedOut) {
                finalStatus = 'timed_out';
            } else if (turn.aborted) {
                finalStatus = 'cancelled';
            } else if (!finalStatus) {
                if (cleanError) {
                    finalStatus = 'failed';
                } else if (!turn.sawDoneMarker) {
                    finalStatus = 'interrupted';
                    finalInterrupted = true;
                } else {
                    finalStatus = 'completed';
                }
            }

            const persistCfg = this._getSessionContextConfig();
            this._turns.finalizeTurn(turn, {
                status: finalStatus,
                interrupted: finalInterrupted,
                errorText: cleanError,
                onPersistAssistant: m => this._store?.appendMessage(m, 'openai', persistCfg),
            });
        };

        const applyParsedSseEvents = events => {
            for (const evt of events) {
                if (!this._turns.isCurrent(turn)) return false;
                if (evt.type === 'error') {
                    settleOpenAI({status: 'failed', errorText: evt.error});
                    return false;
                }
                if (evt.type === 'done') {
                    turn.sawDoneMarker = true;
                    settleOpenAI({status: 'completed'});
                    return false;
                }
                if (evt.type === 'delta') {
                    if (evt.model && !turn.modelId) turn.modelId = evt.model;
                    if (evt.thinkingDelta) this._turns.appendThinking(turn, evt.thinkingDelta);
                    if (evt.textDelta) this._turns.appendText(turn, evt.textDelta);
                }
            }
            return true;
        };

        this._httpSession.send_async(msg, GLib.PRIORITY_DEFAULT, turn.cancellable, (sess, res) => {
            let baseStream = null;
            try {
                baseStream = sess.send_finish(res);
            } catch (err) {
                if (this._turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
                    settleOpenAI({
                        status: turn.aborted ? 'cancelled' : 'failed',
                        errorText: turn.aborted ? '' : `请求失败：${err.message}`,
                    });
                }
                return;
            }

            if (!this._turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
                try {
                    baseStream?.close_async(GLib.PRIORITY_DEFAULT, null, (st, r) => {
                        try { st.close_finish(r); } catch (_) {}
                    });
                } catch (_) {}
                return;
            }

            activeBaseStream = baseStream;
            const status = msg.get_status();

            if (status < 200 || status >= 300) {
                const errorChunks = [];
                let errorBytes = 0;
                const readErrorChunks = () => {
                    if (!this._turns.isCurrent(turn) || !activeBaseStream) {
                        closeOpenAIStream();
                        return;
                    }
                    activeBaseStream.read_bytes_async(8192, GLib.PRIORITY_DEFAULT, turn.cancellable, (s, r) => {
                        let gbytes = null;
                        try { gbytes = s.read_bytes_finish(r); } catch (_) {}

                        if (!this._turns.isCurrent(turn)) {
                            closeOpenAIStream();
                            return;
                        }
                        const chunk = gbytes ? gbytes.get_data() : null;
                        if (chunk && chunk.byteLength > 0 && errorBytes < DEFAULT_SSE_LIMITS.maxErrorBodyBytes) {
                            const allowed = chunk.subarray(0, DEFAULT_SSE_LIMITS.maxErrorBodyBytes - errorBytes);
                            errorChunks.push(Decoder.decode(allowed, {stream: true}));
                            errorBytes += allowed.byteLength;
                            if (errorBytes < DEFAULT_SSE_LIMITS.maxErrorBodyBytes) {
                                readErrorChunks();
                                return;
                            }
                        }
                        errorChunks.push(Decoder.decode(new Uint8Array(0), {stream: false}));
                        const detail = formatSanitizedHttpError(
                            status,
                            msg.get_reason_phrase() || '',
                            errorChunks.join(''),
                            {apiKey: this._runtime.apiKey}
                        );
                        settleOpenAI({status: 'failed', errorText: detail});
                    });
                };
                readErrorChunks();
                return;
            }

            let sawFirstPayloadChunk = false;
            turn.setWatchdogPhase?.(
                resolvedTimeouts.firstByteTimeoutSec,
                `等待模型首字响应超时（${resolvedTimeouts.firstByteTimeoutSec}s）`
            );

            const readSseChunks = () => {
                if (!this._turns.isCurrent(turn) || !activeBaseStream) {
                    closeOpenAIStream();
                    return;
                }
                activeBaseStream.read_bytes_async(16384, GLib.PRIORITY_DEFAULT, turn.cancellable, (s, r) => {
                    let gbytes = null;
                    try {
                        gbytes = s.read_bytes_finish(r);
                    } catch (err) {
                        if (!this._turns.isCurrent(turn)) {
                            closeOpenAIStream();
                            return;
                        }
                        settleOpenAI({
                            status: turn.aborted ? 'cancelled' : 'failed',
                            errorText: turn.aborted ? '' : err.message,
                        });
                        return;
                    }

                    if (!this._turns.isCurrent(turn)) {
                        closeOpenAIStream();
                        return;
                    }

                    const rawChunk = gbytes ? gbytes.get_data() : null;
                    if (!rawChunk || rawChunk.byteLength === 0) {
                        const fin = sseParser.finish();
                        if (!applyParsedSseEvents(fin.events)) return;
                        if (fin.isNonSseJson) {
                            if (fin.model && !turn.modelId) turn.modelId = fin.model;
                            if (fin.nonSseThinking) this._turns.replaceThinking(turn, fin.nonSseThinking);
                            if (fin.nonSseText) this._turns.replaceText(turn, fin.nonSseText);
                            turn.sawDoneMarker = true;
                            settleOpenAI({status: 'completed'});
                            return;
                        }
                        if (fin.completedCleanly) {
                            turn.sawDoneMarker = true;
                            settleOpenAI({status: 'completed'});
                            return;
                        }
                        if (fin.interrupted) {
                            settleOpenAI({
                                status: 'interrupted',
                                interrupted: true,
                                errorText: fin.error,
                            });
                            return;
                        }
                        settleOpenAI({
                            status: 'failed',
                            errorText: fin.error || '响应解析失败',
                        });
                        return;
                    }

                    if (!sawFirstPayloadChunk) {
                        sawFirstPayloadChunk = true;
                        turn.setWatchdogPhase?.(
                            resolvedTimeouts.streamIdleTimeoutSec,
                            `流式响应空闲超时（${resolvedTimeouts.streamIdleTimeoutSec}s）`
                        );
                    } else {
                        turn.resetWatchdog?.();
                    }

                    const parsedEvents = sseParser.pushBytes(rawChunk);
                    if (!applyParsedSseEvents(parsedEvents)) return;
                    readSseChunks();
                });
            };
            readSseChunks();
        });

        return {disposition: 'streaming', turnId: turn.id};
    }

    async cancel(turnId = '') {
        const active = this._turns?.activeTurn;
        if (!active || active.finalized) return {aborted: false};
        if (turnId && active.id !== String(turnId)) return {aborted: false, stale: true};
        const ctxCfg = this._getSessionContextConfig();
        this._turns.cancelActiveTurn({
            onPersistAssistant: m => this._store?.appendMessage(m, 'openai', ctxCfg),
        });
        return {aborted: true, turnId: active.id};
    }

    dispose() {
        super.dispose();
        try { this._httpSession?.abort(); } catch (_) {}
        this._httpSession = null;
    }
}
