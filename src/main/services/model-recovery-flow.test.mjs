import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationController} from './conversation-controller.mjs';
import {restoreFlowSnapshot} from './flow-bootstrap.mjs';
import {createFlowTimelineProjector, queueStoppedIdle} from '@hemi/conversation-flow/core';

test('recovery is an authoritative run fact: survives projection, prevents preemption and rejects stale commands', async () => {
  const starts=[],stops=[],retries=[],saves=[];
  const controller=createConversationController({conversationId:'c',effects:{store:{update:async()=>saves.push(1),flush:async()=>{}},runtime:{
    start:async value=>{starts.push(value);return {};},stop:async value=>stops.push(value),retryRecovery:async value=>{retries.push(value);return {ok:true};},
  }}});
  await controller.command({type:'send',input:{inputId:'a',text:'original'}});
  const runId=controller.getSnapshot().activeRunId;
  const recovery={id:'retry-owner',phase:'waiting',attempt:4,firstFailureAt:100,deadlineAt:1800100,nextRetryAt:200,updatedAt:100};
  assert.equal(controller.applyFact({type:'run-recovery',runId,recovery}).applied,true);
  const rows=createFlowTimelineProjector()(controller.getSnapshot()).transcripts;
  assert.equal(rows.at(-1).recovery.id,recovery.id);
  assert.equal(rows.filter(row=>row.author==='user').length,1);
  assert.equal((await controller.command({type:'retryRecovery',targetRunId:'stale',recoveryId:recovery.id})).ok,false);
  assert.equal((await controller.command({type:'retryRecovery',targetRunId:runId,recoveryId:'stale'})).ok,false);
  assert.equal(retries.length,0);
  assert.equal((await controller.command({type:'retryRecovery',targetRunId:runId,recoveryId:recovery.id})).ok,true);
  const queued=await controller.command({type:'send',preempt:'active',input:{inputId:'b',text:'next'}});
  assert.equal(queued.disposition,'queued');assert.equal(stops.length,0);assert.equal(starts.length,1);
  await controller.command({type:'stop',targetRunId:runId});
  controller.applyFact({type:'run-closed',runId,outcome:'stopped',at:300});
  const snapshot=controller.getSnapshot();
  assert.equal(snapshot.runs[runId].recovery.phase,'stopped');assert.equal(snapshot.queuePaused,true);
  assert.equal(queueStoppedIdle({...snapshot,pending:[]}),true);
  assert.equal(queueStoppedIdle({...snapshot,pending:[],runs:{[runId]:{...snapshot.runs[runId],recovery:{...recovery,phase:'expired'}}}}),false);
  assert.equal(controller.applyFact({type:'run-recovery',runId,recovery}).applied,false);
  assert.ok(saves.length>=3);
});

test('application restart preserves recovery history and draft queue without resuming old work', () => {
  const snapshot={revision:1,generation:1,activeRunId:'r',phase:'running',pending:[{inputId:'q',state:'pending'}],runs:{r:{runId:'r',recovery:{id:'recovery',phase:'waiting',nextRetryAt:100,history:[{phase:'waiting'}]}}}};
  const restored=restoreFlowSnapshot(snapshot);
  assert.equal(restored.phase,'idle');assert.equal(restored.activeRunId,null);
  assert.equal(restored.runs.r.outcome,'interrupted');assert.equal(restored.runs.r.recovery.phase,'stopped');
  assert.equal(restored.runs.r.recovery.nextRetryAt,null);assert.equal(restored.runs.r.recovery.history.length,1);
  assert.equal(restored.queuePaused,true);assert.equal(restored.pending.length,1);
  assert.equal(snapshot.runs.r.recovery.phase,'waiting','source snapshot remains immutable');
});
