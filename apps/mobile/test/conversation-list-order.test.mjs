import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBotHost} from '../../../src/main/bot/host.mjs';
import {moduleUnderTest} from '../../../packages/conversation-flow/test/compile.mjs';

const {createBotWorkspace} = await moduleUnderTest('../../../apps/mobile/test/workspace-test-api.ts');
const wait = async read => {
  const end=Date.now()+4000;
  while(!await read()){assert.ok(Date.now()<end,'mobile list update timed out');await new Promise(resolve=>setTimeout(resolve,10));}
};

test('mobile refreshes order from Host timestamps only on selection, including cached restore and pinned sessions',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-mobile-order-')),dataDir=path.join(root,'data'),live=new Map();
  const options={dataDir,defaultDir:path.join(root,'workspace'),validateModel:async()=>{},executorFactory:()=>({
    run(spec,apply){return new Promise(resolve=>live.set(spec.conversationId,{spec,apply,resolve}));},
    async stop(id){live.get(id)?.resolve({stopped:true});},async close(){for(const run of live.values())run.resolve({stopped:true});},
  })};
  let host=await createBotHost(options),instanceId=(await host.request('handshake')).instanceId;
  const call=(method,params={})=>host.request(method,{instanceId,requestId:randomUUID(),...params},{clientId:'fixture-pc'});
  t.after(async()=>{await host.close();await fs.rm(root,{recursive:true,force:true});});
  await call('model.sync',{models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'fixture',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'TEST_ONLY'}]});
  const ids=[];for(let i=0;i<4;i++)ids.push((await call('session.create')).id);
  const [newest,middle,old,pinned]=ids;
  await host.close();
  const file=path.join(dataDir,'state.json'),seed=JSON.parse(await fs.readFile(file,'utf8')),now=Date.now();
  for(const [index,id] of ids.entries())seed.sessions[id].updatedAt=now-[1000,2*86400000,5*86400000,7*86400000][index];
  seed.sessions[pinned].pinned=true;seed.order=[pinned,newest,middle,old];
  await fs.writeFile(file,JSON.stringify(seed));host=await createBotHost(options);
  const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  const makeWorkspace=()=>createBotWorkspace({target:{endpoint:'https://fixture.invalid',botInstanceId:instanceId,name:'Order fixture'},rpc:{request:(method,params)=>host.request(method,params,{clientId:'fixture-mobile'}),watch:(...args)=>host.watch(...args)},storage});
  const workspace=makeWorkspace();t.after(()=>workspace.dispose());const release=workspace.retain();t.after(release);await workspace.reconnect();
  const order=()=>workspace.getSnapshot().items.map(item=>item.id);
  const time=id=>workspace.getSnapshot().items.find(item=>item.id===id).updatedAt;
  assert.deepEqual(order(),seed.order);assert.equal(time(old),seed.sessions[old].updatedAt);assert.equal(workspace.getSnapshot().items[0].pinned,true);
  workspace.select(old);assert.deepEqual(order(),seed.order,'opening an unchanged old chat does not promote it');

  const start=async id=>{await call('flow.command',{id,command:{type:'send',input:{inputId:randomUUID(),text:'Held list verification'}}});await wait(()=>live.has(id));};
  await start(old);await wait(()=>workspace.getSnapshot().items.find(item=>item.id===old).running);
  const current=live.get(old);
  current.apply({type:'part-appended',runId:current.spec.runId,generation:current.spec.generation,part:{kind:'text',partId:'output',content:'Streaming output'}});
  await wait(async()=>(await call('session.open',{id:old,activate:false})).updatedAt>seed.sessions[old].updatedAt);
  await new Promise(resolve=>setTimeout(resolve,80));assert.deepEqual(order(),seed.order);assert.equal(time(old),seed.sessions[old].updatedAt);
  await start(newest);await new Promise(resolve=>setTimeout(resolve,80));
  const oldTime=(await call('session.open',{id:old,activate:false})).updatedAt;
  assert.ok((await call('session.open',{id:newest,activate:false})).updatedAt>oldTime);
  workspace.select(old);assert.deepEqual(order(),[pinned,newest,old,middle]);assert.equal(time(old),oldTime);
  assert.equal((await call('session.open',{id:old,activate:false})).updatedAt,oldTime,'selection never stamps the current time');

  current.resolve({});await wait(()=>workspace.getSnapshot().items.find(item=>item.id===old).status===null);
  assert.deepEqual(order(),[pinned,newest,old,middle],'completion cannot move the row');
  workspace.select(middle);assert.deepEqual(order(),[pinned,old,newest,middle],'next selection applies the latest real timestamp to all rows');
  const savedOrder=order();release();workspace.dispose();
  const restored=makeWorkspace();t.after(()=>restored.dispose());assert.deepEqual(restored.getSnapshot().items.map(item=>item.id),savedOrder);
  await restored.reconnect();assert.deepEqual(restored.getSnapshot().items.map(item=>item.id),savedOrder,'metadata restore keeps the saved display order');
});
