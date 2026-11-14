import GLib from 'gi://GLib';
import {parseCodexProviderCatalog, parseZCodeProviderCatalog} from '../protocol.js';

const Decoder = new TextDecoder('utf-8');

export function readJsonFileSync(path) {
    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) return null;
    try {
        const [ok, raw] = GLib.file_get_contents(path);
        if (!ok || !raw) return null;
        return JSON.parse(Decoder.decode(raw));
    } catch (_) {
        return null;
    }
}

export function readTextFileSync(path) {
    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) return '';
    try {
        const [ok, raw] = GLib.file_get_contents(path);
        return ok && raw ? Decoder.decode(raw) : '';
    } catch (_) {
        return '';
    }
}

export function listNvmBinDirs(homeDir) {
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

/**
 * Shared backend detection logic used identically by Preferences UI, Quick Model Switcher, and Runtime.
 */
export function detectEffectiveBackend(configuredBackend = 'auto', executableHint = 'pi', openaiBaseUrl = '') {
    if (configuredBackend && configuredBackend !== 'auto') {
        return configuredBackend;
    }
    const rawExec = (executableHint || '').trim();
    const pathDirs = buildSearchPath(rawExec);

    if (findExecutableInDirs(rawExec || 'pi', pathDirs)) {
        return 'pi';
    }
    const bundledZCode = '/opt/ZCode/resources/glm/zcode.cjs';
    if (
        GLib.file_test(bundledZCode, GLib.FileTest.EXISTS) &&
        (findExecutableInDirs('node', pathDirs) || GLib.file_test('/opt/ZCode/zcode', GLib.FileTest.IS_EXECUTABLE))
    ) {
        return 'zcode';
    }
    const customCodex = rawExec && rawExec !== 'pi' ? findExecutableInDirs(rawExec, pathDirs) : null;
    if (customCodex || findExecutableInDirs('codex', pathDirs)) {
        return 'codex';
    }
    if ((openaiBaseUrl || '').trim()) {
        return 'openai';
    }
    return 'zcode';
}

export function loadLocalBackendCatalog(effectiveBackend) {
    const home = GLib.get_home_dir();
    if (effectiveBackend === 'zcode') {
        const personalPath = GLib.build_filenamev([home, '.zcode', 'v2', 'provider_config.json']);
        const builtinPath = '/opt/ZCode/resources/config/provider/zcode-builtin.json';
        const personalObj = readJsonFileSync(personalPath);
        const builtinObj = readJsonFileSync(builtinPath);
        const cat = parseZCodeProviderCatalog(personalObj, builtinObj);
        return {
            backendLabel: 'ZCode CLI',
            providers: cat.providers,
            defaultProviderId: cat.defaultSelection?.providerId || '',
            defaultModelId: cat.defaultSelection?.modelId || '',
        };
    }

    if (effectiveBackend === 'codex') {
        const tomlPath = GLib.build_filenamev([home, '.codex', 'config.toml']);
        const cachePath = GLib.build_filenamev([home, '.codex', 'models_cache.json']);
        const cat = parseCodexProviderCatalog(readTextFileSync(tomlPath), readJsonFileSync(cachePath));
        return {
            backendLabel: 'Codex CLI',
            providers: cat.providers,
            defaultProviderId: cat.defaultProvider || 'openai',
            defaultModelId: cat.defaultModel || '',
        };
    }

    if (effectiveBackend === 'pi') {
        const piModelsPath = GLib.build_filenamev([home, '.pi', 'agent', 'models.json']);
        const piObj = readJsonFileSync(piModelsPath);
        const providers = [];
        if (piObj && typeof piObj === 'object') {
            for (const [k, v] of Object.entries(piObj.providers || piObj)) {
                if (v && typeof v === 'object') {
                    const models = Array.isArray(v.models)
                        ? v.models.map(m => String(m?.id || m?.name || m || '').trim()).filter(Boolean)
                        : [];
                    providers.push({id: k, name: k, baseUrl: v.baseUrl || '', apiKey: '', models});
                }
            }
        }
        if (!providers.length) {
            providers.push(
                {id: 'anthropic', name: 'Anthropic', baseUrl: '', apiKey: '', models: ['claude-sonnet-4-5', 'claude-opus-4-5']},
                {id: 'openai', name: 'OpenAI', baseUrl: '', apiKey: '', models: ['gpt-5', 'gpt-4.1', 'o3']},
                {id: 'google', name: 'Google Gemini', baseUrl: '', apiKey: '', models: ['gemini-2.5-pro', 'gemini-2.5-flash']},
                {id: 'deepseek', name: 'DeepSeek', baseUrl: '', apiKey: '', models: ['deepseek-chat', 'deepseek-reasoner']},
            );
        }
        return {
            backendLabel: 'Pi CLI',
            providers,
            defaultProviderId: '',
            defaultModelId: '',
        };
    }

    return {
        backendLabel: '自定义 OpenAI API',
        providers: [],
        defaultProviderId: '',
        defaultModelId: '',
    };
}
