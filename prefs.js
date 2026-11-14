import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    getBackendCapabilities,
    normalizeOpenAIEndpoint,
} from './protocol.js';
import {
    detectEffectiveBackend,
    loadLocalBackendCatalog,
} from './core/backendDetect.js';
import {
    loadOpenAIApiKey,
    storeOpenAIApiKey,
} from './core/secretStore.js';

const Decoder = new TextDecoder('utf-8');

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
        window.set_default_size(650, 720);

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
            description: '选择对话使用的 AI 引擎，修改后在空闲时自动热更新（绝不篡改外部 CLI 全局配置文件）。',
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
            description: '支持 OpenAI / DeepSeek / Ollama / 本地代理等标准 /v1/chat/completions 流式协议。API Key 加密保存在系统密钥环 (GNOME Keyring)。',
        });
        modelPage.add(openaiGroup);

        const baseUrlRow = new Adw.EntryRow({
            title: '接口地址 (Base URL)',
        });
        s.bind('openai-base-url', baseUrlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        baseUrlRow.add_suffix(makeResetButton('清空接口地址', () => s.set_string('openai-base-url', '')));
        openaiGroup.add(baseUrlRow);

        const apiKeyRow = new Adw.PasswordEntryRow({
            title: '接口密钥 (API Key · 密钥环加密存储)',
        });
        openaiGroup.add(apiKeyRow);

        let syncingSecret = true;
        let secretSaveTimer = 0;
        let latestApiKeyDraft = '';

        loadOpenAIApiKey(s).then(loadedKey => {
            latestApiKeyDraft = loadedKey || '';
            syncingSecret = true;
            apiKeyRow.text = latestApiKeyDraft;
            syncingSecret = false;
        }).catch(() => {
            syncingSecret = false;
        });

        apiKeyRow.connect('notify::text', () => {
            if (syncingSecret) return;
            latestApiKeyDraft = apiKeyRow.text.trim();
            if (secretSaveTimer) {
                try { GLib.source_remove(secretSaveTimer); } catch (_) {}
            }
            secretSaveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                secretSaveTimer = 0;
                storeOpenAIApiKey(s, latestApiKeyDraft).catch(() => {});
                return GLib.SOURCE_REMOVE;
            });
        });

        window.connect('close-request', () => {
            if (secretSaveTimer) {
                try { GLib.source_remove(secretSaveTimer); } catch (_) {}
                secretSaveTimer = 0;
                storeOpenAIApiKey(s, latestApiKeyDraft).catch(() => {});
            }
            return false;
        });

        const sysPromptRow = new Adw.EntryRow({
            title: '系统提示词 (System Prompt)',
        });
        s.bind('system-prompt', sysPromptRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        sysPromptRow.add_suffix(makeResetButton('恢复默认系统提示词', () => s.set_string('system-prompt', '')));
        openaiGroup.add(sysPromptRow);

        // --- Group 3: Provider、模型选择与思考强度 ---
        const catalogGroup = new Adw.PreferencesGroup({
            title: 'Provider、模型与思考强度',
            description: '只读扫描本机 CLI 配置或在线查询可用模型，支持下拉选择或手动输入。',
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

        const getEffectiveBackend = () => detectEffectiveBackend(
            s.get_string('backend'),
            s.get_string('pi-path'),
            s.get_string('openai-base-url')
        );
        const getActiveModelKey = () => (getEffectiveBackend() === 'openai' ? 'openai-model' : 'model');

        const modelEntryRow = new Adw.EntryRow({
            title: '模型 ID (可手动修改)',
        });
        modelEntryRow.add_suffix(makeResetButton('恢复默认模型', () => {
            if (getEffectiveBackend() === 'openai') s.set_string('openai-model', '');
            else s.set_string('model', '');
        }));
        catalogGroup.add(modelEntryRow);

        const efforts = ['default', 'fast', 'standard', 'deep'];
        const effortRow = new Adw.ComboRow({
            title: '思考强度 (Reasoning Effort)',
            subtitle: '日常问答建议使用默认或快速模式以获得更低的首字延迟',
            model: Gtk.StringList.new([
                '默认 (保持后端原有推理设置)',
                '快速 · 日常简短问答 (Low)',
                '标准 · 常规分析推理 (Medium)',
                '深入 · 复杂多步任务 (High)',
            ]),
        });
        effortRow.selected = Math.max(0, efforts.indexOf(s.get_string('reasoning-effort')));
        effortRow.connect('notify::selected', () => {
            s.set_string('reasoning-effort', efforts[effortRow.selected] || 'default');
        });
        catalogGroup.add(effortRow);

        // =====================================================================
        // Page 2: 界面与权限 (UI, Shortcuts & Agent Permissions)
        // =====================================================================
        const uiPage = new Adw.PreferencesPage({
            title: '界面与权限',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(uiPage);

        // --- Group 1: 全局快捷键与提醒 ---
        const shortcutGroup = new Adw.PreferencesGroup({
            title: '全局快捷键与完成提醒',
            description: '支持在桌面任意位置一键呼出随问或直接针对剪贴板文本提问（留空可禁用快捷键）。',
        });
        uiPage.add(shortcutGroup);

        const toggleShortcutRow = new Adw.EntryRow({
            title: '呼出 / 收起随问面板快捷键 (如 <Super><Shift>q)',
        });
        toggleShortcutRow.text = (s.get_strv('toggle-shortcut') || [])[0] || '';
        toggleShortcutRow.connect('notify::text', () => {
            const val = toggleShortcutRow.text.trim();
            s.set_strv('toggle-shortcut', val ? [val] : []);
        });
        toggleShortcutRow.add_suffix(makeResetButton('恢复默认 <Super><Shift>q', () => {
            toggleShortcutRow.text = '<Super><Shift>q';
        }));
        shortcutGroup.add(toggleShortcutRow);

        const clipShortcutRow = new Adw.EntryRow({
            title: '剪贴板 / 选中内容随问快捷键 (如 <Super><Shift>y)',
        });
        clipShortcutRow.text = (s.get_strv('clipboard-shortcut') || [])[0] || '';
        clipShortcutRow.connect('notify::text', () => {
            const val = clipShortcutRow.text.trim();
            s.set_strv('clipboard-shortcut', val ? [val] : []);
        });
        clipShortcutRow.add_suffix(makeResetButton('恢复默认 <Super><Shift>y', () => {
            clipShortcutRow.text = '<Super><Shift>y';
        }));
        shortcutGroup.add(clipShortcutRow);

        const notifyCompleteRow = new Adw.SwitchRow({
            title: '后台生成完成时弹出桌面通知',
            subtitle: '当收起顶部通知栏等待长回答时，生成结束后发送轻量提醒（不抢占焦点）',
        });
        s.bind('notify-on-complete', notifyCompleteRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        shortcutGroup.add(notifyCompleteRow);

        // --- Group 2: 通知栏面板与排版 ---
        const uiGroup = new Adw.PreferencesGroup({
            title: '通知栏面板与动效',
            description: '定制顶部通知栏左栏尺寸、过渡动画及增量 Markdown 渲染。',
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
            title: '增量 Markdown 与代码块渲染',
            subtitle: '流式冻结已完成段落，支持标题、粗斜体、列表及一键复制代码块',
        });
        s.bind('render-markdown', mdRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(mdRow);

        // --- Group 3: CLI Agent 权限、能力矩阵与资源回收 ---
        const agentGroup = new Adw.PreferencesGroup({
            title: 'CLI Agent 权限与环境',
            description: '根据当前所选后端动态适配工具、沙箱与交互式审批能力。',
        });
        uiPage.add(agentGroup);

        const modes = ['chat', 'readonly', 'full'];
        const modeComboModel = Gtk.StringList.new([
            '纯问答 (禁用本地工具)',
            '智能审批 Agent (推荐 · 敏感工具气泡内审批)',
            '全自动 Agent (免审批自动执行一切工具)',
        ]);
        const modeRow = new Adw.ComboRow({
            title: 'Agent 权限模式',
            model: modeComboModel,
        });
        modeRow.selected = Math.max(0, modes.indexOf(s.get_string('agent-mode')));
        modeRow.connect('notify::selected', () => {
            if (syncingModeCombo) return;
            s.set_string('agent-mode', modes[modeRow.selected] || 'readonly');
        });
        agentGroup.add(modeRow);

        const piIdleRow = new Adw.SpinRow({
            title: 'Pi 常驻进程空闲回收 (分钟)',
            subtitle: '仅对 Pi RPC 后端生效（0 表示常驻不回收；回收后下次发消息自动拉起并恢复会话）',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 60,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        piIdleRow.value = s.get_int('pi-idle-minutes');
        piIdleRow.connect('notify::value', () => {
            s.set_int('pi-idle-minutes', Math.round(piIdleRow.value));
        });
        agentGroup.add(piIdleRow);

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

        // =====================================================================
        // State & Synchronization for Provider / Model / Backend Capabilities
        // =====================================================================
        let currentCatalog = {backendLabel: '', providers: []};
        let providerValues = [''];
        let modelValues = [''];
        let onlineOpenAIModels = [];
        let syncingUi = false;
        let syncingModeCombo = false;

        const syncBackendCapabilitiesUi = eff => {
            const caps = getBackendCapabilities(eff);
            const curModeIdx = Math.max(0, modes.indexOf(s.get_string('agent-mode')));
            syncingModeCombo = true;
            modeComboModel.splice(0, modeComboModel.get_n_items(), caps.modeLabels);
            modeRow.selected = curModeIdx;
            syncingModeCombo = false;

            modeRow.sensitive = caps.supportsTools;
            if (!caps.supportsTools) {
                modeRow.subtitle = '当前自定义 OpenAI API 仅使用标准 HTTP 对话流，不挂载本机工具或文件权限';
            } else if (caps.supportsApproval) {
                modeRow.subtitle = '支持按命令/域名/文件粒度分级审批，高危破坏性命令禁止会话级一键放行';
            } else {
                modeRow.subtitle = `当前后端 (${eff.toUpperCase()}) 使用 CLI 沙箱/白名单策略控制权限，不支持会话内交互弹窗审批`;
            }
        };

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

            syncBackendCapabilitiesUi(eff);

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
                catalogGroup.description = `${currentCatalog.backendLabel}：已只读扫描到 ${currentCatalog.providers.length} 个 Provider、${totalModels} 个预设模型。`;
            }
        };

        backendRow.connect('notify::selected', () => {
            const next = backends[backendRow.selected] || 'auto';
            if (s.get_string('backend') !== next) {
                s.set_string('backend', next);
            }
            rebuildProviderAndModelUi();
        });

        providerComboRow.connect('notify::selected', () => {
            if (syncingUi) return;
            const idx = providerComboRow.selected;
            const val = idx >= 0 && idx < providerValues.length ? providerValues[idx] : '';
            if (s.get_string('provider') !== val) {
                s.set_string('provider', val);
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
            rebuildProviderAndModelUi();
        });

        providerEntryRow.connect('notify::text', () => {
            if (syncingUi) return;
            const val = providerEntryRow.text.trim();
            if (s.get_string('provider') !== val) {
                s.set_string('provider', val);
                rebuildProviderAndModelUi();
            }
        });

        modelEntryRow.connect('notify::text', () => {
            if (syncingUi) return;
            const val = modelEntryRow.text.trim();
            const key = getActiveModelKey();
            if (s.get_string(key) !== val) {
                s.set_string(key, val);
                rebuildModelDropdown();
            }
        });

        refreshBtn.connect('clicked', async () => {
            const eff = getEffectiveBackend();
            currentCatalog = loadLocalBackendCatalog(eff);

            let targetBaseUrl = '';
            let targetApiKey = '';
            let targetProviderObj = null;

            if (eff === 'openai') {
                targetBaseUrl = s.get_string('openai-base-url').trim();
                targetApiKey = latestApiKeyDraft || (await loadOpenAIApiKey(s));
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
    }
}
