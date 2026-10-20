import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createSubagentManager, clipReport, MAX_REPORT_CHARS, PARALLEL_LIMIT } from './subagents.mjs';
import { loadRoles } from './agent-roles.mjs';

const roles = loadRoles();
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 可控的假会话：prompt 挂起直到测试 resolve；事件经 emit 注入。 */
function fakeSession() {
  const emitter = new EventEmitter();
  const prompts = [];
  const responses = [];
  let disposed = false;
  let pending = null;
  return {
    prompts,
    responses,
    emit: (...args) => emitter.emit(...args),
    finish(result) {
      const waiter = pending;
      pending = null;
      waiter?.(result);
    },
    session: {
      on: emitter.on.bind(emitter),
      off: emitter.off.bind(emitter),
      prompt: (text) => {
        prompts.push(text);
        return new Promise((resolve) => { pending = resolve; });
      },
      steer: async (text) => {
        responses.push(['steer', text]);
        return { ok: true };
      },
      abort: async () => {
        const waiter = pending;
        pending = null;
        waiter?.({ texts: [], lastText: null, usages: [], toolNames: [], modelError: null, aborted: true });
      },
      respondPermission: (id, outcome) => responses.push(['perm', id, outcome]),
      isDisposed: () => disposed,
      dispose: () => { disposed = true; },
    },
  };
}

function managerWith({ onTerminal = null, onSettled = null } = {}) {
  const fakes = [];
  const history = {
    records: new Map(),
    createRecord({ taskText }) {
      const taskId = `rec-${this.records.size + 1}`;
      this.records.set(taskId, { taskId, taskText, events: [] });
      return { taskId };
    },
    startExecution() { return true; },
    appendEvent(taskId, text) { this.records.get(taskId)?.events.push(text); },
    finishRecord(taskId, fields) { Object.assign(this.records.get(taskId) ?? {}, { finished: fields }); },
    appendDeliverable(taskId, artifact) {
      const record = this.records.get(taskId);
      if (!record) return false;
      record.deliverables = record.deliverables ?? [];
      if (record.deliverables.some((item) => item.kind === artifact.kind && (artifact.kind === 'file' ? item.path === artifact.path : item.url === artifact.url))) return true;
      record.deliverables.push(artifact);
      return true;
    },
  };
  const manager = createSubagentManager({
    createSession: async () => {
      const fake = fakeSession();
      fakes.push(fake);
      return fake.session;
    },
    history,
    onTerminal, onSettled,
    stallTimeoutMs: 60_000,
  });
  return { manager, fakes, history };
}

const done = (text) => ({ texts: [text], lastText: text, usages: [], toolNames: [], modelError: null, aborted: false });

test('clipReport：按码点截断并报告总长', () => {
  assert.deepEqual(clipReport('短'), { text: '短', truncated: false, total: 1 });
  const long = '字'.repeat(MAX_REPORT_CHARS + 5);
  const clipped = clipReport(long);
  assert.equal(clipped.truncated, true);
  assert.equal(Array.from(clipped.text).length, MAX_REPORT_CHARS);
  assert.equal(clipped.total, MAX_REPORT_CHARS + 5);
});

test('057 回归：register_delivery 声明随终态落任务档案 deliverables（重启后引用候选/预览才拿得到）', async () => {
  const { manager, fakes, history } = managerWith();
  const pending = manager.spawn({ role: roles.get('fixer'), prompt: '创建 note.txt 并声明交付', description: '创建 note.txt', conversationId: 'c1' });
  await tick();
  await tick();
  fakes[0].emit('progress', { kind: 'tool-start', tool: 'write', toolCallId: 'tc-1', args: { path: '/tmp/note.txt' } });
  fakes[0].emit('progress', { kind: 'tool-end', tool: 'write', toolCallId: 'tc-1', args: {}, isError: false });
  fakes[0].emit('progress', { kind: 'tool-start', tool: 'register_delivery', toolCallId: 'tc-2', args: { files: [{ path: '/tmp/note.txt', description: '说明文件' }] } });
  fakes[0].emit('progress', { kind: 'tool-end', tool: 'register_delivery', toolCallId: 'tc-2', args: { files: [{ path: '/tmp/note.txt', description: '说明文件' }] }, isError: false });
  fakes[0].finish(done('已创建并声明'));
  const outcome = await pending;
  assert.equal(outcome.result.outcome, 'complete');
  const [record] = [...history.records.values()];
  assert.ok(record.deliverables?.some((item) => item.path === '/tmp/note.txt' && item.kind === 'file'), 'deliverables 应含声明文件');
});

test('前台派单：阻塞到交付，报告作为结果返回；终态入档、快照带角色', async () => {
  const { manager, fakes, history } = managerWith();
  const pending = manager.spawn({ role: roles.get('explorer'), prompt: '找出所有发布脚本', description: '找发布脚本', conversationId: 'c1' });
  await tick();
  await tick();
  assert.equal(fakes.length, 1);
  assert.deepEqual(fakes[0].prompts, ['找出所有发布脚本']);
  const running = manager.snapshot().tasks[0];
  assert.equal(running.agent, 'explorer');
  assert.equal(running.phase, 'running');
  assert.equal(running.taskText, '找发布脚本');
  fakes[0].finish(done('scripts/publish.mjs:12'));
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.background, false);
  assert.equal(outcome.result.outcome, 'complete');
  assert.equal(outcome.result.report, 'scripts/publish.mjs:12');
  assert.equal(outcome.result.alias, 'explorer-1');
  assert.equal(history.records.get('rec-1').finished.outcome, 'complete');
  assert.equal(manager.snapshot().tasks[0].resultText, 'scripts/publish.mjs:12');
});

test('后台派单：立刻返回 id，终态经 onTerminal 通知（带对话 id 与报告）', async () => {
  const events = [];
  const { manager, fakes } = managerWith({ onTerminal: (event) => events.push(event) });
  const outcome = await manager.spawn({ role: roles.get('fixer'), prompt: '改三个文件', description: '批量改', background: true, conversationId: 'c2' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.background, true);
  assert.equal(events.length, 0);
  await tick();
  fakes[0].finish(done('改完了'));
  for (let i = 0; i < 5 && !events.length; i += 1) await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].conversationId, 'c2');
  assert.equal(events[0].report, '改完了');
  assert.equal(events[0].agent, 'fixer');
});

test('续用：同角色已结束的会话再 prompt；运行中/跨角色/跨对话拒绝', async () => {
  const { manager, fakes } = managerWith();
  const first = manager.spawn({ role: roles.get('explorer'), prompt: '第一问', conversationId: 'c3' });
  await tick(); await tick();
  const busy = await manager.spawn({ role: roles.get('explorer'), prompt: '插队', sessionId: 'explorer-1', conversationId: 'c3' });
  assert.equal(busy.ok, false);
  assert.match(busy.error, /还在运行/);
  fakes[0].finish(done('答一'));
  await first;
  const wrongRole = await manager.spawn({ role: roles.get('oracle'), prompt: 'x', sessionId: 'explorer-1', conversationId: 'c3' });
  assert.match(wrongRole.error, /不能当 oracle 续用/);
  const wrongConv = await manager.spawn({ role: roles.get('explorer'), prompt: 'x', sessionId: 'explorer-1', conversationId: 'other' });
  assert.match(wrongConv.error, /不属于当前对话/);
  const again = manager.spawn({ role: roles.get('explorer'), prompt: '第二问', sessionId: 'explorer-1', conversationId: 'c3' });
  await tick();
  assert.equal(fakes.length, 1, '续用不新建会话');
  assert.deepEqual(fakes[0].prompts, ['第一问', '第二问']);
  fakes[0].finish(done('答二'));
  const second = await again;
  assert.equal(second.result.report, '答二');
  assert.equal(manager.snapshot().tasks[0].runs, 1, '旧任务不能被续用覆盖');
  assert.equal(manager.snapshot().tasks[0].resultText, '答一');
  assert.equal(manager.snapshot().tasks[1].runs, 2);
  assert.notEqual(second.taskId, (await first).taskId);
  assert.equal(manager.snapshot().tasks[0].sessionRef, manager.snapshot().tasks[1].sessionRef);
});

test('并发上限：超额任务受理后等待，取消等待者不会启动', async () => {
  const { manager, fakes } = managerWith();
  for (let i = 0; i < PARALLEL_LIMIT; i += 1) {
    void manager.spawn({ role: roles.get('explorer'), prompt: `p${i}`, background: true, conversationId: 'c4' });
  }
  await tick(); await tick();
  const over = await manager.spawn({ role: roles.get('explorer'), prompt: 'one more', background: true, conversationId: 'c4' });
  assert.equal(over.ok, true);
  assert.equal(manager.snapshot().tasks.at(-1).phase, 'waiting');
  assert.equal(fakes.length, PARALLEL_LIMIT);
  await manager.stop(over.key);
  assert.equal(manager.snapshot().tasks.at(-1).outcome, 'stopped');
  assert.equal(fakes.length, PARALLEL_LIMIT);
  await manager.stop();
});

test('确认环：子 agent 的授权卡进快照，decide 回传选项；主 agent 的卡走 agentPermissions', async () => {
  const { manager, fakes } = managerWith();
  void manager.spawn({ role: roles.get('fixer'), prompt: '写文件', conversationId: 'c5' });
  await tick(); await tick();
  fakes[0].emit('permission', { id: 'perm-9', title: JSON.stringify({ kind: 'action', summary: '执行命令：rm x', tool: 'bash', args: { command: 'rm x' }, options: ['本任务允许', '拒绝'] }) });
  const waiting = manager.snapshot().tasks[0];
  assert.equal(waiting.phase, 'waiting');
  assert.equal(waiting.permission.summary, '执行命令：rm x');
  assert.equal(manager.decide('persistent', { taskKey: waiting.key }).errorCode, 'INVALID_CHOICE');
  assert.equal(manager.decide('task', { taskKey: waiting.key }).ok, true);
  assert.deepEqual(fakes[0].responses.at(-1), ['perm', 'perm-9', { value: '本任务允许' }]);
  assert.equal(manager.snapshot().tasks[0].phase, 'running');

  const mainResponses = [];
  manager.hostPermission({ conversationId: 'c5', session: { respondPermission: (...args) => mainResponses.push(args) }, request: { id: 'perm-10', title: JSON.stringify({ kind: 'grant', summary: '允许 Hemi 访问「~/x」？', tool: 'read', args: {}, options: ['本任务允许', '持续允许', '拒绝'] }) } });
  const hosted = manager.snapshot().agentPermissions;
  assert.equal(hosted.length, 1);
  assert.equal(hosted[0].conversationId, 'c5');
  assert.equal(manager.decide('deny', { taskKey: hosted[0].key }).ok, true);
  assert.deepEqual(mainResponses, [['perm-10', { value: '拒绝' }]]);
  assert.equal(manager.snapshot().agentPermissions.length, 0, '应答后不留死卡');
});

test('停止：stop 收口为 stopped，结果仍回到派单方；message 给运行中的子 agent 补充指令', async () => {
  const { manager, fakes } = managerWith();
  const pending = manager.spawn({ role: roles.get('fixer'), prompt: '长任务', conversationId: 'c6' });
  await tick(); await tick();
  const steer = await manager.message('fixer-1', '只改 README');
  assert.equal(steer.ok, true);
  assert.deepEqual(fakes[0].responses.at(-1), ['steer', '只改 README']);
  assert.equal(manager.snapshot().tasks[0].steeredCount, 1);
  const stopped = await manager.stop('fixer-1');
  assert.equal(stopped.stopped, 1);
  const outcome = await pending;
  assert.equal(outcome.result.outcome, 'stopped');
  const late = await manager.message('fixer-1', '还在吗');
  assert.equal(late.ok, false);
});

test('status 与 waitFor：只读视图按对话过滤；waitFor 等到终态返回结果', async () => {
  const { manager, fakes } = managerWith();
  void manager.spawn({ role: roles.get('oracle'), prompt: '评审方案', description: '评审', background: true, conversationId: 'c7' });
  void manager.spawn({ role: roles.get('explorer'), prompt: '别的对话', background: true, conversationId: 'c8' });
  await tick(); await tick();
  const list = manager.status({ conversationId: 'c7' });
  assert.equal(list.length, 1);
  assert.equal(list[0].agent, 'oracle');
  const waiting = manager.waitFor('oracle-1', { timeoutMs: 5000 });
  fakes[0].finish(done('方案可行'));
  const result = await waiting;
  assert.equal(result.report, '方案可行');
  assert.equal(await manager.waitFor('nope'), null);
});

test('denied/blocked：门控拒绝且没有正文时按对应终态收口', async () => {
  const { manager, fakes } = managerWith();
  const pending = manager.spawn({ role: roles.get('fixer'), prompt: '删库', conversationId: 'c9' });
  await tick(); await tick();
  fakes[0].emit('progress', { kind: 'tool-start', tool: 'bash', args: { command: 'rm -rf /' } });
  fakes[0].emit('progress', { kind: 'tool-end', tool: 'bash', args: {}, isError: true, text: '禁止执行（删除根目录）' });
  fakes[0].finish({ texts: [], lastText: null, usages: [], toolNames: ['bash'], modelError: null, aborted: false });
  const outcome = await pending;
  assert.equal(outcome.result.outcome, 'blocked');
});

test('只读调研打开页面到阈值时宿主插话一次，提醒收手交付；执行角色不提醒', async () => {
  const { manager, fakes } = managerWith();
  const pending = manager.spawn({ role: roles.get('explorer'), prompt: '查资料', conversationId: 'c9' });
  await tick(); await tick();
  for (let i = 0; i < 20; i += 1) {
    fakes[0].emit('progress', { kind: 'tool-start', tool: 'browser_navigate', args: { url: `https://e.x/${i}` } });
    fakes[0].emit('progress', { kind: 'tool-end', tool: 'browser_navigate', args: { url: `https://e.x/${i}` } });
  }
  await tick();
  const steers = fakes[0].responses.filter(([kind]) => kind === 'steer');
  assert.equal(steers.length, 1);
  assert.match(steers[0][1], /停止继续浏览/);
  fakes[0].finish(done('R'));
  await pending;

  const fixerRun = manager.spawn({ role: roles.get('fixer'), prompt: '跑腿', conversationId: 'c9' });
  await tick(); await tick();
  for (let i = 0; i < 20; i += 1) fakes[1].emit('progress', { kind: 'tool-start', tool: 'browser_navigate', args: {} });
  await tick();
  assert.equal(fakes[1].responses.filter(([kind]) => kind === 'steer').length, 0);
  fakes[1].finish(done('R'));
  await fixerRun;
});

test('056 过程日志：只读工具（read/grep/glob/ls）也记，描述带路径与关键词', async () => {
  const { manager, fakes } = managerWith();
  const pending = manager.spawn({ role: roles.get('explorer'), prompt: '摸清项目', description: '摸清项目', conversationId: 'c11' });
  await tick(); await tick();
  fakes[0].emit('progress', { kind: 'tool-start', tool: 'ls', args: { path: '/Users/demo/Projects/video' } });
  fakes[0].emit('progress', { kind: 'tool-end', tool: 'ls', args: { path: '/Users/demo/Projects/video' } });
  fakes[0].emit('progress', { kind: 'tool-start', tool: 'grep', args: { pattern: 'deploy', path: '/Users/demo/Projects/video' } });
  fakes[0].emit('progress', { kind: 'tool-end', tool: 'grep', args: { pattern: 'deploy', path: '/Users/demo/Projects/video' } });
  await tick();
  const texts = manager.snapshot().tasks[0].log.map((entry) => entry.text);
  assert.equal(texts.length, 3); // 首条是「侦察（explorer）开始：…」
  assert.match(texts[1], /^已完成：查看目录 ~\/Projects\/video（/);
  assert.match(texts[2], /^已完成：搜索「deploy」（~\/Projects\/video）/);
  fakes[0].finish(done('R'));
  await pending;
});

test('056 快照带发起它的 task 调用 id；续用时换成新那次调用的 id；入档也带', async () => {
  const { manager, fakes, history } = managerWith();
  const first = manager.spawn({ role: roles.get('explorer'), prompt: '查', conversationId: 'c10', toolCallId: 'toolu_a' });
  await tick(); await tick();
  assert.equal(manager.snapshot().tasks[0].toolCallId, 'toolu_a');
  fakes[0].finish(done('R1'));
  await first;
  const [record] = [...history.records.values()];
  assert.equal(record.finished.toolCallId, 'toolu_a');
  assert.equal(record.finished.agent, 'explorer');
  const again = manager.spawn({ role: roles.get('explorer'), prompt: '再查', conversationId: 'c10', sessionId: 'explorer-1', toolCallId: 'toolu_b' });
  await tick(); await tick();
  assert.equal(manager.snapshot().tasks[0].toolCallId, 'toolu_a', '旧任务保留原派单身份');
  assert.equal(manager.snapshot().tasks[1].toolCallId, 'toolu_b');
  fakes[0].finish(done('R2'));
  await again;
});

test('057 交付声明：register_delivery 的 files/sources 捕获进任务成果（同路径替换、来源去重）', async () => {
  const { manager, fakes } = managerWith();
  const pending = manager.spawn({ role: roles.get('fixer'), prompt: '生成报告', description: '生成报告', conversationId: 'c12' });
  await tick(); await tick();
  fakes[0].emit('progress', { kind: 'tool-start', tool: 'register_delivery', args: { files: [{ path: '/tmp/report.md', description: '最终报告' }], sources: [{ title: '依据', url: 'https://example.com/a' }] } });
  fakes[0].emit('progress', { kind: 'tool-end', tool: 'register_delivery', args: { files: [{ path: '/tmp/report.md', description: '最终报告 v2' }], sources: [{ title: '重复', url: 'https://example.com/a' }] } });
  await tick();
  const snap = manager.snapshot().tasks[0];
  assert.equal(snap.artifacts.length, 1, '同路径替换不重复');
  assert.equal(snap.artifacts[0].path, '/tmp/report.md');
  assert.equal(snap.artifacts[0].description, '最终报告 v2');
  assert.equal(snap.artifacts[0].kind, 'file');
  assert.equal(snap.sources.filter((entry) => entry.url === 'https://example.com/a').length, 1, '来源去重');
  const logs = snap.log.map((entry) => entry.text);
  assert.ok(logs.some((text) => text.includes('声明交付') || text.includes('register_delivery')), '过程日志记声明');
  fakes[0].finish(done('R'));
  await pending;
});

test('060 R-22：按根运行取消所属子调用——background 归属取消、独立根目标 D 不受影响', async () => {
  const { manager, fakes } = managerWith();
  // 三个后台任务（spawn 即返回身份；前台阻塞语义不影响归属断言，由 stop 用例覆盖）。
  const a1 = await manager.spawn({ role: roles.get('explorer'), prompt: 'A 后台活儿一', description: 'A 后台一', background: true, conversationId: 'c1', rootRunId: 'run-A' });
  const a2 = await manager.spawn({ role: roles.get('explorer'), prompt: 'A 后台活儿二', description: 'A 后台二', background: true, conversationId: 'c1', rootRunId: 'run-A' });
  const d = await manager.spawn({ role: roles.get('explorer'), prompt: 'D 独立活儿', description: 'D 独立', background: true, conversationId: 'c1', rootRunId: 'run-D' });
  assert.ok(a1.ok && a2.ok && d.ok);
  const cancelled = await manager.cancelByRootRun('run-A', { reason: 'promote' });
  assert.deepEqual([...cancelled.cancelled].sort(), [a1.key, a2.key].sort(), 'A 名下两个都收到取消');
  assert.ok(!cancelled.cancelled.includes(d.key), '独立根目标 D 未被误停');
  await tick(); await tick(); await tick();
  const byId = Object.fromEntries(manager.status({ conversationId: 'c1' }).map((t) => [t.id, t]));
  assert.equal(byId[a1.alias]?.phase, 'terminal');
  assert.equal(byId[a2.alias]?.phase, 'terminal');
  assert.equal(byId[d.alias]?.phase, 'running', 'D 仍在运行');
  fakes.forEach((fake) => fake.finish(done('收尾')));
});

test('060：子会话仍在初始化时插队，等待终态且不能在初始化返回后复活旧工作', async () => {
  let ready;
  const fake = fakeSession();
  const manager = createSubagentManager({ createSession: () => new Promise((resolve) => { ready = resolve; }) });
  const spawned = manager.spawn({ role: roles.get('fixer'), prompt: '不应执行', background: true, rootRunId: 'A', conversationId: 'c' });
  await tick();
  let stopped = false;
  const stop = manager.cancelByRootRun('A', { reason: 'promote' }).then(() => { stopped = true; });
  await tick();
  assert.equal(stopped, false, '初始化未落定前不能假确认退出');
  ready(fake.session);
  await Promise.all([spawned, stop]);
  assert.deepEqual(fake.prompts, [], '旧工作从未开始 prompt');
  assert.equal(manager.snapshot().tasks[0].outcome, 'stopped');
});

test('终态持久化屏障：wait 和续用不能抢在完整报告与完成事件保存之前', async () => {
  let release, entered=false;
  const barrier=new Promise(resolve=>release=resolve);
  const {manager,fakes}=managerWith({onSettled:async task=>{entered=true;await barrier;task.reportRef='ctx-persisted';}});
  const receipt=await manager.spawn({role:roles.get('explorer'),prompt:'调查',background:true,conversationId:'barrier'});
  await tick();await tick();fakes[0].finish(done('原始报告'));await tick();assert.ok(entered);
  let returned=false;const waiting=manager.waitFor(receipt.taskId).then(result=>{returned=true;return result;});
  await tick();assert.equal(returned,false);
  const refused=await manager.spawn({role:roles.get('explorer'),prompt:'续问',sessionId:receipt.sessionRef,conversationId:'barrier'});assert.equal(refused.ok,false);
  release();const result=await waiting;assert.equal(result.reportRef,'ctx-persisted');assert.equal(result.report,'原始报告');
});

test('派单族按对话及当前目标校验归属，空取消不能升级为全局停止', async () => {
  const { manager, fakes } = managerWith();
  const running = await manager.spawn({role: roles.get('fixer'), prompt: '保持运行', background: true, conversationId: 'owner', rootRunId: 'root-owner'});
  await tick(); await tick();
  assert.deepEqual(manager.status({conversationId: 'other', keyOrId: running.taskId}), []);
  assert.equal(await manager.waitFor(running.taskId, {conversationId: 'other'}), null);
  assert.equal((await manager.message(running.taskId, '越界', {conversationId: 'other'})).ok, false);
  assert.equal((await manager.stop(running.taskId, {conversationId: 'other'})).ok, false);
  assert.equal((await manager.stop('', {conversationId: 'owner'})).ok, false);
  assert.equal((await manager.stop(running.taskId, {conversationId: 'owner', rootRunId: 'new-root'})).ok, false);
  assert.equal(manager.status({conversationId: 'owner'})[0].phase, 'running');
  assert.equal((await manager.message(running.taskId, '合法补充', {conversationId: 'owner', rootRunId: 'root-owner'})).ok, true);
  assert.deepEqual(fakes[0].responses, [['steer', '合法补充']]);
  assert.equal((await manager.stop(running.taskId, {conversationId: 'owner', rootRunId: 'root-owner'})).ok, true);
  assert.equal((await manager.waitFor(running.taskId, {conversationId: 'owner'})).outcome, 'stopped');
  manager.disposeAll();
});

test('停摆看门狗：模型流式分片计入活动，只有流真停了才在 stallTimeoutMs 后自动停止（10-19 t24 写报告被掐回归）', async () => {
  let now = 1_000_000;
  const timers = [];
  const fakes = [];
  const history = {
    records: new Map(),
    createRecord({ taskText }) { const taskId = `rec-${this.records.size + 1}`; this.records.set(taskId, { taskId, taskText, events: [] }); return { taskId }; },
    startExecution() { return true; },
    appendEvent(taskId, text) { this.records.get(taskId)?.events.push(text); },
    finishRecord(taskId, fields) { Object.assign(this.records.get(taskId) ?? {}, { finished: fields }); },
    appendDeliverable() { return true; },
  };
  const manager = createSubagentManager({
    createSession: async () => { const fake = fakeSession(); fakes.push(fake); return fake.session; },
    history,
    nowFn: () => now,
    setIntervalFn: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearIntervalFn: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    stallTimeoutMs: 180_000,
  });
  const fire = () => { for (const timer of [...timers]) timer.fn(); };
  const running = await manager.spawn({ role: roles.get('explorer'), prompt: '读完资料后写长报告', background: true, conversationId: 'c1' });
  await tick(); await tick();
  assert.equal(manager.snapshot().tasks[0].phase, 'running');
  assert.equal(timers.length, 1, '运行中应有停摆看门狗在跑');

  // 最后一个工具事件之后模型开始流式写报告：每 30s 到一片，持续 6 分钟，远超 180s。
  fakes[0].emit('progress', { kind: 'tool-start', tool: 'browser_extract', toolCallId: 'tc-1', args: {} });
  fakes[0].emit('progress', { kind: 'tool-end', tool: 'browser_extract', toolCallId: 'tc-1', args: {}, isError: false });
  for (let i = 0; i < 12; i += 1) {
    now += 30_000;
    fakes[0].emit('stream', { type: ['text_delta', 'thinking_delta', 'toolcall_delta'][i % 3], delta: '模型输出分片……' });
    fire(); await tick();
    assert.equal(manager.snapshot().tasks[0].phase, 'running', `流式分片持续到达时第 ${i + 1} 片不应被判停摆`);
  }

  // 流真停了：179s 内不停，过了 180s 停。
  now += 179_000; fire(); await tick();
  assert.equal(manager.snapshot().tasks[0].phase, 'running');
  now += 2_000; fire(); await tick(); await tick();
  const outcome = await manager.waitFor(running.taskId, { conversationId: 'c1' });
  assert.equal(outcome.outcome, 'stopped');
  const task = manager.snapshot().tasks[0];
  assert.equal(task.outcomeReason, '长时间无响应，自动停止');
  assert.ok(history.records.get('rec-1').events.some((line) => /180 秒没有任何响应/.test(line)), '任务日志要留停摆留痕');
  fire(); // 看门狗在下一拍发现没有运行中的任务才自清
  assert.equal(timers.length, 0, '没有运行中的任务后看门狗应停掉');
  manager.disposeAll();
});
