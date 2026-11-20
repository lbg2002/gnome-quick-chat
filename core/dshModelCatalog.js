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

export function makeDshModelCatalog(configured = {}) {
    const provider = cleanDshModelId(configured.provider);
    const model = cleanDshModelId(configured.model);
    const providers = [{
        id: 'deepseek-official',
        name: 'DeepSeek 官方（随 DSH 安装提供，实际可用取决于账号）',
        models: [...DSH_OFFICIAL_MODELS],
    }];
    if (provider && model && provider !== 'deepseek-official') {
        // A parsed profile route is a configured choice, not an invented listing
        // of all the provider's models.
        providers.push({id: provider, name: `${provider}（当前配置）`, models: [model]});
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

export function buildDshProfileOverlay({provider = '', model = '', persona = ''} = {}) {
    const cleanProvider = cleanDshModelId(provider);
    const cleanModel = cleanDshModelId(model);
    if (Boolean(provider) !== Boolean(model) || (provider && (!cleanProvider || !cleanModel))) {
        throw new Error('DSH 模型必须同时指定有效的 Provider 与模型 ID');
    }
    const cleanPersona = String(persona || '').trim();
    if (cleanPersona.length > 8192) throw new Error('桌面助手提示词最多 8192 字');
    const patches = [];
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
