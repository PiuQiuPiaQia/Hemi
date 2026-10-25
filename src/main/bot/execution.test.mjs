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

async function until(read) {
  const end=Date.now()+12000;
  for (;;) {const value=await read();if(value)return value;assert.ok(Date.now()<end,'execution condition timed out');await new Promise(resolve=>setTimeout(resolve,15));}
}
function reply(res,{text='DONE',command}={}) {
  if(res.destroyed)return;
  res.writeHead(200,{'content-type':'text/event-stream'});
  const delta=command ? {role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:'bash',arguments:JSON.stringify(command)}}]} : {role:'assistant',content:text};
  for(const [content,finish] of [[delta,null],[{},command?'tool_calls':'stop']])res.write('data: '+JSON.stringify({id:randomUUID(),model:'fixture',choices:[{index:0,delta:content,finish_reason:finish}],...(finish?{usage:{prompt_tokens:20,completion_tokens:10}}:{})})+'\n\n');
  res.end('data: [DONE]\n\n');
}
async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-shared-execution-'))),held=new Map(),requests=[];
  const first=path.join(root,'workspace'),other=path.join(root,'other');await fs.mkdir(first);await fs.mkdir(other);
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw),text=JSON.stringify(body.messages);requests.push(body);
    const lastUser=JSON.stringify(body.messages.filter(message=>message.role==='user').at(-1));
    if(lastUser?.includes('HOLD_MODEL')){held.set(lastUser.match(/HOLD_MODEL_(\w+)/)[1].toLowerCase(),res);return;}
    const toolCalled=body.messages.some(message=>message.role==='tool');
    if(text.includes('BLOCK_SHELL')&&!toolCalled){reply(res,{command:{command:'printf started > a.started; while [ ! -f release ]; do sleep 0.02; done; printf A_DONE',run_in_background:true,yield_ms:20}});return;}
    if(text.includes('WRITE_FILE')&&!toolCalled){reply(res,{command:{command:'printf actual > '+(text.includes('WRITE_FILE_E')?'e.done':text.includes('WRITE_FILE_C')?'c.done':'b.done')}});return;}
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

test('only conflicting tools wait: background shell retains its workspace lease, other projects and chat proceed, cancelled waits never execute',{timeout:30000,skip:process.platform==='win32'},async t=>{
  const f=await fixture(t),a=await f.create(),b=await f.create(),c=await f.create(f.other),d=await f.create();
  await f.send(a,'BLOCK_SHELL');await until(()=>fs.access(path.join(f.first,'a.started')).then(()=>true,()=>false));
  await f.send(b,'WRITE_FILE_B');
  const blocked=await until(async()=>{const item=await f.detail(b);return item.waitingResource&&item;});
  assert.equal(blocked.status,'queued');assert.deepEqual(blocked.blockedBy,[a]);
  assert.equal(await fs.access(path.join(f.first,'b.done')).then(()=>true,()=>false),false);
  await f.send(c,'WRITE_FILE_C');await f.done(c);assert.equal(await fs.readFile(path.join(f.other,'c.done'),'utf8'),'actual');
  await f.send(d,'PLAIN');await f.done(d);assert.ok((await f.detail(a)).flow.activeRunId,'other conversations finish while the original shell still runs');
  await f.call('flow.command',{id:b,command:{type:'stop',targetRunId:blocked.flow.activeRunId}});await f.done(b);
  const e=await f.create();await f.send(e,'WRITE_FILE_E');await until(async()=>(await f.detail(e)).waitingResource);
  await fs.writeFile(path.join(f.first,'release'),'release');await f.done(a);await f.done(e);
  assert.equal(await fs.readFile(path.join(f.first,'e.done'),'utf8'),'actual');
  assert.equal(await fs.access(path.join(f.first,'b.done')).then(()=>true,()=>false),false,'a cancelled resource waiter never executes after release');
  const state=JSON.parse(await fs.readFile(path.join(f.root,'data/runtime-v2/run-journal.json'),'utf8').catch(async()=>{
    const files=await fs.readdir(path.join(f.root,'data/runtime-v2'));throw Error('journal files: '+files.join(','));
  }));
  assert.doesNotMatch(JSON.stringify(state),/SYNTHETIC_ONLY/);
});

test('concurrent accepted conversations are never evicted while their shared runtime sessions initialize',{timeout:30000},async t=>{
  const f=await fixture(t),ids=await Promise.all(Array.from({length:10},()=>f.create()));
  await Promise.all(ids.map((id,index)=>f.send(id,'HOLD_MODEL_N'+index)));
  await until(()=>f.held.size===ids.length);
  for(const id of ids)assert.equal((await f.detail(id)).status,'running');
  for(const res of f.held.values())reply(res);
  await Promise.all(ids.map(id=>f.done(id)));
});
