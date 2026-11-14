import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    buildZCodePersonalConfigOverride,
    normalizeOpenAIEndpoint,
    parseCodexProviderCatalog,
    parseZCodeProviderCatalog,
} from './protocol.js';

const Decoder = new TextDecoder('utf-8');
const Encoder = new TextEncoder();

function applyModelSelectionSideEffects(settings) {
    const home = GLib.get_home_dir();
    const provider = settings.get_string('provider').trim();
    const model = settings.get_string('model').trim();

    // 1. Sync ZCode defaultModelSelection so ZCode CLI uses the chosen provider & model immediately
    const personalPath = GLib.build_filenamev([home, '.zcode', 'v2', 'provider_config.json']);
    const personalObj = readJsonFile(personalPath);
    if (personalObj) {
        const override = buildZCodePersonalConfigOverride(personalObj, {provider, model});
        if (override && override.configObj) {
            const payload = Encoder.encode(JSON.stringify(override.configObj, null, 2));
            try {
                const runtimeDir = GLib.get_user_runtime_dir() || '/tmp';
                const runtimePath = GLib.build_filenamev([runtimeDir, 'quick-chat-zcode-provider.json']);
                GLib.file_set_contents(runtimePath, payload);
            } catch (_) {}
            if (override.providerId && override.modelId) {
                try {
                    GLib.file_set_contents(personalPath, payload);
                } catch (_) {}
            }
        }
    }

    // 2. Clear remoteSessionId in current session state file so next turn doesn't resume an old model's session
    const sessionId = settings.get_string('session-id').trim();
    if (sessionId) {
        const stateFile = GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'quick-chat',
            'sessions',
            `${sessionId}.qc.json`,
        ]);
        const stateObj = readJsonFile(stateFile);
        if (stateObj && stateObj.remoteSessionId) {
            stateObj.remoteSessionId = '';
            try {
                GLib.file_set_contents(stateFile, Encoder.encode(JSON.stringify(stateObj)));
            } catch (_) {}
        }
    }
}

function readJsonFile(path) {
    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) return null;
    try {
        const [ok, raw] = GLib.file_get_contents(path);
        if (!ok || !raw) return null;
        return JSON.parse(Decoder.decode(raw));
    } catch (_) {
        return null;
    }
}

function readTextFile(path) {
    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) return '';
    try {
        const [ok, raw] = GLib.file_get_contents(path);
        return ok && raw ? Decoder.decode(raw) : '';
    } catch (_) {
        return '';
    }
}

function detectEffectiveBackend(configuredBackend) {
    if (configuredBackend && configuredBackend !== 'auto') return configuredBackend;
    const home = GLib.get_home_dir();
    const checkBin = name => Boolean(GLib.find_program_in_path(name));
    if (checkBin('pi')) return 'pi';
    if (GLib.file_test('/opt/ZCode/resources/glm/zcode.cjs', GLib.FileTest.EXISTS)) return 'zcode';
    if (checkBin('codex') || GLib.file_test(GLib.build_filenamev([home, '.codex', 'config.toml']), GLib.FileTest.EXISTS)) {
        return 'codex';
    }
    return 'zcode';
}

function loadLocalBackendCatalog(effectiveBackend) {
    const home = GLib.get_home_dir();
    if (effectiveBackend === 'zcode') {
        const personalPath = GLib.build_filenamev([home, '.zcode', 'v2', 'provider_config.json']);
        const builtinPath = '/opt/ZCode/resources/config/provider/zcode-builtin.json';
        const personalObj = readJsonFile(personalPath);
        const builtinObj = readJsonFile(builtinPath);
        const cat = parseZCodeProviderCatalog(personalObj, builtinObj);
        return {
            backendLabel: 'ZCode CLI',
            providers: cat.providers,
        };
    }

    if (effectiveBackend === 'codex') {
        const tomlPath = GLib.build_filenamev([home, '.codex', 'config.toml']);
        const cachePath = GLib.build_filenamev([home, '.codex', 'models_cache.json']);
        const cat = parseCodexProviderCatalog(readTextFile(tomlPath), readJsonFile(cachePath));
        return {
            backendLabel: 'Codex CLI',
            providers: cat.providers,
        };
    }

    if (effectiveBackend === 'pi') {
        const piModelsPath = GLib.build_filenamev([home, '.pi', 'agent', 'models.json']);
        const piObj = readJsonFile(piModelsPath);
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
        };
    }

    return {
        backendLabel: '自定义 OpenAI API',
        providers: [],
    };
}

function makeResetButton(tooltip, onClick) {
    const btn = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat', 'circular'],
    });
    btn.connect('clicked', onClick);
    return btn;
}

export default class QuickChatPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window.set_default_size(640, 680);

        // =====================================================================
        // Page 1: 模型与后端 (Models & Backends)
        // =====================================================================
        const modelPage = new Adw.PreferencesPage({
            title: '模型与后端',
            icon_name: 'system-run-symbolic',
        });
        window.add(modelPage);

        // --- Group 1: 后端引擎 ---
        const backendGroup = new Adw.PreferencesGroup({
            title: '后端引擎',
            description: '选择对话使用的 AI 引擎，修改后在空闲时自动热更新。',
        });
        modelPage.add(backendGroup);

        const backends = ['auto', 'zcode', 'codex', 'pi', 'openai'];
        const backendNames = [
            '自动检测',
            'ZCode CLI',
            'Codex CLI',
            'Pi CLI',
            '自定义 OpenAI API',
        ];
        const backendRow = new Adw.ComboRow({
            title: '运行模式',
            model: Gtk.StringList.new(backendNames),
        });
        backendRow.selected = Math.max(0, backends.indexOf(s.get_string('backend')));
        backendGroup.add(backendRow);

        // --- Group 2: 自定义 OpenAI API 连接配置 (仅在 openai 模式下显示) ---
        const openaiGroup = new Adw.PreferencesGroup({
            title: '自定义 OpenAI 接口连接',
            description: '支持 OpenAI / DeepSeek / Ollama / 本地代理等标准 /v1/chat/completions 流式协议。',
        });
        modelPage.add(openaiGroup);

        const baseUrlRow = new Adw.EntryRow({
            title: '接口地址 (Base URL)',
        });
        s.bind('openai-base-url', baseUrlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        baseUrlRow.add_suffix(makeResetButton('清空接口地址', () => s.set_string('openai-base-url', '')));
        openaiGroup.add(baseUrlRow);

        const apiKeyRow = new Adw.PasswordEntryRow({
            title: '接口密钥 (API Key)',
        });
        s.bind('openai-api-key', apiKeyRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        openaiGroup.add(apiKeyRow);

        const sysPromptRow = new Adw.EntryRow({
            title: '系统提示词 (System Prompt)',
        });
        s.bind('system-prompt', sysPromptRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        sysPromptRow.add_suffix(makeResetButton('恢复默认系统提示词', () => s.set_string('system-prompt', '')));
        openaiGroup.add(sysPromptRow);

        // --- Group 3: Provider 与模型选择 (支持所有后端查询、下拉选择与手动修改) ---
        const catalogGroup = new Adw.PreferencesGroup({
            title: 'Provider 与模型选择',
            description: '自动读取本机 CLI 配置或在线查询可用模型，支持下拉选择或下方手动输入。',
        });
        modelPage.add(catalogGroup);

        const refreshBtn = new Gtk.Button({
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        const refreshBtnContent = new Adw.ButtonContent({
            icon_name: 'view-refresh-symbolic',
            label: '查询 / 刷新模型',
        });
        refreshBtn.set_child(refreshBtnContent);
        catalogGroup.set_header_suffix(refreshBtn);

        const providerComboModel = Gtk.StringList.new(['默认 (由后端自动决定)']);
        const providerComboRow = new Adw.ComboRow({
            title: '选择 Provider',
            subtitle: '切换服务提供商后，下方模型列表会自动筛选',
            model: providerComboModel,
        });
        catalogGroup.add(providerComboRow);

        const modelComboModel = Gtk.StringList.new(['默认 (由后端自动决定)']);
        const modelComboRow = new Adw.ComboRow({
            title: '选择模型',
            subtitle: '从已发现的模型中直接选择，或在下方手动填写',
            model: modelComboModel,
        });
        catalogGroup.add(modelComboRow);

        const providerEntryRow = new Adw.EntryRow({
            title: 'Provider 标识 (可手动修改)',
        });
        providerEntryRow.add_suffix(makeResetButton('恢复默认 Provider', () => {
            s.set_string('provider', '');
        }));
        catalogGroup.add(providerEntryRow);

        const modelEntryRow = new Adw.EntryRow({
            title: '模型 ID (可手动修改)',
        });
        modelEntryRow.add_suffix(makeResetButton('恢复默认模型', () => {
            const eff = detectEffectiveBackend(s.get_string('backend'));
            if (eff === 'openai') s.set_string('openai-model', '');
            else s.set_string('model', '');
        }));
        catalogGroup.add(modelEntryRow);

        // --- State & Synchronization for Provider / Model ---
        let currentCatalog = {backendLabel: '', providers: []};
        let providerValues = [''];
        let modelValues = [''];
        let onlineOpenAIModels = [];
        let syncingUi = false;

        const getEffectiveBackend = () => detectEffectiveBackend(s.get_string('backend'));
        const getActiveModelKey = () => (getEffectiveBackend() === 'openai' ? 'openai-model' : 'model');

        const autoRepairSwappedProviderAndModel = providers => {
            const curProv = s.get_string('provider').trim();
            const curMod = s.get_string('model').trim();
            if (!curProv || curMod || !providers.length) return;
            const isKnownProvider = providers.some(
                p => p.id.toLowerCase() === curProv.toLowerCase() || p.name.toLowerCase() === curProv.toLowerCase()
            );
            if (isKnownProvider) return;
            const owner = providers.find(
                p => p.models.some(m => m.toLowerCase() === curProv.toLowerCase())
            );
            if (owner) {
                const exactModel = owner.models.find(m => m.toLowerCase() === curProv.toLowerCase()) || curProv;
                s.set_string('provider', owner.id);
                s.set_string('model', exactModel);
            }
        };

        const rebuildModelDropdown = () => {
            const eff = getEffectiveBackend();
            const curProv = s.get_string('provider').trim();
            const curMod = s.get_string(getActiveModelKey()).trim();

            let availableModels = [];
            if (eff === 'openai') {
                availableModels = [...onlineOpenAIModels];
            } else {
                const matchedProv = curProv
                    ? currentCatalog.providers.find(
                        p => p.id.toLowerCase() === curProv.toLowerCase() || p.name.toLowerCase() === curProv.toLowerCase()
                    )
                    : null;
                if (matchedProv) {
                    availableModels = [...matchedProv.models];
                } else {
                    const set = new Set();
                    for (const p of currentCatalog.providers) {
                        for (const m of p.models) set.add(m);
                    }
                    availableModels = Array.from(set);
                }
            }

            const labels = ['默认 (由后端自动决定)'];
            modelValues = [''];

            for (const m of availableModels) {
                if (!modelValues.includes(m)) {
                    labels.push(m);
                    modelValues.push(m);
                }
            }

            if (curMod && !modelValues.includes(curMod)) {
                labels.push(`自定义: ${curMod}`);
                modelValues.push(curMod);
            }

            syncingUi = true;
            modelComboModel.splice(0, modelComboModel.get_n_items(), labels);
            const idx = Math.max(0, modelValues.indexOf(curMod));
            modelComboRow.selected = idx;
            if (modelEntryRow.text !== curMod) {
                modelEntryRow.text = curMod;
            }
            syncingUi = false;
        };

        const rebuildProviderAndModelUi = (statusNote = '') => {
            const configured = s.get_string('backend') || 'auto';
            const eff = getEffectiveBackend();
            const isOpenAI = eff === 'openai';

            const modeNameMap = {
                zcode: 'ZCode CLI',
                codex: 'Codex CLI',
                pi: 'Pi CLI',
                openai: '自定义 OpenAI API',
            };
            backendRow.subtitle = configured === 'auto'
                ? `当前自动匹配：${modeNameMap[eff] || eff}`
                : `当前固定使用：${modeNameMap[eff] || eff}`;

            openaiGroup.visible = isOpenAI;
            providerComboRow.visible = !isOpenAI;
            providerEntryRow.visible = !isOpenAI;

            currentCatalog = loadLocalBackendCatalog(eff);
            if (!isOpenAI) {
                autoRepairSwappedProviderAndModel(currentCatalog.providers);
            }

            const curProv = s.get_string('provider').trim();
            const provLabels = ['默认 (由后端自动决定)'];
            providerValues = [''];

            for (const p of currentCatalog.providers) {
                const hostHint = p.baseUrl ? ` · ${p.baseUrl.replace(/^https?:\/\//, '').replace(/\/v1.*$/, '')}` : '';
                const label = p.name && p.name !== p.id
                    ? `${p.name} (${p.id}${hostHint})`
                    : `${p.id}${hostHint}`;
                provLabels.push(label);
                providerValues.push(p.id);
            }

            if (curProv && !providerValues.includes(curProv)) {
                provLabels.push(`自定义: ${curProv}`);
                providerValues.push(curProv);
            }

            syncingUi = true;
            providerComboModel.splice(0, providerComboModel.get_n_items(), provLabels);
            providerComboRow.selected = Math.max(0, providerValues.indexOf(curProv));
            if (providerEntryRow.text !== curProv) {
                providerEntryRow.text = curProv;
            }
            syncingUi = false;

            rebuildModelDropdown();

            const totalModels = new Set(currentCatalog.providers.flatMap(p => p.models)).size;
            if (statusNote) {
                catalogGroup.description = statusNote;
            } else if (isOpenAI) {
                catalogGroup.description = onlineOpenAIModels.length
                    ? `自定义 API：已在线拉取 ${onlineOpenAIModels.length} 个可选模型。`
                    : '自定义 API：点击右上角「查询 / 刷新模型」可从 /v1/models 拉取在线模型列表。';
            } else {
                catalogGroup.description = `${currentCatalog.backendLabel}：已发现 ${currentCatalog.providers.length} 个 Provider、${totalModels} 个预设模型。`;
            }
        };

        // Events for Dropdowns & Manual Entries
        backendRow.connect('notify::selected', () => {
            const next = backends[backendRow.selected] || 'auto';
            if (s.get_string('backend') !== next) {
                s.set_string('backend', next);
            }
            rebuildProviderAndModelUi();
        applyModelSelectionSideEffects(s);
        });

        providerComboRow.connect('notify::selected', () => {
            if (syncingUi) return;
            const idx = providerComboRow.selected;
            const val = idx >= 0 && idx < providerValues.length ? providerValues[idx] : '';
            if (s.get_string('provider') !== val) {
                s.set_string('provider', val);
                applyModelSelectionSideEffects(s);
            }
            syncingUi = true;
            if (providerEntryRow.text !== val) providerEntryRow.text = val;
            syncingUi = false;
            rebuildModelDropdown();
        });

        modelComboRow.connect('notify::selected', () => {
            if (syncingUi) return;
            const idx = modelComboRow.selected;
            const val = idx >= 0 && idx < modelValues.length ? modelValues[idx] : '';
            const key = getActiveModelKey();
            if (s.get_string(key) !== val) {
                s.set_string(key, val);
            }
            // If user picked a model in ZCode/Codex and provider was empty or mismatched, auto-select its owning provider
            if (val && getEffectiveBackend() !== 'openai') {
                const curProv = s.get_string('provider').trim();
                const currentProvObj = currentCatalog.providers.find(p => p.id === curProv);
                if (!currentProvObj || !currentProvObj.models.includes(val)) {
                    const owner = currentCatalog.providers.find(p => p.models.includes(val));
                    if (owner && s.get_string('provider') !== owner.id) {
                        s.set_string('provider', owner.id);
                    }
                }
            }
            applyModelSelectionSideEffects(s);
            rebuildProviderAndModelUi();
        applyModelSelectionSideEffects(s);
        });

        providerEntryRow.connect('notify::text', () => {
            if (syncingUi) return;
            const val = providerEntryRow.text.trim();
            if (s.get_string('provider') !== val) {
                s.set_string('provider', val);
                applyModelSelectionSideEffects(s);
                rebuildProviderAndModelUi();
        applyModelSelectionSideEffects(s);
            }
        });

        modelEntryRow.connect('notify::text', () => {
            if (syncingUi) return;
            const val = modelEntryRow.text.trim();
            const key = getActiveModelKey();
            if (s.get_string(key) !== val) {
                s.set_string(key, val);
                applyModelSelectionSideEffects(s);
                rebuildModelDropdown();
            }
        });

        // Live Query / Refresh Button (queries local configs AND remote /v1/models if available)
        refreshBtn.connect('clicked', () => {
            const eff = getEffectiveBackend();
            currentCatalog = loadLocalBackendCatalog(eff);

            let targetBaseUrl = '';
            let targetApiKey = '';
            let targetProviderObj = null;

            if (eff === 'openai') {
                targetBaseUrl = s.get_string('openai-base-url').trim();
                targetApiKey = s.get_string('openai-api-key').trim();
            } else {
                const curProv = s.get_string('provider').trim();
                targetProviderObj = (curProv && currentCatalog.providers.find(p => p.id === curProv))
                    || currentCatalog.providers.find(p => p.baseUrl);
                if (targetProviderObj?.baseUrl) {
                    targetBaseUrl = targetProviderObj.baseUrl;
                    targetApiKey = targetProviderObj.apiKey || '';
                }
            }

            if (!targetBaseUrl) {
                rebuildProviderAndModelUi(
                    eff === 'openai'
                        ? '⚠️ 请先在上方填写接口地址 (Base URL)'
                        : `✓ 已重新扫描 ${currentCatalog.backendLabel} 本地配置（共 ${currentCatalog.providers.length} 个 Provider）`
                );
                return;
            }

            const modelsUrl = normalizeOpenAIEndpoint(targetBaseUrl, '/models');
            refreshBtn.sensitive = false;
            refreshBtnContent.label = '查询中…';
            catalogGroup.description = `正在请求 ${modelsUrl} 查询可用模型…`;

            const session = new Soup.Session({timeout: 12});
            const msg = Soup.Message.new('GET', modelsUrl);
            if (!msg) {
                refreshBtn.sensitive = true;
                refreshBtnContent.label = '查询 / 刷新模型';
                rebuildProviderAndModelUi(`❌ 无效的接口地址：${modelsUrl}`);
                return;
            }
            msg.get_request_headers().append('Accept', 'application/json');
            if (targetApiKey) {
                msg.get_request_headers().append('Authorization', `Bearer ${targetApiKey}`);
            }

            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                refreshBtn.sensitive = true;
                refreshBtnContent.label = '查询 / 刷新模型';
                try {
                    const bytes = sess.send_and_read_finish(res);
                    const status = msg.get_status();
                    const bodyText = Decoder.decode(bytes.get_data() || new Uint8Array());
                    if (status < 200 || status >= 300) {
                        rebuildProviderAndModelUi(`⚠️ 在线查询返回 HTTP ${status}，已使用本地配置列表`);
                        return;
                    }
                    const parsed = JSON.parse(bodyText);
                    const items = Array.isArray(parsed.data) ? parsed.data : [];
                    const ids = items.map(it => String(it?.id || '').trim()).filter(Boolean);
                    if (!ids.length) {
                        rebuildProviderAndModelUi('⚠️ 在线接口未返回模型列表，已使用本地配置');
                        return;
                    }
                    if (eff === 'openai') {
                        onlineOpenAIModels = ids;
                        if (!s.get_string('openai-model').trim() && ids[0]) {
                            s.set_string('openai-model', ids[0]);
                        }
                        rebuildProviderAndModelUi(`✓ 连接成功：从 ${modelsUrl} 拉取到 ${ids.length} 个在线模型`);
                    } else {
                        if (targetProviderObj) {
                            targetProviderObj.models = Array.from(new Set([...ids, ...targetProviderObj.models]));
                        }
                        rebuildModelDropdown();
                        catalogGroup.description = `✓ 已合并本地配置与 ${targetProviderObj?.name || ''} 在线查询结果（共 ${ids.length} 个在线模型）`;
                    }
                } catch (err) {
                    rebuildProviderAndModelUi(`⚠️ 在线接口暂不可达（${err.message}），已加载本地配置列表`);
                }
            });
        });

        rebuildProviderAndModelUi();
        applyModelSelectionSideEffects(s);

        // =====================================================================
        // Page 2: 界面与权限 (UI & Agent Permissions)
        // =====================================================================
        const uiPage = new Adw.PreferencesPage({
            title: '界面与权限',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(uiPage);

        // --- Group 1: 通知栏面板与排版 ---
        const uiGroup = new Adw.PreferencesGroup({
            title: '通知栏面板与动效',
            description: '定制顶部通知栏左栏尺寸、过渡动画及 Markdown 富文本渲染。',
        });
        uiPage.add(uiGroup);

        const tabs = ['ai', 'notifications'];
        const tabRow = new Adw.ComboRow({
            title: '默认打开标签',
            subtitle: '进入桌面时通知栏左侧默认展示的页面',
            model: Gtk.StringList.new(['✦ 随问 (AI 助手)', '通知 (系统消息)']),
        });
        tabRow.selected = Math.max(0, tabs.indexOf(s.get_string('default-tab')));
        tabRow.connect('notify::selected', () => {
            s.set_string('default-tab', tabs[tabRow.selected] || 'ai');
        });
        uiGroup.add(tabRow);

        const widthRow = new Adw.SpinRow({
            title: '面板宽度 (px)',
            subtitle: '同时固定随问与通知栏宽度，防止切换标签时日历抖动',
            adjustment: new Gtk.Adjustment({
                lower: 340,
                upper: 680,
                step_increment: 10,
                page_increment: 40,
            }),
        });
        widthRow.value = s.get_int('panel-width');
        widthRow.connect('notify::value', () => {
            s.set_int('panel-width', Math.round(widthRow.value));
        });
        uiGroup.add(widthRow);

        const heightRow = new Adw.SpinRow({
            title: '对话区高度 (px)',
            subtitle: '消息滚动区域的最大显示高度',
            adjustment: new Gtk.Adjustment({
                lower: 280,
                upper: 640,
                step_increment: 10,
                page_increment: 40,
            }),
        });
        heightRow.value = s.get_int('panel-height');
        heightRow.connect('notify::value', () => {
            s.set_int('panel-height', Math.round(heightRow.value));
        });
        uiGroup.add(heightRow);

        const animRow = new Adw.SwitchRow({
            title: '启用平滑过渡动画',
            subtitle: '标签切换渐隐、消息气泡入场与平滑滚动动效',
        });
        s.bind('enable-animations', animRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(animRow);

        const mdRow = new Adw.SwitchRow({
            title: 'Markdown 与代码块渲染',
            subtitle: '渲染标题、粗斜体、列表及带一键复制按钮的代码块',
        });
        s.bind('render-markdown', mdRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(mdRow);

        // --- Group 2: CLI Agent 权限与路径 ---
        const agentGroup = new Adw.PreferencesGroup({
            title: 'CLI Agent 权限与环境',
            description: '仅在使用 ZCode / Codex / Pi 等本机 CLI 引擎时生效。',
        });
        uiPage.add(agentGroup);

        const modes = ['chat', 'readonly', 'full'];
        const modeRow = new Adw.ComboRow({
            title: 'Agent 权限模式',
            subtitle: '智能审批模式支持联网、终端与文件工具，敏感操作在对话气泡内弹窗审批',
            model: Gtk.StringList.new([
                '纯问答 (禁用本地工具)',
                '智能审批 Agent (推荐 · 敏感操作弹窗审批)',
                '全自动 Agent (免审批自动执行一切工具)',
            ]),
        });
        modeRow.selected = Math.max(0, modes.indexOf(s.get_string('agent-mode')));
        modeRow.connect('notify::selected', () => {
            s.set_string('agent-mode', modes[modeRow.selected] || 'readonly');
        });
        agentGroup.add(modeRow);

        const piPathRow = new Adw.EntryRow({
            title: 'CLI 可执行路径 (默认 pi)',
        });
        s.bind('pi-path', piPathRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        piPathRow.add_suffix(makeResetButton('恢复默认路径', () => s.set_string('pi-path', 'pi')));
        agentGroup.add(piPathRow);

        const workspaceRow = new Adw.EntryRow({
            title: 'Agent 工作目录 (留空默认使用主目录 ~)',
        });
        s.bind('workspace', workspaceRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        workspaceRow.add_suffix(makeResetButton('恢复默认主目录', () => s.set_string('workspace', '')));
        agentGroup.add(workspaceRow);
    }
}
