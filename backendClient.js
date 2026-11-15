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
    getBackendCapabilities,
    mapReasoningEffort,
    normalizeEffectiveAgentMode,
    normalizeOpenAIEndpoint,
    parseOpenAISSELine,
} from './protocol.js';
import {
    buildSearchPath,
    createGioCliEnv,
    detectBackendSelection,
    findExecutableInDirs,
    probeCliCapabilities,
    readJsonFileSync,
} from './core/backendDetect.js';
import {UNCONFIGURED_BACKEND_MESSAGE} from './core/configMigration.js';
import {
    cleanupStaleRuntimeFiles,
    getPrivateRuntimeDir,
    getUserSpecialDirs,
    removeFileQuietly,
    writePrivateFileSync,
} from './core/paths.js';
import {SessionStore} from './core/sessionStore.js';
import {TurnController} from './core/turnController.js';
import {
    BRIDGE_EXPECTED_PROTOCOL_VERSION,
    CliTurnMonitor,
    DEFAULT_BRIDGE_HANDSHAKE_TIMEOUT_MS,
    DEFAULT_KILL_GRACE_MS,
    buildProcessGroupKillArgv,
    evaluateSubprocessOutcome,
    isSafeProcessGroupId,
    prepareZCodeConfigOverride,
    validateCliPromptLength,
    wrapArgvWithSetsid,
} from './runtime/cliProcessRunner.js';

export {buildSearchPath, findExecutableInDirs};

const Encoder = new TextEncoder();
const Decoder = new TextDecoder('utf-8');
const DEFAULT_APPROVAL_TIMEOUT_SEC = 300;

function resolveKillExecutable() {
    if (GLib.file_test('/bin/kill', GLib.FileTest.IS_EXECUTABLE)) return '/bin/kill';
    if (GLib.file_test('/usr/bin/kill', GLib.FileTest.IS_EXECUTABLE)) return '/usr/bin/kill';
    return '';
}

function resolveSetsidExecutable(pathDirs = []) {
    if (GLib.file_test('/usr/bin/setsid', GLib.FileTest.IS_EXECUTABLE)) return '/usr/bin/setsid';
    if (GLib.file_test('/bin/setsid', GLib.FileTest.IS_EXECUTABLE)) return '/bin/setsid';
    return findExecutableInDirs('setsid', pathDirs) || '';
}

function signalIsolatedProcessGroup(pgid, signalName, killBin) {
    if (!killBin || !isSafeProcessGroupId(pgid)) return false;
    try {
        const argv = buildProcessGroupKillArgv(pgid, signalName, killBin);
        const killer = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        killer.wait_async(null, (p, res) => {
            try { p.wait_finish(res); } catch (_) {}
        });
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Terminates a CLI subprocess and its isolated `setsid` process group cleanly:
 * sends SIGTERM first, gives DEFAULT_KILL_GRACE_MS (800ms) for clean exit,
 * and escalates to SIGKILL only within the child's own isolated process group.
 */
function terminateProcessTreeGracefully(proc, {pgid = 0, isolatedProcessGroup = false} = {}) {
    if (!proc) return;
    const killBin = isolatedProcessGroup ? resolveKillExecutable() : '';
    const canKillGroup = Boolean(isolatedProcessGroup && killBin && isSafeProcessGroupId(pgid));

    let exited = false;
    try {
        proc.wait_async(null, (p, res) => {
            exited = true;
            try { p.wait_finish(res); } catch (_) {}
        });
    } catch (_) {}

    if (canKillGroup) {
        signalIsolatedProcessGroup(pgid, 'TERM', killBin);
    }
    try {
        proc.send_signal(15); // SIGTERM
    } catch (_) {
        if (canKillGroup) signalIsolatedProcessGroup(pgid, 'KILL', killBin);
        try { proc.force_exit(); } catch (__) {}
        return;
    }

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEFAULT_KILL_GRACE_MS, () => {
        if (!exited) {
            if (canKillGroup) {
                signalIsolatedProcessGroup(pgid, 'KILL', killBin);
            }
            try { proc.force_exit(); } catch (_) {}
        }
        return GLib.SOURCE_REMOVE;
    });
}

function createDefaultZCodeConfigIo() {
    return {
        homeDir: GLib.get_home_dir(),
        fileExists: p => Boolean(p && GLib.file_test(p, GLib.FileTest.EXISTS)),
        readJson: readJsonFileSync,
        getRuntimeDir: getPrivateRuntimeDir,
        makeUuid: () => GLib.uuid_string_random(),
        writePrivateFile: (p, bytes) => writePrivateFileSync(p, bytes),
        removeFile: removeFileQuietly,
    };
}

/**
 * Generates and verifies an isolated 0600 temporary ZCode personal provider config file
 * inside XDG_RUNTIME_DIR/gnome-quick-chat without modifying ~/.zcode/v2/provider_config.json.
 *
 * Fail-closed (Stage B2): if the user explicitly configured provider, model, or reasoningEffort
 * and the config cannot be read, applied, written, or verified on disk, throws an explicit Error
 * rather than silently running another model.
 */
export function createIsolatedZCodeConfigOverride(config, ioEnv = null) {
    return prepareZCodeConfigOverride(config, ioEnv || createDefaultZCodeConfigIo());
}

export function resolveBackendRuntime(config = {}) {
    const rawZCodePath = String(config.zcodePath || '').trim();
    const rawCodexPath = String(config.codexPath || '').trim();
    const rawBaseUrl = String(config.openaiBaseUrl || '').trim();
    const requestedMode = String(config.mode || 'readonly').trim();

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
            resolvedProvider: '',
            resolvedModel: '',
            capabilities: getBackendCapabilities('unconfigured', requestedMode),
            effectiveModeInfo: {effectiveMode: 'chat', downgradedFromChat: false, notice: ''},
        };
    }

    if (!selection.available) {
        throw new Error(selection.reason || UNCONFIGURED_BACKEND_MESSAGE);
    }

    if (effective === 'openai') {
        const modelId = String(config.openaiModel || config.model || '').trim();
        const effectiveModeInfo = normalizeEffectiveAgentMode('openai', requestedMode);
        return {
            backend: 'openai',
            available: true,
            baseUrl: rawBaseUrl,
            chatUrl: normalizeOpenAIEndpoint(rawBaseUrl, '/chat/completions'),
            modelsUrl: normalizeOpenAIEndpoint(rawBaseUrl, '/models'),
            apiKey: String(config.openaiApiKey || '').trim(),
            modelId,
            resolvedProvider: 'openai',
            resolvedModel: modelId,
            systemPrompt: String(config.systemPrompt || '').trim(),
            reasoningEffort: mapReasoningEffort(config.reasoningEffort),
            label: modelId || 'OpenAI API',
            capabilities: getBackendCapabilities('openai', effectiveModeInfo.effectiveMode),
            effectiveModeInfo,
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
        const resolvedProvider = preview?.providerId
            || config.provider
            || personalObj?.config?.defaultModelSelection?.providerId
            || '';
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

        const setsidPath = resolveSetsidExecutable(pathDirs);
        const nodeExe = findExecutableInDirs('node', pathDirs);

        let executable = '';
        let commandPrefix = [];
        let extraEnv = {...baseEnv};
        let pathEnv = '';
        let probePrefix = [];
        let probeEnv = {...baseEnv};

        if (cjsTarget) {
            if (nodeExe) {
                executable = nodeExe;
                commandPrefix = [nodeExe, ...bridgeArgs, cjsTarget];
                probePrefix = [nodeExe, cjsTarget];
                pathEnv = buildSearchPath(nodeExe).join(':');
            } else {
                const electronExe = '/opt/ZCode/zcode';
                if (!GLib.file_test(electronExe, GLib.FileTest.IS_EXECUTABLE)) {
                    throw new Error('找到 ZCode 脚本但缺少 Node 或 Electron 运行时');
                }
                executable = electronExe;
                commandPrefix = [electronExe, ...bridgeArgs, cjsTarget];
                probePrefix = [electronExe, cjsTarget];
                extraEnv = {...baseEnv, ELECTRON_RUN_AS_NODE: '1'};
                probeEnv = {...baseEnv, ELECTRON_RUN_AS_NODE: '1'};
                pathEnv = pathDirs.join(':');
            }
        } else {
            const zcodeExe = resolvedCustom || findExecutableInDirs('zcode', pathDirs);
            if (!zcodeExe) {
                throw new Error('未检测到本机 ZCode CLI，请安装 ZCode 或在设置中检查路径');
            }
            executable = zcodeExe;
            commandPrefix = [zcodeExe];
            probePrefix = [zcodeExe];
            pathEnv = buildSearchPath(zcodeExe).join(':');
            if (bridgePath && !bridgePath.includes('"')) {
                const existingNodeOpts = GLib.getenv('NODE_OPTIONS') || '';
                extraEnv.NODE_OPTIONS = `${existingNodeOpts} --require "${bridgePath}"`.trim();
            }
        }

        const cliCapabilities = probeCliCapabilities('zcode', probePrefix, probeEnv);
        const effectiveModeInfo = normalizeEffectiveAgentMode('zcode', requestedMode, cliCapabilities);
        return {
            backend: 'zcode',
            available: true,
            executable,
            commandPrefix,
            bridgePath,
            setsidPath,
            extraEnv,
            pathEnv,
            resolvedProvider,
            resolvedModel: effectiveModel,
            label,
            cliCapabilities,
            effectiveModeInfo,
            capabilities: getBackendCapabilities('zcode', effectiveModeInfo.effectiveMode, cliCapabilities),
        };
    }

    if (effective === 'codex') {
        const cliEnv = createGioCliEnv(rawCodexPath);
        const codexExe = (rawCodexPath ? cliEnv.resolveCandidate(rawCodexPath) : '')
            || findExecutableInDirs('codex', cliEnv.pathDirs);
        if (!codexExe) {
            throw new Error('未检测到本机 Codex CLI 可执行文件');
        }
        const setsidPath = resolveSetsidExecutable(cliEnv.pathDirs);
        const cliCapabilities = probeCliCapabilities('codex', [codexExe], {});
        const effectiveModeInfo = normalizeEffectiveAgentMode('codex', requestedMode, cliCapabilities);
        const resolvedModel = String(config.model || '').trim();
        return {
            backend: 'codex',
            available: true,
            executable: codexExe,
            setsidPath,
            pathEnv: buildSearchPath(codexExe).join(':'),
            resolvedProvider: String(config.provider || 'openai').trim(),
            resolvedModel,
            label: resolvedModel || 'Codex',
            cliCapabilities,
            effectiveModeInfo,
            capabilities: getBackendCapabilities('codex', effectiveModeInfo.effectiveMode, cliCapabilities),
        };
    }

    throw new Error(UNCONFIGURED_BACKEND_MESSAGE);
}

export class BackendClient {
    constructor(onEvent, onExit) {
        this._event = onEvent;
        this._exit = onExit;
        this._closed = false;
        this._clientGeneration = 0;
        this._httpSession = null;
        this._approvedScopes = new Set();
        this._turns = new TurnController(evt => {
            if (!this._closed) this._event(evt);
        });
        this._store = null;
    }

    start(config, workspace, sessionDir, sessionId, options = {}) {
        this._config = config;
        this._workspace = workspace;
        this._sessionDir = sessionDir;
        this._sessionId = sessionId;
        this._clientGeneration = Number(options.clientGeneration || 0);
        this._specialDirs = getUserSpecialDirs();
        cleanupStaleRuntimeFiles();
        this._runtime = resolveBackendRuntime(config);
        this._backend = this._runtime.backend;

        if (this._backend === 'openai') {
            this._httpSession = new Soup.Session({timeout: 120});
        }
        this._store = new SessionStore(sessionId);
    }

    revokeApprovedScopes() {
        this._approvedScopes.clear();
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

    _terminateTurnProcess(turn, proc) {
        terminateProcessTreeGracefully(proc, {
            pgid: turn?.processGroupId || 0,
            isolatedProcessGroup: Boolean(turn?.isolatedProcessGroup),
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
                model: {
                    id: this._runtime.label,
                    provider: this._runtime.resolvedProvider || '',
                    modelId: this._runtime.resolvedModel || '',
                },
                capabilities: this._runtime.capabilities || null,
                effectiveMode: this._runtime.effectiveModeInfo?.effectiveMode || (this._config?.mode || 'readonly'),
                modeNotice: this._runtime.effectiveModeInfo?.notice || '',
                cliVersion: this._runtime.cliCapabilities?.version || '',
            };
        }
        if (type === 'get_messages') {
            return {messages: this._store ? [...this._store.messages] : []};
        }
        if (type === 'revoke_scopes') {
            this.revokeApprovedScopes();
            return {revoked: true};
        }
        if (type === 'abort') {
            const active = this._turns.activeTurn;
            if (!active || active.finalized) {
                return {aborted: false};
            }
            if (fields.turnId && active.id !== String(fields.turnId)) {
                return {aborted: false, stale: true};
            }
            this._turns.cancelActiveTurn({
                onPersistAssistant: m => this._store?.appendMessage(m, this._backend, this._config),
                onTerminateProcess: proc => this._terminateTurnProcess(active, proc),
                onCleanupTempFiles: files => files.forEach(removeFileQuietly),
            });
            return {aborted: true, turnId: active.id};
        }
        if (type === 'permission_response') {
            return this._sendTurnPermissionResponse(fields);
        }
        if (type === 'prompt') {
            if (this._backend === 'unconfigured') {
                throw new Error(this._runtime?.reason || UNCONFIGURED_BACKEND_MESSAGE);
            }
            const turnMeta = {
                turnId: fields.turnId || '',
                messageId: fields.messageId || '',
                clientGeneration: fields.clientGeneration ?? this._clientGeneration,
                lifecycleGeneration: fields.lifecycleGeneration ?? 0,
            };
            if (this._backend === 'openai') {
                return this._runOpenAITurn(fields.message || '', turnMeta);
            }
            return this._runSingleTurnSubprocess(fields.message || '', turnMeta);
        }
        return {};
    }

    _sendTurnPermissionResponse({
        turnId = '',
        requestId = '',
        decision = 'deny',
        alwaysAllow = false,
        allowSessionRule = false,
        scopeKey = '',
        modifiedInput = undefined,
        reason = '',
    } = {}) {
        const turn = this._turns.activeTurn;
        const cleanReqId = String(requestId || '').trim();
        if (!turn || turn.finalized || !turn.stdin || !cleanReqId) {
            return Promise.resolve({sent: false, rejected: 'no_active_turn_or_request_id'});
        }
        if (turnId && String(turnId) !== turn.id) {
            return Promise.resolve({sent: false, rejected: 'turn_id_mismatch'});
        }
        if (!turn.pendingApprovals.has(cleanReqId)) {
            return Promise.resolve({sent: false, rejected: 'unknown_or_already_resolved_request'});
        }

        const effectiveAlwaysAllow = Boolean(decision === 'allow' && alwaysAllow && allowSessionRule && scopeKey);
        const msgObj = {
            type: 'permission_response',
            turnId: turn.id,
            requestId: cleanReqId,
            decision: decision === 'allow' ? 'allow' : 'deny',
            alwaysAllow: effectiveAlwaysAllow,
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
                        if (this._turns.matchesIdentity(turn, {turnId: turn.id})) {
                            if (effectiveAlwaysAllow) {
                                this._approvedScopes.add(scopeKey);
                            }
                            this._turns.leaveApproval(turn, cleanReqId);
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
                    turn.timedOut = true;
                    try { turn.cancellable?.cancel?.(); } catch (_) {}
                    this._turns.finalizeTurn(turn, {
                        status: 'timed_out',
                        timedOut: true,
                        aborted: false,
                        errorText: onTimeoutMessage,
                        onPersistAssistant: msg => this._store?.appendMessage(msg, this._backend, this._config),
                        onTerminateProcess: proc => this._terminateTurnProcess(turn, proc),
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

    _attachApprovalWatchdog(turn, timeoutSec = DEFAULT_APPROVAL_TIMEOUT_SEC) {
        let approvalTimerId = 0;
        const clearApproval = () => {
            if (approvalTimerId) {
                try { GLib.source_remove(approvalTimerId); } catch (_) {}
                approvalTimerId = 0;
            }
        };
        const startApproval = () => {
            clearApproval();
            if (!this._turns.isCurrent(turn) || timeoutSec <= 0) return;
            approvalTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSec, () => {
                approvalTimerId = 0;
                if (this._turns.isCurrent(turn)) {
                    turn.timedOut = true;
                    try { turn.cancellable?.cancel?.(); } catch (_) {}
                    this._turns.finalizeTurn(turn, {
                        status: 'timed_out',
                        timedOut: true,
                        aborted: false,
                        errorText: `等待工具审批超时（${timeoutSec}s），已安全拒绝并终止本轮任务`,
                        onPersistAssistant: msg => this._store?.appendMessage(msg, this._backend, this._config),
                        onTerminateProcess: proc => this._terminateTurnProcess(turn, proc),
                        onCleanupTempFiles: files => files.forEach(removeFileQuietly),
                    });
                }
                return GLib.SOURCE_REMOVE;
            });
        };
        turn.startApprovalWatchdog = startApproval;
        turn.clearApprovalWatchdog = clearApproval;
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
                    const status = msg.get_status();
                    if (status < 200 || status >= 300) {
                        reject(new Error(`拉取 /models 失败（HTTP ${status}），请在设置中手动填写模型 ID`));
                        return;
                    }
                    const text = Decoder.decode(bytes.get_data() || new Uint8Array());
                    const parsed = JSON.parse(text);
                    const list = Array.isArray(parsed.data) ? parsed.data : [];
                    const firstId = list[0]?.id || '';
                    if (!firstId) {
                        reject(new Error('未指定模型 ID，且 /models 未返回可用模型；请在设置中填写模型 ID'));
                        return;
                    }
                    this._runtime.modelId = firstId;
                    this._runtime.resolvedModel = firstId;
                    this._runtime.label = firstId;
                    resolve(firstId);
                } catch (e) {
                    reject(new Error(`请在设置中填写模型 ID（自动拉取失败：${e.message}）`));
                }
            });
        });
    }

    async _runOpenAITurn(promptText, turnMeta = {}) {
        const cancellable = new Gio.Cancellable();
        const turn = this._turns.beginTurn({
            turnId: turnMeta.turnId,
            messageId: turnMeta.messageId,
            sessionId: this._sessionId,
            clientGeneration: turnMeta.clientGeneration ?? this._clientGeneration,
            lifecycleGeneration: turnMeta.lifecycleGeneration ?? 0,
            backend: 'openai',
            promptText,
            cancellable,
        });

        this._store?.appendMessage({role: 'user', content: promptText}, this._backend, this._config);

        let modelId;
        try {
            modelId = await this._discoverOpenAIModelAsync(turn.cancellable);
        } catch (err) {
            this._turns.finalizeTurn(turn, {status: 'failed', errorText: err.message});
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
            this._turns.finalizeTurn(turn, {status: 'failed', errorText: err.message});
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

        let dataStream = null;
        const closeOpenAIStream = () => {
            if (!dataStream) return;
            const s = dataStream;
            dataStream = null;
            try { s.close_async(GLib.PRIORITY_DEFAULT, null, (st, r) => { try { st.close_finish(r); } catch (_) {} }); } catch (_) {}
        };

        const nonSseLines = [];
        const settleOpenAI = (errorText = '') => {
            closeOpenAIStream();
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

            let status = '';
            let interrupted = false;
            if (turn.timedOut) {
                status = 'timed_out';
            } else if (turn.aborted) {
                status = 'cancelled';
            } else if (errorText) {
                status = 'failed';
            } else if (!turn.sawDoneMarker) {
                status = 'interrupted';
                interrupted = true;
                errorText = '响应连接意外中断（未收到完整流结束标记）';
            } else {
                status = 'completed';
            }

            this._turns.finalizeTurn(turn, {
                status,
                interrupted,
                errorText,
                onPersistAssistant: m => this._store?.appendMessage(m, this._backend, this._config),
            });
        };

        this._httpSession.send_async(msg, GLib.PRIORITY_DEFAULT, turn.cancellable, (sess, res) => {
            if (!this._turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
                try {
                    const staleStream = sess.send_finish(res);
                    staleStream?.close_async(GLib.PRIORITY_DEFAULT, null, (st, r) => { try { st.close_finish(r); } catch (_) {} });
                } catch (_) {}
                return;
            }
            let baseStream;
            try {
                baseStream = sess.send_finish(res);
            } catch (err) {
                settleOpenAI(turn.aborted ? '' : `请求失败：${err.message}`);
                return;
            }

            const status = msg.get_status();
            dataStream = new Gio.DataInputStream({base_stream: baseStream});

            if (status < 200 || status >= 300) {
                const errLines = [];
                const readErr = () => {
                    if (!this._turns.isCurrent(turn) || !dataStream) return;
                    dataStream.read_line_async(GLib.PRIORITY_DEFAULT, turn.cancellable, (s, r) => {
                        if (!this._turns.isCurrent(turn)) {
                            closeOpenAIStream();
                            return;
                        }
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
                if (!this._turns.isCurrent(turn) || !dataStream) return;
                dataStream.read_line_async(GLib.PRIORITY_DEFAULT, turn.cancellable, (s, r) => {
                    if (!this._turns.isCurrent(turn)) {
                        closeOpenAIStream();
                        return;
                    }
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

        return {disposition: 'streaming', turnId: turn.id};
    }

    _runSingleTurnSubprocess(promptText, turnMeta = {}) {
        const cancellable = new Gio.Cancellable();
        const turn = this._turns.beginTurn({
            turnId: turnMeta.turnId,
            messageId: turnMeta.messageId,
            sessionId: this._sessionId,
            clientGeneration: turnMeta.clientGeneration ?? this._clientGeneration,
            lifecycleGeneration: turnMeta.lifecycleGeneration ?? 0,
            backend: this._backend,
            promptText,
            cancellable,
            deferTempCleanupUntilProcessExit: true,
        });

        const cliCaps = this._runtime?.cliCapabilities || null;
        const modeInfo = normalizeEffectiveAgentMode(this._backend, this._config?.mode || 'readonly', cliCaps);
        const effectiveMode = modeInfo.effectiveMode;

        const historyBeforePrompt = this._store ? [...this._store.messages] : [];
        const remoteId = this._store?.remoteSessionId || '';
        const promptWithDesktopEnv = augmentPromptWithDesktopContext(promptText, this._specialDirs, {
            isFirstTurn: !remoteId,
            mode: effectiveMode,
            workspace: this._workspace,
        });
        const effectiveCliPrompt = (!remoteId && historyBeforePrompt.length > 0)
            ? buildCrossBackendPromptWithContext(historyBeforePrompt, promptWithDesktopEnv)
            : promptWithDesktopEnv;

        const requireBridgeHandshake = this._backend === 'zcode' && effectiveMode === 'readonly';
        if (requireBridgeHandshake && !this._runtime?.bridgePath) {
            const err = new Error('未找到 ZCode 权限审批桥接模块（zcodeBridge.cjs），已阻止在需审批模式下启动任务');
            this._turns.finalizeTurn(turn, {status: 'failed', errorText: err.message});
            return Promise.reject(err);
        }

        let zcodeIsolated = {env: {}, tempFilePath: '', resolvedProvider: '', resolvedModel: ''};
        let promptTempFilePath = '';
        let rawArgv = [];
        const useZCodePromptFile = Boolean(this._backend === 'zcode' && this._runtime?.bridgePath);
        const useCodexStdin = Boolean(this._backend === 'codex' && cliCaps?.supportsStdinPrompt !== false);

        try {
            validateCliPromptLength(effectiveCliPrompt, {
                viaArgv: !(useZCodePromptFile || useCodexStdin),
            });

            if (this._backend === 'zcode') {
                zcodeIsolated = createIsolatedZCodeConfigOverride(this._config);
                if (zcodeIsolated.tempFilePath) {
                    turn.tempFiles.push(zcodeIsolated.tempFilePath);
                }
                if (zcodeIsolated.resolvedModel) {
                    this._runtime.resolvedProvider = zcodeIsolated.resolvedProvider || this._runtime.resolvedProvider;
                    this._runtime.resolvedModel = zcodeIsolated.resolvedModel;
                    this._runtime.label = zcodeIsolated.resolvedModel;
                }
                if (useZCodePromptFile) {
                    const runtimeDir = getPrivateRuntimeDir();
                    promptTempFilePath = GLib.build_filenamev([
                        runtimeDir,
                        `zcode-prompt-${GLib.uuid_string_random()}.txt`,
                    ]);
                    writePrivateFileSync(promptTempFilePath, Encoder.encode(effectiveCliPrompt));
                    turn.tempFiles.push(promptTempFilePath);
                }
            }

            const spawnConfig = {
                ...this._config,
                mode: effectiveMode,
                executable: this._runtime.executable,
                commandPrefix: this._runtime.commandPrefix,
                cliCapabilities: cliCaps,
            };
            rawArgv = this._backend === 'zcode'
                ? buildZCodeArgs(spawnConfig, effectiveCliPrompt, remoteId, this._workspace, {
                    cliCaps,
                    usePromptFile: Boolean(promptTempFilePath),
                })
                : buildCodexArgs(spawnConfig, this._workspace, effectiveCliPrompt, remoteId, {
                    cliCaps,
                    stdinPrompt: useCodexStdin,
                });
        } catch (prepErr) {
            this._turns.finalizeTurn(turn, {
                status: 'failed',
                errorText: prepErr.message,
                onCleanupTempFiles: files => files.forEach(removeFileQuietly),
            });
            return Promise.reject(prepErr);
        }

        this._store?.appendMessage({role: 'user', content: promptText}, this._backend, this._config);

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
            ...this._buildXdgEnvVars(),
            ...(this._runtime.extraEnv || {}),
            ...zcodeIsolated.env,
            QUICK_CHAT_SESSION_ID: String(this._sessionId || ''),
            QUICK_CHAT_TURN_ID: String(turn.id || ''),
            QUICK_CHAT_WORKSPACE: String(this._workspace || ''),
            ...(promptTempFilePath ? {QUICK_CHAT_PROMPT_FILE: promptTempFilePath} : {}),
            ...(requireBridgeHandshake
                ? {
                    QUICK_CHAT_REQUIRE_BRIDGE: '1',
                    QUICK_CHAT_BRIDGE_PROTOCOL: String(BRIDGE_EXPECTED_PROTOCOL_VERSION),
                }
                : {}),
            ...(this._approvedScopes.size > 0
                ? {QUICK_CHAT_APPROVED_SCOPES: JSON.stringify(Array.from(this._approvedScopes))}
                : {}),
        };
        for (const [k, v] of Object.entries(turnExtraEnv)) {
            launcher.setenv(k, String(v), true);
        }

        const wrappedSpawn = wrapArgvWithSetsid(rawArgv, this._runtime.setsidPath);
        const turnTempFiles = [...turn.tempFiles];

        let proc;
        try {
            proc = launcher.spawnv(wrappedSpawn.argv);
            turn.process = proc;
            turn.isolatedProcessGroup = wrappedSpawn.isolatedProcessGroup;
            turn.processGroupId = Number.parseInt(proc.get_identifier?.() || '', 10) || 0;
        } catch (spawnErr) {
            this._turns.finalizeTurn(turn, {
                status: 'failed',
                errorText: spawnErr.message,
                onCleanupTempFiles: files => files.forEach(removeFileQuietly),
            });
            return Promise.reject(spawnErr);
        }

        const stdinPipe = proc.get_stdin_pipe();
        if (this._backend === 'zcode') {
            turn.stdin = stdinPipe;
        } else if (useCodexStdin && stdinPipe) {
            const promptBytes = Encoder.encode(effectiveCliPrompt);
            stdinPipe.write_all_async(promptBytes, GLib.PRIORITY_DEFAULT, turn.cancellable, (s, r) => {
                try {
                    s.write_all_finish(r);
                } catch (writeErr) {
                    if (this._turns.isCurrent(turn) && !turn.aborted) {
                        turn.error = `向 Codex CLI 写入提问内容失败：${writeErr.message}`;
                    }
                } finally {
                    try { s.close_async(GLib.PRIORITY_DEFAULT, null, (st, cr) => { try { st.close_finish(cr); } catch (_) {} }); } catch (_) {}
                }
            });
        } else if (stdinPipe) {
            try { stdinPipe.close(null); } catch (_) {}
        }

        const stdout = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        const stderr = new Gio.DataInputStream({base_stream: proc.get_stderr_pipe()});

        const monitor = new CliTurnMonitor({
            turnId: turn.id,
            backend: this._backend,
            requireBridgeHandshake,
        });

        let handshakeTimerId = 0;
        const clearHandshakeTimer = () => {
            if (handshakeTimerId) {
                try { GLib.source_remove(handshakeTimerId); } catch (_) {}
                handshakeTimerId = 0;
            }
        };

        let stdoutDone = false;
        let stderrDone = false;
        let processExited = false;
        let exitCode = null;
        let termSignal = null;
        let streamsClosed = false;

        const closeIoPipes = () => {
            if (streamsClosed) return;
            streamsClosed = true;
            try { stdout.close_async(GLib.PRIORITY_DEFAULT, null, (s, r) => { try { s.close_finish(r); } catch (_) {} }); } catch (_) {}
            try { stderr.close_async(GLib.PRIORITY_DEFAULT, null, (s, r) => { try { s.close_finish(r); } catch (_) {} }); } catch (_) {}
            if (turn.stdin) {
                const st = turn.stdin;
                turn.stdin = null;
                try { st.close_async(GLib.PRIORITY_DEFAULT, null, (s, r) => { try { s.close_finish(r); } catch (_) {} }); } catch (_) {}
            }
        };

        const abortTurnForFatalMonitorError = () => {
            clearHandshakeTimer();
            if (!this._turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
                return;
            }
            closeIoPipes();
            this._turns.finalizeTurn(turn, {
                status: 'failed',
                errorText: monitor.fatalError || 'CLI 安全校验未通过',
                onPersistAssistant: m => this._store?.appendMessage(m, this._backend, this._config),
                onTerminateProcess: p => this._terminateTurnProcess(turn, p),
                onCleanupTempFiles: files => files.forEach(removeFileQuietly),
            });
        };

        const trySettleWhenComplete = () => {
            if (!stdoutDone || !stderrDone || !processExited) return;
            clearHandshakeTimer();
            closeIoPipes();

            if (!this._turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
                return;
            }

            if (requireBridgeHandshake && monitor.isHandshakePending) {
                monitor.markHandshakeTimedOut();
            }

            const outcome = evaluateSubprocessOutcome({
                exitCode,
                termSignal,
                sawDoneMarker: turn.sawDoneMarker,
                turnError: turn.error,
                fatalError: monitor.fatalError,
                aborted: turn.aborted,
                timedOut: turn.timedOut,
                stderrSummary: monitor.getStderrSummary(),
            });

            this._turns.finalizeTurn(turn, {
                status: outcome.status,
                aborted: outcome.aborted,
                timedOut: outcome.timedOut,
                interrupted: outcome.interrupted,
                errorText: outcome.errorMessage,
                onPersistAssistant: m => this._store?.appendMessage(m, this._backend, this._config),
                onTerminateProcess: p => this._terminateTurnProcess(turn, p),
                onCleanupTempFiles: files => files.forEach(removeFileQuietly),
            });
        };

        if (requireBridgeHandshake) {
            handshakeTimerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                DEFAULT_BRIDGE_HANDSHAKE_TIMEOUT_MS,
                () => {
                    handshakeTimerId = 0;
                    if (monitor.markHandshakeTimedOut()) {
                        abortTurnForFatalMonitorError();
                    }
                    return GLib.SOURCE_REMOVE;
                }
            );
        }

        // Wait for real OS exit status and delete sensitive 0600 temp files ONLY after process exit!
        proc.wait_async(null, (p, res) => {
            try {
                p.wait_finish(res);
                if (p.get_if_exited()) {
                    exitCode = p.get_exit_status();
                }
                if (p.get_if_signaled()) {
                    termSignal = p.get_term_sig();
                }
            } catch (_) {}

            for (const f of turnTempFiles) {
                removeFileQuietly(f);
            }
            turn.tempFiles = [];

            processExited = true;
            trySettleWhenComplete();
        });

        const readStderrLoop = () => {
            if (this._closed || turn.aborted || turn.timedOut) {
                stderrDone = true;
                trySettleWhenComplete();
                return;
            }
            stderr.read_line_async(GLib.PRIORITY_DEFAULT, turn.cancellable, (src, res) => {
                if (this._closed) {
                    stderrDone = true;
                    return;
                }
                try {
                    const [line] = src.read_line_finish_utf8(res);
                    if (line === null) {
                        stderrDone = true;
                        trySettleWhenComplete();
                        return;
                    }
                    if (this._turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
                        monitor.pushStderrLine(turn.id, line);
                    }
                    readStderrLoop();
                } catch (_) {
                    stderrDone = true;
                    trySettleWhenComplete();
                }
            });
        };

        this._turns.markStreaming(turn);
        this._attachTurnWatchdog(turn, 120, '响应超时（120s 无输出）');
        this._attachApprovalWatchdog(
            turn,
            Number(this._config?.approvalTimeoutSec) > 0
                ? Number(this._config.approvalTimeoutSec)
                : DEFAULT_APPROVAL_TIMEOUT_SEC
        );

        if (modeInfo.notice) {
            this._turns.emitForTurn(turn, {
                type: 'mode_notice',
                effectiveMode,
                message: modeInfo.notice,
            });
        }

        const seenPermissionIds = new Set();

        const readStdoutLoop = () => {
            if (!this._turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
                stdoutDone = true;
                trySettleWhenComplete();
                return;
            }
            stdout.read_line_async(GLib.PRIORITY_DEFAULT, turn.cancellable, (stream, res) => {
                if (!this._turns.matchesIdentity(turn, {turnId: turn.id, clientGeneration: turn.clientGeneration})) {
                    stdoutDone = true;
                    trySettleWhenComplete();
                    return;
                }
                try {
                    const [line] = stream.read_line_finish_utf8(res);
                    if (line === null) {
                        stdoutDone = true;
                        trySettleWhenComplete();
                        return;
                    }
                    if (turn.state !== 'awaiting_approval') {
                        turn.resetWatchdog?.();
                    }

                    const checked = monitor.processStdoutLine(turn.id, line);
                    if (checked.fatalError) {
                        abortTurnForFatalMonitorError();
                        return;
                    }
                    if (monitor.isHandshakeVerified) {
                        clearHandshakeTimer();
                    }

                    const norm = checked.normalized;
                    if (norm) {
                        if (norm.type === 'bridge_ready') {
                            this._turns.emitForTurn(turn, norm);
                        } else if (norm.type === 'permission_request') {
                            if (norm.requestId && !seenPermissionIds.has(norm.requestId)) {
                                seenPermissionIds.add(norm.requestId);
                                this._turns.enterApproval(turn, norm.requestId);
                                this._turns.emitForTurn(turn, norm);
                            }
                        } else if (norm.type === 'permission_resolved') {
                            if (norm.requestId) {
                                this._turns.leaveApproval(turn, norm.requestId);
                            }
                            this._turns.emitForTurn(turn, norm);
                        } else if (norm.type === 'session_bound' && norm.sessionId) {
                            this._store?.setRemoteSessionId(norm.sessionId, this._backend, this._config);
                        } else if (norm.type === 'turn_completed') {
                            turn.sawDoneMarker = true;
                        } else if (norm.type === 'turn_result') {
                            if (norm.sessionId) {
                                this._store?.setRemoteSessionId(norm.sessionId, this._backend, this._config);
                            }
                            if (norm.isError) {
                                turn.error = norm.errorMessage || 'ZCode 执行返回错误';
                            } else {
                                turn.sawDoneMarker = true;
                                if (norm.text && !turn.text) {
                                    this._turns.replaceText(turn, norm.text);
                                }
                            }
                        } else if (norm.type === 'text_snapshot') {
                            this._turns.replaceText(turn, norm.text);
                        } else if (norm.type === 'thinking_snapshot') {
                            this._turns.replaceThinking(turn, norm.text);
                        } else if (norm.type === 'message_update') {
                            if (norm.sessionId) {
                                this._store?.setRemoteSessionId(norm.sessionId, this._backend, this._config);
                            }
                            const ev = norm.assistantMessageEvent;
                            if (ev?.type === 'text_delta') {
                                this._turns.appendText(turn, ev.delta || '');
                            } else if (ev?.type === 'thinking_delta') {
                                this._turns.appendThinking(turn, ev.delta || '');
                            } else {
                                this._turns.emitForTurn(turn, norm);
                            }
                        } else if (norm.type === 'message_end' && norm.message) {
                            if (norm.sessionId) {
                                this._store?.setRemoteSessionId(norm.sessionId, this._backend, this._config);
                            }
                            if (typeof norm.message.content === 'string' && norm.message.content) {
                                this._turns.replaceText(turn, norm.message.content);
                            }
                            if (norm.message.errorMessage) {
                                turn.error = norm.message.errorMessage;
                            }
                            // Defer final `message_end` emission to `finalizeTurn` after exit status verification.
                        } else {
                            if (norm.sessionId) {
                                this._store?.setRemoteSessionId(norm.sessionId, this._backend, this._config);
                            }
                            this._turns.emitForTurn(turn, norm);
                        }
                    }
                    readStdoutLoop();
                } catch (err) {
                    stdoutDone = true;
                    if (!turn.aborted && !turn.timedOut && !turn.error) {
                        turn.error = err.message;
                    }
                    trySettleWhenComplete();
                }
            });
        };

        readStderrLoop();
        readStdoutLoop();
        return Promise.resolve({disposition: 'streaming', turnId: turn.id});
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        const active = this._turns.activeTurn;
        this._turns.dispose(
            proc => this._terminateTurnProcess(active, proc),
            files => files.forEach(removeFileQuietly)
        );
        try { this._httpSession?.abort(); } catch (_) {}
        this._httpSession = null;
    }
}
