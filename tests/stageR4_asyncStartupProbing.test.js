import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {registerGiMocks} from './helpers/giMockLoader.js';

registerGiMocks();

const Gio = (await import('gi://Gio')).default;
const {parseLinuxProcStat} = await import('../runtime/cliProcessRunner.js');
const {
    detectBackendSelection,
    detectBackendSelectionAsync,
    invalidateBackendDetectionCaches,
    peekBackendSelection,
    peekEffectiveBackend,
    probeCliCapabilitiesAsync,
    runShortProbeCommandAsync,
} = await import('../core/backendDetect.js');
const {
    BackendClient,
    resolveBackendRuntimeAsync,
} = await import('../backendClient.js');
const {ChatController} = await import('../core/chatController.js');

function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 1) return false;
    try {
        process.kill(pid, 0);
    } catch (_) {
        return false;
    }
    try {
        const statText = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const parsed = parseLinuxProcStat(statText);
        if (parsed?.state === 'Z') return false;
    } catch (_) {}
    return true;
}

test('R4.1: Fake CLI --help sleeping 5s with child keeping stdout open never blocks 20ms heartbeat, times out on deadline, and kills process group', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-r4-sleep-'));
    try {
        invalidateBackendDetectionCaches('all');
        globalThis.__qcSyncCommunicateCount = 0;

        const pidLogFile = path.join(tmpRoot, 'probe-pids.jsonl');
        const sleepingZCode = path.join(tmpRoot, 'zcode');
        await fs.writeFile(
            sleepingZCode,
            `#!/usr/bin/env node
'use strict';
const {spawn} = require('node:child_process');
const fs = require('node:fs');

// Identify as ZCode when readFileHeadAsync reads the top of this script:
// @zcode/cli Zhipu AI Coding Agent
const args = process.argv.slice(2);
const child = spawn(process.execPath, [
    '-e',
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
], {
    stdio: ['ignore', 'pipe', 'ignore'],
});
fs.appendFileSync(${JSON.stringify(pidLogFile)}, JSON.stringify({
    leaderPid: process.pid,
    childPid: child.pid,
    args,
}) + '\\n', 'utf8');

process.on('SIGTERM', () => {
    process.exit(0);
});
// Sleep 5 seconds without exiting
setTimeout(() => process.exit(0), 5000);
`,
            {mode: 0o755}
        );

        // Start a 20ms main-loop heartbeat monitor
        const heartbeatDeltas = [];
        let lastTick = Date.now();
        let heartbeatRunning = true;
        const hbTimer = setInterval(() => {
            if (!heartbeatRunning) return;
            const now = Date.now();
            heartbeatDeltas.push(now - lastTick);
            lastTick = now;
        }, 20);

        const startMs = Date.now();
        const caps = await probeCliCapabilitiesAsync('zcode', [sleepingZCode], {}, {
            timeoutMs: 220,
        });
        const elapsedMs = Date.now() - startMs;

        heartbeatRunning = false;
        clearInterval(hbTimer);

        // 1. Zero synchronous communicate_utf8 calls
        assert.equal(
            globalThis.__qcSyncCommunicateCount,
            0,
            'Cold-start CLI probing must NEVER invoke synchronous communicate_utf8 on the main thread'
        );

        // 2. Heartbeat kept ticking continuously while CLI slept 5s
        assert.ok(heartbeatDeltas.length >= 6, `20ms heartbeat must tick continuously during probe (got ${heartbeatDeltas.length} ticks)`);
        const maxGapMs = Math.max(...heartbeatDeltas);
        assert.ok(maxGapMs < 180, `Main loop heartbeat must not stall (max gap was ${maxGapMs}ms)`);

        // 3. Probe completed near the deadline (~220ms per probe call) rather than waiting 5000ms
        assert.ok(elapsedMs < 2500, `Probe must finish by deadline instead of waiting 5s (elapsed ${elapsedMs}ms)`);
        assert.equal(caps.probed, false, 'Timed-out --help probe must report probed: false fallback capabilities');

        // 4. Both the leader and the SIGTERM-ignoring child process in the probe's isolated process group must be killed!
        const rawLogs = (await fs.readFile(pidLogFile, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
        assert.ok(rawLogs.length >= 1);
        await new Promise(r => setTimeout(r, 150));
        for (const rec of rawLogs) {
            assert.equal(isPidAlive(rec.leaderPid), false, `Probe leader PID ${rec.leaderPid} must be terminated on timeout`);
            assert.equal(isPidAlive(rec.childPid), false, `Probe child PID ${rec.childPid} must be killed via isolated process group on timeout`);
        }
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('R4.2: detectBackendSelectionAsync never falls back to sync readFileHeadSync or probeCliVersionSync across ~ paths and symlinks', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-r4-nosync-'));
    try {
        invalidateBackendDetectionCaches('all');
        globalThis.__qcSyncCommunicateCount = 0;

        // Create an ELF-like header binary wrapper or script where head does not match, forcing --version probe
        const realBin = path.join(tmpRoot, 'real-codex-bin');
        await fs.writeFile(
            realBin,
            `#!/usr/bin/env node
// Generic wrapper without brand keywords in first 2KB
${'// padding '.repeat(220)}
if (process.argv.includes('--version')) {
    process.stdout.write('codex-cli 0.42.0 (OpenAI Codex)\\n');
    process.exit(0);
}
process.exit(0);
`,
            {mode: 0o755}
        );

        const symlinkBin = path.join(tmpRoot, 'codex-link');
        await fs.symlink(realBin, symlinkBin);

        // Cold cache peek must NOT spawn any process or block
        const coldPeek = peekBackendSelection({
            configuredBackend: 'codex',
            codexPath: symlinkBin,
        });
        assert.equal(coldPeek.fromCache, false);
        assert.equal(coldPeek.detecting, true);
        assert.equal( ColdPeekBackend(coldPeek), 'codex');
        assert.equal(globalThis.__qcSyncCommunicateCount, 0);

        const selection = await detectBackendSelectionAsync(
            {
                configuredBackend: 'codex',
                codexPath: symlinkBin,
            },
            {forceRefresh: true}
        );
        assert.equal(selection.effectiveBackend, 'codex');
        assert.equal(selection.available, true);
        assert.equal(
            globalThis.__qcSyncCommunicateCount,
            0,
            'detectBackendSelectionAsync must NEVER fall back to probeCliVersionSync'
        );

        // Warm cache peek now returns cached result synchronously
        const warmPeek = peekBackendSelection({
            configuredBackend: 'codex',
            codexPath: symlinkBin,
        });
        assert.equal(warmPeek.fromCache, true);
        assert.equal(warmPeek.detecting, false);
        assert.equal(warmPeek.effectiveBackend, 'codex');
        assert.equal(
            peekEffectiveBackend('codex', {codexPath: symlinkBin}),
            'codex'
        );
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

function ColdPeekBackend(peekResult) {
    return peekResult.effectiveBackend;
}

test('R4.3: runShortProbeCommandAsync enforces bounded stream reading and probeCliCapabilitiesAsync deduplicates single-flight & invalidates on mtime change', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-r4-bounded-'));
    try {
        invalidateBackendDetectionCaches('all');

        // 1. Fake CLI that streams 2 MiB of stdout without exiting
        const floodScript = path.join(tmpRoot, 'flood-help.mjs');
        await fs.writeFile(
            floodScript,
            `#!/usr/bin/env node
const chunk = '--output-format --prompt --cwd --mode --resume\\n'.repeat(400);
const timer = setInterval(() => {
    try {
        process.stdout.write(chunk);
    } catch (_) {
        clearInterval(timer);
        process.exit(0);
    }
}, 5);
`,
            {mode: 0o755}
        );

        const boundedOut = await runShortProbeCommandAsync([floodScript], {}, 512, {
            maxBytes: 4096,
            timeoutMs: 1200,
        });
        assert.ok(boundedOut.length > 0 && boundedOut.length <= 512, `Bounded output length must be <= 512 chars (got ${boundedOut.length})`);
        assert.match(boundedOut, /--output-format/);

        // 2. Single-flight deduplication and mtime invalidation in probeCliCapabilitiesAsync
        const countFile = path.join(tmpRoot, 'probe-count.txt');
        const fakeZCode = path.join(tmpRoot, 'zcode-caps.mjs');
        const writeFakeZCode = async (extraFlag = '') => {
            await fs.writeFile(
                fakeZCode,
                `#!/usr/bin/env node
import fs from 'node:fs';
// @zcode/cli
fs.appendFileSync(${JSON.stringify(countFile)}, '1\\n', 'utf8');
const args = process.argv.slice(2);
setTimeout(() => {
    if (args.includes('--version')) {
        process.stdout.write('zcode 2.1.0\\n');
    } else {
        process.stdout.write('Options: --output-format --prompt --cwd --mode --resume ${extraFlag}\\n');
    }
    process.exit(0);
}, 40);
`,
                {mode: 0o755}
            );
        };

        await writeFakeZCode('');

        // Launch 4 concurrent capability probes -> single-flight must coalesce them!
        const [c1, c2, c3, c4] = await Promise.all([
            probeCliCapabilitiesAsync('zcode', [fakeZCode]),
            probeCliCapabilitiesAsync('zcode', [fakeZCode]),
            probeCliCapabilitiesAsync('zcode', [fakeZCode]),
            probeCliCapabilitiesAsync('zcode', [fakeZCode]),
        ]);
        assert.equal(c1.probed, true);
        assert.equal(c1.supportsDisallowedTools, false);
        assert.deepEqual(c1, c2);
        assert.deepEqual(c2, c3);
        assert.deepEqual(c3, c4);

        const invocationsAfterBatch1 = (await fs.readFile(countFile, 'utf8')).trim().split('\n').length;
        // 1 for --version + 1 for --help = 2 process spawns total across all 4 concurrent callers!
        assert.equal(invocationsAfterBatch1, 2, 'Concurrent probeCliCapabilitiesAsync calls must be single-flight deduplicated');

        // Modify the CLI script on disk (advancing mtime & size to simulate CLI upgrade adding --disallowed-tools)
        await new Promise(r => setTimeout(r, 20));
        await writeFakeZCode('--disallowed-tools --workflow-mode --toolsearch-mode');
        const futureTime = new Date(Date.now() + 5000);
        await fs.utimes(fakeZCode, futureTime, futureTime);

        const upgradedCaps = await probeCliCapabilitiesAsync('zcode', [fakeZCode]);
        assert.equal(upgradedCaps.supportsDisallowedTools, true, 'Capability cache must auto-invalidate when CLI binary mtime/size changes');
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('R4.4: ChatController.ensureConnected awaits BackendClient.startAsync and cancels cleanly on close/lock/backend-switch without polluting new connection', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-r4-controller-'));
    try {
        invalidateBackendDetectionCaches('all');

        // Slow ZCode CLI whose probe takes 600ms
        const slowZCode = path.join(tmpRoot, 'slow-zcode');
        await fs.writeFile(
            slowZCode,
            `#!/usr/bin/env node
// @zcode/cli Zhipu
setTimeout(() => {
    if (process.argv.includes('--version')) {
        process.stdout.write('zcode 2.0.0\\n');
    } else {
        process.stdout.write('--output-format --prompt --cwd --mode --resume --disallowed-tools\\n');
    }
    process.exit(0);
}, 600);
`,
            {mode: 0o755}
        );

        let currentConfig = {
            backend: 'zcode',
            zcodePath: slowZCode,
            codexPath: '',
            openaiBaseUrl: 'https://api.example.com/v1',
            openaiModel: 'gpt-4.1-mini',
            mode: 'readonly',
        };

        const stateChanges = [];
        const connectingEvents = [];
        const controller = new ChatController({
            createClient: (onEvent, onExit) => new BackendClient(onEvent, onExit),
            loadRuntimeEnvironment: async () => ({
                config: {...currentConfig},
                workspace: tmpRoot,
                sessionsDir: tmpRoot,
                sessionId: 'sess_r4_switch',
            }),
            onEvent: () => {},
            onStateChanged: info => stateChanges.push(info),
            onConnectionError: () => {},
            onConnecting: info => connectingEvents.push(info),
        });
        controller.beginLifecycle(1);

        // Start connecting to slow ZCode (cold cache)
        const firstConnectPromise = controller.ensureConnected({canConnect: () => true});

        // After 60ms (while slowZCode probe is still in-flight), user switches backend to OpenAI (or locks screen / stops client)
        await new Promise(r => setTimeout(r, 60));
        controller.stopClient();

        const firstResult = await firstConnectPromise;
        assert.equal(firstResult, null, 'Cancelled cold-start connection must resolve to null');
        assert.equal(stateChanges.length, 0, 'Cancelled connection must NOT emit onStateChanged');

        // Now switch config to OpenAI and connect immediately
        currentConfig = {
            ...currentConfig,
            backend: 'openai',
        };
        const secondResult = await controller.ensureConnected({canConnect: () => true});
        assert.ok(secondResult, 'Subsequent connection after cancellation must succeed');
        assert.equal(secondResult.state.backend, 'openai');
        assert.equal(stateChanges.length, 1);
        assert.equal(stateChanges[0].state.backend, 'openai');

        // Wait past the original 600ms window to ensure late callbacks from first probe never overwrite OpenAI state
        await new Promise(r => setTimeout(r, 620));
        assert.equal(controller.lastState.backend, 'openai');
        assert.equal(stateChanges.length, 1);

        controller.dispose();
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('R4.5: a synchronous unavailable result must not suppress later async CLI discovery', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-r4-cache-'));
    try {
        invalidateBackendDetectionCaches('all');
        const customCodex = path.join(tmpRoot, 'custom-cli');
        const initial = detectBackendSelection({
            configuredBackend: 'codex',
            codexPath: customCodex,
        });
        assert.equal(initial.available, false, 'Missing CLI correctly appears unavailable');

        // Simulate installation after a Preferences/UI synchronous inspection.
        // The authoritative async probe must not reuse the earlier negative result.
        await fs.writeFile(customCodex, `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('codex-cli 0.99.0');
if (process.argv.includes('--help')) console.log('codex exec --json --sandbox read-only');
`, {mode: 0o755});

        const resolved = await detectBackendSelectionAsync({
            configuredBackend: 'codex',
            codexPath: customCodex,
        });
        assert.equal(resolved.effectiveBackend, 'codex');
        assert.equal(resolved.available, true, 'Async detection must discover a newly available CLI');
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('QA-06: explicit OpenAI selection never executes local CLI identity probes', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-openai-no-cli-'));
    const marker = path.join(tmpRoot, 'was-probed');
    try {
        invalidateBackendDetectionCaches('all');
        const cliPaths = {};
        for (const name of ['zcode', 'codex']) {
            const cliPath = path.join(tmpRoot, name);
            await fs.writeFile(cliPath, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'probe\\n');
console.log('no probe expected');
`, {mode: 0o755});
            cliPaths[name] = cliPath;
        }
        const selection = await detectBackendSelectionAsync({
            configuredBackend: 'openai',
            zcodePath: cliPaths.zcode,
            codexPath: cliPaths.codex,
            openaiBaseUrl: 'https://api.example.test/v1',
        }, {forceRefresh: true});
        assert.equal(selection.effectiveBackend, 'openai');
        assert.equal(selection.available, true);
        assert.equal(fsSync.existsSync(marker), false,
            'Explicit API configuration must skip all ZCode/Codex subprocess probes');
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('DSH: custom wrapper is accepted only when its actual headless help supports our JSONL contract', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-dsh-wrapper-'));
    try {
        const wrapper = path.join(tmpRoot, 'my-deepseek-wrapper');
        await fs.writeFile(wrapper, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: dsh --profile headless [options] [task...]');
  console.log('--json --session-id --permission-mode --approval-policy');
} else if (args.includes('--version')) {
  console.log('deepseek-harness 0.2.0');
}
`, {mode: 0o755});
        invalidateBackendDetectionCaches('all');
        const good = await detectBackendSelectionAsync({
            configuredBackend: 'dsh', dshPath: wrapper,
        }, {forceRefresh: true});
        assert.equal(good.effectiveBackend, 'dsh');
        assert.equal(good.available, true);
        assert.equal(good.executable, wrapper);

        // A deceptive wrapper filename must not be enough to pass capability detection.
        const bogus = path.join(tmpRoot, 'dsh');
        await fs.writeFile(bogus, `#!/usr/bin/env node
console.log('not the official dsh headless interface');
`, {mode: 0o755});
        const invalid = await detectBackendSelectionAsync({
            configuredBackend: 'dsh', dshPath: bogus,
        }, {forceRefresh: true});
        assert.equal(invalid.available, false);
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});

test('DSH: auto mode falls back to a verified DSH before OpenAI if ZCode and Codex are missing', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qc-dsh-auto-'));
    try {
        const customDsh = path.join(tmpRoot, 'custom-headless');
        await fs.writeFile(customDsh, `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  console.log('Usage: dsh --profile headless [options] [task...]');
  console.log('--json --session-id --permission-mode --approval-policy');
}
`, {mode: 0o755});
        invalidateBackendDetectionCaches('all');
        const found = await detectBackendSelectionAsync({
            configuredBackend: 'auto',
            zcodePath: path.join(tmpRoot, 'missing-zcode'),
            codexPath: path.join(tmpRoot, 'missing-codex'),
            dshPath: customDsh,
            openaiBaseUrl: 'https://api.example.test/v1',
        }, {forceRefresh: true});
        assert.equal(found.effectiveBackend, 'dsh');
        assert.equal(found.available, true);
        assert.equal(found.executable, customDsh);
    } finally {
        await fs.rm(tmpRoot, {recursive: true, force: true});
    }
});
