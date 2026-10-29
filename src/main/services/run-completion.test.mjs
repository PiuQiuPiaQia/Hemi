import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationController} from './conversation-controller.mjs';
import {closeConversationRun} from './run-completion.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture() {
  const starts = [];
  const controller = createConversationController({conversationId:'closure',effects:{
    runtime:{async start(spec) {starts.push(spec);},async stop() {}},
    store:{async update() {},async flush() {}},
  }});
  const sent = await controller.command({type:'send',input:{text:'first'}});
  return {controller,starts,runId:sent.runId,generation:controller.getSnapshot().generation};
}

for (const code of ['ENOSPC','EACCES','EIO']) test(`failed terminal write (${code}) closes the run and pauses accepted queue inputs`, async () => {
  const f = await fixture();
  const queued = await f.controller.command({type:'send',input:{text:'queued'}});
  assert.equal(queued.disposition,'queued');
  const error = Object.assign(new Error(`${code}: write failed`),{code});
  const result = await closeConversationRun({...f,outcome:'failed',pauseQueue:true,persist:async () => {throw error;}});
  await tick();
  const snapshot = f.controller.getSnapshot();
  assert.equal(result,error);
  assert.equal(snapshot.phase,'idle');
  assert.equal(snapshot.activeRunId,null);
  assert.equal(snapshot.runs[f.runId].outcome,'failed');
  assert.equal(snapshot.queuePaused,true);
  assert.equal(snapshot.pending.length,1);
  assert.equal(f.starts.length,1,'saving failure must not dispatch queued work');
  assert.ok(JSON.stringify(snapshot.timeline).includes(code));
});

test('a hung terminal save has a bounded close; its late result cannot close a newer run', async () => {
  const f = await fixture();
  let release;
  const error = await closeConversationRun({...f,outcome:'completed',timeoutMs:10,persist:() => new Promise(resolve => {release=resolve;})});
  assert.equal(error.code,'run-state-save-timeout');
  assert.equal(f.controller.getSnapshot().runs[f.runId].outcome,'partial');
  const next = await f.controller.command({type:'send',input:{text:'new explicit task'}});
  assert.notEqual(next.runId,f.runId);
  release();await tick();
  assert.equal(f.controller.getSnapshot().activeRunId,next.runId);
  assert.equal(f.starts.length,2);
});

test('a stale completion cannot pause or close a newer run', async () => {
  const f=await fixture();let release;
  const closing=closeConversationRun({...f,outcome:'failed',pauseQueue:true,persist:()=>new Promise((_,reject)=>{release=reject;})});
  await tick();
  f.controller.applyFact({type:'run-closed',runId:f.runId,generation:f.generation,outcome:'failed'});
  const next=await f.controller.command({type:'send',input:{text:'next'}});
  release(new Error('late storage failure'));await closing;
  assert.equal(f.controller.getSnapshot().activeRunId,next.runId);
  assert.equal(f.controller.getSnapshot().queuePaused,false);
});

test('save failure does not automatically dispatch an input promoted while the old run was stopping', async () => {
  const f=await fixture();
  const queued=await f.controller.command({type:'send',input:{text:'promoted'}});
  await f.controller.command({type:'promoteInput',inputId:queued.inputId});
  await closeConversationRun({...f,outcome:'stopped',persist:async()=>{throw new Error('write failed');}});
  await tick();
  const snapshot=f.controller.getSnapshot();
  assert.equal(snapshot.phase,'idle');assert.equal(snapshot.queuePaused,true);
  assert.equal(snapshot.pending.length,1);assert.equal(snapshot.pending[0].promoteTarget,null);
  assert.equal(f.starts.length,1);
});

test('save failure holds a replacement awaiting handoff for review instead of dispatching it', async () => {
  const f=await fixture();
  const replacement=await f.controller.command({type:'send',preempt:'active',input:{text:'replacement'}});
  assert.equal(replacement.disposition,'preempting');
  await closeConversationRun({...f,outcome:'stopped',persist:async()=>{throw new Error('write failed');}});
  await tick();
  const snapshot=f.controller.getSnapshot();
  assert.equal(snapshot.phase,'idle');assert.equal(snapshot.queuePaused,true);
  assert.equal(snapshot.pending.length,1);assert.equal(snapshot.pending[0].text,'replacement');
  assert.equal(snapshot.pending[0].state,'needs-review');assert.equal(f.starts.length,1);
});

test('unconfirmed cleanup retains its own failure path instead of becoming a storage-only failure', async () => {
  const f=await fixture(),error=Object.assign(new Error('process cleanup remains unconfirmed'),{code:'cleanup-unconfirmed'});
  await f.controller.command({type:'send',preempt:'active',input:{text:'replacement'}});
  assert.equal(await closeConversationRun({...f,outcome:'completed',persist:async()=>{throw error;}}),error);
  await tick();
  const snapshot=f.controller.getSnapshot();
  assert.equal(snapshot.runs[f.runId].outcome,'failed');assert.equal(snapshot.queuePaused,true);
  assert.equal(snapshot.pending[0].state,'needs-review');assert.equal(f.starts.length,1);
  assert.doesNotMatch(JSON.stringify(snapshot.timeline),/运行状态尚未保存/);
  assert.match(JSON.stringify(snapshot.timeline),/cleanup remains unconfirmed/);
});
