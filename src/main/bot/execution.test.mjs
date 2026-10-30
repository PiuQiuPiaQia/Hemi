import {replyToGoalCheck} from '../../../scripts/lib/goal-model-fixture.mjs';
// Production Host -> shared runtime -> installed SDK -> real HTTP and POSIX tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createBotHost} from './host.mjs';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {sharedResourceLeases} from '../agent-runtime/resource-leases.mjs';

async function until(read) {
  const end=Date.now()+12000;
  for (;;) {const value=await read();if(value)return value;assert.ok(Date.now()<end,'execution condition timed out');await new Promise(resolve=>setTimeout(resolve,15));}
}
function reply(res,{text='DONE',command,tool='bash'}={}) {
  if(res.destroyed)return;
  res.writeHead(200,{'content-type':'text/event-stream'});
  const delta=command ? {role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:tool,arguments:JSON.stringify(command)}}]} : {role:'assistant',content:text};
  for(const [content,finish] of [[delta,null],[{},command?'tool_calls':'stop']])res.write('data: '+JSON.stringify({id:randomUUID(),model:'fixture',choices:[{index:0,delta:content,finish_reason:finish}],...(finish?{usage:{prompt_tokens:20,completion_tokens:10}}:{})})+'\n\n');
  res.end('data: [DONE]\n\n');
}
async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-shared-execution-'))),held=new Map(),requests=[];
  const first=path.join(root,'workspace'),other=path.join(root,'other');await fs.mkdir(first);await fs.mkdir(other);
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);if(replyToGoalCheck(body,res))return;const text=JSON.stringify(body.messages);requests.push(body);
    const lastUser=JSON.stringify(body.messages.filter(message=>message.role==='user').at(-1));
    if(lastUser?.includes('HOLD_MODEL')){held.set(lastUser.match(/HOLD_MODEL_(\w+)/)[1].toLowerCase(),res);return;}
    const toolCalled=body.messages.some(message=>message.role==='tool');
    if(text.includes('BLOCK_SHELL')&&!toolCalled){reply(res,{command:{command:'printf started > a.started; while [ ! -f release ]; do sleep 0.02; done; printf A_DONE',run_in_background:true,yield_ms:20}});return;}
    if(text.includes('WRITE_FILE')&&!toolCalled){reply(res,{command:{command:'printf actual > '+(text.includes('WRITE_FILE_E')?'e.done':text.includes('WRITE_FILE_C')?'c.done':'b.done')}});return;}
    if(text.includes('READ_SHARED_FILE')&&!toolCalled){reply(res,{tool:'read',command:{path:'input.txt'}});return;}
    if(text.includes('WRITE_SHARED_FILE')&&!toolCalled){reply(res,{tool:'write',command:{path:'native.done',content:'native write completed'}});return;}
    if(text.includes('ASK_PERMISSION')&&!toolCalled){reply(res,{command:{command:`rm -rf -- '${path.join(root,'outside.txt')}'`}});return;}
    reply(res,{text:text.includes('BLOCK_SHELL')&&!text.includes('［后台命令完成')?'AWAIT_BACKGROUND':'DONE'});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const host=await createBotHost({dataDir:path.join(root,'data'),defaultDir:first,allowLoopbackModels:true,validateModel:async()=>{}});
  t.after(async()=>{await host.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const {instanceId}=await host.request('handshake'),call=(method,p={})=>host.request(method,{instanceId,requestId:randomUUID(),...p});
  await call('model.sync',{models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'fixture',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'SYNTHETIC_ONLY'}]});
  const create=async(dir=first)=>{const {id}=await call('session.create');if(dir!==first)await call('session.update',{id,dir});return id;};
  const send=(id,text)=>call('flow.command',{id,command:{type:'send',input:{inputId:randomUUID(),text}}});
  const detail=id=>call('session.open',{id,activate:false});
  const done=id=>until(async()=>{const d=await detail(id);return !d.flow.activeRunId&&d;});
  return{root,first,other,held,requests,host,call,create,send,detail,done};
}

test('independent model requests run together; stopping one does not abort another and permission waits stay scoped',{timeout:30000},async t=>{
  const f=await fixture(t),a=await f.create(),b=await f.create();
  await f.send(a,'HOLD_MODEL_A');await until(()=>f.held.has('a'));
  await f.send(b,'HOLD_MODEL_B');await until(()=>f.held.has('b'));
  assert.equal((await f.detail(a)).status,'running');assert.equal((await f.detail(b)).status,'running');
  const runId=(await f.detail(a)).flow.activeRunId;
  await f.call('flow.command',{id:a,command:{type:'stop',targetRunId:runId}});
  assert.equal((await f.done(a)).flow.runs[runId].outcome,'stopped');
  await f.send(a,'PLAIN_NEW_GOAL');await f.done(a);
  // Close inspection handles before same-process synchronous Windows commits.
  const saved=JSON.parse(readFileSync(path.join(f.root,'data/state.json'),'utf8'));
  const reference=saved.sessions[a].agent.payload;
  assert.equal(reference.storage,'pi');
  const sessionDir=path.join(f.root,'data/runtime-v2/sessions');
  const metadata=JSON.parse(readFileSync(path.join(sessionDir,'metadata',`${reference.ref}.json`),'utf8'));
  const persisted=SessionManager.open(path.join(sessionDir,'pi',metadata.native.file));
  assert.match(JSON.stringify(persisted.getEntries()),/hemi_goal_stopped/,'the common stop fact survives in the native transcript');
  const nextRequest=f.requests.find(body=>JSON.stringify(body.messages.filter(message=>message.role==='user').at(-1)).includes('PLAIN_NEW_GOAL'));
  assert.match(JSON.stringify(nextRequest.messages),/未完成部分已经取消/,'the next input receives the stop fact and cannot resume the old goal');
  assert.equal((await f.detail(b)).status,'running');assert.equal(f.held.get('b').destroyed,false);
  reply(f.held.get('b'));await f.done(b);
  const c=await f.create(),d=await f.create();await fs.writeFile(path.join(f.root,'outside.txt'),'preserve');
  await f.send(c,'ASK_PERMISSION');await until(async()=>Object.values((await f.detail(c)).permissions).some(p=>p.status==='pending'));
  await f.send(d,'PLAIN');assert.equal((await f.done(d)).flow.timeline.flatMap(item=>item.parts??[]).some(p=>p.kind==='text'&&p.content==='DONE'),true);
  const pending=Object.values((await f.detail(c)).permissions).find(p=>p.status==='pending');
  await f.call('permission.decide',{id:c,permissionId:pending.id,value:pending.options.at(-1)});await f.done(c);
  assert.equal(await fs.readFile(path.join(f.root,'outside.txt'),'utf8'),'preserve');
});

test('background shell does not block same-workspace file tools or commands, and completion still resumes its own goal',{timeout:30000,skip:process.platform==='win32'},async t=>{
  const f=await fixture(t),a=await f.create(),b=await f.create(),c=await f.create(f.other),d=await f.create(),reader=await f.create(),writer=await f.create();
  await fs.writeFile(path.join(f.first,'input.txt'),'shared readable content');
  await f.send(a,'BLOCK_SHELL');await until(()=>fs.access(path.join(f.first,'a.started')).then(()=>true,()=>false));
  await until(async()=>{const item=await f.detail(a);return item.flow.phase==='idle'&&Object.values(item.flow.runs).some(run=>run.outcome==='awaiting-background');});
  await f.send(b,'WRITE_FILE_B');await f.done(b);
  assert.equal(await fs.readFile(path.join(f.first,'b.done'),'utf8'),'actual');
  await f.send(reader,'READ_SHARED_FILE');await f.done(reader);
  assert.ok(f.requests.some(body=>JSON.stringify(body.messages.filter(message=>message.role==='user').at(-1)).includes('READ_SHARED_FILE')
    && JSON.stringify(body.messages.filter(message=>message.role==='tool')).includes('shared readable content')),'the actual read result reaches the model before the background shell exits');
  await f.send(writer,'WRITE_SHARED_FILE');await f.done(writer);
  assert.equal(await fs.readFile(path.join(f.first,'native.done'),'utf8'),'native write completed');
  await f.send(c,'WRITE_FILE_C');await f.done(c);assert.equal(await fs.readFile(path.join(f.other,'c.done'),'utf8'),'actual');
  await f.send(d,'PLAIN');await f.done(d);assert.equal((await f.detail(a)).flow.phase,'idle','the original conversation is also free while its shell runs');
  assert.equal((await f.detail(reader)).waitingResource,false);assert.equal((await f.detail(writer)).waitingResource,false);
  await fs.writeFile(path.join(f.first,'release'),'release');await until(async()=>{const flow=(await f.detail(a)).flow;return flow.phase==='idle'&&Object.values(flow.runs).some(run=>run.source==='event'&&run.outcome==='completed');});
  const completion=f.requests.filter(body=>JSON.stringify(body.messages).includes('［后台命令完成'));
  assert.equal(completion.length,1,'the background result resumes the owning goal exactly once');
  assert.match(JSON.stringify(completion[0].messages),/A_DONE/);
  const state=JSON.parse(await fs.readFile(path.join(f.root,'data/runtime-v2/run-journal.json'),'utf8').catch(async()=>{
    const files=await fs.readdir(path.join(f.root,'data/runtime-v2'));throw Error('journal files: '+files.join(','));
  }));
  assert.doesNotMatch(JSON.stringify(state),/SYNTHETIC_ONLY/);
  assert.ok(Object.values(state.observations).filter(observation=>observation.tool==='bash').every(observation=>observation.resource===null));
});

test('explicit same-file writes still wait and a stopped waiter never executes after release',{timeout:30000},async t=>{
  const f=await fixture(t),owner=await f.create(),cancelled=await f.create(),next=await f.create();
  const target=path.join(f.first,'native.done').replaceAll('\\','/');
  // Match the production gateway's case-insensitive Windows file identity.
  const scope=process.platform==='win32'?target.toLowerCase():target;
  const lease=await sharedResourceLeases.acquire({host:'local',scope:'file:'+scope,mode:'write',owner:{conversationId:owner},tool:'write'});
  t.after(()=>lease.release());
  await f.send(cancelled,'WRITE_SHARED_FILE');
  const waiting=await until(async()=>{const item=await f.detail(cancelled);return item.waitingResource&&item;});
  assert.equal(waiting.status,'queued');assert.deepEqual(waiting.blockedBy,[owner]);
  assert.equal(await fs.access(target).then(()=>true,()=>false),false);
  await f.call('flow.command',{id:cancelled,command:{type:'stop',targetRunId:waiting.flow.activeRunId}});await f.done(cancelled);
  lease.release();
  assert.equal(await fs.access(target).then(()=>true,()=>false),false);
  await f.send(next,'WRITE_SHARED_FILE');await f.done(next);
  assert.equal(await fs.readFile(target,'utf8'),'native write completed');
  const journal=JSON.parse(await fs.readFile(path.join(f.root,'data/runtime-v2/run-journal.json'),'utf8'));
  const writes=Object.values(journal.observations).filter(observation=>observation.tool==='write');
  assert.equal(writes.filter(observation=>observation.owner.conversationId===cancelled).length,0,'the cancelled waiter never begins a write');
  assert.equal(writes.filter(observation=>observation.owner.conversationId===next).length,1,'a later writer executes normally after release');
});

test('concurrent accepted conversations are never evicted while their shared runtime sessions initialize',{timeout:30000},async t=>{
  const f=await fixture(t),ids=await Promise.all(Array.from({length:10},()=>f.create()));
  await Promise.all(ids.map((id,index)=>f.send(id,'HOLD_MODEL_N'+index)));
  await until(()=>f.held.size===ids.length);
  for(const id of ids)assert.equal((await f.detail(id)).status,'running');
  for(const res of f.held.values())reply(res);
  await Promise.all(ids.map(id=>f.done(id)));
});

test('editing a completed input executes exactly one SDK/model request per replacement',{timeout:30000},async t=>{
  const f=await fixture(t),id=await f.create();
  const original=await f.send(id,'ORIGINAL_QUESTION');await f.done(id);
  let targetInputId=original.inputId;
  for(let index=1;index<=3;index++){
    const inputId='edited-input-'+index,text='EDITED_QUESTION_'+index;
    const result=await f.call('flow.command',{id,command:{type:'rewind',targetInputId,input:{inputId,text}}});
    assert.equal(result.ok,true);
    await f.done(id);
    // Allow any erroneous post-close handoff to reach the HTTP server as well.
    await new Promise(resolve=>setTimeout(resolve,100));
    const completed=await f.detail(id);
    assert.equal(completed.flow.phase,'idle');
    assert.equal(completed.flow.generation,index+1);
    assert.equal(Object.values(completed.flow.runs).filter(run=>run.inputIds.includes(inputId)).length,1);
    const requests=f.requests.filter(body=>JSON.stringify(body.messages.filter(message=>message.role==='user').at(-1)).includes(text));
    assert.equal(requests.length,1,'the actual executor submits the edited input to the model once');
    assert.equal(completed.flow.timeline.filter(item=>item.kind==='assistant').length,1);
    assert.deepEqual(completed.flow.timeline.filter(item=>item.kind==='user').map(item=>item.id),[inputId]);
    targetInputId=inputId;
  }
  await f.send(id,'FOLLOW_UP');await f.done(id);
  assert.equal(f.requests.length,5,'one original, three edits and one follow-up');
  const saved=JSON.parse(await fs.readFile(path.join(f.root,'data/state.json'),'utf8'));
  assert.equal(Object.keys(saved.sessions[id].flow.runs).length,5);
});
