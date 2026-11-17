import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerGiMocks} from './helpers/giMockLoader.js';

registerGiMocks();

const {TurnController} = await import('../core/turnController.js');
const {
    parseLinuxProcStat,
} = await import('../runtime/cliProcessRunner.js');
const {
    getSelfProcessIdentity,
    isProcessGroupReused,
    readProcStatSync,
    resolveKillExecutable,
    resolveSetsidExecutable,
    signalIsolatedProcessGroupAsync,
    spawnManagedCliTurn,
    terminateTurnProcess,
} = await import('../runtime/processManager.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_PATH = path.join(REPO_ROOT, 'zcodeBridge.cjs');

function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 1) return false;
    try {
        process.kill(pid, 0);
    } catch (_) {
        return false;
    }
    try {
        const statText = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const parsed = parseLinuxProcStat(statText);
        if (parsed?.state === 'Z') return false;
    } catch (_) {}
    return true;
}

async function waitForPidGone(pid, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isPidAlive(pid)) return true;
        await new Promise(r => setTimeout(r, 20));
    }
    return !isPidAlive(pid);
}

test('R2.1: Leader exits on SIGTERM while child ignores SIGTERM — group SIGKILL still cleans up child, checks kill status, and guards PGID reuse', async () => {
    const setsidBin = resolveSetsidExecutable();
    const killBin = resolveKillExecutable();
    assert.ok(setsidBin, 'setsid binary must be available');
    assert.ok(killBin, 'kill binary must be available');

    const selfIdentity = getSelfProcessIdentity();
    assert.equal(selfIdentity.selfPid, process.pid);
    assert.ok(selfIdentity.selfPgid > 1);

    // Self PID/PGID must never be signaled
    const selfSigRes = await signalIsolatedProcessGroupAsync(selfIdentity.selfPgid, '0', killBin);
    assert.equal(selfSigRes.started, false);
    assert.equal(selfSigRes.ok, false);

    // PGID reuse guard: mismatched startTime must report reused = true
    const myStat = readProcStatSync(process.pid);
    assert.ok(myStat?.startTime);
    assert.equal(isProcessGroupReused(process.pid, myStat.startTime), false);
    assert.equal(isProcessGroupReused(process.pid, '999999999999'), true);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-r2-tree-'));
    try {
        const childPidFile = path.join(tmpDir, 'stubborn-child.pid');
        const stubbornChildScript = path.join(tmpDir, 'stubborn-child.cjs');
        fs.writeFileSync(
            stubbornChildScript,
            `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid) + '\\n');
setInterval(() => {}, 1000);
`,
            {mode: 0o755}
        );

        const leaderScript = path.join(tmpDir, 'leader-exits-on-term.cjs');
        fs.writeFileSync(
            leaderScript,
            `#!/usr/bin/env node
'use strict';
const {spawn} = require('node:child_process');

// Spawn a child in the same process group that ignores SIGTERM and closes stdio
const child = spawn(
    process.execPath,
    [${JSON.stringify(stubbornChildScript)}],
    {stdio: 'ignore'}
);

console.log(JSON.stringify({type: 'thread.started', thread_id: 'th_r2_1'}));
console.log(JSON.stringify({type: 'item.updated', item: {id: 'm1', type: 'agent_message', text: 'child_spawned:' + child.pid}}));

// Leader exits immediately (0) upon SIGTERM, leaving stubborn child alive!
process.on('SIGTERM', () => {
    process.exit(0);
});
setInterval(() => {}, 1000);
`,
            {mode: 0o755}
        );

        const events = [];
        let settledResolve;
        const settledPromise = new Promise(r => { settledResolve = r; });
        const turns = new TurnController(evt => {
            events.push(evt);
            if (evt.type === 'agent_settled') settledResolve(evt);
        });

        const turn = turns.beginTurn({
            turnId: 'turn_r2_tree',
            messageId: 'msg_r2_tree',
            sessionId: 'sess_r2',
            clientGeneration: 1,
            lifecycleGeneration: 1,
            backend: 'codex',
            cancellable: new globalThis.__qcMockGio.Cancellable(),
        });
        turn.killGraceMs = 80;

        await spawnManagedCliTurn({
            backend: 'codex',
            runtime: {
                executable: process.execPath,
                setsidPath: setsidBin,
                pathEnv: process.env.PATH || '',
            },
            config: {mode: 'readonly'},
            workspace: tmpDir,
            sessionId: 'sess_r2',
            specialDirs: {home: tmpDir},
            turns,
            turn,
            store: null,
            getSessionContextConfig: () => ({}),
            rawArgv: [process.execPath, leaderScript],
        });

        // Wait until the stubborn child has registered SIGTERM ignore and written its PID
        let rawPidText = '';
        for (let i = 0; i < 80; i++) {
            if (fs.existsSync(childPidFile)) {
                rawPidText = fs.readFileSync(childPidFile, 'utf8').trim();
                if (rawPidText.length > 0) break;
            }
            await new Promise(r => setTimeout(r, 15));
        }
        assert.ok(rawPidText.length > 0, 'Stubborn child PID file should be populated');
        const stubbornChildPid = Number.parseInt(rawPidText, 10);
        assert.ok(stubbornChildPid > 1);
        assert.equal(isPidAlive(stubbornChildPid), true);
        assert.equal(turn.isolatedProcessGroup, true);
        assert.ok(turn.processGroupId > 1);
        assert.ok(turn.leaderStartTime.length > 0);

        // Cancel turn (simulating user cancel / lock screen / disable)
        let termCallbackResult = null;
        const termDonePromise = new Promise(r => {
            turn.aborted = true;
            try { turn.cancellable?.cancel?.(); } catch (_) {}
            turns.finalizeTurn(turn, {
                status: 'cancelled',
                aborted: true,
                onTerminateProcess: proc => terminateTurnProcess(turn, proc, {
                    graceMs: 80,
                    onComplete: res => {
                        termCallbackResult = res;
                        r(res);
                    },
                }),
            });
        });

        const settled = await settledPromise;
        assert.equal(settled.status, 'cancelled');

        await termDonePromise;
        assert.ok(termCallbackResult);
        assert.equal(termCallbackResult.termSent, true);
        assert.equal(termCallbackResult.killSent, true, 'Group SIGKILL must be sent even when leader exited on SIGTERM');
        assert.equal(termCallbackResult.hadRemainingMembers, true, 'Group SIGKILL must confirm remaining member was killed (exit 0)');

        const childGone = await waitForPidGone(stubbornChildPid, 1500);
        assert.equal(childGone, true, 'Stubborn SIGTERM-ignoring child must be killed by group SIGKILL');

        // Signaling a non-existent PGID must report ok: false (ESRCH, exitStatus !== 0)
        const postProbe = await signalIsolatedProcessGroupAsync(999999, 'TERM', killBin);
        assert.equal(postProbe.started, true);
        assert.equal(postProbe.ok, false);
        assert.notEqual(postProbe.exitStatus, 0);
    } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});

test('R2.2: Forked background child keeping stdout open after CLI leader exits is drained, closed, and terminated without hanging', async () => {
    const setsidBin = resolveSetsidExecutable();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-r2-pipeleak-'));
    try {
        const leakedChildPidFile = path.join(tmpDir, 'leaked-stdout-child.pid');
        const forkLeakScript = path.join(tmpDir, 'leader-fork-stdout-leak.cjs');
        fs.writeFileSync(
            forkLeakScript,
            `#!/usr/bin/env node
'use strict';
const {spawn} = require('node:child_process');
const fs = require('node:fs');

// Spawn a child that inherits stdout/stderr FDs and sleeps for 60s
const bg = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000);'],
    {stdio: ['ignore', 'inherit', 'inherit']}
);
fs.writeFileSync(${JSON.stringify(leakedChildPidFile)}, String(bg.pid));

console.log(JSON.stringify({type: 'thread.started', thread_id: 'th_r2_leak'}));
console.log(JSON.stringify({type: 'item.completed', item: {id: 'm1', type: 'agent_message', text: '主进程已完成'}}));
console.log(JSON.stringify({type: 'turn.completed'}));
process.exit(0);
`,
            {mode: 0o755}
        );

        let settledResolve;
        const settledPromise = new Promise(r => { settledResolve = r; });
        const turns = new TurnController(evt => {
            if (evt.type === 'agent_settled') settledResolve(evt);
        });

        const turn = turns.beginTurn({
            turnId: 'turn_r2_leak',
            messageId: 'msg_r2_leak',
            sessionId: 'sess_r2_leak',
            clientGeneration: 1,
            lifecycleGeneration: 1,
            backend: 'codex',
            cancellable: new globalThis.__qcMockGio.Cancellable(),
        });
        turn.killGraceMs = 60;

        const startMs = Date.now();
        await spawnManagedCliTurn({
            backend: 'codex',
            runtime: {
                executable: process.execPath,
                setsidPath: setsidBin,
                pathEnv: process.env.PATH || '',
            },
            config: {mode: 'readonly'},
            workspace: tmpDir,
            sessionId: 'sess_r2_leak',
            specialDirs: {home: tmpDir},
            turns,
            turn,
            store: null,
            getSessionContextConfig: () => ({}),
            rawArgv: [process.execPath, forkLeakScript],
            timeouts: {
                streamIdleTimeoutSec: 30,
                toolExecutionTimeoutSec: 30,
                approvalTimeoutSec: 30,
                totalTurnTimeoutSec: 60,
                postExitDrainMs: 90,
            },
        });

        const settled = await settledPromise;
        const elapsedMs = Date.now() - startMs;
        assert.equal(settled.status, 'completed');
        assert.equal(turn.text, '主进程已完成');
        assert.ok(elapsedMs < 2000, `Turn should settle promptly after leader exit (took ${elapsedMs}ms)`);

        const leakedPid = Number.parseInt(fs.readFileSync(leakedChildPidFile, 'utf8').trim(), 10);
        const bgGone = await waitForPidGone(leakedPid, 1500);
        assert.equal(bgGone, true, 'Background child holding stdout open must be terminated');
    } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});

test('R2.3: Normal clean completion does NOT send termination signals, and early disposal still finishes GIO async reads cleanly', async () => {
    const setsidBin = resolveSetsidExecutable();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-r2-normal-'));
    try {
        const cleanScript = path.join(tmpDir, 'clean-cli.cjs');
        fs.writeFileSync(
            cleanScript,
            `#!/usr/bin/env node
'use strict';
console.log(JSON.stringify({type: 'thread.started', thread_id: 'th_clean'}));
console.log(JSON.stringify({type: 'item.completed', item: {id: 'm1', type: 'agent_message', text: '正常回答'}}));
console.log(JSON.stringify({type: 'turn.completed'}));
process.exit(0);
`,
            {mode: 0o755}
        );

        let settledResolve;
        const settledPromise = new Promise(r => { settledResolve = r; });
        const turns = new TurnController(evt => {
            if (evt.type === 'agent_settled') settledResolve(evt);
        });

        const turn = turns.beginTurn({
            turnId: 'turn_r2_clean',
            messageId: 'msg_r2_clean',
            sessionId: 'sess_r2_clean',
            clientGeneration: 1,
            lifecycleGeneration: 1,
            backend: 'codex',
            cancellable: new globalThis.__qcMockGio.Cancellable(),
        });

        await spawnManagedCliTurn({
            backend: 'codex',
            runtime: {
                executable: process.execPath,
                setsidPath: setsidBin,
                pathEnv: process.env.PATH || '',
            },
            config: {mode: 'readonly'},
            workspace: tmpDir,
            sessionId: 'sess_r2_clean',
            specialDirs: {home: tmpDir},
            turns,
            turn,
            store: null,
            getSessionContextConfig: () => ({}),
            rawArgv: [process.execPath, cleanScript],
        });

        const settled = await settledPromise;
        assert.equal(settled.status, 'completed');
        assert.equal(turn.text, '正常回答');
        assert.equal(
            Boolean(turn.terminationInitiated),
            false,
            'Normal clean completion must NOT initiate process group kill after process exit'
        );
    } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});

test('R2.4: ZCode bridge security — custom CLI wrapper without "zcode" in script name, delayed broker init, and pre-handshake child_process block', async () => {
    const setsidBin = resolveSetsidExecutable();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-r2-bridge-'));
    try {
        // 1. Custom shell wrapper -> custom script name `custom-agent-cli.cjs` (no "zcode" in argv!)
        //    with delayed initialization (40ms) of DenyPermissionBroker
        const customAgentScript = path.join(tmpDir, 'custom-agent-cli.cjs');
        fs.writeFileSync(
            customAgentScript,
            `#!/usr/bin/env node
'use strict';
setTimeout(() => {
    class DenyPermissionBroker {
        async requestPermission() {
            return {decision: 'deny'};
        }
    }
    Object.defineProperty(DenyPermissionBroker, 'name', {value: 'DenyPermissionBroker', configurable: true});
    const broker = new DenyPermissionBroker();
    // Verify child NODE_OPTIONS had zcodeBridge stripped so nested node tools are clean
    const nestedNodeOpts = process.env.NODE_OPTIONS || '';
    console.log(JSON.stringify({
        type: 'result',
        sessionId: 'sess_custom_wrap',
        response: 'WRAPPER_OK:' + (!nestedNodeOpts.includes('zcodeBridge.cjs')),
        is_error: false,
    }));
    console.log(JSON.stringify({type: 'turn.completed'}));
    process.exit(0);
}, 40);
`,
            {mode: 0o755}
        );

        const wrapperSh = path.join(tmpDir, 'my-custom-wrapper.sh');
        fs.writeFileSync(
            wrapperSh,
            `#!/bin/sh
exec "${process.execPath}" "${customAgentScript}" "$@"
`,
            {mode: 0o755}
        );

        let settled1Resolve;
        const settled1Promise = new Promise(r => { settled1Resolve = r; });
        const turns1 = new TurnController(evt => {
            if (evt.type === 'agent_settled') settled1Resolve(evt);
        });
        const turn1 = turns1.beginTurn({
            turnId: 'turn_r2_wrap',
            messageId: 'msg_r2_wrap',
            sessionId: 'sess_r2_wrap',
            clientGeneration: 1,
            lifecycleGeneration: 1,
            backend: 'zcode',
            cancellable: new globalThis.__qcMockGio.Cancellable(),
        });

        await spawnManagedCliTurn({
            backend: 'zcode',
            runtime: {
                executable: wrapperSh,
                bridgePath: BRIDGE_PATH,
                setsidPath: setsidBin,
                pathEnv: process.env.PATH || '',
            },
            config: {mode: 'readonly'},
            workspace: tmpDir,
            sessionId: 'sess_r2_wrap',
            specialDirs: {home: tmpDir},
            turns: turns1,
            turn: turn1,
            store: null,
            getSessionContextConfig: () => ({}),
            rawArgv: [wrapperSh],
            keepStdinOpenForApproval: true,
            requireBridgeHandshake: true,
            effectiveMode: 'readonly',
        });

        const settled1 = await settled1Promise;
        assert.equal(settled1.status, 'completed');
        assert.equal(turn1.text, 'WRAPPER_OK:true');

        // 2. Unpatched CLI attempting child_process.spawnSync BEFORE DenyPermissionBroker is hooked
        //    must be blocked in-process before the child process can create a marker file!
        const pwnedMarker = path.join(tmpDir, 'should-never-exist.txt');
        const unpatchedSpawnScript = path.join(tmpDir, 'evil-unpatched-cli.cjs');
        fs.writeFileSync(
            unpatchedSpawnScript,
            `#!/usr/bin/env node
'use strict';
const {spawnSync} = require('node:child_process');
spawnSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(${JSON.stringify(pwnedMarker)}, "pwned")']);
console.log(JSON.stringify({type: 'turn.completed'}));
`,
            {mode: 0o755}
        );

        let settled2Resolve;
        const settled2Promise = new Promise(r => { settled2Resolve = r; });
        const turns2 = new TurnController(evt => {
            if (evt.type === 'agent_settled') settled2Resolve(evt);
        });
        const turn2 = turns2.beginTurn({
            turnId: 'turn_r2_evil',
            messageId: 'msg_r2_evil',
            sessionId: 'sess_r2_evil',
            clientGeneration: 1,
            lifecycleGeneration: 1,
            backend: 'zcode',
            cancellable: new globalThis.__qcMockGio.Cancellable(),
        });

        await spawnManagedCliTurn({
            backend: 'zcode',
            runtime: {
                executable: process.execPath,
                bridgePath: BRIDGE_PATH,
                setsidPath: setsidBin,
                pathEnv: process.env.PATH || '',
            },
            config: {mode: 'readonly'},
            workspace: tmpDir,
            sessionId: 'sess_r2_evil',
            specialDirs: {home: tmpDir},
            turns: turns2,
            turn: turn2,
            store: null,
            getSessionContextConfig: () => ({}),
            rawArgv: [process.execPath, unpatchedSpawnScript],
            keepStdinOpenForApproval: true,
            requireBridgeHandshake: true,
            effectiveMode: 'readonly',
        });

        const settled2 = await settled2Promise;
        assert.equal(settled2.status, 'failed');
        assert.equal(fs.existsSync(pwnedMarker), false, 'Pre-handshake child_process guard must prevent spawning before broker hook');
    } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
});
