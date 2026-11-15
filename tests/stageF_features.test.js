import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BUILTIN_SLASH_COMMANDS,
    DEFAULT_QUICK_PROMPTS,
    MAX_CUSTOM_QUICK_PROMPTS,
    applyQuickActionToDraft,
    getCombinedSlashCommands,
    matchSlashCommands,
    parseQuickPromptsConfig,
    serializeQuickPromptsConfig,
} from '../core/quickActions.js';

import {
    AttachmentManager,
    MAX_ATTACHMENT_FILE_BYTES,
    MAX_ATTACHMENTS_COUNT,
    MAX_TOTAL_ATTACHMENTS_BYTES,
    classifyTextSnippet,
    detectBinaryFile,
    extractCopiedFilePaths,
    stripAnsiEscapes,
} from '../core/attachmentManager.js';

import {
    SessionStoreEngine,
    buildContinuationPrompt,
    deleteSessionDirectoryWithIo,
    exportSessionFormatted,
    inspectSessionsWithIo,
    planSessionRetentionCleanup,
    resolvePreviousSessionId,
} from '../core/sessionEngine.js';

import {HistoryWindowController} from '../core/renderScheduler.js';

import {
    BackgroundNotificationGate,
    resolveNotificationClickTarget,
} from '../core/notificationPolicy.js';

import {
    clampSafeRecommendedMode,
    classifyPromptIntentLocally,
    recommendRouteLocally,
} from '../core/modelRouter.js';

import {
    formatCapabilitiesLine,
    formatRedactedDiagnosticsText,
    parseStoredDiagnosticSnapshot,
    sanitizeDiagnosticSnapshot,
} from '../core/diagnosticsReport.js';

function createMemorySessionIo() {
    const files = new Map();
    const dirs = new Set(['/mock/sessions']);

    const ensureParentDir = filePath => {
        const idx = filePath.lastIndexOf('/');
        if (idx > 0) dirs.add(filePath.slice(0, idx));
    };

    return {
        files,
        dirs,
        async exists(p) {
            return files.has(p) || dirs.has(p);
        },
        async readText(p) {
            if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
            return files.get(p);
        },
        async replaceFile(p, content) {
            ensureParentDir(p);
            files.set(p, String(content));
        },
        async appendLine(p, text) {
            ensureParentDir(p);
            const prev = files.get(p) || '';
            const suffix = String(text).endsWith('\n') ? String(text) : `${text}\n`;
            files.set(p, prev + suffix);
        },
        async listDir(dirPath) {
            const prefix = `${dirPath.replace(/\/+$/, '')}/`;
            const seen = new Map();
            for (const d of dirs) {
                if (d.startsWith(prefix)) {
                    const rest = d.slice(prefix.length);
                    const seg = rest.split('/')[0];
                    if (seg && !seen.has(seg)) {
                        seen.set(seg, {name: seg, isDir: true, isSymlink: false});
                    }
                }
            }
            for (const f of files.keys()) {
                if (f.startsWith(prefix)) {
                    const rest = f.slice(prefix.length);
                    if (!rest.includes('/')) {
                        seen.set(rest, {name: rest, isDir: false, isSymlink: false});
                    }
                }
            }
            return Array.from(seen.values());
        },
        async statMtimeMs() {
            return 1700000000000;
        },
        async unlink(p) {
            files.delete(p);
        },
        async rmdir(d) {
            dirs.delete(d);
        },
    };
}

// =============================================================================
// F1: Quick Actions, Editable Templates & `/` Slash Commands
// =============================================================================

test('F1: parseQuickPromptsConfig safely falls back on empty/malformed JSON and caps custom templates', () => {
    const def1 = parseQuickPromptsConfig('');
    assert.equal(def1.length, DEFAULT_QUICK_PROMPTS.length);
    assert.equal(def1[0].slash, '/explain');

    const def2 = parseQuickPromptsConfig('{broken json');
    assert.equal(def2.length, DEFAULT_QUICK_PROMPTS.length);

    const many = Array.from({length: 20}, (_, i) => ({
        label: `模板 ${i + 1}`,
        prompt: `Prompt ${i + 1}\n`,
        slash: `cmd${i + 1}`,
    }));
    const raw = serializeQuickPromptsConfig(many);
    const parsed = parseQuickPromptsConfig(raw);
    assert.equal(parsed.length, MAX_CUSTOM_QUICK_PROMPTS);
    assert.equal(parsed[0].slash, '/cmd1');
});

test('F1: matchSlashCommands matches all 7 built-in commands & Chinese aliases while ignoring Unix file paths', () => {
    assert.equal(BUILTIN_SLASH_COMMANDS.length, 7);
    const expectedCommands = ['/explain', '/translate', '/polish', '/summarize', '/review', '/error', '/academic'];
    for (const cmd of expectedCommands) {
        const res = matchSlashCommands(cmd);
        assert.equal(res.active, true, `Expected ${cmd} to activate slash completion`);
        assert.equal(res.matches[0].command, cmd);
    }

    // Chinese aliases
    assert.equal(matchSlashCommands('/翻译 Hello').matches[0].command, '/translate');
    assert.equal(matchSlashCommands('/报错分析').matches[0].command, '/error');
    assert.equal(matchSlashCommands('/学术润色').matches[0].command, '/academic');
    assert.equal(matchSlashCommands('/代码检查').matches[0].command, '/review');

    // Unix paths MUST NOT be hijacked as slash commands
    assert.equal(matchSlashCommands('/etc/hosts').active, false);
    assert.equal(matchSlashCommands('/home/user/project/src/index.js').active, false);

    // Custom slash command & override
    const custom = [
        {label: 'SQL 优化', prompt: '请优化以下 SQL 查询：\n', slash: '/sql'},
        {label: '精简润色', prompt: '请极简润色：\n', slash: '/polish'},
    ];
    const combined = getCombinedSlashCommands(custom);
    assert.ok(combined.some(c => c.command === '/sql' && c.isCustom));
    assert.equal(combined.find(c => c.command === '/polish')?.template, '请极简润色：\n');

    // Ctrl+/ forceOpen works even when draft has non-slash text
    const forced = matchSlashCommands('已有草稿内容', custom, {forceOpen: true});
    assert.equal(forced.active, true);
    assert.ok(forced.matches.length >= 8);
});

test('F1: applyQuickActionToDraft NEVER auto-sends and preserves trailing/existing user draft text', () => {
    // Even a prompt without trailing newline (like ubuntu_tips) MUST have autoSend === false!
    const tipsAction = DEFAULT_QUICK_PROMPTS.find(p => p.id === 'ubuntu_tips');
    const appliedTips = applyQuickActionToDraft(tipsAction, '');
    assert.equal(appliedTips.autoSend, false);
    assert.equal(appliedTips.text, tipsAction.prompt);

    // Slash prefix replacement preserves trailing argument text
    const trCmd = BUILTIN_SLASH_COMMANDS.find(c => c.command === '/translate');
    const appliedSlash = applyQuickActionToDraft(trCmd, '/tr Quick Chat is lightweight.');
    assert.equal(appliedSlash.autoSend, false);
    assert.ok(appliedSlash.text.startsWith(trCmd.template));
    assert.ok(appliedSlash.text.endsWith('Quick Chat is lightweight.'));

    // Applying a chip when user already wrote a draft prepends template instead of clobbering draft
    const reviewCmd = BUILTIN_SLASH_COMMANDS.find(c => c.command === '/review');
    const appliedExisting = applyQuickActionToDraft(reviewCmd, 'function add(a, b) { return a + b; }');
    assert.equal(appliedExisting.autoSend, false);
    assert.ok(appliedExisting.text.includes('function add(a, b)'));
    assert.ok(appliedExisting.text.startsWith(reviewCmd.template));
});

// =============================================================================
// F2: Context Attachments, File/Binary Limits & Outbound Scope Disclosure
// =============================================================================

test('F2: AttachmentManager preserves >4000-char clipboard snippets without truncation, deduplicates, and classifies logs', () => {
    const mgr = new AttachmentManager();
    const longText = 'Line of log data 0123456789\n'.repeat(400); // ~11,200 chars (> 4,000!)
    assert.ok(longText.length > 10000);

    const res1 = mgr.addTextSnippet(longText);
    assert.equal(res1.ok, true);
    assert.equal(res1.deduplicated, false);
    assert.equal(res1.item.content.length, longText.trim().length);

    // Exact duplicate snippet is deduplicated cleanly
    const resDup = mgr.addTextSnippet(longText);
    assert.equal(resDup.ok, true);
    assert.equal(resDup.deduplicated, true);
    assert.equal(mgr.count, 1);

    // ANSI terminal log snippet strips escape codes and classifies as `terminal_log`
    const ansiLog = '\x1b[31mError: ENOENT: no such file or directory\x1b[0m\n    at Object.openSync (node:fs:581:3)';
    assert.equal(stripAnsiEscapes(ansiLog).includes('\x1b['), false);
    const classified = classifyTextSnippet(ansiLog, {fromPrimarySelection: true});
    assert.equal(classified.kind, 'terminal_log');
    assert.equal(classified.sourceLabel, '终端选中日志');

    const res2 = mgr.addTextSnippet(ansiLog, {fromPrimarySelection: true});
    assert.equal(res2.ok, true);
    assert.equal(mgr.count, 2);

    // Compose payload keeps full content for model while keeping UI displayUserText concise
    const composed = mgr.composeTurnPayload('为什么这里报错了？');
    assert.equal(composed.hasAttachments, true);
    assert.ok(composed.promptForModel.includes(longText.trim()));
    assert.ok(composed.promptForModel.includes('Error: ENOENT'));
    assert.ok(composed.displayUserText.length < 500);
});

test('F2: extractCopiedFilePaths parses Nautilus copied URIs and rejects mixed prose', () => {
    const nautilusClip = 'copy\nfile:///home/alice/My%20Docs/notes.md\nfile:///tmp/demo.py';
    assert.deepEqual(extractCopiedFilePaths(nautilusClip), [
        '/home/alice/My Docs/notes.md',
        '/tmp/demo.py',
    ]);

    assert.deepEqual(extractCopiedFilePaths('请帮我看看 /etc/hosts 为什么无法解析'), []);
});

test('F2: binary files, NUL bytes, invalid UTF-8, directories, and oversized files safely downgrade to path-only', () => {
    assert.equal(detectBinaryFile(null, '/tmp/photo.png').isBinary, true);
    assert.equal(detectBinaryFile(new Uint8Array([0x48, 0x00, 0x69]), '/tmp/data.dat').isBinary, true);
    assert.equal(detectBinaryFile(new Uint8Array([0xff, 0xfe, 0xfd]), '/tmp/bad.txt').isBinary, true);

    const mgr = new AttachmentManager();

    // 1. Binary PNG -> automatic `file_path`
    const binRes = mgr.addFileCandidate({
        filePath: '/home/u/screen.png',
        fileSize: 2048,
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]),
    });
    assert.equal(binRes.ok, true);
    assert.equal(binRes.item.kind, 'file_path');
    assert.equal(binRes.item.isBinary, true);
    assert.equal(binRes.item.content, '');
    assert.equal(binRes.item.canToggleContent, false);

    // 2. Oversized file (> 128 KiB) -> automatic `file_path`
    const hugeRes = mgr.addFileCandidate({
        filePath: '/home/u/bundle.js',
        fileSize: MAX_ATTACHMENT_FILE_BYTES + 4096,
        tooLarge: true,
    });
    assert.equal(hugeRes.ok, true);
    assert.equal(hugeRes.item.kind, 'file_path');
    assert.ok(hugeRes.item.warning.includes('上限'));

    // 3. Valid UTF-8 source file -> `file_content` and can toggle to `file_path` and back
    const codeBytes = new TextEncoder().encode('export const answer = 42;\n');
    const textRes = mgr.addFileCandidate({
        filePath: '/home/u/answer.js',
        fileSize: codeBytes.byteLength,
        bytes: codeBytes,
    });
    assert.equal(textRes.ok, true);
    assert.equal(textRes.item.kind, 'file_content');
    assert.equal(mgr.toggleFileMode(textRes.item.id).mode, 'file_path');
    assert.equal(mgr.toggleFileMode(textRes.item.id).mode, 'file_content');

    // Outbound scope notice clearly names remote cloud host for OpenAI backend
    const cloudNotice = mgr.buildOutboundScopeNotice('openai', {
        endpointUrl: 'https://api.deepseek.com/v1',
    });
    assert.ok(cloudNotice.includes('api.deepseek.com'));
    assert.ok(cloudNotice.includes('文件正文'));
    assert.ok(cloudNotice.includes('文件路径'));

    // Enforces MAX_ATTACHMENTS_COUNT & MAX_TOTAL_ATTACHMENTS_BYTES
    const capMgr = new AttachmentManager({maxCount: MAX_ATTACHMENTS_COUNT, maxTotalBytes: MAX_TOTAL_ATTACHMENTS_BYTES});
    for (let i = 0; i < MAX_ATTACHMENTS_COUNT; i++) {
        assert.equal(capMgr.addTextSnippet(`snippet #${i}`).ok, true);
    }
    assert.equal(capMgr.addTextSnippet('overflow snippet').ok, false);
});

// =============================================================================
// F3: Message Operations (Regenerate, Continue, Edit Question, Export & Honest Rewind)
// =============================================================================

test('F3: SessionStoreEngine.rewindFromUserMessage rewinds history in-place and invalidates remoteSessionId honestly', async () => {
    const io = createMemorySessionIo();
    const store = new SessionStoreEngine('sess_f3_rewind', {
        sessionsRootDir: '/mock/sessions',
        io,
    });
    await store.load('zcode', {model: 'glm-5'});

    await store.appendMessage({id: 'u1', role: 'user', text: '第一问'}, 'zcode', {model: 'glm-5'});
    await store.appendMessage({id: 'a1', role: 'assistant', text: '第一答', replyTo: 'u1'}, 'zcode', {model: 'glm-5'});
    await store.setRemoteSessionId('zcode_remote_999', 'zcode', {model: 'glm-5'});
    await store.appendMessage({id: 'u2', role: 'user', text: '第二问'}, 'zcode', {model: 'glm-5'});
    await store.appendMessage({id: 'a2', role: 'assistant', text: '第二答（不满意）', replyTo: 'u2'}, 'zcode', {model: 'glm-5'});
    await store.appendMessage({id: 'u3', role: 'user', text: '第三问'}, 'zcode', {model: 'glm-5'});
    await store.flush();

    assert.equal(store.remoteSessionId, 'zcode_remote_999');
    assert.equal(store.messages.length, 5);

    // Rewind from assistant `a2` (resolves via `replyTo: 'u2'`)
    const rewind = store.rewindFromUserMessage('a2');
    assert.equal(rewind.ok, true);
    assert.equal(rewind.targetUserMessage.id, 'u2');
    assert.equal(rewind.removedMessages.length, 3); // u2, a2, u3
    assert.equal(rewind.remoteSessionReset, true);
    assert.equal(store.remoteSessionId, '');
    assert.deepEqual(store.messages.map(m => m.id), ['u1', 'a1']);

    await rewind.writePromise;

    // Reload from mock disk and verify persisted JSONL + meta match rewound state
    const reloaded = new SessionStoreEngine('sess_f3_rewind', {
        sessionsRootDir: '/mock/sessions',
        io,
    });
    await reloaded.load('zcode', {model: 'glm-5'});
    assert.deepEqual(reloaded.messages.map(m => m.id), ['u1', 'a1']);
    assert.equal(reloaded.remoteSessionId, '');
});

test('F3: HistoryWindowController supports in-place Regenerate without duplicating user message and Edit truncation', () => {
    const hw = new HistoryWindowController({initialPageSize: 24, maxMountedActors: 48});
    const msgs = [
        {id: 'u1', role: 'user', text: '问题1', createdAt: '10:00'},
        {id: 'a1', role: 'assistant', text: '回答1', replyTo: 'u1', createdAt: '10:00'},
        {id: 'u2', role: 'user', text: '问题2', createdAt: '10:05'},
        {id: 'a2', role: 'assistant', text: '回答2', replyTo: 'u2', createdAt: '10:05'},
    ];
    hw.reset(msgs);
    const cards = msgs.map(m => ({messageId: m.id, role: m.role, text: m.text, replyTo: m.replyTo || ''}));
    hw.registerMountedInitialCards(cards);

    const retryInfo = hw.findRetryTurnInfoForCard(cards[3]);
    assert.equal(retryInfo.userMessageId, 'u2');
    assert.equal(retryInfo.promptText, '问题2');

    // Regenerate keeps `u2` in UI (`keepStartMessage: true`) and removes only `a2`!
    const regenTrunc = hw.truncateFromMessageId('u2', {keepStartMessage: true});
    assert.equal(regenTrunc.truncated, true);
    assert.deepEqual(regenTrunc.removedCards.map(c => c.messageId), ['a2']);
    assert.deepEqual(hw.mountedCards.map(c => c.messageId), ['u1', 'a1', 'u2']);

    // Edit Question removes `u2` itself (`keepStartMessage: false`) so user can edit and re-send
    const editTrunc = hw.truncateFromMessageId('u2', {keepStartMessage: false});
    assert.equal(editTrunc.truncated, true);
    assert.deepEqual(editTrunc.removedCards.map(c => c.messageId), ['u2']);
    assert.deepEqual(hw.mountedCards.map(c => c.messageId), ['u1', 'a1']);
});

test('F3: buildContinuationPrompt and exportSessionFormatted handle partial/length truncation cleanly', () => {
    const contPrompt = buildContinuationPrompt('前文内容……这是被 length 截断的最后一句');
    assert.ok(contPrompt.includes('最后一句'));
    assert.ok(contPrompt.includes('无需重复上文'));

    const sampleMessages = [
        {id: 'u1', role: 'user', text: '内部完整 Prompt', displayText: '简短展示问题', createdAt: '12:00'},
        {id: 'a1', role: 'assistant', text: '部分回答', modelId: 'gpt-4.1', partial: true, finishReason: 'length', createdAt: '12:01'},
    ];
    const md = exportSessionFormatted(sampleMessages, {backend: 'openai'}, {
        sessionId: 'sess_export_1',
        format: 'markdown',
        exportedAtIso: '2026-11-15T00:00:00Z',
    });
    assert.ok(md.includes('简短展示问题'));
    assert.ok(!md.includes('内部完整 Prompt'));
    assert.ok(md.includes('[未完成/已截断]'));

    const jsonStr = exportSessionFormatted(sampleMessages, {backend: 'openai'}, {
        sessionId: 'sess_export_1',
        format: 'json',
        exportedAtIso: '2026-11-15T00:00:00Z',
    });
    const parsed = JSON.parse(jsonStr);
    assert.equal(parsed.messageCount, 2);
    assert.equal(parsed.messages[1].finishReason, 'length');
});

// =============================================================================
// F4: Lightweight Session Recovery & Consent-Gated Retention Policy
// =============================================================================

test('F4: inspectSessionsWithIo, resolvePreviousSessionId & planSessionRetentionCleanup protect active/previous sessions', async () => {
    const io = createMemorySessionIo();
    const now = 1_760_000_000_000;
    const dayMs = 24 * 60 * 60 * 1000;

    const seedSession = async (id, updatedAt, question) => {
        const s = new SessionStoreEngine(id, {sessionsRootDir: '/mock/sessions', io});
        await s.appendMessage({id: `u_${id}`, role: 'user', text: question, ts: updatedAt}, 'openai', {});
        s.meta.updatedAt = updatedAt;
        await io.replaceFile(s.metaPath, JSON.stringify(s.meta));
        await s.flush();
    };

    await seedSession('curr_sess', now - 1000, '当前正在进行的提问');
    await seedSession('prev_sess', now - 45 * dayMs, '上一个重要会话（虽超30天但受保护）');
    await seedSession('recent_1', now - 2 * dayMs, '两天前的会话');
    await seedSession('recent_2', now - 5 * dayMs, '五天前的会话');
    await seedSession('expired_age', now - 40 * dayMs, '四十天前的超期会话');
    await seedSession('expired_count', now - 10 * dayMs, '超出数量上限的会话');

    const listed = await inspectSessionsWithIo('/mock/sessions', io);
    assert.equal(listed.length, 6);
    assert.equal(listed[0].sessionId, 'curr_sess');

    const resolvedPrev = resolvePreviousSessionId(listed, {
        currentSessionId: 'curr_sess',
        preferredPreviousId: 'prev_sess',
    });
    assert.equal(resolvedPrev, 'prev_sess');

    // Retention plan with maxCount=4, maxAgeDays=30 MUST protect both `curr_sess` and `prev_sess`
    // and MUST NOT delete any files automatically!
    const plan = planSessionRetentionCleanup(listed, {
        currentSessionId: 'curr_sess',
        previousSessionId: resolvedPrev,
        maxCount: 4,
        maxAgeDays: 30,
        nowMs: now,
    });
    const candidateIds = plan.candidatesToDelete.map(c => c.sessionId);
    assert.ok(!candidateIds.includes('curr_sess'));
    assert.ok(!candidateIds.includes('prev_sess'));
    assert.deepEqual(candidateIds.sort(), ['expired_age', 'expired_count']);
    assert.equal((await inspectSessionsWithIo('/mock/sessions', io)).length, 6);

    // Protected session deletion is rejected; path traversal is rejected
    const blockedProtected = await deleteSessionDirectoryWithIo('/mock/sessions', 'curr_sess', io, {
        protectedIds: ['curr_sess', 'prev_sess'],
    });
    assert.equal(blockedProtected.ok, false);

    const blockedTraversal = await deleteSessionDirectoryWithIo('/mock/sessions', '../escape', io);
    assert.equal(blockedTraversal.ok, false);

    // Explicit approved deletion removes only the approved candidate
    const delOk = await deleteSessionDirectoryWithIo('/mock/sessions', 'expired_age', io, {
        protectedIds: ['curr_sess', 'prev_sess'],
    });
    assert.equal(delOk.ok, true);
    assert.equal((await inspectSessionsWithIo('/mock/sessions', io)).length, 5);
});

// =============================================================================
// F5: Background Status Notifications, Lock-Screen Suppression & Click Routing
// =============================================================================

test('F5: BackgroundNotificationGate suppresses lock screen/visible chat, deduplicates, rate-limits, and leaks zero transcript', () => {
    const gate = new BackgroundNotificationGate({cooldownMs: 4000});
    const settings = {notifyOnApproval: true, notifyOnError: true, notifyOnComplete: true};

    // 1. Lock screen & greeter strictly suppressed
    assert.equal(
        gate.evaluate({kind: 'approval_needed', sessionId: 's1', turnId: 't1', isLocked: true, enabledSettings: settings, nowMs: 1000}).shouldNotify,
        false
    );
    assert.equal(
        gate.evaluate({kind: 'turn_completed', sessionId: 's1', turnId: 't1', isGreeter: true, enabledSettings: settings, nowMs: 1000}).shouldNotify,
        false
    );

    // 2. Visible chat suppressed
    assert.equal(
        gate.evaluate({kind: 'turn_completed', sessionId: 's1', turnId: 't1', isChatVisible: true, enabledSettings: settings, nowMs: 1000}).shouldNotify,
        false
    );

    // 3. Background approval_needed fires once per turn and contains ZERO sensitive command/prompt text
    const n1 = gate.evaluate({
        kind: 'approval_needed',
        sessionId: 's1',
        turnId: 'turn_secret_1',
        requestId: 'req_1',
        enabledSettings: settings,
        nowMs: 2000,
    });
    assert.equal(n1.shouldNotify, true);
    assert.ok(!n1.title.includes('turn_secret_1'));
    assert.ok(!n1.body.includes('req_1'));

    // Burst second approval in the SAME turn is deduplicated
    const nDup = gate.evaluate({
        kind: 'approval_needed',
        sessionId: 's1',
        turnId: 'turn_secret_1',
        requestId: 'req_2',
        enabledSettings: settings,
        nowMs: 8000,
    });
    assert.equal(nDup.shouldNotify, false);
    assert.equal(nDup.reason, 'deduplicated');

    // Different turn within cooldown window is rate-limited
    const n2 = gate.evaluate({
        kind: 'turn_failed',
        sessionId: 's1',
        turnId: 'turn_2',
        enabledSettings: settings,
        nowMs: 3000,
    });
    assert.equal(n2.shouldNotify, true);

    const nRateLimited = gate.evaluate({
        kind: 'turn_failed',
        sessionId: 's1',
        turnId: 'turn_3',
        enabledSettings: settings,
        nowMs: 4500, // < 3000 + 4000ms cooldown
    });
    assert.equal(nRateLimited.shouldNotify, false);
    assert.equal(nRateLimited.reason, 'rate_limited');
});

test('F5: resolveNotificationClickTarget safely handles active, missing, deleted, busy, and locked states', () => {
    const target = {kind: 'approval_needed', sessionId: 's_other', turnId: 't_9', requestId: 'r_1'};

    assert.equal(resolveNotificationClickTarget(target, {isLocked: true}).action, 'ignore');

    assert.equal(
        resolveNotificationClickTarget(
            {kind: 'turn_completed', sessionId: 's_cur', turnId: 't_gone'},
            {currentSessionId: 's_cur', mountedTurnIds: ['t_1'], storedTurnIds: ['t_1']}
        ).action,
        'open_current_missing_turn'
    );

    assert.equal(
        resolveNotificationClickTarget(target, {
            currentSessionId: 's_cur',
            existingSessionIds: ['s_cur'],
        }).action,
        'open_current_missing_session'
    );

    assert.equal(
        resolveNotificationClickTarget(target, {
            currentSessionId: 's_cur',
            existingSessionIds: ['s_cur', 's_other'],
            isBusy: true,
        }).action,
        'open_current_busy'
    );

    const switched = resolveNotificationClickTarget(target, {
        currentSessionId: 's_cur',
        existingSessionIds: ['s_cur', 's_other'],
        isBusy: false,
    });
    assert.equal(switched.action, 'switch_session_and_focus');
    assert.equal(switched.sessionId, 's_other');
    assert.equal(switched.turnId, 't_9');
});

// =============================================================================
// F6: Local Rule-Based Smart Model Routing (Zero Extra LLM Calls, Never `full`)
// =============================================================================

test('F6: recommendRouteLocally prefers OpenAI for simple Q&A, Agent for workspace tasks, respects dismissals, and NEVER outputs full mode', () => {
    const profiles = {
        openai: {model: 'gpt-4o-mini', mode: 'chat', reasoningEffort: 'fast'},
        zcode: {model: 'claude-sonnet-4', mode: 'full', reasoningEffort: 'standard'}, // Even if user's profile has 'full'!
        codex: {model: 'o4-mini', mode: 'full', reasoningEffort: 'standard'},
    };
    const availableBackends = ['zcode', 'codex', 'openai'];

    // 1. Simple Q&A while on ZCode -> recommends fast OpenAI chat
    const qaRec = recommendRouteLocally({
        promptText: '什么是 HTTP/3 QUIC 协议？',
        currentBackend: 'zcode',
        currentModel: 'claude-sonnet-4',
        currentMode: 'readonly',
        availableBackends,
        profiles,
    });
    assert.ok(qaRec);
    assert.equal(qaRec.category, 'simple_qa');
    assert.equal(qaRec.targetBackend, 'openai');
    assert.equal(qaRec.targetMode, 'chat');

    // 2. Local file task while on OpenAI -> recommends ZCode ONLY in safe `readonly` mode (never `full`!)
    const fileRec = recommendRouteLocally({
        promptText: '请读取当前仓库 ./src/index.js 并检查是否有未处理的异常',
        currentBackend: 'openai',
        currentModel: 'gpt-4o-mini',
        currentMode: 'chat',
        availableBackends,
        profiles,
    });
    assert.ok(fileRec);
    assert.equal(fileRec.targetBackend, 'zcode');
    assert.equal(fileRec.targetMode, 'readonly');
    assert.notEqual(fileRec.targetMode, 'full');

    // 3. Dismissed signature is respected
    const dismissed = new Set([fileRec.signature]);
    assert.equal(
        recommendRouteLocally({
            promptText: '请读取当前仓库 ./src/index.js 并检查是否有未处理的异常',
            currentBackend: 'openai',
            currentModel: 'gpt-4o-mini',
            currentMode: 'chat',
            availableBackends,
            profiles,
            dismissedKeys: dismissed,
        }),
        null
    );

    // 4. Exhaustive safety check: across ALL backends and candidate modes, `full` is impossible
    for (const backend of ['openai', 'zcode', 'codex']) {
        for (const mode of ['chat', 'readonly', 'full']) {
            assert.notEqual(clampSafeRecommendedMode(backend, mode), 'full');
        }
    }
    const prompts = [
        '你好',
        '查看 /var/log/syslog 日志',
        '重构多文件 race condition 并发竞争问题',
        '请给出严谨证明与时间复杂度证明',
    ];
    for (const p of prompts) {
        assert.ok(['simple_qa', 'file_read', 'complex_code', 'deep_reasoning'].includes(classifyPromptIntentLocally(p)));
        for (const curBackend of ['openai', 'zcode', 'codex']) {
            const rec = recommendRouteLocally({
                promptText: p,
                currentBackend: curBackend,
                currentMode: 'full',
                currentEffort: 'default',
                availableBackends,
                profiles,
            });
            if (rec) {
                assert.notEqual(rec.targetMode, 'full', `Router must never output full mode (got ${rec.targetMode})`);
            }
        }
    }
});

// =============================================================================
// F7: Compact Redacted Runtime Diagnostics
// =============================================================================

test('F7: formatRedactedDiagnosticsText scrubs API keys, URL userinfo, query tokens, home username, and ignores non-whitelisted transcript fields', () => {
    const raw = {
        configuredBackend: 'auto',
        effectiveBackend: 'openai',
        cliVersion: 'zcode 1.4.2 (/home/secretuser/.local/bin/zcode)',
        activeProvider: 'custom',
        activeModel: 'deepseek-chat',
        effectiveMode: 'chat',
        capabilities: {
            supportsTools: false,
            supportsApproval: false,
            interactiveQuestions: false,
            supportsThinking: true,
        },
        mountMode: 'datemenu',
        lastConnectionError: 'HTTP 401 from https://admin:super_pass_123@proxy.example.com/v1/models?api_key=sk-secret999999999999999999 with Bearer my_custom_tok_abc',
        sessionSaveStatus: '写入失败: /home/secretuser/.local/share/gnome-quick-chat/sessions',
        endpointSecurityNote: '远程 HTTP: http://10.0.0.8:8080/v1?token=leak_me_not',
        // Non-whitelisted sensitive fields that MUST NEVER appear in snapshot or formatted output:
        prompt: '我的私人银行卡号与敏感提问正文',
        messages: [{role: 'user', text: '绝密聊天历史记录'}],
    };

    const snap = sanitizeDiagnosticSnapshot(raw, {
        homeDir: '/home/secretuser',
        apiKey: 'my_custom_tok_abc',
    });
    assert.equal('prompt' in snap, false);
    assert.equal('messages' in snap, false);

    const text = formatRedactedDiagnosticsText(raw, {
        extensionVersion: '0.2.0',
        homeDir: '/home/secretuser',
        apiKey: 'my_custom_tok_abc',
    });

    assert.ok(text.includes('Quick Chat（随问）脱敏诊断报告 v0.2.0'));
    assert.ok(text.includes('~/.local/bin/zcode'));
    assert.ok(text.includes(formatCapabilitiesLine(raw.capabilities, 'chat')));
    assert.equal(text.includes('secretuser'), false);
    assert.equal(text.includes('super_pass_123'), false);
    assert.equal(text.includes('sk-secret999999999999999999'), false);
    assert.equal(text.includes('my_custom_tok_abc'), false);
    assert.equal(text.includes('leak_me_not'), false);
    assert.equal(text.includes('私人银行卡号'), false);
    assert.equal(text.includes('绝密聊天历史记录'), false);

    const roundTripped = parseStoredDiagnosticSnapshot(JSON.stringify(snap), {homeDir: '/home/secretuser'});
    assert.equal(roundTripped.effectiveBackend, 'openai');
    assert.equal(roundTripped.activeModel, 'deepseek-chat');
});
