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

/**
 * DSH's provider registry uses the configured route key directly (e.g.
 * "codex"), NOT "llm-pi-ai:codex". The prefix was introduced by an older
 * Quick Chat release; normalize it at the persistence and CLI boundaries.
 */
export function normalizeDshProviderId(value) {
    const raw = String(value || '').trim();
    const withoutLegacyPrefix = raw.startsWith('llm-pi-ai:')
        ? raw.slice('llm-pi-ai:'.length) : raw;
    return cleanDshModelId(withoutLegacyPrefix);
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
    const provider = normalizeDshProviderId(configured.provider);
    const model = cleanDshModelId(configured.model);
    const providers = [{
        id: 'deepseek-official',
        name: 'DeepSeek 官方（随 DSH 安装提供，实际可用取决于账号）',
        models: [...DSH_OFFICIAL_MODELS],
    }];
    for (const item of profileProviders) {
        const id = normalizeDshProviderId(item?.id);
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

export function buildDshProfileOverlay({provider = '', model = '', persona = '', piAiPatch = '', mountCredentials = false, sdkMode = ''} = {}) {
    const cleanProvider = normalizeDshProviderId(provider);
    const cleanModel = cleanDshModelId(model);
    if (Boolean(provider) !== Boolean(model) || (provider && (!cleanProvider || !cleanModel))) {
        throw new Error('DSH 模型必须同时指定有效的 Provider 与模型 ID');
    }
    const cleanPersona = String(persona || '').trim();
    if (cleanPersona.length > 8192) throw new Error('桌面助手提示词最多 8192 字');
    const patches = [];
    if (mountCredentials) patches.push('- id: credentials\n  disabled: false');
    if (sdkMode) {
        const sandbox = sdkMode === 'full' ? 'danger-full-access' : 'read-only';
        const policy = sdkMode === 'smart' ? 'ask' : 'never';
        patches.push(
            `- id: sandbox-policy\n  config:\n    mode: ${sandbox}`,
            `- id: approval\n  config:\n    policy: ${policy}`,
            `- id: permission\n  config:\n    defaultPreset: ${sandbox}\n    presets:\n      ${sandbox}:\n        sandbox: ${sandbox}\n        approval: ${policy}`
        );
    }
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
    '根据用户当前意图和已授予的权限，自主选择工具与执行方式。',
    '相关记忆可作为线索。用户明确表达的偏好可指导选择，过去成功的做法可供参考。',
    '按本次任务需要核实可能变化的信息。已有信息足以行动时直接推进，存在会实质影响结果的歧义时再询问。',
    '依据可观察到的结果说明完成情况，对尚未确认的部分如实表述。',
].join('\n');

export function resolveDesktopAssistantPrompt(configured) {
    const custom = String(configured || '').trim();
    if (custom.length > 8192) throw new Error('桌面助手提示词最多 8192 字');
    return custom || DEFAULT_DESKTOP_ASSISTANT_PROMPT;
}
