import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationController} from './conversation-controller.mjs';
import {closeUnconfirmedCommand} from './command-cleanup-failure.mjs';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('unconfirmed cleanup closes the old run, preserves the queue and rejects late old-run facts',async()=>{
  const starts=[];
  const controller=createConversationController({conversationId:'c',effects:{store:{update:async()=>{},flush:async()=>{}},runtime:{start:async spec=>{starts.push(spec);},stop:async()=>{}}}});
  await controller.command({type:'send',input:{text:'first'}});
  const {activeRunId:runId,generation}=controller.getSnapshot();
  const queued=await controller.command({type:'send',input:{text:'keep queued'}});
  await controller.command({type:'stop',reason:'promote'});
  assert.equal(closeUnconfirmedCommand(controller,{runId,generation,error:Error('cleanup requires review')}),true);
  await settle();
  const closed=controller.getSnapshot();
  assert.equal(closed.phase,'idle');assert.equal(closed.queuePaused,true);
  assert.equal(closed.runs[runId].outcome,'failed');
  assert.ok(closed.pending.some(input=>input.inputId===queued.inputId));
  assert.equal(starts.length,1);
  assert.equal(closeUnconfirmedCommand(controller,{runId:'unrelated',generation,error:Error('late')}),false);
  await controller.command({type:'resumeQueue'});await settle();
  const next=controller.getSnapshot().activeRunId;
  assert.notEqual(next,runId);
  controller.applyFact({type:'run-closed',runId,generation,at:0,outcome:'completed'});
  assert.equal(controller.getSnapshot().activeRunId,next);
  assert.equal(starts.length,2);
});

test('rewind awaiting a failed handoff remains reviewable instead of silently dispatching or losing its text',async()=>{
  const controller=createConversationController({conversationId:'c',effects:{store:{update:async()=>{},flush:async()=>{}},runtime:{start:async()=>{},stop:async()=>{}}}});
  await controller.command({type:'send',input:{inputId:'original',text:'first'}});
  const {activeRunId:runId,generation}=controller.getSnapshot();
  for(let i=0;i<8;i++)await controller.command({type:'send',input:{text:'queued '+i}});
  await controller.command({type:'rewind',targetInputId:'original',input:{text:'replacement'}});
  closeUnconfirmedCommand(controller,{runId,generation,error:Error('cleanup requires review')});
  await settle();
  const snapshot=controller.getSnapshot();
  assert.equal(snapshot.phase,'idle');assert.equal(snapshot.queuePaused,true);
  assert.equal(snapshot.pending.find(input=>input.text==='replacement')?.state,'needs-review');
  assert.equal(snapshot.generation,generation);
  assert.equal(snapshot.pending.length,9);
});

test('a promoted input does not bypass the queue pause when old-run cleanup fails',async()=>{
  const starts=[];
  const controller=createConversationController({conversationId:'c',effects:{store:{update:async()=>{},flush:async()=>{}},runtime:{start:async spec=>{starts.push(spec);},stop:async()=>{}}}});
  await controller.command({type:'send',input:{inputId:'first',text:'first'}});
  const {activeRunId:runId,generation}=controller.getSnapshot();
  await controller.command({type:'send',input:{inputId:'next',text:'keep next'}});
  await controller.command({type:'promoteInput',inputId:'next'});
  closeUnconfirmedCommand(controller,{runId,generation,error:Error('cleanup requires review')});
  await settle();
  const snapshot=controller.getSnapshot();
  assert.equal(starts.length,1);assert.equal(snapshot.phase,'idle');assert.equal(snapshot.queuePaused,true);
  assert.equal(snapshot.pending[0].inputId,'next');assert.equal(snapshot.pending[0].promoteAt,null);
  assert.equal(snapshot.timeline.filter(item=>item.id==='next').length,0);
});
