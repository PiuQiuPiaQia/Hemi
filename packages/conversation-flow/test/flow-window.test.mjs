import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleUnderTest} from './compile.mjs';
const {projectFlowWindow,flowHistoryPage,createFlowWindowProjector,applyFlowChange,createConversation}=await moduleUnderTest('../src/core.ts');
const item=i=>({kind:'user',id:'input-'+i,runId:'run-'+i,text:String(i)+':'+ 'x'.repeat(64*1024),inputSource:'text',attachmentIds:[],acceptedAt:0,deliveredAt:0});
const full={schemaVersion:1,conversationId:'long',generation:1,revision:1,phase:'idle',activeRunId:null,queuePaused:false,pending:[],timeline:Array.from({length:100},(_,i)=>item(i)),runs:{},tasks:{},permissions:{},artifacts:{},pendingReports:[]};
test('long histories have a bounded active baseline and every historical row remains retrievable',()=>{
 const head=projectFlowWindow(full);assert.ok(Buffer.byteLength(JSON.stringify(full))>6*1024*1024);assert.ok(Buffer.byteLength(JSON.stringify(head))<256*1024);
 let before=head.history.start,rows=head.timeline;
 while(before){const page=flowHistoryPage(full,{before,generation:1});assert.equal(page.end,before);assert.ok(page.start<before);rows=[...page.snapshot.timeline,...rows];before=page.start;}
 assert.deepEqual(rows.map(x=>x.id),full.timeline.map(x=>x.id));
 assert.throws(()=>flowHistoryPage(full,{before:3,generation:2}),{code:'conflict'});
});
test('window patches preserve revisions and global history offsets through append, update and rewind',()=>{
 let authoritative=full;const project=createFlowWindowProjector(applyFlowChange,()=>authoritative);
 let visible=project({type:'reset',snapshot:{detail:{id:'long',flow:full}}}).snapshot.detail.flow;
 for(let i=100;i<160;i++){
  const change={kind:'patch',conversationId:'long',generation:1,baseRevision:authoritative.revision,revision:authoritative.revision+1,changes:[{kind:'item-appended',item:item(i)}]};
  authoritative=applyFlowChange(authoritative,change).snapshot;
  const frame=project({type:'flow',id:'long',change});const applied=applyFlowChange(visible,frame.change);assert.equal(applied.ok,true);visible=applied.snapshot;
  assert.equal(visible.history.total,i+1);assert.equal(visible.history.start+visible.timeline.length,i+1);assert.ok(Buffer.byteLength(JSON.stringify(frame))<300*1024);
 }
 authoritative={...full,revision:100,generation:2,timeline:[item(999)]};
 const frame=project({type:'flow',id:'long',change:{kind:'patch',conversationId:'long',generation:2,baseRevision:99,revision:100,changes:[]}});
 assert.equal(frame.change.kind,'snapshot');assert.equal(frame.change.snapshot.generation,2);
});
test('history reads and commands run concurrently without cancelling each other',async t=>{
 let signal,release,reads=0,commands=0,receive;
 const client=createConversation({scope:{environmentId:'test',conversationId:'long'},transport:{
  async fetchSnapshot(){reads++;return projectFlowWindow(full);},
  subscribe(_scope,onChange,_offline,online){receive=onChange;onChange({kind:'snapshot',snapshot:projectFlowWindow(full),epoch:'boot'});online();return()=>{};},
  fetchHistory(_scope,cursor,context){signal=context.signal;return new Promise(resolve=>release=()=>resolve(flowHistoryPage(full,cursor)));},
  async command(){commands++;return {ok:true};}
 }});t.after(()=>client.dispose());await client.start();const history=client.loadHistory();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(client.getSnapshot().history.loading,true);assert.equal((await client.sendCommand({type:'resumeQueue'})).ok,true);assert.equal(signal.aborted,false);release();await history;
 assert.equal(signal.aborted,false);assert.equal(client.getSnapshot().history.error,'');assert.equal(commands,1);assert.equal(reads,0);assert.equal(client.getSnapshot().connection,'online');
 receive({kind:'snapshot',snapshot:{...projectFlowWindow(full),revision:0},epoch:'new-boot'});assert.equal(client.getSnapshot().snapshot.revision,0);
});
test('loaded history merges with live heads without duplicating rows or caching the full history',async t=>{
 let receive;const saved=[];
 const client=createConversation({scope:{environmentId:'test',conversationId:'long'},storage:{snapshots:{async load(){return null;},async save(_scope,value){saved.push(value);}}},transport:{
 async fetchSnapshot(){return projectFlowWindow(full);},subscribe(_s,change,_off,online){receive=change;change({kind:'snapshot',snapshot:projectFlowWindow(full)});online();return()=>{};},
 async fetchHistory(_s,cursor){return flowHistoryPage(full,cursor);},async command(){return {ok:true};}
 }});t.after(()=>client.dispose());await client.start();await client.loadHistory();const start=client.getSnapshot().snapshot.history.start;
 const next={...full,revision:2,timeline:[...full.timeline,item(100)]};receive({kind:'snapshot',snapshot:projectFlowWindow(next)});
 const snapshot=client.getSnapshot().snapshot;assert.equal(snapshot.history.start,start);assert.equal(new Set(snapshot.timeline.map(x=>x.id)).size,snapshot.timeline.length);
 const old=client.getSnapshot().snapshot.timeline[0];receive({kind:'patch',conversationId:'long',generation:1,baseRevision:2,revision:3,changes:[{kind:'item-updated',item:{...old,text:'Historical update'}}]});assert.equal(client.getSnapshot().snapshot.timeline[0].text,'Historical update');
 await client.flushSnapshot();assert.ok(saved.at(-1).timeline.length<snapshot.timeline.length);assert.ok(Buffer.byteLength(JSON.stringify(saved.at(-1)))<256*1024);
});
test('replica applies the rewind patch that advances generation by one',()=>{
 const base={...full,timeline:full.timeline.slice(0,2)};
 const meta={phase:'idle',activeRunId:null,awaitingUser:null,queuePaused:false,generation:2};
 const change={kind:'patch',conversationId:'long',generation:2,baseRevision:1,revision:2,changes:[{kind:'multi',changes:[{kind:'meta',meta},{kind:'timeline',timeline:[]}]}]};
 const applied=applyFlowChange(base,change);assert.equal(applied.ok,true);assert.equal(applied.snapshot.generation,2);assert.equal(applied.snapshot.timeline.length,0);
 assert.equal(applyFlowChange(base,{...change,changes:[{kind:'timeline',timeline:[]}]}).code,'stale');
 assert.equal(applyFlowChange(base,{...change,generation:3,changes:[{kind:'meta',meta:{...meta,generation:3}}]}).code,'stale');
});
