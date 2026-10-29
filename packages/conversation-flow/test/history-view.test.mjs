import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleUnderTest} from './compile.mjs';
const {createConversation,projectFlowWindow,flowHistoryPage}=await moduleUnderTest('../src/core.ts');
const row=i=>({kind:'user',id:'u'+i,runId:'r'+i,text:'Question '+i,inputSource:'text',attachmentIds:[],acceptedAt:1,deliveredAt:1});
const full=(length,revision=1,generation=1)=>({schemaVersion:1,conversationId:'history',revision,generation,phase:'idle',activeRunId:null,queuePaused:false,pending:[],timeline:Array.from({length},(_,i)=>row(i)),runs:{},tasks:{},artifacts:{},permissions:{},pendingReports:[]});
async function fixture(t) {
  let source=full(100),receive,offline,online,read,reads=0;
  const client=createConversation({scope:{environmentId:'test',conversationId:'history'},transport:{
    async fetchSnapshot(){return projectFlowWindow(source);},
    subscribe(_scope,change,off,on){receive=change;offline=off;online=on;change({kind:'snapshot',snapshot:projectFlowWindow(source),epoch:'boot'});on();return()=>{};},
    async fetchHistory(_scope,cursor,context){reads++;return read?read(cursor,context):flowHistoryPage(source,cursor);},async command(){return {ok:true};},
  }});
  t.after(()=>client.dispose());await client.start();
  return {client,change:value=>receive(value),offline:()=>offline(),online:()=>online(),get reads(){return reads;},hold(fn){read=fn;},head(length,revision,generation=1,epoch='boot'){source=full(length,revision,generation);receive({kind:'snapshot',snapshot:projectFlowWindow(source),epoch});}};
}
test('discontinuous heads retain the reading segment and expose one user-driven gap',async t=>{
  const f=await fixture(t);await f.client.loadHistory();const first=f.client.getSnapshot().snapshot.timeline[0].id;
  f.head(200,2);f.head(300,3);
  let state=f.client.getSnapshot();assert.equal(state.snapshot.timeline[0].id,first);assert.equal(state.snapshot.timeline.at(-1).id,'u299');assert.equal(f.reads,1);
  assert.deepEqual(state.snapshot.history.gap,{start:100,end:268,beforeId:'u268'});
  await f.client.loadHistory();assert.equal(f.client.getSnapshot().snapshot.history.start,4);
  let iterations=0;
  while(f.client.getSnapshot().history.gap){assert.ok(iterations++<10);await f.client.loadHistory('gap');}
  state=f.client.getSnapshot();assert.deepEqual(state.snapshot.timeline.map(item=>item.id),Array.from({length:296},(_,i)=>'u'+(i+4)));
  await f.client.loadHistory();assert.equal(f.client.getSnapshot().history.hasMore,false);assert.equal(f.client.getSnapshot().snapshot.timeline.length,300);
});
test('late history responses cannot cross generation or Host authority fences',async t=>{
  const f=await fixture(t);let resolve,signal;
  f.hold((cursor,context)=>{signal=context.signal;return new Promise(done=>resolve=()=>done(flowHistoryPage(full(100,1,cursor.generation),cursor)));});
  const read=f.client.loadHistory();await new Promise(setImmediate);f.head(5,2,2);assert.equal(signal.aborted,true);resolve();await read;
  assert.equal(f.client.getSnapshot().snapshot.timeline.length,5);assert.equal(f.client.getSnapshot().history.error,'');
  f.head(100,3,2);const second=f.client.loadHistory();await new Promise(setImmediate);f.head(4,0,1,'new-boot');resolve();await second;
  assert.equal(f.client.getSnapshot().snapshot.revision,0);assert.equal(f.client.getSnapshot().history.loading,false);assert.equal(f.client.getSnapshot().history.error,'');
});
test('a valid page overtaken by a fuller live baseline is discarded without a false error',async t=>{
  const f=await fixture(t);let resolve;
  f.hold(cursor=>new Promise(done=>resolve=()=>done(flowHistoryPage(full(100,1,cursor.generation),cursor))));
  const read=f.client.loadHistory();await new Promise(setImmediate);f.head(20,2);resolve();await read;
  assert.equal(f.client.getSnapshot().snapshot.timeline.length,20);assert.equal(f.client.getSnapshot().history.error,'');
});
test('normal history pages align to QA boundaries; oversized QA has explicit continuations and no lost rows',()=>{
  const source=full(0);source.timeline=Array.from({length:20},(_,i)=>[row(i),...Array.from({length:3},(_,j)=>({kind:'assistant',itemId:`a${i}-${j}`,runId:'r'+i,afterInputId:'u'+i,parts:[]}))]).flat();
  let view=projectFlowWindow(source,{limit:6});assert.equal(view.timeline[0].kind,'user');assert.equal(view.history.continuation,undefined);
  const page=flowHistoryPage(source,{generation:1,before:view.history.start,limit:6});assert.equal(page.snapshot.timeline[0].kind,'user');assert.equal(page.continuation,undefined);
  source.timeline=[row(0),...Array.from({length:250},(_,j)=>({kind:'assistant',itemId:'a'+j,runId:'r0',afterInputId:'u0',parts:[{partId:'p'+j,kind:'text',content:'x'.repeat(12000)}]}))];
  view=projectFlowWindow(source);assert.deepEqual(view.history.continuation,{questionId:'u0'});assert.ok(Buffer.byteLength(JSON.stringify(view))<256*1024);
  let before=view.history.start,ids=view.timeline.map(item=>item.itemId??item.id),continuations=0;
  while(before){const page=flowHistoryPage(source,{generation:1,before});if(page.continuation)continuations++;ids=[...page.snapshot.timeline.map(item=>item.itemId??item.id),...ids];before=page.start;}
  assert.ok(continuations>1);assert.deepEqual(ids,source.timeline.map(item=>item.itemId??item.id));
});

test('history loading during a connection recovery gives feedback and recovers without consuming a read',async t=>{
 const f=await fixture(t);f.offline();await f.client.loadHistory();assert.equal(f.reads,0);assert.match(f.client.getSnapshot().history.error,/连接恢复/);f.online();assert.equal(f.client.getSnapshot().history.error,'');await f.client.loadHistory();assert.equal(f.reads,1);
});
test('updates overtaking a history response win over the earlier page data',async t=>{
 const f=await fixture(t);let resolve;
 f.hold(cursor=>new Promise(done=>resolve=()=>done(flowHistoryPage(full(100),cursor))));
 const read=f.client.loadHistory();await new Promise(setImmediate);
 f.change({kind:'patch',conversationId:'history',generation:1,baseRevision:1,revision:2,changes:[{kind:'item-updated',item:{...row(40),text:'newer historical content'}}]});
 resolve();await read;assert.equal(f.client.getSnapshot().snapshot.timeline.find(item=>item.id==='u40').text,'newer historical content');
});
