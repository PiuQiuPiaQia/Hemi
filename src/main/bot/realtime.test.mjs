import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBotHost} from './host.mjs';
import {createBotEventStream} from './event-stream.mjs';
import {createBotDesktopService} from './desktop-service.mjs';

const wait=async predicate=>{const end=Date.now()+3000;while(!await predicate()){assert.ok(Date.now()<end,'condition timed out');await new Promise(r=>setTimeout(r,10));}};
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-realtime-')), runs=[], live=new Map();let clock=Date.now();
  const options={dataDir:path.join(root,'data'),defaultDir:path.join(root,'workspace'),validateModel:async()=>{},now:()=>clock,executorFactory:()=>({
    run(spec,apply){runs.push(spec);return new Promise(resolve=>live.set(spec.conversationId,{spec,apply,resolve}));},
    async stop(id){live.get(id)?.resolve({stopped:true});},decide:()=>true,async close(){for(const item of live.values())item.resolve({stopped:true});},
  })};
  let host=await createBotHost(options);const {instanceId}=await host.request('handshake');
  const request=(owner,method,p={})=>host.request(method,{instanceId,requestId:randomUUID(),...p},{clientId:owner});
  await request('pc','model.sync',{source:'manual',models:[{modelKey:'f/m',providerId:'f',name:'Fixture',model:'fake',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'TEST_ONLY'}]});
  const {id}=await request('pc','session.create');
  t.after(async()=>{await host.close();await fs.rm(root,{recursive:true,force:true});});
  const command=(owner,cmd,p={})=>request(owner,'flow.command',{id,command:cmd,...p});
  return {request,command,id,instanceId,runs,live,get host(){return host;},advance(ms){clock+=ms;},async restart(){await host.close();host=await createBotHost(options);}};
}

test('bounded event replay has no subscription gap; old process/scope/expired cursors get snapshots',()=>{
  let value=0;const stream=createBotEventStream({instanceId:'bot',snapshot:id=>({id,value}),maxEntries:2});
  const first=[];let release=stream.subscribe({instanceId:'bot',id:'a'},frame=>first.push(frame));
  assert.equal(first[0].type,'reset');const cursor={...first.at(-1),id:'a'};release();
  value++;stream.publish({type:'catalog'});
  const replay=[];release=stream.subscribe({instanceId:'bot',id:'a',cursor},frame=>replay.push(frame));
  assert.deepEqual(replay.map(f=>f.type),['catalog','ready']);release();
  stream.publish({type:'catalog'});stream.publish({type:'catalog'});
  const expired=[];stream.subscribe({instanceId:'bot',id:'a',cursor},frame=>expired.push(frame))();assert.equal(expired[0].type,'reset');
  const wrong=[];stream.subscribe({instanceId:'bot',id:'b',cursor:{...stream.cursor(),id:'a'}},frame=>wrong.push(frame))();assert.equal(wrong[0].type,'reset');
  assert.throws(()=>stream.subscribe({instanceId:'other'},()=>{}),/身份/);
  assert.doesNotThrow(()=>{stream.subscribe({instanceId:'bot'},()=>{throw new Error('slow');});stream.publish({type:'catalog'});});
});

test('two devices append concurrently once, share streamed output and reject edit/reorder/stop conflicts',async t=>{
  const f=await fixture(t),pc=[],phone=[];
  const release=f.host.watch({instanceId:f.instanceId,id:f.id},frame=>pc.push(frame),undefined,{clientId:'pc'});
  const stop=f.host.watch({instanceId:f.instanceId,id:f.id},frame=>phone.push(frame),undefined,{clientId:'phone'});t.after(release);t.after(stop);
  const send=(inputId,text)=>({type:'send',input:{inputId,text}});
  const operation=randomUUID();
  await Promise.all([f.command('pc',send('a','电脑')),f.command('phone',send('b','手机'),{requestId:operation}),f.command('pc',send('c','再排一条'))]);
  await wait(()=>f.runs.length===1);
  let snapshot=await f.request('pc','flow.snapshot',{id:f.id});assert.deepEqual(snapshot.pending.map(i=>i.inputId),['b','c']);
  assert.equal((await f.command('phone',send('b','手机'),{requestId:operation})).ok,true);
  assert.equal((await f.request('pc','flow.snapshot',{id:f.id})).pending.length,2);
  const running=f.live.get(f.id);running.apply({type:'part-appended',runId:running.spec.runId,generation:running.spec.generation,part:{partId:'text',kind:'text',content:'开始'}});
  running.apply({type:'part-updated',runId:running.spec.runId,generation:running.spec.generation,partId:'text',patch:{content:'实时输出🙂'}});
  await wait(()=>pc.some(f=>f.type==='flow'&&JSON.stringify(f.change).includes('实时输出🙂')));
  assert.deepEqual(pc.filter(f=>f.type==='flow'),phone.filter(f=>f.type==='flow'));
  assert.equal((await f.command('pc',{type:'beginEditInput',inputId:'b',expectedEditRevision:0})).ok,true);
  assert.equal((await f.command('phone',{type:'beginEditInput',inputId:'b',expectedEditRevision:0})).code,'locked');
  assert.equal((await f.command('phone',{type:'finishEditInput',inputId:'b',expectedEditRevision:0,patch:{text:'覆盖'}})).code,'locked');
  await f.command('pc',{type:'finishEditInput',inputId:'b',expectedEditRevision:0,patch:{text:'电脑改过'}});
  assert.equal((await f.command('phone',{type:'updateInput',inputId:'b',expectedEditRevision:0,patch:{text:'旧修改'}})).code,'stale-input');
  await f.command('pc',{type:'reorderInput',inputId:'c',overInputId:'b',expectedInputIds:['b','c']});
  assert.equal((await f.command('phone',{type:'reorderInput',inputId:'b',overInputId:'c',expectedInputIds:['b','c']})).code,'stale-queue');
  await f.command('pc',{type:'stop',targetRunId:running.spec.runId});await wait(async()=>(await f.request('pc','flow.snapshot',{id:f.id})).phase==='idle');
  assert.equal((await f.command('phone',{type:'stop',targetRunId:running.spec.runId})).code,'run-changed');
  assert.equal((await f.command('phone',{type:'send',input:{inputId:'stale',text:'旧分支'}},{generation:99})).code,'conflict');
});

test('disconnected editor releases with draft preserved and queue paused; reconnect/restart recover without replay',async t=>{
  const f=await fixture(t);await f.command('pc',{type:'send',input:{inputId:'first',text:'运行'}});await wait(()=>f.runs.length===1);
  await f.command('pc',{type:'send',input:{inputId:'queued',text:'原文'}});
  const frames=[],release=f.host.watch({instanceId:f.instanceId,id:f.id},frame=>frames.push(frame),undefined,{clientId:'pc'});
  await f.command('pc',{type:'beginEditInput',inputId:'queued'});await f.command('pc',{type:'saveInputEditDraft',inputId:'queued',draftRevision:1,patch:{text:'未提交修改'}});
  const cursor={...frames.at(-1),id:f.id};release();f.advance(61000);await f.host.expireEditLeases();
  const snapshot=await f.request('phone','flow.snapshot',{id:f.id});assert.equal(snapshot.queuePaused,true);assert.equal(snapshot.pending[0].state,'pending');assert.equal(snapshot.pending[0].editDraft.text,'未提交修改');
  const recovered=[];f.host.watch({instanceId:f.instanceId,id:f.id,cursor},frame=>recovered.push(frame))();assert.equal(recovered[0].type,'flow');
  assert.equal((await f.command('pc',{type:'finishEditInput',inputId:'queued',patch:{text:'过期覆盖'}})).code,'stale-input');
  await f.restart();const reboot=[];f.host.watch({instanceId:f.instanceId,id:f.id,cursor},frame=>reboot.push(frame))();assert.equal(reboot[0].type,'reset');assert.equal(f.runs.length,1);
});

test('desktop reconnects the event stream promptly and does not let an older snapshot replace newer output',async t=>{
  const f=await fixture(t),profile=path.join(os.tmpdir(),'hemi-live-desktop-'+randomUUID());
  await fs.mkdir(path.join(profile,'bot'),{recursive:true});
  await fs.writeFile(path.join(profile,'bot/connection.json'),JSON.stringify({host:'fixture',instanceId:f.instanceId}));
  let cut,connections=0,staleSnapshot;
  const transport={
    rpc:async(_host,method,params,options)=>{
      const snapshot=await f.host.request(method,staleSnapshot&&method==='snapshot'?{...params,revision:-1}:params,{clientId:options.clientId});
      if(method==='snapshot'&&staleSnapshot){const gate=staleSnapshot;staleSnapshot=null;gate.started();await gate.promise;}
      return snapshot;
    },
    watch(_host,options,{signal,onEvent,clientId}){
      connections++;
      return new Promise(resolve=>{
        const release=f.host.watch(options,onEvent,undefined,{clientId});
        cut=()=>{release();resolve();};signal.addEventListener('abort',cut,{once:true});
      });
    },
  };
  const desktop=createBotDesktopService({userDataDir:profile,runner:{},profiles:{list:async()=>({providers:[]})},transport});
  t.after(async()=>{await desktop.close();await fs.rm(profile,{recursive:true,force:true});});
  await desktop.refresh();await wait(()=>connections===1);
  await f.command('phone',{type:'send',input:{inputId:'run',text:'运行'}});await wait(()=>f.runs.length===1);
  const run=f.live.get(f.id),apply=(type,p)=>run.apply({type,runId:run.spec.runId,generation:run.spec.generation,...p});
  apply('part-appended',{part:{partId:'text',kind:'text',content:'最初'}});
  await wait(()=>JSON.stringify(desktop.getState().cache.details[f.id].flow).includes('最初'));
  cut();apply('part-updated',{partId:'text',patch:{content:'断线更新'}});
  await wait(()=>connections>=2&&JSON.stringify(desktop.getState().cache.details[f.id].flow).includes('断线更新'));
  let started,release;const captured=new Promise(resolve=>started=resolve),promise=new Promise(resolve=>release=resolve);
  staleSnapshot={started,promise};const pending=desktop.refresh();await captured;
  apply('part-updated',{partId:'text',patch:{content:'不能被旧快照覆盖'}});
  await wait(()=>JSON.stringify(desktop.getState().cache.details[f.id].flow).includes('不能被旧快照覆盖'));
  release();await pending;
  assert.ok(JSON.stringify(desktop.getState().cache.details[f.id].flow).includes('不能被旧快照覆盖'));
});
