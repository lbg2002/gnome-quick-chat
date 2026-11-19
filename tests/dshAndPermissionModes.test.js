import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildZCodeArgs, buildCodexArgs, buildDshArgs, normalizeEvent,
    normalizeEffectiveAgentMode, parseZCodeHelpCapabilities,
    getBackendCapabilities,
} from '../protocol.js';
import {resolveBackendSelection} from '../core/configMigration.js';
import {BackendRegistry, MemorySettingsStore} from '../core/backendRegistry.js';

test('ZCode: incomplete help text must not reject a newer CLI with valid --mode and stream-json', () => {
    const caps = parseZCodeHelpCapabilities('Usage: zcode [options]\n--version', 'zcode v3.1.0');
    assert.equal(caps.probed, true);
    assert.equal(caps.supportsStreamJson, false, 'probe only sees short help');
    const args = buildZCodeArgs({mode: 'smart', executable: 'zcode'}, '打开浏览器', '', '/home/test', {cliCaps: caps});
    assert.ok(args.includes('--mode'));
    assert.ok(args.includes('build'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('stream-json'));
    assert.ok(!args.includes('--workflow-mode'), 'optional flags must only appear when advertised');
});
test('permissions: ZCode real plan/read-only, build/smart with bridge, yolo/full', () => {
    for (const [mode, actual] of [['readonly','plan'],['smart','build'],['full','yolo']]) {
        const args = buildZCodeArgs({mode, executable:'zcode'}, 'read file');
        assert.equal(args[args.indexOf('--mode')+1],actual);
    }
    const cap = getBackendCapabilities('zcode');
    assert.ok(cap.supportedModes.includes('smart'));
    assert.equal(cap.modeBadges.smart,'智能审批');
});
test('preferences: permission labels map one-to-one to readonly/smart/full for all local agents', () => {
    for (const backend of ['zcode','codex','dsh']) {
        const caps = getBackendCapabilities(backend);
        assert.equal(caps.modeLabels.length, 3,
            `${backend}: extra legacy chat label would shift security settings labels`);
        assert.match(caps.modeLabels[0], /只读/);
        assert.match(caps.modeLabels[1], /智能/);
        assert.match(caps.modeLabels[2], /完全权限/);
    }
});
test('permissions: Codex smart must stay sandboxed read-only and never grant write silently', () => {
    const mode = normalizeEffectiveAgentMode('codex','smart');
    assert.equal(mode.effectiveMode,'readonly');
    const args = buildCodexArgs({executable:'codex',mode:'smart'},'/tmp','read a file');
    assert.ok(args.includes('sandbox_mode="read-only"'));
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(!args.includes('sandbox_mode="danger-full-access"'));
});
test('DSH: headless CLI invocation passes prompt only on stdin and isolates permissions', () => {
    const readonly = buildDshArgs({executable:'/usr/bin/dsh',mode:'readonly'});
    assert.deepEqual(readonly, ['/usr/bin/dsh','--profile','headless','--json','--permission-mode','read-only','--approval-policy','never','-']);
    assert.equal(normalizeEffectiveAgentMode('dsh','smart').effectiveMode,'readonly');
    const full = buildDshArgs({executable:'dsh',mode:'full'},'session-123');
    assert.ok(full.includes('danger-full-access'));
    assert.ok(full.includes('session-123'));
});
test('DSH: normalize official JSON line events with committed final answer', () => {
    assert.deepEqual(normalizeEvent('dsh',{type:'session',sessionId:'session-abcd'}),{type:'session_bound',sessionId:'session-abcd'});
    assert.equal(normalizeEvent('dsh',{type:'text',text:'你好'}).assistantMessageEvent.delta,'你好');
    assert.equal(normalizeEvent('dsh',{type:'thinking',text:'思考'}).assistantMessageEvent.type,'thinking_delta');
    assert.equal(normalizeEvent('dsh',{type:'tool_call',callId:'call-1',tool:'read_file'}).type,'tool_execution_start');
    assert.equal(normalizeEvent('dsh',{type:'tool_result',callId:'call-1',status:'error'}).isError,true);
    const final = normalizeEvent('dsh',{type:'final',sessionId:'session-abcd',reason:{kind:'completed'},text:'最终结果'});
    assert.equal(final.type,'turn_result');
    assert.equal(final.text,'最终结果');
    assert.equal(final.authoritative,true);
    assert.equal(final.isError,false);
    assert.equal(normalizeEvent('dsh',{type:'final',reason:{kind:'error',error:{message:'failed'}},text:''}).isError,true);
    assert.equal(normalizeEvent('dsh',{type:'final',reason:null,text:''}).isError,true);
});
test('DSH: config is selected explicitly and isolated from Codex/ZCode profiles', () => {
    const sel=resolveBackendSelection({configuredBackend:'dsh',dshPath:'/usr/bin/dsh'},{hasDsh:()=>true});
    assert.equal(sel.effectiveBackend,'dsh');
    assert.equal(sel.available,true);
    const settings=new MemorySettingsStore({backend:'dsh','dsh-path':'/usr/bin/dsh','dsh-agent-mode':'smart'});
    const registry=new BackendRegistry(settings);
    assert.equal(registry.getBackendProfile('dsh').mode,'smart');
    registry.updateBackendProfile('dsh',{mode:'readonly',workspace:'/tmp'});
    assert.equal(settings.get_string('dsh-workspace'),'/tmp');
    assert.equal(registry.buildRuntimeConfig('dsh').dshPath,'/usr/bin/dsh');
});
