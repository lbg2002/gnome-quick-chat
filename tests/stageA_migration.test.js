import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    CURRENT_CONFIG_VERSION,
    PI_MIGRATION_NOTICE,
    SUPPORTED_BACKENDS,
    UNCONFIGURED_BACKEND_MESSAGE,
    identifyCliCandidate,
    isLegacyPiSessionMeta,
    migrateLegacyConfig,
    parseLegacyPiSessionContent,
    resolveBackendSelection,
} from '../core/configMigration.js';
import {getBackendCapabilities} from '../protocol.js';

function createMemorySettings(initial = {}) {
    const defaults = {
        'config-version': 0,
        'migration-notice': '',
        'backend': 'auto',
        'pi-path': 'pi',
        'pi-idle-minutes': 5,
        'zcode-path': '',
        'codex-path': '',
        'provider': '',
        'model': '',
        'reasoning-effort': 'default',
        'zcode-provider': '',
        'zcode-model': '',
        'zcode-reasoning-effort': 'default',
        'codex-provider': '',
        'codex-model': '',
        'codex-reasoning-effort': 'default',
        'openai-base-url': '',
        'openai-model': '',
        'openai-reasoning-effort': 'default',
    };
    const data = new Map(Object.entries({...defaults, ...initial}));
    return {
        data,
        hasKey: k => data.has(k),
        getString: k => String(data.get(k) ?? ''),
        setString: (k, v) => data.set(k, String(v)),
        getInt: k => Number(data.get(k) ?? 0),
        setInt: (k, v) => data.set(k, Number(v)),
    };
}

test('Stage A1: supported backends strictly exclude pi', () => {
    assert.deepEqual([...SUPPORTED_BACKENDS], ['auto', 'zcode', 'codex', 'dsh', 'openai']);
    assert.equal(getBackendCapabilities('zcode').supportsTools, true);
    assert.equal(getBackendCapabilities('codex').supportsTools, true);
    assert.equal(getBackendCapabilities('dsh').supportsTools, true);
    assert.equal(getBackendCapabilities('openai').supportsTools, false);
    // Falling through with unknown/removed 'pi' never grants local tools
    assert.equal(getBackendCapabilities('pi').supportsTools, false);
});

test('Stage A2: CLI identity verification distinguishes Pi, Codex, ZCode, and arbitrary/invalid paths', () => {
    const fakeFs = {
        '/usr/local/bin/pi': {exec: true, head: '#!/usr/bin/env node\nrequire("@mariozechner/pi-coding-agent")'},
        '/home/u/.local/bin/my-agent': {exec: true, link: '/home/u/.nvm/lib/node_modules/@mariozechner/pi-coding-agent/cli.js'},
        '/home/u/.npm-global/bin/codex': {exec: true, head: '#!/usr/bin/env node\n// @openai/codex'},
        '/opt/ZCode/resources/glm/zcode.cjs': {exec: false, head: '// ZCode CLI bundle'},
        '/usr/local/bin/zcode': {exec: true, head: '#!/usr/bin/env bash\nexec /opt/ZCode/zcode "$@"'},
        '/bin/ls': {exec: true, head: 'ELF', ver: 'ls (GNU coreutils) 9.1'},
    };
    const env = {
        fileExists: p => Boolean(fakeFs[p]),
        isDir: () => false,
        isExecutable: p => Boolean(fakeFs[p]?.exec),
        readLink: p => fakeFs[p]?.link || '',
        readFileHead: p => fakeFs[p]?.head || '',
        probeVersion: p => fakeFs[p]?.ver || '',
        hasZCodeNodeRuntime: () => true,
    };

    assert.equal(identifyCliCandidate('pi', env), 'pi');
    assert.equal(identifyCliCandidate('/usr/local/bin/pi', env), 'pi');
    assert.equal(identifyCliCandidate('/home/u/.local/bin/my-agent', env), 'pi');
    assert.equal(identifyCliCandidate('/home/u/.npm-global/bin/codex', env), 'codex');
    assert.equal(identifyCliCandidate('/opt/ZCode/resources/glm/zcode.cjs', env), 'zcode');
    assert.equal(identifyCliCandidate('/usr/local/bin/zcode', env), 'zcode');
    assert.equal(identifyCliCandidate('/bin/ls', env), 'unknown');
    assert.equal(identifyCliCandidate('/nonexistent/codex', env), 'unknown');
});

test('Stage A2: legacy backend=pi/auto/zcode/codex/openai configs migrate idempotently without losing provider/model', () => {
    const env = {
        fileExists: p => p === '/custom/bin/codex' || p === '/usr/local/bin/pi',
        isDir: () => false,
        isExecutable: p => p === '/custom/bin/codex' || p === '/usr/local/bin/pi',
        readLink: () => '',
        readFileHead: p => (p === '/custom/bin/codex' ? '@openai/codex' : '@mariozechner/pi-coding-agent'),
        probeVersion: () => '',
    };

    // 1. Legacy backend=pi -> auto + migration-notice; real pi path is NOT copied to zcode-path/codex-path; provider/model kept intact
    const piStore = createMemorySettings({
        'backend': 'pi',
        'pi-path': '/usr/local/bin/pi',
        'provider': 'anthropic',
        'model': 'claude-sonnet-4-5',
    });
    const rPi = migrateLegacyConfig(piStore, env);
    assert.equal(rPi.migrated, true);
    assert.equal(rPi.migratedFromPi, true);
    assert.equal(rPi.migratedCliIdentity, 'none');
    assert.equal(piStore.getString('backend'), 'auto');
    assert.equal(piStore.getString('migration-notice'), PI_MIGRATION_NOTICE);
    assert.equal(piStore.getString('zcode-path'), '');
    assert.equal(piStore.getString('codex-path'), '');
    assert.equal(piStore.getString('provider'), 'anthropic');
    assert.equal(piStore.getString('model'), 'claude-sonnet-4-5');
    assert.equal(piStore.getString('zcode-model'), '');
    assert.equal(piStore.getString('codex-model'), '');
    assert.equal(piStore.getInt('config-version'), CURRENT_CONFIG_VERSION);

    // Repeated call is strictly idempotent
    const rPiSecond = migrateLegacyConfig(piStore, env);
    assert.equal(rPiSecond.migrated, false);

    // 2. Legacy backend=codex with custom codex binary stored in old pi-path -> codex-path + codex-provider/model seeded
    const codexStore = createMemorySettings({
        'backend': 'codex',
        'pi-path': '/custom/bin/codex',
        'provider': 'openai',
        'model': 'gpt-5',
        'reasoning-effort': 'deep',
    });
    const rCodex = migrateLegacyConfig(codexStore, env);
    assert.equal(rCodex.migrated, true);
    assert.equal(rCodex.migratedFromPi, false);
    assert.equal(rCodex.migratedCliIdentity, 'codex');
    assert.equal(codexStore.getString('backend'), 'codex');
    assert.equal(codexStore.getString('codex-path'), '/custom/bin/codex');
    assert.equal(codexStore.getString('zcode-path'), '');
    assert.equal(codexStore.getString('codex-provider'), 'openai');
    assert.equal(codexStore.getString('codex-model'), 'gpt-5');
    assert.equal(codexStore.getString('codex-reasoning-effort'), 'deep');
    assert.equal(codexStore.getString('migration-notice'), '');

    // 3. Legacy backend=zcode -> zcode-provider/model seeded, shared preserved
    const zcodeStore = createMemorySettings({
        'backend': 'zcode',
        'provider': 'glm',
        'model': 'gpt-6-luna',
        'reasoning-effort': 'fast',
    });
    migrateLegacyConfig(zcodeStore, env);
    assert.equal(zcodeStore.getString('backend'), 'zcode');
    assert.equal(zcodeStore.getString('zcode-provider'), 'glm');
    assert.equal(zcodeStore.getString('zcode-model'), 'gpt-6-luna');
    assert.equal(zcodeStore.getString('zcode-reasoning-effort'), 'fast');

    // 4. Legacy backend=openai -> openai-model / openai-reasoning-effort seeded
    const openaiStore = createMemorySettings({
        'backend': 'openai',
        'openai-base-url': 'https://api.deepseek.com/v1',
        'model': 'deepseek-chat',
        'reasoning-effort': 'standard',
    });
    migrateLegacyConfig(openaiStore, env);
    assert.equal(openaiStore.getString('backend'), 'openai');
    assert.equal(openaiStore.getString('openai-model'), 'deepseek-chat');
    assert.equal(openaiStore.getString('openai-reasoning-effort'), 'standard');
});

test('Stage A2: backend selection handles 3 backends, 1 backend, 0 backends (unconfigured), and never silently switches explicit choice', () => {
    // All 3 available -> auto picks zcode -> codex -> openai
    const all3 = resolveBackendSelection(
        {configuredBackend: 'auto', openaiBaseUrl: 'http://localhost:11434/v1'},
        {hasZCode: () => true, hasCodex: () => true}
    );
    assert.equal(all3.effectiveBackend, 'zcode');
    assert.equal(all3.available, true);

    // Only Codex available
    const onlyCodex = resolveBackendSelection(
        {configuredBackend: 'auto'},
        {hasZCode: () => false, hasCodex: () => true}
    );
    assert.equal(onlyCodex.effectiveBackend, 'codex');
    assert.equal(onlyCodex.available, true);

    // Only OpenAI configured
    const onlyOpenAI = resolveBackendSelection(
        {configuredBackend: 'auto', openaiBaseUrl: 'https://api.openai.com/v1'},
        {hasZCode: () => false, hasCodex: () => false}
    );
    assert.equal(onlyOpenAI.effectiveBackend, 'openai');
    assert.equal(onlyOpenAI.available, true);

    // Zero backends installed/configured -> explicit 'unconfigured', NEVER phantom 'zcode'
    const none = resolveBackendSelection(
        {configuredBackend: 'auto', openaiBaseUrl: ''},
        {hasZCode: () => false, hasCodex: () => false}
    );
    assert.equal(none.effectiveBackend, 'unconfigured');
    assert.equal(none.available, false);
    assert.equal(none.reason, UNCONFIGURED_BACKEND_MESSAGE);

    // Explicitly chosen backend NEVER silently switches to another available backend
    const explicitCodexMissing = resolveBackendSelection(
        {configuredBackend: 'codex', codexPath: '/bad/codex', openaiBaseUrl: 'https://api.openai.com/v1'},
        {hasZCode: () => true, hasCodex: () => false}
    );
    assert.equal(explicitCodexMissing.effectiveBackend, 'codex');
    assert.equal(explicitCodexMissing.available, false);
    assert.ok(explicitCodexMissing.reason.includes('/bad/codex'));
});

test('Stage A2: legacy Pi session meta clears remoteSessionId and Pi JSONL imports read-only safely', () => {
    assert.equal(isLegacyPiSessionMeta({backend: 'pi', remoteSessionId: 'pi_sess_1'}), true);
    assert.equal(isLegacyPiSessionMeta({backend: 'zcode', modelSignature: 'pi:anthropic:claude', remoteSessionId: 'pi_sess_2'}), true);
    assert.equal(isLegacyPiSessionMeta({backend: 'zcode', modelSignature: 'zcode:openai:gpt-6'}), false);

    const samplePiJsonl = [
        JSON.stringify({type: 'session', id: 'pi-uuid-1', timestamp: '2026-10-01T10:00:00Z'}),
        JSON.stringify({
            type: 'message',
            timestamp: '2026-10-01T10:01:00Z',
            message: {
                role: 'user',
                content: '[Ubuntu GNOME 用户目录环境：主目录(HOME)=/home/u]\n帮我解释 systemctl',
            },
        }),
        JSON.stringify({
            type: 'message',
            timestamp: '2026-10-01T10:01:05Z',
            message: {
                role: 'toolResult',
                content: 'should not be imported as chat bubble',
            },
        }),
        JSON.stringify({
            type: 'message',
            timestamp: '2026-10-01T10:01:08Z',
            message: {
                role: 'assistant',
                content: [
                    {type: 'thinking', thinking: '用户询问 systemctl 基本用法'},
                    {type: 'text', text: '`systemctl` 是 systemd 的主管理命令。'},
                ],
            },
        }),
    ].join('\n');

    const imported = parseLegacyPiSessionContent(samplePiJsonl);
    assert.equal(imported.ok, true);
    assert.equal(imported.messages.length, 2);
    assert.equal(imported.messages[0].role, 'user');
    assert.equal(imported.messages[0].content, '帮我解释 systemctl');
    assert.equal(imported.messages[1].role, 'assistant');
    assert.equal(imported.messages[1].importedFrom, 'pi-readonly');

    const unparseable = parseLegacyPiSessionContent('not json at all\n<<<corrupt>>>');
    assert.equal(unparseable.ok, false);
    assert.equal(unparseable.messages.length, 0);
    assert.ok(unparseable.error.includes('已保留原始文件'));
});
