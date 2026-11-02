import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleUnderTest} from './compile.mjs';
const {projectFlowWindow,flowHistoryPage,createFlowWindowProjector,applyFlowChange,createConversation}=await moduleUnderTest('../src/core.ts');
const item=i=>({kind:'user',id:'input-'+i,runId:'run-'+i,text:String(i)+':'+ 'x'.repeat(64*1024),inputSource:'text',attachmentIds:[],acceptedAt:0,deliveredAt:0});
const full={schemaVersion:1,conversationId:'long',generation:1,revision:1,phase:'idle',activeRunId:null,queuePaused:false,pending:[],timeline:Array.from({length:100},(_,i)=>item(i)),runs:{},tasks:{},permissions:{},artifacts:{},pendingReports:[]};
test('windowed clients retain background jobs and receive output/removal patches while foreground is idle',()=>{
 let authoritative={...full,timeline:[]};const project=createFlowWindowProjector(applyFlowChange,()=>authoritative);
 let view=project({type:'reset',snapshot:{detail:{id:'long',flow:authoritative}}}).snapshot.detail.flow;
 const job={id:'job',runId:'old',generation:1,command:'pnpm dev',status:'running',output:'Ready'};
 for(const jobs of [[job],[{...job,output:'New output'}],[]]){
  const change={kind:'patch',conversationId:'long',generation:1,baseRevision:authoritative.revision,revision:authoritative.revision+1,changes:[{kind:'background-jobs',jobs}]};
  authoritative=applyFlowChange(authoritative,change).snapshot;
  const frame=project({type:'flow',id:'long',change});const applied=applyFlowChange(view,frame.change);
  assert.equal(applied.ok,true);view=applied.snapshot;assert.deepEqual(view.backgroundJobs,jobs);
  assert.equal(view.phase,'idle');assert.equal(view.activeRunId,null);
 }
});
test('long histories have a bounded active baseline and every historical row remains retrievable',()=>{
 const head=projectFlowWindow(full);assert.ok(Buffer.byteLength(JSON.stringify(full))>6*1024*1024);assert.equal(head.timeline.length,10);
 let before=head.history.start,rows=head.timeline;
 while(before){const page=flowHistoryPage(full,{before,generation:1});assert.equal(page.end,before);assert.ok(page.start<before);rows=[...page.snapshot.timeline,...rows];before=page.start;}
 assert.deepEqual(rows.map(x=>x.id),full.timeline.map(x=>x.id));
 assert.throws(()=>flowHistoryPage(full,{before:3,generation:2}),{code:'conflict'});
});
test('large child execution details do not shrink main-flow history into one-row pages',()=>{
 const conversation={messages:[{id:'child-message',text:'child output '.repeat(40000)}]};
 const task={taskId:'child',toolCallId:'call',phase:'terminal',outcome:'complete',conversation,
  executions:{call:{taskId:'child',toolCallId:'call',phase:'terminal',outcome:'complete',conversation}}};
 const timeline=Array.from({length:60},(_,i)=>[
  {...item(i),text:'Question '+i},
  {kind:'assistant',itemId:'answer-'+i,runId:'run-'+i,afterInputId:'input-'+i,
   parts:[{kind:'delegation',partId:'delegation-'+i,taskId:'child',toolCallId:'call'},
    {kind:'text',partId:'answer-text-'+i,phase:'final_answer',content:'Answer '+i}]}]).flat();
 const snapshot={...full,timeline,tasks:{child:task}};
 const head=projectFlowWindow(snapshot);
 assert.equal(head.timeline.length,20);
 assert.equal(head.timeline[0].kind,'user');
 assert.deepEqual(head.tasks.child,task,'process preview keeps the complete per-execution conversation');
 let before=head.history.start,rows=head.timeline,pages=0;
 while(before){const page=flowHistoryPage(snapshot,{before,generation:1});rows=[...page.snapshot.timeline,...rows];before=page.start;pages++;}
 assert.equal(pages,5);
 assert.deepEqual(rows,timeline);
 assert.deepEqual(snapshot.tasks.child,task,'projection never changes the archive');
});
test('window patches preserve revisions and global history offsets through append, update and rewind',()=>{
 let authoritative=full;const project=createFlowWindowProjector(applyFlowChange,()=>authoritative);
 let visible=project({type:'reset',snapshot:{detail:{id:'long',flow:full}}}).snapshot.detail.flow;
 for(let i=100;i<160;i++){
  const change={kind:'patch',conversationId:'long',generation:1,baseRevision:authoritative.revision,revision:authoritative.revision+1,changes:[{kind:'item-appended',item:item(i)}]};
  authoritative=applyFlowChange(authoritative,change).snapshot;
  const frame=project({type:'flow',id:'long',change});const applied=applyFlowChange(visible,frame.change);assert.equal(applied.ok,true);visible=applied.snapshot;
  assert.equal(visible.history.total,i+1);assert.equal(visible.history.start+visible.timeline.length,i+1);assert.equal(visible.timeline.length,10+(i-99)%6);
 }
 authoritative={...full,revision:100,generation:2,timeline:[item(999)]};
 const frame=project({type:'flow',id:'long',change:{kind:'patch',conversationId:'long',generation:2,baseRevision:99,revision:100,changes:[]}});
 assert.equal(frame.change.kind,'snapshot');assert.equal(frame.change.snapshot.generation,2);
});
test('live windows allow five extra QAs, then reclaim everything outside the latest ten',()=>{
 const qa=i=>[{...item(i),text:'Question '+i},{kind:'assistant',itemId:'answer-'+i,runId:'run-'+i,afterInputId:'input-'+i,parts:[{kind:'text',partId:'part-'+i,content:'Answer '+i}]}];
 let canonical={...full,timeline:Array.from({length:10},(_,i)=>qa(i)).flat()};
 const project=createFlowWindowProjector(applyFlowChange,()=>canonical);
 let visible=project({type:'reset',snapshot:{detail:{id:'long',flow:canonical}}}).snapshot.detail.flow;
 const starts=[];
 for(let i=10;i<20;i++){
  const change={kind:'patch',conversationId:'long',generation:1,baseRevision:canonical.revision,revision:canonical.revision+1,changes:qa(i).map(item=>({kind:'item-appended',item}))};
  canonical=applyFlowChange(canonical,change).snapshot;
  visible=applyFlowChange(visible,project({type:'flow',id:'long',change}).change).snapshot;
  starts.push(visible.history.start);
  assert.equal(visible.timeline.filter(item=>item.kind==='user').length,10+(i-9)%6);
  assert.equal(visible.timeline[0].kind,'user');assert.equal(visible.timeline.at(-1).itemId,'answer-'+i);
 }
 assert.deepEqual(starts,[0,0,0,0,0,12,12,12,12,12]);
 assert.equal(canonical.timeline.length,40,'view reclamation never removes archived QAs');
 const burst={kind:'patch',conversationId:'long',generation:1,baseRevision:canonical.revision,revision:canonical.revision+1,changes:[20,21,22,23].flatMap(i=>qa(i).map(item=>({kind:'item-appended',item})))};
 canonical=applyFlowChange(canonical,burst).snapshot;
 visible=applyFlowChange(visible,project({type:'flow',id:'long',change:burst}).change).snapshot;
 assert.equal(visible.timeline.filter(item=>item.kind==='user').length,10,'a burst from 14 to 18 retained QAs reclaims eight, not five');
 assert.equal(visible.timeline[0].id,'input-14');
});
test('history reads and commands run concurrently without cancelling each other',async t=>{
 let signal,release,reads=0,commands=0,receive;
 const client=createConversation({scope:{environmentId:'test',conversationId:'long'},transport:{
  async fetchSnapshot(){reads++;return projectFlowWindow(full);},
  subscribe(_scope,onChange,_offline,online){receive=onChange;onChange({kind:'snapshot',snapshot:projectFlowWindow(full),epoch:'boot'});online();return()=>{};},
  fetchHistory(_scope,cursor,context){signal=context.signal;return new Promise(resolve=>release=()=>resolve(flowHistoryPage(full,cursor)));},
  async command(){commands++;return {ok:true};}
 }});t.after(()=>client.dispose());await client.start();const history=client.loadHistory();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(client.getSnapshot().history.loading,true);assert.equal(client.getSnapshot().history.total,full.timeline.length);assert.equal((await client.sendCommand({type:'resumeQueue'})).ok,true);assert.equal(signal.aborted,false);release();await history;
 assert.equal(client.getSnapshot().history.total,full.timeline.length,'backfill changes retained rows, not the canonical total');
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
 await client.flushSnapshot();assert.ok(saved.at(-1).timeline.length<snapshot.timeline.length);assert.equal(saved.at(-1).timeline.length,10);
});
test('replica applies the rewind patch that advances generation by one',()=>{
 const base={...full,timeline:full.timeline.slice(0,2)};
 const meta={phase:'idle',activeRunId:null,awaitingUser:null,queuePaused:false,generation:2};
 const change={kind:'patch',conversationId:'long',generation:2,baseRevision:1,revision:2,changes:[{kind:'multi',changes:[{kind:'meta',meta},{kind:'timeline',timeline:[]}]}]};
 const applied=applyFlowChange(base,change);assert.equal(applied.ok,true);assert.equal(applied.snapshot.generation,2);assert.equal(applied.snapshot.timeline.length,0);
 assert.equal(applyFlowChange(base,{...change,changes:[{kind:'timeline',timeline:[]}]}).code,'stale');
 assert.equal(applyFlowChange(base,{...change,generation:3,changes:[{kind:'meta',meta:{...meta,generation:3}}]}).code,'stale');
});
