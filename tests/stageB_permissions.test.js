import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

import {
    canonicalizeJson,
    evaluatePermissionPolicy,
    parseNetworkTarget,
    resolveFileTargetWithEnv,
    resolveRealPathWithLinkOps,
    sha256Hex,
} from '../core/permissionPolicy.js';
import {computePermissionScope} from '../protocol.js';

const require = createRequire(import.meta.url);
const zcodeBridge = require('../zcodeBridge.cjs');

test('B1: Pure-JS sha256Hex matches Node crypto SHA-256 across ASCII, UTF-8 Chinese, emoji, and multi-block inputs', () => {
    const samples = [
        '',
        'abc',
        'The quick brown fox jumps over the lazy dog',
        'a'.repeat(55),
        'b'.repeat(56),
        'c'.repeat(64),
        'd'.repeat(256),
        '随问 Quick Chat 权限范围哈希校验 🚀 /home/user/桌面/报告.md',
        canonicalizeJson({b: 2, a: [1, 'two', {z: true, y: null}]}),
    ];

    for (const input of samples) {
        const expected = crypto.createHash('sha256').update(input, 'utf8').digest('hex');
        assert.equal(sha256Hex(input), expected, `SHA-256 mismatch for length=${input.length}`);
    }
});

test('B1: Shell commands default to allow-once; opt-in session keys prevent 120-char prefix, quote-whitespace, cwd, and summary-spoof collisions', () => {
    const mockFsEnv = {
        realpath: p => p,
        isSymlink: () => false,
        exists: () => true,
    };

    const sharedPrefix = `python3 -c "${'x'.repeat(135)}"`;
    const cmdSafe = `${sharedPrefix} --check`;
    const cmdDifferentTail = `${sharedPrefix} --format json`;
    assert.equal(cmdSafe.slice(0, 125), cmdDifferentTail.slice(0, 125));

    // 1. Default policy: Shell commands NEVER grant session-wide rules
    const defaultEval = evaluatePermissionPolicy({
        toolName: 'Bash',
        input: {command: cmdSafe},
        sessionId: 'sess_alpha',
        cwd: '/work/app',
        workspace: '/work/app',
        fsEnv: mockFsEnv,
    });
    assert.equal(defaultEval.allowSessionRule, false);
    assert.equal(defaultEval.scopeKey, '');

    // 2. Opt-in session repeat: full lossless command hashed — 135-char identical prefix does NOT collide
    const s1 = evaluatePermissionPolicy({
        toolName: 'Bash',
        input: {command: cmdSafe},
        sessionId: 'sess_alpha',
        cwd: '/work/app',
        workspace: '/work/app',
        fsEnv: mockFsEnv,
        allowRepeatShellInSession: true,
    });
    const s2 = evaluatePermissionPolicy({
        toolName: 'Bash',
        input: {command: cmdDifferentTail},
        sessionId: 'sess_alpha',
        cwd: '/work/app',
        workspace: '/work/app',
        fsEnv: mockFsEnv,
        allowRepeatShellInSession: true,
    });
    assert.equal(s1.allowSessionRule, true);
    assert.equal(s2.allowSessionRule, true);
    assert.notEqual(s1.scopeKey, s2.scopeKey);

    // 3. Whitespace inside quotes is preserved verbatim (never compressed)
    const quoteSingleSpace = evaluatePermissionPolicy({
        toolName: 'Bash',
        input: {command: 'grep "foo bar" README.md'},
        sessionId: 'sess_alpha',
        cwd: '/work/app',
        workspace: '/work/app',
        fsEnv: mockFsEnv,
        allowRepeatShellInSession: true,
    });
    const quoteDoubleSpace = evaluatePermissionPolicy({
        toolName: 'Bash',
        input: {command: 'grep "foo  bar" README.md'},
        sessionId: 'sess_alpha',
        cwd: '/work/app',
        workspace: '/work/app',
        fsEnv: mockFsEnv,
        allowRepeatShellInSession: true,
    });
    assert.notEqual(quoteSingleSpace.scopeKey, quoteDoubleSpace.scopeKey);

    // 4. Same command in different cwd or different sessionId or with extra parameters produces distinct keys
    const diffCwd = evaluatePermissionPolicy({
        toolName: 'Bash',
        input: {command: 'grep "foo bar" README.md'},
        sessionId: 'sess_alpha',
        cwd: '/work/other',
        workspace: '/work',
        fsEnv: mockFsEnv,
        allowRepeatShellInSession: true,
    });
    const diffSession = evaluatePermissionPolicy({
        toolName: 'Bash',
        input: {command: 'grep "foo bar" README.md'},
        sessionId: 'sess_beta',
        cwd: '/work/app',
        workspace: '/work/app',
        fsEnv: mockFsEnv,
        allowRepeatShellInSession: true,
    });
    const diffParams = evaluatePermissionPolicy({
        toolName: 'Bash',
        input: {command: 'grep "foo bar" README.md', env: {LD_PRELOAD: '/tmp/x.so'}},
        sessionId: 'sess_alpha',
        cwd: '/work/app',
        workspace: '/work/app',
        fsEnv: mockFsEnv,
        allowRepeatShellInSession: true,
    });
    assert.notEqual(quoteSingleSpace.scopeKey, diffCwd.scopeKey);
    assert.notEqual(quoteSingleSpace.scopeKey, diffSession.scopeKey);
    assert.notEqual(quoteSingleSpace.scopeKey, diffParams.scopeKey);

    // 5. Display summary vs actual command mismatch escalates risk and blocks session rule
    const spoofed = evaluatePermissionPolicy({
        toolName: 'Bash',
        input: {command: 'cat ~/.config/secret.json'},
        summary: 'ls -la',
        sessionId: 'sess_alpha',
        cwd: '/work/app',
        workspace: '/work/app',
        fsEnv: mockFsEnv,
        allowRepeatShellInSession: true,
    });
    assert.equal(spoofed.targetMismatch, true);
    assert.equal(spoofed.allowSessionRule, false);
    assert.equal(spoofed.scopeKey, '');
});

test('B1: File permission policy enforces realpath, catches symlink escapes, relative traversal, same-name paths, and GJS link-ops parity', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-stageb-fs-'));
    try {
        const fakeHome = path.join(tempRoot, 'home');
        const workspace = path.join(fakeHome, 'project');
        const outsideDir = path.join(tempRoot, 'outside');
        const subA = path.join(workspace, 'pkgA');
        const subB = path.join(workspace, 'pkgB');
        const sshDir = path.join(fakeHome, '.ssh');

        fs.mkdirSync(subA, {recursive: true});
        fs.mkdirSync(subB, {recursive: true});
        fs.mkdirSync(outsideDir, {recursive: true});
        fs.mkdirSync(sshDir, {recursive: true});

        const fileA = path.join(subA, 'config.json');
        const fileB = path.join(subB, 'config.json');
        const outsideSecret = path.join(outsideDir, 'secret.txt');
        const sshKey = path.join(sshDir, 'id_ed25519');
        const workspaceDotEnv = path.join(workspace, '.env');

        fs.writeFileSync(fileA, '{"a":1}\n');
        fs.writeFileSync(fileB, '{"b":2}\n');
        fs.writeFileSync(outsideSecret, 'TOP_SECRET\n');
        fs.writeFileSync(sshKey, 'PRIVATE_KEY\n');
        fs.writeFileSync(workspaceDotEnv, 'API_KEY=123\n');

        // Symlink inside workspace pointing outside workspace
        const escapeLink = path.join(workspace, 'innocent-readme.md');
        fs.symlinkSync(outsideSecret, escapeLink);

        // Symlink loop
        const loopA = path.join(workspace, 'loopA');
        const loopB = path.join(workspace, 'loopB');
        fs.symlinkSync(loopB, loopA);
        fs.symlinkSync(loopA, loopB);

        // Build GJS-style link-ops adapter using lstat + readlink to verify resolveRealPathWithLinkOps
        const gjsStyleFsEnv = {
            isSymlink: p => {
                try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; }
            },
            exists: p => {
                try { fs.lstatSync(p); return true; } catch (_) { return false; }
            },
            realpath: p => resolveRealPathWithLinkOps(p, {
                exists: target => {
                    try { fs.lstatSync(target); return true; } catch (_) { return false; }
                },
                isSymlink: target => {
                    try { return fs.lstatSync(target).isSymbolicLink(); } catch (_) { return false; }
                },
                readLink: target => fs.readlinkSync(target),
            }),
        };

        assert.equal(gjsStyleFsEnv.realpath(escapeLink), fs.realpathSync(escapeLink));
        assert.throws(() => gjsStyleFsEnv.realpath(loopA), /ELOOP|层级过深/);

        // 1. Symlink escape outside workspace -> critical risk, symlinkEscape: true, no session rule
        const symEval = evaluatePermissionPolicy({
            toolName: 'Read',
            input: {file_path: escapeLink},
            sessionId: 'sess_fs',
            cwd: workspace,
            workspace,
            homeDir: fakeHome,
            fsEnv: gjsStyleFsEnv,
        });
        assert.equal(symEval.symlinkEscape, true);
        assert.equal(symEval.riskLevel, 'critical');
        assert.equal(symEval.allowSessionRule, false);
        assert.equal(symEval.scopeKey, '');

        // 2. Relative traversal (`../../outside/secret.txt`) -> outsideWorkspace, no session rule
        const relEscape = evaluatePermissionPolicy({
            toolName: 'Edit',
            input: {file_path: '../../outside/secret.txt'},
            sessionId: 'sess_fs',
            cwd: subA,
            workspace,
            homeDir: fakeHome,
            fsEnv: gjsStyleFsEnv,
        });
        assert.equal(relEscape.allowSessionRule, false);
        assert.equal(relEscape.scopeKey, '');

        // 3. Symlink loop -> resolution fails closed, no session rule
        const loopRes = resolveFileTargetWithEnv(loopA, {cwd: workspace, workspace, homeDir: fakeHome, fsEnv: gjsStyleFsEnv});
        assert.equal(loopRes.resolvedOk, false);
        const loopEval = evaluatePermissionPolicy({
            toolName: 'Write',
            input: {file_path: loopA},
            sessionId: 'sess_fs',
            cwd: workspace,
            workspace,
            homeDir: fakeHome,
            fsEnv: gjsStyleFsEnv,
        });
        assert.equal(loopEval.allowSessionRule, false);

        // 4. Sensitive paths (~/.ssh/id_ed25519 and workspace/.env) -> never grant session rule
        const sshEval = evaluatePermissionPolicy({
            toolName: 'Read',
            input: {file_path: '~/.ssh/id_ed25519'},
            sessionId: 'sess_fs',
            cwd: workspace,
            workspace: fakeHome,
            homeDir: fakeHome,
            fsEnv: gjsStyleFsEnv,
        });
        const envEval = evaluatePermissionPolicy({
            toolName: 'Edit',
            input: {file_path: workspaceDotEnv},
            sessionId: 'sess_fs',
            cwd: workspace,
            workspace,
            homeDir: fakeHome,
            fsEnv: gjsStyleFsEnv,
        });
        assert.equal(sshEval.allowSessionRule, false);
        assert.equal(envEval.allowSessionRule, false);

        // 5. Same basename (`config.json`) in two different directories -> distinct SHA-256 scope keys
        const scopeA = evaluatePermissionPolicy({
            toolName: 'Edit',
            input: {file_path: 'config.json'},
            sessionId: 'sess_fs',
            cwd: subA,
            workspace,
            homeDir: fakeHome,
            fsEnv: gjsStyleFsEnv,
        });
        const scopeB = evaluatePermissionPolicy({
            toolName: 'Edit',
            input: {file_path: 'config.json'},
            sessionId: 'sess_fs',
            cwd: subB,
            workspace,
            homeDir: fakeHome,
            fsEnv: gjsStyleFsEnv,
        });
        assert.equal(scopeA.allowSessionRule, true);
        assert.equal(scopeB.allowSessionRule, true);
        assert.notEqual(scopeA.scopeKey, scopeB.scopeKey);

        // 6. Read scope must NOT grant Edit/Write scope on the exact same file!
        const readA = evaluatePermissionPolicy({
            toolName: 'Read',
            input: {file_path: fileA},
            sessionId: 'sess_fs',
            cwd: workspace,
            workspace,
            homeDir: fakeHome,
            fsEnv: gjsStyleFsEnv,
        });
        assert.notEqual(readA.scopeKey, scopeA.scopeKey);

        // 7. Display summary mismatch vs real input.file_path -> targetMismatch: true, no session rule
        const mismatchFile = evaluatePermissionPolicy({
            toolName: 'Write',
            input: {file_path: fileB},
            summary: fileA,
            sessionId: 'sess_fs',
            cwd: workspace,
            workspace,
            homeDir: fakeHome,
            fsEnv: gjsStyleFsEnv,
        });
        assert.equal(mismatchFile.targetMismatch, true);
        assert.equal(mismatchFile.allowSessionRule, false);
    } finally {
        fs.rmSync(tempRoot, {recursive: true, force: true});
    }
});

test('B1: Network policy isolates scheme/host/port and blocks plaintext HTTP, private IPs, redirects, and unknown/high-risk tools', () => {
    const https443 = evaluatePermissionPolicy({
        toolName: 'WebFetch',
        input: {url: 'https://developer.gnome.org/documentation'},
        sessionId: 'sess_net',
    });
    const https8443 = evaluatePermissionPolicy({
        toolName: 'WebFetch',
        input: {url: 'https://developer.gnome.org:8443/documentation'},
        sessionId: 'sess_net',
    });
    assert.equal(https443.allowSessionRule, true);
    assert.equal(https8443.allowSessionRule, true);
    assert.notEqual(https443.scopeKey, https8443.scopeKey);

    const blockedUrls = [
        {url: 'http://developer.gnome.org/docs'},
        {url: 'https://localhost:8080/api'},
        {url: 'https://127.0.0.1/secret'},
        {url: 'https://169.254.169.254/latest/meta-data/'},
        {url: 'https://192.168.1.1/admin'},
        {url: 'https://[::1]/admin'},
        {url: 'https://token:secret@api.github.com/user'},
        {url: 'file:///etc/passwd'},
        {url: 'https://auth.example.com/oauth?redirect_uri=https://attacker.example/cb'},
        {url: 'https://api.example.com/v1', method: 'POST'},
        {url: 'https://api.example.com/v1', headers: {Authorization: 'Bearer secret'}},
        {url: 'https://api.example.com/v1', followRedirects: true},
    ];
    for (const badInput of blockedUrls) {
        const res = evaluatePermissionPolicy({
            toolName: 'WebFetch',
            input: badInput,
            sessionId: 'sess_net',
        });
        assert.equal(res.allowSessionRule, false, `Should block session scope for ${JSON.stringify(badInput)}`);
        assert.equal(res.scopeKey, '');
    }

    assert.equal(parseNetworkTarget('not a url').valid, false);

    // Unknown tools, MCP tools, Delete, NotebookEdit, WebSearch, AskUserQuestion strictly disallow session rules
    for (const toolName of ['UnknownCustomTool', 'mcp__github__create_issue', '工具', 'Delete', 'NotebookEdit', 'WebSearch', 'AskUserQuestion']) {
        const pRes = computePermissionScope(toolName, {query: 'test', path: '/tmp/a'}, {sessionId: 'sess_net'});
        const bRes = zcodeBridge.computeBridgeScope(toolName, {query: 'test', path: '/tmp/a'}, {sessionId: 'sess_net'});
        assert.equal(pRes.allowSessionRule, false, `protocol must disallow session rule for ${toolName}`);
        assert.equal(pRes.scopeKey, '');
        assert.equal(bRes.allowSessionRule, false, `bridge must disallow session rule for ${toolName}`);
        assert.equal(bRes.scopeKey, '');
    }

    // Verify zcodeBridge VM fallback produces identical deterministic scope keys to ESM import
    const vmPolicy = zcodeBridge.loadSharedPermissionPolicy({forceVmFallback: true});
    const vmRes = vmPolicy.evaluatePermissionPolicy({
        toolName: 'WebFetch',
        input: {url: 'https://developer.gnome.org/documentation'},
        sessionId: 'sess_net',
    });
    assert.equal(vmRes.scopeKey, https443.scopeKey);
});

test('B1: PermissionBrokerController enforces requestId/turnId, parallel auto-resolve events, revocation, AbortSignal cleanup, stdin close, and timeout', async () => {
    const emitted = [];
    const broker = zcodeBridge.createPermissionBrokerController({
        sessionId: 'sess_broker_1',
        turnId: 'turn_broker_1',
        approvalTimeoutMs: 5000,
        emitEvent: evt => emitted.push(evt),
    });

    // 1. Missing requestId is immediately denied without queuing
    const noIdRes = await broker.handlePermissionRequest({toolName: 'Bash', input: {command: 'id'}});
    assert.equal(noIdRes.decision, 'deny');
    assert.equal(broker.pendingRequests.size, 0);

    // 2. Two parallel WebFetch requests to same origin + one to a different origin, with tracked AbortSignal
    let addedListeners = 0;
    let removedListeners = 0;
    const mockSignal = {
        aborted: false,
        _fn: null,
        addEventListener(type, fn) {
            if (type === 'abort') {
                addedListeners++;
                this._fn = fn;
            }
        },
        removeEventListener(type, fn) {
            if (type === 'abort' && this._fn === fn) {
                removedListeners++;
                this._fn = null;
            }
        },
    };

    const p1 = broker.handlePermissionRequest(
        {requestId: 'req_1', toolCallId: 'call_1', toolName: 'WebFetch', input: {url: 'https://docs.gnome.org/a'}},
        {signal: mockSignal}
    );
    const p2 = broker.handlePermissionRequest(
        {requestId: 'req_2', toolCallId: 'call_2', toolName: 'WebFetch', input: {url: 'https://docs.gnome.org/b'}}
    );
    const p3 = broker.handlePermissionRequest(
        {requestId: 'req_3', toolCallId: 'call_3', toolName: 'WebFetch', input: {url: 'https://gitlab.gnome.org/c'}}
    );
    assert.equal(broker.pendingRequests.size, 3);
    assert.equal(addedListeners, 1);

    // Duplicate requestId while pending is rejected without clobbering existing entry
    const dupReq = await broker.handlePermissionRequest(
        {requestId: 'req_1', toolCallId: 'call_dup', toolName: 'WebFetch', input: {url: 'https://evil.example/'}}
    );
    assert.equal(dupReq.decision, 'deny');
    assert.equal(broker.pendingRequests.size, 3);

    // 3. Responses with missing requestId, unknown requestId, or wrong turnId MUST be rejected!
    assert.equal(
        broker.handlePermissionResponseMessage({type: 'permission_response', decision: 'allow'}).reason,
        'missing_request_id'
    );
    assert.equal(
        broker.handlePermissionResponseMessage({type: 'permission_response', requestId: 'req_unknown', decision: 'allow'}).reason,
        'unknown_or_expired_request_id'
    );
    assert.equal(
        broker.handlePermissionResponseMessage({type: 'permission_response', requestId: 'req_1', turnId: 'turn_OLD', decision: 'allow'}).reason,
        'turn_id_mismatch'
    );
    assert.equal(broker.pendingRequests.size, 3);

    // 4. Approving req_1 with alwaysAllow: true settles req_1 AND auto-settles parallel req_2 (emitting permission_resolved for BOTH!), leaving req_3 pending
    const acceptRes = broker.handlePermissionResponseMessage({
        type: 'permission_response',
        requestId: 'req_1',
        turnId: 'turn_broker_1',
        decision: 'allow',
        alwaysAllow: true,
    });
    assert.equal(acceptRes.accepted, true);
    assert.deepEqual(acceptRes.autoSettledIds, ['req_2']);
    assert.equal((await p1).decision, 'allow');
    assert.equal((await p2).decision, 'allow');
    assert.equal(removedListeners, 1, 'AbortSignal listener must be cleaned up upon settlement');
    assert.equal(broker.pendingRequests.size, 1);

    // Duplicate response for already-settled req_1 is rejected
    assert.equal(
        broker.handlePermissionResponseMessage({type: 'permission_response', requestId: 'req_1', decision: 'deny'}).reason,
        'unknown_or_expired_request_id'
    );

    // Subsequent req_4 for docs.gnome.org auto-approves AND emits quickchat.permission_resolved with autoApproved: true
    const p4 = await broker.handlePermissionRequest({
        requestId: 'req_4',
        toolCallId: 'call_4',
        toolName: 'WebFetch',
        input: {url: 'https://docs.gnome.org/page4'},
    });
    assert.equal(p4.decision, 'allow');

    const resolvedEvents = emitted.filter(e => e.type === 'quickchat.permission_resolved');
    assert.ok(resolvedEvents.some(e => e.payload.requestId === 'req_2' && e.payload.autoApproved === true));
    assert.ok(resolvedEvents.some(e => e.payload.requestId === 'req_4' && e.payload.autoApproved === true));

    // 5. Revoking scopes prevents subsequent auto-approval
    broker.revokeApprovedScopes();
    const p5 = broker.handlePermissionRequest({
        requestId: 'req_5',
        toolCallId: 'call_5',
        toolName: 'WebFetch',
        input: {url: 'https://docs.gnome.org/after-revoke'},
    });
    assert.equal(broker.pendingRequests.has('req_5'), true);

    // 6. Closing stdin denies all remaining pending requests (req_3 and req_5) cleanly
    broker.closeAllPending('输入流已关闭');
    assert.equal((await p3).decision, 'deny');
    assert.equal((await p5).decision, 'deny');
    assert.equal(broker.pendingRequests.size, 0);

    // 7. Approval timeout safely denies stalled request and emits timedOut: true
    const timeoutEvents = [];
    const shortTimeoutBroker = zcodeBridge.createPermissionBrokerController({
        sessionId: 'sess_timeout',
        turnId: 'turn_timeout',
        approvalTimeoutMs: 35,
        emitEvent: evt => timeoutEvents.push(evt),
    });
    const stalledRes = await shortTimeoutBroker.handlePermissionRequest({
        requestId: 'req_stall',
        toolCallId: 'call_stall',
        toolName: 'Bash',
        input: {command: 'echo hi'},
    });
    assert.equal(stalledRes.decision, 'deny');
    assert.ok(timeoutEvents.some(e => e.type === 'quickchat.permission_resolved' && e.payload.requestId === 'req_stall' && e.payload.timedOut === true));
});
