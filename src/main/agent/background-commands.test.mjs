import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHemiSession } from './hemi-session.mjs';
import { createRunJournal } from '../agent-runtime/run-journal.mjs';
import { createContextStore } from '../agent-runtime/context-store.mjs';
import { BACKGROUND_WAIT_GUIDANCE } from './background-wait.mjs';
import { buildAgentAppendSystem } from './main-agent.mjs';
import { loadRoles } from './agent-roles.mjs';

const posix = { skip: process.platform === 'win32' ? '真实 POSIX shell；Windows 进程树另需真机验证' : false };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (!fn()) { assert.ok(Date.now() < deadline, '等待后台状态超时'); await pause(10); }
}
async function fixture(t, command, toolOptions = {}, behavior = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hemi-background-'));
  const requests = [], activities = [], sessions = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const text = JSON.stringify(body.messages);
    const independent = text.includes('INDEPENDENT');
    const completed = text.includes('［后台命令完成');
    const called = body.messages.some(message => message.role === 'tool'
      || message.content?.some?.(part => part.type === 'tool_result'));
    const delta = behavior.respond?.({ body, completed, called, index: requests.length })
      ?? (independent ? { content: 'OTHER_CHAT_DONE' } : completed ? { content: 'RESUMED_WITH_RESULT' }
      : called ? { content: '等待后台命令，完成后继续。' }
      : { tool_calls: [{ index: 0, id: `command-${requests.length}`, type: 'function', function: {
        name: 'bash', arguments: JSON.stringify({ command: command(dir), yield_ms: 20, ...toolOptions }),
      } }] });
    if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((call, index) => ({ ...call, index }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (behavior.api === 'anthropic-messages') {
      const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      emit('message_start', { message: { id: 'background-test', type: 'message', role: 'assistant',
        model: 'test-background', content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
      if (delta.tool_calls) {
        for (const [index, call] of delta.tool_calls.entries()) {
          emit('content_block_start', { index, content_block: { type: 'tool_use', id: call.id, name: call.function.name, input: {} } });
          emit('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: call.function.arguments } });
          emit('content_block_stop', { index });
        }
      } else {
        emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: delta.content } });
        emit('content_block_stop', { index: 0 });
      }
      emit('message_delta', { delta: { stop_reason: delta.tool_calls ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } });
      emit('message_stop', {});
      res.end(); return;
    }
    for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } }]) {
      res.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'test-background', ...chunk })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { modelKey: 'p/test', providerId: 'p', credentialRef: 'p', api: behavior.api ?? 'openai-completions',
    model: 'test-background', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic' };
  const journal = createRunJournal({ dir: path.join(dir, 'journal') });
  async function make(id = 'first', role = 'main') {
    const rootOwner = { conversationId: id, rootRunId: `run-${id}`, generation: 1 };
    const owner = { ...rootOwner, ...(role === 'main' ? {} : { taskId: `task-${id}` }) };
    await journal.beginRoot(rootOwner);
    let cancelled = false;
    const execution = { journal, owner, contextStore: createContextStore({ dir: path.join(dir, 'contexts') }),
      plan: { role, primary: config, allowedFallbacks: [] },
      store: { resolveStrict: async () => ({ ok: true, config }) },
      budgets: { maxRequestsPerRun: 10 }, purpose: 'main', cancelled: () => cancelled,
    };
    const session = createHemiSession({ cwd: dir, agentDir: path.join(dir, `agent-${id}`), model: config,
      accessWorkspaceDir: dir, tools: ['bash'], features: {}, executionContext: execution,
      appendSystem: role === 'main' ? buildAgentAppendSystem() : [loadRoles().get(role).systemPrompt],
      settings: { retry: { enabled: false } },backgroundQuietReviewMs:behavior.quietMs??0,
    });
    session.on('activity', activity => activities.push({ id, ...activity }));
    sessions.push(session);
    return { session, execution, owner, cancelOwnership: () => { cancelled = true; } };
  }
  t.after(async () => {
    await Promise.all(sessions.map(s => s.abort())); sessions.forEach(s => s.dispose());
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, requests, activities, journal, make };
}

const commandCall = (id, command, description) => ({ index: 0, id, type: 'function',
  function: { name: 'bash', arguments: JSON.stringify({ command, description }) } });

test('真实 SDK：服务独立就绪核验后可收口，同会话新问题不用等服务退出',{...posix,timeout:15000},async t=>{
  const f=await fixture(t,()=>`"${process.execPath}" -e "require('node:http').createServer((q,s)=>s.end('REAL_SERVICE_READY')).listen(0,'127.0.0.1',function(){require('node:fs').writeFileSync('service-port',String(this.address().port))})"`,
    {run_in_background:true,timeout_ms:12000},{quietMs:20,respond:({body,index})=>{
      if(JSON.stringify(body.messages).includes('FOLLOW_UP_QUESTION'))return {content:'FOLLOW_UP_ANSWER'};
      if(index===1)return undefined;
      if(index===2)return {tool_calls:[commandCall('readiness',`"${process.execPath}" -e "const fs=require('node:fs'),end=Date.now()+3000;async function probe(){try{const port=fs.readFileSync('service-port','utf8');const r=await fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(500)});if(await r.text()==='REAL_SERVICE_READY'){console.log('BOUNDED_READINESS_OK');return}}catch{}if(Date.now()>end)process.exit(1);setTimeout(probe,20)}probe()"`)]};
      return {content:'SERVICE_READY_CONFIRMED'};
    }});
  const {session,execution,owner}=await f.make('service');const progress=[];session.on('progress',e=>progress.push(e));
  await f.journal.beginGoal(owner,'Start and keep a development service',{maxRounds:3,maxRequests:10,maxRequestsPerRound:10,noProgressRounds:3});
  assert.equal((await session.prompt('Start and keep a development service')).lastText,'SERVICE_READY_CONFIRMED');
  const jobs=await session.backgroundCommand({action:'list'});assert.equal(jobs.length,1);assert.equal(jobs[0].status,'running');
  assert.match(JSON.stringify(f.requests.at(-1).messages),/BOUNDED_READINESS_OK/);
  assert.ok(!f.activities.some(a=>a.phase==='waiting-background'));
  assert.equal(progress.find(e=>e.kind==='tool-end'&&e.toolCallId===jobs[0].toolCallId).background,false,'service launch tool closes while process remains running');
  await f.journal.checkGoal(owner);await f.journal.recordGoalCheck(owner,{status:'complete',reason:'real HTTP readiness',evidence:['BOUNDED_READINESS_OK'],remaining:[],nextAction:''});await f.journal.finishRoot(owner,'completed');
  await session.abort({preserveBackground:true});
  const next={...owner,rootRunId:'follow-up'};await f.journal.beginRoot(next);session.setExecutionContext({...execution,owner:next});
  assert.equal((await session.prompt('FOLLOW_UP_QUESTION')).lastText,'FOLLOW_UP_ANSWER');
  assert.equal((await session.backgroundCommand({action:'list'}))[0].status,'running');
  await pause(60);assert.equal(f.requests.length,4,'quiet service does not cause model polling');
  const stopped=await session.backgroundCommand({action:'stop',jobId:jobs[0].id});assert.equal(stopped.cleanupConfirmed,true);
  assert.equal(f.requests.length,4,'stopping a retained service does not replay its original goal');
});

for (const api of ['openai-completions', 'anthropic-messages']) {
  for (const role of ['main', 'fixer']) {
    test(`${api} ${role}：占位命令在 Shell 前让出生成，宿主等待后仅续跑一次`, { ...posix, timeout: 10000 }, async t => {
      const f = await fixture(t, dir => `until [ -f '${path.join(dir, 'release')}' ]; do sleep 0.02; done; printf REAL_BACKGROUND_FAILURE >&2; exit 7`,
        { run_in_background: true }, { api, respond: ({ called, completed }) => completed
          ? { content: 'RESUMED_WITH_RESULT' } : called
            ? { tool_calls: [commandCall('idle-echo', 'echo 等待推送完成'),
              commandCall('idle-printf', "printf '%s\\n' 'waiting for background'")] } : undefined });
      const { session, owner } = await f.make('guarded', role);
      const progress=[]; session.on('progress',event=>progress.push(event));
      const running = session.prompt('Run a background task and wait for its actual result');
      await until(() => f.activities.some(a => a.phase === 'waiting-background'));
      const callId=progress.find(event=>event.background)?.toolCallId;
      assert.ok(callId,'后台受理和真正完成使用同一个工具调用身份');
      assert.equal(progress.filter(event=>event.kind==='tool-end'&&event.toolCallId===callId&&!event.background).length,0);
      assert.equal(f.requests.length, 2, '第一次占位调用就停止生成，无须模型自行纠正');
      const system = JSON.stringify(api === 'anthropic-messages' ? f.requests[0].system
        : f.requests[0].messages.filter(m => m.role === 'system'));
      assert.ok(system.includes(BACKGROUND_WAIT_GUIDANCE), '主／子角色均实际收到共用系统规则');
      await pause(70);
      assert.equal(f.requests.length, 2, '等待阶段不调用模型或轮询后台结果');
      assert.equal(Object.keys((await f.journal.snapshot()).processes).length, 1, '占位命令未启动进程');
      await writeFile(path.join(f.dir, 'release'), 'done');
      const result = await running;
      assert.equal(result.modelError, null); assert.equal(result.aborted, false);
      assert.equal(result.lastText, 'RESUMED_WITH_RESULT');
      const terminal=progress.filter(event=>event.kind==='tool-end'&&event.toolCallId===callId&&!event.background);
      assert.equal(terminal.length,1);assert.equal(terminal[0].isError,true);assert.match(terminal[0].text,/exit=7/);
      assert.match(terminal[0].observationRef,/^ctx-/,'核验依据来自真实后台结果快照，不能使用受理回执');
      assert.equal(f.requests.length, 3);
      const resume = JSON.stringify(f.requests[2].messages);
      assert.match(resume, /REAL_BACKGROUND_FAILURE/); assert.match(resume, /exit=7/);
      assert.match(resume, /占位等待命令未执行/);
      const state = await f.journal.snapshot();
      assert.equal(Object.keys(state.processes).length, 1);
      const processes = Object.values(state.processes), requests = Object.values(state.requests);
      assert.equal(processes[0].code, 7); assert.equal(processes[0].cleanupConfirmed, true);
      assert.ok(requests.every(r => r.owner.rootRunId === owner.rootRunId && r.owner.taskId === owner.taskId));
      const entries = (await session.exportEntries()).entries;
      const yielded = entries.filter(e => e.message?.role === 'toolResult' && ['idle-echo', 'idle-printf'].includes(e.message.toolCallId));
      assert.equal(yielded.length, 2);
      assert.ok(yielded.every(e => !e.message.isError && e.message.details.actionState === 'not-executed'), '让出等待不伪报命令失败或已执行');
      assert.equal(entries.filter(e => e.customType === 'hemi_background_command_result').length, 1);
      assert.equal(state.roots[owner.rootRunId].status, 'running', '让出生成没有提前终结用户目标');
    });
  }
}

test('占位等待与独立工作混合在同批工具时，保留真实工作及后续生成', { ...posix, timeout: 10000 }, async t => {
  const f = await fixture(t, dir => `until [ -f '${path.join(dir, 'release')}' ]; do sleep 0.02; done; printf MIXED_BACKGROUND`,
    { run_in_background: true }, { respond: ({ called, completed, index }) => completed ? { content: 'RESUMED_WITH_RESULT' }
      : called && index === 2 ? { tool_calls: [commandCall('idle', 'echo 等待推送'),
        commandCall('independent', "printf 'INDEPENDENT_WORK waiting' > independent.txt")] }
        : called ? { content: '等待后台结果。' } : undefined });
  const { session } = await f.make();
  const running = session.prompt('Background command with independent work');
  await until(() => f.activities.some(a => a.phase === 'waiting-background'));
  assert.equal(await readFile(path.join(f.dir, 'independent.txt'), 'utf8'), 'INDEPENDENT_WORK waiting');
  assert.equal(f.requests.length, 3, '混合批次保留独立工作的结果供模型处理');
  assert.match(JSON.stringify(f.requests[2].messages), /占位等待命令未执行/);
  assert.equal(Object.keys((await f.journal.snapshot()).processes).length, 2);
  await writeFile(path.join(f.dir, 'release'), 'done');
  assert.equal((await running).lastText, 'RESUMED_WITH_RESULT');
});

test('没有所属后台命令时，普通 echo 正常执行', { ...posix, timeout: 10000 }, async t => {
  const f = await fixture(t, () => 'echo waiting for user', {}, { respond: ({ called }) => called ? { content: 'DONE' } : undefined });
  const { session } = await f.make('standalone', 'fixer');
  assert.equal((await session.prompt('Print a literal marker')).lastText, 'DONE');
  const processes = Object.values((await f.journal.snapshot()).processes);
  assert.equal(processes.length, 1); assert.match(processes[0].output, /waiting for user/);
});

test('防空转让出后仍可取消后台命令，不投递迟到结果', { ...posix, timeout: 10000 }, async t => {
  const f = await fixture(t, () => 'sleep 30', { run_in_background: true },
    { respond: ({ called }) => called ? { tool_calls: [commandCall('idle', 'true')] } : undefined });
  const { session } = await f.make('cancel', 'fixer');
  const running = session.prompt('Run a cancellable background command');
  await until(() => f.activities.some(a => a.phase === 'waiting-background'));
  await session.abort();
  assert.equal((await running).aborted, true);
  assert.equal(f.requests.length, 2);
  const processes = Object.values((await f.journal.snapshot()).processes);
  assert.equal(processes.length, 1); assert.equal(processes[0].status, 'cancelled');
  assert.equal(processes[0].cleanupConfirmed, true);
  assert.equal((await session.exportEntries()).entries.filter(e => e.customType === 'hemi_background_command_result').length, 0);
});

test('后台释放模型等待，独立会话可工作；完成结果在同一目标自动消费且只唤醒一次', posix, async t => {
  const f = await fixture(t, dir => `export HEMI_TEST_LABEL=display\nprintf started; until [ -f '${path.join(dir, 'release')}' ]; do sleep 0.02; done; printf BACKGROUND_ACTUAL_RESULT\n# ${'display '.repeat(50)}`,
    { description: '  检查构建状态\n并核对结果  ' });
  const { session } = await f.make();
  let settled = false;
  const result = session.prompt('BACKGROUND').then(value => { settled = true; return value; });
  await until(() => f.activities.some(a => a.phase === 'waiting-background'));
  await until(() => f.activities.some(a => a.jobs[0]?.lastOutputAt != null));
  const job = f.activities.findLast(a => a.jobs.length)?.jobs[0];
  assert.equal(job.description, '检查构建状态 并核对结果');
  assert.ok(job.lastOutputAt >= job.startedAt);
  assert.match(job.command, /# display/);
  assert.ok(job.command.length > 300, '详情保留实际命令，不能只剩环境准备行');
  assert.equal(job.commandTruncated, false);
  assert.equal(session.isBusy(), true);
  assert.equal(settled, false, '模型生成结束不等于目标已完成');
  const count = f.requests.length;
  const other = await f.make('other');
  assert.match((await other.session.prompt('INDEPENDENT')).texts.join(''), /OTHER_CHAT_DONE/);
  assert.equal(settled, false, '另一个会话不需要等待前一个后台命令');
  await pause(70);
  assert.equal(f.requests.length, count + 1, '等待期间不轮询模型');
  await writeFile(path.join(f.dir, 'release'), 'done');
  const answer = await result;
  assert.equal(answer.aborted, false);
  assert.match(answer.texts.join(''), /RESUMED_WITH_RESULT/);
  const resumed = f.requests.filter(r => JSON.stringify(r.messages).includes('［后台命令完成'));
  assert.equal(resumed.length, 1);
  assert.match(JSON.stringify(resumed[0].messages), /BACKGROUND_ACTUAL_RESULT/);
  const state = await f.journal.snapshot(), processes = Object.values(state.processes);
  assert.equal(processes.length, 1);
  assert.equal(processes[0].background, true);
  assert.equal(processes[0].state, 'finished');
  assert.equal(processes[0].owner.rootRunId, 'run-first');
  assert.equal(processes[0].description, '检查构建状态 并核对结果');
  assert.ok(processes[0].lastOutputAt >= job.lastOutputAt);
  assert.equal(f.activities.at(-1).phase, 'running');
});

test('等待后台时停止目标会清理真实进程树，旧完成不会唤醒或留下延迟副作用', posix, async t => {
  const f = await fixture(t, dir => `sleep 1; printf forbidden > '${path.join(dir, 'late')}'`);
  const { session, cancelOwnership } = await f.make();
  const pending = session.prompt('CANCEL');
  await until(() => f.activities.some(a => a.phase === 'waiting-background'));
  const job = f.activities.findLast(a => a.jobs.length)?.jobs[0];
  assert.equal(job.description, '', '没有说明的旧调用仍可执行');
  assert.equal(job.lastOutputAt, null, '尚无输出不能冒充最近有输出');
  const count = f.requests.length;
  cancelOwnership();
  await session.abort();
  assert.equal((await pending).aborted, true);
  await pause(1100);
  assert.equal(f.requests.length, count);
  assert.equal(await readFile(path.join(f.dir, 'late'), 'utf8').catch(() => null), null);
  assert.equal(Object.values((await f.journal.snapshot()).processes)[0].state, 'finished');
});

test('后台等待中的交接取消真实命令，不把取消结果再次唤醒旧目标',posix,async t=>{
 const f=await fixture(t,dir=>`sleep 2; printf forbidden > '${path.join(dir,'late')}'`);
 const {session}=await f.make();
 const pending=session.prompt('HANDOFF');
 await until(()=>f.activities.some(activity=>activity.phase==='waiting-background'));
 const before=f.requests.length;
 await session.requestHandoff();
 assert.equal((await pending).aborted,true);
 assert.equal(f.requests.length,before);
 assert.ok(Object.values((await f.journal.snapshot()).processes).every(record=>record.state==='finished'&&record.cleanupConfirmed));
 assert.equal(await readFile(path.join(f.dir,'late'),'utf8').catch(()=>null),null);
});

test('后台失败把真实退出码交回原目标，失效目标不再续跑', posix, async t => {
  const f = await fixture(t, () => 'sleep 0.2; printf ACTUAL_FAILURE >&2; exit 7');
  const first = await f.make();
  await first.session.prompt('FAIL');
  const resumed = f.requests.find(r => JSON.stringify(r.messages).includes('［后台命令完成'));
  assert.match(JSON.stringify(resumed.messages), /exit=7/);
  assert.match(JSON.stringify(resumed.messages), /ACTUAL_FAILURE/);
  const old = await f.make('old');
  const pending = old.session.prompt('STALE');
  await until(() => f.activities.some(a => a.id === 'old' && a.phase === 'waiting-background'));
  const count = f.requests.length;
  old.cancelOwnership();
  assert.equal((await pending).aborted, true);
  assert.equal(f.requests.length, count, '旧归属结束后不重新请求模型');
});

test('显式后台立即返回，进程硬超时仍终止并把 timed-out 交回模型', posix, async t => {
  const f = await fixture(t, () => 'sleep 30', { run_in_background: true, yield_ms: 120000, timeout_ms: 200 });
  const { session } = await f.make();
  const pending = session.prompt('TIMEOUT');
  await until(() => f.activities.some(a => a.jobs.length));
  const result = await pending;
  assert.equal(result.aborted, false);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /timed-out/);
  const process = Object.values((await f.journal.snapshot()).processes)[0];
  assert.equal(process.status, 'timed-out');
  assert.equal(process.cleanupConfirmed, true);
});

test('后台完成早于 SDK 受理回执时仍先受理后终结，不会复活工具状态', { ...posix, timeout:10000 }, async t => {
  const f=await fixture(t,()=> 'sleep 0.05; printf QUICK_COMPLETION',{run_in_background:true});
  const original=f.journal.processBackground;
  f.journal.processBackground=async id=>{await original(id);await pause(150);};
  const {session}=await f.make('fast');const events=[];session.on('progress',event=>events.push(event));
  await session.prompt('Run a quick background command');
  const ends=events.filter(event=>event.kind==='tool-end'&&event.tool==='bash');
  assert.equal(ends.length,2);assert.equal(ends[0].background,true);assert.equal(ends[1].isError,false);
  assert.match(ends[1].text,/QUICK_COMPLETION/);assert.equal(ends[0].toolCallId,ends[1].toolCallId);
});
