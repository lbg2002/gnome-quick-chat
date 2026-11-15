// Unified Backend Client Facade (Stage E).
// Resolves active backend runtime (`zcode` | `codex` | `openai` | `unconfigured`) and delegates
// execution to `ZCodeAdapter`, `CodexAdapter`, or `OpenAIAdapter` over shared `SessionStore` and `TurnController`.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
    getBackendCapabilities,
    mapReasoningEffort,
    normalizeEffectiveAgentMode,
    normalizeOpenAIEndpoint,
} from './protocol.js';
import {
    buildSearchPath,
    createGioCliEnv,
    detectBackendSelection,
    findExecutableInDirs,
    peekCachedBackendCatalog,
    probeCliCapabilities,
} from './core/backendDetect.js';
import {UNCONFIGURED_BACKEND_MESSAGE} from './core/configMigration.js';
import {
    cleanupStaleRuntimeFiles,
    getUserSpecialDirs,
    removeFileQuietly,
} from './core/paths.js';
import {inspectEndpointSecurity} from './core/secretPolicy.js';
import {SessionStore} from './core/sessionStore.js';
import {TurnController} from './core/turnController.js';
import {resolveSplitTimeouts} from './runtime/sseParser.js';
import {
    resolveSetsidExecutable,
    terminateTurnProcess,
} from './runtime/processManager.js';
import {BaseBackendAdapter} from './backends/baseAdapter.js';
import {
    ZCodeAdapter,
    createIsolatedZCodeConfigOverride,
    createIsolatedZCodeConfigOverrideAsync,
} from './backends/zcodeAdapter.js';
import {CodexAdapter} from './backends/codexAdapter.js';
import {
    OpenAIAdapter,
    attachCrossOriginRedirectGuard,
} from './backends/openaiAdapter.js';

export {
    attachCrossOriginRedirectGuard,
    buildSearchPath,
    createIsolatedZCodeConfigOverride,
    createIsolatedZCodeConfigOverrideAsync,
    findExecutableInDirs,
};

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
        this._approvedScopes = new Set();
        this._turns = new TurnController(evt => {
            if (!this._closed) this._event(evt);
        });
        this._store = null;
        this._adapter = null;
    }

    get adapter() {
        return this._adapter;
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

        const sharedDeps = {
            turns: this._turns,
            store: this._store,
            approvedScopes: this._approvedScopes,
            getSessionContextConfig: () => this._getSessionContextConfig(),
            emitEvent: evt => {
                if (!this._closed) this._event(evt);
            },
            clientGeneration: this._clientGeneration,
        };

        if (this._backend === 'zcode') {
            this._adapter = new ZCodeAdapter(sharedDeps).initialize(this._runtime, config);
        } else if (this._backend === 'codex') {
            this._adapter = new CodexAdapter(sharedDeps).initialize(this._runtime, config);
        } else if (this._backend === 'openai') {
            this._adapter = new OpenAIAdapter(sharedDeps).initialize(this._runtime, config, {
                timeouts: this._timeouts,
            });
        } else {
            this._adapter = new BaseBackendAdapter('unconfigured', sharedDeps).initialize(this._runtime, config);
        }
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

    updateApiKey(apiKey) {
        const clean = String(apiKey || '').trim();
        if (this._config) this._config.openaiApiKey = clean;
        if (this._adapter && typeof this._adapter.updateApiKey === 'function') {
            this._adapter.updateApiKey(clean);
        } else if (this._runtime && this._backend === 'openai') {
            this._runtime.apiKey = clean;
        }
    }

    async request(type, fields = {}) {
        if (this._closed) {
            throw new Error('服务已关闭');
        }
        if (this._store) {
            await this._adapter.restoreSession(this._store, this._getSessionContextConfig());
        }

        if (type === 'get_state') {
            if (typeof this._adapter?.refreshDefaultModelIfCold === 'function') {
                await this._adapter.refreshDefaultModelIfCold();
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
                capabilities: this._adapter?.getCapabilities() || this._runtime.capabilities || null,
                effectiveMode: this._runtime.effectiveModeInfo?.effectiveMode || (this._config?.mode || 'readonly'),
                modeNotice: this._runtime.effectiveModeInfo?.notice || '',
                cliVersion: this._runtime.cliCapabilities?.version || '',
                bridgeAvailable: Boolean(this._runtime?.bridgePath),
                endpointSecurity: endpointSec,
                sessionUnsavedWarning: this._store?.lastWriteError
                    ? `历史未保存：${this._store.lastWriteError.message}`
                    : '',
            };
        }
        if (type === 'get_models') {
            return this._adapter.getModels({
                forceRefresh: Boolean(fields.forceRefresh),
                cancellable: fields.cancellable || null,
            });
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
            return this._adapter.cancel(fields.turnId || '');
        }
        if (type === 'permission_response') {
            return this._adapter.respondPermission(fields);
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
            return this._adapter.sendMessage({
                promptText: fields.message || '',
                turnMeta,
                workspace: this._workspace,
                sessionId: this._sessionId,
                specialDirs: this._specialDirs,
                timeouts: this._timeouts,
            });
        }
        return {};
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        const active = this._turns.activeTurn;
        this._turns.dispose(
            proc => terminateTurnProcess(active, proc),
            files => files.forEach(removeFileQuietly)
        );
        try { this._adapter?.dispose(); } catch (_) {}
        this._adapter = null;
    }
}
