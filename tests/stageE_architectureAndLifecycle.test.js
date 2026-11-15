import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
    BackendRegistry,
    MemorySettingsStore,
    runSettingsTransaction,
} from '../core/backendRegistry.js';
import {ChatController} from '../core/chatController.js';
import {
    executeDateMenuMountTransaction,
    nudgeContainerLayoutSafely,
    restoreNativeActorFromSnapshot,
} from '../core/dateMenuTransaction.js';
import {BaseBackendAdapter} from '../backends/baseAdapter.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeMockActor(name, props = {}) {
    const classes = new Set(
        String(props.style_class || '')
            .split(/\s+/)
            .filter(Boolean)
    );
    const children = [];
    const signals = new Map();
    let nextSigId = 1;
    let parentRef = null;

    const actor = {
        name,
        visible: props.visible ?? true,
        opacity: props.opacity ?? 255,
        translation_x: props.translation_x ?? 0,
        translation_y: props.translation_y ?? 0,
        scale_x: props.scale_x ?? 1,
        scale_y: props.scale_y ?? 1,
        layout_manager: props.layout_manager || null,
        relayoutCalls: 0,
        get style_class() {
            return Array.from(classes).join(' ');
        },
        has_style_class_name(cls) {
            return classes.has(cls);
        },
        add_style_class_name(cls) {
            classes.add(cls);
        },
        remove_style_class_name(cls) {
            classes.delete(cls);
        },
        get_parent() {
            return parentRef;
        },
        _setParent(p) {
            parentRef = p;
        },
        get_children() {
            return [...children];
        },
        get_n_children() {
            return children.length;
        },
        add_child(child) {
            if (props.throwOnAddChild) {
                throw new Error(props.throwOnAddChild);
            }
            if (child.get_parent()) {
                throw new Error(`Child ${child.name} already has a parent`);
            }
            children.push(child);
            child._setParent(actor);
        },
        insert_child_at_index(child, idx) {
            if (props.throwOnInsertChild && child.name === props.throwOnInsertChildTarget) {
                throw new Error(props.throwOnInsertChild);
            }
            if (child.get_parent()) {
                throw new Error(`Child ${child.name} already has a parent`);
            }
            const clamped = Math.max(0, Math.min(idx, children.length));
            children.splice(clamped, 0, child);
            child._setParent(actor);
        },
        remove_child(child) {
            const idx = children.indexOf(child);
            if (idx < 0) {
                throw new Error(`Child ${child.name} not in ${actor.name}`);
            }
            children.splice(idx, 1);
            child._setParent(null);
        },
        connect(sig, cb) {
            const id = nextSigId++;
            signals.set(id, {sig, cb});
            return id;
        },
        disconnect(id) {
            signals.delete(id);
        },
        emitSignal(sig) {
            for (const entry of signals.values()) {
                if (entry.sig === sig) entry.cb(actor);
            }
        },
        queue_relayout() {
            actor.relayoutCalls += 1;
        },
        activeSignalCount() {
            return signals.size;
        },
    };
    return actor;
}

test('E1 BackendRegistry: isolates ZCode, Codex, and OpenAI profiles across switches and batches writes', () => {
    const store = new MemorySettingsStore({
        backend: 'zcode',
        provider: '',
        model: '',
        'reasoning-effort': 'default',
        'agent-mode': 'readonly',
        workspace: '',
    });
    const registry = new BackendRegistry(store);

    // 1. Configure ZCode profile in a single delayed GSettings transaction
    const applyBefore = store.applyCount;
    registry.updateBackendProfile('zcode', {
        executablePath: '/opt/bin/zcode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        reasoningEffort: 'deep',
        workspace: '/work/zcode-project',
        mode: 'full',
    }, {recordRecent: true});
    assert.equal(store.applyCount, applyBefore + 1, 'Multi-key update must commit in a single apply() batch');

    // Legacy shared provider/model keys must NOT be polluted
    assert.equal(store.get_string('provider'), '');
    assert.equal(store.get_string('model'), '');

    // 2. Switch to Codex and configure distinct settings
    registry.selectBackend('codex');
    const initialCodex = registry.getBackendProfile('codex');
    assert.equal(initialCodex.provider, '', 'ZCode provider must not leak into Codex');
    assert.equal(initialCodex.model, '', 'ZCode model must not leak into Codex');

    registry.updateBackendProfile('codex', {
        executablePath: '/opt/bin/codex',
        provider: 'openai',
        model: 'gpt-5-codex',
        reasoningEffort: 'standard',
        workspace: '/work/codex-project',
        mode: 'chat', // Codex has no tool-free chat; must normalize safely to readonly
    }, {recordRecent: true});
    assert.equal(registry.getBackendProfile('codex').mode, 'readonly');

    // 3. Switch to OpenAI API and configure custom model & endpoint
    registry.selectBackend('openai');
    assert.equal(registry.getBackendProfile('openai').model, '', 'CLI models must not leak into OpenAI profile');
    registry.updateBackendProfile('openai', {
        baseUrl: 'https://api.example.com/v1',
        model: 'deepseek-chat',
        reasoningEffort: 'fast',
        systemPrompt: '请简洁回答',
    }, {recordRecent: true});

    // 4. Switch back through ZCode -> Codex -> OpenAI and verify 100% lossless restoration
    registry.selectBackend('zcode');
    const restoredZcode = registry.getBackendProfile('zcode');
    assert.equal(restoredZcode.provider, 'anthropic');
    assert.equal(restoredZcode.model, 'claude-sonnet-4-5');
    assert.equal(restoredZcode.reasoningEffort, 'deep');
    assert.equal(restoredZcode.workspace, '/work/zcode-project');
    assert.equal(restoredZcode.mode, 'full');

    registry.selectBackend('codex');
    const restoredCodex = registry.getBackendProfile('codex');
    assert.equal(restoredCodex.provider, 'openai');
    assert.equal(restoredCodex.model, 'gpt-5-codex');
    assert.equal(restoredCodex.reasoningEffort, 'standard');
    assert.equal(restoredCodex.workspace, '/work/codex-project');
    assert.equal(restoredCodex.mode, 'readonly');

    registry.selectBackend('openai');
    const restoredOpenAI = registry.getBackendProfile('openai');
    assert.equal(restoredOpenAI.baseUrl, 'https://api.example.com/v1');
    assert.equal(restoredOpenAI.model, 'deepseek-chat');
    assert.equal(restoredOpenAI.reasoningEffort, 'fast');
    assert.equal(restoredOpenAI.mode, 'chat');

    // Nested runSettingsTransaction calls do not prematurely apply inner blocks
    let signalsDuringTx = -1;
    runSettingsTransaction(store, () => {
        const beforeLen = store.signalEvents.length;
        store.set_string('zcode-model', 'claude-opus-4-1');
        runSettingsTransaction(store, () => {
            store.set_string('zcode-provider', 'anthropic-ent');
        });
        signalsDuringTx = store.signalEvents.length - beforeLen;
    });
    assert.equal(signalsDuringTx, 0, 'Delayed transaction must hold signals until outermost apply()');
    assert.equal(store.get_string('zcode-model'), 'claude-opus-4-1');
    assert.equal(store.get_string('zcode-provider'), 'anthropic-ent');
});

test('E2 BaseBackendAdapter: enforces unified interface and capability-gated permission responses', async () => {
    const codexAdapter = new BaseBackendAdapter('codex').initialize(null, {mode: 'readonly'});
    const openaiAdapter = new BaseBackendAdapter('openai').initialize(null, {mode: 'chat'});
    const zcodeAdapter = new BaseBackendAdapter('zcode').initialize(null, {mode: 'readonly'});

    assert.equal(codexAdapter.getCapabilities().supportsApproval, false);
    assert.equal(openaiAdapter.getCapabilities().supportsApproval, false);
    assert.equal(zcodeAdapter.getCapabilities().supportsApproval, true);

    const codexPerm = await codexAdapter.respondPermission({requestId: 'req_1', decision: 'allow'});
    assert.equal(codexPerm.sent, false);
    assert.equal(codexPerm.rejected, 'capability_not_supported');

    const openaiPerm = await openaiAdapter.respondPermission({requestId: 'req_2', decision: 'allow'});
    assert.equal(openaiPerm.sent, false);
    assert.equal(openaiPerm.rejected, 'capability_not_supported');

    await assert.rejects(
        () => openaiAdapter.sendMessage({message: 'hi'}),
        /must implement sendMessage/
    );

    openaiAdapter.dispose();
    assert.equal(openaiAdapter.isDisposed, true);
});

test('E3 DateMenuTransaction: rolls back completely on partial mount failure and preserves _frozen & lock-screen state', () => {
    let frozenMutations = 0;
    let frozenVal = true;
    const layoutManager = {
        layoutChangedCount: 0,
        get _frozen() {
            return frozenVal;
        },
        set _frozen(v) {
            frozenMutations += 1;
            frozenVal = v;
        },
        layout_changed() {
            this.layoutChangedCount += 1;
        },
    };

    const bin = makeMockActor('bin', {layout_manager: layoutManager});
    const parentBox = makeMockActor('hbox');
    bin.add_child(parentBox);

    const leftCalendar = makeMockActor('calendar');
    const nativeList = makeMockActor('nativeMessageList', {
        visible: true,
        opacity: 240,
        translation_y: 4,
        style_class: 'message-list',
    });
    const rightMedia = makeMockActor('mediaSection');
    parentBox.add_child(leftCalendar);
    parentBox.add_child(nativeList); // original index === 1
    parentBox.add_child(rightMedia);

    const dateMenu = {menu: {isOpen: false}, _messageList: nativeList};

    // Case A: Partial failure AFTER `parent.remove_child(nativeList)` when `wrapper.add_child` throws!
    const brokenWrapper = makeMockActor('brokenWrapper', {
        throwOnAddChild: 'Simulated Clutter actor reparent failure',
    });
    const failedTx = executeDateMenuMountTransaction({
        dateMenu,
        wrapperActor: brokenWrapper,
        shouldForceHideNativeFn: () => true,
        sessionState: {hasNotifications: true, isLocked: false, isGreeter: false},
    });

    assert.equal(failedTx.ok, false);
    assert.equal(failedTx.reason, 'mount_exception');
    assert.equal(failedTx.rolledBack, true);
    assert.equal(nativeList.get_parent(), parentBox, 'nativeList must be restored to original parent');
    assert.equal(parentBox.get_children().indexOf(nativeList), 1, 'nativeList must return to exact index 1');
    assert.equal(nativeList.has_style_class_name('qc-native-clean'), false);
    assert.equal(nativeList.opacity, 240);
    assert.equal(nativeList.translation_y, 4);
    assert.equal(nativeList.visible, true);
    assert.equal(frozenMutations, 0, 'Must never mutate private layout_manager._frozen by default');

    // Case B: Partial failure when `parent.insert_child_at_index(wrapperActor, index)` throws AFTER wrapper adopted nativeList!
    const parentFailInsert = makeMockActor('hboxInsertFail', {
        throwOnInsertChild: 'Simulated container insert error',
        throwOnInsertChildTarget: 'goodWrapper',
    });
    const cal2 = makeMockActor('cal2');
    const native2 = makeMockActor('native2', {visible: false, style_class: 'message-list'});
    parentFailInsert.add_child(cal2);
    parentFailInsert.add_child(native2);
    const wrapper2 = makeMockActor('goodWrapper');

    const failedTx2 = executeDateMenuMountTransaction({
        dateMenu: {menu: {}, _messageList: native2},
        wrapperActor: wrapper2,
        shouldForceHideNativeFn: () => true,
        sessionState: {hasNotifications: true, isLocked: false, isGreeter: false},
    });
    assert.equal(failedTx2.ok, false);
    assert.equal(failedTx2.rolledBack, true);
    assert.equal(native2.get_parent(), parentFailInsert);
    assert.equal(wrapper2.get_n_children(), 0);
    assert.equal(native2.visible, false, 'Must preserve original false visibility instead of forcing true');

    // Case C: Successful mount + visibility guard + lock-screen-aware unmount
    const goodWrapper = makeMockActor('qcWrapper');
    let forceHide = true;
    const okTx = executeDateMenuMountTransaction({
        dateMenu,
        wrapperActor: goodWrapper,
        shouldForceHideNativeFn: () => forceHide,
        sessionState: {hasNotifications: true, isLocked: false, isGreeter: false},
    });
    assert.equal(okTx.ok, true);
    assert.equal(parentBox.get_children().indexOf(goodWrapper), 1);
    assert.equal(nativeList.get_parent(), goodWrapper);
    assert.equal(nativeList.has_style_class_name('qc-native-clean'), true);

    nativeList.visible = true;
    nativeList.emitSignal('notify::visible');
    assert.equal(nativeList.visible, false, 'Guard signal hides nativeList while AI tab is active');

    // Unmount while screen is locked -> nativeList must NOT be forced visible on lock screen
    nativeList.disconnect(okTx.guardSignalId);
    const lockRestore = restoreNativeActorFromSnapshot(nativeList, goodWrapper, okTx.snapshot, {
        hasNotifications: true,
        isLocked: true,
        isGreeter: false,
    });
    assert.equal(lockRestore.restored, true);
    assert.equal(nativeList.get_parent(), parentBox);
    assert.equal(parentBox.get_children().indexOf(nativeList), 1);
    assert.equal(nativeList.visible, false, 'Lock screen unmount must keep nativeList hidden');

    // Verify optional temporary unfreeze restores `_frozen` even if layout_changed throws
    const throwingLm = {
        _frozen: true,
        layout_changed() {
            throw new Error('boom');
        },
    };
    const binThrow = makeMockActor('binThrow', {layout_manager: throwingLm});
    const boxThrow = makeMockActor('boxThrow');
    binThrow.add_child(boxThrow);
    nudgeContainerLayoutSafely(boxThrow, {allowTemporaryUnfreeze: true});
    assert.equal(throwingLm._frozen, true, '_frozen must be restored in finally block');
});

test('E4 ChatController: coalesces concurrent ensureConnected, debounces reconnects, revokes scopes, and isolates lifecycles', async () => {
    const store = new MemorySettingsStore({backend: 'zcode'});
    const registry = new BackendRegistry(store);

    let envLoadCalls = 0;
    let clientCreateCalls = 0;
    let revokeCalls = 0;
    const stateChanges = [];
    const receivedEvents = [];

    let activeWorkspace = '/work/a';
    let activeMode = 'readonly';

    const controller = new ChatController({
        registry,
        loadRuntimeEnvironment: async () => {
            envLoadCalls += 1;
            await new Promise(r => setTimeout(r, 15));
            return {
                config: {backend: 'zcode', mode: activeMode},
                workspace: activeWorkspace,
                sessionsDir: '/tmp/sessions',
                sessionId: 'sess_1',
            };
        },
        createClient: (onEvent) => {
            clientCreateCalls += 1;
            return {
                emitTestEvent: ev => onEvent(ev),
                start() {},
                revokeApprovedScopes() {
                    revokeCalls += 1;
                },
                async request(method) {
                    if (method === 'get_state') {
                        return {backend: 'zcode', effectiveMode: activeMode, model: {id: 'claude-4'}};
                    }
                    if (method === 'get_messages') {
                        return {messages: []};
                    }
                    return {};
                },
                close() {},
            };
        },
        onEvent: ev => receivedEvents.push(ev),
        onStateChanged: info => stateChanges.push(info),
    });

    // 1. Fire 5 concurrent ensureConnected() calls -> must coalesce into 1 connection!
    const results = await Promise.all([
        controller.ensureConnected(),
        controller.ensureConnected(),
        controller.ensureConnected(),
        controller.ensureConnected(),
        controller.ensureConnected(),
    ]);
    assert.equal(envLoadCalls, 1);
    assert.equal(clientCreateCalls, 1);
    assert.equal(stateChanges.length, 1);
    assert.ok(results.every(r => r && r.state.backend === 'zcode'));

    // 2. Rapid burst of 4 config changes coalesces into 1 reconnect and revokes scopes on security change
    activeWorkspace = '/work/b';
    controller.scheduleConfigReconnect({debounceMs: 20, revokeScopes: true});
    controller.scheduleConfigReconnect({debounceMs: 20, revokeScopes: false});
    controller.scheduleConfigReconnect({debounceMs: 20, revokeScopes: false});
    controller.scheduleConfigReconnect({debounceMs: 20, revokeScopes: true});

    await new Promise(r => setTimeout(r, 65));
    assert.equal(clientCreateCalls, 2, '4 rapid config updates must trigger only 1 reconnect');
    assert.ok(revokeCalls >= 2, 'Approved scopes must be revoked on workspace boundary change');

    // 3. While busy, config change sets needsReconnect instead of killing active turn
    controller.busy = true;
    controller.scheduleConfigReconnect({debounceMs: 10, revokeScopes: true});
    assert.equal(controller.needsReconnect, true);
    assert.equal(clientCreateCalls, 2);
    controller.busy = false;

    // 4. Lifecycle disposal blocks stale events & in-flight connections from touching a re-enabled lifecycle
    const staleClientRef = controller.client;
    controller.dispose();
    staleClientRef.emitTestEvent({type: 'message_end'});
    assert.equal(receivedEvents.length, 0, 'Events from disposed lifecycle generation must be dropped');

    controller.beginLifecycle(2);
    const res2 = await controller.ensureConnected();
    assert.equal(res2.state.backend, 'zcode');
    controller.dispose();
});

test('E5 Shell Lifecycle: install.sh (install, upgrade, rollback) and uninstall.sh (preserve vs scoped --purge)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-stageE-scripts-'));
    try {
        const fakeBin = path.join(tmpRoot, 'bin');
        const homeDir = path.join(tmpRoot, 'home');
        const dataHome = path.join(homeDir, '.local', 'share');
        const cacheHome = path.join(homeDir, '.cache');
        const runtimeDir = path.join(tmpRoot, 'run');
        const logFile = path.join(tmpRoot, 'cmd.log');
        const failFlagFile = path.join(tmpRoot, 'fail-schema');
        const failSecretFlagFile = path.join(tmpRoot, 'fail-secret');

        fs.mkdirSync(fakeBin, {recursive: true});
        fs.mkdirSync(homeDir, {recursive: true});
        fs.mkdirSync(runtimeDir, {recursive: true, mode: 0o700});

        const writeFakeCmd = (name, scriptBody) => {
            const p = path.join(fakeBin, name);
            fs.writeFileSync(p, `#!/usr/bin/env bash\nset -e\n${scriptBody}\n`, {mode: 0o755});
        };

        writeFakeCmd('glib-compile-schemas', `
echo "glib-compile-schemas $*" >> "${logFile}"
if [[ -f "${failFlagFile}" ]]; then
  echo "Simulated schema compile error" >&2
  exit 1
fi
target_dir="\${@: -1}"
if [[ -d "$target_dir" ]]; then
  echo "compiled" > "$target_dir/gschemas.compiled"
fi
`);
        writeFakeCmd('gjs', `echo "gjs $*" >> "${logFile}"`);
        writeFakeCmd('gnome-shell', `echo "GNOME Shell 50.1"`);
        writeFakeCmd('gnome-extensions', `
echo "gnome-extensions $*" >> "${logFile}"
if [[ "$1" == "info" ]]; then
  echo "Name: Quick Chat"
  echo "State: ACTIVE"
fi
`);
        writeFakeCmd('gsettings', `
echo "gsettings $*" >> "${logFile}"
if [[ "$1" == "list-schemas" ]]; then
  echo "org.gnome.shell.extensions.quick-chat"
fi
`);
        writeFakeCmd('secret-tool', `
echo "secret-tool $*" >> "${logFile}"
if [[ -f "${failSecretFlagFile}" ]]; then
  exit 2
fi
`);

        const env = {
            ...process.env,
            HOME: homeDir,
            XDG_DATA_HOME: dataHome,
            XDG_CACHE_HOME: cacheHome,
            XDG_RUNTIME_DIR: runtimeDir,
            PATH: `${fakeBin}:${process.env.PATH}`,
        };

        const extDest = path.join(dataHome, 'gnome-shell', 'extensions', 'quick-chat@lbg2002.github.io');

        // 1. Fresh install succeeds, includes backends/, compiles schema, and never rewrites global enabled-extensions
        const install1 = spawnSync('bash', [path.join(REPO_ROOT, 'install.sh')], {
            cwd: REPO_ROOT,
            env,
            encoding: 'utf8',
        });
        assert.equal(install1.status, 0, `install.sh failed: ${install1.stderr}`);
        assert.ok(fs.existsSync(path.join(extDest, 'extension.js')));
        assert.ok(fs.existsSync(path.join(extDest, 'backends', 'zcodeAdapter.js')));
        assert.ok(fs.existsSync(path.join(extDest, 'backends', 'codexAdapter.js')));
        assert.ok(fs.existsSync(path.join(extDest, 'backends', 'openaiAdapter.js')));
        assert.ok(fs.existsSync(path.join(extDest, 'core', 'backendRegistry.js')));
        assert.ok(fs.existsSync(path.join(extDest, 'core', 'chatController.js')));
        assert.ok(fs.existsSync(path.join(extDest, 'runtime', 'processManager.js')));
        assert.ok(fs.existsSync(path.join(extDest, 'ui', 'chatPanel.js')));
        assert.ok(fs.existsSync(path.join(extDest, 'schemas', 'gschemas.compiled')));
        assert.match(install1.stdout, /已成功启用/);

        const logAfterInstall = fs.readFileSync(logFile, 'utf8');
        assert.ok(!logAfterInstall.includes('enabled-extensions'), 'Must not rewrite global enabled-extensions list');

        // 2. Place a marker in installed extension, simulate failed upgrade -> existing installation remains intact!
        const markerPath = path.join(extDest, 'previous-version-marker.txt');
        fs.writeFileSync(markerPath, 'v-old-safe');
        fs.writeFileSync(failFlagFile, '1');
        const failedUpgrade = spawnSync('bash', [path.join(REPO_ROOT, 'install.sh')], {
            cwd: REPO_ROOT,
            env,
            encoding: 'utf8',
        });
        assert.notEqual(failedUpgrade.status, 0);
        assert.equal(fs.readFileSync(markerPath, 'utf8'), 'v-old-safe', 'Failed upgrade must preserve existing install');
        fs.unlinkSync(failFlagFile);

        // 3. Valid upgrade replaces marker cleanly and leaves zero `.backup.` or `.staging.` directories
        const okUpgrade = spawnSync('bash', [path.join(REPO_ROOT, 'install.sh')], {
            cwd: REPO_ROOT,
            env,
            encoding: 'utf8',
        });
        assert.equal(okUpgrade.status, 0, okUpgrade.stderr);
        assert.equal(fs.existsSync(markerPath), false);
        const extRootEntries = fs.readdirSync(path.dirname(extDest));
        assert.equal(
            extRootEntries.some(e => e.includes('.backup.') || e.includes('.staging.')),
            false,
            'No leftover backup or staging dirs after successful upgrade'
        );

        // 4. Create user session history, cache fallback dir, runtime dir, and external CLI dirs (~/.zcode, ~/.codex)
        const sessionDir = path.join(dataHome, 'gnome-quick-chat', 'sessions', 'sess_demo');
        const appCacheDir = path.join(cacheHome, 'gnome-quick-chat');
        const appRuntimeDir = path.join(runtimeDir, 'gnome-quick-chat');
        const externalZcodeDir = path.join(homeDir, '.zcode');
        const externalCodexDir = path.join(homeDir, '.codex');
        for (const d of [sessionDir, appCacheDir, appRuntimeDir, externalZcodeDir, externalCodexDir]) {
            fs.mkdirSync(d, {recursive: true});
            fs.writeFileSync(path.join(d, 'data.json'), '{"keep":true}');
        }

        // Normal uninstall removes extension dir ONLY, preserving user history & external CLI configs
        const normalUninstall = spawnSync('bash', [path.join(REPO_ROOT, 'uninstall.sh')], {
            cwd: REPO_ROOT,
            env,
            encoding: 'utf8',
        });
        assert.equal(normalUninstall.status, 0, normalUninstall.stderr);
        assert.equal(fs.existsSync(extDest), false);
        assert.equal(fs.existsSync(sessionDir), true, 'Normal uninstall must preserve user session history');
        assert.equal(fs.existsSync(externalZcodeDir), true);
        assert.equal(fs.existsSync(externalCodexDir), true);

        // Reinstall, then test `--purge` when Keyring fails -> must report failure (non-zero exit)!
        spawnSync('bash', [path.join(REPO_ROOT, 'install.sh')], {cwd: REPO_ROOT, env});
        fs.writeFileSync(failSecretFlagFile, '1');
        const failedPurge = spawnSync('bash', [path.join(REPO_ROOT, 'uninstall.sh'), '--purge'], {
            cwd: REPO_ROOT,
            env,
            encoding: 'utf8',
        });
        assert.notEqual(failedPurge.status, 0, 'uninstall.sh --purge must fail honestly when Keyring clear fails');
        fs.unlinkSync(failSecretFlagFile);

        // Reinstall + recreate data/cache/runtime dirs, then run clean `--purge`
        spawnSync('bash', [path.join(REPO_ROOT, 'install.sh')], {cwd: REPO_ROOT, env});
        for (const d of [sessionDir, appCacheDir, appRuntimeDir]) {
            fs.mkdirSync(d, {recursive: true});
        }
        fs.writeFileSync(logFile, '');
        const cleanPurge = spawnSync('bash', [path.join(REPO_ROOT, 'uninstall.sh'), '--purge'], {
            cwd: REPO_ROOT,
            env,
            encoding: 'utf8',
        });
        assert.equal(cleanPurge.status, 0, cleanPurge.stderr);
        assert.equal(fs.existsSync(extDest), false);
        assert.equal(fs.existsSync(path.join(dataHome, 'gnome-quick-chat')), false);
        assert.equal(fs.existsSync(appCacheDir), false);
        assert.equal(fs.existsSync(appRuntimeDir), false);
        assert.equal(fs.existsSync(externalZcodeDir), true, 'Purge must NEVER delete ~/.zcode');
        assert.equal(fs.existsSync(externalCodexDir), true, 'Purge must NEVER delete ~/.codex');

        const purgeLog = fs.readFileSync(logFile, 'utf8');
        assert.match(purgeLog, /reset-recursively org\.gnome\.shell\.extensions\.quick-chat/);
        assert.match(
            purgeLog,
            /secret-tool clear xdg:schema org\.gnome\.shell\.extensions\.quick-chat\.endpoint-apikey account openai-endpoint-api-key/
        );
        assert.match(
            purgeLog,
            /secret-tool clear xdg:schema org\.gnome\.shell\.extensions\.quick-chat\.apikey account openai-compatible-api-key/
        );
    } finally {
        fs.rmSync(tmpRoot, {recursive: true, force: true});
    }
});
