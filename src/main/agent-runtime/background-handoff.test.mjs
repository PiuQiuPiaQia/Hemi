import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {createAgentRuntime} from './core.mjs';
import {freezeModelPolicy, resolveModelPlan, hydrateModelPlan} from './model-policy.mjs';
import {GOAL_CHECK_SYSTEM, goalRunOutcome} from './goal-driver.mjs';
import {createBotHost} from '../bot/host.mjs';
import {createBotExecutor} from '../bot/runtime.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read) {
  const deadline = Date.now() + 15000;
  while (true) {
    const result = await read();
    if (result) return result;
    assert.ok(Date.now() < deadline, 'background handoff did not progress');
    await pause(10);
  }
}
const quote = value => process.platform === 'win32' ? `"${value.replaceAll('"','""')}"` : `'${value.replaceAll("'", "'\\''")}'`;

// Real PC core / Bot Host, Pi SDK, journal, shell processes and WebSocket; only model HTTP is controlled.
async function fixture(t, platform, mode, policy = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-handoff-')));
  const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  await fs.mkdir(workspace);
  const sockets = new WebSocketServer({host:'127.0.0.1', port:0});
  await new Promise(resolve => sockets.on('listening', resolve));
  const wsUrl = `ws://127.0.0.1:${sockets.address().port}`;
  await fs.writeFile(path.join(workspace, 'hung.cjs'), `const fs=require('fs');const ws=new WebSocket(${JSON.stringify(wsUrl)});ws.onopen=()=>{fs.writeFileSync('proof.txt','ACTUAL_WORK_DONE');console.log('WORK_DONE_WITH_OPEN_WS')};`);
  await fs.writeFile(path.join(workspace, 'normal.cjs'), "const fs=require('fs');fs.writeFileSync('started','yes');const tick=setInterval(()=>{if(fs.existsSync('release')){clearInterval(tick);fs.writeFileSync('proof.txt','NORMAL_WORK_DONE');console.log('NORMAL_COMPLETION')}},20);");
  let runtime, host, agent, ctx, cid, mainCalls = 0, childCalls = 0, checks = 0, outcome, running;
  let blockedResponse, atHandoff = false, releaseHandoff;
  const requests = [], errors = [], activities = [];
  const exists = name => fs.stat(path.join(workspace, name)).then(() => true, () => false);
  const snapshot = async () => runtime ? runtime.journal.snapshot() : until(async () => {
    try {return JSON.parse(await fs.readFile(path.join(dataDir, 'runtime-v2/run-journal.json'), 'utf8'));}
    catch (error) {if (error.code !== 'ENOENT') throw error; return null;}
  });
  const processes = async () => Object.values((await snapshot()).processes);
  const command = name => `${quote(process.execPath)} ${quote(path.join(workspace, name))}`;
  const tool = (name, args) => ({index:0, id:randomUUID(), type:'function', function:{name, arguments:JSON.stringify(args)}});
  const startJob = name => tool('bash', {command:command(name), description:name, run_in_background:true, timeout_ms:mode === 'timeout' ? 500 : 30000});
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      const checking = body.messages.some(message => message.role === 'system' && JSON.stringify(message.content).includes(GOAL_CHECK_SYSTEM));
      let content, tools;
      if (checking) {
        checks++;
        assert.ok((await processes()).every(item => item.state === 'finished' && item.cleanupConfirmed), 'live work must not reach completion verification');
        content = JSON.stringify({status:'complete', reason:'实际成果与进程清理均已核对', evidence:['实际 proof.txt 与已清理的命令'], remaining:[], nextAction:''});
      } else if (!body.tools?.length) content = '隔离验收';
      else if (mode === 'child-hung' && !body.tools.some(item => item.function.name === 'task')) {
        childCalls++;
        if (childCalls === 1) tools = [startJob('hung.cjs')];
        else content = '保留后台任务，等待主目标处理。';
      } else {
        mainCalls++;
        if (mode === 'child-hung') {
          if (mainCalls === 1) tools = [tool('task', {agent:'fixer',prompt:'生成 proof.txt；保留后台任务，等待主目标核对后停止。',description:'后台文件工作',background:true})];
          else if (JSON.stringify(body.messages).includes('分段交接') && !body.messages.some(item => item.role === 'tool' && item.name === 'task_cancel')) {
            await until(() => exists('proof.txt'));
            const task = Object.values((await snapshot()).dispatches)[0];
            tools = [tool('task_cancel', {id:task.taskId})];
          } else content = '等待子任务结果。';
        } else if (mainCalls === 1) tools = mode === 'two-jobs' ? [startJob('hung.cjs'), startJob('normal.cjs')]
          : [startJob(['normal','race','stop-handoff'].includes(mode) ? 'normal.cjs' : 'hung.cjs')];
        else if (mode === 'hung') {
          await until(() => exists('proof.txt'));
          const id = (await processes())[0].id;
          tools = [mainCalls === 2 ? tool('job_list', {}) : mainCalls === 3 ? tool('job_output', {job_id:id}) : tool('job_kill', {job_id:id})];
        } else if (mode === 'quiet-hung') {
          await until(() => exists('proof.txt'));
          if (mainCalls === 2) content = '已检查，等待后台任务。';
          else tools = [tool('job_kill', {job_id:(await processes())[0].id})];
        } else if (mode === 'two-jobs' && mainCalls === 2) {
          await until(() => exists('proof.txt'));
          tools = [tool('job_kill', {job_id:(await processes()).find(item => item.command.includes('hung.cjs')).id})];
        } else if (mode === 'stop-request' && mainCalls === 2) {
          blockedResponse = res;
          return;
        } else content = '保留仍需要的任务，等待真实完成事件。';
      }
      res.writeHead(200, {'content-type':'text/event-stream'});
      const delta = tools ? {role:'assistant', tool_calls:tools.map((entry,index) => ({...entry,index}))} : {role:'assistant', content};
      for (const [value, reason] of [[delta,null],[{},tools ? 'tool_calls' : 'stop']]) res.write(`data: ${JSON.stringify({id:randomUUID(),model:body.model,choices:[{index:0,delta:value,finish_reason:reason}],...(reason ? {usage:{prompt_tokens:20,completion_tokens:10}} : {})})}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); res.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {modelKey:'test/handoff', providerId:'test', name:'Handoff fixture', model:'handoff', api:'openai-completions', apiKey:'SYNTHETIC_ONLY', baseUrl:`http://127.0.0.1:${server.address().port}/v1`, thinkingLevel:'off'};
  const goalPolicy = {maxRequestsPerRound:1, maxRounds:10, maxRequests:20, ...policy};
  let call;
  if (platform === 'PC') {
    const store = {list:async () => ({defaultModelId:config.modelKey}), resolveStrict:async () => ({ok:true, config})};
    const policySnapshot = await freezeModelPolicy({store, modelKey:config.modelKey});
    const modelPlan = await hydrateModelPlan(resolveModelPlan(policySnapshot), store);
    ctx = {conversationId:'handoff', runId:'handoff-root', generation:1, policySnapshot, modelPlan, config, inputSource:'text', workspace:{id:'proof',type:'project',dir:workspace}};
    cid = ctx.conversationId;
    runtime = createAgentRuntime({userDataDir:dataDir, goalPolicy, getProfiles:() => store,
      resolveCapabilities:async () => ({features:{},extensionConfig:{}}), getAccessService:() => null,
      loadArchiveAgent:() => null, loadArchiveTurns:() => [], saveArchiveAgent:() => true,
      sessionOptions:{backgroundQuietReviewMs:mode === 'quiet-hung' ? 30 : 0}});
    agent = await runtime.obtain(ctx); agent.on('activity', value => activities.push(value));
    if (mode === 'race' || mode === 'stop-handoff') {
      // 057 软复盘：段交接在回合边界发生，命令完成不再由旧的请求触顶点触发；
      // 这两种场景改用定时释放命令，让完成事实与回合边界复盘各自独立到达。
      const checkpoint = runtime.journal.checkpointGoal;
      runtime.journal.checkpointGoal = async (...args) => {
        atHandoff = true;
        if (mode !== 'race') await new Promise(resolve => { releaseHandoff = resolve; });
        return checkpoint(...args);
      };
      setTimeout(() => { void fs.writeFile(path.join(workspace, 'release'), 'done').catch(() => {}); }, 200);
    }
  } else {
    host = await createBotHost({dataDir, defaultDir:workspace, goalPolicy, allowLoopbackModels:true, validateModel:async () => {},
      executorFactory:options => createBotExecutor({...options, backgroundQuietReviewMs:mode === 'quiet-hung' ? 30 : 0})});
    const {instanceId} = await host.request('handshake');
    call = (method, args = {}) => host.request(method, {instanceId, requestId:randomUUID(), ...args});
    await call('model.sync', {models:[config]});
    cid = (await call('session.create')).id;
  }
  t.after(async () => {
    releaseHandoff?.(); blockedResponse?.destroy();
    if (runtime) { await runtime.stopRoot(cid, ctx.runId).catch(() => {}); await runtime.close(); }
    await host?.close();
    for (const client of sockets.clients) client.terminate();
    await new Promise(resolve => sockets.close(resolve));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(root, {recursive:true,force:true,maxRetries:5,retryDelay:50});
  });
  return {
    workspace, requests, errors, activities, snapshot, processes, exists,
    get calls() {return mainCalls;}, get checks() {return checks;}, get atHandoff() {return atHandoff;}, get blocked() {return blockedResponse;},
    get childCalls() {return childCalls;},
    async start() {
      if (runtime) {
        running = runtime.runRootTurn(cid, {userText:'完成文件任务并处理所属后台工作', inputId:'one-user-input'})
          .then(async result => {outcome = goalRunOutcome(result, {cancelled:ctx.cancelled}); await runtime.completeConversation(cid, outcome, null, ctx.runId); return result;},
            async error => {if (!ctx.cancelled) throw error; outcome = 'stopped'; await runtime.completeConversation(cid, outcome, null, ctx.runId); return {aborted:true};});
        void running.catch(() => {});
      } else await call('flow.command', {id:cid, command:{type:'send',input:{inputId:'one-user-input',text:'完成文件任务并处理所属后台工作'}}});
    },
    async finish() {
      if (runtime) await running;
      else {
        const flow = await until(async () => {const s = await call('flow.snapshot', {id:cid}); return s.phase === 'idle' && Object.keys(s.runs).length ? s : null;});
        assert.equal(flow.timeline.filter(item => item.kind === 'user').length, 1);
        assert.equal(Object.keys(flow.runs).length, 1);
        outcome = Object.values(flow.runs)[0].outcome;
      }
      assert.deepEqual(errors, []);
      return outcome;
    },
    async stop() {
      if (runtime) await runtime.stopRoot(cid, ctx.runId);
      else await call('flow.command', {id:cid,command:{type:'stop'}});
      releaseHandoff?.();
    },
    async entries() {
      if (agent) return (await agent.exportEntries()).entries;
      const dir = path.join(dataDir, 'runtime-v2/sessions/pi');
      const files = (await fs.readdir(dir)).filter(name => name.endsWith('.jsonl'));
      return (await Promise.all(files.map(name => fs.readFile(path.join(dir,name),'utf8')))).flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
    },
  };
}

for (const platform of ['PC','Bot']) {
  for (const mode of ['hung','quiet-hung']) test(`${platform}: completed work with an open WebSocket can be inspected and stopped across request segments (${mode})`, {timeout:25000}, async t => {
    const f = await fixture(t, platform, mode); await f.start(); assert.equal(await f.finish(), 'completed');
    const jobs = await f.processes(); assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'cancelled'); assert.equal(jobs[0].cleanupConfirmed, true);
    assert.equal(await fs.readFile(path.join(f.workspace,'proof.txt'),'utf8'), 'ACTUAL_WORK_DONE');
    const root = Object.values((await f.snapshot()).roots).find(item => item.goal);
    // 057 软复盘：段边界不再拒绝请求，模型在单回合内跨软段边界连续工作（R-07）；
    // 回合结束时已无未决工作则无需段交接（checkpoint 为空是正确行为），完成校验收口。
    assert.ok(f.calls >= 2, `requests admitted across the soft segment boundary (calls=${f.calls})`);
    assert.equal(root.goal.phase, 'complete'); assert.equal(f.checks, 1);
    const entries = await f.entries(); assert.equal(entries.filter(item => item.type === 'custom' && item.customType === 'hemi.input').length, 1);
    // 057 软复盘（R-02/R-07）：跨段不再依赖 60s 静默复核兜底唤醒——reviewPending 立即唤醒
    // 根复盘（goal round 推进），模型自己核验并停止不再需要的命令；quiet review 保留为长静默兜底。
    if (mode === 'quiet-hung') assert.ok(root.goal.round >= 2, `soft segment review woke the root (round=${root.goal.round})`);
  });
  test(`${platform}: a quiet required long job survives handoff and retains its original identity and deadline`, {timeout:25000}, async t => {
    const f = await fixture(t, platform, 'normal'); await f.start();
    await until(async () => f.calls >= 2 && await f.exists('started'));
    const before = (await f.processes())[0]; await pause(80);
    assert.equal((await f.processes())[0].state, 'active'); assert.equal(f.checks, 0);
    await fs.writeFile(path.join(f.workspace,'release'),'done'); assert.equal(await f.finish(),'completed');
    const after = (await f.processes())[0]; assert.equal(after.id,before.id); assert.equal(after.pid,before.pid); assert.equal(after.startedAt,before.startedAt); assert.equal(after.status,'succeeded');
    const entries = await f.entries(); assert.equal(entries.filter(item => item.customType === 'hemi_background_command_result').length,1);
    assert.equal((await f.processes()).length,1);
  });
  test(`${platform}: stopping one obsolete job after handoff preserves a second required job`, {timeout:25000}, async t => {
    const f = await fixture(t, platform, 'two-jobs'); await f.start();
    await until(async () => (await f.processes()).some(item => item.status === 'cancelled'));
    const jobs = await f.processes(); assert.equal(jobs.length,2); assert.equal(jobs.filter(item => item.state === 'active').length,1);
    await fs.writeFile(path.join(f.workspace,'release'),'done'); assert.equal(await f.finish(),'completed');
    assert.equal((await f.processes()).filter(item => item.status === 'succeeded').length,1);
  });
  test(`${platform}: handoff preserves the command hard timeout and delivers its actual terminal state`, {timeout:25000}, async t => {
    const f = await fixture(t,platform,'timeout'); await f.start(); assert.equal(await f.finish(),'completed');
    const jobs=await f.processes(); assert.equal(jobs.length,1); assert.equal(jobs[0].status,'timed-out'); assert.equal(jobs[0].cleanupConfirmed,true);
    const entries=await f.entries(); assert.ok(entries.some(item=>item.customType==='hemi_background_command_result'&&JSON.stringify(item).includes('timed-out')));
  });
  test(`${platform}: user stop after handoff prevents late requests and clears the real process`, {timeout:25000}, async t => {
    const f = await fixture(t, platform, 'stop-request'); await f.start(); await until(() => f.blocked);
    await f.stop(); assert.equal(await f.finish(),'stopped'); const count = f.requests.length; await pause(80);
    assert.equal(f.requests.length,count); assert.equal(f.checks,0); assert.ok((await f.processes()).every(item => item.cleanupConfirmed));
  });
  for (const policy of [{maxRounds:1},{maxRequests:1}]) test(`${platform}: exhausted ${Object.keys(policy)[0]} clears live work and closes partial without verification`, {timeout:25000}, async t => {
    const f = await fixture(t, platform, 'budget', policy); await f.start(); assert.equal(await f.finish(),'partial');
    // 057 软复盘：maxRounds 场景第 2 个请求软性发出（段不拒请求，回合边界才收口）；maxRequests 硬预算仍在准入处拒绝。
    if (Object.keys(policy)[0] === 'maxRequests') assert.equal(f.calls, 1); else assert.ok(f.calls >= 2, `segment admitted softly (calls=${f.calls})`);
    assert.equal(f.checks,0); assert.equal((await f.processes()).length,1);
    assert.ok((await f.processes()).every(item => item.cleanupConfirmed && item.status === 'cancelled'));
    const goal = Object.values((await f.snapshot()).roots).find(item => item.goal).goal; assert.equal(goal.phase,'budget_limited'); assert.equal(goal.round,1);
  });
  test(`${platform}: a child reaching the shared segment limit wakes a parent waiting on its live command`, {timeout:25000}, async t => {
    const f = await fixture(t,platform,'child-hung',{maxRequestsPerRound:3}); await f.start(); assert.equal(await f.finish(),'completed');
    assert.ok(f.childCalls >= 1); const state=await f.snapshot(); assert.equal(Object.keys(state.dispatches).length,1);
    const jobs=await f.processes(); assert.equal(jobs.length,1); assert.ok(jobs[0].owner.taskId); assert.equal(jobs[0].status,'cancelled'); assert.equal(jobs[0].cleanupConfirmed,true);
    const goal=Object.values(state.roots).find(item=>item.goal).goal; assert.ok(goal.checkpoints.length>=1); assert.equal(goal.phase,'complete');
  });
}
test('PC: completion racing the durable handoff is delivered exactly once before verification', {timeout:25000}, async t => {
  const f = await fixture(t,'PC','race'); await f.start(); assert.equal(await f.finish(),'completed'); assert.equal(f.atHandoff,true);
  assert.equal((await f.processes())[0].status,'succeeded'); assert.equal(f.checks,1);
  const entries = await f.entries(); assert.equal(entries.filter(item => item.customType === 'hemi_background_command_result').length,1);
  assert.ok(entries.some(item => item.customType === 'hemi_background_command_result' && JSON.stringify(item).includes('NORMAL_COMPLETION')));
});
test('PC: cancellation while checkpoint persistence is delayed cannot advance or restart the goal', {timeout:25000}, async t => {
  const f = await fixture(t,'PC','stop-handoff'); await f.start(); await until(() => f.atHandoff); await f.stop(); assert.equal(await f.finish(),'stopped');
  // 057 软复盘：段边界软放行了第 2 次请求（不再硬拒）；取消后不得再有任何新请求，也不得推进或重启目标。
  const count = f.requests.length; await pause(80);
  assert.equal(f.requests.length, count); assert.ok(f.calls >= 1 && f.calls <= 2, `calls=${f.calls}`);
  assert.equal(f.checks,0); assert.ok((await f.processes()).every(item => item.cleanupConfirmed));
  const goal = Object.values((await f.snapshot()).roots).find(item => item.goal).goal; assert.equal(goal.round,1); assert.notEqual(goal.phase,'complete');
});
