import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createAgentRuntime} from './core.mjs';
import {freezeModelPolicy, resolveModelPlan, hydrateModelPlan} from './model-policy.mjs';
import {GOAL_CHECK_SYSTEM, goalRunOutcome} from './goal-driver.mjs';

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-browser-goal-')));
  let status = 'awaiting_user', checks = 0;
  const clients = new Map();
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const checking = body.messages.some(m => m.role === 'system' && String(m.content).includes(GOAL_CHECK_SYSTEM));
    if (checking) checks++;
    const verdict = {status, reason:'实际会话结果', evidence:['已读取任务页面'],
      remaining:status === 'complete' ? [] : ['等待用户手动验证'], nextAction:status === 'continue' ? '继续读取原页面' : '',
      ...(status === 'awaiting_user' ? {question:'请确认账号并手动完成页面上的人机验证，完成后告诉我。'} : {})};
    const content = checking ? JSON.stringify(verdict) : '请确认账号并手动完成页面上的人机验证，完成后告诉我。';
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{content},finish_reason:null}]})}\n\n`);
    res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
    if (checking && status === 'continue') status = 'awaiting_user';
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {modelKey:'test/browser-goal',model:'browser-goal',api:'openai-completions',apiKey:'SYNTHETIC_ONLY',
    baseUrl:`http://127.0.0.1:${server.address().port}/v1`,thinkingLevel:'off'};
  const store = {list:async () => ({defaultModelId:config.modelKey}),resolveStrict:async () => ({ok:true,config})};
  const policySnapshot = await freezeModelPolicy({store,modelKey:config.modelKey});
  const modelPlan = await hydrateModelPlan(resolveModelPlan(policySnapshot),store);
  const runtime = createAgentRuntime({userDataDir:path.join(dir,'data'),getProfiles:() => store,
    resolveCapabilities:async () => ({features:{},extensionConfig:{},browserOn:true}),getAccessService:() => null,
    createBrowserClient:({taskId}) => {
      const client = {cleanups:0,async endSession() {this.cleanups++;}};
      clients.set(taskId,client); return client;
    },
    loadArchiveAgent:() => null,loadArchiveTurns:() => [],saveArchiveAgent:() => true});
  t.after(async () => {
    await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(dir,{recursive:true,force:true});
  });
  async function obtain(conversationId = 'browser-goal', runId = 'initial', continuationOf = null) {
    const ctx = {conversationId,runId,continuationOf,generation:1,policySnapshot,modelPlan,config,inputSource:'text',
      workspace:{id:'fixture',type:'project',dir}};
    const agent = await runtime.obtain(ctx);
    return {ctx,agent,client:clients.get(`main-${conversationId}`)};
  }
  return {runtime,obtain,setStatus:value => {status=value;},checks:() => checks};
}

test('目标续跑和等待用户时不清页；回复后完成才清页；旧根收口不能关新页面', {timeout:15000}, async t => {
  const f = await fixture(t), {runtime} = f;
  const first = await f.obtain();
  f.setStatus('continue');
  const waiting = await runtime.runRootTurn(first.ctx.conversationId,{userText:'提交申诉',inputId:'first'});
  assert.equal(f.checks(),2);
  assert.equal(goalRunOutcome(waiting),'awaiting-user');
  await runtime.completeConversation(first.ctx.conversationId,'awaiting-user',null,first.ctx.runId);
  assert.equal(first.client.cleanups,0);
  const next = await f.obtain('browser-goal','reply','initial');
  assert.equal(next.agent,first.agent);
  assert.equal(next.client,first.client);
  f.setStatus('complete');
  const done = await runtime.runRootTurn(next.ctx.conversationId,{userText:'已确认并完成验证',inputId:'reply'});
  assert.equal(goalRunOutcome(done),'completed');
  assert.equal(next.client.cleanups,0,'完成校验前后都由宿主收尾决定关闭');
  await runtime.completeConversation(next.ctx.conversationId,'stopped',null,first.ctx.runId);
  assert.equal(next.client.cleanups,0,'延迟旧根收口不能关闭继续执行中的页面');
  await runtime.completeConversation(next.ctx.conversationId,'completed',null,next.ctx.runId);
  assert.equal(next.client.cleanups,1);
});

test('等待用户时停止目标或直接取消会话都回收页面', {timeout:15000}, async t => {
  const f = await fixture(t);
  for (const direct of [false,true]) {
    const {ctx,agent,client} = await f.obtain(`cancel-${direct}`,`cancel-root-${direct}`);
    await f.runtime.runRootTurn(ctx.conversationId,{userText:'等待验证',inputId:'first'});
    await f.runtime.completeConversation(ctx.conversationId,'awaiting-user',null,ctx.runId);
    assert.equal(client.cleanups,0);
    if (direct) await agent.abort();
    else await f.runtime.completeConversation(ctx.conversationId,'stopped','用户取消',ctx.runId);
    assert.equal(client.cleanups,1);
  }
});

test('等待用户的会话不会被其它会话的 LRU 淘汰关闭', {timeout:15000}, async t => {
  const f = await fixture(t), {ctx,agent,client} = await f.obtain('waiting');
  await f.runtime.runRootTurn(ctx.conversationId,{userText:'等待验证',inputId:'first'});
  await f.runtime.completeConversation(ctx.conversationId,'awaiting-user',null,ctx.runId);
  for (let i=0;i<9;i++) await f.obtain(`other-${i}`,`root-${i}`);
  assert.equal(f.runtime.get(ctx.conversationId),agent);
  assert.equal(agent.isDisposed(),false);
  assert.equal(client.cleanups,0);
  await f.runtime.completeConversation(ctx.conversationId,'stopped',null,ctx.runId);
  assert.equal(client.cleanups,1);
});

test('terminal persistence failure still releases the runtime slot and browser pages', {timeout:15000}, async t => {
  const f=await fixture(t),{ctx,client}=await f.obtain('storage-failure','storage-root');
  const owner={conversationId:ctx.conversationId,rootRunId:ctx.runId,generation:ctx.generation};
  await f.runtime.journal.beginRoot(owner);
  const file=path.join(ctx.workspace.dir,'data/runtime-v2/run-journal.json'),backup=file+'.last-good';
  await fs.rename(file,backup);await fs.mkdir(file);
  try {
    await assert.rejects(f.runtime.completeConversation(ctx.conversationId,'failed','write failed',ctx.runId));
    assert.equal(client.cleanups,1,'browser cleanup must not depend on a terminal write succeeding');
    assert.equal(f.runtime.isBusy(),false);
    assert.equal((await f.runtime.journal.root(owner)).status,'failed');
  } finally {
    await fs.rm(file,{recursive:true});await fs.rename(backup,file);await f.runtime.journal.flush();
  }
});
