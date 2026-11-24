import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    getBackendCapabilities,
    normalizeEffectiveAgentMode,
    normalizeOpenAIEndpoint,
} from './protocol.js';
import {
    peekBackendSelection,
    invalidateBackendDetectionCaches,
    loadLocalBackendCatalogAsync,
    migrateGSettingsIfNeeded,
    peekCachedBackendCatalog,
} from './core/backendDetect.js';
import {getMemoryDirectory} from './core/markdownMemory.js';
import {BackendRegistry} from './core/backendRegistry.js';
import {compactNameCombo, compactPreferenceRow} from './ui/preferencesLayout.js';
import {DEFAULT_DESKTOP_ASSISTANT_PROMPT} from './core/dshModelCatalog.js';
import {
    attachCrossOriginRedirectGuard,
    readSoupResponseBytesBoundedAsync,
} from './backendClient.js';
import {
    SecretWriteQueue,
    clearOpenAIApiKey,
    inspectEndpointSecurity,
    loadOpenAIApiKey,
    loadOpenAIApiKeyDetailed,
    normalizeEndpointKeyIdentity,
    storeOpenAIApiKey,
} from './core/secretStore.js';
import {
    executeApprovedSessionCleanupAsync,
    importLegacyPiSessionFileReadOnly,
    listLegacyPiSessionFiles,
    listStoredSessionsAsync,
} from './core/sessionStore.js';
import {
    planSessionRetentionCleanup,
    resolvePreviousSessionId,
} from './core/sessionEngine.js';
import {
    DEFAULT_QUICK_PROMPTS,
    MAX_CUSTOM_QUICK_PROMPTS,
    parseQuickPromptsConfig,
    serializeQuickPromptsConfig,
} from './core/quickActions.js';
import {
    formatCapabilitiesLine,
    formatRedactedDiagnosticsText,
    parseStoredDiagnosticSnapshot,
    sanitizeDiagnosticSnapshot,
} from './core/diagnosticsReport.js';
import {
    defaultEndpointModelMetadataCache,
} from './core/modelCatalogCache.js';
import {
    parseModelsResponse,
    redactSensitiveText,
} from './runtime/sseParser.js';
import {
    RELEASE_PAGE,
} from './core/updateManager.js';
import {
    checkGitHubRelease,
    getInstalledExtensionMode,
    installUserRelease,
} from './runtime/releaseUpdater.js';

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
        migrateGSettingsIfNeeded(s);
        const registry = new BackendRegistry(s);
        window.set_default_size(800, 750);
        window.add_css_class('qc-prefs');
        // Preferences are a separate GTK process, not the Shell renderer.
        // Scope typography to this window and use bounded two-line subtitles
        // rather than allowing verbose descriptions to widen the entire view.
        try {
            const provider = new Gtk.CssProvider();
            provider.load_from_string(
                'window.qc-prefs .subtitle { font-size: 0.82em; } ' +
                'window.qc-prefs .title { font-size: 0.94em; } ' +
                'window.qc-prefs row { min-width: 0; }'
            );
            const display = Gdk.Display.get_default();
            Gtk.StyleContext.add_provider_for_display(
                display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            );
            window.connect('close-request', () => {
                Gtk.StyleContext.remove_provider_for_display(display, provider);
                return false;
            });
        } catch (err) { console.warn('[Quick Chat] GTK typography fallback: ' + err.message); }

        const tuneRows = widget => {
            compactPreferenceRow(widget);
            for (let child = widget.get_first_child?.(); child; child = child.get_next_sibling?.()) {
                tuneRows(child);
            }
        };

        const hasKey = k => Boolean(s.settings_schema?.has_key?.(k));
        const getStr = (k, fb = '') => (hasKey(k) ? s.get_string(k) : fb);
        const setStr = (k, v) => {
            if (hasKey(k) && s.get_string(k) !== v) {
                s.set_string(k, v);
            }
        };

        // =====================================================================
        // Page 1: 模型与后端 (Models & Backends)
        // =====================================================================
        const modelPage = new Adw.PreferencesPage({
            title: '模型与后端',
            icon_name: 'system-run-symbolic',
        });
        window.add(modelPage);

        // --- Optional Group 0: 旧版配置升级提示 ---
        const noticeGroup = new Adw.PreferencesGroup({
            title: '配置迁移提示',
        });
        const noticeRow = new Adw.ActionRow({
            title: '已完成旧版配置安全迁移',
            subtitle: getStr('migration-notice', ''),
        });
        const dismissNoticeBtn = new Gtk.Button({
            label: '知道了',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        const syncNoticeBanner = () => {
            const msg = getStr('migration-notice', '').trim();
            noticeRow.subtitle = msg;
            noticeGroup.visible = Boolean(msg);
        };
        dismissNoticeBtn.connect('clicked', () => {
            setStr('migration-notice', '');
            syncNoticeBanner();
        });
        noticeRow.add_suffix(dismissNoticeBtn);
        noticeGroup.add(noticeRow);
        modelPage.add(noticeGroup);
        syncNoticeBanner();

        // --- Group 1: 后端引擎 ---
        const backendGroup = new Adw.PreferencesGroup({
            title: '后端引擎',
            description: '支持 ZCode、Codex、DeepSeek Harness (dsh) 和 OpenAI 兼容 API；不改动外部 CLI 全局配置。',
        });
        modelPage.add(backendGroup);

        const backends = ['auto', 'zcode', 'codex', 'dsh', 'openai'];
        const backendNames = [
            '自动检测 (ZCode → Codex → DSH → OpenAI API)',
            'ZCode CLI',
            'Codex CLI',
            'DeepSeek Harness (dsh)',
            '自定义 OpenAI API',
        ];
        const backendRow = new Adw.ComboRow({
            title: '运行模式',
            model: Gtk.StringList.new(backendNames),
        });
        backendRow.selected = Math.max(0, backends.indexOf(getStr('backend', 'auto')));
        backendGroup.add(backendRow);

        // --- Group 2: 自定义 OpenAI API 连接配置 (仅在 openai 模式或未配置引导下显示) ---
        const openaiGroup = new Adw.PreferencesGroup({
            title: '自定义 OpenAI 接口连接',
            description: '支持 OpenAI / DeepSeek / Ollama / 本地代理等标准 /v1/chat/completions 流式协议。API Key 按接口地址独立加密保存在系统密钥环 (GNOME Keyring)，切换地址绝不串发旧密钥。',
        });
        modelPage.add(openaiGroup);

        const baseUrlRow = new Adw.EntryRow({
            title: '接口地址 (Base URL)',
        });
        s.bind('openai-base-url', baseUrlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        baseUrlRow.add_suffix(makeResetButton('清空接口地址', () => setStr('openai-base-url', '')));
        openaiGroup.add(baseUrlRow);

        const endpointSecurityRow = new Adw.ActionRow({
            title: '远程明文 HTTP 安全提醒',
            subtitle: '',
            visible: false,
        });
        openaiGroup.add(endpointSecurityRow);

        const apiKeyRow = new Adw.PasswordEntryRow({
            title: '当前接口密钥 (API Key · 按端点独立隔离)',
        });
        const clearKeyBtn = makeResetButton('从系统密钥环彻底清除当前接口密钥', () => {
            triggerClearCurrentEndpointKey();
        });
        apiKeyRow.add_suffix(clearKeyBtn);
        openaiGroup.add(apiKeyRow);

        const secretStatusRow = new Adw.ActionRow({
            title: '密钥存储状态',
            subtitle: '正在读取当前端点的系统密钥环状态…',
        });
        openaiGroup.add(secretStatusRow);

        const allowPlaintextRow = new Adw.SwitchRow({
            title: '密钥环不可用时允许本地兼容存储',
            subtitle: '密钥环不可用时，允许在磁盘明文保存密钥',
        });
        if (hasKey('allow-plaintext-key-fallback')) {
            s.bind('allow-plaintext-key-fallback', allowPlaintextRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        }
        openaiGroup.add(allowPlaintextRow);

        const secretQueue = new SecretWriteQueue();
        let syncingSecret = true;
        let secretSaveTimer = 0;
        let pendingSaveEndpointUrl = '';
        let pendingSaveKeyDraft = '';
        let latestApiKeyDraft = '';
        let activeSecretEndpointSlot = normalizeEndpointKeyIdentity(getStr('openai-base-url', ''));
        let closingAfterFlush = false;
        let activeModelsCancellable = null;

        const syncEndpointSecurityBanner = () => {
            const rawUrl = getStr('openai-base-url', '').trim();
            const sec = inspectEndpointSecurity(rawUrl);
            if (sec.warning) {
                endpointSecurityRow.visible = true;
                endpointSecurityRow.title = sec.isRemotePlaintextHttp
                    ? '⚠️ 远程明文 HTTP 风险提示'
                    : '⚠️ 接口地址格式提示';
                endpointSecurityRow.subtitle = sec.warning;
            } else {
                endpointSecurityRow.visible = false;
                endpointSecurityRow.subtitle = '';
            }
        };

        const flushPendingDebouncedSave = () => {
            if (!secretSaveTimer) return null;
            try { GLib.source_remove(secretSaveTimer); } catch (_) {}
            secretSaveTimer = 0;
            const targetUrl = pendingSaveEndpointUrl;
            const targetDraft = pendingSaveKeyDraft;
            return secretQueue.enqueue(async () => {
                const res = await storeOpenAIApiKey(s, targetDraft, targetUrl);
                if (normalizeEndpointKeyIdentity(getStr('openai-base-url', '')) === normalizeEndpointKeyIdentity(targetUrl)) {
                    if (!res.ok) {
                        secretStatusRow.subtitle = `❌ ${res.error || '密钥操作失败'}`;
                    } else if (res.warning) {
                        secretStatusRow.subtitle = `⚠️ ${res.warning}`;
                    } else if (res.storage === 'keyring') {
                        secretStatusRow.subtitle = '✓ 已加密保存在 GNOME Keyring（仅绑定当前接口地址）';
                    } else if (!targetDraft) {
                        secretStatusRow.subtitle = '当前接口未保存密钥';
                    }
                }
                return res;
            });
        };

        const loadSecretForCurrentEndpoint = () => {
            const curUrl = getStr('openai-base-url', '').trim();
            activeSecretEndpointSlot = normalizeEndpointKeyIdentity(curUrl);
            const loadToken = secretQueue.beginLoad(curUrl);

            // Immediately clear UI draft before async lookup so switching Base URL NEVER retains or leaks old host's key!
            syncingSecret = true;
            latestApiKeyDraft = '';
            apiKeyRow.text = '';
            syncingSecret = false;

            loadOpenAIApiKeyDetailed(s, curUrl).then(info => {
                if (!secretQueue.shouldApplyLoad(loadToken, getStr('openai-base-url', '').trim())) {
                    return;
                }
                latestApiKeyDraft = info.apiKey || '';
                syncingSecret = true;
                apiKeyRow.text = latestApiKeyDraft;
                syncingSecret = false;

                if (info.warning) {
                    secretStatusRow.subtitle = `⚠️ ${info.warning}`;
                } else if (info.apiKey && info.storage === 'keyring') {
                    secretStatusRow.subtitle = info.migrated
                        ? '✓ 已将旧版密钥安全迁移至系统密钥环并清除明文残留'
                        : '✓ 已从系统密钥环加载当前端点的专属密钥';
                } else if (info.apiKey && info.storage === 'memory') {
                    secretStatusRow.subtitle = '⚠️ 当前密钥仅保存在本次运行内存中';
                } else {
                    secretStatusRow.subtitle = '当前接口尚未配置密钥（本地免鉴权服务可留空）';
                }
            }).catch(err => {
                syncingSecret = false;
                secretStatusRow.subtitle = `⚠️ 读取密钥环状态异常：${redactSensitiveText(err?.message || String(err))}`;
            });
        };

        const triggerClearCurrentEndpointKey = () => {
            if (secretSaveTimer) {
                try { GLib.source_remove(secretSaveTimer); } catch (_) {}
                secretSaveTimer = 0;
            }
            const curUrl = getStr('openai-base-url', '').trim();
            secretStatusRow.subtitle = '正在清除当前接口密钥…';
            secretQueue.enqueue(async () => {
                const res = await clearOpenAIApiKey(s, curUrl);
                if (!res.ok) {
                    // Never pretend deletion succeeded when Keyring rejected clear!
                    secretStatusRow.subtitle = `❌ ${res.error || '系统密钥环删除失败，请检查密钥环锁定状态'}`;
                    return res;
                }
                if (normalizeEndpointKeyIdentity(getStr('openai-base-url', '').trim()) === normalizeEndpointKeyIdentity(curUrl)) {
                    latestApiKeyDraft = '';
                    syncingSecret = true;
                    apiKeyRow.text = '';
                    syncingSecret = false;
                    secretStatusRow.subtitle = res.removedFromKeyring
                        ? '✓ 已从系统密钥环彻底删除当前接口密钥'
                        : '✓ 当前接口已无保存的密钥';
                }
                return res;
            });
        };

        syncEndpointSecurityBanner();
        loadSecretForCurrentEndpoint();

        apiKeyRow.connect('notify::text', () => {
            if (syncingSecret) return;
            latestApiKeyDraft = apiKeyRow.text.trim();
            pendingSaveEndpointUrl = getStr('openai-base-url', '').trim();
            pendingSaveKeyDraft = latestApiKeyDraft;
            // Bump edit version immediately so any in-flight initial load cannot clobber user's typing!
            secretQueue.bumpEditVersion();
            if (secretSaveTimer) {
                try { GLib.source_remove(secretSaveTimer); } catch (_) {}
            }
            secretSaveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 320, () => {
                secretSaveTimer = 0;
                const targetUrl = pendingSaveEndpointUrl;
                const targetDraft = pendingSaveKeyDraft;
                secretQueue.enqueue(async () => {
                    const res = await storeOpenAIApiKey(s, targetDraft, targetUrl);
                    if (normalizeEndpointKeyIdentity(getStr('openai-base-url', '')) === normalizeEndpointKeyIdentity(targetUrl)) {
                        if (!res.ok) {
                            secretStatusRow.subtitle = `❌ ${res.error || '密钥保存失败'}`;
                        } else if (res.warning) {
                            secretStatusRow.subtitle = `⚠️ ${res.warning}`;
                        } else if (res.storage === 'keyring') {
                            secretStatusRow.subtitle = '✓ 已加密保存在 GNOME Keyring（仅绑定当前接口地址）';
                        } else if (!targetDraft) {
                            secretStatusRow.subtitle = '✓ 当前接口密钥已清空';
                        }
                    }
                    return res;
                });
                return GLib.SOURCE_REMOVE;
            });
        });

        const prefsSignalIds = [];
        let diagCopyResetTimer = 0;

        window.connect('close-request', () => {
            try { activeModelsCancellable?.cancel?.(); } catch (_) {}
            if (diagCopyResetTimer) {
                try { GLib.source_remove(diagCopyResetTimer); } catch (_) {}
                diagCopyResetTimer = 0;
            }
            while (prefsSignalIds.length > 0) {
                const sid = prefsSignalIds.pop();
                try { s.disconnect(sid); } catch (_) {}
            }
            if (closingAfterFlush) {
                return false;
            }
            flushPendingDebouncedSave();
            if (secretQueue.hasPendingWrites) {
                secretStatusRow.subtitle = '正在完成密钥安全保存…';
                secretQueue.flush().finally(() => {
                    closingAfterFlush = true;
                    try { window.close(); } catch (_) {}
                });
                return true;
            }
            return false;
        });

        const sysPromptRow = new Adw.EntryRow({
            title: '系统提示词 (System Prompt)',
        });
        s.bind('system-prompt', sysPromptRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        sysPromptRow.add_suffix(makeResetButton('恢复默认系统提示词', () => setStr('system-prompt', '')));
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
            subtitle: '切换后筛选模型列表',
            model: providerComboModel,
        });
        compactNameCombo(providerComboRow);
        catalogGroup.add(providerComboRow);

        const modelComboModel = Gtk.StringList.new(['默认 (由后端自动决定)']);
        const modelComboRow = new Adw.ComboRow({
            title: '选择模型',
            subtitle: '也可在下方手动填写',
            model: modelComboModel,
        });
        compactNameCombo(modelComboRow);
        catalogGroup.add(modelComboRow);

        const getSelection = () => peekBackendSelection({
            configuredBackend: getStr('backend', 'auto'),
            zcodePath: getStr('zcode-path', ''),
            codexPath: getStr('codex-path', ''),
            dshPath: getStr('dsh-path', ''),
            openaiBaseUrl: getStr('openai-base-url', ''),
        });
        const getEffectiveBackend = () => getSelection().effectiveBackend;

        const getActiveProvider = eff => registry.getBackendProfile(eff).provider || '';
        const setActiveProvider = (eff, val) => {
            if (eff === 'zcode' || eff === 'codex' || eff === 'dsh') {
                registry.updateBackendProfile(eff, {provider: val});
            }
        };

        const getActiveModel = eff => registry.getBackendProfile(eff).model || '';
        const setActiveModel = (eff, val, {recordRecent = false} = {}) => {
            if (eff === 'zcode' || eff === 'codex' || eff === 'dsh' || eff === 'openai') {
                registry.updateBackendProfile(eff, {model: val}, {recordRecent});
            }
        };

        const getActiveEffort = eff => registry.getBackendProfile(eff).reasoningEffort || 'default';
        const setActiveEffort = (eff, val) => {
            if (eff === 'zcode' || eff === 'codex' || eff === 'openai') {
                registry.updateBackendProfile(eff, {reasoningEffort: val});
            } else {
                setStr('reasoning-effort', val);
            }
        };

        const providerEntryRow = new Adw.EntryRow({
            title: 'Provider 标识 (可手动修改)',
        });
        providerEntryRow.add_suffix(makeResetButton('恢复默认 Provider', () => {
            setActiveProvider(getEffectiveBackend(), '');
            rebuildProviderAndModelUi();
        }));
        catalogGroup.add(providerEntryRow);

        const modelEntryRow = new Adw.EntryRow({
            title: '模型 ID (可手动修改)',
        });
        modelEntryRow.add_suffix(makeResetButton('恢复默认模型', () => {
            setActiveModel(getEffectiveBackend(), '');
            rebuildProviderAndModelUi();
        }));
        catalogGroup.add(modelEntryRow);

        const efforts = ['default', 'fast', 'standard', 'deep'];
        const effortRow = new Adw.ComboRow({
            title: '思考强度 (Reasoning Effort)',
            subtitle: '日常问答可选默认或快速',
            model: Gtk.StringList.new([
                '默认 (保持后端原有推理设置)',
                '快速 · 日常简短问答 (Low)',
                '标准 · 常规分析推理 (Medium)',
                '深入 · 复杂多步任务 (High)',
            ]),
        });
        effortRow.selected = Math.max(0, efforts.indexOf(getActiveEffort(getEffectiveBackend())));
        effortRow.connect('notify::selected', () => {
            if (syncingUi) return;
            setActiveEffort(getEffectiveBackend(), efforts[effortRow.selected] || 'default');
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
            title: '主面板快捷键',
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
            title: '剪贴板随问快捷键',
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

        if (hasKey('enable-experimental-capsule')) {
            const capsuleEnabledRow = new Adw.SwitchRow({
                title: '实验性胶囊',
                subtitle: '在屏幕顶部快速提问',
            });
            s.bind('enable-experimental-capsule', capsuleEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            shortcutGroup.add(capsuleEnabledRow);
        }
        const capsuleShortcutRow = new Adw.EntryRow({
            title: '胶囊快捷键',
        });
        if (hasKey('capsule-shortcut')) {
            capsuleShortcutRow.text = (s.get_strv('capsule-shortcut') || [])[0] || '';
            capsuleShortcutRow.connect('notify::text', () => {
                const shortcut = capsuleShortcutRow.text.trim();
                s.set_strv('capsule-shortcut', shortcut ? [shortcut] : []);
            });
            capsuleShortcutRow.add_suffix(makeResetButton('恢复默认 Super+Shift+A', () => {
                capsuleShortcutRow.text = '<Super><Shift>a';
            }));
            shortcutGroup.add(capsuleShortcutRow);
        }

        const notifyApprovalRow = new Adw.SwitchRow({
            title: '审批提醒',
            subtitle: '点击通知返回待处理任务',
        });
        if (hasKey('notify-on-approval')) {
            s.bind('notify-on-approval', notifyApprovalRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            shortcutGroup.add(notifyApprovalRow);
        }

        const notifyErrorRow = new Adw.SwitchRow({
            title: '后台任务失败或超时弹出桌面通知',
            subtitle: '面板关闭时提示失败或超时',
        });
        if (hasKey('notify-on-error')) {
            s.bind('notify-on-error', notifyErrorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            shortcutGroup.add(notifyErrorRow);
        }

        const notifyCompleteRow = new Adw.SwitchRow({
            title: '后台生成完成时弹出桌面通知',
            subtitle: '面板关闭时提示回答完成',
        });
        s.bind('notify-on-complete', notifyCompleteRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        shortcutGroup.add(notifyCompleteRow);

        // --- Group 1.5: 快捷动作模板与 / 命令 (Stage F1) ---
        const quickPromptsGroup = new Adw.PreferencesGroup({
            title: '快捷动作模板与 / 命令',
            description: '输入框键入 /（或按 Ctrl+/）可唤出内置命令：/explain、/translate、/polish、/summarize、/review、/error、/academic。所有快捷动作默认仅填入输入框，绝不自动发送。',
        });
        uiPage.add(quickPromptsGroup);

        const quickHeaderBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        const addQuickPromptBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: '新增自定义快捷动作模板',
            css_classes: ['flat'],
        });
        const resetQuickPromptsBtn = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: '恢复默认快捷动作模板',
            css_classes: ['flat'],
        });
        quickHeaderBox.append(addQuickPromptBtn);
        quickHeaderBox.append(resetQuickPromptsBtn);
        quickPromptsGroup.set_header_suffix(quickHeaderBox);

        let quickPromptItems = parseQuickPromptsConfig(getStr('quick-prompts-json', ''));
        let mountedQuickRows = [];

        const saveQuickPromptItems = () => {
            if (!hasKey('quick-prompts-json')) return;
            setStr('quick-prompts-json', serializeQuickPromptsConfig(quickPromptItems));
        };

        const formatQuickRowSubtitle = item => {
            const slashPart = item.slash ? `${item.slash} · ` : '';
            const preview = String(item.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 52);
            return `${slashPart}${preview || '（空模板）'}`;
        };

        const rebuildQuickPromptRows = () => {
            for (const row of mountedQuickRows) {
                try { quickPromptsGroup.remove(row); } catch (_) {}
            }
            mountedQuickRows = [];
            addQuickPromptBtn.sensitive = quickPromptItems.length < MAX_CUSTOM_QUICK_PROMPTS;

            quickPromptItems.forEach((item, idx) => {
                const expRow = new Adw.ExpanderRow({
                    title: item.label || `快捷动作 ${idx + 1}`,
                    subtitle: formatQuickRowSubtitle(item),
                });

                compactPreferenceRow(expRow);
                const deleteBtn = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    tooltip_text: '删除此快捷动作',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat', 'circular'],
                });
                deleteBtn.connect('clicked', () => {
                    if (quickPromptItems.length <= 1) {
                        quickPromptItems = DEFAULT_QUICK_PROMPTS.map(d => ({...d}));
                        if (hasKey('quick-prompts-json')) setStr('quick-prompts-json', '');
                    } else {
                        quickPromptItems.splice(idx, 1);
                        saveQuickPromptItems();
                    }
                    rebuildQuickPromptRows();
                });
                expRow.add_suffix(deleteBtn);

                const labelEntry = new Adw.EntryRow({
                    title: '按钮名称 (Label)',
                    text: item.label || '',
                });
                const slashEntry = new Adw.EntryRow({
                    title: '绑定 / 命令 (可选，如 /sql 或覆盖 /polish)',
                    text: item.slash || '',
                });
                const promptEntry = new Adw.EntryRow({
                    title: '提示词模板 (结尾保留换行可接后续输入)',
                    text: item.prompt || '',
                });

                const syncSingleItemEdit = () => {
                    item.label = labelEntry.text.trim() || `快捷动作 ${idx + 1}`;
                    const rawSlash = slashEntry.text.trim();
                    item.slash = rawSlash
                        ? (rawSlash.startsWith('/') ? rawSlash : `/${rawSlash}`).replace(/\s+/g, '').toLowerCase()
                        : '';
                    item.prompt = promptEntry.text || item.prompt;
                    expRow.title = item.label;
                    expRow.subtitle = formatQuickRowSubtitle(item);
                    saveQuickPromptItems();
                };

                labelEntry.connect('notify::text', syncSingleItemEdit);
                slashEntry.connect('notify::text', syncSingleItemEdit);
                promptEntry.connect('notify::text', syncSingleItemEdit);

                expRow.add_row(labelEntry);
                expRow.add_row(slashEntry);
                expRow.add_row(promptEntry);
                quickPromptsGroup.add(expRow);
                mountedQuickRows.push(expRow);
            });
        };

        addQuickPromptBtn.connect('clicked', () => {
            if (quickPromptItems.length >= MAX_CUSTOM_QUICK_PROMPTS) return;
            const n = quickPromptItems.length + 1;
            quickPromptItems.push({
                id: `custom_${Date.now()}_${n}`,
                label: `⚡ 自定义模板 ${n}`,
                slash: `/c${n}`,
                prompt: '请帮我分析以下内容：\n',
            });
            saveQuickPromptItems();
            rebuildQuickPromptRows();
        });

        resetQuickPromptsBtn.connect('clicked', () => {
            quickPromptItems = DEFAULT_QUICK_PROMPTS.map(d => ({...d}));
            if (hasKey('quick-prompts-json')) {
                setStr('quick-prompts-json', '');
            }
            rebuildQuickPromptRows();
        });

        rebuildQuickPromptRows();

        // --- Group 2: 通知栏面板与排版 ---
        const uiGroup = new Adw.PreferencesGroup({
            title: '通知栏面板与动效',
            description: '定制顶部通知栏左栏尺寸、过渡动画及增量 Markdown 渲染。',
        });
        uiPage.add(uiGroup);

        const widthRow = new Adw.SpinRow({
            title: '面板宽度 (px)',
            subtitle: '独立随问面板的宽度',
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

        // --- Group 3: CLI Agent 权限与路径 ---
        const agentGroup = new Adw.PreferencesGroup({
            title: 'CLI Agent 权限与环境',
            description: '根据当前所选后端独立保存工具模式与工作目录偏好，切换引擎时自动恢复。',
        });
        uiPage.add(agentGroup);

        const modes = ['readonly', 'smart', 'full'];
        const modeComboModel = Gtk.StringList.new([
            '只读（允许查看文件与检索，禁止修改）',
            '智能（低风险自动执行，修改/删除需真实审批；Codex 无审批通道时仍只读）',
            '完全权限（危险：允许无审批修改与删除）',
        ]);
        const modeRow = new Adw.ComboRow({
            title: 'Agent 权限模式',
            model: modeComboModel,
        });
        modeRow.selected = Math.max(
            0,
            modes.indexOf(registry.getBackendProfile(getEffectiveBackend()).mode || 'readonly')
        );

        const confirmEnableFullMode = onResult => {
            const heading = '确认开启高权限「全自动 Agent」模式？';
            const body =
                '开启后，CLI Agent 将在不弹出审批提示的情况下直接执行本机 Shell 命令、修改或删除文件并访问网络。\n\n' +
                '仅建议在受信任任务与受控工作目录中临时开启；日常使用建议保持「需审批 Agent」或「只读沙箱 Agent」。';
            if (typeof Adw.AlertDialog === 'function') {
                const dlg = new Adw.AlertDialog({heading, body});
                dlg.add_response('cancel', '保持安全模式');
                dlg.add_response('confirm', '我已知晓风险，开启全自动');
                dlg.set_response_appearance('confirm', Adw.ResponseAppearance.DESTRUCTIVE);
                dlg.set_default_response('cancel');
                dlg.set_close_response('cancel');
                dlg.connect('response', (_, resp) => onResult(resp === 'confirm'));
                dlg.present(window);
                return;
            }
            const dlg = new Adw.MessageDialog({
                transient_for: window,
                modal: true,
                heading,
                body,
            });
            dlg.add_response('cancel', '保持安全模式');
            dlg.add_response('confirm', '我已知晓风险，开启全自动');
            dlg.set_response_appearance('confirm', Adw.ResponseAppearance.DESTRUCTIVE);
            dlg.set_default_response('cancel');
            dlg.set_close_response('cancel');
            dlg.connect('response', (_, resp) => {
                onResult(resp === 'confirm');
                try { dlg.destroy(); } catch (_) {}
            });
            dlg.present();
        };

        const applyBackendMode = (eff, chosenMode) => {
            if (eff === 'zcode' || eff === 'codex' || eff === 'dsh') {
                registry.updateBackendProfile(eff, {mode: chosenMode});
            } else {
                setStr('agent-mode', chosenMode);
            }
        };

        modeRow.connect('notify::selected', () => {
            if (syncingModeCombo) return;
            const eff = getEffectiveBackend();
            const prevMode = registry.getBackendProfile(eff).mode || 'readonly';
            let chosenMode = modes[modeRow.selected] || 'readonly';

            // Codex CLI has no true tool-disabling flag; never pretend prompt text is a sandbox!
            if (chosenMode === 'chat' && eff === 'codex') {
                chosenMode = 'readonly';
                syncingModeCombo = true;
                modeRow.selected = modes.indexOf('readonly');
                syncingModeCombo = false;
            }

            if (chosenMode === 'full' && prevMode !== 'full') {
                const revertIdx = Math.max(0, modes.indexOf(prevMode));
                confirmEnableFullMode(confirmed => {
                    if (confirmed) {
                        applyBackendMode(getEffectiveBackend(), 'full');
                        syncBackendCapabilitiesUi(getEffectiveBackend());
                    } else {
                        syncingModeCombo = true;
                        modeRow.selected = revertIdx;
                        syncingModeCombo = false;
                    }
                });
                return;
            }

            applyBackendMode(eff, chosenMode);
            syncBackendCapabilitiesUi(eff);
        });
        agentGroup.add(modeRow);

        const modelRoutingRow = new Adw.SwitchRow({
            title: '本地规则智能模型推荐 (可选)',
            subtitle: '按问题类型推荐已配置的模型',
        });
        if (hasKey('enable-model-routing')) {
            s.bind('enable-model-routing', modelRoutingRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            agentGroup.add(modelRoutingRow);
        }

        const zcodePathRow = new Adw.EntryRow({
            title: 'ZCode CLI 路径 (留空自动探测)',
        });
        if (hasKey('zcode-path')) {
            s.bind('zcode-path', zcodePathRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        }
        zcodePathRow.add_suffix(makeResetButton('清空自定义 ZCode 路径', () => setStr('zcode-path', '')));
        zcodePathRow.connect('notify::text', () => {
            invalidateBackendDetectionCaches();
            registry.bumpGeneration();
            rebuildProviderAndModelUi();
        });
        agentGroup.add(zcodePathRow);

        const codexPathRow = new Adw.EntryRow({
            title: 'Codex CLI 路径 (留空自动探测)',
        });
        if (hasKey('codex-path')) {
            s.bind('codex-path', codexPathRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        }
        codexPathRow.add_suffix(makeResetButton('清空自定义 Codex 路径', () => setStr('codex-path', '')));
        codexPathRow.connect('notify::text', () => {
            invalidateBackendDetectionCaches();
            registry.bumpGeneration();
            rebuildProviderAndModelUi();
        });
        agentGroup.add(codexPathRow);

        const dshPathRow = new Adw.EntryRow({
            title: 'DeepSeek Harness CLI 路径 (留空自动探测 dsh)',
        });
        if (hasKey('dsh-path')) {
            s.bind('dsh-path', dshPathRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        }
        dshPathRow.add_suffix(makeResetButton('清空自定义 dsh 路径', () => setStr('dsh-path', '')));
        dshPathRow.connect('notify::text', () => {
            invalidateBackendDetectionCaches();
            registry.bumpGeneration();
            rebuildProviderAndModelUi();
        });
        agentGroup.add(dshPathRow);


        let syncingWorkspace = false;
        const workspaceRow = new Adw.EntryRow({
            title: '当前后端工作目录 (留空默认使用主目录 ~)',
        });
        workspaceRow.text = registry.getBackendProfile(getEffectiveBackend()).workspace || '';
        workspaceRow.connect('notify::text', () => {
            if (syncingWorkspace) return;
            const eff = getEffectiveBackend();
            const val = workspaceRow.text.trim();
            if (eff === 'zcode' || eff === 'codex' || eff === 'dsh') {
                registry.updateBackendProfile(eff, {workspace: val});
            } else {
                setStr('workspace', val);
            }
        });
        workspaceRow.add_suffix(makeResetButton('恢复默认主目录', () => {
            workspaceRow.text = '';
        }));
        agentGroup.add(workspaceRow);

        // --- Editable, multi-line agent persona (does not change executable authority) ---
        const personaRow = new Adw.ActionRow({
            title: '桌面助手提示词',
            subtitle: '适用于 ZCode / Codex / DSH。默认适合 GNOME 桌面控制、打开应用和简短问答。',
        });
        const editPersonaButton = new Gtk.Button({
            label: '编辑提示词',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        personaRow.add_suffix(editPersonaButton);
        agentGroup.add(personaRow);
        const updatePersonaSubtitle = () => {
            const userValue = getStr('desktop-assistant-prompt', '').trim();
            personaRow.subtitle = userValue
                ? `已启用自定义指引（${userValue.length} 字），仅用于下一次 Agent 请求。权限仍由 CLI 预设控制。`
                : '使用内置 GNOME 桌面助手指引；支持编辑为自己的中文提示词。';
        };
        updatePersonaSubtitle();
        const resetPersonaButton = makeResetButton('恢复内置桌面助手提示词', () => {
            setStr('desktop-assistant-prompt', '');
            updatePersonaSubtitle();
        });
        personaRow.add_suffix(resetPersonaButton);
        editPersonaButton.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: '自定义桌面助手提示词',
                body: '设置智能助手的工作方式，不改变 DSH/ZCode/Codex 的真实文件与系统权限。打开程序属于系统操作；修改、删除和危险 Bash 指令仍须遵守权限策略。',
            });
            dialog.add_response('cancel', '取消');
            dialog.add_response('save', '保存');
            dialog.set_default_response('save');
            dialog.set_close_response('cancel');
            const editor = new Gtk.TextView({
                wrap_mode: Gtk.WrapMode.WORD_CHAR,
                top_margin: 8, bottom_margin: 8,
                left_margin: 8, right_margin: 8,
                monospace: false,
            });
            editor.get_buffer().set_text(
                getStr('desktop-assistant-prompt', '') || DEFAULT_DESKTOP_ASSISTANT_PROMPT, -1
            );
            const scroller = new Gtk.ScrolledWindow({
                min_content_height: 260,
                max_content_height: 340,
                vexpand: true,
                hscrollbar_policy: Gtk.PolicyType.NEVER,
            });
            scroller.set_child(editor);
            dialog.set_extra_child(scroller);
            dialog.connect('response', (_d, response) => {
                if (response !== 'save') return;
                const buffer = editor.get_buffer();
                const edited = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false).trim();
                if (!edited || edited.length > 8192) {
                    personaRow.subtitle = '⚠️ 提示词不能为空，且最多 8192 字；未覆盖之前的设置';
                    return;
                }
                setStr('desktop-assistant-prompt',
                    edited === DEFAULT_DESKTOP_ASSISTANT_PROMPT ? '' : edited);
                updatePersonaSubtitle();
            });
            dialog.present(window);
        });

        // DSH native Auto Review is a model-based approval substitute, NOT a
        // reliable sandbox or Quick Chat interactive approval. Leave off by
        // default and require the user to install the experimental bundle.
        const dshReviewRow = new Adw.SwitchRow({
            title: '旧版 DSH · 实验性 Auto Review',
            subtitle: '仅旧版 Headless 生效，模型审核可能误判',
            tooltip_text: '需要在 DSH Headless 配置档安装 auto-review 插件。高风险操作会被拒绝，不弹出确认。',
        });
        if (hasKey('dsh-auto-review')) {
            s.bind('dsh-auto-review', dshReviewRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        }
        dshReviewRow.visible = getEffectiveBackend() === 'dsh';
        agentGroup.add(dshReviewRow);

        // --- Group 4: 隐私与本地历史管理 ---
        const privacyGroup = new Adw.PreferencesGroup({
            title: '隐私与本地会话存储',
            description: '本地对话保存在 ~/.local/share/gnome-quick-chat/sessions/（私有 0700/0600 权限，包含消息正文、模型标识与时间戳）。随问默认绝不自动发送剪贴板、窗口标题或文件正文，后台通知默认不暴露回答正文。',
        });
        uiPage.add(privacyGroup);

        const memoryRow = new Adw.SwitchRow({
            title: '为当前后端启用共享 Markdown 记忆',
            subtitle: '向当前后端发送相关记忆。模型可在回合结束后自动总结并更新笔记。',
        });
        const refreshMemoryRow = () => {
            if (!hasKey('shared-memory-backends')) return;
            memoryRow.active = s.get_strv('shared-memory-backends')
                .includes(registry.getMemoryDestination(getEffectiveBackend()));
        };
        memoryRow.connect('notify::active', () => {
            if (!hasKey('shared-memory-backends')) return;
            const target = registry.getMemoryDestination(getEffectiveBackend());
            const destinations = s.get_strv('shared-memory-backends');
            if (destinations.includes(target) === memoryRow.active) return;
            s.set_strv('shared-memory-backends', memoryRow.active
                ? [...destinations, target] : destinations.filter(value => value !== target));
        });
        privacyGroup.add(memoryRow);
        const memoryLocation = new Adw.ActionRow({title: '我的电脑 · Markdown 记忆', subtitle: getMemoryDirectory()});
        const openMemory = new Gtk.Button({label: '打开目录', valign: Gtk.Align.CENTER});
        openMemory.connect('clicked', () => {
            const directory = getMemoryDirectory();
            if (GLib.file_test(directory, GLib.FileTest.IS_SYMLINK)) return;
            GLib.mkdir_with_parents(directory, 0o700);
            Gio.AppInfo.launch_default_for_uri_async(Gio.File.new_for_path(directory).get_uri(),
                null, null, (_, result) => {
                    try { Gio.AppInfo.launch_default_for_uri_finish(result); }
                    catch (_) { memoryLocation.subtitle = '无法打开 ' + directory; }
                });
        });
        memoryLocation.add_suffix(openMemory);
        privacyGroup.add(memoryLocation);
        refreshMemoryRow();

        const resetSessionRow = new Adw.ActionRow({
            title: '新建空白当前会话',
            subtitle: '开始新会话并撤销本次工具授权',
        });
        const resetSessionBtn = new Gtk.Button({
            label: '新建会话',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        resetSessionBtn.connect('clicked', () => {
            const curSid = getStr('session-id', '').trim();
            if (curSid && hasKey('previous-session-id')) {
                setStr('previous-session-id', curSid);
            }
            setStr('session-id', GLib.uuid_string_random());
            resetSessionRow.subtitle = '✓ 已切换至全新空白会话（可通过下方「恢复上一个会话」切回）';
        });
        resetSessionRow.add_suffix(resetSessionBtn);
        privacyGroup.add(resetSessionRow);

        const restorePrevRow = new Adw.ActionRow({
            title: '恢复上一个会话',
            subtitle: '切回最近使用的历史会话',
        });
        const restorePrevBtn = new Gtk.Button({
            label: '恢复上一会话',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        restorePrevBtn.connect('clicked', async () => {
            restorePrevBtn.sensitive = false;
            try {
                const sessions = await listStoredSessionsAsync();
                const currentSid = getStr('session-id', '').trim();
                const preferredPrev = getStr('previous-session-id', '').trim();
                const targetSid = resolvePreviousSessionId(sessions, {
                    currentSessionId: currentSid,
                    preferredPreviousId: preferredPrev,
                });
                if (!targetSid) {
                    restorePrevRow.subtitle = '⚠️ 本地暂无其他可恢复的历史会话';
                    return;
                }
                if (currentSid && hasKey('previous-session-id')) {
                    setStr('previous-session-id', currentSid);
                }
                setStr('session-id', targetSid);
                const hit = sessions.find(item => item.sessionId === targetSid);
                restorePrevRow.subtitle = `✓ 已恢复历史会话：${hit?.previewTitle || targetSid.slice(0, 8)}`;
            } finally {
                restorePrevBtn.sensitive = true;
            }
        });
        restorePrevRow.add_suffix(restorePrevBtn);
        privacyGroup.add(restorePrevRow);

        if (hasKey('session-retention-max-count')) {
            const retentionCountRow = new Adw.SpinRow({
                title: '旧会话保留数量上限',
                subtitle: '超出上限的旧会话仅在点击下方扫描并确认后清理，不会静默删除历史',
                adjustment: new Gtk.Adjustment({
                    lower: 5,
                    upper: 100,
                    step_increment: 5,
                    page_increment: 10,
                }),
            });
            retentionCountRow.value = s.get_int('session-retention-max-count');
            retentionCountRow.connect('notify::value', () => {
                s.set_int('session-retention-max-count', Math.round(retentionCountRow.value));
            });
            privacyGroup.add(retentionCountRow);
        }

        if (hasKey('session-retention-max-days')) {
            const retentionDaysRow = new Adw.SpinRow({
                title: '旧会话保留天数上限 (天)',
                subtitle: '自动保护当前会话与上一个会话不被误删',
                adjustment: new Gtk.Adjustment({
                    lower: 1,
                    upper: 365,
                    step_increment: 5,
                    page_increment: 30,
                }),
            });
            retentionDaysRow.value = s.get_int('session-retention-max-days');
            retentionDaysRow.connect('notify::value', () => {
                s.set_int('session-retention-max-days', Math.round(retentionDaysRow.value));
            });
            privacyGroup.add(retentionDaysRow);
        }

        const confirmSessionCleanupDialog = (plan, onDecision) => {
            const sampleLines = plan.candidatesToDelete
                .slice(0, 5)
                .map(c => `• ${c.previewTitle} (${c.messageCount} 条 · ${c.reason})`)
                .join('\n');
            const moreHint = plan.candidatesToDelete.length > 5
                ? `\n…等共 ${plan.candidatesToDelete.length} 个旧会话`
                : '';
            const heading = `确认清理 ${plan.candidatesToDelete.length} 个超期旧会话？`;
            const body =
                `保留策略：${plan.policySummary}（当前会话与上一个会话受保护保留）。\n\n` +
                `待清理项预览：\n${sampleLines}${moreHint}`;

            if (typeof Adw.AlertDialog === 'function') {
                const dlg = new Adw.AlertDialog({heading, body});
                dlg.add_response('cancel', '暂不清理');
                dlg.add_response('confirm', '确认永久清理');
                dlg.set_response_appearance('confirm', Adw.ResponseAppearance.DESTRUCTIVE);
                dlg.set_default_response('cancel');
                dlg.set_close_response('cancel');
                dlg.connect('response', (_, resp) => onDecision(resp === 'confirm'));
                dlg.present(window);
                return;
            }
            const dlg = new Adw.MessageDialog({
                transient_for: window,
                modal: true,
                heading,
                body,
            });
            dlg.add_response('cancel', '暂不清理');
            dlg.add_response('confirm', '确认永久清理');
            dlg.set_response_appearance('confirm', Adw.ResponseAppearance.DESTRUCTIVE);
            dlg.set_default_response('cancel');
            dlg.set_close_response('cancel');
            dlg.connect('response', (_, resp) => {
                onDecision(resp === 'confirm');
                try { dlg.destroy(); } catch (_) {}
            });
            dlg.present();
        };

        const cleanupSessionsRow = new Adw.ActionRow({
            title: '扫描并清理超期旧会话',
            subtitle: '列出超期会话，确认后清理',
        });
        const cleanupSessionsBtn = new Gtk.Button({
            label: '扫描清理',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        cleanupSessionsBtn.connect('clicked', async () => {
            cleanupSessionsBtn.sensitive = false;
            try {
                const sessions = await listStoredSessionsAsync();
                const currentSid = getStr('session-id', '').trim();
                const prevSid = resolvePreviousSessionId(sessions, {
                    currentSessionId: currentSid,
                    preferredPreviousId: getStr('previous-session-id', '').trim(),
                });
                const maxCount = hasKey('session-retention-max-count')
                    ? s.get_int('session-retention-max-count')
                    : 20;
                const maxAgeDays = hasKey('session-retention-max-days')
                    ? s.get_int('session-retention-max-days')
                    : 30;
                const plan = planSessionRetentionCleanup(sessions, {
                    currentSessionId: currentSid,
                    previousSessionId: prevSid,
                    maxCount,
                    maxAgeDays,
                });
                if (plan.candidatesToDelete.length === 0) {
                    cleanupSessionsRow.subtitle = `✓ 共扫描 ${sessions.length} 个本地会话，无超期需清理项（${plan.policySummary}）`;
                    return;
                }
                confirmSessionCleanupDialog(plan, async approved => {
                    if (!approved) {
                        cleanupSessionsRow.subtitle = `已取消清理（共保留 ${sessions.length} 个会话）`;
                        return;
                    }
                    const candidateIds = plan.candidatesToDelete.map(c => c.sessionId);
                    const res = await executeApprovedSessionCleanupAsync(candidateIds, {
                        protectedIds: [currentSid, prevSid].filter(Boolean),
                    });
                    cleanupSessionsRow.subtitle = res.errors.length
                        ? `⚠️ 已清理 ${res.deletedCount} 个旧会话（${res.errors[0]}）`
                        : `✓ 已安全清理 ${res.deletedCount} 个超期旧会话`;
                });
            } finally {
                cleanupSessionsBtn.sensitive = true;
            }
        });
        cleanupSessionsRow.add_suffix(cleanupSessionsBtn);
        privacyGroup.add(cleanupSessionsRow);

        // --- Optional Group 4: 旧版 Pi 本地历史只读导入 ---
        const legacyPiFiles = listLegacyPiSessionFiles();
        if (legacyPiFiles.length > 0) {
            const legacyImportGroup = new Adw.PreferencesGroup({
                title: '旧版会话只读导入',
                description: '检测到本地 sessions 目录中保留的旧版独立 JSONL 会话。导入后仅作为普通历史对话浏览与续问，不会修改或删除原始文件。',
            });
            uiPage.add(legacyImportGroup);

            for (const item of legacyPiFiles.slice(0, 8)) {
                const row = new Adw.ActionRow({
                    title: item.name,
                    subtitle: item.path,
                });
                const importBtn = new Gtk.Button({
                    label: '只读导入',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                importBtn.connect('clicked', async () => {
                    importBtn.sensitive = false;
                    importBtn.label = '导入中…';
                    const res = await importLegacyPiSessionFileReadOnly(item.path);
                    if (res.ok && res.sessionId) {
                        setStr('session-id', res.sessionId);
                        importBtn.label = `✓ 已导入 (${res.importedCount} 条)`;
                        row.subtitle = `已作为只读历史导入至新会话（原文件保留未变）`;
                    } else {
                        importBtn.sensitive = true;
                        importBtn.label = '重试导入';
                        row.subtitle = `⚠️ ${res.error || '导入失败，已保留原始文件'}`;
                    }
                });
                row.add_suffix(importBtn);
                legacyImportGroup.add(row);
            }
        }

        // =====================================================================
        // Page 3: 紧凑诊断页 (Stage F7 · Redacted Runtime Diagnostics)
        // =====================================================================
        const diagPage = new Adw.PreferencesPage({
            title: '诊断',
            icon_name: 'utilities-terminal-symbolic',
        });
        window.add(diagPage);

        const diagGroup = new Adw.PreferencesGroup({
            title: '运行状态与能力诊断',
            description: '汇总后端引擎版本、实际生效模型、权限边界、桥接握手与会话保存状态。复制报告时自动脱敏（绝不包含对话正文、API Key 或主目录用户名）。',
        });
        diagPage.add(diagGroup);

        const copyDiagBtn = new Gtk.Button({
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        const copyDiagContent = new Adw.ButtonContent({
            icon_name: 'edit-copy-symbolic',
            label: '复制脱敏诊断',
        });
        copyDiagBtn.set_child(copyDiagContent);
        diagGroup.set_header_suffix(copyDiagBtn);

        const diagBackendRow = new Adw.ActionRow({title: '后端引擎与版本', subtitle: '读取中…'});
        const diagModelRow = new Adw.ActionRow({title: '实际生效模型与 Provider', subtitle: '读取中…'});
        const diagCapsRow = new Adw.ActionRow({title: '权限模式与能力边界', subtitle: '读取中…'});
        const diagBridgeRow = new Adw.ActionRow({title: 'ZCode 桥接握手状态', subtitle: '读取中…'});
        const diagConnRow = new Adw.ActionRow({title: '面板挂载与连接状态', subtitle: '读取中…'});
        const diagSessionRow = new Adw.ActionRow({title: '会话存储与最近同步', subtitle: '读取中…'});

        diagGroup.add(diagBackendRow);
        diagGroup.add(diagModelRow);
        diagGroup.add(diagCapsRow);
        diagGroup.add(diagBridgeRow);
        diagGroup.add(diagConnRow);
        diagGroup.add(diagSessionRow);

        const buildCurrentDiagnosticSnapshot = () => {
            const homeDir = GLib.get_home_dir() || '';
            const stored = hasKey('last-diagnostic-json')
                ? parseStoredDiagnosticSnapshot(getStr('last-diagnostic-json', ''), {homeDir})
                : null;
            const configured = getStr('backend', 'auto') || 'auto';
            const sel = getSelection();
            const eff = sel.effectiveBackend;
            const profile = registry.getBackendProfile(eff);
            const modeInfo = normalizeEffectiveAgentMode(eff, profile.mode || 'readonly');
            const caps = getBackendCapabilities(eff, modeInfo.effectiveMode);
            const sec = eff === 'openai' ? inspectEndpointSecurity(getStr('openai-base-url', '')) : {warning: ''};
            const storedMatchesBackend = Boolean(stored && stored.effectiveBackend === eff);

            return sanitizeDiagnosticSnapshot({
                updatedAt: stored?.updatedAt || new Date().toISOString(),
                configuredBackend: configured,
                effectiveBackend: eff,
                cliVersion: storedMatchesBackend
                    ? stored.cliVersion
                    : (eff === 'openai' ? 'HTTP/SSE (Soup 3.0)' : (sel.binaryPath ? `${eff} (${sel.binaryPath})` : '待运行探测')),
                activeProvider: profile.provider || (storedMatchesBackend ? stored.activeProvider : '') || (eff === 'openai' ? '自定义端点' : '默认'),
                activeModel: profile.model || (storedMatchesBackend ? stored.activeModel : '') || '默认（由后端自动决定）',
                effectiveMode: modeInfo.effectiveMode,
                capabilitySummary: formatCapabilitiesLine(caps, modeInfo.effectiveMode),
                bridgeHandshake: eff === 'zcode'
                    ? (storedMatchesBackend ? stored.bridgeHandshake : '待任务启动时验证握手')
                    : '不适用（当前非 ZCode 后端）',
                mountMode: stored?.mountMode || 'panel-button',
                lastConnectionError: !sel.available
                    ? sel.reason
                    : (storedMatchesBackend ? stored.lastConnectionError : '无'),
                sessionSaveStatus: stored?.sessionSaveStatus || '正常',
                endpointSecurityNote: sec.warning || '',
            }, {
                homeDir,
                apiKey: latestApiKeyDraft,
            });
        };

        const syncDiagnosticsUi = () => {
            const snap = buildCurrentDiagnosticSnapshot();
            diagBackendRow.subtitle = `配置: ${snap.configuredBackend} → 实际: ${snap.effectiveBackend} · 版本: ${snap.cliVersion}`;
            diagModelRow.subtitle = `模型: ${snap.activeModel} · Provider: ${snap.activeProvider}`;
            diagCapsRow.subtitle = snap.capabilitySummary;
            diagBridgeRow.subtitle = snap.bridgeHandshake;
            diagConnRow.subtitle = `挂载: ${snap.mountMode} · 连接: ${String(snap.lastConnectionError || '').slice(0, 100)}`
                + (snap.endpointSecurityNote ? ' · 安全提示见脱敏诊断' : '');
            diagSessionRow.subtitle = `${snap.sessionSaveStatus}（更新于 ${snap.updatedAt}）`;
        };

        copyDiagBtn.connect('clicked', () => {
            const snap = buildCurrentDiagnosticSnapshot();
            const extVersion = String(this.metadata?.['version-name'] || this.metadata?.version || '').trim();
            const reportText = formatRedactedDiagnosticsText(snap, {
                extensionVersion: extVersion,
                homeDir: GLib.get_home_dir() || '',
                apiKey: latestApiKeyDraft,
            });
            try {
                const clip = window.get_clipboard?.() || Gdk.Display.get_default()?.get_clipboard?.();
                clip?.set?.(reportText);
                copyDiagContent.label = '✓ 已复制脱敏诊断';
                if (diagCopyResetTimer) {
                    try { GLib.source_remove(diagCopyResetTimer); } catch (_) {}
                }
                diagCopyResetTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => {
                    diagCopyResetTimer = 0;
                    copyDiagContent.label = '复制脱敏诊断';
                    return GLib.SOURCE_REMOVE;
                });
            } catch (_) {
                copyDiagContent.label = '复制失败';
            }
        });

        if (hasKey('last-diagnostic-json')) {
            prefsSignalIds.push(
                s.connect('changed::last-diagnostic-json', () => syncDiagnosticsUi())
            );
        }

        // =====================================================================
        // Page 4: 关于与更新（GitHub Releases，无需自己的服务器）
        // =====================================================================
        const aboutPage = new Adw.PreferencesPage({
            title: '关于与更新',
            icon_name: 'software-update-available-symbolic',
        });
        window.add(aboutPage);
        const updateGroup = new Adw.PreferencesGroup({
            title: 'Quick Chat · 随问',
            description: '更新来自 lbg2002/gnome-quick-chat 的正式 GitHub Releases。仅在点击后检查或下载；不后台轮询。',
        });
        aboutPage.add(updateGroup);

        const currentVersion = String(this.metadata?.['version-name'] || this.metadata?.version || '').trim();
        const versionRow = new Adw.ActionRow({
            title: '当前安装版本',
            subtitle: `v${currentVersion} · GNOME Shell 50`,
        });
        updateGroup.add(versionRow);

        const mode = getInstalledExtensionMode();
        const modeLabels = {
            user: '用户目录安装（可一键安装 ZIP）',
            system: '系统 DEB 安装（使用软件包管理器升级）',
            mixed: '检测到用户与系统版本共存（请先排除覆盖冲突）',
            unknown: '安装路径未确认（只提供发布页面）',
        };
        const installRow = new Adw.ActionRow({
            title: '安装方式',
            subtitle: modeLabels[mode] || modeLabels.unknown,
        });
        updateGroup.add(installRow);

        const updateStatus = new Adw.ActionRow({
            title: '最新版本',
            subtitle: '尚未检查（不会自动访问网络）',
        });
        updateGroup.add(updateStatus);
        const checkBtn = new Gtk.Button({
            label: '检查更新',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        updateStatus.add_suffix(checkBtn);

        const updateInstallRow = new Adw.ActionRow({
            title: '下载安装',
            subtitle: '用户版可在此更新，系统版请使用 DEB',
        });
        updateGroup.add(updateInstallRow);
        const installBtn = new Gtk.Button({
            label: '下载并安装 ZIP',
            valign: Gtk.Align.CENTER,
            sensitive: false,
        });
        updateInstallRow.add_suffix(installBtn);
        installBtn.visible = mode === 'user';

        const releaseRow = new Adw.ActionRow({
            title: 'GitHub 发布页面',
            subtitle: '查看版本说明、.deb 与 ZIP 文件、SHA256SUMS',
        });
        updateGroup.add(releaseRow);
        const releaseBtn = new Gtk.Button({
            label: '查看 Releases',
            valign: Gtk.Align.CENTER,
        });
        releaseRow.add_suffix(releaseBtn);
        releaseBtn.connect('clicked', () => {
            try {
                const launcher = Gtk.UriLauncher.new(RELEASE_PAGE);
                launcher.launch(window, null, (obj, result) => {
                    try { obj.launch_finish(result); }
                    catch (err) { updateStatus.subtitle = `打开浏览器失败：${err.message}`; }
                });
            } catch (err) {
                updateStatus.subtitle = `打开发布页面失败：${err.message}`;
            }
        });

        let latestRelease = null;
        let updating = false;
        let releaseCancellable = null;
        window.connect('close-request', () => {
            try { releaseCancellable?.cancel(); } catch (_) {}
            return false;
        });
        const setUpdateBusy = value => {
            updating = value;
            checkBtn.sensitive = !value;
            installBtn.sensitive = !value && mode === 'user' &&
                Boolean(latestRelease?.hasUpdate && latestRelease?.zip && latestRelease?.checksum);
        };

        checkBtn.connect('clicked', async () => {
            if (updating) return;
            try { releaseCancellable?.cancel(); } catch (_) {}
            releaseCancellable = new Gio.Cancellable();
            setUpdateBusy(true);
            latestRelease = null;
            updateStatus.subtitle = '正在检查 GitHub 正式版本…';
            try {
                const info = await checkGitHubRelease(currentVersion, {
                    cancellable: releaseCancellable,
                });
                if (releaseCancellable.is_cancelled()) return;
                latestRelease = info;
                const availability = info.hasUpdate ? '发现新版本' : '已经是最新正式版';
                updateStatus.subtitle = `${availability}：v${info.version}`;
                if (info.hasUpdate && (!info.zip || !info.checksum)) {
                    updateStatus.subtitle += '（缺少经校验的 ZIP，请通过发布页安装）';
                }
            } catch (err) {
                if (!releaseCancellable.is_cancelled()) {
                    updateStatus.subtitle = `检查失败：${String(err?.message || err).slice(0, 180)}`;
                }
            } finally {
                setUpdateBusy(false);
            }
        });

        installBtn.connect('clicked', () => {
            if (updating || !latestRelease?.hasUpdate || mode !== 'user') return;
            const releaseToInstall = latestRelease;
            const dlg = new Adw.AlertDialog({
                heading: `安装 Quick Chat v${releaseToInstall.version}？`,
                body: '从官方 GitHub Release 下载并校验 SHA-256，然后使用 GNOME 扩展管理器更新用户目录。不会清理历史或 API Key。GNOME Wayland 下完成后必须注销并重新登录，新版本才能真正生效。',
            });
            dlg.add_response('cancel', '取消');
            dlg.add_response('install', '下载并安装');
            dlg.set_default_response('cancel');
            dlg.set_close_response('cancel');
            dlg.connect('response', async (_dialog, response) => {
                if (response !== 'install' || updating) return;
                try { releaseCancellable?.cancel(); } catch (_) {}
                releaseCancellable = new Gio.Cancellable();
                setUpdateBusy(true);
                updateStatus.subtitle = '正在下载、校验 ZIP 并安装…';
                try {
                    await installUserRelease(releaseToInstall, {
                        currentVersion,
                        cancellable: releaseCancellable,
                    });
                    if (!releaseCancellable.is_cancelled()) {
                        updateStatus.subtitle = `✓ v${releaseToInstall.version} 已写入用户目录。请注销并重新登录后生效。`;
                    }
                } catch (err) {
                    if (!releaseCancellable.is_cancelled()) {
                        updateStatus.subtitle = `更新失败（原配置未删除）：${String(err?.message || err).slice(0, 200)}`;
                    }
                } finally {
                    setUpdateBusy(false);
                }
            });
            dlg.present(window);
        });

        // =====================================================================
        // State & Synchronization for Provider / Model / Backend Capabilities
        // =====================================================================
        let currentCatalog = {backendLabel: '', providers: []};
        let providerValues = [''];
        let modelValues = [''];
        let onlineOpenAIModels = hasKey('openai-cached-models')
            ? [...(s.get_strv('openai-cached-models') || [])]
            : [];
        let syncingUi = false;
        let syncingModeCombo = false;
        let catalogBgGen = 0;

        const syncBackendCapabilitiesUi = eff => {
            const profile = registry.getBackendProfile(eff);
            const rawMode = profile.mode || 'readonly';
            const modeInfo = normalizeEffectiveAgentMode(eff, rawMode);
            const caps = getBackendCapabilities(eff, modeInfo.effectiveMode);
            const displayMode = eff === 'codex' && rawMode === 'chat' ? 'readonly' : rawMode;
            const curModeIdx = Math.max(0, modes.indexOf(displayMode));
            syncingModeCombo = true;
            modeComboModel.splice(0, modeComboModel.get_n_items(), caps.modeLabels);
            modeRow.selected = curModeIdx;
            syncingModeCombo = false;

            const desiredWorkspace = profile.workspace || '';
            if (workspaceRow.text !== desiredWorkspace) {
                syncingWorkspace = true;
                workspaceRow.text = desiredWorkspace;
                syncingWorkspace = false;
            }
            workspaceRow.sensitive = eff === 'zcode' || eff === 'codex' || eff === 'dsh';
            dshReviewRow.visible = eff === 'dsh';
            refreshMemoryRow();

            modeRow.sensitive = caps.supportsTools;
            if (eff === 'unconfigured') {
                modeRow.subtitle = '尚未配置可用后端；请先安装 ZCode / Codex CLI 或配置自定义 OpenAI 兼容 API';
            } else if (!caps.supportsTools) {
                modeRow.subtitle = '当前自定义 OpenAI API 仅执行纯文本 HTTP 对话流，不挂载任何本机文件、命令或网络工具';
            } else if (caps.supportsApproval) {
                modeRow.subtitle = '需审批 Agent 按完整命令/规范真实路径/来源逐项请求您授权（非系统级强制只读沙箱；Shell 命令默认仅单次放行）';
            } else if (eff === 'codex') {
                modeRow.subtitle = 'Codex 非交互执行模式无法把写入审批回传到随问；智能模式保持只读，只有显式开启完全权限才允许写入';
            } else {
                modeRow.subtitle = `当前后端 (${eff.toUpperCase()}) 通过 CLI 权限预设控制操作；智能模式无真实审批回传时会保持只读`;
            }
            syncDiagnosticsUi();
        };

        const autoRepairSwappedProviderAndModel = (eff, providers) => {
            const curProv = getActiveProvider(eff);
            const curMod = getActiveModel(eff);
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
                registry.updateBackendProfile(eff, {provider: owner.id, model: exactModel});
            }
        };

        const rebuildModelDropdown = () => {
            const eff = getEffectiveBackend();
            const curProv = getActiveProvider(eff);
            const curMod = getActiveModel(eff);

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
            effortRow.selected = Math.max(0, efforts.indexOf(getActiveEffort(eff)));
            syncingUi = false;
            syncDiagnosticsUi();
        };

        const rebuildProviderAndModelUi = (statusNote = '', skipAsyncRefresh = false) => {
            const configured = getStr('backend', 'auto') || 'auto';
            const selection = getSelection();
            const eff = selection.effectiveBackend;
            const isOpenAI = eff === 'openai';
            const isUnconfigured = eff === 'unconfigured';

            const modeNameMap = {
                zcode: 'ZCode CLI',
                codex: 'Codex CLI',
                dsh: 'DeepSeek Harness',
                openai: '自定义 OpenAI API',
                unconfigured: '未配置可用引擎',
            };
            if (!selection.available) {
                backendRow.subtitle = `⚠️ ${selection.reason}`;
            } else {
                backendRow.subtitle = configured === 'auto'
                    ? `当前自动匹配：${modeNameMap[eff] || eff}`
                    : `当前固定使用：${modeNameMap[eff] || eff}`;
            }

            // Show OpenAI setup group both when openai is selected AND when unconfigured so user can easily configure an API
            openaiGroup.visible = isOpenAI || isUnconfigured;
            providerComboRow.visible = !isOpenAI && !isUnconfigured;
            providerEntryRow.visible = !isOpenAI && !isUnconfigured;

            syncBackendCapabilitiesUi(eff);

            const cached = peekCachedBackendCatalog(eff);
            currentCatalog = cached;
            if (!isOpenAI && !isUnconfigured && (!cached.fromCache || cached.stale) && !skipAsyncRefresh) {
                const bgGen = ++catalogBgGen;
                loadLocalBackendCatalogAsync(eff, {
                    dshPath: getStr('dsh-path', ''),
                }).then(loaded => {
                    if (bgGen === catalogBgGen && getEffectiveBackend() === eff && loaded) {
                        currentCatalog = loaded;
                        rebuildProviderAndModelUi(statusNote, true);
                    }
                }).catch(() => {});
            }

            if (!isOpenAI && !isUnconfigured) {
                autoRepairSwappedProviderAndModel(eff, currentCatalog.providers);
            }

            const curProv = getActiveProvider(eff);
            const provLabels = ['默认 (由后端自动决定)'];
            providerValues = [''];

            for (const p of currentCatalog.providers) {
                const hostHint = p.baseUrl ? ` · ${p.baseUrl.replace(/^https?:\/\//, '').replace(/\/v1.*$/, '')}` : '';
                const label = p.name && p.name !== p.id
                    ? `${p.name} (${p.id})`
                    : p.id;
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
            } else if (isUnconfigured) {
                catalogGroup.description = '尚未检测到可用后端：可在上方直接填写 OpenAI 兼容接口地址，或安装 ZCode / Codex CLI。';
            } else if (isOpenAI) {
                catalogGroup.description = onlineOpenAIModels.length
                    ? `自定义 API：已缓存 / 拉取 ${onlineOpenAIModels.length} 个可选模型。`
                    : '自定义 API：点击右上角「查询 / 刷新模型」可从 /v1/models 拉取在线模型列表。';
            } else {
                catalogGroup.description = eff === 'dsh'
                    ? `DSH：已发现 ${totalModels} 个官方或本地配置模型。`
                    : `${currentCatalog.backendLabel}：已只读扫描到 ${currentCatalog.providers.length} 个 Provider、${totalModels} 个预设模型。`;
            }
        };

        let modelsRefreshGeneration = 0;

        baseUrlRow.connect('notify::text', () => {
            syncEndpointSecurityBanner();
            const nextUrl = getStr('openai-base-url', '').trim();
            const nextSlot = normalizeEndpointKeyIdentity(nextUrl);
            if (nextSlot !== activeSecretEndpointSlot) {
                // Flush any pending key edit to its original endpoint BEFORE switching to the new endpoint!
                flushPendingDebouncedSave();
                ++modelsRefreshGeneration;
                registry.bumpGeneration();
                onlineOpenAIModels = [];
                if (hasKey('openai-cached-models')) {
                    s.set_strv('openai-cached-models', []);
                }
                invalidateBackendDetectionCaches();
                try { activeModelsCancellable?.cancel?.(); } catch (_) {}
                refreshBtn.sensitive = true;
                refreshBtnContent.label = '查询 / 刷新模型';
                loadSecretForCurrentEndpoint();
            }
            rebuildProviderAndModelUi();
        });

        backendRow.connect('notify::selected', () => {
            const next = backends[backendRow.selected] || 'auto';
            if (getStr('backend', 'auto') !== next) {
                ++modelsRefreshGeneration;
                try { activeModelsCancellable?.cancel?.(); } catch (_) {}
                refreshBtn.sensitive = true;
                refreshBtnContent.label = '查询 / 刷新模型';
                registry.selectBackend(next, {clearMigrationNotice: true});
                syncNoticeBanner();
            }
            rebuildProviderAndModelUi();
        });

        providerComboRow.connect('notify::selected', () => {
            if (syncingUi) return;
            const eff = getEffectiveBackend();
            const idx = providerComboRow.selected;
            const val = idx >= 0 && idx < providerValues.length ? providerValues[idx] : '';
            setActiveProvider(eff, val);
            syncingUi = true;
            if (providerEntryRow.text !== val) providerEntryRow.text = val;
            syncingUi = false;
            rebuildModelDropdown();
        });

        modelComboRow.connect('notify::selected', () => {
            if (syncingUi) return;
            const eff = getEffectiveBackend();
            const idx = modelComboRow.selected;
            const val = idx >= 0 && idx < modelValues.length ? modelValues[idx] : '';
            let nextProv = getActiveProvider(eff);
            if (val && eff !== 'openai' && eff !== 'unconfigured') {
                const currentProvObj = currentCatalog.providers.find(p => p.id === nextProv);
                if (!currentProvObj || !currentProvObj.models.includes(val)) {
                    const owner = currentCatalog.providers.find(p => p.models.includes(val));
                    if (owner) {
                        nextProv = owner.id;
                    }
                }
            }
            if (eff === 'zcode' || eff === 'codex' || eff === 'dsh') {
                registry.updateBackendProfile(eff, {provider: nextProv || (val ? currentCatalog.defaultProviderId : ''), model: val}, {recordRecent: Boolean(val)});
            } else {
                setActiveModel(eff, val, {recordRecent: Boolean(val)});
            }
            rebuildProviderAndModelUi();
        });

        providerEntryRow.connect('notify::text', () => {
            if (syncingUi) return;
            const eff = getEffectiveBackend();
            const val = providerEntryRow.text.trim();
            if (getActiveProvider(eff) !== val) {
                setActiveProvider(eff, val);
                rebuildProviderAndModelUi();
            }
        });

        modelEntryRow.connect('notify::text', () => {
            if (syncingUi) return;
            const eff = getEffectiveBackend();
            const val = modelEntryRow.text.trim();
            if (getActiveModel(eff) !== val) {
                setActiveModel(eff, val, {recordRecent: Boolean(val)});
                rebuildModelDropdown();
            }
        });

        refreshBtn.connect('clicked', async () => {
            const reqGen = ++modelsRefreshGeneration;
            const configGenSnapshot = registry.generation;
            try { activeModelsCancellable?.cancel?.(); } catch (_) {}
            const reqCancellable = new Gio.Cancellable();
            activeModelsCancellable = reqCancellable;

            invalidateBackendDetectionCaches();
            const eff = getEffectiveBackend();
            currentCatalog = await loadLocalBackendCatalogAsync(eff, {
                    forceRefresh: true, dshPath: getStr('dsh-path', ''), cancellable: reqCancellable,
                });

            let targetBaseUrl = '';
            let targetApiKey = '';
            let targetProviderObj = null;

            if (eff === 'openai' || eff === 'unconfigured') {
                targetBaseUrl = getStr('openai-base-url', '').trim();
                targetApiKey = latestApiKeyDraft || (await loadOpenAIApiKey(s, targetBaseUrl));
            } else {
                const curProv = getActiveProvider(eff);
                targetProviderObj = (curProv && currentCatalog.providers.find(p => p.id === curProv))
                    || currentCatalog.providers.find(p => p.baseUrl);
                if (targetProviderObj?.baseUrl && targetProviderObj.apiKey) {
                    targetBaseUrl = targetProviderObj.baseUrl;
                    targetApiKey = targetProviderObj.apiKey;
                }
            }

            if (
                reqGen !== modelsRefreshGeneration ||
                configGenSnapshot !== registry.generation ||
                reqCancellable.is_cancelled()
            ) {
                return;
            }

            if (!targetBaseUrl) {
                rebuildProviderAndModelUi(
                    eff === 'openai' || eff === 'unconfigured'
                        ? '⚠️ 请先在上方填写接口地址 (Base URL)'
                        : `✓ 已重新扫描 ${currentCatalog.backendLabel} 本地配置（共 ${currentCatalog.providers.length} 个 Provider）`,
                    true
                );
                return;
            }

            const targetEndpointSlot = normalizeEndpointKeyIdentity(targetBaseUrl);
            const modelsUrl = normalizeOpenAIEndpoint(targetBaseUrl, '/models');
            refreshBtn.sensitive = false;
            refreshBtnContent.label = '查询中…';
            catalogGroup.description = `正在请求 ${modelsUrl} 查询可用模型…`;

            const session = new Soup.Session({timeout: 12});
            const msg = Soup.Message.new('GET', modelsUrl);
            if (!msg) {
                refreshBtn.sensitive = true;
                refreshBtnContent.label = '查询 / 刷新模型';
                rebuildProviderAndModelUi(`❌ 无效的接口地址：${modelsUrl}`, true);
                return;
            }
            const redirectGuardState = {blockedError: null, policy: null, strippedAuth: false, signalIds: []};
            attachCrossOriginRedirectGuard(msg, modelsUrl, {
                method: 'GET',
                cancellable: reqCancellable,
                state: redirectGuardState,
            });
            msg.get_request_headers().append('Accept', 'application/json');
            if (targetApiKey) {
                msg.get_request_headers().append('Authorization', `Bearer ${targetApiKey}`);
            }

            readSoupResponseBytesBoundedAsync(session, msg, {
                cancellable: reqCancellable,
                redirectGuardState,
            }).then(
                ({status, bytes: rawData}) => {
                    if (
                        reqGen !== modelsRefreshGeneration ||
                        configGenSnapshot !== registry.generation ||
                        ((eff === 'openai' || eff === 'unconfigured') &&
                            normalizeEndpointKeyIdentity(getStr('openai-base-url', '').trim()) !== targetEndpointSlot)
                    ) {
                        return;
                    }
                    refreshBtn.sensitive = true;
                    refreshBtnContent.label = '查询 / 刷新模型';
                    const preferred = eff === 'openai' || eff === 'unconfigured'
                        ? getStr('openai-model', '').trim()
                        : getActiveModel(eff);

                    const parsed = parseModelsResponse(status, rawData, {
                        preferredModel: preferred,
                        apiKey: targetApiKey,
                    });
                    if (parsed.metadataById && Object.keys(parsed.metadataById).length > 0) {
                        defaultEndpointModelMetadataCache.setBatch(targetEndpointSlot, parsed.metadataById);
                    }
                    const ids = parsed.models;
                    if (!ids.length) {
                        rebuildProviderAndModelUi('⚠️ 在线接口未返回模型列表，已使用本地配置', true);
                        return;
                    }
                    if (eff === 'openai' || eff === 'unconfigured') {
                        onlineOpenAIModels = ids;
                        if (hasKey('openai-cached-models')) {
                            s.set_strv('openai-cached-models', ids.slice(0, 120));
                        }
                        const currentManualModel = getStr('openai-model', '').trim();
                        if (!currentManualModel && !preferred && parsed.selectedModel) {
                            registry.updateBackendProfile('openai', {model: parsed.selectedModel});
                        }
                        rebuildProviderAndModelUi(`✓ 连接成功：从 ${modelsUrl} 拉取到 ${ids.length} 个在线模型`, true);
                    } else {
                        if (targetProviderObj) {
                            targetProviderObj.models = Array.from(new Set([...ids, ...targetProviderObj.models]));
                        }
                        rebuildModelDropdown();
                        catalogGroup.description = `✓ 已合并本地配置与 ${targetProviderObj?.name || ''} 在线查询结果（共 ${ids.length} 个在线模型）`;
                    }
                },
                err => {
                    if (
                        reqGen !== modelsRefreshGeneration ||
                        configGenSnapshot !== registry.generation ||
                        (!redirectGuardState.blockedError && reqCancellable.is_cancelled()) ||
                        ((eff === 'openai' || eff === 'unconfigured') &&
                            normalizeEndpointKeyIdentity(getStr('openai-base-url', '').trim()) !== targetEndpointSlot)
                    ) {
                        return;
                    }
                    refreshBtn.sensitive = true;
                    refreshBtnContent.label = '查询 / 刷新模型';
                    const rawErr = redirectGuardState.blockedError || err;
                    const cleanErr = redactSensitiveText(rawErr?.message || String(rawErr), {
                        apiKey: targetApiKey,
                        maxChars: 200,
                    });
                    rebuildProviderAndModelUi(`⚠️ 在线查询未成功（${cleanErr}），已保留现有配置`, true);
                }
            );
        });

        rebuildProviderAndModelUi();
        tuneRows(window);
    }
}
