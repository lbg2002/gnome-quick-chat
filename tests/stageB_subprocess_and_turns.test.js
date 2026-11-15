import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';

import {
    buildCodexArgs,
    buildZCodeArgs,
    getBackendCapabilities,
    normalizeEffectiveAgentMode,
    parseCodexHelpCapabilities,
    parseZCodeHelpCapabilities,
} from '../protocol.js';
import {TurnController} from '../core/turnController.js';
import {
    BRIDGE_EXPECTED_PROTOCOL_VERSION,
    CliTurnMonitor,
    buildProcessGroupKillArgv,
    cleanupStaleRuntimeFilesWithEnv,
    evaluateSubprocessOutcome,
    isManagedTempRuntimeFilename,
    isSafeProcessGroupId,
    prepareZCodeConfigOverride,
    validateCliPromptLength,
    wrapArgvWithSetsid,
} from '../runtime/cliProcessRunner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BRIDGE_PATH = path.join(REPO_ROOT, 'zcodeBridge.cjs');

function isProcessAliveOrRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 1) return false;
    try {
        process.kill(pid, 0);
    } catch (_) {
        return false;
    }
    try {
        const statText = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const rparen = statText.lastIndexOf(')');
        if (rparen > 0) {
            const state = statText.slice(rparen + 2, rparen + 3);
            if (state === 'Z' || state === 'X') return false;
        }
    } catch (_) {
        return false;
    }
    return true;
}

async function waitForPidExit(pid, maxWaitMs = 1200) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        if (!isProcessAliveOrRunning(pid)) return true;
        await new Promise(r => setTimeout(r, 25));
    }
    return !isProcessAliveOrRunning(pid);
}

/**
 * Helper that runs a real Node fake-CLI subprocess through CliTurnMonitor + stdout/stderr/exit barrier,
 * mirroring BackendClient._runSingleTurnSubprocess.
 */
async function runMonitoredFakeCli({
    backend = 'codex',
    turnId = 'turn_test_1',
    argv,
    env = {},
    stdinText = '',
    requireBridgeHandshake = false,
    expectedBridgeVersion = BRIDGE_EXPECTED_PROTOCOL_VERSION,
    limits = {},
}) {
    const monitor = new CliTurnMonitor({
        turnId,
        backend,
        requireBridgeHandshake,
        expectedBridgeVersion,
        limits,
    });
    const events = [];
    let sawDoneMarker = false;
    let turnError = '';

    const child = spawn(argv[0], argv.slice(1), {
        env: {...process.env, ...env},
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (stdinText) {
        child.stdin.write(stdinText);
    }
    child.stdin.end();

    const outDone = new Promise(resolve => {
        const rl = readline.createInterface({input: child.stdout, crlfDelay: Infinity});
        rl.on('line', line => {
            const {ignore, normalized, fatalError} = monitor.processStdoutLine(turnId, line);
            if (ignore) return;
            if (fatalError) {
                try { child.kill('SIGTERM'); } catch (_) {}
                return;
            }
            if (!normalized) return;
            events.push(normalized);
            if (normalized.type === 'turn_completed' || normalized.type === 'turn_result') {
                sawDoneMarker = true;
                if (normalized.isError && normalized.errorMessage) {
                    turnError = normalized.errorMessage;
                }
            } else if (normalized.type === 'message_end' && normalized.message?.errorMessage) {
                turnError = normalized.message.errorMessage;
            }
        });
        rl.on('close', resolve);
    });

    const errDone = new Promise(resolve => {
        const rl = readline.createInterface({input: child.stderr, crlfDelay: Infinity});
        rl.on('line', line => {
            monitor.pushStderrLine(turnId, line);
        });
        rl.on('close', resolve);
    });

    const exitPromise = new Promise(resolve => {
        child.on('exit', (code, signal) => resolve({code, signal}));
    });

    const [, , exitInfo] = await Promise.all([outDone, errDone, exitPromise]);

    const outcome = evaluateSubprocessOutcome({
        exitCode: exitInfo.code,
        termSignal: exitInfo.signal,
        sawDoneMarker,
        turnError,
        fatalError: monitor.fatalError,
        stderrSummary: monitor.getStderrSummary(),
    });

    return {monitor, events, exitInfo, outcome};
}

test('B2: Capability matrix is honest (ZCode approval agent vs Codex read-only sandbox vs OpenAI pure chat) and CLI flags are validated', () => {
    const zCaps = getBackendCapabilities('zcode');
    assert.equal(zCaps.supportsApproval, true);
    assert.equal(zCaps.modeBadges.readonly, '需审批 Agent');
    assert.ok(zCaps.modeLabels[1].includes('非系统级沙箱'));

    // Codex without a real --no-tools flag disables pureChat and downgrades 'chat' to 'readonly' sandbox without fake prompt injection
    const codexProbed = parseCodexHelpCapabilities(
        'Usage: codex exec [OPTIONS] [PROMPT]\n  --json\n  -c, --config <KEY=VALUE>\n  -C, --cd <DIR>\n  --skip-git-repo-check\n  --color <WHEN>\n  resume\n  Read prompt from stdin with -',
        'codex-cli 0.42.0'
    );
    assert.equal(codexProbed.probed, true);
    assert.equal(codexProbed.supportsDisableTools, false);
    assert.equal(codexProbed.supportsStdinPrompt, true);

    const cCaps = getBackendCapabilities('codex', codexProbed);
    assert.equal(cCaps.pureChat, false);
    assert.deepEqual(cCaps.supportedModes, ['readonly', 'full']);

    const eff = normalizeEffectiveAgentMode('codex', 'chat', codexProbed);
    assert.equal(eff.effectiveMode, 'readonly');
    assert.equal(eff.downgradedFromChat, true);
    assert.ok(eff.notice.includes('OpenAI API'));

    // Prompts starting with `-` cannot inject CLI flags in ZCode or Codex
    const dashPrompt = '--dangerous-flag=1';
    const zDashArgs = buildZCodeArgs({executable: 'zcode', mode: 'readonly'}, dashPrompt);
    assert.ok(zDashArgs.includes(`--prompt=${dashPrompt}`), 'ZCode must bind prompt into --prompt=<value>');
    assert.ok(!zDashArgs.includes(dashPrompt), 'Bare --dangerous-flag token must never appear in ZCode argv');

    const cStdinArgs = buildCodexArgs({executable: 'codex', mode: 'chat'}, '/tmp/ws', dashPrompt, '', {
        cliCaps: codexProbed,
        stdinPrompt: true,
    });
    assert.equal(cStdinArgs.at(-1), '-');
    assert.ok(cStdinArgs.includes('sandbox_mode="read-only"'));
    assert.ok(!cStdinArgs.some(a => a.includes('不要调用工具')));

    const cArgvArgs = buildCodexArgs({executable: 'codex', mode: 'readonly'}, '/tmp/ws', dashPrompt, '', {
        cliCaps: codexProbed,
        stdinPrompt: false,
    });
    const sepIdx = cArgvArgs.indexOf('--');
    assert.ok(sepIdx > 0 && cArgvArgs[sepIdx + 1] === dashPrompt, 'Codex argv prompt must follow `--` option terminator');

    // Incompatible CLI versions fail closed rather than silently ignoring security flags
    const brokenZCodeCaps = parseZCodeHelpCapabilities('Usage: zcode --prompt <text> --output-format stream-json --mode <m>', '0.1.0');
    assert.equal(brokenZCodeCaps.supportsDisallowedTools, false);
    assert.throws(
        () => buildZCodeArgs({executable: 'zcode', mode: 'chat'}, '你好', '', '', {cliCaps: brokenZCodeCaps}),
        /不支持 --disallowed-tools/
    );

    const brokenCodexCaps = parseCodexHelpCapabilities('Usage: codex [PROMPT]', '0.0.1');
    assert.throws(
        () => buildCodexArgs({executable: 'codex', mode: 'readonly'}, '/tmp/ws', '你好', '', {cliCaps: brokenCodexCaps}),
        /不支持必需的 exec/
    );

    // OpenAI API is strictly pure HTTP chat without local tools
    const oCaps = getBackendCapabilities('openai');
    assert.equal(oCaps.pureChat, true);
    assert.equal(oCaps.supportsTools, false);
    assert.deepEqual(oCaps.supportedModes, ['chat']);

    // Prompt byte-length limits
    assert.throws(() => validateCliPromptLength('x'.repeat(40 * 1024), {viaArgv: true}), /上限/);
    assert.ok(validateCliPromptLength('x'.repeat(40 * 1024), {viaArgv: false}) > 32 * 1024);
});

test('B2: prepareZCodeConfigOverride fails closed on missing/corrupt config, unknown provider, write error, or read-back mismatch', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-stageb-zcfg-'));
    try {
        const homeDir = path.join(tempDir, 'home');
        const runtimeDir = path.join(tempDir, 'run');
        const zcodeCfgDir = path.join(homeDir, '.zcode', 'v2');
        fs.mkdirSync(zcodeCfgDir, {recursive: true});
        fs.mkdirSync(runtimeDir, {recursive: true, mode: 0o700});

        const personalPath = path.join(zcodeCfgDir, 'provider_config.json');
        const baseIo = {
            homeDir,
            fileExists: p => fs.existsSync(p),
            readJson: p => {
                try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
            },
            getRuntimeDir: () => runtimeDir,
            makeUuid: () => '11111111-2222-3333-4444-555555555555',
            writePrivateFile: (p, bytes) => fs.writeFileSync(p, bytes, {mode: 0o600}),
            removeFile: p => { try { fs.unlinkSync(p); } catch (_) {} },
        };

        // 1. Missing personal config with explicit model -> throws (never silently uses unknown model)
        assert.throws(
            () => prepareZCodeConfigOverride({provider: 'openai', model: 'gpt-5'}, baseIo),
            /无法读取 ZCode 个人模型配置文件/
        );

        // 2. Corrupt JSON with explicit model -> throws
        fs.writeFileSync(personalPath, '{corrupt_json');
        assert.throws(
            () => prepareZCodeConfigOverride({provider: 'openai', model: 'gpt-5'}, baseIo),
            /解析 ZCode 个人模型配置文件失败/
        );

        // Write valid personal config
        const validPersonal = {
            schemaVersion: 1,
            config: {
                defaultModelSelection: {providerId: 'openai', modelId: 'gpt-4o'},
                providerOrder: ['openai'],
                providerConfigRules: {
                    providerRules: [
                        {
                            providerId: 'openai',
                            providerName: 'OpenAI',
                            config: {
                                modelOrder: ['gpt-4o', 'gpt-5'],
                                personalModelIds: ['gpt-4o', 'gpt-5'],
                            },
                        },
                    ],
                },
            },
        };
        fs.writeFileSync(personalPath, JSON.stringify(validPersonal, null, 2));

        // 3. Unknown provider explicitly requested -> throws
        assert.throws(
            () => prepareZCodeConfigOverride({provider: 'nonexistent-provider', model: 'm1'}, baseIo),
            /无法将所选模型应用到 ZCode 配置/
        );

        // 4. Read-back verification mismatch -> cleans up temp file and throws!
        let removedTemp = '';
        const tamperedIo = {
            ...baseIo,
            readJson: p => {
                if (p === personalPath) return JSON.parse(fs.readFileSync(p, 'utf8'));
                // Simulate corrupted/tampered read-back with wrong modelId
                return {config: {defaultModelSelection: {providerId: 'openai', modelId: 'WRONG_MODEL'}}};
            },
            removeFile: p => {
                removedTemp = p;
                try { fs.unlinkSync(p); } catch (_) {}
            },
        };
        assert.throws(
            () => prepareZCodeConfigOverride({provider: 'openai', model: 'gpt-5', reasoningEffort: 'deep'}, tamperedIo),
            /回读校验不一致/
        );
        assert.ok(removedTemp.endsWith('zcode-provider-11111111-2222-3333-4444-555555555555.json'));
        assert.equal(fs.existsSync(removedTemp), false, 'Failed override temp file must be deleted immediately');

        // 5. Valid override succeeds, verifies 0600 temp file, and leaves ~/.zcode/v2/provider_config.json untouched
        const okRes = prepareZCodeConfigOverride(
            {provider: 'openai', model: 'gpt-5', reasoningEffort: 'deep'},
            baseIo
        );
        assert.equal(okRes.resolvedProvider, 'openai');
        assert.equal(okRes.resolvedModel, 'gpt-5');
        assert.equal(okRes.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, okRes.tempFilePath);
        const mode = fs.statSync(okRes.tempFilePath).mode & 0o777;
        assert.equal(mode, 0o600);
        const origAfter = JSON.parse(fs.readFileSync(personalPath, 'utf8'));
        assert.equal(origAfter.config.defaultModelSelection.modelId, 'gpt-4o');
    } finally {
        fs.rmSync(tempDir, {recursive: true, force: true});
    }
});

test('B2 & B4: Fake CLI subprocesses validate done markers, non-zero exits, late stderr, stream caps, and ZCode bridge handshake', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-stageb-cli-'));
    try {
        // 1. Normal CLI exit (0) WITH done marker -> completed
        const normalRes = await runMonitoredFakeCli({
            backend: 'codex',
            argv: [
                process.execPath,
                '-e',
                [
                    'console.log(JSON.stringify({type:"thread.started",thread_id:"th_ok"}));',
                    'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"正常完成"}}));',
                    'console.log(JSON.stringify({type:"turn.completed"}));',
                ].join(''),
            ],
        });
        assert.equal(normalRes.outcome.status, 'completed');
        assert.equal(normalRes.outcome.errorMessage, '');

        // 2. Exit 0 WITHOUT done marker (truncated stdout EOF) -> interrupted (NEVER completed!)
        const truncatedRes = await runMonitoredFakeCli({
            backend: 'codex',
            argv: [
                process.execPath,
                '-e',
                'console.log(JSON.stringify({type:"item.updated",item:{type:"agent_message",text:"说到一半断流"}}));',
            ],
        });
        assert.equal(truncatedRes.outcome.status, 'interrupted');
        assert.equal(truncatedRes.outcome.interrupted, true);

        // 3. Non-zero exit code + late stderr arriving after stdout closes -> failed with stderr summary
        const failLateStderr = await runMonitoredFakeCli({
            backend: 'codex',
            argv: [
                process.execPath,
                '-e',
                [
                    'process.stdout.write(JSON.stringify({type:"turn.completed"}) + "\\n");',
                    'process.stdout.end();',
                    'setTimeout(() => { process.stderr.write("FATAL: sandbox authentication failed\\n"); process.exit(2); }, 35);',
                ].join(''),
            ],
        });
        assert.equal(failLateStderr.outcome.status, 'failed');
        assert.match(failLateStderr.outcome.errorMessage, /sandbox authentication failed/);

        // 4. CliTurnMonitor per-turn isolation & resource caps (turnId mismatch, line overflow, stderr cap, JSON error cap)
        const cappedMonitor = new CliTurnMonitor({
            turnId: 'turn_current',
            backend: 'codex',
            limits: {maxLineBytes: 128, maxStderrBytes: 80, maxStderrLines: 5, maxJsonParseErrors: 2},
        });
        assert.equal(cappedMonitor.processStdoutLine('turn_stale', '{"type":"turn.completed"}').ignore, true);
        assert.equal(cappedMonitor.pushStderrLine('turn_stale', 'stale stderr'), false);

        cappedMonitor.pushStderrLine('turn_current', 'E'.repeat(200));
        assert.equal(cappedMonitor.stderrTruncated, true);
        assert.ok(cappedMonitor.stderrBytes <= 80);

        assert.equal(cappedMonitor.processStdoutLine('turn_current', '{bad1').fatalError, '');
        assert.equal(cappedMonitor.processStdoutLine('turn_current', '{bad2').fatalError, '');
        assert.match(cappedMonitor.processStdoutLine('turn_current', '{bad3').fatalError, /连续解析失败超过上限/);

        const lineOverflowMonitor = new CliTurnMonitor({
            turnId: 'turn_overflow',
            backend: 'codex',
            limits: {maxLineBytes: 64},
        });
        assert.match(lineOverflowMonitor.processStdoutLine('turn_overflow', `{"x":"${'A'.repeat(100)}"}`).fatalError, /单行输出超过安全上限/);

        // 5. ZCode bridge fail-closed handshake: unpatched CLI (DenyPermissionBroker renamed/missing) exits 78 & aborts before task!
        const unpatchedZcodeScript = path.join(tempDir, 'fake-zcode-unpatched.cjs');
        fs.writeFileSync(unpatchedZcodeScript, [
            'class RenamedBroker {}',
            'Object.defineProperty(RenamedBroker, "name", {value: "RenamedBroker"});',
            'setTimeout(() => {',
            '  console.log(JSON.stringify({type: "tool.updated", payload: {kind: "started", toolName: "Bash", input: {command: "echo SHOULD_NOT_RUN"}}}));',
            '}, 50);',
        ].join('\n'));

        // Direct bridge check: exits strictly with code 78 when DenyPermissionBroker is missing
        const directUnpatched = spawnSync(
            process.execPath,
            ['--require', BRIDGE_PATH, unpatchedZcodeScript],
            {env: {...process.env, QUICK_CHAT_REQUIRE_BRIDGE: '1', QUICK_CHAT_BRIDGE_PROTOCOL: '1'}, encoding: 'utf8'}
        );
        assert.equal(directUnpatched.status, 78);

        const unpatchedRes = await runMonitoredFakeCli({
            backend: 'zcode',
            requireBridgeHandshake: true,
            argv: [process.execPath, '--require', BRIDGE_PATH, unpatchedZcodeScript],
            env: {
                QUICK_CHAT_REQUIRE_BRIDGE: '1',
                QUICK_CHAT_BRIDGE_PROTOCOL: '1',
            },
        });
        assert.ok(unpatchedRes.exitInfo.code === 78 || unpatchedRes.exitInfo.signal === 'SIGTERM');
        assert.equal(unpatchedRes.outcome.status, 'failed');
        assert.match(unpatchedRes.outcome.errorMessage, /未命中/);
        assert.equal(unpatchedRes.events.some(e => e.type === 'tool_execution_start'), false, 'Sensitive task must never run when bridge hook misses');

        // 6. ZCode bridge protocol version mismatch -> fails closed immediately (exit 78)
        const directMismatch = spawnSync(
            process.execPath,
            ['--require', BRIDGE_PATH, unpatchedZcodeScript],
            {env: {...process.env, QUICK_CHAT_REQUIRE_BRIDGE: '1', QUICK_CHAT_BRIDGE_PROTOCOL: '999'}, encoding: 'utf8'}
        );
        assert.equal(directMismatch.status, 78);

        const versionMismatchRes = await runMonitoredFakeCli({
            backend: 'zcode',
            requireBridgeHandshake: true,
            expectedBridgeVersion: 999,
            argv: [process.execPath, '--require', BRIDGE_PATH, unpatchedZcodeScript],
            env: {
                QUICK_CHAT_REQUIRE_BRIDGE: '1',
                QUICK_CHAT_BRIDGE_PROTOCOL: '999',
            },
        });
        assert.ok(versionMismatchRes.exitInfo.code === 78 || versionMismatchRes.exitInfo.signal === 'SIGTERM');
        assert.equal(versionMismatchRes.outcome.status, 'failed');
        assert.match(versionMismatchRes.outcome.errorMessage, /协议版本/);

        // 7. ZCode patched DenyPermissionBroker + QUICK_CHAT_PROMPT_FILE safely injects `--leading-dash` prompt and unlinks temp file
        const promptFile = path.join(tempDir, 'zcode-prompt-aaaa1111-bbbb-cccc-dddd-eeeeffff0000.txt');
        fs.writeFileSync(promptFile, '--leading-dash\n第二行中文提问', {mode: 0o600});

        const patchedZcodeScript = path.join(tempDir, 'fake-zcode-patched.cjs');
        fs.writeFileSync(patchedZcodeScript, [
            'class DenyPermissionBroker { requestPermission() { return Promise.resolve({decision: "deny"}); } }',
            'Object.defineProperty(DenyPermissionBroker, "name", {value: "DenyPermissionBroker"});',
            'const pArg = process.argv.find(a => a.startsWith("--prompt=")) || "";',
            'console.log(JSON.stringify({type: "model.streaming", payload: {kind: "text_delta", delta: pArg.slice("--prompt=".length)}}));',
            'console.log(JSON.stringify({type: "turn.completed"}));',
        ].join('\n'));

        const patchedRes = await runMonitoredFakeCli({
            backend: 'zcode',
            requireBridgeHandshake: true,
            argv: [process.execPath, '--require', BRIDGE_PATH, patchedZcodeScript, '--prompt='],
            env: {
                QUICK_CHAT_REQUIRE_BRIDGE: '1',
                QUICK_CHAT_BRIDGE_PROTOCOL: '1',
                QUICK_CHAT_REQUIRE_PROMPT_FILE: '1',
                QUICK_CHAT_PROMPT_FILE: promptFile,
            },
        });
        assert.equal(fs.existsSync(promptFile), false, 'Bridge must unlink private prompt file immediately after reading');
        assert.equal(patchedRes.outcome.status, 'completed');
        assert.equal(patchedRes.monitor.isHandshakeVerified, true);
        assert.equal(
            patchedRes.events.find(e => e.type === 'message_update')?.assistantMessageEvent?.delta,
            '--leading-dash\n第二行中文提问'
        );

        // 8. Tool event arriving BEFORE bridge_ready is blocked immediately by CliTurnMonitor
        const prematureMonitor = new CliTurnMonitor({
            turnId: 'turn_premature',
            backend: 'zcode',
            requireBridgeHandshake: true,
        });
        const validPremature = prematureMonitor.processStdoutLine(
            'turn_premature',
            JSON.stringify({type: 'tool.updated', payload: {kind: 'started', toolName: 'Bash', input: {command: 'whoami'}}})
        );
        assert.match(validPremature.fatalError, /未完成审批桥接安全握手/);
    } finally {
        fs.rmSync(tempDir, {recursive: true, force: true});
    }
});

test('B4: Isolated setsid process group terminates SIGTERM-trapping grandchild processes without leaking orphans', async () => {
    const setsidBin = fs.existsSync('/usr/bin/setsid') ? '/usr/bin/setsid' : (fs.existsSync('/bin/setsid') ? '/bin/setsid' : '');
    const killBin = fs.existsSync('/bin/kill') ? '/bin/kill' : '/usr/bin/kill';
    assert.ok(setsidBin, 'setsid binary should exist on Linux test host');

    assert.equal(isSafeProcessGroupId(0), false);
    assert.equal(isSafeProcessGroupId(1), false);
    assert.equal(isSafeProcessGroupId(process.pid, {selfPid: process.pid}), false);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-stageb-pgid-'));
    const grandchildPidFile = path.join(tempDir, 'grandchild.pid');
    let leader = null;
    let grandchildPid = 0;

    try {
        const parentScript = [
            'const {spawn} = require("node:child_process");',
            'const fs = require("node:fs");',
            'const gc = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000);"], {stdio: "ignore"});',
            `fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(gc.pid));`,
            'console.log("READY:" + gc.pid);',
            'process.on("SIGTERM", () => {});',
            'setInterval(() => {}, 1000);',
        ].join(' ');

        const wrapped = wrapArgvWithSetsid([process.execPath, '-e', parentScript], setsidBin);
        assert.equal(wrapped.isolatedProcessGroup, true);

        leader = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timed out waiting for grandchild spawn')), 3000);
            const rl = readline.createInterface({input: leader.stdout});
            rl.on('line', line => {
                if (line.startsWith('READY:')) {
                    grandchildPid = Number(line.slice('READY:'.length).trim());
                    clearTimeout(timer);
                    resolve();
                }
            });
        });

        assert.ok(grandchildPid > 1);
        assert.equal(isProcessAliveOrRunning(leader.pid), true);
        assert.equal(isProcessAliveOrRunning(grandchildPid), true);

        // Send TERM then KILL strictly to the isolated `-pgid` process group
        const termArgs = buildProcessGroupKillArgv(leader.pid, 'TERM', killBin);
        spawnSync(termArgs[0], termArgs.slice(1));

        // Both parent and grandchild trap SIGTERM, so escalate to KILL on `-pgid`
        const killArgs = buildProcessGroupKillArgv(leader.pid, 'KILL', killBin);
        spawnSync(killArgs[0], killArgs.slice(1));

        const leaderGone = await waitForPidExit(leader.pid, 1500);
        const grandchildGone = await waitForPidExit(grandchildPid, 1500);
        assert.equal(leaderGone, true, 'Leader CLI process must be terminated');
        assert.equal(grandchildGone, true, 'Grandchild process inside setsid group must be terminated with zero leaks');
    } finally {
        if (leader?.pid) {
            try { process.kill(-leader.pid, 'SIGKILL'); } catch (_) {}
            try { leader.kill('SIGKILL'); } catch (_) {}
        }
        if (grandchildPid > 1) {
            try { process.kill(grandchildPid, 'SIGKILL'); } catch (_) {}
        }
        fs.rmSync(tempDir, {recursive: true, force: true});
    }
});

test('B3 & B4: TurnController preserves awaiting_approval across deltas, defers temp-file deletion until process exit, and cleans stale runtime files safely', () => {
    const events = [];
    const controller = new TurnController(evt => events.push(evt));

    // 1. Multi-approval + streaming text/thinking deltas must NOT overwrite awaiting_approval or resume main watchdog early
    const turnA = controller.beginTurn({
        turnId: 'turn_A',
        messageId: 'msg_A',
        sessionId: 'sess_1',
        clientGeneration: 3,
        lifecycleGeneration: 1,
        backend: 'zcode',
        promptText: 'Run two tools',
        deferTempCleanupUntilProcessExit: true,
    });
    turnA.process = {pid: 4242};
    turnA.tempFiles.push('/run/user/1000/gnome-quick-chat/zcode-provider-aaaa1111-2222.json');

    let mainWatchdogResets = 0;
    let approvalWatchdogStarts = 0;
    let approvalWatchdogClears = 0;
    turnA.resetWatchdog = () => { mainWatchdogResets++; };
    turnA.pauseWatchdog = () => {};
    turnA.startApprovalWatchdog = () => { approvalWatchdogStarts++; };
    turnA.clearApprovalWatchdog = () => { approvalWatchdogClears++; };

    controller.markStreaming(turnA);
    controller.enterApproval(turnA, 'perm_1');
    controller.enterApproval(turnA, 'perm_2');
    assert.equal(turnA.state, 'awaiting_approval');
    assert.equal(approvalWatchdogStarts, 2);

    // Streaming delta arrives while 2 approvals are still pending -> state MUST stay awaiting_approval!
    controller.appendText(turnA, '正在准备执行工具…');
    controller.appendThinking(turnA, '先获取第一个资源');
    controller.markStreaming(turnA);
    assert.equal(turnA.state, 'awaiting_approval');
    assert.equal(mainWatchdogResets, 0);

    // Resolve first approval -> still awaiting second approval!
    controller.leaveApproval(turnA, 'perm_1');
    assert.equal(turnA.state, 'awaiting_approval');
    assert.equal(mainWatchdogResets, 0);
    assert.equal(approvalWatchdogClears, 0);

    // Resolve final approval -> returns to streaming and resumes main watchdog once
    controller.leaveApproval(turnA, 'perm_2');
    assert.equal(turnA.state, 'streaming');
    assert.equal(approvalWatchdogClears, 1);
    assert.equal(mainWatchdogResets, 1);

    // Snapshot replacement: prefix growth emits text_delta, non-prefix rewrite emits text_replace (never duplicates!)
    controller.replaceText(turnA, '正在准备执行工具…已完成第一步');
    controller.replaceText(turnA, '修正后的完整回复');
    assert.equal(turnA.text, '修正后的完整回复');
    assert.ok(events.some(e => e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_replace' && e.assistantMessageEvent.text === '修正后的完整回复'));

    // 2. Cancel Turn A while subprocess is still exiting: temp files are NOT deleted prematurely before wait_async!
    const prematurelyCleaned = [];
    controller.cancelActiveTurn({
        onCleanupTempFiles: files => prematurelyCleaned.push(...files),
    });
    assert.equal(prematurelyCleaned.length, 0, 'Temp config must not be unlinked while child process is still exiting');
    assert.equal(turnA.tempFiles.length, 1, 'wait_async exit barrier retains tempFiles list to unlink after OS exit');

    // 3. Immediately start Turn B: late callbacks or identity checks for Turn A cannot touch Turn B
    const turnB = controller.beginTurn({
        turnId: 'turn_B',
        messageId: 'msg_B',
        sessionId: 'sess_1',
        clientGeneration: 3,
        lifecycleGeneration: 1,
        backend: 'zcode',
        promptText: 'Question B',
    });
    assert.equal(controller.matchesIdentity(turnA, {turnId: 'turn_A', clientGeneration: 3, sessionId: 'sess_1'}), false);
    assert.equal(controller.matchesIdentity(turnB, {turnId: 'turn_B', clientGeneration: 3, sessionId: 'sess_1'}), true);
    assert.equal(controller.matchesIdentity(turnB, {turnId: 'turn_B', clientGeneration: 99, sessionId: 'sess_1'}), false);
    assert.equal(controller.matchesIdentity(turnB, {turnId: 'turn_B', clientGeneration: 3, sessionId: 'sess_other'}), false);

    // 4. Stale runtime file cleanup removes only aged managed UUID temp files and skips symlinks/fresh/unrelated files
    const tempRuntime = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-stageb-clean-'));
    try {
        const staleProvider = path.join(tempRuntime, 'zcode-provider-12345678-abcd-ef01-2345-6789abcdef01.json');
        const freshPrompt = path.join(tempRuntime, 'zcode-prompt-87654321-abcd-ef01-2345-6789abcdef01.txt');
        const unrelatedFile = path.join(tempRuntime, 'keep-notes.json');
        const symlinkName = 'zcode-provider-deadbeef-dead-beef-dead-beefdeadbeef.json';
        const symlinkPath = path.join(tempRuntime, symlinkName);

        fs.writeFileSync(staleProvider, '{}');
        fs.writeFileSync(freshPrompt, 'hi');
        fs.writeFileSync(unrelatedFile, '{}');
        fs.symlinkSync(unrelatedFile, symlinkPath);

        const oldTime = new Date(Date.now() - 7200 * 1000);
        fs.utimesSync(staleProvider, oldTime, oldTime);

        assert.equal(isManagedTempRuntimeFilename(path.basename(staleProvider)), true);
        assert.equal(isManagedTempRuntimeFilename('../zcode-provider-12345678.json'), false);
        assert.equal(isManagedTempRuntimeFilename('keep-notes.json'), false);

        const cleanupRes = cleanupStaleRuntimeFilesWithEnv(tempRuntime, {
            isSymlink: p => fs.lstatSync(p).isSymbolicLink(),
            isDir: p => fs.lstatSync(p).isDirectory(),
            listEntries: d => fs.readdirSync(d),
            getMtimeMs: p => fs.lstatSync(p).mtimeMs,
            unlink: p => { fs.unlinkSync(p); return true; },
        }, {nowMs: Date.now(), maxAgeMs: 3600 * 1000});

        assert.deepEqual(cleanupRes.removed, [staleProvider]);
        assert.equal(fs.existsSync(staleProvider), false);
        assert.equal(fs.existsSync(freshPrompt), true);
        assert.equal(fs.existsSync(unrelatedFile), true);
        assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
    } finally {
        fs.rmSync(tempRuntime, {recursive: true, force: true});
    }
});
