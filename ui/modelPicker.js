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
        onNudgeLayout,
        onOpenPreferences,
    }) {
        this._settings = settings;
        this._registry = registry;
        this._getEffectiveBackend = getEffectiveBackend;
        this._getAvailableBackends = getAvailableBackends;
        this._getActiveRuntimeInfo = getActiveRuntimeInfo;
        this._getClient = getClient;
        this._isExtensionAlive = isExtensionAlive;
        this._onNudgeLayout = onNudgeLayout;
        this._onOpenPreferences = onOpenPreferences;

        this.container = null;
        this.chevronLabel = null;
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

    attachActors(containerBox, chevronLabel) {
        this.container = containerBox;
        this.chevronLabel = chevronLabel;
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
            this.chevronLabel.text = nextOpen ? '▴' : '▾';
        }
        if (!nextOpen) {
            this.container.visible = false;
            this._onNudgeLayout?.();
            return;
        }
        this.populate();
        this.container.visible = true;
        this._onNudgeLayout?.();
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
                forceRefresh, dshPath: this._getString('dsh-path', ''),
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
        const catalog = peekCachedBackendCatalog(effectiveBackend);
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

        const backendRow = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-picker-row',
            y_align: Clutter.ActorAlign.CENTER,
        });
        backendRow.add_child(new St.Label({
            text: '引擎:',
            style_class: 'qc-picker-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        for (const item of pickerState.backendChips) {
            backendRow.add_child(createStButton(
                item.displayLabel,
                () => {
                    this.page = 0;
                    // Fast switch updates backend profile/selection without resetting composer draft or attachments (R11.1)
                    this._registry.selectBackend(item.id, {clearMigrationNotice: true});
                    this.populate();
                },
                item.active ? 'qc-picker-chip qc-picker-chip-active' : 'qc-picker-chip',
                item.statusTag ? `${item.label}（${item.statusTag}）` : `切换到 ${item.label}`
            ));
        }
        backendRow.add_child(new St.Widget({x_expand: true}));
        if (effectiveBackend !== 'unconfigured') {
            backendRow.add_child(createStButton(
                '↻',
                () => {
                    invalidateBackendDetectionCaches('catalog');
                    this._refreshCatalogInBackground(effectiveBackend, true);
                    this._renderResultsFn?.();
                },
                'qc-picker-chip',
                '后台异步刷新模型目录'
            ));
        }
        this.container.add_child(backendRow);

        const summaryText = [pickerState.currentModelSummary, pickerState.capabilityNotice]
            .filter(Boolean)
            .join(' · ');
        if (summaryText) {
            this.container.add_child(createWrapLabel(summaryText, 'qc-mini-label'));
        }

        if (effectiveBackend !== 'unconfigured') {
            const searchEntry = new St.Entry({
                style_class: 'qc-picker-search',
                hint_text: effectiveBackend === 'openai'
                    ? '搜索已缓存模型，或输入自定义模型 ID 按回车切换…'
                    : '搜索模型或 Provider（★ 收藏 · 近期使用优先展示）…',
                can_focus: true,
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

        const resultsSection = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-picker-models',
            x_expand: true,
        });
        this.container.add_child(resultsSection);

        const footerRow = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-picker-row',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const renderFooterRow = stateForFooter => {
            footerRow.destroy_all_children();
            const eff = stateForFooter.effectiveBackend;
            const thinkingSupport = stateForFooter.thinkingSupport;
            footerRow.add_child(new St.Label({
                text: '思考:',
                style_class: 'qc-picker-label',
                y_align: Clutter.ActorAlign.CENTER,
            }));

            if (!thinkingSupport.supported) {
                footerRow.add_child(createWrapLabel(
                    thinkingSupport.reason || '当前模型不支持思考强度调节',
                    'qc-mini-label'
                ));
            } else {
                const curEffort = this._registry.getBackendProfile(eff).reasoningEffort || 'default';
                for (const ef of [
                    {id: 'default', label: '默认'},
                    {id: 'fast', label: '快'},
                    {id: 'standard', label: '标准'},
                    {id: 'deep', label: '深入'},
                ]) {
                    footerRow.add_child(createStButton(
                        ef.label,
                        () => {
                            if (eff !== 'unconfigured') {
                                this._registry.updateBackendProfile(eff, {reasoningEffort: ef.id});
                            }
                            this.populate();
                        },
                        curEffort === ef.id ? 'qc-picker-chip qc-picker-chip-active' : 'qc-picker-chip',
                        `思考强度：${ef.label}`
                    ));
                }
            }
            footerRow.add_child(new St.Widget({x_expand: true}));
            footerRow.add_child(createStButton('更多设置…', () => {
                this.toggle(false);
                this._onOpenPreferences?.();
            }, 'qc-picker-chip', '打开完整设置页面'));
        };

        const renderResultsSection = () => {
            if (!resultsSection.get_parent()) return;
            resultsSection.destroy_all_children();

            const liveState = this._buildCurrentPickerState();
            const eff = liveState.effectiveBackend;
            const catalog = peekCachedBackendCatalog(eff);
            const ranked = liveState.ranked;
            this.page = ranked.page;

            if (ranked.items.length > 0) {
                for (let i = 0; i < ranked.items.length; i += 2) {
                    const line = new St.BoxLayout({orientation: H, style_class: 'qc-picker-row', x_expand: true});
                    for (const entry of ranked.items.slice(i, i + 2)) {
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
                        const mBtn = createStButton(
                            lbl,
                            () => {
                                this._registry.updateBackendProfile(
                                    eff,
                                    {provider: entry.providerId, model: entry.modelId},
                                    {recordRecent: true}
                                );
                                this.toggle(false);
                            },
                            entry.isSelected ? 'qc-picker-model-btn qc-picker-chip-active' : 'qc-picker-model-btn',
                            lbl
                        );
                        mBtn.x_expand = true;
                        cell.add_child(mBtn);

                        const starBtn = createStButton(
                            entry.isFavorite ? '★' : '☆',
                            () => {
                                this._toggleFavoriteModel(entry.key);
                                renderResultsSection();
                            },
                            entry.isFavorite ? 'qc-picker-star-btn qc-picker-star-active' : 'qc-picker-star-btn',
                            entry.isFavorite ? '取消收藏该模型' : '收藏该模型（置顶显示）'
                        );
                        cell.add_child(starBtn);
                        line.add_child(cell);
                    }
                    resultsSection.add_child(line);
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
                    resultsSection.add_child(pageRow);
                }
            } else {
                const emptyText = eff === 'unconfigured'
                    ? '未检测到可用引擎：请安装 ZCode / Codex CLI，或点击下方「更多设置…」配置 OpenAI API。'
                    : this.query.trim()
                        ? (eff === 'openai'
                            ? `无匹配缓存模型，可直接按回车使用「${this.query.trim()}」`
                            : `未找到匹配「${this.query.trim()}」的模型`)
                        : this._refreshing
                            ? '正在后台异步加载模型目录…'
                            : eff === 'openai'
                                ? `当前生效模型：${liveState.activeModelId || '自动发现'}（点击右上角 ↻ 可在线拉取列表）`
                                : '未检测到预设模型列表，将使用后端默认模型。';
                resultsSection.add_child(createWrapLabel(emptyText, 'qc-picker-empty'));
            }
            renderFooterRow(liveState);
            this._onNudgeLayout?.();
        };

        this._renderResultsFn = renderResultsSection;
        renderResultsSection();

        const initialPeek = peekCachedBackendCatalog(effectiveBackend);
        if (
            effectiveBackend !== 'unconfigured' &&
            effectiveBackend !== 'openai' &&
            (!initialPeek.fromCache || initialPeek.stale)
        ) {
            this._refreshCatalogInBackground(effectiveBackend, false);
        }

        this.container.add_child(footerRow);
    }

    dispose() {
        ++this._bgGen;
        try { this._activeCancellable?.cancel?.(); } catch (_) {}
        this._activeCancellable = null;
        this._renderResultsFn = null;
        this.container = null;
        this.chevronLabel = null;
        this.isOpen = false;
    }
}
