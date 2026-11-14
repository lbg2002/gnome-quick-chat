import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {
    buildArgs,
    buildCodexArgs,
    buildZCodeArgs,
    buildZCodePersonalConfigOverride,
    messageText,
    normalizeEvent,
    normalizeOpenAIEndpoint,
    parseOpenAISSELine,
    stripAnsi,
} from './protocol.js';

const Decoder = new TextDecoder('utf-8');
const Encoder = new TextEncoder();

function prepareZCodePersonalConfigEnv(config) {
    const home = GLib.get_home_dir();
    const personalPath = GLib.build_filenamev([home, '.zcode', 'v2', 'provider_config.json']);
    if (!GLib.file_test(personalPath, GLib.FileTest.EXISTS)) {
        return {env: {}, resolvedModel: config.model || '', resolvedProvider: config.provider || ''};
    }
    try {
        const [ok, raw] = GLib.file_get_contents(personalPath);
        if (!ok || !raw) {
            return {env: {}, resolvedModel: config.model || '', resolvedProvider: config.provider || ''};
        }
        const parsed = JSON.parse(Decoder.decode(raw));
        const override = buildZCodePersonalConfigOverride(parsed, {
            provider: config.provider || '',
            model: config.model || '',
        });
        if (!override || (!override.providerId && !override.modelId)) {
            return {env: {}, resolvedModel: config.model || '', resolvedProvider: config.provider || ''};
        }
        const runtimeDir = GLib.get_user_runtime_dir() || '/tmp';
        const outPath = GLib.build_filenamev([runtimeDir, 'quick-chat-zcode-provider.json']);
        GLib.file_set_contents(outPath, Encoder.encode(JSON.stringify(override.configObj, null, 2)));
        return {
            env: {ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: outPath},
            resolvedModel: override.modelId || config.model || '',
            resolvedProvider: override.providerId || config.provider || '',
        };
    } catch (_) {
        return {env: {}, resolvedModel: config.model || '', resolvedProvider: config.provider || ''};
    }
}

function listNvmBinDirs(homeDir) {
    const nvmNodeDir = GLib.build_filenamev([homeDir, '.nvm', 'versions', 'node']);
    if (!GLib.file_test(nvmNodeDir, GLib.FileTest.IS_DIR)) return [];
    const versions = [];
    try {
        const dir = GLib.Dir.open(nvmNodeDir, 0);
        let name;
        while ((name = dir.read_name()) !== null) {
            const binDir = GLib.build_filenamev([nvmNodeDir, name, 'bin']);
            if (GLib.file_test(binDir, GLib.FileTest.IS_DIR)) {
                versions.push({name, binDir});
            }
        }
        dir.close();
    } catch (_) {}
    versions.sort((a, b) => b.name.localeCompare(a.name, undefined, {numeric: true}));
    return versions.map(v => v.binDir);
}

export function buildSearchPath(extraExecutable = '') {
    const home = GLib.get_home_dir();
    const sysPath = (GLib.getenv('PATH') || '/usr/local/bin:/usr/bin:/bin').split(':').filter(Boolean);
    const dirs = [];
    const pushDir = d => {
        if (d && !dirs.includes(d) && GLib.file_test(d, GLib.FileTest.IS_DIR)) {
            dirs.push(d);
        }
    };

    if (extraExecutable && extraExecutable.startsWith('/')) {
        pushDir(GLib.path_get_dirname(extraExecutable));
        try {
            const linkTarget = GLib.file_read_link(extraExecutable);
            const resolved = linkTarget.startsWith('/')
                ? linkTarget
                : GLib.build_filenamev([GLib.path_get_dirname(extraExecutable), linkTarget]);
            pushDir(GLib.path_get_dirname(resolved));
        } catch (_) {}
    }

    for (const nvmBin of listNvmBinDirs(home)) pushDir(nvmBin);
    pushDir(GLib.build_filenamev([home, '.local', 'bin']));
    pushDir(GLib.build_filenamev([home, 'bin']));
    pushDir(GLib.build_filenamev([home, '.opencode', 'bin']));
    pushDir(GLib.build_filenamev([home, '.local', 'share', 'pnpm']));
    pushDir(GLib.build_filenamev([home, '.bun', 'bin']));
    pushDir(GLib.build_filenamev([home, '.npm-global', 'bin']));
    pushDir(GLib.build_filenamev([home, '.volta', 'bin']));
    pushDir(GLib.build_filenamev([home, '.cargo', 'bin']));
    pushDir('/usr/local/bin');
    for (const p of sysPath) pushDir(p);
    return dirs;
}

export function findExecutableInDirs(nameOrPath, pathDirs) {
    if (!nameOrPath) return null;
    if (nameOrPath.includes('/')) {
        return GLib.file_test(nameOrPath, GLib.FileTest.IS_EXECUTABLE) &&
            !GLib.file_test(nameOrPath, GLib.FileTest.IS_DIR)
            ? nameOrPath
            : null;
    }
    for (const dir of pathDirs) {
        const candidate = GLib.build_filenamev([dir, nameOrPath]);
        if (GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE) &&
            !GLib.file_test(candidate, GLib.FileTest.IS_DIR)) {
            return candidate;
        }
    }
    return null;
}

export function resolveBackendRuntime(config) {
    const requested = config.backend || 'auto';
    const rawExec = (config.executable || '').trim();
    const pathDirs = buildSearchPath(rawExec);

    const resolvePi = () => {
        const exe = findExecutableInDirs(rawExec || 'pi', pathDirs);
        if (!exe) return null;
        return {
            backend: 'pi',
            executable: exe,
            pathEnv: buildSearchPath(exe).join(':'),
            label: config.model || 'Pi',
        };
    };

    const resolveZCode = () => {
        const bundledCjs = rawExec && rawExec.endsWith('.cjs') && GLib.file_test(rawExec, GLib.FileTest.EXISTS)
            ? rawExec
            : '/opt/ZCode/resources/glm/zcode.cjs';
        if (GLib.file_test(bundledCjs, GLib.FileTest.EXISTS)) {
            const builtinCfg = '/opt/ZCode/resources/config/provider/zcode-builtin.json';
            const personalOverride = prepareZCodePersonalConfigEnv(config);
            const baseEnv = {
                ...(GLib.file_test(builtinCfg, GLib.FileTest.EXISTS)
                    ? {
                        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinCfg,
                        ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: builtinCfg,
                    }
                    : {}),
                ...personalOverride.env,
            };
            const effectiveModel = personalOverride.resolvedModel || config.model || '';
            const label = effectiveModel ? `ZCode · ${effectiveModel}` : 'ZCode';

            let bridgeArgs = [];
            try {
                const selfFile = Gio.File.new_for_uri(import.meta.url);
                const selfDir = selfFile.get_parent()?.get_path();
                if (selfDir) {
                    const bridgePath = GLib.build_filenamev([selfDir, 'zcodeBridge.cjs']);
                    if (GLib.file_test(bridgePath, GLib.FileTest.EXISTS)) {
                        bridgeArgs = ['--require', bridgePath];
                    }
                }
            } catch (_) {}

            const nodeExe = findExecutableInDirs('node', pathDirs);
            if (nodeExe) {
                return {
                    backend: 'zcode',
                    executable: nodeExe,
                    commandPrefix: [nodeExe, ...bridgeArgs, bundledCjs],
                    extraEnv: baseEnv,
                    pathEnv: buildSearchPath(nodeExe).join(':'),
                    label,
                };
            }
            const electronExe = '/opt/ZCode/zcode';
            if (GLib.file_test(electronExe, GLib.FileTest.IS_EXECUTABLE)) {
                return {
                    backend: 'zcode',
                    executable: electronExe,
                    commandPrefix: [electronExe, ...bridgeArgs, bundledCjs],
                    extraEnv: {...baseEnv, ELECTRON_RUN_AS_NODE: '1'},
                    pathEnv: pathDirs.join(':'),
                    label,
                };
            }
        }
        return null;
    };

    const resolveCodex = () => {
        const customCodex = rawExec && rawExec !== 'pi' ? findExecutableInDirs(rawExec, pathDirs) : null;
        const codexExe = customCodex || findExecutableInDirs('codex', pathDirs);
        if (!codexExe) return null;
        return {
            backend: 'codex',
            executable: codexExe,
            pathEnv: buildSearchPath(codexExe).join(':'),
            label: config.model ? `Codex · ${config.model}` : 'Codex',
        };
    };

    const resolveOpenAI = () => {
        const baseUrl = (config.openaiBaseUrl || '').trim();
        if (!baseUrl) return null;
        const chatUrl = normalizeOpenAIEndpoint(baseUrl, '/chat/completions');
        const modelsUrl = normalizeOpenAIEndpoint(baseUrl, '/models');
        const modelId = (config.openaiModel || config.model || '').trim();
        return {
            backend: 'openai',
            chatUrl,
            modelsUrl,
            apiKey: (config.openaiApiKey || '').trim(),
            modelId,
            systemPrompt: (config.systemPrompt || '').trim(),
            label: modelId ? `API · ${modelId}` : 'OpenAI API',
        };
    };

    if (requested === 'openai') {
        const r = resolveOpenAI();
        if (!r) throw new Error('请在设置中填写自定义 OpenAI 接口地址（Base URL）');
        return r;
    }
    if (requested === 'pi') {
        const r = resolvePi();
        if (!r) throw new Error(`未找到 Pi 可执行文件（${rawExec || 'pi'}）；请在设置中填写绝对路径或切换后端`);
        return r;
    }
    if (requested === 'zcode') {
        const r = resolveZCode();
        if (!r) throw new Error('未找到 ZCode CLI（/opt/ZCode/resources/glm/zcode.cjs）');
        return r;
    }
    if (requested === 'codex') {
        const r = resolveCodex();
        if (!r) throw new Error('未找到 Codex CLI（codex）');
        return r;
    }

    // 'auto' mode: prefer Pi -> ZCode -> Codex -> configured OpenAI API
    const detected = resolvePi() || resolveZCode() || resolveCodex() || resolveOpenAI();
    if (!detected) {
        throw new Error('未检测到可用后端（Pi / ZCode / Codex / OpenAI API）；请在设置中配置');
    }
    return detected;
}

// Owns child subprocesses or HTTP streams, never calls a shell or blocks waiting for network/model I/O.
export class PiClient {
    constructor(onEvent, onExit) {
        this._event = onEvent;
        this._exit = onExit;
        this._pending = new Map();
        this._sequence = 0;
        this._closed = false;
        this._writeQueue = [];
        this._stderrLines = [];
        this._turnWatchdog = 0;
        this._httpSession = null;
        this._alwaysAllowedTools = new Set();
        this._turnStdin = null;
    }

    start(config, workspace, sessionDir, sessionId) {
        this._config = config;
        this._workspace = workspace;
        this._sessionDir = sessionDir;
        this._sessionId = sessionId;
        this._runtime = resolveBackendRuntime(config);
        this._backend = this._runtime.backend;

        if (this._backend === 'pi') {
            this._startPiRpc();
        } else {
            if (this._backend === 'openai') {
                this._httpSession = new Soup.Session({timeout: 120});
            }
            this._startTranscriptBackend();
        }
    }

    _startPiRpc() {
        const launcher = new Gio.SubprocessLauncher({
            flags:
                Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE,
        });
        launcher.set_cwd(this._workspace);
        launcher.setenv('PATH', this._runtime.pathEnv, true);
        launcher.setenv('NO_COLOR', '1', true);
        for (const [k, v] of Object.entries(this._runtime.extraEnv || {})) {
            launcher.setenv(k, String(v), true);
        }
        this._cancel = new Gio.Cancellable();
        const rpcConfig = {...this._config, executable: this._runtime.executable};
        this._process = launcher.spawnv(buildArgs(rpcConfig, this._sessionDir, this._sessionId));
        this._input = new Gio.DataInputStream({base_stream: this._process.get_stdout_pipe()});
        this._stderr = new Gio.DataInputStream({base_stream: this._process.get_stderr_pipe()});
        this._output = this._process.get_stdin_pipe();
        this._readStdout();
        this._readStderr(this._stderr, this._cancel);
    }

    _modelSignature() {
        return `${this._backend}:${this._config?.provider || ''}:${this._config?.model || ''}`;
    }

    _startTranscriptBackend() {
        this._stateFile = GLib.build_filenamev([this._sessionDir, `${this._sessionId}.qc.json`]);
        this._history = [];
        this._remoteSessionId = '';
        if (GLib.file_test(this._stateFile, GLib.FileTest.EXISTS)) {
            try {
                const [ok, raw] = GLib.file_get_contents(this._stateFile);
                if (ok && raw) {
                    const parsed = JSON.parse(Decoder.decode(raw));
                    if (Array.isArray(parsed.messages)) this._history = parsed.messages;
                    const sigMatches = !parsed.modelSignature || parsed.modelSignature === this._modelSignature();
                    if (sigMatches && typeof parsed.remoteSessionId === 'string') {
                        this._remoteSessionId = parsed.remoteSessionId;
                    }
                }
            } catch (_) {}
        }
    }

    _saveTranscriptState() {
        if (!this._stateFile) return;
        try {
            const payload = JSON.stringify({
                backend: this._backend,
                modelSignature: this._modelSignature(),
                remoteSessionId: this._remoteSessionId || '',
                updatedAt: Date.now(),
                messages: this._history,
            });
            GLib.file_set_contents(this._stateFile, Encoder.encode(payload));
        } catch (_) {}
    }

    _formatStderrSuffix() {
        if (!this._stderrLines.length) return '';
        const last = this._stderrLines.slice(-2).join(' | ');
        return last ? `（${last.slice(0, 140)}）` : '';
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

    _refreshPromptTimeouts() {
        for (const [id, p] of this._pending.entries()) {
            if (p.type === 'prompt') {
                if (p.timeout) GLib.source_remove(p.timeout);
                p.timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 90, () => {
                    this._pending.delete(id);
                    p.reject(new Error('Pi 响应流超时'));
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    request(type, fields = {}) {
        if (this._closed) return Promise.reject(new Error('服务已关闭'));
        if (this._backend !== 'pi') {
            return this._requestTranscriptBackend(type, fields);
        }
        if (!this._process) return Promise.reject(new Error('Pi 未启动'));
        const id = `qc-${++this._sequence}`;
        const timeoutSeconds = type === 'prompt' ? 60 : type === 'abort' ? 25 : 20;
        return new Promise((resolve, reject) => {
            const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
                this._pending.delete(id);
                reject(new Error(`Pi 请求超时：${type}${this._formatStderrSuffix()}`));
                return GLib.SOURCE_REMOVE;
            });
            this._pending.set(id, {type, resolve, reject, timeout});
            const bytes = Encoder.encode(JSON.stringify({id, type, ...fields}) + '\n');
            this._writeQueue.push(bytes);
            this._writeNext();
        });
    }

    _requestTranscriptBackend(type, fields = {}) {
        if (type === 'get_state') {
            return Promise.resolve({
                backend: this._backend,
                model: {id: this._runtime.label},
            });
        }
        if (type === 'get_messages') {
            return Promise.resolve({messages: this._history});
        }
        if (type === 'abort') {
            this._abortActiveTurn();
            return Promise.resolve({aborted: true});
        }
        if (type === 'permission_response') {
            return this._sendTurnPermissionResponse(fields);
        }
        if (type === 'prompt') {
            if (this._backend === 'openai') {
                return this._runOpenAITurn(fields.message || '');
            }
            return this._runSingleTurnSubprocess(fields.message || '');
        }
        return Promise.resolve({});
    }

    _sendTurnPermissionResponse({requestId = '', decision = 'deny', alwaysAllow = false, toolName = ''} = {}) {
        if (alwaysAllow && toolName) {
            this._alwaysAllowedTools.add(toolName);
        }
        if (!this._turnStdin) {
            return Promise.resolve({sent: false});
        }
        const payload = JSON.stringify({
            type: 'permission_response',
            requestId,
            decision,
            alwaysAllow: Boolean(alwaysAllow),
        }) + '\n';
        const bytes = Encoder.encode(payload);
        return new Promise(resolve => {
            try {
                this._turnStdin.write_all_async(bytes, GLib.PRIORITY_DEFAULT, this._turnCancel, (stream, res) => {
                    try {
                        stream.write_all_finish(res);
                        stream.flush_async(GLib.PRIORITY_DEFAULT, this._turnCancel, () => {});
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
                    this._runtime.label = `API · ${firstId}`;
                    resolve(firstId);
                } catch (e) {
                    reject(new Error(`请在设置中填写模型 ID（自动拉取失败：${e.message}）`));
                }
            });
        });
    }

    async _runOpenAITurn(promptText) {
        if (this._turnActive) {
            throw new Error('上一轮请求仍在执行中');
        }
        this._turnActive = true;
        this._turnAborted = false;
        this._turnCancel = new Gio.Cancellable();

        this._history.push({role: 'user', content: promptText});
        this._saveTranscriptState();

        let modelId;
        try {
            modelId = await this._discoverOpenAIModelAsync(this._turnCancel);
        } catch (err) {
            this._turnActive = false;
            this._turnCancel = null;
            throw err;
        }

        const apiMessages = [];
        if (this._runtime.systemPrompt) {
            apiMessages.push({role: 'system', content: this._runtime.systemPrompt});
        } else {
            apiMessages.push({
                role: 'system',
                content: '你是 Ubuntu 26 / GNOME 50 桌面顶栏中的「随问」AI 助手。请用清晰、简明、准确的中文回答问题。',
            });
        }
        for (const m of this._history.slice(-30)) {
            if (m && (m.role === 'user' || m.role === 'assistant')) {
                const txt = messageText(m);
                if (txt) apiMessages.push({role: m.role, content: txt});
            }
        }

        const msg = Soup.Message.new('POST', this._runtime.chatUrl);
        if (!msg) {
            this._turnActive = false;
            this._turnCancel = null;
            throw new Error(`无效的 OpenAI 接口地址：${this._runtime.chatUrl}`);
        }

        const reqHeaders = msg.get_request_headers();
        reqHeaders.append('Content-Type', 'application/json');
        reqHeaders.append('Accept', 'text/event-stream, application/json');
        if (this._runtime.apiKey) {
            reqHeaders.append('Authorization', `Bearer ${this._runtime.apiKey}`);
        }

        const bodyBytes = Encoder.encode(JSON.stringify({
            model: modelId,
            stream: true,
            messages: apiMessages,
        }));
        msg.set_request_body_from_bytes('application/json', new GLib.Bytes(bodyBytes));

        this._event({type: 'message_start', message: {role: 'assistant'}});

        let streamedText = '';
        let streamedThinking = '';
        let nonSseLines = [];

        const finishOpenAITurn = (errorText = '') => {
            if (this._turnWatchdog) {
                GLib.source_remove(this._turnWatchdog);
                this._turnWatchdog = 0;
            }
            this._turnActive = false;
            this._turnCancel = null;
            if (this._closed) return;

            if (!streamedText && nonSseLines.length > 0 && !errorText) {
                const joined = nonSseLines.join('\n').trim();
                if (joined.startsWith('{')) {
                    try {
                        const obj = JSON.parse(joined);
                        if (obj.error) {
                            errorText = obj.error.message || JSON.stringify(obj.error);
                        } else {
                            const content = obj.choices?.[0]?.message?.content;
                            if (typeof content === 'string' && content) {
                                streamedText = content;
                            }
                        }
                    } catch (_) {}
                }
            }

            if (streamedText) {
                const parts = [];
                if (streamedThinking) parts.push({type: 'thinking', thinking: streamedThinking});
                parts.push({type: 'text', text: streamedText});
                this._history.push({role: 'assistant', content: parts});
                this._saveTranscriptState();
                this._event({type: 'message_end', message: {role: 'assistant', content: parts}});
            } else if (!this._turnAborted && errorText) {
                this._event({
                    type: 'message_end',
                    message: {role: 'assistant', content: '', errorMessage: errorText},
                });
            }
            this._event({type: 'agent_settled', aborted: Boolean(this._turnAborted)});
        };

        const resetWatchdog = () => {
            if (this._turnWatchdog) GLib.source_remove(this._turnWatchdog);
            this._turnWatchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 120, () => {
                this._turnWatchdog = 0;
                this._turnCancel?.cancel();
                finishOpenAITurn('OpenAI 接口响应超时（120s）');
                return GLib.SOURCE_REMOVE;
            });
        };
        resetWatchdog();

        this._httpSession.send_async(msg, GLib.PRIORITY_DEFAULT, this._turnCancel, (sess, res) => {
            if (this._closed) return;
            let baseStream;
            try {
                baseStream = sess.send_finish(res);
            } catch (err) {
                if (this._turnAborted) {
                    finishOpenAITurn('');
                } else {
                    finishOpenAITurn(`请求失败：${err.message}`);
                }
                return;
            }

            const status = msg.get_status();
            const dataStream = new Gio.DataInputStream({base_stream: baseStream});

            if (status < 200 || status >= 300) {
                const errLines = [];
                const readErr = () => {
                    dataStream.read_line_async(GLib.PRIORITY_DEFAULT, this._turnCancel, (s, r) => {
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
                        finishOpenAITurn(detail);
                    });
                };
                readErr();
                return;
            }

            const readSseLine = () => {
                if (this._closed || !this._turnActive) return;
                dataStream.read_line_async(GLib.PRIORITY_DEFAULT, this._turnCancel, (s, r) => {
                    if (this._closed) return;
                    try {
                        const [line] = s.read_line_finish_utf8(r);
                        if (line === null) {
                            finishOpenAITurn('');
                            return;
                        }
                        resetWatchdog();
                        const sse = parseOpenAISSELine(line);
                        if (sse) {
                            if (sse.error) {
                                finishOpenAITurn(sse.error);
                                return;
                            }
                            if (sse.done) {
                                finishOpenAITurn('');
                                return;
                            }
                            if (sse.thinkingDelta) {
                                streamedThinking += sse.thinkingDelta;
                                this._event({
                                    type: 'message_update',
                                    assistantMessageEvent: {type: 'thinking_delta', delta: sse.thinkingDelta},
                                });
                            }
                            if (sse.textDelta) {
                                streamedText += sse.textDelta;
                                this._event({
                                    type: 'message_update',
                                    assistantMessageEvent: {type: 'text_delta', delta: sse.textDelta},
                                });
                            }
                        } else if (line.trim()) {
                            nonSseLines.push(line);
                        }
                        readSseLine();
                    } catch (err) {
                        if (this._turnAborted) finishOpenAITurn('');
                        else finishOpenAITurn(err.message);
                    }
                });
            };
            readSseLine();
        });

        return {disposition: 'streaming'};
    }

    _runSingleTurnSubprocess(promptText) {
        if (this._turnProcess) {
            return Promise.reject(new Error('上一轮请求仍在执行中'));
        }
        this._history.push({role: 'user', content: promptText});
        this._saveTranscriptState();

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
        const turnExtraEnv = {
            ...(this._runtime.extraEnv || {}),
            ...(this._backend === 'zcode' ? prepareZCodePersonalConfigEnv(this._config).env : {}),
            ...(this._alwaysAllowedTools.size > 0
                ? {QUICK_CHAT_AUTO_APPROVE_TOOLS: Array.from(this._alwaysAllowedTools).join(',')}
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
            ? buildZCodeArgs(spawnConfig, promptText, this._remoteSessionId)
            : buildCodexArgs(spawnConfig, this._workspace, promptText, this._remoteSessionId);

        try {
            this._turnCancel = new Gio.Cancellable();
            this._turnAborted = false;
            this._turnProcess = launcher.spawnv(argv);
            if (this._backend === 'zcode') {
                this._turnStdin = this._turnProcess.get_stdin_pipe();
            } else {
                this._turnStdin = null;
                try { this._turnProcess.get_stdin_pipe()?.close(null); } catch (_) {}
            }
        } catch (error) {
            this._turnProcess = null;
            this._turnStdin = null;
            return Promise.reject(error);
        }

        const stdout = new Gio.DataInputStream({base_stream: this._turnProcess.get_stdout_pipe()});
        const stderr = new Gio.DataInputStream({base_stream: this._turnProcess.get_stderr_pipe()});
        this._readStderr(stderr, this._turnCancel);

        let streamedText = '';
        let streamedThinking = '';
        let finalError = '';
        const seenPermissionIds = new Set();

        const pauseTurnWatchdog = () => {
            if (this._turnWatchdog) {
                GLib.source_remove(this._turnWatchdog);
                this._turnWatchdog = 0;
            }
        };

        const resetTurnWatchdog = () => {
            pauseTurnWatchdog();
            this._turnWatchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 120, () => {
                this._turnWatchdog = 0;
                finalError = '响应超时（120s 无输出）';
                this._abortActiveTurn();
                return GLib.SOURCE_REMOVE;
            });
        };
        resetTurnWatchdog();

        const readNextLine = () => {
            if (this._closed || !this._turnProcess) return;
            stdout.read_line_async(GLib.PRIORITY_DEFAULT, this._turnCancel, (stream, res) => {
                if (this._closed) return;
                try {
                    const [line] = stream.read_line_finish_utf8(res);
                    if (line === null) {
                        this._finishTurnSubprocess(streamedText, streamedThinking, finalError);
                        return;
                    }
                    resetTurnWatchdog();
                    const trimmed = line.trim();
                    let record = null;
                    if (trimmed.startsWith('{')) {
                        try { record = JSON.parse(trimmed); } catch (_) {}
                    }
                    if (record) {
                        const norm = normalizeEvent(this._backend, record);
                        if (norm) {
                            if (norm.type === 'permission_request') {
                                if (!seenPermissionIds.has(norm.requestId)) {
                                    seenPermissionIds.add(norm.requestId);
                                    pauseTurnWatchdog();
                                    this._event(norm);
                                }
                            } else if (norm.type === 'session_bound' && norm.sessionId) {
                                this._remoteSessionId = norm.sessionId;
                                this._saveTranscriptState();
                            } else if (norm.type === 'turn_result') {
                                if (norm.sessionId) this._remoteSessionId = norm.sessionId;
                                if (norm.text && !streamedText) {
                                    streamedText = norm.text;
                                    this._event({
                                        type: 'message_end',
                                        message: {role: 'assistant', content: streamedText},
                                    });
                                }
                            } else if (norm.type === 'text_snapshot') {
                                const delta = norm.text.startsWith(streamedText)
                                    ? norm.text.slice(streamedText.length)
                                    : norm.text;
                                streamedText = norm.text;
                                if (delta) {
                                    this._event({
                                        type: 'message_update',
                                        assistantMessageEvent: {type: 'text_delta', delta},
                                    });
                                }
                            } else if (norm.type === 'thinking_snapshot') {
                                const delta = norm.text.startsWith(streamedThinking)
                                    ? norm.text.slice(streamedThinking.length)
                                    : norm.text;
                                streamedThinking = norm.text;
                                if (delta) {
                                    this._event({
                                        type: 'message_update',
                                        assistantMessageEvent: {type: 'thinking_delta', delta},
                                    });
                                }
                            } else {
                                if (norm.sessionId) {
                                    this._remoteSessionId = norm.sessionId;
                                }
                                if (norm.type === 'message_update') {
                                    const ev = norm.assistantMessageEvent;
                                    if (ev?.type === 'text_delta') streamedText += ev.delta || '';
                                    if (ev?.type === 'thinking_delta') streamedThinking += ev.delta || '';
                                }
                                if (norm.type === 'message_end' && norm.message) {
                                    if (norm.message.content) streamedText = norm.message.content;
                                    if (norm.message.errorMessage) finalError = norm.message.errorMessage;
                                }
                                this._event(norm);
                            }
                        }
                    }
                    readNextLine();
                } catch (err) {
                    if (!this._closed && !this._turnAborted) {
                        this._finishTurnSubprocess(streamedText, streamedThinking, err.message);
                    }
                }
            });
        };

        readNextLine();
        return Promise.resolve({disposition: 'streaming'});
    }

    _finishTurnSubprocess(streamedText, streamedThinking, finalError) {
        if (this._turnWatchdog) {
            GLib.source_remove(this._turnWatchdog);
            this._turnWatchdog = 0;
        }
        const proc = this._turnProcess;
        this._turnProcess = null;
        this._turnCancel = null;

        if (this._closed) return;

        if (streamedText) {
            const contentParts = [];
            if (streamedThinking) contentParts.push({type: 'thinking', thinking: streamedThinking});
            contentParts.push({type: 'text', text: streamedText});
            this._history.push({role: 'assistant', content: contentParts});
            this._saveTranscriptState();
            this._event({
                type: 'message_end',
                message: {role: 'assistant', content: contentParts},
            });
        } else if (!this._turnAborted && (finalError || this._stderrLines.length)) {
            const errMsg = finalError || this._stderrLines.slice(-2).join(' ');
            this._event({
                type: 'message_end',
                message: {role: 'assistant', content: '', errorMessage: errMsg},
            });
        }

        try { proc?.force_exit(); } catch (_) {}
        this._event({type: 'agent_settled', aborted: Boolean(this._turnAborted)});
    }

    _abortActiveTurn() {
        this._turnAborted = true;
        this._turnActive = false;
        if (this._turnWatchdog) {
            GLib.source_remove(this._turnWatchdog);
            this._turnWatchdog = 0;
        }
        this._turnCancel?.cancel();
        const proc = this._turnProcess;
        this._turnProcess = null;
        if (proc) {
            try { proc.send_signal(15); } catch (_) {}
            try { proc.force_exit(); } catch (_) {}
        }
        if (!this._closed) {
            this._event({type: 'agent_settled', aborted: true});
        }
    }

    _writeNext() {
        if (this._closed || this._writing || !this._writeQueue.length || !this._output) return;
        this._writing = true;
        const bytes = this._writeQueue.shift();
        this._output.write_all_async(bytes, GLib.PRIORITY_DEFAULT, this._cancel, (stream, result) => {
            this._writing = false;
            try {
                stream.write_all_finish(result);
            } catch (error) {
                if (!this._closed) this._fail(error);
                return;
            }
            this._writeNext();
        });
    }

    _readStdout() {
        if (this._closed || !this._input) return;
        this._input.read_line_async(GLib.PRIORITY_DEFAULT, this._cancel, (stream, result) => {
            if (this._closed) return;
            try {
                const [line] = stream.read_line_finish_utf8(result);
                if (line === null) {
                    const detail = this._formatStderrSuffix();
                    this._fail(new Error(`Pi 已退出${detail || '；请检查安装、模型及日志'}`));
                    return;
                }
                let record;
                try {
                    record = JSON.parse(line);
                } catch (_) {
                    this._readStdout();
                    return;
                }
                if (record.type === 'response' && this._pending.has(record.id)) {
                    const p = this._pending.get(record.id);
                    this._pending.delete(record.id);
                    GLib.source_remove(p.timeout);
                    if (record.success) p.resolve(record.data ?? {});
                    else p.reject(new Error(record.error || `Pi 请求失败：${record.command}`));
                } else if (record.type !== 'response') {
                    this._refreshPromptTimeouts();
                    this._event(record);
                }
                this._readStdout();
            } catch (error) {
                if (!this._closed) this._fail(error);
            }
        });
    }

    _fail(error) {
        if (this._closed) return;
        this.close();
        this._exit(error);
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        this._turnActive = false;
        if (this._turnWatchdog) {
            GLib.source_remove(this._turnWatchdog);
            this._turnWatchdog = 0;
        }
        this._cancel?.cancel();
        this._turnCancel?.cancel();
        try { this._httpSession?.abort(); } catch (_) {}
        this._httpSession = null;
        for (const p of this._pending.values()) {
            GLib.source_remove(p.timeout);
            p.reject(new Error('服务已关闭'));
        }
        this._pending.clear();
        this._writeQueue = [];

        const terminateCleanly = proc => {
            if (!proc) return;
            try { proc.send_signal(15); } catch (_) {}
            try { proc.force_exit(); } catch (_) {}
        };
        terminateCleanly(this._turnProcess);
        terminateCleanly(this._process);
        this._turnProcess = null;
        this._process = null;
    }
}
