import {readRunJournalFileSync} from './journal-inspection.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, rename, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRunJournal, dispatchIdentity, BUDGET_SUMMARY_PURPOSE } from './run-journal.mjs';
import { createTaskHandoff } from '../../shared/task-handoff.mjs';
const owner = { conversationId: 'c', rootRunId: 'r', generation: 1 };
async function fixture(t) { const dir = await mkdtemp(path.join(os.tmpdir(),'h64-journal-')); t.after(() => rm(dir,{recursive:true,force:true})); const journal = createRunJournal({dir}); await journal.ready(); return { dir, journal };  }
test('handoff identity is checked before admission, then preserved with the inbox across restart', async t => {
  const {journal,dir}=await fixture(t); await journal.beginRoot(owner);
  const taskOwner={...owner,taskId:'structured-child'};
  const result={taskId:taskOwner.taskId,outcome:'partial',outcomeReason:'缺少有效交接',report:'已执行的原文'};
  result.handoff=createTaskHandoff(result,{owner:taskOwner,status:'missing'});
  const forged=structuredClone(result); forged.handoff.owner.generation++;
  await assert.rejects(journal.completeTask({owner:taskOwner,result:forged}),/归属/);
  assert.equal(Object.keys((await journal.snapshot()).tasks).length,0);
  await journal.completeTask({owner:taskOwner,result});
  await journal.completeTask({owner:taskOwner,result});
  assert.equal((await journal.pending(owner)).length,1);
  const restored=createRunJournal({dir}); await restored.recover();
  const state=await restored.snapshot();
  assert.deepEqual(state.tasks[taskOwner.taskId].result.handoff,result.handoff);
  assert.deepEqual(state.inbox[`complete:${taskOwner.taskId}`].result.handoff,result.handoff);
});
test('background processes may reach goal checking; foreground and unknown cleanup still fence it',async t=>{
  const {journal}=await fixture(t);await journal.beginRoot(owner);await journal.beginGoal(owner,'start service',{maxRounds:3,maxRequests:10,maxRequestsPerRound:10,noProgressRounds:3});
  await journal.processStart({id:'service',pid:1234,token:'test',owner});await journal.processBackground('service');
  await journal.checkGoal(owner);
  await journal.recordGoalCheck(owner,{status:'continue',reason:'readiness needed',evidence:[],remaining:['readiness'],nextAction:'probe'});
  await journal.processStart({id:'build',pid:1235,token:'test-build',owner});
  await assert.rejects(journal.checkGoal(owner),/未确认/);
  await journal.processEnd('build',{state:'finished',cleanupConfirmed:true});
  await journal.processEnd('service',{state:'unknown',cleanupConfirmed:false});
  await assert.rejects(journal.checkGoal(owner),/未确认/);
  await journal.processEnd('service',{state:'finished',cleanupConfirmed:true});await journal.checkGoal(owner);
});
test('selected background waits wake on actual process facts and reject foreign jobs or cancellation',async t=>{
 const {journal}=await fixture(t);await journal.beginRoot(owner);
 await journal.processStart({id:'job',owner,pid:1234,token:'job'});await journal.processBackground('job');
 await assert.rejects(journal.waitForProcessUpdate({...owner,conversationId:'foreign'},['job']),/不属于/);
 const controller=new AbortController(),cancelled=journal.waitForProcessUpdate(owner,['job'],{signal:controller.signal});controller.abort();await assert.rejects(cancelled,{name:'AbortError'});
 let woke=false;const waiting=journal.waitForProcessUpdate(owner,['job']).then(update=>{woke=true;return update;});
 await new Promise(r=>setTimeout(r,10));assert.equal(woke,false);
 await journal.processEnd('job',{state:'finished',cleanupConfirmed:true,status:'succeeded',code:0});assert.equal((await waiting).kind,'settled');
});
test('a cleanup failure racing a positive verdict cannot commit a completed goal',async t=>{
 const {journal}=await fixture(t);await journal.beginRoot(owner);await journal.beginGoal(owner,'start',{maxRounds:3,maxRequests:10,maxRequestsPerRound:10,noProgressRounds:3});
 await journal.processStart({id:'job',owner,pid:1234,token:'job'});await journal.processBackground('job');await journal.checkGoal(owner);
 await journal.recordGoalCheck(owner,{status:'complete',reason:'ready',evidence:['independent readiness'],remaining:[],nextAction:''});
 await journal.processEnd('job',{state:'unknown',cleanupConfirmed:false,status:'cleanup-failed'});
 await assert.rejects(journal.finishRoot(owner,'completed'),/未确认/);assert.equal((await journal.root(owner)).status,'running');
});
test('terminal write failure retains its execution fence and retries only state after storage recovery', async t => {
  const {journal,dir}=await fixture(t);t.after(()=>journal.dispose());
  await journal.beginRoot(owner);
  const file=path.join(dir,'run-journal.sqlite'),backup=file+'.last-good';
  await rename(file,backup);await mkdir(file);
  await assert.rejects(journal.finishRoot(owner,'failed','storage failure'));
  assert.equal((await journal.root(owner)).status,'failed','confirmed end survives failed persistence in memory');
  assert.equal(readRunJournalFileSync(backup).roots.r.status,'running','failed commit does not replace the last good file');
  await assert.rejects(journal.requestStart(owner,{requestId:'replayed'},10),/停止/);
  const next={...owner,rootRunId:'explicit-new-task'};
  await assert.rejects(journal.beginRoot(next));
  assert.equal((await journal.snapshot()).roots[next.rootRunId],undefined,'failed admission never enters executable memory state');
  assert.deepEqual((await readdir(dir)).filter(name=>name.endsWith('.tmp')),[]);
  await rm(file,{recursive:true});await rename(backup,file);
  const deadline=Date.now()+3000;
  while(readRunJournalFileSync(file).roots.r.status!=='failed') {
    assert.ok(Date.now()<deadline,'pending terminal state should be retried without new work');
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  const saved=readRunJournalFileSync(file);
  assert.deepEqual(saved.requests,{});
  assert.equal(saved.roots[next.rootRunId],undefined);
  await journal.beginRoot(next);
  await journal.flush();
});
test('同一持久派单重投只有一个 reservation；不同条目短 call id 重用不碰撞', async t => {
  const {journal}=await fixture(t); await journal.beginRoot(owner);
  const fields={...owner,sessionId:'s',callAnchorId:'a',toolCallId:'same'};
  const key=dispatchIdentity(fields);
  const results=await Promise.all([journal.reserveDispatch(key,{owner}),journal.reserveDispatch(key,{owner})]);
  assert.deepEqual(results.map(x=>x.existing),[false,true]);
  assert.match(results[0].taskId,/^task-/);assert.equal(results[0].taskId,results[1].taskId);
  assert.notEqual(key,dispatchIdentity({...fields,callAnchorId:'b'}));
});

test('durable admission identities survive reload and fence receipts/results; response headers do not settle a request', async t => {
  const { journal, dir } = await fixture(t); await journal.beginRoot(owner);
  const reserved = await journal.reserveDispatch('first', { owner });
  const restored = createRunJournal({ dir });
  assert.equal((await restored.reserveDispatch('first', { owner })).taskId, reserved.taskId);
  await assert.rejects(restored.recordReceipt('first', { ok: true, taskId: 't1' }), /不匹配/);
  await assert.rejects(restored.completeTask({ dispatchKey: 'first', owner: { ...owner, taskId: 't1' }, result: { taskId: 't1' } }), /不匹配/);
  await restored.completeTask({ dispatchKey: 'first', owner: { ...owner, taskId: reserved.taskId }, result: { taskId: reserved.taskId } });
  await restored.recordReceipt('first', { ok: true, taskId: reserved.taskId });
  // 057 统一 accepted：所有派单结算都产生 inbox 事件；未消费前完成门保持关闭（R-11）。
  assert.equal((await restored.pending(owner)).length, 1);
  await restored.consume([`complete:${reserved.taskId}`], 'entry-anchor');
  const rejected = await restored.reserveDispatch('rejected', { owner });
  assert.notEqual(rejected.taskId, reserved.taskId);
  await restored.recordReceipt('rejected', { ok: false, error: '子会话不兼容，未开始执行' });
  await restored.requestStart(owner, { requestId: 'inflight' }, 3);
  await restored.requestResponse('inflight', { httpStatus: 200 });
  await restored.beginGoal(owner, 'read', { maxRequests: 3, maxRounds: 1 });
  await assert.rejects(restored.checkGoal(owner), /未确认/);
  await restored.requestEnd('inflight', { coverage: 'unknown' });
  await restored.checkGoal(owner);
  assert.equal((await restored.snapshot()).dispatches.rejected.state, 'terminal');
});
test('终态与完成事件同落盘，重启保留事实且不自动续跑，重复完成不增事件',async t=>{
  const {journal,dir}=await fixture(t);await journal.beginRoot(owner);
  const result={taskId:'t',report:'complete'};
  await journal.completeTask({owner,result,background:true});await journal.completeTask({owner,result,background:true});
  assert.equal((await journal.pending(owner)).length,1);
  const restored=createRunJournal({dir});await restored.recover();
  const state=await restored.snapshot();assert.equal(state.roots.r.status,'interrupted');assert.equal(state.tasks.t.result.report,'complete');assert.equal(state.inbox['complete:t'].state,'obsolete');
});
test('消费锚点持久；停止后不允许新派单／请求',async t=>{
  const {journal}=await fixture(t);await journal.beginRoot(owner);await journal.completeTask({owner,result:{taskId:'t'},background:true});
  await journal.consume(['complete:t'],'entry');assert.deepEqual(await journal.pending(owner),[]);
  await journal.finishRoot(owner,'cancelled');
  await assert.rejects(journal.reserveDispatch('x',{owner}),/停止/);
  await assert.rejects(journal.requestStart(owner,{requestId:'q'},3),/停止/);
});
test('并发请求的额度原子占用；未知 usage 不记零费用',async t=>{
  const {journal}=await fixture(t);await journal.beginRoot(owner);
  const results=await Promise.allSettled(['a','b','c'].map(requestId=>journal.requestStart(owner,{requestId},2)));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,2);
  assert.match(results.find(x=>x.status==='rejected').reason.message,/上限/);
  assert.equal((await journal.snapshot()).requests.a.coverage,'unknown');
});

test('069 主子与辅助共享完整执行额度，触顶后仅根主模型能额外总结一次且不能开新动作', async t => {
  const { journal, dir } = await fixture(t);
  await journal.beginRoot(owner, { policySnapshot: { budgets: { maxRequestsPerRun: 2 } } });
  const child = { ...owner, taskId: 'child' }, auxiliary = { ...owner, rootRunId: 'aux' };
  await journal.beginRoot(auxiliary, { kind: 'auxiliary', sourceRootRunId: owner.rootRunId });
  await journal.observationStart({ id: 'inflight', owner: child, tool: 'bash' });
  await journal.requestStart(owner, { requestId: 'first' }, 2);
  await journal.requestStart(child, { requestId: 'second' }, 2);
  await assert.rejects(journal.requestStart(auxiliary, { requestId: 'third' }, 999), /上限 2/);
  assert.equal((await journal.root(owner)).requestLimitReached.limit, 2);
  await journal.observationEnd('inflight', { outcome: 'ok' });
  await assert.rejects(journal.observationStart({ id: 'late', owner: child, tool: 'write' }), /上限/);
  await assert.rejects(journal.reserveDispatch('late', { owner }), /上限/);
  await assert.rejects(journal.processStart({ id: 'late', owner, pid: 99999, token: 'test' }), /上限/);
  const claims = await Promise.all([journal.beginBudgetSummary(owner), journal.beginBudgetSummary(owner)]);
  assert.deepEqual(claims.map(item => item.existing), [false, true]);
  const request = { purpose: BUDGET_SUMMARY_PURPOSE, role: 'main' };
  await assert.rejects(journal.requestStart(child, { ...request, requestId: 'child-summary' }, 2), /不可用/);
  await assert.rejects(journal.requestStart(auxiliary, { ...request, requestId: 'aux-summary' }, 2), /不可用/);
  const results = await Promise.allSettled(['summary-a','summary-b'].map(requestId => journal.requestStart(owner, { ...request, requestId }, 2)));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  await assert.rejects(journal.requestStart(owner, { requestId: 'after-summary' }, 999), /上限 2/);
  await journal.finishBudgetSummary(owner, { text: '已有结果；剩余尚未完成', fallback: false });
  await journal.finishBudgetSummary(owner, { text: '不得覆盖' });
  const restored = createRunJournal({ dir });
  assert.equal((await restored.root(owner)).budgetSummary.text, '已有结果；剩余尚未完成');
  assert.equal(Object.keys((await restored.snapshot()).requests).length, 3);
  await restored.recover();
  await assert.rejects(restored.beginBudgetSummary(owner), /停止/);
  await assert.rejects(restored.requestStart(owner, { ...request, requestId: 'replay' }, 2), /停止/);
  const next = { ...owner, rootRunId: 'next' }; await restored.beginRoot(next);
  await restored.requestStart(next, { requestId: 'new-input' }, 2);
  await assert.rejects(restored.beginBudgetSummary(next), /未触顶/);
});

test('069 总结在途重启保留已消耗事实，不重新发出；正常任务不能提前占用总结请求', async t => {
  const { journal, dir } = await fixture(t); await journal.beginRoot(owner);
  const summary = { purpose: BUDGET_SUMMARY_PURPOSE, role: 'main' };
  await assert.rejects(journal.requestStart(owner, { ...summary, requestId: 'early' }, 1), /不可用/);
  await journal.requestStart(owner, { requestId: 'execution' }, 1);
  await assert.rejects(journal.requestStart(owner, { requestId: 'over' }, 1), /上限/);
  await journal.beginBudgetSummary(owner);
  await journal.requestStart(owner, { ...summary, requestId: 'summary' }, 1);
  const restored = createRunJournal({ dir }); await restored.recover();
  assert.equal((await restored.root(owner)).budgetSummary.requestId, 'summary');
  assert.equal((await restored.snapshot()).requests.summary.coverage, 'unknown');
  await assert.rejects(restored.requestStart(owner, { ...summary, requestId: 'again' }, 1), /停止/);
});
test('损坏事实库不按空库继续',async t=>{
  const {dir}=await fixture(t);await writeFile(path.join(dir,'run-journal.sqlite'),'broken');
  const journal=createRunJournal({dir});await assert.rejects(journal.ready(),/读取失败/);
});

test('重启后的在途请求／工具／派单保留不明事实，不伪造完成或自动重投',async t=>{
 const {journal,dir}=await fixture(t);await journal.beginRoot(owner);
 await journal.reserveDispatch('dispatch',{owner});await journal.recordReceipt('dispatch',{taskId:'task',background:true});
 await journal.observationStart({id:'tool',owner,tool:'bash'});await journal.requestStart(owner,{requestId:'request'},3);
 const restored=createRunJournal({dir});await restored.recover();const state=await restored.snapshot();
 assert.equal(state.dispatches.dispatch.state,'interrupted');assert.equal(state.observations.tool.phase,'unknown');assert.equal(state.requests.request.coverage,'unknown');assert.equal(state.requests.request.tokenUsage,undefined);
 await assert.rejects(restored.requestStart(owner,{requestId:'late'},3),/停止/);
});

test('同派单或任务ID不能被另一目标认领，越界终态不改写原事实', async t => {
  const {journal} = await fixture(t);
  const other = {...owner, conversationId: 'other', rootRunId: 'other-root'};
  await journal.beginRoot(owner); await journal.beginRoot(other);
  await journal.reserveDispatch('dispatch', {owner});
  await assert.rejects(journal.reserveDispatch('dispatch', {owner: other}), /不属于/);
  await assert.rejects(journal.completeTask({dispatchKey: 'dispatch', owner: other, result: {taskId: 'foreign'}}), /归属/);
  await journal.completeTask({owner, result: {taskId: 'task', report: 'original'}});
  await assert.rejects(journal.completeTask({owner: other, result: {taskId: 'task', report: 'overwrite'}}), /占用/);
  assert.equal((await journal.snapshot()).tasks.task.result.report, 'original');
});

test('工作流挂起释放会话占用，恢复原身份前须等其他目标结束；重启不把挂起变终态', async t => {
  const {journal,dir}=await fixture(t);
  const other={...owner,rootRunId:'ordinary'};
  await journal.beginRoot(owner,{kind:'workflow'});
  await journal.suspendRoot(owner);
  await assert.rejects(journal.requestStart(owner,{requestId:'late'},3),/挂起/);
  await assert.rejects(journal.reserveDispatch('late',{owner}),/挂起/);
  await journal.beginRoot(other);
  await assert.rejects(journal.beginRoot(owner),/已有执行/);
  await journal.finishRoot(other,'completed');
  const restored=createRunJournal({dir});await restored.recover();
  assert.equal((await restored.root(owner)).status,'waiting');
  await restored.beginRoot(owner);
  assert.equal((await restored.root(owner)).status,'running');
  await restored.finishRoot(owner,'cancelled');
  await assert.rejects(restored.beginRoot(owner),/终结/);
});

// ---- goal-resume：终态目标显式恢复（新建 root 接续，不复活旧 root） ----

/** 造一个带校验记录的已停止目标；requests 控制停止前已用的请求数。
 *  conversationId/generation 可选：资格矩阵按独立会话隔离，代际用例按 generation 区分。 */
async function stoppedGoal(journal, {rootRunId = 'r', verdict = null, finish = 'cancelled', reason = '用户停止', requests = 2, conversationId = owner.conversationId, generation = owner.generation} = {}) {
  const rootOwner = {...owner, conversationId, generation, rootRunId};
  await journal.beginRoot(rootOwner);
  await journal.beginGoal(rootOwner, '完成目标恢复验收', {maxRounds: 6, maxRequests: 10, maxRequestsPerRound: 6, noProgressRounds: 3});
  for (let i = 1; i <= requests; i++) {
    await journal.requestStart(rootOwner, {requestId: `${rootRunId}-q${i}`, role: 'main'}, 3);
    await journal.requestEnd(`${rootRunId}-q${i}`, {error: null});
  }
  await journal.checkGoal(rootOwner);
  await journal.recordGoalCheck(rootOwner, verdict ?? {status: 'continue', reason: '还差收尾', evidence: ['已有产出'], remaining: ['验证剩余结果'], nextAction: '运行剩余验证'});
  if (finish === 'blocked') {
    await journal.checkGoal(rootOwner);
    await journal.recordGoalCheck(rootOwner, {status: 'blocked', reason: '外部资源不可用', evidence: ['实际命令失败'], remaining: ['资源恢复后完成'], nextAction: '恢复资源'});
    await journal.finishRoot(rootOwner, 'blocked');
    return rootOwner;
  }
  await journal.endGoal(rootOwner, finish === 'partial' ? 'budget_limited' : finish === 'cancelled' ? 'cancelled' : finish, reason);
  await journal.finishRoot(rootOwner, finish, reason);
  return rootOwner;
}

test('goal-resume 资格矩阵：被停止/失败/部分完成/中断可恢复，blocked/完成不可恢复（独立会话隔离）', async t => {
  const {journal} = await fixture(t);
  for (const [finish, expected] of [['cancelled', true], ['failed', true], ['partial', true], ['interrupted', true], ['blocked', false]]) {
    // 每个终态独立会话：新语义下恢复入口只属最近受理链，多链共存会互相遮断。
    const conversationId = `matrix-${finish}`;
    const rootOwner = await stoppedGoal(journal, {rootRunId: `st-${finish}`, finish, conversationId});
    const summary = await journal.findResumableGoal(conversationId, {goalId: rootOwner.rootRunId});
    assert.equal(Boolean(summary), expected, finish);
    if (expected) {
      assert.equal(summary.goalId, rootOwner.rootRunId);
      assert.equal(summary.sourceRootRunId, rootOwner.rootRunId);
      assert.equal(summary.objective, '完成目标恢复验收');
      assert.equal(summary.status, finish);
      assert.deepEqual(summary.remaining, ['验证剩余结果']);
      assert.equal(summary.nextAction, '运行剩余验证');
      assert.equal(summary.unconfirmedWork, false);
      assert.equal(summary.budgetExhausted, false);
    }
  }
  // 完成校验通过的目标不可恢复；等待答复走答复续接，也不是恢复对象。
  const doneOwner = {...owner, rootRunId: 'st-done'};
  await journal.beginRoot(doneOwner);
  await journal.beginGoal(doneOwner, '已完成', {maxRounds: 6, maxRequests: 10, maxRequestsPerRound: 6, noProgressRounds: 3});
  await journal.checkGoal(doneOwner);
  await journal.recordGoalCheck(doneOwner, {status: 'complete', reason: '已完成', evidence: ['结果验证'], remaining: [], nextAction: ''});
  await journal.finishRoot(doneOwner, 'completed');
  assert.equal(await journal.findResumableGoal(owner.conversationId, {goalId: 'st-done'}), null);
  // 无 goalId 的默认查询＝最近受理链的投影（见下方遮断/受理顺序用例，此处不跨链）。
});

test('goal-resume 新建 root 接续：goal.id/累计请求连续，旧 root 标 continued；二次恢复幂等拒绝', async t => {
  const {journal,dir} = await fixture(t);
  const sourceOwner = await stoppedGoal(journal, {rootRunId: 'r'});
  const nextOwner = {...owner, rootRunId: 'resume-1'};
  const resumed = await journal.resumeGoal(nextOwner);
  assert.equal(resumed.goal.id, 'r');
  assert.equal(resumed.goal.objective, '完成目标恢复验收');
  assert.equal(resumed.goal.round, 2);
  assert.equal(resumed.goal.requestOffset, 2, '前一段已用请求计入 requestOffset');
  assert.equal(resumed.source.rootRunId, 'r');
  assert.equal(resumed.source.status, 'cancelled');
  const oldRoot = await journal.root(sourceOwner);
  assert.equal(oldRoot.status, 'continued');
  assert.equal(oldRoot.continuedBy, 'resume-1');
  assert.ok(oldRoot.terminalAt);
  assert.equal(oldRoot.goal.phase, 'continued');
  // 持久化断言：continued 标记必须落盘（行内 mutation 不进变更集的回归在此暴露）。
  await journal.flush();
  const persisted = createRunJournal({dir}); await persisted.ready();
  assert.equal((await persisted.root(sourceOwner)).status, 'continued');
  const newRoot = await journal.root(nextOwner);
  assert.equal(newRoot.goal.phase, 'active');
  assert.equal(newRoot.goal.continuedFrom, 'r');
  // 累计预算跨 root 连续：旧请求计入新 goal（requestOffset=2），新请求接着占用剩余总额。
  await journal.requestStart(nextOwner, {requestId: 'resume-q1', role: 'main'}, 3);
  // 已恢复的活跃 goal 再次恢复：幂等 already-active 并指向既有 root。
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'resume-2'}), error => error.code === 'goal-already-active' && error.rootRunId === 'resume-1');
  // 恢复回合后续 beginGoal 幂等复用账本 goal，不覆盖 objective/round。
  const goal = await journal.beginGoal(nextOwner, '', {maxRounds: 1, maxRequests: 1, maxRequestsPerRound: 1, noProgressRounds: 1});
  assert.equal(goal.id, 'r'); assert.equal(goal.round, 2); assert.equal(goal.objective, '完成目标恢复验收');
});

test('goal-resume 拒绝：无可恢复目标、未确认工作、预算耗尽（不执行任何请求、不建 root）', async t => {
  const {journal} = await fixture(t);
  await assert.rejects(journal.resumeGoal(owner), {code: 'goal-not-resumable'});
  const sourceOwner = await stoppedGoal(journal, {rootRunId: 'r', requests: 10});
  // 预算耗尽拒绝：goalRequests 已达 maxRequests=10。
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'resume-1'}), {code: 'goal-budget-limit'});
  const state = await journal.snapshot();
  assert.equal(state.roots['resume-1'], undefined, '拒绝恢复不建新 root');
  assert.equal(state.roots.r.status, 'cancelled', '拒绝恢复不改旧 root');
  // 停止时残留的未完成观察（如进程重启后副作用未核对）拒绝恢复。
  const another = {...owner, rootRunId: 'r2'};
  await journal.beginRoot(another);
  await journal.beginGoal(another, '完成目标恢复验收', {maxRounds: 6, maxRequests: 10, maxRequestsPerRound: 6, noProgressRounds: 3});
  await journal.observationStart({id: 'stray', owner: another, tool: 'write'});
  await journal.endGoal(another, 'cancelled', '用户停止');
  await journal.finishRoot(another, 'cancelled', '用户停止');
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'resume-1'}), {code: 'goal-unconfirmed-work'});
  await journal.observationEnd('stray', {isError: false});
  const resumed = await journal.resumeGoal({...owner, rootRunId: 'resume-1'});
  assert.equal(resumed.goal.id, 'r2');
});

test('goal-resume 绕过 workflow root；同会话其他执行目标占用时拒绝', async t => {
  const {journal} = await fixture(t);
  const wfOwner = {...owner, rootRunId: 'wf'};
  await journal.beginRoot(wfOwner, {kind: 'workflow'});
  await journal.beginGoal(wfOwner, '工作流目标', {maxRounds: 6, maxRequests: 10, maxRequestsPerRound: 6, noProgressRounds: 3});
  await journal.endGoal(wfOwner, 'cancelled', '用户停止');
  await journal.finishRoot(wfOwner, 'cancelled');
  assert.equal(await journal.findResumableGoal(owner.conversationId, {goalId: 'wf'}), null);
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'resume-wf'}), {code: 'goal-not-resumable'});
  const sourceOwner = await stoppedGoal(journal, {rootRunId: 'r'});
  const busyOwner = {...owner, rootRunId: 'busy'};
  await journal.beginRoot(busyOwner);
  // 新独立回合已建 root（尚无 goal）进行中：统一口径下按 already-active 拒绝——
  // 最近受理就是该回合，旧链不提供恢复入口（busy 栅栏保留为并发兜底）。
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'resume-1'}), error => error.code === 'goal-already-active' && error.rootRunId === 'busy');
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'resume-1'}, {goalId: 'r'}), {code: 'goal-not-resumable'});
  // 该回合收口（如准备失败）：已受理的独立回合持续遮断旧链，不因无 goal 而失效。
  await journal.finishRoot(busyOwner, 'failed', '输入准备失败');
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'resume-1'}), {code: 'goal-not-resumable'});
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'resume-1'}, {goalId: sourceOwner.rootRunId}), {code: 'goal-not-resumable'});
});

// ---- 恢复资格只属最近受理的独立主目标链（不按终止时间、不跨链、不猜任务） ----

test('旧停止目标被新独立目标遮断：新回合运行中/完成后，默认与显式旧 goalId 均不恢复', async t => {
  const {journal} = await fixture(t);
  const oldOwner = await stoppedGoal(journal, {rootRunId: 'old-r'});
  // 新普通回合运行中：恢复入口已让位；同链语义只认 already-active（指向新链）。
  const runningOwner = {...owner, rootRunId: 'new-r'};
  await journal.beginRoot(runningOwner);
  await journal.beginGoal(runningOwner, '新的普通问题', {maxRounds: 6, maxRequests: 10, maxRequestsPerRound: 6, noProgressRounds: 3});
  assert.equal(await journal.findResumableGoal(owner.conversationId, {goalId: 'old-r'}), null, '显式旧 goalId 被拒');
  assert.deepEqual(await journal.findResumableGoal(owner.conversationId), {alreadyActive: true, goalId: 'new-r', rootRunId: 'new-r'});
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'x1'}, {goalId: 'old-r'}), {code: 'goal-not-resumable'});
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'x2'}), {code: 'goal-already-active'});
  // 新回合完成：最新链非可恢复，旧链也不再提供恢复入口（不按历史目标猜）。
  await journal.checkGoal(runningOwner);
  await journal.recordGoalCheck(runningOwner, {status: 'complete', reason: '已答复', evidence: ['回答'], remaining: [], nextAction: ''});
  await journal.finishRoot(runningOwner, 'completed', '完成');
  assert.equal(await journal.findResumableGoal(owner.conversationId), null);
  assert.equal(await journal.findResumableGoal(owner.conversationId, {goalId: 'old-r'}), null);
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'x3'}, {goalId: 'old-r'}), {code: 'goal-not-resumable'});
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'x4'}), {code: 'goal-not-resumable'});
  assert.deepEqual((await journal.goalProjection(owner.conversationId)).goal, null, '普通问答收口后不残留恢复投影');
  assert.equal((await journal.root(oldOwner)).status, 'cancelled', '旧 root 原终态不被恢复尝试改写');
});

test('旧目标晚终止不夺恢复入口：受理顺序优先于 terminalAt（后台链迟到收口）', async t => {
  const {journal} = await fixture(t);
  const policy = {maxRounds: 6, maxRequests: 10, maxRequestsPerRound: 6, noProgressRounds: 3};
  // 旧目标后台交接释放会话占用后，新目标受理并停止。
  const aOwner = {...owner, rootRunId: 'a'};
  await journal.beginRoot(aOwner);
  await journal.beginGoal(aOwner, '旧目标', policy);
  await journal.suspendGoal(aOwner);
  const bOwner = {...owner, rootRunId: 'b'};
  await journal.beginRoot(bOwner);
  await journal.beginGoal(bOwner, '新目标', policy);
  await journal.endGoal(bOwner, 'cancelled', '用户停止');
  await journal.finishRoot(bOwner, 'cancelled', '用户停止');
  // 旧链迟到接续并很久之后才终止：terminalAt 晚于新链，但受理早于新链。
  const realNow = Date.now();
  const late = t.mock.method(Date, 'now', () => realNow + 10_000_000);
  try {
    await journal.resumeBackgroundGoal(aOwner);
    await journal.endGoal(aOwner, 'cancelled', '用户停止');
    await journal.finishRoot(aOwner, 'cancelled', '用户停止');
  } finally { late.mock.restore(); }
  const summary = await journal.findResumableGoal(owner.conversationId);
  assert.equal(summary.goalId, 'b', '恢复入口属最近受理链，不属晚终止旧链');
  assert.equal(summary.sourceRootRunId, 'b');
  assert.equal(await journal.findResumableGoal(owner.conversationId, {goalId: 'a'}), null);
  assert.equal((await journal.goalProjection(owner.conversationId)).goal.goalId, 'b');
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'x'}, {goalId: 'a'}), {code: 'goal-not-resumable'});
});

test('辅助与 workflow root 不构成独立链，不抢占主会话恢复候选', async t => {
  const {journal} = await fixture(t);
  const stopped = await stoppedGoal(journal, {rootRunId: 'main-r'});
  // 之后受理的辅助 root（子代理/运输通道）与挂起的 workflow root 都不是独立主链。
  await journal.beginRoot({...owner, rootRunId: 'aux-r', taskId: 't1'}, {kind: 'auxiliary', sourceRootRunId: 'main-r'});
  const wfOwner = {...owner, rootRunId: 'wf-r'};
  await journal.beginRoot(wfOwner, {kind: 'workflow'});
  await journal.beginGoal(wfOwner, '工作流目标', {maxRounds: 6, maxRequests: 10, maxRequestsPerRound: 6, noProgressRounds: 3});
  await journal.suspendRoot(wfOwner);
  assert.equal((await journal.findResumableGoal(owner.conversationId)).goalId, 'main-r');
  assert.equal((await journal.findResumableGoal(owner.conversationId, {goalId: 'main-r'})).goalId, 'main-r');
  assert.equal(await journal.findResumableGoal(owner.conversationId, {goalId: 'wf-r'}), null);
  assert.equal((await journal.goalProjection(owner.conversationId)).goal.goalId, 'main-r');
  const resumed = await journal.resumeGoal({...owner, rootRunId: 'resume-1'}, {goalId: 'main-r'});
  assert.equal(resumed.goal.id, stopped.rootRunId);
});

test('同链恢复后再次停止仍可恢复：链不换 goal.id，段位与累计请求跨恢复连续', async t => {
  const {journal} = await fixture(t);
  await stoppedGoal(journal, {rootRunId: 'r', requests: 2});
  const first = await journal.resumeGoal({...owner, rootRunId: 'resume-1'});
  assert.equal(first.goal.round, 2);
  assert.equal(first.goal.requestOffset, 2);
  // 恢复回合再次被停止：仍是最近受理链（恢复不换链），可再次恢复。
  const r1 = {...owner, rootRunId: 'resume-1'};
  await journal.requestStart(r1, {requestId: 'r1-q1', role: 'main'}, 3);
  await journal.requestEnd('r1-q1', {error: null});
  await journal.checkGoal(r1);
  await journal.recordGoalCheck(r1, {status: 'continue', reason: '还差收尾', evidence: ['已有产出'], remaining: ['验证剩余结果'], nextAction: '运行剩余验证'});
  await journal.endGoal(r1, 'cancelled', '用户停止');
  await journal.finishRoot(r1, 'cancelled', '用户停止');
  const again = await journal.findResumableGoal(owner.conversationId);
  assert.equal(again.goalId, 'r', '同链 goal.id 不变');
  assert.equal(again.sourceRootRunId, 'resume-1', '链内取最近可恢复 root');
  assert.equal(again.unconfirmedWork, false);
  const second = await journal.resumeGoal({...owner, rootRunId: 'resume-2'}, {goalId: 'r'});
  assert.equal(second.goal.id, 'r');
  assert.equal(second.goal.round, 3);
  assert.equal(second.goal.requestOffset, 3, '累计请求跨恢复连续');
});

test('后台等待链不被恢复入口误杀；旧背景链晚接续/晚收口不压过新链', async t => {
  const {journal} = await fixture(t);
  const policy = {maxRounds: 6, maxRequests: 10, maxRequestsPerRound: 6, noProgressRounds: 3};
  const bgOwner = {...owner, rootRunId: 'bg'};
  await journal.beginRoot(bgOwner);
  await journal.beginGoal(bgOwner, '后台目标', policy);
  await journal.suspendGoal(bgOwner);
  // 等待后台属同链非终态：幂等 already-active，不产生恢复投影。
  assert.deepEqual(await journal.findResumableGoal(owner.conversationId), {alreadyActive: true, goalId: 'bg', rootRunId: 'bg'});
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'x'}), {code: 'goal-already-active'});
  assert.equal((await journal.goalProjection(owner.conversationId)).goal, null);
  // 新独立普通回合完成后，旧后台链迟到接续（root 重新 running）如实投影为活跃，
  // 但晚终止后恢复入口仍只认最近受理的新链（此处新链已完成→无恢复入口）。
  const newOwner = {...owner, rootRunId: 'new-r'};
  await journal.beginRoot(newOwner);
  await journal.beginGoal(newOwner, '新的普通问题', policy);
  await journal.checkGoal(newOwner);
  await journal.recordGoalCheck(newOwner, {status: 'complete', reason: '已答复', evidence: ['回答'], remaining: [], nextAction: ''});
  await journal.finishRoot(newOwner, 'completed', '完成');
  await journal.resumeBackgroundGoal(bgOwner);
  assert.equal((await journal.goalProjection(owner.conversationId)).goal.goalId, 'bg');
  assert.equal((await journal.goalProjection(owner.conversationId)).goal.resumable, false);
  await journal.endGoal(bgOwner, 'cancelled', '用户停止');
  await journal.finishRoot(bgOwner, 'cancelled', '用户停止');
  assert.equal(await journal.findResumableGoal(owner.conversationId), null, '晚收口旧链不给恢复入口');
  assert.equal((await journal.goalProjection(owner.conversationId)).goal, null);
});

test('同毫秒受理的两个独立链：持久受理序决定恢复入口（重载后仍稳定）', async t => {
  const {journal, dir} = await fixture(t);
  const frozen = t.mock.method(Date, 'now', () => 1_700_000_000_000);
  try {
    await stoppedGoal(journal, {rootRunId: 'same-ms-a'});
    await stoppedGoal(journal, {rootRunId: 'same-ms-b'});
  } finally { frozen.mock.restore(); }
  assert.equal((await journal.findResumableGoal(owner.conversationId)).goalId, 'same-ms-b', '后受理者持有恢复入口');
  assert.equal(await journal.findResumableGoal(owner.conversationId, {goalId: 'same-ms-a'}), null);
  // 受理序持久在 root 记录内：与时钟和存储读取顺序无关。
  const seqA = (await journal.root({...owner, rootRunId: 'same-ms-a'})).admissionSeq;
  const seqB = (await journal.root({...owner, rootRunId: 'same-ms-b'})).admissionSeq;
  assert.ok(Number.isInteger(seqA) && Number.isInteger(seqB) && seqB > seqA, `admissionSeq 递增：${seqA} → ${seqB}`);
  await journal.flush();
  const restored = createRunJournal({dir});
  await restored.ready();
  assert.equal((await restored.findResumableGoal(owner.conversationId)).goalId, 'same-ms-b', '受理序随账本落盘');
});

test('迟到答复不能复活被遮断的旧链：beginGoal 续接要求等待链仍是最近受理链', async t => {
  const {journal} = await fixture(t);
  const policy = {maxRounds: 6, maxRequests: 10, maxRequestsPerRound: 6, noProgressRounds: 3};
  const waitGoal = async (rootOwner, objective) => {
    await journal.beginRoot(rootOwner);
    await journal.beginGoal(rootOwner, objective, policy);
    await journal.checkGoal(rootOwner);
    await journal.recordGoalCheck(rootOwner, {status: 'awaiting_user', question: '要哪个？', reason: '需要选择', evidence: [], remaining: [], nextAction: ''});
    await journal.finishRoot(rootOwner, 'awaiting_user');
  };
  // 旧链进入等待答复（挂起释放会话占用）。
  await waitGoal({...owner, rootRunId: 'a'}, '等待答复的旧目标');
  // 用户改问新的独立普通问题并完成。
  const bOwner = {...owner, rootRunId: 'b'};
  await journal.beginRoot(bOwner);
  await journal.beginGoal(bOwner, '新的普通问题', policy);
  await journal.checkGoal(bOwner);
  await journal.recordGoalCheck(bOwner, {status: 'complete', reason: '已答复', evidence: ['回答'], remaining: [], nextAction: ''});
  await journal.finishRoot(bOwner, 'completed', '完成');
  // 旧链的迟到答复：续接被拒，不建 goal、不复活旧链。
  const lateOwner = {...owner, rootRunId: 'late-cont'};
  await journal.beginRoot(lateOwner);
  await assert.rejects(journal.beginGoal(lateOwner, '答复', policy, {rootRunId: 'a', inputId: 'i1', answer: '选 A'}), /已变化/);
  assert.equal((await journal.root(lateOwner)).goal, undefined);
  assert.equal((await journal.root({...owner, rootRunId: 'a'})).status, 'awaiting_user', '旧等待 root 不被误改');
  // 未被遮断的等待链照常续接（守卫不过度拦截）。
  const cOwner = {conversationId: 'solo', rootRunId: 'c', generation: 1};
  await waitGoal(cOwner, '单独等待的目标');
  const contOwner = {conversationId: 'solo', rootRunId: 'c-cont', generation: 1};
  await journal.beginRoot(contOwner);
  const goal = await journal.beginGoal(contOwner, '答复', policy, {rootRunId: 'c', inputId: 'i1', answer: '选 A'});
  assert.equal(goal.id, 'c');
  assert.equal(goal.phase, 'active');
});

test('会话隔离：其他会话的新目标不拦截本会话等待链续接', async t => {
  const {journal} = await fixture(t);
  const policy = {maxRounds: 6, maxRequests: 10, maxRequestsPerRound: 6, noProgressRounds: 3};
  const alphaOwner = {conversationId: 'alpha', rootRunId: 'a1', generation: 1};
  await journal.beginRoot(alphaOwner);
  await journal.beginGoal(alphaOwner, 'alpha 等待答复', policy);
  await journal.checkGoal(alphaOwner);
  await journal.recordGoalCheck(alphaOwner, {status: 'awaiting_user', question: '要哪个？', reason: '需要选择', evidence: [], remaining: [], nextAction: ''});
  await journal.finishRoot(alphaOwner, 'awaiting_user');
  // 另一会话随后受理并停止新目标（全局受理序更晚）。
  const betaOwner = {conversationId: 'beta', rootRunId: 'b1', generation: 1};
  await journal.beginRoot(betaOwner);
  await journal.beginGoal(betaOwner, 'beta 新目标', policy);
  await journal.endGoal(betaOwner, 'cancelled', '用户停止');
  await journal.finishRoot(betaOwner, 'cancelled', '用户停止');
  // alpha 的答复续接按本会话受理序判断，不被 beta 的 root 拦截。
  const alphaCont = {conversationId: 'alpha', rootRunId: 'a1-cont', generation: 1};
  await journal.beginRoot(alphaCont);
  const goal = await journal.beginGoal(alphaCont, '选 A', policy, {rootRunId: 'a1', inputId: 'i1', answer: '选 A'});
  assert.equal(goal.id, 'a1');
  assert.equal(goal.phase, 'active');
  // 两会话各自的恢复互不串扰：goalId 不跨会话命中。
  assert.equal((await journal.findResumableGoal('beta')).goalId, 'b1');
  assert.deepEqual(await journal.findResumableGoal('alpha'), {alreadyActive: true, goalId: 'a1', rootRunId: 'a1-cont'});
  assert.equal(await journal.findResumableGoal('alpha', {goalId: 'b1'}), null);
  assert.equal(await journal.findResumableGoal('beta', {goalId: 'a1'}), null);
});

test('已受理的独立主 root 尚未挂 goal 也遮断旧链（准备中/准备失败不留恢复窗口）', async t => {
  const {journal} = await fixture(t);
  await stoppedGoal(journal, {rootRunId: 'old-r'});
  // 新独立回合建 root 后、beginGoal 前的准备阶段（running、无 goal）。
  const prepping = {...owner, rootRunId: 'prep-r'};
  await journal.beginRoot(prepping);
  assert.deepEqual(await journal.findResumableGoal(owner.conversationId), {alreadyActive: true, goalId: 'prep-r', rootRunId: 'prep-r'});
  assert.equal(await journal.findResumableGoal(owner.conversationId, {goalId: 'old-r'}), null);
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'x1'}, {goalId: 'old-r'}), {code: 'goal-not-resumable'});
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'x2'}), {code: 'goal-already-active'});
  assert.equal((await journal.goalProjection(owner.conversationId)).goal, null, '准备中不出现旧恢复投影');
  // 准备失败收口（failed、无 goal）：遮断保持，旧链不复活。
  await journal.finishRoot(prepping, 'failed', '输入准备失败');
  assert.equal(await journal.findResumableGoal(owner.conversationId), null);
  assert.equal(await journal.findResumableGoal(owner.conversationId, {goalId: 'old-r'}), null);
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'x3'}), {code: 'goal-not-resumable'});
  await assert.rejects(journal.resumeGoal({...owner, rootRunId: 'x4'}, {goalId: 'old-r'}), {code: 'goal-not-resumable'});
  assert.equal((await journal.goalProjection(owner.conversationId)).goal, null);
  assert.equal((await journal.root({...owner, rootRunId: 'old-r'})).status, 'cancelled');
});

test('恢复保持会话 generation 隔离：跨代来源拒绝，同代预算/幂等保留', async t => {
  const {journal} = await fixture(t);
  await stoppedGoal(journal, {rootRunId: 'r', requests: 2});
  // 回卷后的新时间线（generation 2）不能跨代恢复 generation 1 的旧链。
  await assert.rejects(journal.resumeGoal({...owner, generation: 2, rootRunId: 'g2-resume'}), error => error.code === 'goal-generation-mismatch' && /回卷/.test(error.message));
  const state = await journal.snapshot();
  assert.equal(state.roots['g2-resume'], undefined, '拒绝不建新 root');
  assert.equal(state.roots.r.status, 'cancelled', '旧 root 不被标 continued');
  // 同代恢复照常：预算跨 root 连续、重复恢复幂等。
  const resumed = await journal.resumeGoal({...owner, generation: 1, rootRunId: 'g1-resume'});
  assert.equal(resumed.goal.id, 'r');
  assert.equal(resumed.goal.round, 2);
  assert.equal(resumed.goal.requestOffset, 2);
  await assert.rejects(journal.resumeGoal({...owner, generation: 1, rootRunId: 'g1-resume-2'}), error => error.code === 'goal-already-active' && error.rootRunId === 'g1-resume');
});

// ---- 收口：同链后继不刷新链优先级；只读入口按 generation 过滤 ----

/** 合成持久状态（注入内存 storage）：用于构造当前代码已不可再产生、但旧版账本
 *  可能存在的历史形状（如新独立链之后又出现的迟到同链后继）。不读生产数据。 */
async function fixtureState(t, roots) {
  const dir = await mkdtemp(path.join(os.tmpdir(),'h64-journal-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  // roots 以数组传入（按受理序），账本表按 rootRunId 建键。
  const table = Object.fromEntries(roots.map(root => [root.owner.rootRunId, structuredClone(root)]));
  let state = {version: 2, roots: table, dispatches: {}, tasks: {}, inbox: {}, requests: {}, observations: {}, processes: {}};
  const storage = {
    load: async () => state,
    commit: async changes => { for (const [table, records] of Object.entries(changes)) for (const [id, record] of Object.entries(records)) state[table][id] = structuredClone(record); },
  };
  const journal = createRunJournal({dir, storage});
  await journal.ready();
  return {journal};
}
const legacyGoal = (id, objective, {phase = 'cancelled', round = 1} = {}) => ({id, objective, phase, round, requestOffset: 0,
  policy: {maxRounds: 6, maxRequests: 10, maxRequestsPerRound: 6, noProgressRounds: 3},
  verifications: [{status: 'continue', reason: '还差收尾', evidence: ['已有产出'], remaining: ['验证剩余结果'], nextAction: '运行剩余验证', round}], startedAt: 1});
const legacyRoot = (rootRunId, {goal = null, status = 'cancelled', seq, conversationId = 'c', generation = 1, kind = null} = {}) => ({
  owner: {conversationId, rootRunId, generation}, status, createdAt: seq * 1000, admissionSeq: seq, terminalAt: seq * 1000 + 1,
  reason: '用户停止', ...(kind ? {kind} : {}), ...(goal ? {goal} : {})});

test('老版账本的迟到同链后继不把旧链顶回最新：默认/显式/投影/恢复均不复活旧链', async t => {
  // 旧链 a 先停止；新独立链 b 随后受理并停止；老版代码此后又给旧链 a 建了迟到
  // 恢复后继（goal.id='a'，admissionSeq 最高）——链优先级仍由链头决定。
  const {journal} = await fixtureState(t, [
    legacyRoot('a', {goal: legacyGoal('a', '旧链目标'), seq: 1}),
    legacyRoot('b', {goal: legacyGoal('b', '新独立链目标'), seq: 2}),
    legacyRoot('a-late-resume', {goal: legacyGoal('a', '旧链目标', {round: 2}), seq: 3}),
    legacyRoot('a-late-cont', {goal: legacyGoal('a', '旧链目标', {round: 3}), seq: 4, status: 'interrupted'}),
  ]);
  const summary = await journal.findResumableGoal('c');
  assert.equal(summary.goalId, 'b', '默认恢复入口属最近独立链，迟到后继不改变链序');
  assert.equal(summary.sourceRootRunId, 'b');
  assert.equal(await journal.findResumableGoal('c', {goalId: 'a'}), null, '显式旧 goalId 拒绝');
  assert.equal((await journal.goalProjection('c')).goal.goalId, 'b', '投影不复活旧链');
  const resumed = await journal.resumeGoal({conversationId: 'c', rootRunId: 'new-resume', generation: 1});
  assert.equal(resumed.goal.id, 'b');
  await assert.rejects(journal.resumeGoal({conversationId: 'c', rootRunId: 'new-resume-2', generation: 1}, {goalId: 'a'}), {code: 'goal-not-resumable'});
});

test('只读入口按 generation 过滤：跨代不显示、不回退历史同代链', async t => {
  const {journal} = await fixture(t);
  await stoppedGoal(journal, {rootRunId: 'g1-r'});
  assert.equal((await journal.findResumableGoal(owner.conversationId, {generation: 1})).goalId, 'g1-r', '同代照常可见');
  assert.equal((await journal.goalProjection(owner.conversationId, {generation: 1})).goal.goalId, 'g1-r');
  // 回卷后的新时间线（generation 2）：旧链跨代不显示。
  assert.equal(await journal.findResumableGoal(owner.conversationId, {generation: 2}), null);
  assert.equal((await journal.goalProjection(owner.conversationId, {generation: 2})).goal, null);
  assert.equal(await journal.findResumableGoal(owner.conversationId, {goalId: 'g1-r', generation: 2}), null);
  // 新时间线随后受理并停止新链：按各自 generation 可见；查询旧代不回退到旧代链。
  await stoppedGoal(journal, {rootRunId: 'g2-r', generation: 2, conversationId: owner.conversationId});
  assert.equal((await journal.findResumableGoal(owner.conversationId, {generation: 2})).goalId, 'g2-r');
  assert.equal((await journal.goalProjection(owner.conversationId, {generation: 2})).goal.goalId, 'g2-r');
  assert.equal(await journal.findResumableGoal(owner.conversationId, {generation: 1}), null, '先选最近链再校验代际，不回退历史同代链');
  assert.equal((await journal.goalProjection(owner.conversationId, {generation: 1})).goal, null);
  // 不带 generation 的旧调用兼容：仍按最近独立链（此处为 g2）返回。
  assert.equal((await journal.findResumableGoal(owner.conversationId)).goalId, 'g2-r');
  assert.equal((await journal.goalProjection(owner.conversationId)).goal.goalId, 'g2-r');
});
