/**
 * Local, non-invasive DSH integration helpers. The headless CLI has no
 * "list models" command: --dump-config shows layered model defaults (not the
 * complete provider registry), while the two official DeepSeek model ids come
 * from the shipped DeepSeek provider's DEFAULT_MODELS catalog.
 *
 * Never persist the full dump: it may contain credentials in custom patches.
 * Only provider/model ids are extracted into the UI catalog.
 */

export const DSH_OFFICIAL_MODELS = Object.freeze(['deepseek-flash', 'deepseek-v4-pro']);
const VALID_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;

export function cleanDshModelId(value) {
    const raw = String(value || '').trim();
    return VALID_ID.test(raw) ? raw : '';
}

function yamlScalarValue(raw) {
    const v = String(raw || '').trim();
    if (v.startsWith('"')) {
        try { return JSON.parse(v); } catch (_) { return ''; }
    }
    return v.replace(/\s+#.*$/, '').replace(/^'(.*)'$/, '$1');
}

export function extractDshConfiguredModel(configDump) {
    const dump = String(configDump || '').slice(0, 256 * 1024);
    const lines = dump.split(/\r?\n/);
    let last = {provider: '', model: ''};
    for (let i = 0; i < lines.length; i++) {
        if (!/^\s*-\s*id:\s*agent-default-model\s*$/.test(lines[i])) continue;
        const indent = lines[i].search(/\S/);
        let provider = '', model = '', inConfig = false;
        for (let j = i + 1; j < Math.min(i + 22, lines.length); j++) {
            const line = lines[j];
            if (line.trim() && line.search(/\S/) <= indent) break;
            if (/^\s*config:\s*$/.test(line)) {
                inConfig = true;
                continue;
            }
            if (!inConfig) continue;
            const provMatch = /^\s*provider:\s*(.+)$/.exec(line);
            const modMatch = /^\s*model:\s*(.+)$/.exec(line);
            if (provMatch) provider = cleanDshModelId(yamlScalarValue(provMatch[1]));
            if (modMatch) model = cleanDshModelId(yamlScalarValue(modMatch[1]));
        }
        if (provider && model) last = {provider, model};
    }
    return last;
}


/**
 * Read only the llm-pi-ai route block saved by the DSH Web profile. The
 * headless profile does not automatically inherit the Web model settings.
 */
export function extractDshPiAiPatch(profileText) {
    const lines = String(profileText || '').slice(0, 256 * 1024).split(/\r?\n/);
    const start = lines.findIndex(line => /^-\s+id:\s*['"]?llm-pi-ai['"]?\s*(?:#.*)?$/.test(line));
    if (start < 0) return '';
    let end = start + 1;
    while (end < lines.length && !/^-\s/.test(lines[end])) end++;
    const row = lines.slice(start, end).join('\n').trimEnd();
    return row.length <= 128 * 1024 ? row + '\n' : '';
}

/** Parse only route/model identifiers; never return URLs or credentials. */
export function extractDshPiAiProviders(profileText) {
    const patch = extractDshPiAiPatch(profileText);
    if (!patch) return [];
    const providers = [];
    let configIndent = -1;
    let providersIndent = -1;
    let routeIndent = -1;
    let route = null;
    let modelsIndent = -1;
    for (const line of patch.split(/\r?\n/).slice(1)) {
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const indent = line.search(/\S/);
        const scalar = /^\s*([^\s:#][^:]*):\s*(.*)$/.exec(line);
        if (configIndent < 0) {
            if (scalar && scalar[1].trim() === 'config') configIndent = indent;
            continue;
        }
        if (indent <= configIndent) break;
        if (providersIndent < 0) {
            if (scalar && scalar[1].trim() === 'providers') providersIndent = indent;
            continue;
        }
        if (indent <= providersIndent) break;
        if (routeIndent < 0) {
            if (!scalar) continue;
            routeIndent = indent;
        }
        if (indent === routeIndent && scalar) {
            const id = cleanDshModelId(yamlScalarValue(scalar[1]));
            route = id ? {id, name: id + '（DSH 自定义配置）', models: []} : null;
            if (route) providers.push(route);
            modelsIndent = -1;
            continue;
        }
        if (!route || indent <= routeIndent) continue;
        if (scalar && scalar[1].trim() === 'models' && modelsIndent < 0) {
            modelsIndent = indent;
            continue;
        }
        if (modelsIndent >= 0) {
            if (indent <= modelsIndent) {
                modelsIndent = -1;
                continue;
            }
            const modelMatch = /^\s*-\s+id:\s*(.+?)\s*$/.exec(line);
            if (modelMatch) {
                const model = cleanDshModelId(yamlScalarValue(modelMatch[1]));
                if (model && !route.models.includes(model)) route.models.push(model);
            }
        }
    }
    return providers.slice(0, 64).map(p => ({...p, models: p.models.slice(0, 128)}));
}

export function makeDshModelCatalog(configured = {}, profileProviders = []) {
    const provider = cleanDshModelId(configured.provider);
    const model = cleanDshModelId(configured.model);
    const providers = [{
        id: 'deepseek-official',
        name: 'DeepSeek 官方（随 DSH 安装提供，实际可用取决于账号）',
        models: [...DSH_OFFICIAL_MODELS],
    }];
    for (const item of profileProviders) {
        const id = cleanDshModelId(item?.id);
        if (!id) continue;
        const existing = providers.find(p => p.id === id);
        const target = existing || {id, name: id + '（DSH 自定义配置）', models: []};
        if (!existing) providers.push(target);
        for (const candidate of item.models || []) {
            const clean = cleanDshModelId(candidate);
            if (clean && !target.models.includes(clean)) target.models.push(clean);
        }
    }
    if (provider && model && provider !== 'deepseek-official') {
        // A parsed profile route is a configured choice, not an invented listing
        // of all the provider's models.
        const existing = providers.find(p => p.id === provider);
        if (existing) {
            if (!existing.models.includes(model)) existing.models.push(model);
        } else {
            providers.push({id: provider, name: provider + '（当前配置）', models: [model]});
        }
    } else if (model && !providers[0].models.includes(model)) {
        providers[0].models.push(model);
    }
    return {
        backendLabel: 'DeepSeek Harness',
        providers,
        defaultProviderId: provider || 'deepseek-official',
        defaultModelId: model || 'deepseek-flash',
    };
}

export function buildDshProfileOverlay({provider = '', model = '', persona = '', piAiPatch = ''} = {}) {
    const cleanProvider = cleanDshModelId(provider);
    const cleanModel = cleanDshModelId(model);
    if (Boolean(provider) !== Boolean(model) || (provider && (!cleanProvider || !cleanModel))) {
        throw new Error('DSH 模型必须同时指定有效的 Provider 与模型 ID');
    }
    const cleanPersona = String(persona || '').trim();
    if (cleanPersona.length > 8192) throw new Error('桌面助手提示词最多 8192 字');
    const patches = [];
    const routePatch = extractDshPiAiPatch(piAiPatch);
    if (routePatch) patches.push(routePatch.trimEnd());
    if (cleanProvider && cleanModel) {
        patches.push(`- id: agent-default-model\n  config:\n    provider: ${JSON.stringify(cleanProvider)}\n    model: ${JSON.stringify(cleanModel)}`);
    }
    if (cleanPersona) {
        // JSON strings are YAML-compatible scalars and prevent patch injection
        // through quotes, embedded newlines or a leading "!!js" token.
        patches.push(`- id: system-prompt\n  config:\n    personaPrefix: ${JSON.stringify(cleanPersona)}`);
    }
    return patches.length ? patches.join('\n') + '\n' : '';
}

export const DEFAULT_DESKTOP_ASSISTANT_PROMPT = [
    '你是“随问”，运行在用户自己的 Ubuntu GNOME 桌面中的轻量 AI 助手。优先使用简洁中文，回答事实问题直接给结论。',
    '主要任务：按用户明确的意图打开本机应用、查询系统状态、执行非破坏性的桌面与终端操作；需要时再解释步骤。',
    '打开应用优先使用 gio open、gtk-launch、xdg-open 或已经安装的可执行程序。遵守 Wayland 会话和现有 D-Bus 环境，不使用 --no-sandbox、sudo 或权限绕过参数。',
    '真正运行前判断当前权限：只读时只做信息查询；有系统执行权限时，可执行明确请求的低风险打开和读取操作。',
    '安装、卸载、修改系统配置、移动/覆盖/删除文件、修改安全设置以及递归危险 Bash 命令均属于高风险，未获得明确授权时不执行。无法交互审批时先报告待确认的具体命令，绝不假定已获批。',
    '不要声称已打开应用或已更改设置，除非工具输出提供成功证据；优先解释具体错误和受限环境，不要将隔离环境错误误归咎于用户系统。',
].join('\n');

export function resolveDesktopAssistantPrompt(configured) {
    const custom = String(configured || '').trim();
    if (custom.length > 8192) throw new Error('桌面助手提示词最多 8192 字');
    return custom || DEFAULT_DESKTOP_ASSISTANT_PROMPT;
}
