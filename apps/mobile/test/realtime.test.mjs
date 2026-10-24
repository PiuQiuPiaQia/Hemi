import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBotHost} from '../../../src/main/bot/host.mjs';
import {moduleUnderTest} from '../../../packages/conversation-flow/test/compile.mjs';
const {createBotWorkspace,BotCommandRejected}=await moduleUnderTest('../../../apps/mobile/test/workspace-test-api.ts');
const wait=async predicate=>{const end=Date.now()+4000;while(!await predicate()){assert.ok(Date.now()<end,'mobile realtime timed out');await new Promise(r=>setTimeout(r,10));}};

test('two actual workspace clients share queue/output, reconcile a lost receipt and resume one multiplexed stream',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-mobile-live-')),runs=[],live=new Map();
  const host=await createBotHost({dataDir:path.join(root,'data'),defaultDir:path.join(root,'workspace'),validateModel:async()=>{},executorFactory:()=>({
    run(spec,apply){runs.push(spec);return new Promise(resolve=>live.set(spec.conversationId,{spec,apply,resolve}));},async stop(id){live.get(id)?.resolve({stopped:true});},async close(){for(const run of live.values())run.resolve({stopped:true});},
  })});
  const {instanceId}=await host.request('handshake'),call=(method,p={})=>host.request(method,{instanceId,requestId:randomUUID(),...p});
  await call('model.sync',{models:[{modelKey:'f/m',providerId:'f',name:'Fixture',model:'fake',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'TEST_ONLY'}]});
  const {id}=await call('session.create'),workspaces=[];t.after(async()=>{for(const workspace of workspaces)workspace.dispose();await host.close();await fs.rm(root,{recursive:true,force:true});});
  function device(owner){
    let network=true,drop=false,active=0,maximum=0,disconnect,release;const methods=[];
    const rpc={async request(method,p){methods.push(method);if(!network)throw new Error('offline');let result;try{result=await host.request(method,p,{clientId:owner});}catch(error){throw new BotCommandRejected(error.code,error.message);}if(drop&&method==='flow.command'){drop=false;throw new Error('lost receipt');}return result;},
      watch(options,receive,offline){active++;maximum=Math.max(maximum,active);disconnect=offline;let stopped=false;release=host.watch(options,receive,offline,{clientId:owner});return()=>{if(stopped)return;stopped=true;active--;release?.();};},
    };
    const values=new Map(),workspace=createBotWorkspace({rpc,target:{endpoint:'https://fixture.invalid',botInstanceId:instanceId,name:owner},storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}});workspaces.push(workspace);
    return {workspace,methods,get maximum(){return maximum;},lostReply(){drop=true;},disconnect(){network=false;release?.();disconnect?.();},online(){network=true;},};
  }
  const pc=device('pc'),phone=device('phone');
  const releasePC=pc.workspace.retain(),releasePhone=phone.workspace.retain();t.after(releasePC);t.after(releasePhone);
  await Promise.all([pc.workspace.reconnect(),phone.workspace.reconnect()]);
  const a=pc.workspace.getClient(id),b=phone.workspace.getClient(id);const releaseA=a.retain(),releaseB=b.retain();t.after(releaseA);t.after(releaseB);
  await wait(()=>a.getSnapshot().connection==='online'&&b.getSnapshot().connection==='online');
  a.draft.setText('电脑发起');await a.sendDraft();await wait(()=>runs.length===1);
  b.draft.setText('手机排队');await b.sendDraft();await wait(()=>a.getSnapshot().snapshot.pending.some(item=>item.text==='手机排队'));
  phone.lostReply();b.draft.setText('回执丢失');await b.sendDraft();b.draft.setText('后写草稿');
  await wait(()=>b.getSnapshot().operations.every(op=>op.state==='accepted'));assert.equal(b.draft.getSnapshot().text,'后写草稿');
  assert.equal(phone.methods.filter(method=>method==='flow.command').length,2);
  const run=live.get(id);run.apply({type:'part-appended',runId:run.spec.runId,generation:run.spec.generation,part:{partId:'text',kind:'text',content:'双端输出'}});
  await wait(()=>JSON.stringify(a.getSnapshot().snapshot.timeline).includes('双端输出')&&JSON.stringify(b.getSnapshot().snapshot.timeline).includes('双端输出'));
  phone.disconnect();run.apply({type:'part-updated',runId:run.spec.runId,generation:run.spec.generation,partId:'text',patch:{content:'掉线期间输出'}});phone.online();
  await wait(()=>JSON.stringify(b.getSnapshot().snapshot.timeline).includes('掉线期间输出'));
  assert.equal((await call('flow.snapshot',{id})).pending.length,2);assert.equal(phone.maximum,1);assert.equal(pc.maximum,1);
});
