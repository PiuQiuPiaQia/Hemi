// 064 前置 SDK 接缝探针：真实 SDK + 本地 OpenAI／Anthropic 端点，无用户 Key。
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRunJournal } from '../src/main/agent-runtime/run-journal.mjs';
import { controlledStream } from '../src/main/agent-runtime/usage-ledger.mjs';
import { createAgentSession, SessionManager, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-064-probe-'));
const requests = [];
const tinyImage={type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4ryDwHxkzkC4AAKLAIuEUh8J9AAAAAElFTkSuQmCC'};
const toolImage={...tinyImage,data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/bfcAAAAASUVORK5CYII='};
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c);
  req.on('end', () => {
    const body = JSON.parse(raw); requests.push(body);
    const done = !body.tools?.length || JSON.stringify(body.messages).includes('PROJECTED_OBSERVATION');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url.includes('chat/completions')) {
      const delta = done ? { role: 'assistant', content: 'DONE' } : { role: 'assistant', tool_calls: [{ index: 0, id: 'call-probe', type: 'function', function: { name: 'probe', arguments: '{}' } }] };
      for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }]) res.write(`data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', model: body.model, ...chunk })}\n\n`);
      res.end('data: [DONE]\n\n'); return;
    }
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { id: 'reply', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    ev('content_block_start', { index: 0, content_block: done ? { type: 'text', text: '' } : { type: 'tool_use', id: 'toolu-probe', name: 'probe', input: {} } });
    ev('content_block_delta', { index: 0, delta: done ? { type: 'text_delta', text: 'DONE' } : { type: 'input_json_delta', partial_json: '{}' } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: done ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 2 } });
    ev('message_stop', {}); res.end();
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (const api of ['openai-completions', 'anthropic-messages']) {
    const cwd = path.join(root, api); await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'PROJECT_MARKER');
    const skill = path.join(cwd, 'skill'); await fs.mkdir(skill);
    await fs.writeFile(path.join(skill, 'SKILL.md'), '---\nname: runtime-probe\ndescription: SKILL_MARKER\n---\nprobe');
    const manager = SessionManager.inMemory(cwd), settings = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 10, reserveTokens: 1024 }, retry: { enabled: false, provider: { maxRetries: 0 } } });
    let entryAtExecute, effect = 0;
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager: settings,
      systemPromptOverride: () => '你是 Hemi。HEMI_IDENTITY', appendSystemPromptOverride: () => [],
      noThemes: true, noPromptTemplates: true, additionalSkillPaths: [path.join(skill, 'SKILL.md')],
      extensionFactories: [{ name: 'probe', factory: pi => {
        pi.registerProvider('probe', { api, baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'probe', models: [{ id: 'probe', name: 'probe', input: ['text','image'], reasoning: false, contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
        for (const name of ['read','probe']) pi.registerTool({ name, label: name, description: 'probe', parameters: { type: 'object', properties: {} }, async execute(callId) {
          entryAtExecute = manager.getEntries().findLast(e => e.type === 'message' && e.message?.role === 'assistant')?.id;
          assert.ok(entryAtExecute, 'tool execute 前必须有稳定 assistant 条目身份');
          const anchor = { entryAtExecute, callId }; await fs.writeFile(path.join(cwd, 'anchor.json'), JSON.stringify(anchor));
          assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd, 'anchor.json'))), anchor);
          effect++; return { content: [{ type: 'text', text: 'RAW_OBSERVATION' }] };
        } });
        pi.on('tool_result', event => event.toolName === 'probe' ? { content: [{ type: 'text', text: 'PROJECTED_OBSERVATION' },toolImage] } : undefined);
      } }],
    });
    await loader.reload();
    const { session } = await createAgentSession({ cwd, agentDir: cwd, sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: 'builtin' });
    try {
      await session.setModel(session.modelRuntime.getModels('probe')[0]);
      const journal = createRunJournal({dir:path.join(cwd,'ledger')}), owner={conversationId:api,rootRunId:'root',generation:0};await journal.beginRoot(owner);
      const candidate={supportsVision:true,modelKey:'probe/model',providerId:'probe',credentialRef:'probe',model:'probe',api,baseUrl:`http://127.0.0.1:${server.address().port}`};
      let compacting=false;session.subscribe(e=>{if(e.type==='compaction_start')compacting=true;if(e.type==='compaction_end')compacting=false;});
      session.agent.streamFunction=controlledStream(session.agent.streamFunction,()=>({journal,owner,plan:{primary:candidate,allowedFallbacks:[]},store:{resolveStrict:async()=>({ok:true,config:{...candidate,apiKey:'probe'}})},purpose:'main',budgets:{maxRequestsPerRun:20},compacting:()=>compacting}));
      const start = requests.length; await session.prompt('开始'+ '上下文'.repeat(1000),{images:[tinyImage]});
      const first = requests[start], second = requests[start+1];
      const system = JSON.stringify(first.system ?? first.messages.filter(m => m.role === 'system'));
      assert.match(system, /HEMI_IDENTITY/); assert.doesNotMatch(system, /expert coding assistant operating inside pi/);
      assert.match(system, /PROJECT_MARKER/); assert.match(system, /SKILL_MARKER/);
      assert.ok(JSON.stringify(first.messages).includes(tinyImage.data),'用户图像实际发给 provider');
      assert.ok(JSON.stringify(second.messages).includes(toolImage.data),'工具图像实际发给 provider');
      assert.ok(first.tools.some(tool => (tool.name ?? tool.function?.name) === 'probe'));
      assert.equal(effect, 1); assert.ok(second);
      assert.doesNotMatch(JSON.stringify(manager.getEntries()), /RAW_OBSERVATION/);
      assert.match(JSON.stringify(manager.getEntries()), /PROJECTED_OBSERVATION/);
      assert.ok(manager.getEntries().some(e => e.id === entryAtExecute));
      await session.prompt('继续'+ '历史'.repeat(1000));
      const beforeCompact=requests.length;await session.compact('保留目标和工具事实');
      assert.ok(requests.length>beforeCompact,'真正调用压缩 provider');
      const ledger=Object.values((await journal.snapshot()).requests);
      assert.equal(ledger.length,requests.length-start);assert.ok(ledger.some(row=>row.purpose==='compaction'));assert.ok(ledger.every(row=>row.coverage==='complete'));
      console.log(`PASS ${api}: transport ledger / real SDK compaction / custom system / tools / project / Skill / pre-execution anchor / first-history projection`);
    } finally { session.dispose(); }
  }
  console.log('HEMI_064_PROBE_RESULT', JSON.stringify({ passed: 2, total: 2, provider: 'local controlled endpoint', product: false }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
