import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBotHost} from '../../../src/main/bot/host.mjs';
import {moduleUnderTest} from '../../../packages/conversation-flow/test/compile.mjs';
const {createBotWorkspace,BotCommandRejected}=await moduleUnderTest('../../../apps/mobile/test/workspace-test-api.ts');
const wait=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('conversation action timed out');};

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-mobile-actions-')),dataDir=path.join(root,'data');
  const live=new Map(),stopped=[],calls=[],values=new Map();
  const host=await createBotHost({dataDir,defaultDir:path.join(root,'work'),validateModel:async()=>{},executorFactory:()=>({
    run(spec){return new Promise(resolve=>live.set(spec.conversationId,resolve));},
    async stop(id){stopped.push(id);live.get(id)?.({stopped:true});},
    async close(){for(const resolve of live.values())resolve({stopped:true});},
  })});
  const {instanceId}=await host.request('handshake');
  const call=(method,params={})=>host.request(method,{instanceId,requestId:randomUUID(),...params});
  await call('model.sync',{models:[{modelKey:'fixture/model',providerId:'fixture',name:'Synthetic',model:'fixture',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'SYNTHETIC_ONLY'}]});
  const {id}=await call('session.create'),other=(await call('session.create')).id;
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  const target={endpoint:'https://127.0.0.1:29421',botInstanceId:instanceId,name:'Actions Bot'};
  const faults={offline:false,drop:'',disconnect:false,hold:null,reject:false};
  const rpc={async request(method,params,{signal}){
    signal.throwIfAborted();if(faults.offline)throw Error('Network offline');calls.push({method,params});
    if(faults.hold&&method==='session.rename')await faults.hold;
    if(faults.reject&&method==='session.rename'){faults.reject=false;throw new BotCommandRejected('failed','ISOLATED_REJECTION');}
    let result;try{result=await host.request(method,params);}catch(error){throw new BotCommandRejected(error.code??'failed',error.message);}
    if(faults.drop===method){faults.drop='';if(faults.disconnect)faults.offline=true;throw Error('Lost action reply');}return result;
  }};
  let workspace;
  const reload=async()=>{workspace?.dispose();workspace=createBotWorkspace({rpc,target,storage});await workspace.reconnect();return workspace;};
  t.after(async()=>{workspace?.dispose();await host.close();await fs.rm(root,{recursive:true,force:true});});
  return{host,call,id,other,values,live,stopped,calls,faults,reload,cache:`hemi-mobile:bot:${instanceId}:`,dataDir};
}

test('rename uses the clicked Host session, preserves selection/drafts and reconciles a lost reply once',async t=>{
  const f=await fixture(t),workspace=await f.reload();workspace.select(f.id);
  const client=workspace.getClient(f.id);await client.start();client.draft.setText('保留当前草稿');await client.flushDraft();
  f.faults.drop='session.rename';await workspace.rename(f.other,'  新名称  ');
  assert.equal((await f.call('session.open',{id:f.other})).title,'新名称');
  assert.equal(workspace.getSnapshot().activeId,f.id);assert.equal(client.draft.getSnapshot().text,'保留当前草稿');
  assert.equal(f.calls.filter(item=>item.method==='session.rename').length,1);assert.ok(f.calls.some(item=>item.method==='operation.get'));
  assert.equal(f.values.has(f.cache+'manage:'+f.other),false);
  await assert.rejects(workspace.rename(f.id,'  '),/请输入/);
  const restored=await f.reload();assert.equal(restored.getSnapshot().items.find(item=>item.id===f.other).title,'新名称');
  const cached=restored.getClient(f.id);await cached.start();assert.equal(cached.draft.getSnapshot().text,'保留当前草稿');
});

test('confirmed deletion stops the actual run, removes Host attachments and local caches, and selects the next session',async t=>{
  const f=await fixture(t),workspace=await f.reload();workspace.select(f.id);
  const client=workspace.getClient(f.id);await client.start();
  await f.call('attachment.add',{id:f.id,name:'fixture.txt',base64:Buffer.from('isolated attachment').toString('base64')});
  client.draft.setText('运行中删除');assert.equal((await client.sendDraft()).ok,true);await wait(()=>f.live.has(f.id));
  client.draft.setText('删除时应移除的草稿');await client.flushDraft();
  assert.ok([...f.values.keys()].some(key=>key.startsWith(f.cache+f.id+':')));
  await workspace.remove(f.id);assert.ok(f.stopped.includes(f.id));assert.equal(workspace.getSnapshot().activeId,f.other);
  await assert.rejects(f.call('session.open',{id:f.id}),/找不到|不存在/);
  await assert.rejects(fs.access(path.join(f.dataDir,'attachments',f.id)));
  client.dispose();await new Promise(resolve=>setTimeout(resolve,30));
  assert.ok(![...f.values.keys()].some(key=>key.startsWith(f.cache+f.id+':')),'late dispose must not restore deleted caches');
  assert.throws(()=>workspace.getClient(f.id),/已删除/);
  const restored=await f.reload();assert.deepEqual(restored.getSnapshot().items.map(item=>item.id),[f.other]);
  await restored.remove(f.other);assert.equal(restored.getSnapshot().activeId,null);assert.deepEqual(restored.getSnapshot().items,[]);
});

test('unknown management receipt survives reload; explicit retry resolves original identity without replay',async t=>{
  const f=await fixture(t);let workspace=await f.reload();workspace.select(f.id);
  f.faults.drop='session.remove';f.faults.disconnect=true;
  await assert.rejects(workspace.remove(f.other),/结果待核对/);
  assert.ok(f.values.has(f.cache+'manage:'+f.other));assert.equal(workspace.getSnapshot().activeId,f.id);
  const count=f.calls.filter(item=>item.method==='session.remove').length;
  f.faults.offline=false;workspace=await f.reload();assert.ok(!workspace.getSnapshot().items.some(item=>item.id===f.other));
  await workspace.remove(f.other);
  assert.equal(f.calls.filter(item=>item.method==='session.remove').length,count);
  assert.equal(f.values.has(f.cache+'manage:'+f.other),false);assert.equal(workspace.getSnapshot().activeId,f.id);
});

test('offline and duplicate operations are blocked; a definite rejection can be retried',async t=>{
  const f=await fixture(t),workspace=await f.reload();f.faults.offline=true;await workspace.reconnect();
  const before=f.calls.length;await assert.rejects(workspace.rename(f.id,'离线'),/恢复连接/);await assert.rejects(workspace.remove(f.id),/恢复连接/);assert.equal(f.calls.length,before);
  f.faults.offline=false;await workspace.reconnect();let release;f.faults.hold=new Promise(resolve=>{release=resolve;});
  const pending=workspace.rename(f.id,'等待中');await wait(()=>f.calls.some(item=>item.method==='session.rename'));
  await assert.rejects(workspace.rename(f.id,'重复'),/正在进行/);release();await pending;f.faults.hold=null;
  f.faults.reject=true;await assert.rejects(workspace.rename(f.id,'失败'),/ISOLATED_REJECTION/);assert.equal(f.values.has(f.cache+'manage:'+f.id),false);
  await workspace.rename(f.id,'重试成功');assert.equal((await f.call('session.open',{id:f.id})).title,'重试成功');
});
