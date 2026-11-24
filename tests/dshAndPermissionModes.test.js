import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildZCodeArgs, buildCodexArgs, buildDshArgs, normalizeEvent,
    normalizeEffectiveAgentMode, parseZCodeHelpCapabilities,
    getBackendCapabilities,
} from '../protocol.js';
import {resolveBackendSelection, matchesDshHeadlessHelp} from '../core/configMigration.js';
import {BackendRegistry, MemorySettingsStore} from '../core/backendRegistry.js';
import {
    buildDshProfileOverlay, extractDshConfiguredModel, makeDshModelCatalog,
    extractDshPiAiProviders, extractDshPiAiPatch,
    normalizeDshProviderId,
    resolveDesktopAssistantPrompt, DEFAULT_DESKTOP_ASSISTANT_PROMPT,
} from '../core/dshModelCatalog.js';

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
test('DSH: only the documented headless JSONL and approval flags pass compatibility detection', () => {
    const valid = `Usage: dsh --profile headless [options] [task...]
      --json                  write newline-delimited events
      --session-id <id>       resume a session
      --permission-mode <preset>
      --approval-policy <policy>`;
    assert.equal(matchesDshHeadlessHelp(valid), true);
    assert.equal(matchesDshHeadlessHelp(valid.replace('--json', '--text')), false);
    assert.equal(matchesDshHeadlessHelp(valid.replace('--permission-mode', '--unsafe-mode')), false);
    assert.equal(matchesDshHeadlessHelp(valid.replace('Usage: dsh --profile headless', 'Usage: fake-runner')), false);
});

test('DSH: read only configuration defaults and model catalog from composited profile', () => {
    const dump = `# = dsh-base
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-flash
# = headless user overlay
- id: agent-default-model
  config:
    provider: "llm-pi-ai:custom"
    model: "my-model-v2"
- id: some-secret-config
  config:
    apiKey: TEST_DO_NOT_EXPOSE
`;
    const current = extractDshConfiguredModel(dump);
    assert.deepEqual(current, {provider:'llm-pi-ai:custom',model:'my-model-v2'});
    const catalog = makeDshModelCatalog(current);
    assert.ok(catalog.providers[0].models.includes('deepseek-flash'));
    assert.ok(catalog.providers[0].models.includes('deepseek-v4-pro'));
    assert.equal(catalog.defaultProviderId,'custom');
    assert.equal(catalog.defaultModelId,'my-model-v2');
    assert.ok(!JSON.stringify(catalog).includes('TEST_DO_NOT_EXPOSE'));
});

test('DSH: YAML overlay injects only isolated model/persona fields, never patch YAML statements', () => {
    const hostile = '先打开浏览器\\n- id: evil\\n  name: attacker';
    const overlay = buildDshProfileOverlay({
        provider:'deepseek-official',model:'deepseek-v4-pro',persona:hostile,
    });
    assert.match(overlay,/provider: "deepseek-official"/);
    assert.match(overlay,/model: "deepseek-v4-pro"/);
    assert.match(overlay,/personaPrefix: "先打开浏览器/);
    assert.equal(overlay.split(/^[-] id:/m).length - 1, 2, 'only two intended patch rows');
    assert.equal(overlay.includes('\n- id: evil'),false);
    assert.throws(() => buildDshProfileOverlay({provider:'foo\n- id: evil',model:'bar'}));
    assert.ok(resolveDesktopAssistantPrompt('').includes('GNOME'));
    assert.equal(resolveDesktopAssistantPrompt('  自定义指引  '),'自定义指引');
    assert.equal(resolveDesktopAssistantPrompt(''),DEFAULT_DESKTOP_ASSISTANT_PROMPT);
});

test('DSH: headless CLI invocation passes prompt only on stdin and isolates permissions', () => {
    const readonly = buildDshArgs({executable:'/usr/bin/dsh',mode:'readonly'});
    assert.deepEqual(readonly, ['/usr/bin/dsh','--profile','headless','--json','--permission-mode','read-only','--approval-policy','never','-']);
    assert.equal(normalizeEffectiveAgentMode('dsh','smart').effectiveMode,'readonly');
    const full = buildDshArgs({executable:'dsh',mode:'full'},'session-123');
    assert.ok(full.includes('danger-full-access'));
    const smartDisabled = buildDshArgs({executable:'dsh',mode:'smart'});
    assert.equal(smartDisabled[smartDisabled.indexOf('--permission-mode')+1], 'read-only');
    const smartEnabled = buildDshArgs({executable:'dsh',mode:'smart',dshAutoReview:true},'',{
        overlayPath:'/tmp/qc-dsh-overlay.yml',
    });
    assert.equal(smartEnabled[smartEnabled.indexOf('--permission-mode')+1], 'read-only');
    assert.equal(smartEnabled[smartEnabled.indexOf('--patch')+1], '/tmp/qc-dsh-overlay.yml');
    assert.equal(normalizeEffectiveAgentMode('dsh','smart',{enableAutoReview:true}).effectiveMode,'readonly');
    assert.throws(() => buildDshArgs({mode:'full'},'',{overlayPath:'../../evil.yml'}));
    assert.ok(full.includes('session-123'));
});
test('DSH: normalize official JSON line events with committed final answer', () => {
    assert.deepEqual(normalizeEvent('dsh',{type:'session',sessionId:'session-abcd'}),{type:'session_bound',sessionId:'session-abcd'});
    assert.equal(normalizeEvent('dsh',{type:'text',text:'你好'}).assistantMessageEvent.delta,'你好');
    assert.equal(normalizeEvent('dsh',{type:'thinking',text:'思考'}).assistantMessageEvent.type,'thinking_delta');
    assert.equal(normalizeEvent('dsh',{type:'tool_call',callId:'call-1',tool:'read_file'}).type,'tool_execution_start');
    assert.equal(normalizeEvent('dsh',{type:'tool_result',callId:'call-1',status:'error'}).isError,true);
    const raw = normalizeEvent('dsh',{type:'tool_call',callId:'raw-1',tool:'bash',input:'{"incomplete":'});
    assert.deepEqual(raw.rawInput, {rawArguments:'{"incomplete":'});
    const denied = normalizeEvent('dsh',{
        type:'tool_result',callId:'raw-1',status:'error',result:'not run',
        error:{code:'AUTO_REVIEW_DENIED',reason:'No explicit authorization for target'},
    });
    assert.equal(denied.isError, true);
    assert.equal(denied.errorCode, 'AUTO_REVIEW_DENIED');
    assert.match(denied.detail, /No explicit authorization/);
    const final = normalizeEvent('dsh',{type:'final',sessionId:'session-abcd',reason:{kind:'completed'},text:'最终结果'});
    assert.equal(final.type,'turn_result');
    assert.equal(final.text,'最终结果');
    assert.equal(final.authoritative,true);
    assert.equal(final.isError,false);
    assert.equal(normalizeEvent('dsh',{type:'final',reason:{kind:'error',error:{message:'failed'}},text:''}).isError,true);
    const providerError = normalizeEvent('dsh',{
        type:'final',reason:{kind:'error',error:{code:'MODEL_AUTH_FAILED',message:'No DEEPSEEK_API_KEY available'}},
        text:'',sessionId:'s',
    });
    assert.match(providerError.errorMessage,/MODEL_AUTH_FAILED/);
    assert.match(providerError.errorMessage,/DEEPSEEK_API_KEY/);
    assert.equal(normalizeEvent('dsh',{type:'final',reason:null,text:''}).isError,true);
});
test('DSH: config is selected explicitly and isolated from Codex/ZCode profiles', () => {
    const sel=resolveBackendSelection({configuredBackend:'dsh',dshPath:'/usr/bin/dsh'},{hasDsh:()=>true});
    assert.equal(sel.effectiveBackend,'dsh');
    assert.equal(sel.available,true);
    const settings=new MemorySettingsStore({backend:'dsh','dsh-path':'/usr/bin/dsh','dsh-agent-mode':'smart'});
    const registry=new BackendRegistry(settings);
    assert.equal(registry.getBackendProfile('dsh').mode,'smart');
    registry.updateBackendProfile('dsh',{mode:'readonly',workspace:'/tmp',provider:'deepseek-official',model:'deepseek-v4-pro'});
    assert.equal(settings.get_string('dsh-workspace'),'/tmp');
    assert.equal(registry.buildRuntimeConfig('dsh').dshPath,'/usr/bin/dsh');
    assert.equal(registry.buildRuntimeConfig('dsh').model,'deepseek-v4-pro');
});

test('DSH: web profile custom model catalog is secret-free and headless patch is scoped', () => {
    const yaml = [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      personal-api:',
        '        api: openai-completions',
        '        baseURL: https://gateway.private.example/v1',
        '        apiKeyEnv: PRIVATE_SECRET',
        '        models:',
        '          - id: alpha-1',
        '          - id: beta-2',
        '- id: system-prompt',
        '  config:',
        '    personaPrefix: web-only',
    ].join('\n');
    const providers = extractDshPiAiProviders(yaml);
    assert.deepEqual(providers.map(p => ({id:p.id,models:p.models})), [
        {id:'personal-api',models:['alpha-1','beta-2']},
    ]);
    const catalog = makeDshModelCatalog({}, providers);
    assert.ok(catalog.providers.some(p => p.id === 'personal-api'));
    assert.ok(!JSON.stringify(catalog).includes('PRIVATE_SECRET'));
    assert.ok(!JSON.stringify(catalog).includes('gateway.private'));
    assert.ok(!extractDshPiAiPatch(yaml).includes('web-only'));
    const overlay = buildDshProfileOverlay({
        provider:'llm-pi-ai:personal-api', model:'alpha-1', piAiPatch:yaml,
    });
    assert.ok(overlay.includes('provider: "personal-api"'));
    assert.ok(overlay.includes('baseURL: https://gateway.private.example/v1'));
    assert.ok(!overlay.includes('web-only'));
});


test('DSH: upstream pi-ai adapter registers plain provider route IDs; migrate old selections', () => {
    assert.equal(normalizeDshProviderId('llm-pi-ai:codex'), 'codex');
    assert.equal(normalizeDshProviderId('codex'), 'codex');
    assert.equal(normalizeDshProviderId('llm-pi-ai:'), '');
    const store = new MemorySettingsStore({
        backend: 'dsh',
        'dsh-provider': 'llm-pi-ai:codex',
        'dsh-model': 'gpt-6-luna',
    });
    const registry = new BackendRegistry(store);
    assert.equal(registry.getBackendProfile('dsh').provider, 'codex');
    assert.equal(registry.buildRuntimeConfig('dsh').provider, 'codex');
    registry.updateBackendProfile('dsh', {provider: 'llm-pi-ai:codex'});
    assert.equal(store.get_string('dsh-provider'), 'codex');
    const overlay = buildDshProfileOverlay({
        provider: 'llm-pi-ai:codex', model: 'gpt-6-luna',
    });
    assert.ok(overlay.includes('provider: "codex"'));
    assert.ok(!overlay.includes('llm-pi-ai:codex'));
    const web = [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      codex:',
        '        models:',
        '          - id: gpt-6-luna',
    ].join('\n');
    const listed = extractDshPiAiProviders(web);
    assert.deepEqual(listed.map(p => p.id), ['codex']);
    assert.deepEqual(listed[0].models, ['gpt-6-luna']);
    const fullOverlay = buildDshProfileOverlay({
        provider: 'codex', model: 'gpt-6-luna', piAiPatch: web,
    });
    assert.match(fullOverlay, /providers:\n      codex:/);
});
