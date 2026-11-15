import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {
    augmentPromptWithDesktopContext,
    buildBudgetedContextMessages,
    buildCodexArgs,
    buildCrossBackendPromptWithContext,
    buildZCodeArgs,
    buildZCodePersonalConfigOverride,
    mapReasoningEffort,
    normalizeEvent,
    normalizeOpenAIEndpoint,
    parseOpenAISSELine,
    stripAnsi,
} from './protocol.js';
import {
    buildSearchPath,
    createGioCliEnv,
    detectBackendSelection,
    findExecutableInDirs,
    readJsonFileSync,
} from './core/backendDetect.js';
import {UNCONFIGURED_BACKEND_MESSAGE} from './core/configMigration.js';
import {
    getPrivateRuntimeDir,
    getUserSpecialDirs,
    removeFileQuietly,
    writePrivateFileSync,
} from './core/paths.js';
import {SessionStore} from './core/sessionStore.js';
import {TurnController} from './core/turnController.js';

export {buildSearchPath, findExecutableInDirs};

const Encoder = new TextEncoder();
const Decoder = new TextDecoder('utf-8');

/**
 * Sends SIGTERM first, gives the CLI subprocess 800ms to flush & reap children cleanly,
 * and falls back to SIGKILL (force_exit) only if it has not exited in time.
 */
function terminateSubprocessGracefully(proc) {
    if (!proc) return;
    let exited = false;
    try {
        proc.wait_async(null, (p, res) => {
            exited = true;
            try { p.wait_finish(res); } catch (_) {}
        });
    } catch (_) {}

    try {
        proc.send_signal(15); // SIGTERM
    } catch (_) {
        try { proc.force_exit(); } catch (__) {}
        return;
    }

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
        if (!exited) {
            try { proc.force_exit(); } catch (_) {}
        }
        return GLib.SOURCE_REMOVE;
    });
}

/**
 * Generates an isolated, 0600-permission temporary ZCode personal provider config file
 * inside XDG_RUNTIME_DIR/gnome-quick-chat without EVER modifying ~/.zcode/v2/provider_config.json.
 */
function createIsolatedZCodeConfigOverride(config) {
    const home = GLib.get_home_dir();
    const personalPath = GLib.build_filenamev([home, '.zcode', 'v2', 'provider_config.json']);
    if (!GLib.file_test(personalPath, GLib.FileTest.EXISTS)) {
        return {env: {}, tempFilePath: '', resolvedProvider: '', resolvedModel: ''};
    }
    const personalObj = readJsonFileSync(personalPath);
    if (!personalObj) {
        return {env: {}, tempFilePath: '', resolvedProvider: '', resolvedModel: ''};
    }

    const desiredProvider = (config?.provider || '').trim();
    const desiredModel = (config?.model || '').trim();
    const reasoningEffort = (config?.reasoningEffort || 'default').trim();

    if (!desiredProvider && !desiredModel && (!reasoningEffort || reasoningEffort === 'default')) {
        const defSel = personalObj?.config?.defaultModelSelection;
        return {
            env: {},
            tempFilePath: '',
            resolvedProvider: defSel?.providerId || '',
            resolvedModel: defSel?.modelId || '',
        };
    }

    const override = buildZCodePersonalConfigOverride(personalObj, {
        provider: desiredProvider,
        model: desiredModel,
        reasoningEffort,
    });
    if (!override || !override.configObj) {
        return {env: {}, tempFilePath: '', resolvedProvider: '', resolvedModel: ''};
    }

    try {
        const runtimeDir = getPrivateRuntimeDir();
        const tempFilePath = GLib.build_filenamev([
            runtimeDir,
            `zcode-provider-${GLib.uuid_string_random()}.json`,
        ]);
        const bytes = Encoder.encode(JSON.stringify(override.configObj, null, 2));
        writePrivateFileSync(tempFilePath, bytes);
        return {
            env: {ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: tempFilePath},
            tempFilePath,
            resolvedProvider: override.providerId,
            resolvedModel: override.modelId,
        };
    } catch (err) {
        console.warn(`[Quick Chat] Failed to write isolated ZCode config: ${err.message}`);
        return {env: {}, tempFilePath: '', resolvedProvider: '', resolvedModel: ''};
    }
}

export function resolveBackendRuntime(config = {}) {
    const rawZCodePath = String(config.zcodePath || '').trim();
    const rawCodexPath = String(config.codexPath || '').trim();
    const rawBaseUrl = String(config.openaiBaseUrl || '').trim();

    const selection = detectBackendSelection({
        configuredBackend: config.backend || 'auto',
        zcodePath: rawZCodePath,
        codexPath: rawCodexPath,
        openaiBaseUrl: rawBaseUrl,
    });

    const effective = selection.effectiveBackend;
    if (effective === 'unconfigured') {
        return {
            backend: 'unconfigured',
            available: false,
            reason: selection.reason || UNCONFIGURED_BACKEND_MESSAGE,
            label: '未配置后端',
        };
    }

    if (!selection.available) {
        throw new Error(selection.reason || UNCONFIGURED_BACKEND_MESSAGE);
    }

    if (effective === 'openai') {
        const modelId = String(config.openaiModel || config.model || '').trim();
        return {
            backend: 'openai',
            available: true,
            baseUrl: rawBaseUrl,
            chatUrl: normalizeOpenAIEndpoint(rawBaseUrl, '/chat/completions'),
            modelsUrl: normalizeOpenAIEndpoint(rawBaseUrl, '/models'),
            apiKey: String(config.openaiApiKey || '').trim(),
            modelId,
            systemPrompt: String(config.systemPrompt || '').trim(),
            reasoningEffort: mapReasoningEffort(config.reasoningEffort),
            label: modelId || 'OpenAI API',
        };
    }

    if (effective === 'zcode') {
        const cliEnv = createGioCliEnv(rawZCodePath);
        const pathDirs = cliEnv.pathDirs;
        const resolvedCustom = rawZCodePath ? cliEnv.resolveCandidate(rawZCodePath) : '';

        const builtinCfg = '/opt/ZCode/resources/config/provider/zcode-builtin.json';
        const baseEnv = GLib.file_test(builtinCfg, GLib.FileTest.EXISTS)
            ? {
                ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinCfg,
                ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: builtinCfg,
            }
            : {};

        // Inspect personal config read-only to display accurate initial model label
        const home = GLib.get_home_dir();
        const personalObj = readJsonFileSync(GLib.build_filenamev([home, '.zcode', 'v2', 'provider_config.json']));
        const preview = personalObj
            ? buildZCodePersonalConfigOverride(personalObj, {
                provider: config.provider || '',
                model: config.model || '',
                reasoningEffort: config.reasoningEffort || 'default',
            })
            : null;
        const effectiveModel = preview?.modelId
            || config.model
            || personalObj?.config?.defaultModelSelection?.modelId
            || '';
        const label = effectiveModel || 'ZCode';

        let bridgePath = '';
        let bridgeArgs = [];
        try {
            const selfFile = Gio.File.new_for_uri(import.meta.url);
            const selfDir = selfFile.get_parent()?.get_path();
            if (selfDir) {
                const candidateBridge = GLib.build_filenamev([selfDir, 'zcodeBridge.cjs']);
                if (GLib.file_test(candidateBridge, GLib.FileTest.EXISTS)) {
                    bridgePath = candidateBridge;
                    bridgeArgs = ['--require', candidateBridge];
                }
            }
        } catch (_) {}

        const defaultBundledCjs = '/opt/ZCode/resources/glm/zcode.cjs';
        const cjsTarget = resolvedCustom && resolvedCustom.endsWith('.cjs')
            ? resolvedCustom
            : ((!resolvedCustom || resolvedCustom === '/opt/ZCode/zcode') &&
               GLib.file_test(defaultBundledCjs, GLib.FileTest.EXISTS)
                ? defaultBundledCjs
                : '');

        const nodeExe = findExecutableInDirs('node', pathDirs);
        if (cjsTarget) {
            if (nodeExe) {
                return {
                    backend: 'zcode',
                    available: true,
                    executable: nodeExe,
                    commandPrefix: [nodeExe, ...bridgeArgs, cjsTarget],
                    extraEnv: baseEnv,
                    pathEnv: buildSearchPath(nodeExe).join(':'),
                    label,
                };
            }

            const electronExe = '/opt/ZCode/zcode';
            if (GLib.file_test(electronExe, GLib.FileTest.IS_EXECUTABLE)) {
                return {
                    backend: 'zcode',
                    available: true,
                    executable: electronExe,
                    commandPrefix: [electronExe, ...bridgeArgs, cjsTarget],
                    extraEnv: {...baseEnv, ELECTRON_RUN_AS_NODE: '1'},
                    pathEnv: pathDirs.join(':'),
                    label,
                };
            }
            throw new Error('找到 ZCode 脚本但缺少 Node 或 Electron 运行时');
        }

        const zcodeExe = resolvedCustom || findExecutableInDirs('zcode', pathDirs);
        if (!zcodeExe) {
            throw new Error('未检测到本机 ZCode CLI，请安装 ZCode 或在设置中检查路径');
        }
        const extraEnv = {...baseEnv};
        if (bridgePath && !bridgePath.includes('"')) {
            const existingNodeOpts = GLib.getenv('NODE_OPTIONS') || '';
            extraEnv.NODE_OPTIONS = `${existingNodeOpts} --require "${bridgePath}"`.trim();
        }
        return {
            backend: 'zcode',
            available: true,
            executable: zcodeExe,
            commandPrefix: [zcodeExe],
            extraEnv,
            pathEnv: buildSearchPath(zcodeExe).join(':'),
            label,
        };
    }

    if (effective === 'codex') {
        const cliEnv = createGioCliEnv(rawCodexPath);
        const codexExe = (rawCodexPath ? cliEnv.resolveCandidate(rawCodexPath) : '')
            || findExecutableInDirs('codex', cliEnv.pathDirs);
        if (!codexExe) {
            throw new Error('未检测到本机 Codex CLI 可执行文件');
        }
        return {
            backend: 'codex',
            available: true,
            executable: codexExe,
            pathEnv: buildSearchPath(codexExe).join(':'),
            label: config.model || 'Codex',
        };
    }

    throw new Error(UNCONFIGURED_BACKEND_MESSAGE);
}

export class BackendClient {
    constructor(onEvent, onExit) {
        this._event = onEvent;
        this._exit = onExit;
        this._closed = false;
        this._stderrLines = [];
        this._httpSession = null;
        this._approvedScopes = new Set();
        this._turns = new TurnController(evt => {
            if (!this._closed) this._event(evt);
        });
        this._store = null;
    }

    start(config, workspace, sessionDir, sessionId) {
        this._config = config;
        this._workspace = workspace;
        this._sessionDir = sessionDir;
        this._sessionId = sessionId;
        this._specialDirs = getUserSpecialDirs();
        this._runtime = resolveBackendRuntime(config);
        this._backend = this._runtime.backend;

        if (this._backend === 'openai') {
            this._httpSession = new Soup.Session({timeout: 120});
        }
        this._store = new SessionStore(sessionId);
    }

    _buildXdgEnvVars() {
        const d = this._specialDirs || {};
        const env = {};
        if (d.home) env.HOME = d.home;
        if (d.desktop) env.XDG_DESKTOP_DIR = d.desktop;
        if (d.downloads) env.XDG_DOWNLOAD_DIR = d.downloads;
        if (d.documents) env.XDG_DOCUMENTS_DIR = d.documents;
        if (d.pictures) env.XDG_PICTURES_DIR = d.pictures;
        if (d.music) env.XDG_MUSIC_DIR = d.music;
        if (d.videos) env.XDG_VIDEOS_DIR = d.videos;
        return env;
    }

    updateApiKey(apiKey) {
        if (this._config) this._config.openaiApiKey = String(apiKey || '').trim();
        if (this._runtime && this._backend === 'openai') {
            this._runtime.apiKey = String(apiKey || '').trim();
        }
    }

    _readStderr(stream, cancellable) {
        if (this._closed || !stream) return;
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (src, result) => {
            if (this._closed) return;
            try {
                const [line] = src.read_line_finish_utf8(result);
                if (line === null) return;
                const clean = stripAnsi(line).trim();
                if (clean) {
                    this._stderrLines.push(clean);
                    if (this._stderrLines.length > 8) this._stderrLines.shift();
                }
                this._readStderr(stream, cancellable);
            } catch (_) {}
        });
    }

    async request(type, fields = {}) {
        if (this._closed) {
            throw new Error('服务已关闭');
        }
        if (this._store) {
            await this._store.load(this._backend, this._config);
        }

        if (type === 'get_state') {
            return {
                backend: this._backend,
                unconfigured: this._backend === 'unconfigured',
                reason: this._runtime?.reason || '',
                model: {id: this._runtime.label},
            };
        }
        if (type === 'get_messages') {
            return {messages: this._store ? [...this._store.messages] : []};
        }
        if (type === 'abort') {
            this._turns.cancelActiveTurn({
                onPersistAssistant: m => this._store?.appendMessage(m, this._backend, this._config),
                onTerminateProcess: proc => terminateSubprocessGracefully(proc),
                onCleanupTempFiles: files => files.forEach(removeFileQuietly),
            });
            return {aborted: true};
        }
        if (type === 'permission_response') {
            return this._sendTurnPermissionResponse(fields);
        }
        if (type === 'prompt') {
            if (this._backend === 'unconfigured') {
                throw new Error(this._runtime?.reason || UNCONFIGURED_BACKEND_MESSAGE);
            }
            if (this._backend === 'openai') {
                return this._runOpenAITurn(fields.message || '');
            }
            return this._runSingleTurnSubprocess(fields.message || '');
        }
        return {};
    }

    _sendTurnPermissionResponse({
        requestId = '',
        decision = 'deny',
        alwaysAllow = false,
        scopeKey = '',
        modifiedInput = undefined,
        reason = '',
    } = {}) {
        const turn = this._turns.activeTurn;
        if (!turn || turn.finalized || !turn.stdin) {
            return Promise.resolve({sent: false});
        }

        const msgObj = {
            type: 'permission_response',
            requestId,
            decision,
            alwaysAllow: Boolean(alwaysAllow),
        };
        if (modifiedInput !== undefined) {
            msgObj.modifiedInput = modifiedInput;
        }
        if (reason) {
            msgObj.reason = String(reason);
        }
        const payload = JSON.stringify(msgObj) + '\n';
        const bytes = Encoder.encode(payload);

        return new Promise(resolve => {
            try {
                turn.stdin.write_all_async(bytes, GLib.PRIORITY_DEFAULT, turn.cancellable, (stream, res) => {
                    try {
                        stream.write_all_finish(res);
                        stream.flush_async(GLib.PRIORITY_DEFAULT, turn.cancellable, () => {});
                        if (this._turns.isCurrent(turn)) {
                            if (decision === 'allow' && alwaysAllow && scopeKey) {
                                this._approvedScopes.add(scopeKey);
                            }
                            this._turns.leaveApproval(turn, requestId);
                        }
                        resolve({sent: true});
                    } catch (_) {
                        resolve({sent: false});
                    }
                });
            } catch (_) {
                resolve({sent: false});
            }
        });
    }

    _attachTurnWatchdog(turn, timeoutSec, onTimeoutMessage) {
        let timerId = 0;
        const pause = () => {
            if (timerId) {
                try { GLib.source_remove(timerId); } catch (_) {}
                timerId = 0;
            }
        };
        const reset = () => {
            pause();
            if (!this._turns.isCurrent(turn)) return;
            timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSec, () => {
                timerId = 0;
                if (this._turns.isCurrent(turn)) {
                    try { turn.cancellable?.cancel?.(); } catch (_) {}
                    this._turns.finalizeTurn(turn, {
                        errorText: onTimeoutMessage,
                        aborted: false,
                        onPersistAssistant: msg => this._store?.appendMessage(msg, this._backend, this._config),
                        onTerminateProcess: proc => terminateSubprocessGracefully(proc),
                        onCleanupTempFiles: files => files.forEach(removeFileQuietly),
                    });
                }
                return GLib.SOURCE_REMOVE;
            });
        };
        turn.pauseWatchdog = pause;
        turn.resetWatchdog = reset;
        turn.cleanupWatchdog = pause;
        reset();
    }

    _discoverOpenAIModelAsync(cancellable) {
        if (this._runtime.modelId) return Promise.resolve(this._runtime.modelId);
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', this._runtime.modelsUrl);
            if (!msg) {
                reject(new Error(`无效的接口地址：${this._runtime.modelsUrl}`));
                return;
            }
            const headers = msg.get_request_headers();
            headers.append('Accept', 'application/json');
            if (this._runtime.apiKey) {
                headers.append('Authorization', `Bearer ${this._runtime.apiKey}`);
            }
            this._httpSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (sess, res) => {
                try {
                    const bytes = sess.send_and_read_finish(res);
                    const text = Decoder.decode(bytes.get_data() || new Uint8Array());
                    const parsed = JSON.parse(text);
                    const list = Array.isArray(parsed.data) ? parsed.data : [];
                    const firstId = list[0]?.id || '';
                    if (!firstId) {
                        reject(new Error('未指定模型 ID，且 /models 未返回可用模型；请在设置中填写模型 ID'));
                        return;
                    }
                    this._runtime.modelId = firstId;
                    this._runtime.label = firstId;
                    resolve(firstId);
                } catch (e) {
                    reject(new Error(`请在设置中填写模型 ID（自动拉取失败：${e.message}）`));
                }
            });
        });
    }

    async _runOpenAITurn(promptText) {
        const cancellable = new Gio.Cancellable();
        const turn = this._turns.beginTurn({
            backend: 'openai',
            promptText,
            cancellable,
        });

        this._store?.appendMessage({role: 'user', content: promptText}, this._backend, this._config);

        let modelId;
        try {
            modelId = await this._discoverOpenAIModelAsync(turn.cancellable);
        } catch (err) {
            this._turns.finalizeTurn(turn, {errorText: err.message});
            throw err;
        }

        if (!this._turns.isCurrent(turn)) {
            return {disposition: 'handled'};
        }

        const apiMessages = [];
        apiMessages.push({
            role: 'system',
            content: this._runtime.systemPrompt ||
                '你是 Ubuntu 26 / GNOME 50 桌面顶栏中的「随问」AI 助手。请用清晰、简明、准确的中文回答问题。',
        });

        const budgeted = buildBudgetedContextMessages(this._store?.messages || [], 24, 28000);
        apiMessages.push(...budgeted);

        const msg = Soup.Message.new('POST', this._runtime.chatUrl);
        if (!msg) {
            const err = new Error(`无效的 OpenAI 接口地址：${this._runtime.chatUrl}`);
            this._turns.finalizeTurn(turn, {errorText: err.message});
            throw err;
        }

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
        if (this._runtime.reasoningEffort) {
            reqBody.reasoning_effort = this._runtime.reasoningEffort;
        }
        msg.set_request_body_from_bytes('application/json', new GLib.Bytes(Encoder.encode(JSON.stringify(reqBody))));

        this._turns.markStreaming(turn);
        this._turns.emitForTurn(turn, {type: 'message_start', modelId, message: {role: 'assistant'}});
        this._attachTurnWatchdog(turn, 120, 'OpenAI 接口响应超时（120s）');

        const nonSseLines = [];
        const settleOpenAI = (errorText = '') => {
            if (!this._turns.isCurrent(turn)) return;

            if (!turn.text && nonSseLines.length > 0 && !errorText) {
                const joined = nonSseLines.join('\n').trim();
                if (joined.startsWith('{')) {
                    try {
                        const obj = JSON.parse(joined);
                        if (obj.error) {
                            errorText = obj.error.message || JSON.stringify(obj.error);
                        } else {
                            const content = obj.choices?.[0]?.message?.content;
                            if (typeof content === 'string' && content) {
                                turn.text = content;
                                turn.sawDoneMarker = true;
                            }
                        }
                    } catch (_) {}
                }
            }

            // Detect abnormal SSE truncation (EOF without [DONE] marker)
            if (!turn.aborted && !errorText && !turn.sawDoneMarker) {
                if (!turn.text) {
                    errorText = '响应连接意外中断（未收到完整流结束标记）';
                } else {
                    turn.text += '\n\n*(⚠️ 网络流提前中断，以上回答可能不完整)*';
                }
            }

            this._turns.finalizeTurn(turn, {
                errorText,
                onPersistAssistant: m => this._store?.appendMessage(m, this._backend, this._config),
            });
        };

        this._httpSession.send_async(msg, GLib.PRIORITY_DEFAULT, turn.cancellable, (sess, res) => {
            if (!this._turns.isCurrent(turn)) return;
            let baseStream;
            try {
                baseStream = sess.send_finish(res);
            } catch (err) {
                settleOpenAI(turn.aborted ? '' : `请求失败：${err.message}`);
                return;
            }

            const status = msg.get_status();
            const dataStream = new Gio.DataInputStream({base_stream: baseStream});

            if (status < 200 || status >= 300) {
                const errLines = [];
                const readErr = () => {
                    if (!this._turns.isCurrent(turn)) return;
                    dataStream.read_line_async(GLib.PRIORITY_DEFAULT, turn.cancellable, (s, r) => {
                        if (!this._turns.isCurrent(turn)) return;
                        try {
                            const [line] = s.read_line_finish_utf8(r);
                            if (line !== null) {
                                errLines.push(line);
                                if (errLines.length < 25) {
                                    readErr();
                                    return;
                                }
                            }
                        } catch (_) {}
                        const rawBody = errLines.join('\n').trim();
                        let detail = `HTTP ${status} (${msg.get_reason_phrase() || 'Error'})`;
                        if (rawBody.startsWith('{')) {
                            try {
                                const parsed = JSON.parse(rawBody);
                                if (parsed.error?.message) detail = `${detail}: ${parsed.error.message}`;
                            } catch (_) {
                                detail = `${detail}: ${rawBody.slice(0, 160)}`;
                            }
                        } else if (rawBody) {
                            detail = `${detail}: ${rawBody.slice(0, 160)}`;
                        }
                        settleOpenAI(detail);
                    });
                };
                readErr();
                return;
            }

            const readSseLine = () => {
                if (!this._turns.isCurrent(turn)) return;
                dataStream.read_line_async(GLib.PRIORITY_DEFAULT, turn.cancellable, (s, r) => {
                    if (!this._turns.isCurrent(turn)) return;
                    try {
                        const [line] = s.read_line_finish_utf8(r);
                        if (line === null) {
                            settleOpenAI('');
                            return;
                        }
                        turn.resetWatchdog?.();
                        const sse = parseOpenAISSELine(line);
                        if (sse) {
                            if (sse.error) {
                                settleOpenAI(sse.error);
                                return;
                            }
                            if (sse.done) {
                                turn.sawDoneMarker = true;
                                settleOpenAI('');
                                return;
                            }
                            if (sse.thinkingDelta) {
                                this._turns.appendThinking(turn, sse.thinkingDelta);
                            }
                            if (sse.textDelta) {
                                this._turns.appendText(turn, sse.textDelta);
                            }
                        } else if (line.trim()) {
                            nonSseLines.push(line);
                        }
                        readSseLine();
                    } catch (err) {
                        settleOpenAI(turn.aborted ? '' : err.message);
                    }
                });
            };
            readSseLine();
        });

        return {disposition: 'streaming'};
    }

    _runSingleTurnSubprocess(promptText) {
        const cancellable = new Gio.Cancellable();
        const turn = this._turns.beginTurn({
            backend: this._backend,
            promptText,
            cancellable,
        });

        const historyBeforePrompt = this._store ? [...this._store.messages] : [];
        const remoteId = this._store?.remoteSessionId || '';
        const promptWithDesktopEnv = augmentPromptWithDesktopContext(promptText, this._specialDirs, {
            isFirstTurn: !remoteId,
            mode: this._config?.mode,
            workspace: this._workspace,
        });
        const effectiveCliPrompt = (!remoteId && historyBeforePrompt.length > 0)
            ? buildCrossBackendPromptWithContext(historyBeforePrompt, promptWithDesktopEnv)
            : promptWithDesktopEnv;

        this._store?.appendMessage({role: 'user', content: promptText}, this._backend, this._config);
        this._stderrLines = [];

        const launcher = new Gio.SubprocessLauncher({
            flags:
                Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE,
        });
        launcher.set_cwd(this._workspace);
        launcher.setenv('PATH', this._runtime.pathEnv, true);
        launcher.setenv('NO_COLOR', '1', true);

        const zcodeIsolated = this._backend === 'zcode'
            ? createIsolatedZCodeConfigOverride(this._config)
            : {env: {}, tempFilePath: ''};
        if (zcodeIsolated.tempFilePath) {
            turn.tempFiles.push(zcodeIsolated.tempFilePath);
        }

        const turnExtraEnv = {
            ...this._buildXdgEnvVars(),
            ...(this._runtime.extraEnv || {}),
            ...zcodeIsolated.env,
            ...(this._approvedScopes.size > 0
                ? {QUICK_CHAT_APPROVED_SCOPES: JSON.stringify(Array.from(this._approvedScopes))}
                : {}),
        };
        for (const [k, v] of Object.entries(turnExtraEnv)) {
            launcher.setenv(k, String(v), true);
        }

        const spawnConfig = {
            ...this._config,
            executable: this._runtime.executable,
            commandPrefix: this._runtime.commandPrefix,
        };
        const argv = this._backend === 'zcode'
            ? buildZCodeArgs(spawnConfig, effectiveCliPrompt, remoteId, this._workspace)
            : buildCodexArgs(spawnConfig, this._workspace, effectiveCliPrompt, remoteId);

        try {
            turn.process = launcher.spawnv(argv);
            if (this._backend === 'zcode') {
                turn.stdin = turn.process.get_stdin_pipe();
            } else {
                try { turn.process.get_stdin_pipe()?.close(null); } catch (_) {}
            }
        } catch (error) {
            this._turns.finalizeTurn(turn, {
                errorText: error.message,
                onCleanupTempFiles: files => files.forEach(removeFileQuietly),
            });
            return Promise.reject(error);
        }

        const stdout = new Gio.DataInputStream({base_stream: turn.process.get_stdout_pipe()});
        const stderr = new Gio.DataInputStream({base_stream: turn.process.get_stderr_pipe()});
        this._readStderr(stderr, turn.cancellable);

        this._turns.markStreaming(turn);
        this._attachTurnWatchdog(turn, 120, '响应超时（120s 无输出）');

        const seenPermissionIds = new Set();

        const settleSubprocess = (errOverride = '') => {
            if (!this._turns.isCurrent(turn)) return;
            const errMsg = errOverride
                || turn.error
                || (!turn.text && !turn.aborted && this._stderrLines.length
                    ? this._stderrLines.slice(-2).join(' ')
                    : '');
            this._turns.finalizeTurn(turn, {
                errorText: errMsg,
                onPersistAssistant: m => this._store?.appendMessage(m, this._backend, this._config),
                onTerminateProcess: proc => terminateSubprocessGracefully(proc),
                onCleanupTempFiles: files => files.forEach(removeFileQuietly),
            });
        };

        const readNextLine = () => {
            if (!this._turns.isCurrent(turn)) return;
            stdout.read_line_async(GLib.PRIORITY_DEFAULT, turn.cancellable, (stream, res) => {
                if (!this._turns.isCurrent(turn)) return;
                try {
                    const [line] = stream.read_line_finish_utf8(res);
                    if (line === null) {
                        settleSubprocess('');
                        return;
                    }
                    if (turn.state !== 'awaiting_approval') {
                        turn.resetWatchdog?.();
                    }

                    const trimmed = line.trim();
                    let record = null;
                    if (trimmed.startsWith('{')) {
                        try { record = JSON.parse(trimmed); } catch (_) {}
                    }
                    if (record) {
                        const norm = normalizeEvent(this._backend, record);
                        if (norm) {
                            if (norm.type === 'bridge_ready') {
                                if (!norm.patched && this._config?.mode === 'readonly') {
                                    this._turns.emitForTurn(turn, {
                                        type: 'bridge_warning',
                                        message: '当前 ZCode 版本未命中交互审批钩子，敏感工具可能被默认拦截',
                                    });
                                }
                            } else if (norm.type === 'permission_request') {
                                if (!seenPermissionIds.has(norm.requestId)) {
                                    seenPermissionIds.add(norm.requestId);
                                    this._turns.enterApproval(turn, norm.requestId);
                                    this._turns.emitForTurn(turn, norm);
                                }
                            } else if (norm.type === 'permission_resolved') {
                                this._turns.leaveApproval(turn, norm.requestId);
                                this._turns.emitForTurn(turn, norm);
                            } else if (norm.type === 'session_bound' && norm.sessionId) {
                                this._store?.setRemoteSessionId(norm.sessionId, this._backend, this._config);
                            } else if (norm.type === 'turn_completed') {
                                turn.sawDoneMarker = true;
                            } else if (norm.type === 'turn_result') {
                                if (norm.sessionId) {
                                    this._store?.setRemoteSessionId(norm.sessionId, this._backend, this._config);
                                }
                                if (norm.text && !turn.text) {
                                    turn.text = norm.text;
                                }
                            } else if (norm.type === 'text_snapshot') {
                                const delta = norm.text.startsWith(turn.text)
                                    ? norm.text.slice(turn.text.length)
                                    : norm.text;
                                turn.text = norm.text;
                                if (delta) {
                                    this._turns.emitForTurn(turn, {
                                        type: 'message_update',
                                        assistantMessageEvent: {type: 'text_delta', delta},
                                    });
                                }
                            } else if (norm.type === 'thinking_snapshot') {
                                const delta = norm.text.startsWith(turn.thinking)
                                    ? norm.text.slice(turn.thinking.length)
                                    : norm.text;
                                turn.thinking = norm.text;
                                if (delta) {
                                    this._turns.emitForTurn(turn, {
                                        type: 'message_update',
                                        assistantMessageEvent: {type: 'thinking_delta', delta},
                                    });
                                }
                            } else {
                                if (norm.sessionId) {
                                    this._store?.setRemoteSessionId(norm.sessionId, this._backend, this._config);
                                }
                                if (norm.type === 'message_update') {
                                    const ev = norm.assistantMessageEvent;
                                    if (ev?.type === 'text_delta') turn.text += ev.delta || '';
                                    if (ev?.type === 'thinking_delta') turn.thinking += ev.delta || '';
                                    this._turns.emitForTurn(turn, norm);
                                } else if (norm.type === 'message_end' && norm.message) {
                                    if (typeof norm.message.content === 'string' && norm.message.content) {
                                        turn.text = norm.message.content;
                                    }
                                    if (norm.message.errorMessage) {
                                        turn.error = norm.message.errorMessage;
                                    }
                                    // Defer final `message_end` emission to `finalizeTurn` so it fires exactly once!
                                } else {
                                    this._turns.emitForTurn(turn, norm);
                                }
                            }
                        }
                    }
                    readNextLine();
                } catch (err) {
                    if (!turn.aborted) {
                        settleSubprocess(err.message);
                    }
                }
            });
        };

        readNextLine();
        return Promise.resolve({disposition: 'streaming'});
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        this._turns.dispose(
            proc => terminateSubprocessGracefully(proc),
            files => files.forEach(removeFileQuietly)
        );
        try { this._httpSession?.abort(); } catch (_) {}
        this._httpSession = null;
    }
}
