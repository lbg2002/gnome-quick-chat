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
    preparePromptWithinBudget,
} from './protocol.js';
import {
    buildSearchPath,
    createGioCliEnv,
    detectBackendSelection,
    findExecutableInDirs,
    loadLocalBackendCatalogAsync,
    peekCachedBackendCatalog,
    probeCliCapabilities,
    readJsonFileAsync,
    readJsonFileSync,
} from './core/backendDetect.js';
import {UNCONFIGURED_BACKEND_MESSAGE} from './core/configMigration.js';
import {
    cleanupStaleRuntimeFiles,
    getPrivateRuntimeDir,
    getUserSpecialDirs,
    readFileBytesBoundedAsync,
    removeFileQuietly,
    writePrivateFileAsync,
    writePrivateFileSync,
} from './core/paths.js';
import {
    inspectEndpointSecurity,
    shouldStripAuthOnRedirect,
} from './core/secretPolicy.js';
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
    prepareZCodeConfigOverrideAsync,
    validateCliPromptLength,
    wrapArgvWithSetsid,
} from './runtime/cliProcessRunner.js';
import {
    DEFAULT_SSE_LIMITS,
    OpenAISseParser,
    formatSanitizedHttpError,
    parseModelsResponse,
    redactSensitiveText,
    resolveSplitTimeouts,
    supportsOpenAIReasoningEffort,
} from './runtime/sseParser.js';

export {buildSearchPath, findExecutableInDirs};

const Encoder = new TextEncoder();
const Decoder = new TextDecoder('utf-8');

/**
 * Strips the `Authorization` header automatically if an HTTP 30x redirect crosses origins
 * or downgrades `https://` -> `http://` (Stage C4).
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

function createDefaultZCodeConfigAsyncIo() {
    return {
        homeDir: GLib.get_home_dir(),
        fileExistsAsync: async p => {
            const info = await readFileBytesBoundedAsync(p, 16);
            return info.exists;
        },
        readJsonAsync: (p, opts = {}) => readJsonFileAsync(p, opts.maxBytes),
        getRuntimeDir: getPrivateRuntimeDir,
        makeUuid: () => GLib.uuid_string_random(),
        writePrivateFileAsync: (p, bytes) => writePrivateFileAsync(p, bytes),
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

export function createIsolatedZCodeConfigOverrideAsync(config, asyncIoEnv = null) {
    return prepareZCodeConfigOverrideAsync(config, asyncIoEnv || createDefaultZCodeConfigAsyncIo());
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

        // Stage D4: peek sanitized catalog cache first (zero synchronous provider_config.json I/O);
        // `get_state` asynchronously populates the default model label if cache is cold.
        const cachedCat = peekCachedBackendCatalog('zcode');
        const resolvedProvider = String(config.provider || cachedCat.defaultProviderId || '').trim();
        const effectiveModel = String(config.model || cachedCat.defaultModelId || '').trim();
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
        this._timeouts = resolveSplitTimeouts(config);
        cleanupStaleRuntimeFiles();
        this._runtime = resolveBackendRuntime(config);
        this._backend = this._runtime.backend;

        if (this._backend === 'openai') {
            // Keep default strict TLS verification enabled; socket idle bounded by streamIdleTimeoutSec
            this._httpSession = new Soup.Session({
                timeout: this._timeouts.streamIdleTimeoutSec,
            });
            this._runtime.modelMetadata = {};
        }
        this._store = new SessionStore(sessionId, {
            onSaveError: errInfo => {
                if (!this._closed) {
                    this._event({
                        type: 'session_save_error',
                        sessionId: errInfo.sessionId,
                        message: errInfo.message || '历史未保存',
                        clientGeneration: this._clientGeneration,
                    });
                }
            },
        });
    }

    _getSessionContextConfig() {
        return {
            ...(this._config || {}),
            resolvedProvider: this._runtime?.resolvedProvider || '',
            resolvedModel: this._runtime?.resolvedModel || '',
            resolvedWorkspace: this._workspace || '',
            effectiveMode: this._runtime?.effectiveModeInfo?.effectiveMode || (this._config?.mode || 'readonly'),
        };
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
            await this._store.load(this._backend, this._getSessionContextConfig());
        }

        if (type === 'get_state') {
            if (this._backend === 'zcode' && !this._runtime.resolvedModel && !this._config?.model) {
                try {
                    const cat = await loadLocalBackendCatalogAsync('zcode');
                    if (!this._closed && cat?.defaultModelId && !this._runtime.resolvedModel) {
                        this._runtime.resolvedProvider = this._runtime.resolvedProvider || cat.defaultProviderId || '';
                        this._runtime.resolvedModel = cat.defaultModelId;
                        this._runtime.label = cat.defaultModelId;
                    }
                } catch (_) {}
            }
            const endpointSec = this._backend === 'openai'
                ? inspectEndpointSecurity(this._runtime?.baseUrl || '')
                : null;
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
                endpointSecurity: endpointSec,
                sessionUnsavedWarning: this._store?.lastWriteError
                    ? `历史未保存：${this._store.lastWriteError.message}`
                    : '',
            };
        }
        if (type === 'get_models') {
            if (this._backend === 'openai') {
                return this._fetchOpenAIModelsListAsync(fields.cancellable || null);
            }
            const cat = await loadLocalBackendCatalogAsync(this._backend, {
                forceRefresh: Boolean(fields.forceRefresh),
            });
            return {
                backend: this._backend,
                catalog: cat,
                models: [],
            };
        }
        if (type === 'get_messages') {
            return {messages: this._store ? [...this._store.messages] : []};
        }
        if (type === 'flush_session') {
            await this._store?.flush();
            return {
                flushed: true,
                hasUnsavedChanges: Boolean(this._store?.hasUnsavedChanges),
            };
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
            const ctxCfg = this._getSessionContextConfig();
            this._turns.cancelActiveTurn({
                onPersistAssistant: m => this._store?.appendMessage(m, this._backend, ctxCfg),
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
                userMessageId: fields.userMessageId || `user_${GLib.uuid_string_random()}`,
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

    /**
     * Phase-aware watchdog supporting separated connect / first-byte / stream-idle / tool-execution
     * timeouts plus an independent total turn ceiling (Stage C3).
     */
    _attachTurnWatchdog(turn, initialTimeoutSec, initialMessage, totalTurnTimeoutSec = 0) {
        let phaseTimerId = 0;
        let totalTimerId = 0;
        let currentTimeoutSec = Math.max(5, Number(initialTimeoutSec) || 60);
        let currentMessage = String(initialMessage || '请求响应超时');

        const clearPhase = () => {
            if (phaseTimerId) {
                try { GLib.source_remove(phaseTimerId); } catch (_) {}
                phaseTimerId = 0;
            }
        };
        const clearAll = () => {
            clearPhase();
            if (totalTimerId) {
                try { GLib.source_remove(totalTimerId); } catch (_) {}
                totalTimerId = 0;
            }
        };

        const fireTimeout = msgText => {
            clearAll();
            if (this._turns.isCurrent(turn)) {
                turn.timedOut = true;
                try { turn.cancellable?.cancel?.(); } catch (_) {}
                const ctxCfg = this._getSessionContextConfig();
                this._turns.finalizeTurn(turn, {
                    status: 'timed_out',
                    timedOut: true,
                    aborted: false,
                    errorText: msgText,
                    onPersistAssistant: msg => this._store?.appendMessage(msg, this._backend, ctxCfg),
                    onTerminateProcess: proc => this._terminateTurnProcess(turn, proc),
                    onCleanupTempFiles: files => files.forEach(removeFileQuietly),
                });
            }
        };

        const reset = () => {
            clearPhase();
            if (!this._turns.isCurrent(turn)) return;
            phaseTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, currentTimeoutSec, () => {
                phaseTimerId = 0;
                fireTimeout(currentMessage);
                return GLib.SOURCE_REMOVE;
            });
        };

        const setWatchdogPhase = (nextTimeoutSec, nextMessage) => {
            currentTimeoutSec = Math.max(5, Number(nextTimeoutSec) || currentTimeoutSec);
            if (nextMessage) currentMessage = String(nextMessage);
            if (turn.state !== 'awaiting_approval') {
                reset();
            }
        };

        if (totalTurnTimeoutSec > 0) {
            totalTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, totalTurnTimeoutSec, () => {
                totalTimerId = 0;
                fireTimeout(`单轮任务总时长超出安全上限（${totalTurnTimeoutSec}s）`);
                return GLib.SOURCE_REMOVE;
            });
        }

        turn.pauseWatchdog = clearPhase;
        turn.resetWatchdog = reset;
        turn.setWatchdogPhase = setWatchdogPhase;
        turn.cleanupWatchdog = clearAll;
        reset();
    }

    _attachApprovalWatchdog(turn, timeoutSec = this._timeouts?.approvalTimeoutSec || 300) {
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
                    const ctxCfg = this._getSessionContextConfig();
                    this._turns.finalizeTurn(turn, {
                        status: 'timed_out',
                        timedOut: true,
                        aborted: false,
                        errorText: `等待工具审批超时（${timeoutSec}s），已安全拒绝并终止本轮任务`,
                        onPersistAssistant: msg => this._store?.appendMessage(msg, this._backend, ctxCfg),
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

    _fetchOpenAIModelsListAsync(cancellable = null) {
        const userPreferredModel = String(this._runtime.modelId || '').trim();
        const modelsUrl = this._runtime.modelsUrl;
        const apiKey = this._runtime.apiKey || '';
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
                    this._runtime.modelMetadata = {
                        ...(this._runtime.modelMetadata || {}),
                        ...(parsed.metadataById || {}),
                    };
                    if (!this._closed && Array.isArray(parsed.models) && parsed.models.length > 0) {
                        this._event({
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

    async _discoverOpenAIModelAsync(cancellable) {
        const userPreferredModel = String(this._runtime.modelId || '').trim();
        if (userPreferredModel) {
            return userPreferredModel;
        }
        try {
            const parsed = await this._fetchOpenAIModelsListAsync(cancellable);
            if (!parsed.selectedModel) {
                throw new Error('未指定模型 ID，且 /models 未返回可用模型；请在设置中填写模型 ID');
            }
            this._runtime.modelId = parsed.selectedModel;
            this._runtime.resolvedModel = parsed.selectedModel;
            this._runtime.label = parsed.selectedModel;
            return parsed.selectedModel;
        } catch (e) {
            const cleanMsg = redactSensitiveText(e?.message || String(e), {
                apiKey: this._runtime.apiKey || '',
                maxChars: 240,
            });
            throw new Error(`请在设置中填写模型 ID（${cleanMsg}）`);
        }
    }

    async _runOpenAITurn(promptText, turnMeta = {}) {
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
            sessionId: this._sessionId,
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
            this._backend,
            ctxCfg
        );

        const timeouts = this._timeouts || resolveSplitTimeouts();
        this._attachTurnWatchdog(
            turn,
            timeouts.connectTimeoutSec,
            `连接 OpenAI 接口超时（${timeouts.connectTimeoutSec}s）`,
            timeouts.totalTurnTimeoutSec
        );

        let modelId;
        try {
            modelId = await this._discoverOpenAIModelAsync(turn.cancellable);
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
            timeouts.connectTimeoutSec,
            `连接 OpenAI 接口超时（${timeouts.connectTimeoutSec}s）`
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
                    if (evt.model && !turn.modelId) {
                        turn.modelId = evt.model;
                    }
                    if (evt.thinkingDelta) {
                        this._turns.appendThinking(turn, evt.thinkingDelta);
                    }
                    if (evt.textDelta) {
                        this._turns.appendText(turn, evt.textDelta);
                    }
                }
            }
            return true;
        };

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
                onPersistAssistant: m => this._store?.appendMessage(m, this._backend, persistCfg),
            });
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
                        try {
                            gbytes = s.read_bytes_finish(r);
                        } catch (_) {}

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

            // Connected and HTTP 2xx headers received: switch to first-byte timeout until first chunk arrives
            let sawFirstPayloadChunk = false;
            turn.setWatchdogPhase?.(
                timeouts.firstByteTimeoutSec,
                `等待模型首字响应超时（${timeouts.firstByteTimeoutSec}s）`
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
                        // Socket EOF: flush UTF-8 decoder & validate clean SSE completion or non-SSE JSON fallback
                        const fin = sseParser.finish();
                        if (!applyParsedSseEvents(fin.events)) {
                            return;
                        }
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
                            timeouts.streamIdleTimeoutSec,
                            `流式响应空闲超时（${timeouts.streamIdleTimeoutSec}s）`
                        );
                    } else {
                        turn.resetWatchdog?.();
                    }

                    const parsedEvents = sseParser.pushBytes(rawChunk);
                    if (!applyParsedSseEvents(parsedEvents)) {
                        return;
                    }
                    readSseChunks();
                });
            };
            readSseChunks();
        });

        return {disposition: 'streaming', turnId: turn.id};
    }

    async _runSingleTurnSubprocess(promptText, turnMeta = {}) {
        const budgetCheck = preparePromptWithinBudget(promptText, {allowTruncate: false});
        if (!budgetCheck.ok) {
            throw new Error(budgetCheck.warning || '当前提问超出单次输入上限');
        }

        const cancellable = new Gio.Cancellable();
        const turn = this._turns.beginTurn({
            turnId: turnMeta.turnId,
            messageId: turnMeta.messageId,
            replyTo: turnMeta.userMessageId || '',
            modelId: this._runtime?.resolvedModel || '',
            sessionId: this._sessionId,
            clientGeneration: turnMeta.clientGeneration ?? this._clientGeneration,
            lifecycleGeneration: turnMeta.lifecycleGeneration ?? 0,
            backend: this._backend,
            promptText: budgetCheck.promptText,
            cancellable,
            deferTempCleanupUntilProcessExit: true,
        });

        const cliCaps = this._runtime?.cliCapabilities || null;
        const modeInfo = normalizeEffectiveAgentMode(this._backend, this._config?.mode || 'readonly', cliCaps);
        const effectiveMode = modeInfo.effectiveMode;

        const historyBeforePrompt = this._store ? [...this._store.messages] : [];
        const remoteId = this._store?.remoteSessionId || '';
        const promptWithDesktopEnv = augmentPromptWithDesktopContext(budgetCheck.promptText, this._specialDirs, {
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
            throw err;
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
                zcodeIsolated = await createIsolatedZCodeConfigOverrideAsync(this._config);
                if (zcodeIsolated.tempFilePath) {
                    turn.tempFiles.push(zcodeIsolated.tempFilePath);
                }
                if (zcodeIsolated.resolvedModel && !this._closed) {
                    this._runtime.resolvedProvider = zcodeIsolated.resolvedProvider || this._runtime.resolvedProvider;
                    this._runtime.resolvedModel = zcodeIsolated.resolvedModel;
                    this._runtime.label = zcodeIsolated.resolvedModel;
                    turn.modelId = zcodeIsolated.resolvedModel;
                }
                if (useZCodePromptFile) {
                    const runtimeDir = getPrivateRuntimeDir();
                    promptTempFilePath = GLib.build_filenamev([
                        runtimeDir,
                        `zcode-prompt-${GLib.uuid_string_random()}.txt`,
                    ]);
                    await writePrivateFileAsync(promptTempFilePath, Encoder.encode(effectiveCliPrompt), turn.cancellable);
                    turn.tempFiles.push(promptTempFilePath);
                }
            }

            if (!this._turns.isCurrent(turn)) {
                turn.tempFiles.splice(0).forEach(removeFileQuietly);
                return {disposition: 'cancelled', turnId: turn.id};
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
            turn.tempFiles.splice(0).forEach(removeFileQuietly);
            if (this._turns.isCurrent(turn)) {
                this._turns.finalizeTurn(turn, {
                    status: turn.aborted ? 'cancelled' : 'failed',
                    errorText: turn.aborted ? '' : prepErr.message,
                    onCleanupTempFiles: files => files.forEach(removeFileQuietly),
                });
            }
            if (turn.aborted) {
                return {disposition: 'cancelled', turnId: turn.id};
            }
            throw prepErr;
        }

        const ctxCfg = this._getSessionContextConfig();
        this._store?.appendMessage(
            {
                id: turnMeta.userMessageId,
                turnId: turn.id,
                role: 'user',
                content: budgetCheck.promptText,
            },
            this._backend,
            ctxCfg
        );

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
        let activeRunningTools = 0;

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
            const persistCfg = this._getSessionContextConfig();
            this._turns.finalizeTurn(turn, {
                status: 'failed',
                errorText: redactSensitiveText(monitor.fatalError || 'CLI 安全校验未通过'),
                onPersistAssistant: m => this._store?.appendMessage(m, this._backend, persistCfg),
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

            // Never auto-retry side-effecting Agent turns (Stage C3)!
            // If a remote session resume failed before producing output, invalidate the stale remoteSessionId
            // so the user's next turn cleanly rebuilds from budgeted local SessionStore history (Stage C2).
            let finalErrorMessage = redactSensitiveText(outcome.errorMessage || '', {maxChars: 280});
            if (remoteId && outcome.status !== 'completed' && !turn.aborted && !turn.timedOut && !turn.text) {
                this._store?.clearRemoteSessionId('remote_resume_failed');
                finalErrorMessage = finalErrorMessage
                    ? `远端会话恢复失败（已重置为本地上下文，请重试）：${finalErrorMessage}`
                    : '远端会话恢复失败，已自动切换为本地历史上下文，请重新发送当前问题';
            }

            const persistCfg = this._getSessionContextConfig();
            this._turns.finalizeTurn(turn, {
                status: outcome.status,
                aborted: outcome.aborted,
                timedOut: outcome.timedOut,
                interrupted: outcome.interrupted,
                errorText: finalErrorMessage,
                onPersistAssistant: m => this._store?.appendMessage(m, this._backend, persistCfg),
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

        const timeouts = this._timeouts || resolveSplitTimeouts();
        this._turns.markStreaming(turn);
        this._attachTurnWatchdog(
            turn,
            timeouts.streamIdleTimeoutSec,
            `CLI 响应空闲超时（${timeouts.streamIdleTimeoutSec}s 无输出）`,
            timeouts.totalTurnTimeoutSec
        );
        this._attachApprovalWatchdog(
            turn,
            Number(this._config?.approvalTimeoutSec) > 0
                ? Number(this._config.approvalTimeoutSec)
                : timeouts.approvalTimeoutSec
        );

        if (modeInfo.notice) {
            this._turns.emitForTurn(turn, {
                type: 'mode_notice',
                effectiveMode,
                message: modeInfo.notice,
            });
        }

        const seenPermissionIds = new Set();
        const syncCliToolTimeoutPhase = () => {
            if (activeRunningTools > 0) {
                turn.setWatchdogPhase?.(
                    timeouts.toolExecutionTimeoutSec,
                    `工具执行超时（${timeouts.toolExecutionTimeoutSec}s 无状态更新）`
                );
            } else {
                turn.setWatchdogPhase?.(
                    timeouts.streamIdleTimeoutSec,
                    `CLI 响应空闲超时（${timeouts.streamIdleTimeoutSec}s 无输出）`
                );
            }
        };

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
                        const segCfg = this._getSessionContextConfig();
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
                        } else if (norm.type === 'tool_execution_start') {
                            activeRunningTools++;
                            syncCliToolTimeoutPhase();
                            this._turns.emitForTurn(turn, norm);
                        } else if (norm.type === 'tool_execution_end') {
                            activeRunningTools = Math.max(0, activeRunningTools - 1);
                            syncCliToolTimeoutPhase();
                            this._turns.emitForTurn(turn, norm);
                        } else if (norm.type === 'tool_batch_end') {
                            activeRunningTools = 0;
                            syncCliToolTimeoutPhase();
                            this._turns.emitForTurn(turn, norm);
                        } else if (norm.type === 'session_bound' && norm.sessionId) {
                            this._store?.setRemoteSessionId(norm.sessionId, this._backend, segCfg);
                        } else if (norm.type === 'turn_completed') {
                            turn.sawDoneMarker = true;
                        } else if (norm.type === 'turn_result') {
                            if (norm.sessionId) {
                                this._store?.setRemoteSessionId(norm.sessionId, this._backend, segCfg);
                            }
                            if (norm.isError) {
                                turn.error = norm.errorMessage || 'ZCode 执行返回错误';
                            } else {
                                turn.sawDoneMarker = true;
                                if (norm.text && !turn.text) {
                                    this._turns.replaceText(turn, norm.text, norm.segmentId || '');
                                }
                            }
                        } else if (norm.type === 'text_snapshot') {
                            this._turns.replaceText(turn, norm.text, norm.segmentId || '');
                        } else if (norm.type === 'thinking_snapshot') {
                            this._turns.replaceThinking(turn, norm.text, norm.segmentId || '');
                        } else if (norm.type === 'message_update') {
                            if (norm.sessionId) {
                                this._store?.setRemoteSessionId(norm.sessionId, this._backend, segCfg);
                            }
                            const ev = norm.assistantMessageEvent;
                            if (ev?.type === 'text_delta') {
                                this._turns.appendText(turn, ev.delta || '', norm.segmentId || '');
                            } else if (ev?.type === 'thinking_delta') {
                                this._turns.appendThinking(turn, ev.delta || '', norm.segmentId || '');
                            } else {
                                this._turns.emitForTurn(turn, norm);
                            }
                        } else if (norm.type === 'message_end' && norm.message) {
                            if (norm.sessionId) {
                                this._store?.setRemoteSessionId(norm.sessionId, this._backend, segCfg);
                            }
                            if (typeof norm.message.content === 'string' && norm.message.content) {
                                this._turns.replaceText(turn, norm.message.content, norm.segmentId || norm.message.id || '');
                            }
                            if (norm.message.errorMessage) {
                                turn.error = norm.message.errorMessage;
                            }
                            // Defer final `message_end` emission to `finalizeTurn` after exit status verification.
                        } else {
                            if (norm.sessionId) {
                                this._store?.setRemoteSessionId(norm.sessionId, this._backend, segCfg);
                            }
                            if (norm.type === 'message_start' && norm.modelId) {
                                turn.modelId = norm.modelId;
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
