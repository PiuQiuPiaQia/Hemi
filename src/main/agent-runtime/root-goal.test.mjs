import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createAgentRuntime} from './core.mjs';
import {freezeModelPolicy, resolveModelPlan, hydrateModelPlan} from './model-policy.mjs';
import {GOAL_CHECK_SYSTEM, goalRunOutcome} from './goal-driver.mjs';

for (const mode of ['normal','chunked','fail-open']) test(`shared PC runtime ${mode}`, {timeout:30000}, async t => {
  const chunked=mode==='chunked', bypassing=mode==='fail-open';
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-root-goal-')));
  const requests = [], checks = [], calls = [];
  let generated = 0;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    let content, tool;
    if (body.messages.some(message => message.role === 'system' && String(message.content).includes(GOAL_CHECK_SYSTEM))) {
      const done = Boolean(await fs.stat(path.join(root, 'proof.txt')).catch(() => null));
      checks.push(done ? 'complete' : 'continue');
      content = bypassing ? 'not json' : JSON.stringify({status:done ? 'complete' : 'continue', reason:done ? '实际文件已写入，符合原请求' : '文件尚未写入',
        evidence:[done ? 'write 的实际工具结果和 proof.txt' : '只有计划，尚无文件'], remaining:done ? [] : ['写入 proof.txt'], nextAction:done ? '' : '调用 write 写入 proof.txt'});
    } else {
      generated++;
      if (generated === 1) {
        if (chunked || bypassing) tool = {name:'ls', arguments:'{"path":"."}'};
        else content = 'FIRST_ROUND_PLAN';
      } else if (!await fs.stat(path.join(root, 'proof.txt')).catch(() => null)) {
        tool = {name:'write', arguments:JSON.stringify({path:'proof.txt',content:'SHARED_GOAL_PROOF'})};
      } else content = 'FINAL_ROUND_DONE';
    }
    res.writeHead(200, {'content-type':'text/event-stream'});
    const delta = tool ? {role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:tool}]} : {role:'assistant',content};
    for (const [value, finish] of [[delta,null],[{},tool ? 'tool_calls' : 'stop']]) res.write(`data: ${JSON.stringify({id:randomUUID(),model:'shared-goal',choices:[{index:0,delta:value,finish_reason:finish}],...(finish ? {usage:{prompt_tokens:20,completion_tokens:10}} : {})})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let runtime;
  t.after(async () => {
    await runtime?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(root, {recursive:true,force:true});
  });
  const config = {modelKey:'test/shared-goal',providerId:'test',model:'shared-goal',api:'openai-completions',apiKey:'SYNTHETIC_ONLY',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,thinkingLevel:'off'};
  const store = {list:async () => ({defaultModelId:config.modelKey}),resolveStrict:async () => ({ok:true,config})};
  const policySnapshot = await freezeModelPolicy({store,modelKey:config.modelKey});
  const modelPlan = await hydrateModelPlan(resolveModelPlan(policySnapshot), store);
  const ctx = {conversationId:'shared-goal',runId:'shared-root',generation:1,policySnapshot,modelPlan,config,inputSource:'text',workspace:{id:'proof',type:'project',dir:root}};
  runtime = createAgentRuntime({userDataDir:path.join(root,'data'),getProfiles:() => store,resolveCapabilities:async () => ({features:{},extensionConfig:{}}),getAccessService:() => null,
    loadArchiveAgent:() => null,loadArchiveTurns:() => [],saveArchiveAgent:() => true,
    ...(chunked ? {goalPolicy:{maxRequestsPerRound:1}} : {}),onGoalVerification:(_id,call) => calls.push(call)});
  const agent = await runtime.obtain(ctx);
  const activities = [], streams = [];
  agent.on('activity', activity => activities.push(activity.phase));
  agent.on('stream', event => streams.push(event.type));
  const result = await runtime.runRootTurn(ctx.conversationId, {userText:'写入 proof.txt，内容 SHARED_GOAL_PROOF',inputId:'one-input'});
  assert.equal(goalRunOutcome(result), 'completed');
  await runtime.completeConversation(ctx.conversationId, goalRunOutcome(result), null, ctx.runId);
  const journal = await runtime.journal.snapshot(), goal = journal.roots[ctx.runId].goal;
  assert.equal(journal.roots[ctx.runId].status, 'completed');
  assert.equal(await fs.readFile(path.join(root,'proof.txt'),'utf8'), 'SHARED_GOAL_PROOF');
  assert.equal(Object.keys(journal.requests).length, requests.length, 'every execution and verification HTTP request is accounted');
  assert.ok(Object.values(journal.requests).every(row => row.owner.rootRunId === ctx.runId && row.endedAt));
  const entries = (await agent.exportEntries()).entries;
  assert.equal(entries.filter(entry => entry.message?.role === 'user').length, 1);
  if (chunked || bypassing) {
    // 057 软段边界（R-02/R-07）：请求不再被段预算硬拒，主模型单回合内跨段连续工作
    // （ls→write→收口），回合结束软复盘一次即完成；不再强制分段续跑或注入续跑条目。
    assert.equal(goal.round, 1);
    assert.deepEqual(checks, ['complete']);
    assert.equal(calls.length, 1);
    if(bypassing){
      assert.equal(goal.verificationAttempts[0].bypassed,true);
      assert.equal(goal.verifications[0].verificationBypassed,true);
      assert.deepEqual(goal.verifications[0].evidence,[],'host fallback must not fabricate verification evidence');
      assert.equal(goal.verifications.length,1);
      assert.equal(generated,3,'verifier fault must not re-enter the execution agent');
      assert.equal(entries.filter(entry=>entry.message?.toolName==='write').length,1);
    }
    assert.equal(activities.filter(phase => phase === 'verifying').length, 1);
    assert.ok(!activities.includes('continuing'));
    assert.equal(activities.at(-1), 'finishing');
    assert.equal(entries.filter(entry => entry.customType === 'hemi_goal_continuation').length, 0);
    assert.equal(goal.limitHistory, undefined);
    assert.ok(result.toolNames.includes('ls')); assert.ok(result.toolNames.includes('write'));
    assert.ok(result.texts.includes('FINAL_ROUND_DONE'));
  } else {
    assert.equal(goal.round, 2); assert.deepEqual(checks, ['continue','complete']); assert.equal(calls.length, 2);
    assert.equal(activities.filter(phase => phase === 'verifying').length, 2);
    assert.ok(activities.includes('continuing'));
    assert.equal(activities.at(-1), 'finishing');
    assert.ok(streams.includes('hemi_message_end'));
    assert.equal(entries.filter(entry => entry.customType === 'hemi_goal_continuation').length, 1);
    assert.ok(result.toolNames.includes('write'));
    assert.equal(goal.policy.maxRequestsPerRound, 60);
    assert.deepEqual(result.texts, ['FIRST_ROUND_PLAN','FINAL_ROUND_DONE']);
  }
});
