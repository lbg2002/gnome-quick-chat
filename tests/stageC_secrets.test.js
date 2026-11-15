import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SecretKeyManager,
    SecretWriteQueue,
    normalizeEndpointKeyIdentity,
    inspectEndpointSecurity,
    shouldStripAuthOnRedirect,
} from '../core/secretPolicy.js';

function createMockSettings({
    baseUrl = 'https://api.openai.com/v1',
    legacyPlaintext = '',
    allowPlaintextFallback = false,
} = {}) {
    const state = {baseUrl, legacyPlaintext, allowPlaintextFallback};
    return {
        state,
        getBaseUrl: () => state.baseUrl,
        getLegacyPlaintext: () => state.legacyPlaintext,
        setLegacyPlaintext: val => { state.legacyPlaintext = String(val || ''); },
        getAllowPlaintextFallback: () => state.allowPlaintextFallback,
    };
}

function createMockKeyring({
    available = true,
    throwOnClear = false,
    refuseClear = false,
    legacyGlobalKey = '',
} = {}) {
    const store = new Map();
    let legacyGlobal = legacyGlobalKey;
    return {
        available,
        store,
        get legacyGlobal() {
            return legacyGlobal;
        },
        async lookupEndpoint(endpointKey) {
            return store.get(endpointKey) || '';
        },
        async storeEndpoint(endpointKey, secret) {
            store.set(endpointKey, secret);
            return true;
        },
        async clearEndpoint(endpointKey) {
            if (throwOnClear) {
                throw new Error('Keyring daemon locked');
            }
            if (refuseClear) {
                // Simulate libsecret returning false while the item remains locked in keyring!
                return false;
            }
            const existed = store.has(endpointKey);
            store.delete(endpointKey);
            return existed;
        },
        async lookupLegacyGlobal() {
            return legacyGlobal;
        },
        async clearLegacyGlobal() {
            if (refuseClear) return false;
            const existed = Boolean(legacyGlobal);
            legacyGlobal = '';
            return existed;
        },
    };
}

test('Stage C4: Per-endpoint API Key isolation prevents leaking old endpoint keys when switching Base URL', async () => {
    assert.equal(normalizeEndpointKeyIdentity('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com');
    assert.equal(normalizeEndpointKeyIdentity('https://api.openai.com:443/v1/'), 'https://api.openai.com');
    assert.equal(normalizeEndpointKeyIdentity('https://gateway.example.com:8443/tenant-a/v1'), 'https://gateway.example.com:8443/tenant-a');

    const keyring = createMockKeyring();
    const mgr = new SecretKeyManager({keyring});
    const settings = createMockSettings({baseUrl: 'https://api.openai.com/v1'});

    await mgr.storeKey(settings, 'https://api.openai.com/v1', 'sk-openai-1111111111');
    await mgr.storeKey(settings, 'https://api.deepseek.com/v1', 'sk-deepseek-2222222222');

    // Switching Base URL to a brand-new host MUST NOT load OpenAI's or DeepSeek's key!
    settings.state.baseUrl = 'https://new-untrusted-host.example.com/v1';
    const untrustedLoad = await mgr.loadKey(settings, settings.state.baseUrl);
    assert.equal(untrustedLoad.apiKey, '');
    assert.equal(untrustedLoad.storage, 'none');

    // Switching back to OpenAI or DeepSeek retrieves only that exact endpoint's key
    const openaiLoad = await mgr.loadKey(settings, 'https://api.openai.com/v1');
    assert.equal(openaiLoad.apiKey, 'sk-openai-1111111111');
    const deepseekLoad = await mgr.loadKey(settings, 'https://api.deepseek.com/v1');
    assert.equal(deepseekLoad.apiKey, 'sk-deepseek-2222222222');
});

test('Stage C4: Honest clearKey semantics — never swallows errors, distinguishes already-absent vs stuck item, and never resurrects deleted keys', async () => {
    // 1. Keyring throws D-Bus/locked error -> ok: false!
    const throwingKeyring = createMockKeyring({throwOnClear: true});
    const mgrThrow = new SecretKeyManager({keyring: throwingKeyring});
    const settings = createMockSettings();
    await mgrThrow.storeKey(settings, settings.state.baseUrl, 'sk-keep-safe');
    const errRes = await mgrThrow.clearKey(settings, settings.state.baseUrl);
    assert.equal(errRes.ok, false);
    assert.match(errRes.error, /Keyring daemon locked/);

    // 2. Keyring returns `false` while item is still present -> ok: false (never falsely claim deleted!)
    const stuckKeyring = createMockKeyring({refuseClear: true});
    const mgrStuck = new SecretKeyManager({keyring: stuckKeyring});
    await mgrStuck.storeKey(settings, settings.state.baseUrl, 'sk-stuck-item');
    const stuckRes = await mgrStuck.clearKey(settings, settings.state.baseUrl);
    assert.equal(stuckRes.ok, false);
    assert.match(stuckRes.error, /未能删除/);

    // 3. Normal delete -> ok: true, removedFromKeyring: true; subsequent reload returns '' (never resurrects!)
    const normalKeyring = createMockKeyring();
    const mgrNormal = new SecretKeyManager({keyring: normalKeyring});
    settings.state.legacyPlaintext = 'sk-old-fallback-copy';
    await mgrNormal.storeKey(settings, settings.state.baseUrl, 'sk-active-secret');
    assert.equal(settings.state.legacyPlaintext, '', 'legacy plaintext erased after verified keyring store');

    const delRes = await mgrNormal.clearKey(settings, settings.state.baseUrl);
    assert.equal(delRes.ok, true);
    assert.equal(delRes.removedFromKeyring, true);

    const afterDel = await mgrNormal.loadKey(settings, settings.state.baseUrl);
    assert.equal(afterDel.apiKey, '');

    // 4. Clearing an already-absent key when libsecret returns `false` -> ok: true, alreadyAbsent: true
    const absentRes = await mgrNormal.clearKey(settings, settings.state.baseUrl);
    assert.equal(absentRes.ok, true);
    assert.equal(absentRes.alreadyAbsent, true);
});

test('Stage C4: Keyring unavailable defaults to runtime-only memory (zero silent plaintext fallback) unless user explicitly opts in', async () => {
    const unavailableKeyring = createMockKeyring({available: false});
    const memoryStore = new Map();
    const mgr = new SecretKeyManager({keyring: unavailableKeyring, memoryStore});
    const settings = createMockSettings({allowPlaintextFallback: false});

    const saveRes = await mgr.storeKey(settings, settings.state.baseUrl, 'sk-mem-only-secret');
    assert.equal(saveRes.ok, true);
    assert.equal(saveRes.persisted, false);
    assert.equal(saveRes.storage, 'memory');
    // GSettings plaintext MUST remain completely empty!
    assert.equal(settings.state.legacyPlaintext, '');

    // Readable during current runtime session
    const runtimeRead = await mgr.loadKey(settings, settings.state.baseUrl);
    assert.equal(runtimeRead.apiKey, 'sk-mem-only-secret');
    assert.equal(runtimeRead.storage, 'memory');

    // Simulated GNOME Shell restart (fresh memoryStore): nothing persisted in plaintext!
    const restartedMgr = new SecretKeyManager({keyring: unavailableKeyring, memoryStore: new Map()});
    const afterRestart = await restartedMgr.loadKey(settings, settings.state.baseUrl);
    assert.equal(afterRestart.apiKey, '');

    // Explicit user opt-in (`allowPlaintextFallback: true`) persists per-endpoint map with clear warning
    settings.state.allowPlaintextFallback = true;
    const optInRes = await restartedMgr.storeKey(settings, 'https://api.deepseek.com/v1', 'sk-opt-in-key');
    assert.equal(optInRes.persisted, true);
    assert.equal(optInRes.storage, 'plaintext_opt_in');
    assert.notEqual(settings.state.legacyPlaintext, '');
    assert.equal((await restartedMgr.loadKey(settings, 'https://api.openai.com/v1')).apiKey, '');
    assert.equal((await restartedMgr.loadKey(settings, 'https://api.deepseek.com/v1')).apiKey, 'sk-opt-in-key');
});

test('Stage C4: Remote plaintext HTTP warning and cross-origin / scheme-downgrade redirect Authorization stripping', () => {
    const httpsRemote = inspectEndpointSecurity('https://api.openai.com/v1');
    assert.equal(httpsRemote.isValid, true);
    assert.equal(httpsRemote.isRemotePlaintextHttp, false);
    assert.equal(httpsRemote.warning, '');

    const httpLocal = inspectEndpointSecurity('http://127.0.0.1:11434/v1');
    assert.equal(httpLocal.isValid, true);
    assert.equal(httpLocal.isLoopback, true);
    assert.equal(httpLocal.isRemotePlaintextHttp, false);

    const httpRemote = inspectEndpointSecurity('http://10.20.30.40:8000/v1');
    assert.equal(httpRemote.isValid, true);
    assert.equal(httpRemote.isLoopback, false);
    assert.equal(httpRemote.isRemotePlaintextHttp, true);
    assert.match(httpRemote.warning, /明文 HTTP/);

    // Same origin path redirect -> keep Authorization
    assert.equal(
        shouldStripAuthOnRedirect('https://api.openai.com/v1/models', 'https://api.openai.com/v2/models'),
        false
    );
    // Cross-host redirect -> MUST strip Authorization!
    assert.equal(
        shouldStripAuthOnRedirect('https://proxy.example.com/v1/models', 'https://attacker.evil.example/capture'),
        true
    );
    // HTTPS -> HTTP downgrade on same host -> MUST strip Authorization!
    assert.equal(
        shouldStripAuthOnRedirect('https://proxy.example.com/v1/models', 'http://proxy.example.com/v1/models'),
        true
    );
    // Different port -> MUST strip Authorization!
    assert.equal(
        shouldStripAuthOnRedirect('https://proxy.example.com:8443/v1/models', 'https://proxy.example.com:9443/v1/models'),
        true
    );
});

test('Stage C4: SecretWriteQueue prevents stale async load from overwriting user edits and serializes writes before window close', async () => {
    const queue = new SecretWriteQueue();
    const initialLoadToken = queue.beginLoad('https://api.openai.com/v1');

    // User starts typing before initial Keyring lookup finishes -> loadToken becomes stale!
    queue.bumpEditVersion();
    assert.equal(queue.shouldApplyLoad(initialLoadToken, 'https://api.openai.com/v1'), false);

    // Fresh load token on matching version, but user changes Base URL before it resolves -> stale!
    const urlLoadToken = queue.beginLoad('https://api.openai.com/v1');
    assert.equal(queue.shouldApplyLoad(urlLoadToken, 'https://api.deepseek.com/v1'), false);

    // Enqueued writes execute strictly in order even when earlier write is slower
    const executionOrder = [];
    let finalSavedValue = '';

    queue.enqueue(async () => {
        await new Promise(r => setTimeout(r, 25));
        executionOrder.push('write_1_old');
        finalSavedValue = 'sk-old-draft';
        return {ok: true};
    });
    queue.enqueue(async () => {
        await new Promise(r => setTimeout(r, 2));
        executionOrder.push('write_2_newest');
        finalSavedValue = 'sk-newest-final';
        return {ok: true};
    });

    assert.equal(queue.hasPendingWrites, true);
    await queue.flush();
    assert.equal(queue.hasPendingWrites, false);
    assert.deepEqual(executionOrder, ['write_1_old', 'write_2_newest']);
    assert.equal(finalSavedValue, 'sk-newest-final');
});
