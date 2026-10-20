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
  const imageRejected=await wrapped(piModelOf(config,'hemi'),{...context,messages:[...context.messages,{role:'user',content:[{type:'image',mimeType:'image/png',data:'image'}],timestamp:0}]}).result();
  assert.match(imageRejected.errorMessage,/unsupported-modality/);assert.equal(hits,0,'文本候选不能靠 SDK 丢图后发出请求');
  const answer=await wrapped(piModelOf(config,'hemi'),context).result();assert.equal(answer.stopReason,'stop');
  const blocked=await wrapped(piModelOf(config,'hemi'),context).result();assert.match(blocked.errorMessage,/上限/);assert.equal(hits,1);
  const state=await journal.snapshot(),requests=Object.values(state.requests);assert.equal(requests.length,1);assert.equal(requests[0].purpose,'main');assert.equal(requests[0].role,'main');
  assert.equal(requests[0].coverage,'complete');assert.deepEqual(requests[0].tokenUsage,{uncachedInput:5,output:3,cacheRead:10,cacheWrite:0});
  assert.equal(JSON.stringify(state).includes('DO_NOT_PERSIST'),false);assert.equal(requests[0].cost.status,'unknown');
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
