import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import {
    invalidateBackendDetectionCaches,
    loadLocalBackendCatalogAsync,
    peekCachedBackendCatalog,
} from '../core/backendDetect.js';
import {
    DEFAULT_PICKER_PAGE_SIZE,
    resolveModelPickerState,
    toggleFavoriteModelKey,
} from '../core/modelCatalogCache.js';
import {H, V, createStButton, createWrapLabel} from './tracePanel.js';

/**
 * Searchable, favorite-able, recent-ranked, paginated quick Model & Backend Picker (Stage E & R11).
 * Uses `BackendRegistry` for isolated per-backend configurations and `Gio.Cancellable` +
 * generation guards for background catalog refreshes.
 */
export class ModelPickerController {
    constructor({
        settings,
        registry,
        getEffectiveBackend,
        getAvailableBackends = null,
        getActiveRuntimeInfo = null,
        getClient,
        isExtensionAlive,
        onOpenPreferences,
    }) {
        this._settings = settings;
        this._registry = registry;
        this._getEffectiveBackend = getEffectiveBackend;
        this._getAvailableBackends = getAvailableBackends;
        this._getActiveRuntimeInfo = getActiveRuntimeInfo;
        this._getClient = getClient;
        this._isExtensionAlive = isExtensionAlive;
        this._onOpenPreferences = onOpenPreferences;

        this.container = null;
        this.chevronLabel = null;
        this._onToggle = null;
        this.isOpen = false;
        this.query = '';
        this.page = 0;
        this._refreshing = false;
        this._bgGen = 0;
        this._activeCancellable = null;
        this._renderResultsFn = null;
    }

    _hasKey(key) {
        return Boolean(this._settings?.settings_schema?.has_key?.(key));
    }

    _getStr(key, fallback = '') {
        return this._hasKey(key) ? this._settings.get_string(key) : fallback;
    }

    _getStrv(key) {
        return this._hasKey(key) ? (this._settings.get_strv(key) || []) : [];
    }

    attachActors(containerBox, chevronLabel, {onToggle = null} = {}) {
        this.container = containerBox;
        this.chevronLabel = chevronLabel;
        this._onToggle = onToggle;
    }

    resetSessionState() {
        this.query = '';
        this.page = 0;
    }

    dismissMigrationNotice() {
        if (this._hasKey('migration-notice') && this._getStr('migration-notice', '')) {
            this._settings.set_string('migration-notice', '');
        }
    }

    toggle(forceState) {
        if (!this.container) return;
        const nextOpen = typeof forceState === 'boolean' ? forceState : !this.isOpen;
        this.isOpen = nextOpen;
        if (this.chevronLabel) {
            if (this.chevronLabel instanceof St.Icon) {
                this.chevronLabel.icon_name = nextOpen ? 'pan-up-symbolic' : 'pan-down-symbolic';
            } else {
                this.chevronLabel.text = nextOpen ? '▴' : '▾';
            }
        }
        if (!nextOpen) {
            this.container.visible = false;
            this._onToggle?.(false);
            return;
        }
        this.populate();
        this.container.visible = true;
        this._onToggle?.(true);
    }

    refreshResultsOnly() {
        if (this.isOpen) {
            this._renderResultsFn?.();
        }
    }

    _toggleFavoriteModel(entryKey) {
        if (!entryKey || !this._hasKey('favorite-models')) return;
        const curFavs = this._getStrv('favorite-models');
        const nextFavs = toggleFavoriteModelKey(curFavs, entryKey);
        this._settings.set_strv('favorite-models', nextFavs);
    }

    _refreshCatalogInBackground(effectiveBackend, forceRefresh = false) {
        if (!this._isExtensionAlive() || effectiveBackend === 'unconfigured') return;
        const bgGen = ++this._bgGen;
        try { this._activeCancellable?.cancel?.(); } catch (_) {}
        const cancellable = new Gio.Cancellable();
        this._activeCancellable = cancellable;
        this._refreshing = true;

        const runRefresh = async () => {
            if (effectiveBackend === 'openai') {
                const client = this._getClient?.();
                if (client) {
                    const res = await client.request('get_models', {forceRefresh, cancellable});
                    if (
                        !cancellable.is_cancelled() &&
                        this._isExtensionAlive() &&
                        bgGen === this._bgGen &&
                        Array.isArray(res?.models) &&
                        res.models.length > 0 &&
                        this._hasKey('openai-cached-models')
                    ) {
                        this._settings.set_strv('openai-cached-models', res.models.slice(0, 120));
                    }
                }
                return;
            }
            await loadLocalBackendCatalogAsync(effectiveBackend, {
                forceRefresh, dshPath: this._getStr('dsh-path', ''),
            });
        };

        runRefresh()
            .catch(() => {})
            .finally(() => {
                if (!this._isExtensionAlive() || bgGen !== this._bgGen) return;
                this._refreshing = false;
                if (this.isOpen) {
                    this._renderResultsFn?.();
                }
            });
    }

    _buildCurrentPickerState() {
        const configuredBackend = this._registry.getConfiguredBackend();
        const effectiveBackend = this._getEffectiveBackend();
        const profile = this._registry.getBackendProfile(effectiveBackend);
        const catalog = effectiveBackend === 'zcode' && this._refreshing
            ? {providers: []} : peekCachedBackendCatalog(effectiveBackend);
        const runtimeInfo = this._getActiveRuntimeInfo?.() || {};
        const availableBackends = this._getAvailableBackends?.() || null;

        return resolveModelPickerState({
            configuredBackend,
            effectiveBackend,
            profile,
            catalog,
            cachedOpenAiModels: this._getStrv('openai-cached-models'),
            favoriteKeys: this._getStrv('favorite-models'),
            recentKeys: this._getStrv('recent-models'),
            query: this.query,
            page: this.page,
            pageSize: DEFAULT_PICKER_PAGE_SIZE,
            availableBackends,
            runtimeModelId: runtimeInfo.modelId || '',
            runtimeProviderId: runtimeInfo.providerId || '',
            runtimeCapabilities: runtimeInfo.capabilities || null,
            endpointUrl: this._getStr('openai-base-url', '').trim(),
        });
    }

    _createIconBtn(iconName, callback, tooltip, styleClass = 'qc-picker-icon-btn') {
        const icon = new St.Icon({
            icon_name: iconName,
            style_class: 'qc-symbolic-icon-sm',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const btn = new St.Button({
            style_class: styleClass,
            can_focus: true,
            reactive: true,
            track_hover: true,
            accessible_name: tooltip,
            child: icon,
        });
        btn.connect('clicked', callback);
        return btn;
    }

    populate() {
        if (!this.container) return;
        this.container.destroy_all_children();

        const pickerState = this._buildCurrentPickerState();
        const effectiveBackend = pickerState.effectiveBackend;

        const migrationNotice = this._getStr('migration-notice', '').trim();
        if (migrationNotice) {
            const noticeRow = new St.BoxLayout({
                orientation: H,
                style_class: 'qc-picker-row',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            noticeRow.add_child(createWrapLabel(`ℹ️ ${migrationNotice}`, 'qc-picker-empty'));
            noticeRow.add_child(createStButton('知道了', () => {
                this.dismissMigrationNotice();
                this.populate();
            }, 'qc-picker-chip', '关闭升级提示'));
            this.container.add_child(noticeRow);
        }

        const headerRow = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-picker-header',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(new St.Label({
            text: '选择模型',
            style_class: 'qc-picker-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (effectiveBackend !== 'unconfigured') {
            headerRow.add_child(this._createIconBtn(
                'view-refresh-symbolic',
                () => {
                    invalidateBackendDetectionCaches('catalog');
                    this._refreshCatalogInBackground(effectiveBackend, true);
                    this._renderResultsFn?.();
                },
                '后台异步刷新模型目录'
            ));
        }
        headerRow.add_child(this._createIconBtn(
            'emblem-system-symbolic',
            () => {
                this.toggle(false);
                this._onOpenPreferences?.();
            },
            '打开完整设置页面'
        ));
        headerRow.add_child(this._createIconBtn(
            'window-close-symbolic',
            () => this.toggle(false),
            '收起模型选择器'
        ));
        this.container.add_child(headerRow);

        const engineBar = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-segmented-group',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (const item of pickerState.backendChips) {
            const segCls = [
                'qc-seg-btn',
                item.active ? 'qc-seg-btn-active' : '',
                !item.installed ? 'qc-seg-btn-dim' : '',
            ].filter(Boolean).join(' ');
            const segBtn = createStButton(
                item.label,
                () => {
                    this.page = 0;
                    // Fast switch updates backend profile/selection without resetting composer draft or attachments (R11.1)
                    this._registry.selectBackend(item.id, {clearMigrationNotice: true});
                    this.populate();
                },
                segCls,
                item.statusTag ? `${item.label}（${item.statusTag}）` : `切换到 ${item.label}`
            );
            segBtn.x_expand = true;
            engineBar.add_child(segBtn);
        }
        this.container.add_child(engineBar);

        const summaryLabel = createWrapLabel('', 'qc-picker-caption');
        this.container.add_child(summaryLabel);

        if (effectiveBackend !== 'unconfigured') {
            const searchEntry = new St.Entry({
                style_class: 'qc-picker-search',
                primary_icon: new St.Icon({
                    icon_name: 'edit-find-symbolic',
                    style_class: 'qc-search-icon',
                }),
                hint_text: effectiveBackend === 'openai'
                    ? '搜索缓存模型，或输入模型 ID 按回车…'
                    : '搜索模型或服务商…',
                can_focus: true,
                track_hover: true,
                x_expand: true,
            });
            if (this.query) searchEntry.set_text(this.query);
            const sct = searchEntry.clutter_text;
            sct.connect('text-changed', () => {
                this.query = searchEntry.get_text();
                this.page = 0;
                this._renderResultsFn?.();
            });
            sct.connect('activate', () => {
                const typed = searchEntry.get_text().trim();
                if (!typed) return;
                if (effectiveBackend === 'openai') {
                    this._registry.updateBackendProfile('openai', {model: typed}, {recordRecent: true});
                    this.toggle(false);
                }
            });
            this.container.add_child(searchEntry);
        }

        const resultsScroll = new St.ScrollView({
            style_class: 'qc-picker-scroll',
            x_expand: true,
            y_expand: true,
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        const resultsSection = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-picker-models',
            x_expand: true,
        });
        resultsScroll.set_child(resultsSection);
        this.container.add_child(resultsScroll);

        const paginationBox = new St.BoxLayout({
            orientation: V,
            x_expand: true,
        });
        this.container.add_child(paginationBox);

        const footerRow = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-picker-row qc-picker-footer',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const renderFooterRow = stateForFooter => {
            footerRow.destroy_all_children();
            const eff = stateForFooter.effectiveBackend;
            const thinkingSupport = stateForFooter.thinkingSupport;
            footerRow.add_child(new St.Label({
                text: '思考',
                style_class: 'qc-picker-label',
                y_align: Clutter.ActorAlign.CENTER,
            }));

            if (!thinkingSupport.supported) {
                footerRow.add_child(createWrapLabel(
                    thinkingSupport.reason || '当前模型不支持思考强度调节',
                    'qc-picker-caption'
                ));
            } else {
                const effortBar = new St.BoxLayout({
                    orientation: H,
                    style_class: 'qc-segmented-group',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const curEffort = this._registry.getBackendProfile(eff).reasoningEffort || 'default';
                for (const ef of [
                    {id: 'default', label: '默认'},
                    {id: 'fast', label: '快速'},
                    {id: 'standard', label: '标准'},
                    {id: 'deep', label: '深入'},
                ]) {
                    const efBtn = createStButton(
                        ef.label,
                        () => {
                            if (eff !== 'unconfigured') {
                                this._registry.updateBackendProfile(eff, {reasoningEffort: ef.id});
                            }
                            this.populate();
                        },
                        curEffort === ef.id ? 'qc-seg-btn qc-seg-btn-active' : 'qc-seg-btn',
                        `思考强度：${ef.label}`
                    );
                    efBtn.x_expand = true;
                    effortBar.add_child(efBtn);
                }
                footerRow.add_child(effortBar);
            }
        };

        const renderResultsSection = () => {
            if (!resultsSection.get_parent()) return;
            resultsSection.destroy_all_children();
            paginationBox.destroy_all_children();

            const liveState = this._buildCurrentPickerState();
            summaryLabel.text = [liveState.currentModelSummary, liveState.capabilityNotice].filter(Boolean).join(' · ');
            const eff = liveState.effectiveBackend;
            const catalog = peekCachedBackendCatalog(eff);
            const ranked = liveState.ranked;
            this.page = ranked.page;

            if (ranked.items.length > 0) {
                for (const entry of ranked.items) {
                    const cell = new St.BoxLayout({
                        orientation: H,
                        style_class: 'qc-picker-model-cell',
                        x_expand: true,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    const suffix = catalog.providers.length > 1 && entry.providerName
                        ? ` (${entry.providerName})`
                        : '';
                    const recentBadge = entry.isRecent && !entry.isSelected && !entry.isFavorite ? ' · 近期' : '';
                    const lbl = `${entry.isSelected ? '✓ ' : ''}${entry.modelId}${suffix}${recentBadge}`;
                    const modelLbl = createWrapLabel(lbl, 'qc-picker-model-label');
                    modelLbl.y_align = Clutter.ActorAlign.CENTER;
                    const mBtn = new St.Button({
                        style_class: entry.isSelected ? 'qc-picker-model-btn qc-picker-chip-active' : 'qc-picker-model-btn',
                        can_focus: true,
                        reactive: true,
                        track_hover: true,
                        x_expand: true,
                        x_align: Clutter.ActorAlign.FILL,
                        accessible_name: lbl,
                        child: modelLbl,
                    });
                    mBtn.connect('clicked', () => {
                        this._registry.updateBackendProfile(
                            eff,
                            {provider: entry.providerId, model: entry.modelId},
                            {recordRecent: true}
                        );
                        this.toggle(false);
                    });
                    cell.add_child(mBtn);

                    const starBtn = this._createIconBtn(
                        entry.isFavorite ? 'starred-symbolic' : 'non-starred-symbolic',
                        () => {
                            this._toggleFavoriteModel(entry.key);
                            renderResultsSection();
                        },
                        entry.isFavorite ? '取消收藏该模型' : '收藏该模型（置顶显示）',
                        entry.isFavorite ? 'qc-picker-star-btn qc-picker-star-active' : 'qc-picker-star-btn'
                    );
                    starBtn.y_align = Clutter.ActorAlign.CENTER;
                    cell.add_child(starBtn);
                    resultsSection.add_child(cell);
                }

                if (ranked.totalPages > 1) {
                    const pageRow = new St.BoxLayout({
                        orientation: H,
                        style_class: 'qc-picker-row',
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    const prevBtn = createStButton('‹ 上页', () => {
                        if (ranked.hasPrevPage) {
                            this.page = ranked.page - 1;
                            renderResultsSection();
                        }
                    }, 'qc-picker-chip', '上一页模型');
                    prevBtn.reactive = ranked.hasPrevPage;

                    const pageInfo = new St.Label({
                        text: `${ranked.page + 1} / ${ranked.totalPages}（共 ${ranked.totalFiltered} 项）`,
                        style_class: 'qc-picker-page-label',
                        x_expand: true,
                        x_align: Clutter.ActorAlign.CENTER,
                        y_align: Clutter.ActorAlign.CENTER,
                    });

                    const nextBtn = createStButton('下页 ›', () => {
                        if (ranked.hasNextPage) {
                            this.page = ranked.page + 1;
                            renderResultsSection();
                        }
                    }, 'qc-picker-chip', '下一页模型');
                    nextBtn.reactive = ranked.hasNextPage;

                    pageRow.add_child(prevBtn);
                    pageRow.add_child(pageInfo);
                    pageRow.add_child(nextBtn);
                    paginationBox.add_child(pageRow);
                }
            } else {
                const emptyText = eff === 'unconfigured'
                    ? '未检测到可用引擎：请安装 ZCode / Codex CLI，或点击右上角设置图标配置 OpenAI API。'
                    : this.query.trim()
                        ? (eff === 'openai'
                            ? `无匹配缓存模型，可直接按回车使用「${this.query.trim()}」`
                            : `未找到匹配「${this.query.trim()}」的模型`)
                        : this._refreshing
                            ? '正在后台异步加载模型目录…'
                            : eff === 'openai'
                                ? `当前生效模型：${liveState.activeModelId || '自动发现'}（点击右上角刷新图标可在线拉取列表）`
                                : eff === 'zcode'
                                    ? 'ZCode 本地配置中没有可选模型。'
                                    : '未检测到预设模型列表，将使用后端默认模型。';
                resultsSection.add_child(createWrapLabel(emptyText, 'qc-picker-empty'));
            }
            renderFooterRow(liveState);
        };

        this._renderResultsFn = renderResultsSection;
        const initialPeek = peekCachedBackendCatalog(effectiveBackend);
        if (
            effectiveBackend !== 'unconfigured' &&
            effectiveBackend !== 'openai' &&
            (effectiveBackend === 'zcode' || !initialPeek.fromCache || initialPeek.stale)
        ) {
            this._refreshCatalogInBackground(effectiveBackend, effectiveBackend === 'zcode');
        }
        renderResultsSection();

        this.container.add_child(footerRow);
    }

    dispose() {
        const wasOpen = this.isOpen;
        ++this._bgGen;
        try { this._activeCancellable?.cancel?.(); } catch (_) {}
        this._activeCancellable = null;
        this._renderResultsFn = null;
        this.container = null;
        this.chevronLabel = null;
        this.isOpen = false;
        if (wasOpen) this._onToggle?.(false);
        this._onToggle = null;
    }
}
