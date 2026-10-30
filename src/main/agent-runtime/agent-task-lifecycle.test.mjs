import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createAgentRuntime} from './core.mjs';
import {freezeModelPolicy, resolveModelPlan, hydrateModelPlan} from './model-policy.mjs';
import {goalRunOutcome} from './goal-driver.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, ms = 15000) {
  const deadline = Date.now() + ms;
  while (true) {
    const result = await read();
    if (result) return result;
    assert.ok(Date.now() < deadline, 'lifecycle scenario did not progress');
    await pause(10);
  }
}
// Windows 真机链路是 cmd.exe /d /s /c "<命令>"（command-execution-windows-shell.test.mjs
// 固化的语义）：单引号会被 cmd 当普通字符，路径须用双引号；POSIX 分支保持 bash 单引号。
const quote = process.platform === 'win32'
  ? value => `"${String(value)}"`
  : value => `'${String(value).replaceAll("'", "'\\''")}'`;

// Real PC core, Pi SDK, journal and managed processes; only model HTTP is scripted.
// Covers the unified-accepted dispatch path from docs/requirements/agent-task-lifecycle.md:
// the foreground task tool returns an acceptance receipt instead of blocking the SDK turn
// (R-02/R-03), the per-segment budget is soft at request admission and reviewed at the turn
// boundary (R-07), every settlement writes the durable inbox (R-11), and a settled child's
// managed command is awaited and consumed by the root before completion verification (R-04/R-09).
async function fixture(t, scenario, policy = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-lifecycle-')));
  const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  await fs.mkdir(workspace);
  // gate.cjs: writes proof, waits for the release file, then exits 0 (no dangling sockets).
  await fs.writeFile(path.join(workspace, 'gate.cjs'), "const fs=require('fs');fs.writeFileSync('proof.txt','WORK_DONE');const t=setInterval(()=>{if(fs.existsSync('release')){clearInterval(t);console.log('DONE');process.exit(0)}},20);");
  let runtime, agent, ctx, cid, mainCalls = 0, childCalls = 0, childAttempts = 0, checks = 0, outcome, running;
  const requests = [], errors = [];
  const exists = name => fs.stat(path.join(workspace, name)).then(() => true, () => false);
  const snapshot = async () => runtime.journal.snapshot();
  const processes = async () => Object.values((await snapshot()).processes);
  const tool = (name, args) => ({index:0, id:randomUUID(), type:'function', function:{name, arguments:JSON.stringify(args)}});
  const command = name => `${quote(process.execPath)} ${quote(path.join(workspace, name))}`;
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      const checking = body.messages.some(message => message.role === 'system' && JSON.stringify(message.content).includes('［Hemi 目标完成校验］'));
      const isChild = !checking && !body.tools?.some(item => item.function.name === 'task');
      let content, tools;
      if (checking) {
        checks++;
        const jobs = await processes();
        assert.ok(jobs.every(item => item.state === 'finished' && item.cleanupConfirmed), 'live work must not reach completion verification');
        content = JSON.stringify({status:'complete', reason:'成果与进程终态均已核对', evidence:['proof.txt 与命令完成事实'], remaining:[], nextAction:''});
      } else if (isChild) {
        const failingChild = scenario === 'model-error' || scenario === 'stop';
        childAttempts++;
        if (failingChild && childAttempts >= 2) {
          // Keep failing the child model so its inference ends while its command stays live.
          // 401 (auth) is non-retryable: managed sessions hand retryable failures (5xx etc.) to the
          // host model-recovery loop, which retries for a 30-minute window and would never settle.
          res.writeHead(401, {'content-type':'application/json'});
          res.end(JSON.stringify({error:{message:'synthetic child model auth failure'}}));
          return;
        }
        childCalls++;
        if (scenario === 'cross-segment') {
          // 第 1 次调用先做一步实际工作（前台立即完成），SDK 循环继续发起第 2 次请求——
          // 此时共享段预算已被主 Agent 的首次请求耗尽，第 2 次请求只能因软复盘被放行（R-02/R-07）。
          if (childCalls === 1) tools = [tool('bash', {command:'true', description:'第一步工作', timeout_ms:10000})];
          else content = '子任务完成：CROSS_SEGMENT_DONE';
        } else if (failingChild) {
          if (childAttempts === 1) tools = [tool('bash', {command:command('gate.cjs'), description:'后台文件工作', run_in_background:true, timeout_ms:30000})];
          else content = '不会到达：模型持续失败。';
        } else content = `子任务完成：${scenario.toUpperCase()}_DONE`;
      } else {
        mainCalls++;
        if (mainCalls === 1) tools = [tool('task', {agent:'fixer', prompt:'生成 proof.txt 并完成收尾。', description:'前台文件工作'})];
        else if (scenario === 'model-error' && mainCalls === 2) {
          // The child settled with an unknown report while its command stays live.
          // Release the gate so the root's wait resolves; the next call consumes the command fact.
          // (Only for the completion test: the stop test keeps the gate waiting for the root stop.)
          await fs.writeFile(path.join(workspace, 'release'), 'done');
          content = '子任务推理中断，命令仍在执行；等待真实完成。';
        } else content = '已收到全部结果，可以收口。';
      }
      res.writeHead(200, {'content-type':'text/event-stream'});
      const delta = tools ? {role:'assistant', tool_calls:tools.map((entry,index) => ({...entry,index}))} : {role:'assistant', content};
      for (const [value, reason] of [[delta,null],[{},tools ? 'tool_calls' : 'stop']]) res.write(`data: ${JSON.stringify({id:randomUUID(),model:body.model,choices:[{index:0,delta:value,finish_reason:reason}],...(reason ? {usage:{prompt_tokens:20,completion_tokens:10}} : {})})}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); res.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {modelKey:'test/lifecycle', providerId:'test', name:'Lifecycle fixture', model:'lifecycle', api:'openai-completions', apiKey:'SYNTHETIC_ONLY', baseUrl:`http://127.0.0.1:${server.address().port}/v1`, thinkingLevel:'off'};
  const store = {list:async () => ({defaultModelId:config.modelKey}), resolveStrict:async () => ({ok:true, config})};
  const policySnapshot = await freezeModelPolicy({store, modelKey:config.modelKey});
  const modelPlan = await hydrateModelPlan(resolveModelPlan(policySnapshot), store);
  const goalPolicy = {maxRequestsPerRound:3, maxRounds:10, maxRequests:20, ...policy};
  ctx = {conversationId:'lifecycle', runId:'lifecycle-root', generation:1, policySnapshot, modelPlan, config, inputSource:'text', workspace:{id:'proof',type:'project',dir:workspace}};
  cid = ctx.conversationId;
  runtime = createAgentRuntime({userDataDir:dataDir, goalPolicy, getProfiles:() => store,
    resolveCapabilities:async () => ({features:{},extensionConfig:{}}), getAccessService:() => null,
    loadArchiveAgent:() => null, loadArchiveTurns:() => [], saveArchiveAgent:() => true,
    sessionOptions:{}});
  agent = await runtime.obtain(ctx);
  t.after(async () => {
    await runtime.stopRoot(cid, ctx.runId).catch(() => {});
    await runtime.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(root, {recursive:true,force:true,maxRetries:5,retryDelay:50});
  });
  return {
    workspace, requests, errors, snapshot, processes, exists,
    get calls() {return mainCalls;}, get childCallCount() {return childCalls;}, get childAttempts() {return childAttempts;}, get checks() {return checks;},
    async start() {
      running = runtime.runRootTurn(cid, {userText:'完成文件任务', inputId:'one-user-input'})
        .then(async result => {outcome = goalRunOutcome(result, {cancelled:ctx.cancelled}); await runtime.completeConversation(cid, outcome, null, ctx.runId); return result;},
          async error => {if (!ctx.cancelled) throw error; outcome = 'stopped'; await runtime.completeConversation(cid, outcome, null, ctx.runId); return {aborted:true};});
      void running.catch(() => {});
    },
    async finish() { await running; assert.deepEqual(errors, []); return outcome; },
    async stop() { await runtime.stopRoot(cid, ctx.runId); },
    async entries() { return (await agent.exportEntries()).entries; },
  };
}

test('PC: foreground dispatch returns accepted, crosses the soft segment boundary and completes without circular waiting', {timeout:40000}, async t => {
  // Old behavior deadlocked here: the foreground task tool blocked the parent SDK turn while the
  // child waited for the ancestor to clear the per-segment admission limit (maxRequestsPerRound=1).
  // Soft review plus unified accepted must complete within the bounded fixture time.
  const f = await fixture(t, 'cross-segment', {maxRequestsPerRound:1, maxRounds:10, maxRequests:20});
  await f.start();
  assert.equal(await f.finish(), 'completed');
  // The child kept reasoning across the soft segment boundary instead of waiting for the ancestor.
  assert.ok(f.childCallCount >= 2, `child continued across the soft segment (calls=${f.childCallCount})`);
  const state = await f.snapshot();
  assert.equal(Object.keys(state.dispatches).length, 1);
  const dispatch = Object.values(state.dispatches)[0];
  assert.equal(dispatch.state, 'terminal');
  // 057 统一受理：background 不再是派单事实的一部分（受理路径一致），前台派单不得带后台标记。
  assert.ok(!dispatch.background, 'dispatch was issued without the background flag');
  // Unified accepted: the settlement still produced a durable inbox event and it was consumed.
  const event = state.inbox[`complete:${dispatch.taskId}`];
  assert.ok(event, 'foreground settlement produced a durable inbox event');
  assert.equal(event.state, 'consumed');
  const entries = await f.entries();
  const taskResult = entries.findLast(item => item.message?.role === 'toolResult' && item.message?.toolName === 'task');
  assert.match(JSON.stringify(taskResult?.message?.content ?? ''), /accepted/, 'task tool returned an acceptance receipt, not a blocking report');
  assert.ok(entries.some(item => item.customType === 'hemi_subagent_result' && JSON.stringify(item).includes('CROSS_SEGMENT_DONE')), 'final report was delivered into the parent context');
  const goal = Object.values(state.roots).find(item => item.goal).goal;
  assert.equal(goal.phase, 'complete');
});

test('PC: a settled child model failure keeps its command managed; the root waits and consumes the real terminal fact', {timeout:40000}, async t => {
  const f = await fixture(t, 'model-error', {maxRequestsPerRound:3, maxRounds:10, maxRequests:20});
  await f.start();
  assert.equal(await f.finish(), 'completed');
  const state = await f.snapshot();
  const jobs = await f.processes();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'succeeded', 'the healthy command was not killed by the child model failure');
  assert.equal(jobs[0].cleanupConfirmed, true);
  assert.ok(jobs[0].owner.taskId, 'the command stayed owned by the settled child');
  const entries = await f.entries();
  assert.ok(entries.some(item => item.customType === 'hemi_subagent_result'), 'the child stage report was delivered');
  assert.ok(entries.some(item => item.customType === 'hemi_subagent_result' && JSON.stringify(item).includes('DONE')), 'the command completion fact reached the parent context');
  assert.equal(f.checks, 1);
  const goal = Object.values(state.roots).find(item => item.goal).goal;
  assert.equal(goal.phase, 'complete');
});

test('PC: stopping the root cancels the managed command left by a settled child', {timeout:40000}, async t => {
  const f = await fixture(t, 'stop', {maxRequestsPerRound:3, maxRounds:10, maxRequests:20});
  await f.start();
  // Stop as soon as the child's stage report is pending: its live command must be cancelled with the root.
  // The child settles fast once its model failure is non-retryable (auth), while its gate keeps waiting.
  await until(async () => {
    const state = await f.snapshot();
    return Object.values(state.inbox).some(item => item.state === 'pending');
  }, 15000);
  await f.stop();
  assert.equal(await f.finish(), 'stopped');
  const jobs = await f.processes();
  assert.ok(jobs.length >= 1);
  assert.ok(jobs.every(item => item.cleanupConfirmed && item.status === 'cancelled'), 'no managed command outlived the stopped root');
});
