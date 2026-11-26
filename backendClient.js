// Unified Backend Client Facade (Stage E).
// Resolves active backend runtime (`zcode` | `codex` | `openai` | `unconfigured`) and delegates
// execution to `ZCodeAdapter`, `CodexAdapter`, or `OpenAIAdapter` over shared `SessionStore` and `TurnController`.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
    getToolBatchStatus,
    getBackendCapabilities,
    mapReasoningEffort,
    normalizeEffectiveAgentMode,
    normalizeOpenAIEndpoint,
} from './protocol.js';
import {
    buildSearchPath,
    buildSearchPathAsync,
    createGioCliEnv,
    detectBackendSelection,
    detectBackendSelectionAsync,
    findExecutableInDirs,
    peekCachedBackendCatalog,
    probeCliCapabilities,
    probeCliCapabilitiesAsync,
    runShortProbeCommandWithMetaAsync,
} from './core/backendDetect.js';
import {supportsDshSdk} from './runtime/dshSdk.js';
import {UNCONFIGURED_BACKEND_MESSAGE} from './core/configMigration.js';
import {
    cleanupStaleRuntimeFiles,
    getUserSpecialDirs,
    isDshWriteWorkspace,
    removeFileQuietly,
} from './core/paths.js';
import {inspectEndpointSecurity} from './core/secretPolicy.js';
import {excerptMemoryNote, MarkdownMemory, MemoryEditError} from './core/markdownMemory.js';
import {SessionStore} from './core/sessionStore.js';
import {TurnController} from './core/turnController.js';
import {redactSensitiveText, resolveSplitTimeouts} from './runtime/sseParser.js';
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
import {DshAdapter} from './backends/dshAdapter.js';
import {
    OpenAIAdapter,
    attachCrossOriginRedirectGuard,
    readSoupResponseBytesBoundedAsync,
} from './backends/openaiAdapter.js';

export {
    attachCrossOriginRedirectGuard,
    buildSearchPath,
    buildSearchPathAsync,
    createIsolatedZCodeConfigOverride,
    createIsolatedZCodeConfigOverrideAsync,
    findExecutableInDirs,
    readSoupResponseBytesBoundedAsync,
};

const TASK_GUIDANCE = '当前任务若承接上次的工作，从会话和可用记忆定位目标、已验证的进展和卡点。使用前核实可能变化的线索，保留已完成部分；有两个以上合理候选且无法消歧时，先让用户选择，选择之前不要执行。部分失败时说明已观察到的完成项和卡点，未知结果保持未知。';
const MEMORY_INSTRUCTIONS = '行动前先查相关记忆。随问会用类似 grep 的关键词匹配检索本地 Markdown 正文。优先读命中片段，需要完整上下文时再读取指定笔记全文。记忆仅供参考，操作以当前请求和授权为准。';

const MAX_MEMORY_TOOL_CALLS = 8;
const MAX_MEMORY_TOOL_EVIDENCE_BYTES = 1024;
const memoryEvidenceEncoder = new TextEncoder();

function observeMemoryTool(job, event, apiKey) {
    const calls = job.toolCalls;
    if (!calls) return;
    if (event.type === 'tool_batch_end') {
        const ids = new Set(Array.isArray(event.toolCallIds) ? event.toolCallIds : []);
        for (const [id, observation] of calls) {
            if (observation.endObserved || !ids.has(id)) continue;
            const status = getToolBatchStatus(event, id, {individualOnly: true});
            if (!status) continue;
            observation.endObserved = true;
            observation.outcome = status === 'done' ? 'succeeded' : status === 'error' ? 'failed' : status;
        }
        return;
    }
    if (!['tool_execution_start', 'tool_execution_end'].includes(event.type)) return;
    const id = typeof event.toolCallId === 'string' ? event.toolCallId.trim() : '';
    if (!id || id.length > 256) return;
    let observation = calls.get(id);
    if (!observation) {
        if (calls.size >= MAX_MEMORY_TOOL_CALLS) {
            job.toolEvidenceIncomplete = true;
            return;
        }
        observation = {outcome: 'unknown', endObserved: false};
        calls.set(id, observation);
    }
    if (observation.endObserved) return;
    const rawName = typeof event.toolName === 'string' ? event.toolName : '';
    if (!observation.tool && rawName.length <= 80) {
        const name = redactSensitiveText(rawName, {apiKey, maxChars: 40});
        if (/^[\p{L}][\p{L}\p{N}_.:-]{0,23}$/u.test(name)) observation.tool = name;
    }
    if (event.type !== 'tool_execution_end') return;
    observation.endObserved = true;
    if (['succeeded', 'failed', 'interrupted'].includes(event.executionOutcome)) observation.outcome = event.executionOutcome;
    if (Number.isSafeInteger(event.exitCode)) observation.exitCode = event.exitCode;
}

function finishMemoryToolEvidence(job) {
    const calls = job.toolCalls;
    const evidence = [];
    if (!calls) return evidence;
    for (const observation of calls.values()) {
        if (memoryEvidenceEncoder.encode(JSON.stringify([...evidence, observation])).length >
            MAX_MEMORY_TOOL_EVIDENCE_BYTES) {
            job.toolEvidenceIncomplete = true;
            break;
        }
        evidence.push(observation);
    }
    calls.clear();
    return evidence;
}

const memoryUpdateQueues = new Map();

function enqueueMemoryUpdate(root, run) {
    const tail = (memoryUpdateQueues.get(root) || Promise.resolve()).catch(() => {}).then(run);
    memoryUpdateQueues.set(root, tail);
    const clear = () => {
        if (memoryUpdateQueues.get(root) === tail) memoryUpdateQueues.delete(root);
    };
    tail.then(clear, clear);
    return tail;
}

export function resolveBackendRuntime(config = {}) {
    const rawZCodePath = String(config.zcodePath || '').trim();
    const rawCodexPath = String(config.codexPath || '').trim();
    const rawDshPath = String(config.dshPath || '').trim();
    const rawBaseUrl = String(config.openaiBaseUrl || '').trim();
    const requestedMode = String(config.mode || 'readonly').trim();

    const selection = detectBackendSelection({
        configuredBackend: config.backend || 'auto',
        zcodePath: rawZCodePath,
        codexPath: rawCodexPath,
        dshPath: rawDshPath,
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
                extraEnv.QUICK_CHAT_FORCE_BRIDGE = '1';
            }
        }
        if (bridgePath) {
            extraEnv.QUICK_CHAT_FORCE_BRIDGE = '1';
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
            capabilities: getBackendCapabilities('zcode', cliCapabilities),
        };
    }

    if (effective === 'dsh') {
        const pathDirs = buildSearchPath(rawDshPath);
        const env = createGioCliEnv(rawDshPath, pathDirs);
        const executable = (rawDshPath ? env.resolveCandidate(rawDshPath) : '')
            || findExecutableInDirs('dsh', pathDirs);
        if (!executable || !env.isExecutable(executable)) {
            throw new Error('未检测到 DeepSeek Harness CLI（dsh）');
        }
        const effectiveModeInfo = normalizeEffectiveAgentMode('dsh', requestedMode);
        return {
            backend: 'dsh', available: true, executable,
            setsidPath: resolveSetsidExecutable(pathDirs),
            pathEnv: pathDirs.join(':'),
            resolvedProvider: String(config.provider || '').trim() || 'deepseek-official',
            resolvedModel: String(config.model || '').trim(),
            label: String(config.model || '').trim() || 'DeepSeek Harness（使用 DSH profile 默认模型）',
            cliCapabilities: null, effectiveModeInfo,
            capabilities: getBackendCapabilities('dsh'),
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
            capabilities: getBackendCapabilities('codex', cliCapabilities),
        };
    }

    throw new Error(UNCONFIGURED_BACKEND_MESSAGE);
}

export async function resolveBackendRuntimeAsync(config = {}, {
    cancellable = null,
    forceRefresh = false,
    timeoutMs = 1400,
} = {}) {
    if (cancellable?.is_cancelled?.()) {
        throw new Error('连接已取消');
    }
    const rawZCodePath = String(config.zcodePath || '').trim();
    const rawCodexPath = String(config.codexPath || '').trim();
    const rawDshPath = String(config.dshPath || '').trim();
    const rawBaseUrl = String(config.openaiBaseUrl || '').trim();
    const requestedMode = String(config.mode || 'readonly').trim();

    const selection = await detectBackendSelectionAsync({
        configuredBackend: config.backend || 'auto',
        zcodePath: rawZCodePath,
        codexPath: rawCodexPath,
        dshPath: rawDshPath,
        openaiBaseUrl: rawBaseUrl,
    }, {
        forceRefresh,
        cancellable,
        timeoutMs,
    });
    if (cancellable?.is_cancelled?.()) {
        throw new Error('连接已取消');
    }

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
        const pathDirs = await buildSearchPathAsync(rawZCodePath);
        if (cancellable?.is_cancelled?.()) {
            throw new Error('连接已取消');
        }
        const cliEnv = createGioCliEnv(rawZCodePath, pathDirs);
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
                pathEnv = (await buildSearchPathAsync(nodeExe)).join(':');
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
            pathEnv = (await buildSearchPathAsync(zcodeExe)).join(':');
            if (bridgePath && !bridgePath.includes('"')) {
                const existingNodeOpts = GLib.getenv('NODE_OPTIONS') || '';
                extraEnv.NODE_OPTIONS = `${existingNodeOpts} --require "${bridgePath}"`.trim();
                extraEnv.QUICK_CHAT_FORCE_BRIDGE = '1';
            }
        }
        if (bridgePath) {
            extraEnv.QUICK_CHAT_FORCE_BRIDGE = '1';
        }

        const cliCapabilities = await probeCliCapabilitiesAsync('zcode', probePrefix, probeEnv, {
            cancellable,
            timeoutMs,
            forceRefresh,
        });
        if (cancellable?.is_cancelled?.()) {
            throw new Error('连接已取消');
        }
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
            capabilities: getBackendCapabilities('zcode', cliCapabilities),
        };
    }

    if (effective === 'dsh') {
        const pathDirs = await buildSearchPathAsync(rawDshPath);
        if (cancellable?.is_cancelled?.()) throw new Error('连接已取消');
        const env = createGioCliEnv(rawDshPath, pathDirs);
        // Pin the executable whose real headless --help contract was probed.
        // Avoid switching to another PATH candidate between detection and spawn.
        const executable = String(selection.executable || '');
        if (!executable || !env.isExecutable(executable)) {
            throw new Error('DSH 检测结果已失效：已验证的 dsh 可执行文件不存在或不可执行，请重新连接');
        }
        const probe = await runShortProbeCommandWithMetaAsync([executable, '--version'],
            {PATH: pathDirs.join(':')}, 512, {timeoutMs: 2500, cancellable});
        const cliCapabilities = {
            version: probe.ok ? probe.output.trim() : '',
            dshSdk: probe.ok && supportsDshSdk(probe.output),
        };
        const effectiveModeInfo = normalizeEffectiveAgentMode('dsh', requestedMode, cliCapabilities);
        return {
            backend: 'dsh', available: true,
            executable,
            setsidPath: resolveSetsidExecutable(pathDirs),
            pathEnv: pathDirs.join(':'),
            resolvedProvider: String(config.provider || '').trim() || 'deepseek-official',
            resolvedModel: String(config.model || '').trim(),
            label: String(config.model || '').trim() || 'DeepSeek Harness（使用 DSH profile 默认模型）',
            cliCapabilities,
            effectiveModeInfo,
            capabilities: getBackendCapabilities('dsh', cliCapabilities),
        };
    }

    if (effective === 'codex') {
        const pathDirs = await buildSearchPathAsync(rawCodexPath);
        if (cancellable?.is_cancelled?.()) {
            throw new Error('连接已取消');
        }
        const cliEnv = createGioCliEnv(rawCodexPath, pathDirs);
        const codexExe = (rawCodexPath ? cliEnv.resolveCandidate(rawCodexPath) : '')
            || findExecutableInDirs('codex', cliEnv.pathDirs);
        if (!codexExe) {
            throw new Error('未检测到本机 Codex CLI 可执行文件');
        }
        const setsidPath = resolveSetsidExecutable(cliEnv.pathDirs);
        const cliCapabilities = await probeCliCapabilitiesAsync('codex', [codexExe], {}, {
            cancellable,
            timeoutMs,
            forceRefresh,
        });
        if (cancellable?.is_cancelled?.()) {
            throw new Error('连接已取消');
        }
        const effectiveModeInfo = normalizeEffectiveAgentMode('codex', requestedMode, cliCapabilities);
        const resolvedModel = String(config.model || '').trim();
        return {
            backend: 'codex',
            available: true,
            executable: codexExe,
            setsidPath,
            pathEnv: (await buildSearchPathAsync(codexExe)).join(':'),
            resolvedProvider: String(config.provider || 'openai').trim(),
            resolvedModel,
            label: resolvedModel || 'Codex',
            cliCapabilities,
            effectiveModeInfo,
            capabilities: getBackendCapabilities('codex', cliCapabilities),
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
            if (!this._closed) {
                this._handleMemoryEvent(evt);
                this._event(evt);
            }
        });
        this._store = null;
        this._adapter = null;
        this._memoryUpdates = new Set();
        this._startupCancellable = null;
    }

    get adapter() {
        return this._adapter;
    }

    _initWithRuntime(runtime, config, workspace, sessionDir, sessionId, options = {}) {
        this._config = config;
        this._workspace = workspace;
        this._sessionId = sessionId;
        this._clientGeneration = Number(options.clientGeneration || 0);
        this._specialDirs = getUserSpecialDirs();
        this._timeouts = resolveSplitTimeouts(config);
        this._runtime = runtime;
        if (runtime.backend === 'dsh') {
            runtime.effectiveModeInfo = normalizeEffectiveAgentMode('dsh', config.mode, runtime.cliCapabilities,
                {workspaceWrite: isDshWriteWorkspace(config.workspace, workspace)});
        }
        this._backend = this._runtime.backend;

        this._store = this._createSessionStore(sessionId, sessionDir);

        this._memory = config.autoMemory ? new MarkdownMemory(workspace) : null;
        this._adapter = this._makeAdapter(config, this._turns, this._store);
    }

    _createSessionStore(sessionId, sessionDir) {
        return new SessionStore(sessionId, {
            sessionsRootDir: sessionDir,
            onSaveError: errInfo => {
                if (!this._closed && this._sessionId === sessionId) {
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

    startNewSession(sessionId, commitSelection) {
        if (this._closed || !this._store || !this._adapter || this._turns.activeTurn ||
            this._memoryTurn || this._store.hasUnsavedChanges || sessionId === this._sessionId) return false;
        const store = this._createSessionStore(sessionId, this._store.rootDir);
        commitSelection();
        this._sessionId = store.sessionId;
        this._store = store;
        this._adapter.setSessionStore(store);
        this.revokeApprovedScopes();
        return true;
    }

    _makeAdapter(config, turns, store, auxiliary = false) {
        const sharedDeps = {
            turns,
            store,
            approvedScopes: auxiliary ? new Set() : this._approvedScopes,
            getSessionContextConfig: () => this._getSessionContextConfig(),
            emitEvent: evt => {
                if (!auxiliary && !this._closed) this._event(evt);
            },
            clientGeneration: this._clientGeneration,
        };

        const runtime = auxiliary ? {...this._runtime} : this._runtime;
        switch (this._backend) {
            case 'zcode': return new ZCodeAdapter(sharedDeps).initialize(runtime, config);
            case 'codex': return new CodexAdapter(sharedDeps).initialize(runtime, config);
            case 'dsh': return new DshAdapter(sharedDeps).initialize(runtime, config);
            case 'openai': return new OpenAIAdapter(sharedDeps).initialize(runtime, config, {
                timeouts: this._timeouts,
            });
            default: return new BaseBackendAdapter('unconfigured', sharedDeps).initialize(runtime, config);
        }
    }

    async _askMemoryModel(prompt, job) {
        if (job.cancelled || this._closed) throw new Error('记忆请求已取消');
        let answer = '';
        let settle;
        const outcome = new Promise(resolve => { settle = resolve; });
        const turns = new TurnController(event => {
            if (event.type === 'message_end' && !event.partial) {
                const content = event.message?.content;
                answer = Array.isArray(content)
                    ? content.filter(part => part.type === 'text').map(part => part.text).join('')
                    : String(content || '');
            }
            if (event.type === 'agent_settled') settle(event.status === 'completed' && !event.partial);
        });
        const overrides = {mode: 'readonly', dshAutoReview: false, assistantInstructions: '你负责整理随问的 Markdown 记忆。'};
        const adapter = this._makeAdapter({...this._config, ...overrides}, turns, null, true);
        job.stop = () => {
            const active = turns.activeTurn;
            turns.dispose(proc => terminateTurnProcess(active, proc), files => files.forEach(removeFileQuietly));
            adapter.dispose();
            settle(false);
        };
        const deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25_000, () => {
            job.stop?.();
            return GLib.SOURCE_REMOVE;
        });
        try {
            const sessionId = GLib.uuid_string_random();
            const result = await adapter.sendMessage({
                promptText: prompt,
                workspace: GLib.get_tmp_dir(),
                sessionId,
                specialDirs: {},
                timeouts: this._timeouts,
            });
            if (result?.disposition === 'rejected_budget' || result?.disposition === 'cancelled') settle(false);
            if (!await outcome || !answer || job.cancelled) throw new Error('记忆模型未完成响应');
            return answer;
        } finally {
            if (GLib.MainContext.default().find_source_by_id(deadline)) GLib.source_remove(deadline);
            job.stop();
            job.stop = null;
        }
    }

    _memoryNotice(message, job = null, status = '') {
        if (!this._closed && (!job?.sessionId || job.sessionId === this._sessionId)) this._event({
            type: 'memory_notice', message, status, memoryTurnId: job?.turnId || '',
            memoryPrompt: job?.userText || '',
        });
    }

    _handleMemoryEvent(event) {
        const job = this._memoryTurn;
        if (!job || job.turnId !== event.turnId) return;
        if (job.learn && !job.cancelled) observeMemoryTool(job, event, this._runtime.apiKey);
        if (job.learn && !job.cancelled && event.type === 'message_end') {
            const content = event.message?.content || [];
            if (Array.isArray(content)) {
                job.answer = redactSensitiveText(content.filter(part => part.type === 'text').map(part => part.text).join(''),
                    {apiKey: this._runtime.apiKey, maxChars: 5000});
            }
        }
        if (event.type !== 'agent_settled') return;
        this._memoryTurn = null;
        this._store?.clearRemoteSessionId('shared_memory_context');
        if (job.cancelled || event.status !== 'completed' || event.partial || event.modelMismatch ||
            !job.learn || !job.snapshot || !job.answer) {
            job.toolCalls?.clear();
            return;
        }
        job.toolEvidence = finishMemoryToolEvidence(job);
        this._memoryUpdates.add(job);
        enqueueMemoryUpdate(this._memory.root, () => this._updateMemory(job)).catch(error => {
            if (job.cancelled) return;
            const hint = error instanceof MemoryEditError ? error.message : '可重新提出修改要求';
            this._memoryNotice('记忆更新未提交 · ' + hint, job, 'failed');
        }).finally(() => {
            job.toolEvidence = null;
            this._memoryUpdates.delete(job);
        });
    }

    async _updateMemory(job) {
        if (job.cancelled || this._closed) return;
        const snapshot = await this._memory.snapshot();
        if (job.cancelled || this._closed) return;
        const sameIndex = Object.keys(snapshot.indexes)
            .every(scope => snapshot.indexes[scope] === job.snapshot.indexes[scope]);
        const notes = sameIndex
            ? await this._memory.recall(snapshot, JSON.stringify([...job.notes.keys()]))
            : await this._searchMemoryNotes(job, snapshot);
        const edits = await this._askMemoryModel([
            '总结可跨会话复用的经验。记下值得保留的操作、指令、适用条件和已经确认的结论，方便下次直接查找。记录用户明确说过的长期偏好，以及可以续接的任务进展。附带资料只供参考。',
            '有纠正就更新原笔记。临时例外、猜测、重复内容、附件正文、凭据和私密信息不要写入。区分助手陈述和工具证据，未确认的结果保持未知。没有新内容返回 []。',
            '仅返回 JSON 数组，每项含 scope（computer 或 project）、name（Markdown 文件名）、markdown（完整 Markdown 文本，删除用 null）。按用户要求遗忘，新增或删除主题时同步更新相对索引链接。只改已提供的文件或新文件，最多六个文件。',
            JSON.stringify({indexes: snapshot.indexes, notes: Object.fromEntries(notes),
                user: job.userText, assistantReport: job.answer, toolEvidence: job.toolEvidence,
                toolEvidenceIncomplete: Boolean(job.toolEvidenceIncomplete),
                previousReferences: job.previousReferences.filter(address => snapshot.notes.has(address))}),
        ].join('\n'), job);
        const saved = await this._memory.edit(snapshot, notes, edits, () => !job.cancelled && !this._closed);
        if (saved.length) {
            const messages = [];
            const names = kind => saved.filter(change => change.kind === kind)
                .map(({address}) => {
                    const [, scope, name] = /^memory:\/\/(computer|project)\/(.+)$/.exec(address);
                    return (scope === 'project' ? '项目 / ' : '电脑 / ') + name;
                }).join('、');
            const unindexed = names('unindexed');
            const deleted = names('deleted');
            if (unindexed) messages.push('已移出索引，文件仍保留：' + unindexed);
            if (deleted) messages.push('已删除：' + deleted);
            const updated = names('updated');
            if (updated) messages.push('已更新：' + updated);
            this._memoryNotice(messages.join(' · '), job, 'committed');
        } else if (!job.cancelled && /^(?:请[，, ]*)?(?:记住|忘记|忘掉|纠正记忆|remember\b|forget\b)/i.test(job.userText)) {
            this._memoryNotice('本轮未修改记忆', job, 'unchanged');
        }
    }

    _searchMemoryNotes(job, snapshot) {
        return this._memory.search(snapshot, job.userText, {
            previousReferences: job.previousReferences,
            isCurrent: () => !job.cancelled && !this._closed,
        });
    }

    async _prepareMemory(job) {
        job.snapshot = await this._memory.snapshot();
        job.notes = await this._searchMemoryNotes(job, job.snapshot);
        if (!job.notes.size) return '';
        const fullNote = /整篇|全文|完整|\b(?:full|entire)\b/i.test(job.userText) &&
            /笔记|记忆|\.md\b|\b(?:note|memory)\b/i.test(job.userText);
        if (fullNote) job.notes = new Map([...job.notes].slice(0, 1));
        const notes = Object.fromEntries([...job.notes].map(([address, markdown]) =>
            [address, fullNote ? markdown : excerptMemoryNote(markdown, job.userText)]));
        return '本地 Markdown 检索结果（参考资料）\n' + JSON.stringify(notes);
    }

    start(config, workspace, sessionDir, sessionId, options = {}) {
        cleanupStaleRuntimeFiles();
        const runtime = resolveBackendRuntime(config);
        this._initWithRuntime(runtime, config, workspace, sessionDir, sessionId, options);
    }

    async startAsync(config, workspace, sessionDir, sessionId, options = {}) {
        if (this._closed) {
            throw new Error('服务已关闭');
        }
        try { this._startupCancellable?.cancel?.(); } catch (_) {}
        const startupCancellable = options.cancellable || new Gio.Cancellable();
        this._startupCancellable = startupCancellable;
        cleanupStaleRuntimeFiles();
        try {
            const runtime = await resolveBackendRuntimeAsync(config, {
                cancellable: startupCancellable,
                forceRefresh: Boolean(options.forceRefresh),
                timeoutMs: Number(options.probeTimeoutMs || 1400),
            });
            if (this._closed || startupCancellable?.is_cancelled?.()) {
                throw new Error('连接已取消');
            }
            this._initWithRuntime(runtime, config, workspace, sessionDir, sessionId, options);
        } finally {
            if (this._startupCancellable === startupCancellable) {
                this._startupCancellable = null;
            }
        }
    }

    _getSessionContextConfig() {
        return {
            ...(this._config || {}),
            resolvedProvider: this._runtime?.resolvedProvider || '',
            resolvedModel: this._runtime?.resolvedModel || '',
            resolvedWorkspace: this._workspace || '',
            dshSdk: this._runtime?.cliCapabilities?.dshSdk === true,
            dshSandbox: this._backend === 'dsh' ? this._runtime?.effectiveModeInfo?.native?.sandbox : '',
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
        const store = this._store;
        if (store && this._adapter) {
            await this._adapter.restoreSession(store, this._getSessionContextConfig());
            if (store !== this._store) throw new Error('会话已切换，请重新操作');
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
                modeBadge: this._runtime.effectiveModeInfo?.badge || '',
                cliVersion: this._runtime.cliCapabilities?.version || '',
                bridgeAvailable: Boolean(this._runtime?.bridgePath),
                endpointSecurity: endpointSec,
                sessionUnsavedWarning: this._store?.lastWriteError
                    ? `历史未保存：${this._store.lastWriteError.message}`
                    : '',
                hasUnsavedChanges: Boolean(this._store?.hasUnsavedChanges),
                committedRevision: this._store?.revision || 0,
                durableRevision: this._store?.durableRevision || 0,
                failedRevisions: this._store?.failedRevisions || [],
                archivedMessageCount: this._store?.archivedMessageCount || 0,
                totalLogicalMessageCount: this._store?.totalLogicalMessageCount || (this._store?.messages?.length || 0),
                canUndoLastRewind: Boolean(this._store?.canUndoLastRewind),
            };
        }
        if (type === 'get_models') {
            return this._adapter.getModels({
                forceRefresh: Boolean(fields.forceRefresh),
                cancellable: fields.cancellable || null,
            });
        }
        if (type === 'get_messages') {
            if (!this._store) {
                return {messages: [], archivedCount: 0, totalLogicalMessageCount: 0};
            }
            if (fields.includeArchived) {
                const full = await this._store.loadFullLogicalHistory({
                    includeRewound: Boolean(fields.includeRewound),
                });
                return {
                    messages: full.messages,
                    archivedCount: full.archivedCount,
                    totalLogicalMessageCount: full.messages.length,
                };
            }
            return {
                messages: [...this._store.messages],
                archivedCount: this._store.archivedMessageCount || 0,
                totalLogicalMessageCount: this._store.totalLogicalMessageCount || this._store.messages.length,
            };
        }
        if (type === 'get_archive_page') {
            if (!this._store) {
                return {
                    messages: [],
                    hasMoreOlder: false,
                    remainingOlderCount: 0,
                    nextBeforeArchiveOffset: 0,
                    nextBeforeRevision: 0,
                    totalArchivedCount: 0,
                };
            }
            return this._store.loadArchivedHistoryPage({
                beforeRevision: Number(fields.beforeRevision || 0),
                beforeMessageId: String(fields.beforeMessageId || ''),
                beforeArchiveOffset: Number.isInteger(fields.beforeArchiveOffset) ? fields.beforeArchiveOffset : null,
                limit: Number(fields.limit || 30),
                includeRewound: Boolean(fields.includeRewound),
            });
        }
        if (type === 'flush_session') {
            if (!this._store) {
                return {
                    ok: true,
                    flushed: true,
                    durableRevision: 0,
                    committedRevision: 0,
                    failedRevisions: [],
                    hasUnsavedChanges: false,
                    error: '',
                };
            }
            return this._store.flush();
        }
        if (type === 'retry_save_session') {
            if (!this._store) {
                return {ok: false, error: '当前会话尚未初始化', hasUnsavedChanges: false};
            }
            const res = await this._store.retryFailedWrites();
            return {
                ok: Boolean(res?.ok),
                durableRevision: this._store.durableRevision,
                committedRevision: this._store.revision,
                failedRevisions: this._store.failedRevisions,
                hasUnsavedChanges: Boolean(this._store.hasUnsavedChanges),
                error: res?.error?.message || (this._store.lastWriteError?.message || ''),
            };
        }
        if (type === 'rewind_from_user_turn') {
            if (!this._store) {
                return {ok: false, error: '当前会话尚未初始化'};
            }
            if (fields.sessionId && String(fields.sessionId) !== String(this._sessionId)) {
                return {
                    ok: false,
                    error: '当前会话已切换，已取消历史回退',
                    targetUserMessage: null,
                    removedCount: 0,
                    remoteSessionReset: false,
                };
            }
            const rewound = this._store.rewindFromUserMessage(fields.userMessageId || '');
            if (!rewound.ok) {
                return {
                    ok: false,
                    error: rewound.error || '',
                    targetUserMessage: null,
                    removedCount: 0,
                    remoteSessionReset: false,
                };
            }
            const writeRes = await rewound.writePromise;
            if (!writeRes || !writeRes.ok) {
                const errMsg = writeRes?.error?.message || String(writeRes?.error || '历史回退写入磁盘失败');
                return {
                    ok: false,
                    error: errMsg,
                    rolledBack: Boolean(writeRes?.rolledBack),
                    targetUserMessage: null,
                    removedCount: 0,
                    remoteSessionReset: false,
                };
            }
            // Rewinding conversation history revokes session-scoped approvals for safety
            this.revokeApprovedScopes();
            return {
                ok: true,
                error: '',
                targetUserMessage: rewound.targetUserMessage,
                removedCount: rewound.removedMessages?.length || 0,
                retainedCount: rewound.retainedCount,
                remoteSessionReset: Boolean(rewound.remoteSessionReset),
                canUndo: Boolean(rewound.canUndo),
                committedRevision: this._store.revision,
                durableRevision: this._store.durableRevision,
            };
        }
        if (type === 'undo_last_rewind') {
            if (!this._store) {
                return {ok: false, error: '当前会话尚未初始化'};
            }
            const undone = this._store.undoLastRewind();
            if (!undone.ok) {
                return {ok: false, error: undone.error || '暂无可撤销的历史回退记录'};
            }
            const writeRes = await undone.writePromise;
            if (!writeRes || !writeRes.ok) {
                return {
                    ok: false,
                    error: writeRes?.error?.message || '撤销回退写入磁盘失败',
                };
            }
            this.revokeApprovedScopes();
            return {
                ok: true,
                restoredCount: undone.restoredCount || 0,
                messages: undone.messages || [...this._store.messages],
                archivedCount: this._store.archivedMessageCount || 0,
                committedRevision: this._store.revision,
                durableRevision: this._store.durableRevision,
            };
        }
        if (type === 'export_session') {
            const {exportSessionToPrivateFileAsync} = await import('./core/sessionStore.js');
            const includeRewound = Boolean(fields.includeRewound);
            const fullHistory = this._store
                ? await this._store.loadFullLogicalHistory({includeRewound})
                : {messages: [], archivedCount: 0, rewoundMessages: []};
            return exportSessionToPrivateFileAsync(
                fullHistory.messages,
                this._store?.meta || {},
                {
                    sessionId: this._sessionId,
                    format: fields.format === 'json' ? 'json' : 'markdown',
                    includeRewound,
                    rewoundMessages: fullHistory.rewoundMessages,
                    archivedCount: fullHistory.archivedCount,
                }
            );
        }
        if (type === 'revoke_scopes') {
            this.revokeApprovedScopes();
            return {revoked: true};
        }
        if (type === 'abort') {
            const job = this._memoryTurn;
            if (job && (!fields.turnId || fields.turnId === job.turnId)) {
                job.cancelled = true;
                job.stop?.();
                job.toolCalls?.clear();
            }
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
                ...(fields.displayUserText ? {displayUserText: String(fields.displayUserText)} : {}),
                ...(fields.userCreatedAt ? {userCreatedAt: String(fields.userCreatedAt)} : {}),
                ...(fields.userTs ? {userTs: Number(fields.userTs)} : {}),
                clientGeneration: fields.clientGeneration ?? this._clientGeneration,
                lifecycleGeneration: fields.lifecycleGeneration ?? 0,
            };
            const previousAssistant = this._store?.messages?.findLast(message =>
                message.role === 'assistant' && Boolean(message.content?.length));
            const replyMarker = '[随问回执 ' + GLib.uuid_string_random() + ']';
            turnMeta.replyMarker = replyMarker;
            let memoryContext = '';
            const userText = String(fields.displayUserText || fields.message || '');
            if (this._memory) {
                turnMeta.memoryInstructions = MEMORY_INSTRUCTIONS;
                turnMeta.turnId ||= GLib.uuid_string_random();
                const job = {turnId: turnMeta.turnId, sessionId: this._sessionId, notes: new Map(),
                    userText: redactSensitiveText(userText, {apiKey: this._runtime.apiKey, maxChars: 2500}),
                    learn: !fields.displayUserText,
                    previousReferences: previousAssistant?.memoryReferences || [],
                    toolCalls: fields.displayUserText ? null : new Map()};
                this._memoryTurn = job;
                try {
                    memoryContext = await this._prepareMemory(job);
                    turnMeta.allowedMemoryReferences = new Set(job.notes.keys());
                }
                catch (_) {
                    memoryContext = '本轮未能读取已有笔记。';
                    if (!job.cancelled) this._memoryNotice('本轮记忆读取失败', job, 'failed');
                }
                if (job.cancelled || this._closed) {
                    if (this._memoryTurn === job) this._memoryTurn = null;
                    if (!this._closed) this._event({type: 'agent_settled', status: 'cancelled',
                        aborted: true, turnId: job.turnId, sessionId: this._sessionId,
                        clientGeneration: this._clientGeneration});
                    return {disposition: 'cancelled', turnId: job.turnId};
                }
            }
            const lastProgress = previousAssistant?.taskProgress;
            const guidance = [
                TASK_GUIDANCE,
                '仅在确实依据笔记作出选择或需要用户从多个合理候选中选择时，在回答的最后另起一行追加 ' +
                    replyMarker + ' 加紧凑 JSON。used 为本轮实际使用的笔记地址数组，reason 简述该记忆如何影响选择，choices 为候选名称数组。无需回执时省略整行。',
                lastProgress ? '上轮观察到的工具进展（仅在本次相关时参考） ' + JSON.stringify(lastProgress) : '',
            ].filter(Boolean).join('\n');
            memoryContext = [guidance, memoryContext].filter(Boolean).join('\n\n');
            const response = await this._adapter.sendMessage({
                promptText: fields.message || '',
                memoryContext,
                disableResume: Boolean(this._memory),
                turnMeta,
                workspace: this._workspace,
                sessionId: this._sessionId,
                specialDirs: this._specialDirs,
                timeouts: this._timeouts,
            });
            if (response?.disposition === 'rejected_before_send' && this._memoryTurn?.turnId === turnMeta.turnId) {
                this._memoryTurn = null;
            }
            return response;
        }
        return {};
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        for (const job of [this._memoryTurn, ...this._memoryUpdates]) {
            if (!job) continue;
            job.cancelled = true;
            job.stop?.();
            job.toolCalls?.clear();
            job.toolEvidence = null;
        }
        this._memoryTurn = null;
        this._memoryUpdates.clear();
        try { this._startupCancellable?.cancel?.(); } catch (_) {}
        this._startupCancellable = null;
        const active = this._turns.activeTurn;
        this._turns.dispose(
            proc => terminateTurnProcess(active, proc),
            files => files.forEach(removeFileQuietly)
        );
        try { this._adapter?.dispose(); } catch (_) {}
        this._adapter = null;
    }
}
