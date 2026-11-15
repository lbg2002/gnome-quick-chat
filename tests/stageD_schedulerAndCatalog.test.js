import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    HistoryWindowController,
    UI_BUFFER_CAPS,
    appendBoundedInMemoryText,
    computeAdaptiveRenderDelayMs,
    computeToolDotVisualState,
    formatDisplayBufferWithCap,
    formatMessageTimestamp,
    partitionToolDotsForLayout,
    resolveAssistantDisplayModel,
} from '../core/renderScheduler.js';
import {
    ExpiringResourceCache,
    filterAndRankModels,
    flattenCatalogModelEntries,
    makeModelEntryKey,
    recordRecentModelKey,
    sanitizeProviderCatalogSecrets,
    toggleFavoriteModelKey,
} from '../core/modelCatalogCache.js';
import {prepareZCodeConfigOverrideAsync} from '../runtime/cliProcessRunner.js';

test('D2: computeAdaptiveRenderDelayMs delivers immediate first token & urgent approval, and throttles under load', () => {
    assert.equal(
        computeAdaptiveRenderDelayMs({isFirstVisibleRender: true, textLength: 12, lastRenderDurationMs: 0}),
        0,
        'First visible token must render immediately'
    );
    assert.equal(
        computeAdaptiveRenderDelayMs({urgentImmediate: true, textLength: 9000, lastRenderDurationMs: 18}),
        0,
        'Pending approval / terminal status must flush immediately'
    );

    const normalMs = computeAdaptiveRenderDelayMs({textLength: 500, lastRenderDurationMs: 1.5});
    assert.ok(normalMs >= 50 && normalMs <= 100, `Normal visible batching should be 50-100ms, got ${normalMs}`);

    const mediumMs = computeAdaptiveRenderDelayMs({textLength: 3500, lastRenderDurationMs: 4});
    assert.ok(mediumMs >= 80 && mediumMs <= 120);

    const heavyMs = computeAdaptiveRenderDelayMs({textLength: 15000, lastRenderDurationMs: 15});
    assert.ok(heavyMs >= 100 && heavyMs <= 200, `High-load batching should be 100-200ms, got ${heavyMs}`);
});

test('D2: computeToolDotVisualState & partitionToolDotsForLayout diff style keys and fold horizontal overflow safely', () => {
    const runningVis = computeToolDotVisualState({id: 't1', status: 'running'}, null);
    assert.equal(runningVis.colorClass, 'qc-dot-tool-running');
    assert.equal(runningVis.isSelected, false);

    const pendingSelVis = computeToolDotVisualState({id: 't1', status: 'pending_approval'}, 't1');
    assert.equal(pendingSelVis.colorClass, 'qc-dot-tool-pending');
    assert.equal(pendingSelVis.isSelected, true);
    assert.notEqual(runningVis.styleKey, pendingSelVis.styleKey);

    const interruptedVis = computeToolDotVisualState({id: 't2', status: 'interrupted'}, null);
    assert.equal(interruptedVis.colorClass, 'qc-dot-tool-interrupted');

    // 25 tools where tool #2 failed, tool #4 awaits approval, and tool #6 is selected by user
    const manyTools = Array.from({length: 25}, (_, i) => ({
        id: `tool_${i + 1}`,
        status: i === 1 ? 'error' : i === 3 ? 'pending_approval' : i === 24 ? 'running' : 'done',
    }));

    const folded = partitionToolDotsForLayout(manyTools, {
        maxVisibleDots: 10,
        expanded: false,
        selectedNodeId: 'tool_6',
    });
    assert.equal(folded.isFolded, true);
    assert.ok(folded.foldedCount >= 14);
    assert.equal(folded.visibleIds.has('tool_2'), true, 'Error dot must stay pinned visible');
    assert.equal(folded.visibleIds.has('tool_4'), true, 'Pending approval dot must stay pinned visible');
    assert.equal(folded.visibleIds.has('tool_6'), true, 'Selected dot must stay pinned visible');
    assert.equal(folded.visibleIds.has('tool_25'), true, 'Latest running dot must stay visible');

    const unfolded = partitionToolDotsForLayout(manyTools, {
        maxVisibleDots: 10,
        expanded: true,
        selectedNodeId: 'tool_6',
    });
    assert.equal(unfolded.isFolded, false);
    assert.equal(unfolded.visibleIds.size, 25);
});

test('D2: formatDisplayBufferWithCap caps huge UTF-8 buffers for UI while preserving full text on expand', () => {
    const hugeThinking = '深度推理步骤：验证多字节中文字符边界。\n'.repeat(1200);
    const capped = formatDisplayBufferWithCap(hugeThinking, {
        maxDisplayBytes: 4096,
        expanded: false,
    });
    assert.equal(capped.isTruncatedForUi, true);
    assert.ok(capped.displayText.length < hugeThinking.length);
    assert.ok(capped.displayText.includes('UI 仅展示摘要'));

    const expanded = formatDisplayBufferWithCap(hugeThinking, {
        maxDisplayBytes: 4096,
        expanded: true,
    });
    assert.equal(expanded.isTruncatedForUi, false);
    assert.equal(expanded.displayText, hugeThinking);

    const bounded = appendBoundedInMemoryText('abc', 'def', 5);
    assert.ok(bounded.startsWith('abcde'));
    assert.ok(bounded.includes('内存缓冲已达安全上限'));
    assert.ok(UI_BUFFER_CAPS.maxThinkingDisplayBytes >= 8192);
});

test('D3: HistoryWindowController fixes prepend order inversion, recycles Actors beyond window, and binds retry via replyTo', () => {
    const win = new HistoryWindowController({
        initialPageSize: 24,
        pageSize: 24,
        maxMountedActors: 48,
    });

    // Build 60 chronological messages (30 turns: user_0, asst_0, user_1, asst_1, ..., user_29, asst_29)
    const history = [];
    for (let turn = 0; turn < 30; turn++) {
        const uId = `u_${turn}`;
        const aId = `a_${turn}`;
        history.push({
            id: uId,
            role: 'user',
            text: `问题 #${turn}`,
            ts: 1700000000000 + turn * 60000,
        });
        history.push({
            id: aId,
            replyTo: uId,
            role: 'assistant',
            text: `回答 #${turn}`,
            modelId: turn < 15 ? 'glm-4.5' : 'gpt-5-mini',
            ts: 1700000005000 + turn * 60000,
        });
    }

    // 1. Initial render mounts latest 24 messages (indices 36..59 => turn 18..29)
    const init = win.reset(history);
    assert.equal(init.initialSlice.length, 24);
    assert.equal(init.windowStart, 36);
    assert.equal(init.windowEnd, 60);

    const mkCard = msg => ({
        messageId: msg.id,
        replyTo: msg.replyTo || '',
        role: msg.role,
        text: msg.text,
        modelId: msg.modelId || '',
    });
    win.registerMountedInitialCards(init.initialSlice.map(mkCard));
    assert.equal(win.mountedCards.length, 24);
    assert.equal(win.hasOlder, true);
    assert.equal(win.hasNewer, false);

    // 2. First prepend batch (indices 12..35): total mounted reaches 48, strictly chronological!
    const batch1 = win.planPrependOlderBatch();
    assert.equal(batch1.slice.length, 24);
    assert.equal(batch1.evictBottomCount, 0);
    const evicted1 = win.commitPrependedBatch(batch1.slice.map(mkCard), batch1.newWindowStart, batch1.evictBottomCount);
    assert.equal(evicted1.length, 0);
    assert.equal(win.mountedCards.length, 48);
    assert.equal(win.mountedCards[0].messageId, 'u_6');
    assert.equal(win.mountedCards[1].messageId, 'a_6');
    assert.equal(win.mountedCards[23].messageId, 'a_17');
    assert.equal(win.mountedCards[24].messageId, 'u_18');
    assert.equal(win.mountedCards[47].messageId, 'a_29');

    // Verify retry on `a_6` (prepended!) finds `问题 #6` — NOT a reversed card!
    assert.equal(win.findRetryPromptForCard(win.mountedCards[1]), '问题 #6');

    // 3. Second prepend batch (indices 0..11, 12 messages): exceeds 48 -> recycles 12 bottom Actors!
    const batch2 = win.planPrependOlderBatch();
    assert.equal(batch2.slice.length, 12);
    assert.equal(batch2.evictBottomCount, 12);
    const evicted2 = win.commitPrependedBatch(batch2.slice.map(mkCard), batch2.newWindowStart, batch2.evictBottomCount);
    assert.equal(evicted2.length, 12);
    assert.equal(win.mountedCards.length, 48, 'Mounted Actor count must stay capped at 48');
    assert.equal(win.hasOlder, false);
    assert.equal(win.hasNewer, true);
    assert.equal(win.newerRemainingCount, 12);
    assert.equal(win.mountedCards[0].messageId, 'u_0');
    assert.equal(win.mountedCards[47].messageId, 'a_23');
    assert.equal(win.allMessages.length, 60, 'Full session history in memory must never lose evicted items');

    // 4. Reset to latest window & append new runtime messages past 48 -> recycles top Actors!
    const reset2 = win.reset(win.allMessages);
    win.registerMountedInitialCards(reset2.initialSlice.map(mkCard));
    let totalRecycledTop = 0;
    for (let extra = 30; extra < 45; extra++) {
        const uRec = {id: `u_${extra}`, role: 'user', text: `新问题 #${extra}`};
        const aRec = {id: `a_${extra}`, replyTo: `u_${extra}`, role: 'assistant', text: `新回答 #${extra}`};
        const r1 = win.appendRuntimeCard(uRec, mkCard(uRec), {allowRecycleTop: true});
        const r2 = win.appendRuntimeCard(aRec, mkCard(aRec), {allowRecycleTop: true});
        totalRecycledTop += r1.evictedTopCards.length + r2.evictedTopCards.length;
    }
    assert.equal(win.mountedCards.length, 48);
    assert.equal(totalRecycledTop, 6, '24 initial + 30 appended = 54 -> 6 oldest top Actors recycled');

    // Even if `u_0` is NOT in `mountedCards`, `findRetryPromptForCard` resolves via `replyTo` in `allMessages`!
    assert.equal(
        win.findRetryPromptForCard({messageId: 'a_0', replyTo: 'u_0', role: 'assistant'}),
        '问题 #0'
    );
});

test('D3: formatMessageTimestamp & resolveAssistantDisplayModel preserve real historical time and modelId', () => {
    const fixedNow = new Date(2026, 10, 15, 16, 30, 0).getTime(); // 2026-11-15 16:30 local
    const sameDay = new Date(2026, 10, 15, 9, 5, 0).getTime();
    const earlierMonth = new Date(2026, 9, 3, 21, 18, 0).getTime();
    const prevYear = new Date(2025, 4, 20, 8, 0, 0).getTime();

    assert.equal(formatMessageTimestamp({ts: sameDay}, fixedNow), '09:05');
    assert.equal(formatMessageTimestamp({ts: earlierMonth}, fixedNow), '10-03 21:18');
    assert.equal(formatMessageTimestamp({createdAt: new Date(prevYear).toISOString()}, fixedNow), '2025-05-20 08:00');

    assert.equal(resolveAssistantDisplayModel({modelId: 'claude-sonnet-4-5', backend: 'zcode'}, 'gpt-5'), 'claude-sonnet-4-5');
    assert.equal(resolveAssistantDisplayModel({modelId: '', backend: 'codex'}, 'gpt-5'), 'Codex');
    assert.equal(resolveAssistantDisplayModel({}, 'deepseek-chat'), 'deepseek-chat');
});

test('D4: ExpiringResourceCache single-flight async load, invalidation, secret scrubbing, and 75-model search/favorites/pagination', async () => {
    let fakeNow = 1000;
    let loaderCalls = 0;
    const cache = new ExpiringResourceCache({defaultTtlMs: 5000, nowFn: () => fakeNow});

    assert.equal(cache.peek('zcode').hit, false);

    // Concurrent callers share one single-flight Promise
    const [resA, resB] = await Promise.all([
        cache.getOrLoadAsync('zcode', async () => {
            loaderCalls++;
            await new Promise(r => setTimeout(r, 15));
            return {version: 1};
        }),
        cache.getOrLoadAsync('zcode', async () => {
            loaderCalls++;
            return {version: 2};
        }),
    ]);
    assert.equal(loaderCalls, 1);
    assert.deepEqual(resA, {version: 1});
    assert.deepEqual(resB, {version: 1});
    assert.equal(cache.peek('zcode').hit, true);
    assert.equal(cache.peek('zcode').stale, false);

    fakeNow += 6000;
    assert.equal(cache.peek('zcode').stale, true);

    cache.invalidate('zcode');
    assert.equal(cache.peek('zcode').hit, false);

    // Secret scrubbing on provider catalogs
    const dirtyCatalog = {
        backendLabel: 'ZCode CLI',
        defaultProviderId: 'custom_1',
        defaultModelId: 'glm-4.6',
        providers: [
            {
                id: 'custom_1',
                name: '智谱 OpenAI',
                baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
                apiKey: 'sk-SUPER-SECRET-DO-NOT-CACHE',
                models: ['glm-4.6', 'glm-4.5-air'],
            },
        ],
    };
    const scrubbed = sanitizeProviderCatalogSecrets(dirtyCatalog);
    assert.equal(scrubbed.providers[0].apiKey, '');
    assert.equal(JSON.stringify(scrubbed).includes('SUPER-SECRET'), false);

    // 75-model catalog: search, favorites, recent ranking, and pagination beyond first 10!
    const providers = [
        {
            id: 'openai',
            name: 'OpenAI',
            models: Array.from({length: 40}, (_, i) => `gpt-model-${String(i + 1).padStart(2, '0')}`),
        },
        {
            id: 'deepseek',
            name: 'DeepSeek',
            models: Array.from({length: 35}, (_, i) => `deepseek-reasoner-${String(i + 1).padStart(2, '0')}`),
        },
    ];
    const entries = flattenCatalogModelEntries({providers}, {backend: 'zcode'});
    assert.equal(entries.length, 75);

    let favs = [];
    const targetFavKey = makeModelEntryKey('zcode', 'deepseek', 'deepseek-reasoner-33');
    favs = toggleFavoriteModelKey(favs, targetFavKey);
    assert.deepEqual(favs, [targetFavKey]);
    assert.deepEqual(toggleFavoriteModelKey(favs, targetFavKey), []);
    let recents = recordRecentModelKey([], makeModelEntryKey('zcode', 'openai', 'gpt-model-28'));

    const page0 = filterAndRankModels(entries, {
        query: '',
        favoriteKeys: favs,
        recentKeys: recents,
        selectedProviderId: 'openai',
        selectedModelId: 'gpt-model-15',
        page: 0,
        pageSize: 8,
    });
    assert.equal(page0.totalCount, 75);
    assert.equal(page0.totalPages, 10);
    assert.equal(page0.items[0].modelId, 'deepseek-reasoner-33', 'Favorite model ranks #1');
    assert.equal(page0.items[1].modelId, 'gpt-model-15', 'Selected active model ranks #2');
    assert.equal(page0.items[2].modelId, 'gpt-model-28', 'Recent model ranks #3');

    // Last page (page 9) reaches models #73..#75 — never inaccessible!
    const lastPage = filterAndRankModels(entries, {
        query: '',
        favoriteKeys: favs,
        recentKeys: recents,
        page: 9,
        pageSize: 8,
    });
    assert.equal(lastPage.page, 9);
    assert.equal(lastPage.items.length, 3);

    // Multi-token search filters accurately
    const searched = filterAndRankModels(entries, {
        query: 'deepseek 33',
        favoriteKeys: favs,
        page: 0,
        pageSize: 8,
    });
    assert.equal(searched.totalFiltered, 1);
    assert.equal(searched.items[0].modelId, 'deepseek-reasoner-33');
});

test('D4: prepareZCodeConfigOverrideAsync writes verified async override and enforces 4 MiB ceiling', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-stage-d-zcode-'));
    try {
        const zcodeDir = path.join(tmpRoot, '.zcode', 'v2');
        const runtimeDir = path.join(tmpRoot, 'runtime');
        await fs.mkdir(zcodeDir, {recursive: true, mode: 0o700});
        await fs.mkdir(runtimeDir, {recursive: true, mode: 0o700});

        const personalPath = path.join(zcodeDir, 'provider_config.json');
        await fs.writeFile(
            personalPath,
            JSON.stringify({
                version: 2,
                config: {
                    defaultModelSelection: {providerId: 'zhipu', modelId: 'glm-4.5'},
                    providerOrder: ['zhipu'],
                    providerConfigRules: {
                        providerRules: [
                            {
                                providerId: 'zhipu',
                                providerName: 'Zhipu',
                                config: {
                                    enabled: true,
                                    modelOrder: ['glm-4.5', 'glm-4.6'],
                                    personalModelIds: ['glm-4.5', 'glm-4.6'],
                                },
                            },
                        ],
                    },
                },
            }),
            {mode: 0o600}
        );

        const asyncIo = {
            homeDir: tmpRoot,
            getRuntimeDir: () => runtimeDir,
            makeUuid: () => '11111111-2222-3333-4444-555555555555',
            fileExistsAsync: async p => {
                try {
                    await fs.stat(p);
                    return true;
                } catch (_) {
                    return false;
                }
            },
            readJsonAsync: async (p, {maxBytes}) => {
                const st = await fs.stat(p);
                if (st.size > maxBytes) return null;
                return JSON.parse(await fs.readFile(p, 'utf8'));
            },
            writePrivateFileAsync: async (p, bytes) => {
                await fs.writeFile(p, bytes, {mode: 0o600});
            },
            removeFile: async p => {
                await fs.rm(p, {force: true});
            },
        };

        const res = await prepareZCodeConfigOverrideAsync(
            {provider: 'zhipu', model: 'glm-4.6', reasoningEffort: 'high'},
            asyncIo
        );
        assert.equal(res.resolvedProvider, 'zhipu');
        assert.equal(res.resolvedModel, 'glm-4.6');
        assert.ok(res.tempFilePath.endsWith('zcode-provider-11111111-2222-3333-4444-555555555555.json'));
        const st = await fs.stat(res.tempFilePath);
        assert.equal(st.mode & 0o777, 0o600);

        // Verify oversized (>4 MiB) personal config is safely rejected instead of parsed blindly
        const hugePad = 'x'.repeat(4 * 1024 * 1024 + 512);
        await fs.writeFile(personalPath, JSON.stringify({pad: hugePad}), {mode: 0o600});
        await assert.rejects(
            () => prepareZCodeConfigOverrideAsync({provider: 'zhipu', model: 'glm-4.6'}, asyncIo),
            /解析 ZCode 个人模型配置文件失败/
        );
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});
