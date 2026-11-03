import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRunJournal} from '../agent-runtime/run-journal.mjs';
import {initConversationFlowService, __resetConversationFlowServiceForTests} from './conversation-flow-service.mjs';
import {publishGoalStatus} from './goal-status-projection.mjs';

const conversationId = 'goal-projection';
const policy = {maxRounds:6, maxRequests:10, maxRequestsPerRound:6, noProgressRounds:3};
async function fixture(t) {
  __resetConversationFlowServiceForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-goal-projection-'));
  const journal = createRunJournal({dir:path.join(dir,'journal')});
  await journal.ready();
  const flowService = initConversationFlowService({dir:path.join(dir,'conversations'), runtimeFactory:() => ({async start() {}, async stop() {}})});
  t.after(async () => {await flowService.dropAll(); __resetConversationFlowServiceForTests(); fs.rmSync(dir,{recursive:true,force:true});});
  const controller = flowService.controllerFor(conversationId);
  const receipt = await controller.command({type:'send', input:{text:'旧目标'}});
  const owner = {conversationId, rootRunId:receipt.runId, generation:controller.getSnapshot().generation};
  await journal.beginRoot(owner);
  await journal.beginGoal(owner,'旧目标',policy);
  await journal.endGoal(owner,'cancelled','用户停止');
  await journal.finishRoot(owner,'cancelled','用户停止');
  controller.applyFact({type:'run-closed', runId:owner.rootRunId, generation:owner.generation, outcome:'stopped', at:Date.now()});
  return {journal, flowService, controller, owner};
}

// 延迟的是实际账本查询的返回，账本、控制器与持久化均用生产实现。
function pauseProjection(journal) {
  let release, read;
  const gate = new Promise(resolve => {release=resolve;});
  const ready = new Promise(resolve => {read=resolve;});
  return {ready, release, journal:{async goalProjection(id, options) {const value=await journal.goalProjection(id,options); read(); await gate; return value;}}};
}

function publish(f, journal=f.journal) {return publishGoalStatus({conversationId, journal, flowService:f.flowService});}

test('收口后的真实账本投影正常发布，最新停止目标仍可恢复', async t => {
  const f=await fixture(t);
  assert.equal(await publish(f),true);
  assert.equal(f.controller.getSnapshot().goal.goalId,f.owner.rootRunId);
  assert.equal(f.controller.getSnapshot().goal.resumable,true);
  assert.equal(await publish(f),false,'相同投影不重复改变 revision');
});

test('旧投影读取跨过新普通回合的开始与完成，回到 idle 也不能写回', async t => {
  const f=await fixture(t), delayed=pauseProjection(f.journal);
  const pending=publish(f,delayed.journal);
  await delayed.ready;
  const sent=await f.controller.command({type:'send',input:{text:'新的普通问题'}});
  const owner={...f.owner,rootRunId:sent.runId};
  await f.journal.beginRoot(owner); await f.journal.beginGoal(owner,'新的普通问题',policy);
  await f.journal.checkGoal(owner);
  await f.journal.recordGoalCheck(owner,{status:'complete',reason:'已回答',evidence:['回答正文'],remaining:[],nextAction:''});
  await f.journal.finishRoot(owner,'completed','已回答');
  f.controller.applyFact({type:'run-closed',runId:sent.runId,generation:owner.generation,outcome:'completed',at:Date.now()});
  assert.equal(f.controller.getSnapshot().phase,'idle');
  delayed.release(); assert.equal(await pending,false);
  assert.equal(f.controller.getSnapshot().goal,null);
  await publish(f);
  assert.equal(f.controller.getSnapshot().goal,null,'新鲜账本投影仍无历史恢复入口');
});

test('回卷清除旧恢复条且拒绝迟到投影，之后重新查询也不恢复跨代链', async t => {
  const f=await fixture(t), delayed=pauseProjection(f.journal);
  assert.equal(await publish(f),true);
  assert.equal(f.controller.getSnapshot().goal.resumable,true);
  const pending=publish(f,delayed.journal); await delayed.ready;
  const input=f.controller.getSnapshot().timeline.find(item=>item.kind==='user');
  assert.ok(input?.id);
  assert.equal(f.controller.applyFact({type:'generation-bumped',generation:f.owner.generation,cutAfterInputId:input.id}).applied,true);
  assert.equal(f.controller.getSnapshot().generation,f.owner.generation+1);
  delayed.release(); assert.equal(await pending,false);
  assert.equal(f.controller.getSnapshot().goal,null);
});

test('会话控制器关闭重建后，旧投影不能写到新控制器', async t => {
  const f=await fixture(t), delayed=pauseProjection(f.journal);
  const pending=publish(f,delayed.journal); await delayed.ready;
  await f.flowService.drop(conversationId);
  const replacement=f.flowService.controllerFor(conversationId);
  assert.notEqual(replacement,f.controller);
  delayed.release(); assert.equal(await pending,false);
  assert.equal(replacement.getSnapshot().goal,null);
});

test('更近的投影先写入时，迟到读取不能覆盖它；后台任务更新不阻止有效投影', async t => {
  const f=await fixture(t), delayed=pauseProjection(f.journal);
  const pending=publish(f,delayed.journal); await delayed.ready;
  assert.equal(await publish(f),true);
  const current=f.controller.getSnapshot().goal;
  delayed.release(); assert.equal(await pending,false);
  assert.equal(f.controller.getSnapshot().goal,current);
  f.controller.applyFact({type:'goal-status',goal:null});
  const next=pauseProjection(f.journal), valid=publish(f,next.journal); await next.ready;
  f.controller.applyFact({type:'task-updated',task:{taskId:'background',phase:'executing'}});
  next.release(); assert.equal(await valid,true);
  assert.equal(f.controller.getSnapshot().goal.resumable,true);
});
