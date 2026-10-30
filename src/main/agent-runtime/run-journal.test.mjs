import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, rename, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRunJournal, dispatchIdentity, BUDGET_SUMMARY_PURPOSE } from './run-journal.mjs';
const owner = { conversationId: 'c', rootRunId: 'r', generation: 1 };
async function fixture(t) { const dir = await mkdtemp(path.join(os.tmpdir(),'h64-journal-')); t.after(() => rm(dir,{recursive:true,force:true})); const journal = createRunJournal({dir}); await journal.ready(); return { dir, journal };  }
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
  const file=path.join(dir,'run-journal.json'),backup=file+'.last-good';
  await rename(file,backup);await mkdir(file);
  await assert.rejects(journal.finishRoot(owner,'failed','storage failure'));
  assert.equal((await journal.root(owner)).status,'failed','confirmed end survives failed persistence in memory');
  assert.equal(JSON.parse(await readFile(backup,'utf8')).roots.r.status,'running','failed commit does not replace the last good file');
  await assert.rejects(journal.requestStart(owner,{requestId:'replayed'},10),/停止/);
  const next={...owner,rootRunId:'explicit-new-task'};
  await assert.rejects(journal.beginRoot(next));
  assert.equal((await journal.snapshot()).roots[next.rootRunId],undefined,'failed admission never enters executable memory state');
  assert.deepEqual((await readdir(dir)).filter(name=>name.endsWith('.tmp')),[]);
  await rm(file,{recursive:true});await rename(backup,file);
  const deadline=Date.now()+3000;
  while(JSON.parse(await readFile(file,'utf8')).roots.r.status!=='failed') {
    assert.ok(Date.now()<deadline,'pending terminal state should be retried without new work');
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  const saved=JSON.parse(await readFile(file,'utf8'));
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
  const {dir}=await fixture(t);await writeFile(path.join(dir,'run-journal.json'),'broken');
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
