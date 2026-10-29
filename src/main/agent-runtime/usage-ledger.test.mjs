import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { piModelOf } from '../lib/pi-model.mjs';
import { controlledStream } from './usage-ledger.mjs';
import { createRunJournal } from './run-journal.mjs';
import { testPng } from '../../../scripts/lib/local-image-fixtures.mjs';

test('真实 transport 逐请求记录，异步 SDK stream 支持、Key 不落盘、额度在发送前阻止',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'h64-usage-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let hits=0;
  const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{hits++;res.writeHead(200,{'content-type':'text/event-stream'});
    for(const chunk of [{choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:15,completion_tokens:3,prompt_tokens_details:{cached_tokens:10}}}])res.write(`data: ${JSON.stringify({id:'m',object:'chat.completion.chunk',model:'test',...chunk})}\n\n`);
    res.end('data: [DONE]\n\n');});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const config={modelKey:'p/m',providerId:'p',credentialRef:'p',model:'test',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'DO_NOT_PERSIST'};
  const owner={conversationId:'c',rootRunId:'r',generation:1},journal=createRunJournal({dir});await journal.beginRoot(owner);
  const execution={journal,owner,plan:{role:'main',primary:config,allowedFallbacks:[]},store:{resolveStrict:async()=>({ok:true,config})},budgets:{maxRequestsPerRun:1},purpose:'main'};
  const wrapped=controlledStream(async(...args)=>streamSimple(...args),()=>execution);
  const context={messages:[{role:'system',content:'Hemi',timestamp:0,toolsAdded:[{name:'read',description:'read',parameters:{type:'object',properties:{}}}]},{role:'user',content:'hi',timestamp:0}]};
  const answer=await wrapped(piModelOf(config,'hemi'),context).result();assert.equal(answer.stopReason,'stop');
  const blocked=await wrapped(piModelOf(config,'hemi'),context).result();assert.match(blocked.errorMessage,/上限/);assert.equal(hits,1);
  const state=await journal.snapshot(),requests=Object.values(state.requests);assert.equal(requests.length,1);assert.equal(requests[0].purpose,'main');assert.equal(requests[0].role,'main');
  assert.equal(requests[0].coverage,'complete');assert.deepEqual(requests[0].tokenUsage,{uncachedInput:5,output:3,cacheRead:10,cacheWrite:0,reasoning:0});
  assert.equal(JSON.stringify(state).includes('DO_NOT_PERSIST'),false);assert.equal(requests[0].cost.status,'unknown');
});

test('历史图片交给 Pi 按实际候选降级；文本候选不解码大图，视觉转文本备用不复用图片投影', async t => {
  for (const fallback of [false, true]) await t.test(fallback ? '视觉主模型切到同服务的文本备用' : '直接使用文本模型', async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hemi-text-image-history-'));
    const requests = [];
    const server = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      if (body.model === 'vision') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Service unavailable' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '继续文字讨论。' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
    const text = { modelKey: 'p/text', providerId: 'p', credentialRef: 'p', model: 'text',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'SYNTHETIC_ONLY', supportsVision: false };
    const primary = fallback ? { ...text, modelKey: 'p/vision', model: 'vision', supportsVision: true } : text;
    const owner = { conversationId: 'c', rootRunId: 'r', generation: 1 }, journal = createRunJournal({ dir });
    await journal.beginRoot(owner);
    const candidates = [primary, ...(fallback ? [text] : [])];
    const execution = { journal, owner, plan: { role: 'main', primary, allowedFallbacks: candidates.slice(1) },
      store: { resolveStrict: async key => ({ ok: true, config: candidates.find(candidate => candidate.modelKey === key) }) },
      budgets: { maxRequestsPerRun: 3 }, purpose: 'main' };
    // 文本路径使用超过压缩阈值的无效图像，证明它不必经过 Hemi 图片解码。
    const data = fallback ? testPng().toString('base64') : 'x'.repeat(600000);
    const image = { type: 'image', mimeType: 'image/png', data };
    const context = {
      tools: [{ name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }],
      messages: [
        ...Array.from({ length: 9 }, (_, i) => ({ role: 'user', content: [{ type: 'text', text: `frame-${i}.png` }, image], timestamp: i })),
        { role: 'assistant', api: 'openai-completions', provider: 'hemi', model: primary.model, stopReason: 'toolUse',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: [{ type: 'toolCall', id: 'read-history', name: 'read', arguments: { path: 'frame.png' } }], timestamp: 10 },
        { role: 'toolResult', toolCallId: 'read-history', toolName: 'read', content: [{ type: 'text', text: 'TOOL_TEXT_RETAINED' }, image], isError: false, timestamp: 11 },
        { role: 'user', content: '继续文字讨论', timestamp: 12 },
      ],
    };
    const original = structuredClone(context);
    const result = await controlledStream(streamSimple, () => execution)(piModelOf(primary, 'hemi'), context, { signal: AbortSignal.timeout(5000) }).result();
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.deepEqual(requests.map(body => body.model), fallback ? ['vision', 'text'] : ['text']);
    const body = JSON.stringify(requests.at(-1));
    assert.equal(body.match(/\(image omitted: model does not support images\)/g)?.length, 9);
    assert.match(body, /tool image omitted: model does not support images/);
    assert.match(body, /TOOL_TEXT_RETAINED/);
    assert.match(body, /继续文字讨论/);
    assert.doesNotMatch(body, /image_url|data:image|历史图片已从本次请求省略/);
    assert.equal(JSON.stringify(context) === JSON.stringify(original), true, '请求投影不改写原始上下文');
    const records = Object.values((await journal.snapshot()).requests);
    assert.equal(records.length, requests.length);
    assert.deepEqual(records.map(row => row.candidateIndex), fallback ? [0, 1] : [0]);
  });
});

test('角色身份随真实请求落盘，恢复投影保留身份；旧子请求保持未分类', async t => {
  const { usageRecordsFromJournal } = await import('./usage-ledger.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'h48-role-ledger-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = createRunJournal({ dir });
  const owner = { conversationId: 'c', rootRunId: 'r', generation: 0 };
  await journal.beginRoot(owner);
  for (const [requestId, role] of [['main', 'main'], ['explorer', 'explorer'], ['oracle', 'oracle'], ['old', undefined]]) {
    await journal.requestStart({ ...owner, ...(role === 'main' ? {} : { taskId: requestId }) }, {
      requestId, purpose: role === 'main' ? 'main' : 'subagent', role,
      actualModel: { modelKey: 'p/shared', model: 'shared' },
    }, 10);
    await journal.requestEnd(requestId, { tokenUsage: { uncachedInput: 10, output: 2, cacheRead: 4, cacheWrite: 0 }, coverage: 'complete' });
  }
  const restored = createRunJournal({ dir });
  const records = usageRecordsFromJournal(await restored.snapshot(), 'c');
  assert.deepEqual(records.map(row => row.role), ['main', 'explorer', 'oracle', undefined]);
  assert.equal(records.length, 4);
  assert.deepEqual(usageRecordsFromJournal(await restored.snapshot(), 'other'), []);
});

test('response journal failure never replays an already sent provider request', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hemi-response-write-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  let hits = 0;
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {hits++; res.writeHead(200, {'content-type':'text/event-stream'}); res.end('data: [DONE]\n\n');});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {server.closeAllConnections(); server.close();});
  const config = {modelKey:'p/m', providerId:'p', credentialRef:'p', model:'test', baseUrl:`http://127.0.0.1:${server.address().port}/v1`, api:'openai-completions', apiKey:'SYNTHETIC_ONLY'};
  const owner = {conversationId:'c', rootRunId:'r', generation:1}, journal = createRunJournal({dir});
  await journal.beginRoot(owner);
  journal.requestResponse = async () => {throw new Error('journal connection error: persistence failed');};
  const recovery = [];
  const execution = {journal, owner, plan:{role:'main', primary:config, allowedFallbacks:[]}, store:{resolveStrict:async () => ({ok:true, config})},
    budgets:{maxRequestsPerRun:10}, purpose:'main', onRecovery:state => recovery.push(state)};
  const result = await controlledStream(streamSimple, () => execution)(piModelOf(config, 'hemi'), {messages:[{role:'user', content:'hi', timestamp:0}]}).result();
  assert.match(result.errorMessage, /persistence failed/);
  assert.equal(hits, 1);
  assert.deepEqual(recovery, []);
});
