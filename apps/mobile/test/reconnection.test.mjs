import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBotHost} from '../../../src/main/bot/host.mjs';
import {moduleUnderTest} from '../../../packages/conversation-flow/test/compile.mjs';

const {createBotWorkspace} = await moduleUnderTest('../../../apps/mobile/test/workspace-test-api.ts');
const wait = async predicate => {
  const until = Date.now() + 2000;
  while (!await predicate()) {assert.ok(Date.now() < until, 'reconnection timed out'); await new Promise(resolve => setTimeout(resolve, 10));}
};

test('manual recovery replaces a hanging catalog read without waiting for events or old replies', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-reconnect-button-'));
  const host = await createBotHost({dataDir: path.join(root, 'data'), defaultDir: path.join(root, 'work'),
    executorFactory: () => ({async run() {throw new Error('Recovery must not execute a run');}, async stop() {}, async close() {}})});
  t.after(async () => {await host.close(); await fs.rm(root, {recursive: true, force: true});});
  const {instanceId} = await host.request('handshake');
  const stale = await host.request('snapshot', {instanceId});
  let hold = false, finishOld, reads = 0;
  const values = new Map();
  const workspace = createBotWorkspace({rpc: {request(method, params) {
    if (method === 'snapshot') {
      reads++;
      if (hold) return new Promise(resolve => {finishOld = resolve;});
    }
    return host.request(method, params);
  }}, target: {endpoint: 'https://fixture.invalid', botInstanceId: instanceId, name: 'Test Bot'},
  storage: {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)}});
  t.after(() => {finishOld?.(stale); workspace.dispose();});
  await workspace.reconnect();
  hold = true;
  const old = workspace.reconnect();
  await wait(() => !!finishOld);
  hold = false;
  const recovered = workspace.reconnect();
  await wait(() => reads === 3);
  await recovered;
  finishOld({...stale, defaultDir: '/stale-read'});
  await old;
  assert.equal(workspace.getSnapshot().offline, false);
  assert.notEqual(workspace.getSnapshot().defaultDirectory, '/stale-read');
});

test('metadata failures cannot overwrite a live connection or duplicate its initial flow', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-live-metadata-'));
  const host=await createBotHost({dataDir:path.join(root,'data'),defaultDir:path.join(root,'work'),validateModel:async()=>{},executorFactory:()=>({async run(){return{}},async stop(){},async close(){}})});
  t.after(async()=>{await host.close();await fs.rm(root,{recursive:true,force:true})});
  const {instanceId}=await host.request('handshake');
  const call=(method,params={})=>host.request(method,{instanceId,requestId:randomUUID(),...params});
  await call('model.sync',{models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'fake',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'TEST_ONLY'}]});
  const {id}=await call('session.create');let hold=false,fail=false,rejectPoll;const reads=[];
  const rpc={request(method,params){reads.push({method,params});if(method==='snapshot'&&hold)return new Promise((_resolve,reject)=>{rejectPoll=reject});if(method==='snapshot'&&fail)return Promise.reject(new Error('Metadata unavailable'));return host.request(method,params);},watch:(...args)=>host.watch(...args)};
  const values=new Map(),workspace=createBotWorkspace({rpc,target:{endpoint:'https://fixture.invalid',botInstanceId:instanceId,name:'Fixture'},storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}});
  t.after(()=>workspace.dispose());const release=workspace.retain();t.after(release);
  await workspace.reconnect();const client=workspace.getClient(id),releaseClient=client.retain();t.after(releaseClient);
  await wait(()=>client.getSnapshot().connection==='online');
  assert.equal(reads.filter(x=>x.method==='flow.snapshot').length,0,'the stream supplies the only initial flow');
  hold=true;workspace.select(id);await wait(()=>!!rejectPoll);
  assert.equal(reads.at(-1).params.detail,'metadata');
  await workspace.reconnect();assert.equal(workspace.getSnapshot().offline,false);
  hold=false;rejectPoll(new Error('Superseded metadata read failed'));await new Promise(r=>setTimeout(r,30));
  assert.equal(workspace.getSnapshot().offline,false);
  fail=true;await call('session.rename',{id,title:'Live rename'});await new Promise(r=>setTimeout(r,150));
  assert.equal(workspace.getSnapshot().offline,false,'an RPC failure cannot turn a live stream offline');
  assert.equal(client.getSnapshot().connection,'online');
});

test('catalog quota failures cannot reject acknowledged control changes or live readiness',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-catalog-quota-'));
 const host=await createBotHost({dataDir:path.join(root,'data'),defaultDir:path.join(root,'work'),validateModel:async()=>{},executorFactory:()=>({async run(){return{};},async stop(){},async close(){}})});
 t.after(async()=>{await host.close();await fs.rm(root,{recursive:true,force:true});});
 const {instanceId}=await host.request('handshake');await host.request('model.sync',{instanceId,requestId:randomUUID(),models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'fake',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'TEST_ONLY'}]});
 const {id}=await host.request('session.create',{instanceId,requestId:randomUUID()});const values=new Map();
 const workspace=createBotWorkspace({target:{endpoint:'https://fixture.invalid',botInstanceId:instanceId,name:'Quota fixture'},rpc:{request:(method,params)=>host.request(method,params),watch:(...args)=>host.watch(...args)},storage:{getItem:key=>values.get(key)??null,setItem(key,value){if(key.endsWith(':catalog'))throw new DOMException('The quota has been exceeded.','QuotaExceededError');values.set(key,value);},removeItem:key=>values.delete(key)}});
 t.after(()=>workspace.dispose());const release=workspace.retain();t.after(release);await workspace.reconnect();
 const client=workspace.getClient(id),releaseClient=client.retain();t.after(releaseClient);await wait(()=>client.getSnapshot().connection==='online');
 assert.equal(workspace.getSnapshot().offline,false);assert.equal(await workspace.acquireControl(id),true);assert.equal(workspace.getSnapshot().offline,false);assert.ok(workspace.getSnapshot().items.find(x=>x.id===id).control);assert.equal(workspace.getSnapshot().error,'');
});
