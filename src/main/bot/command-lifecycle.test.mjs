import {replyToGoalCheck} from '../../../scripts/lib/goal-model-fixture.mjs';
// Actual Host/controller/SDK and real OS processes; only model responses are fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createBotHost} from './host.mjs';
import {processBirth} from '../agent-runtime/owned-processes.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read){const end=Date.now()+20000;while(!await read()){assert.ok(Date.now()<end,'Host lifecycle timed out');await pause(30);}}
async function fixture(t,hold){
  const escaping=String(hold).includes('escape');
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-owned-host-'))),work=path.join(root,'workspace');await fs.mkdir(work);
  const child=path.join(work,'child.cjs'),parent=path.join(work,'parent.cjs'),pidFile=path.join(work,'pid'),late=path.join(work,'late');
  await fs.writeFile(child,`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(late)},'leaked'),20000);setInterval(()=>{},1000);`);
  await fs.writeFile(parent,`require('child_process').spawn(process.execPath,[${JSON.stringify(child)}],{detached:${escaping},stdio:'inherit'});setTimeout(()=>process.exit(0),${hold===true?100000:500});`);
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);if(replyToGoalCheck(body,res))return;requests.push(body);
    const last=JSON.stringify(body.messages.filter(message=>message.role==='user').at(-1));
    const done=JSON.stringify(body.messages).includes('［后台命令完成');
    const called=body.messages.some(message=>message.role==='tool');
    let command=`"${process.execPath}" "${parent}"`;
    if(process.platform==='win32'){
      const literal=s=>"'"+s.replaceAll("'","''")+"'";
      command=`powershell.exe -NoProfile -NonInteractive -Command "$p=Start-Process -FilePath ${literal(process.execPath)} -ArgumentList @(${literal(child)}) -RedirectStandardOutput ${literal(path.join(work,'out'))} -RedirectStandardError ${literal(path.join(work,'err'))} -PassThru -WindowStyle Hidden; Start-Sleep -Milliseconds ${hold?100000:500}; Write-Output ('PID='+$p.Id)"`;
    }
    const tool=body.tools?.length&&!last.includes('QUEUED_NEXT')&&!called&&!done;
    const launch=body.messages.flatMap(m=>m.tool_calls??[]).find(c=>c.function?.name==='bash');
    const job=body.messages.find(m=>m.role==='tool'&&m.tool_call_id===launch?.id);
    const waiting=hold!=='async-escape'&&called&&!done&&!last.includes('QUEUED_NEXT')&&!body.messages.some(m=>m.role==='assistant'&&m.tool_calls?.some(c=>c.function?.name==='job_output'));
    const jobId=job?.content?.match(/command-[A-Za-z0-9-]+/)?.[0];
    const delta=waiting&&jobId?{role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:'job_output',arguments:JSON.stringify({job_id:jobId,wait_ms:30000})}}]}:tool?{role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:'bash',arguments:JSON.stringify({command,run_in_background:true,yield_ms:20})}}]}:{role:'assistant',content:last.includes('QUEUED_NEXT')?'NEXT_DONE':done?'OWNED_LAUNCH_COMPLETE':'BACKGROUND_WAIT'};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [value,finish]of [[delta,null],[{},(tool||(waiting&&jobId))?'tool_calls':'stop']])res.write('data: '+JSON.stringify({id:randomUUID(),model:'fixture',choices:[{index:0,delta:value,finish_reason:finish}],...(finish?{usage:{prompt_tokens:20,completion_tokens:10}}:{})})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const host=await createBotHost({dataDir:path.join(root,'data'),defaultDir:work,allowLoopbackModels:true,validateModel:async()=>{}});
  t.after(async()=>{
    if(escaping){
      const pid=Number(await fs.readFile(pidFile,'utf8').catch(()=>0));
      if(pid&&await processBirth(pid).catch(()=>null)){try{process.kill(pid,'SIGKILL');}catch{}}
    }
    try{await host.close();}catch(error){if(!escaping||error.code!=='cleanup-unconfirmed')throw error;}
    finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});}
  });
  const {instanceId}=await host.request('handshake'),call=(method,params={})=>host.request(method,{instanceId,requestId:randomUUID(),...params});
  await call('model.sync',{models:[{modelKey:'fixture/owned',providerId:'fixture',name:'Isolated lifecycle',model:'fixture',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'SYNTHETIC_ONLY'}]});
  const {id}=await call('session.create');
  const flow=()=>call('flow.snapshot',{id});
  return {call,id,flow,requests,pidFile,late,root};
}
for(const stopping of [false,true])test(`owned launch ${stopping?'stop':'exit'} settles and hands queued input to exactly one new run`,{timeout:60000},async t=>{
  const f=await fixture(t,stopping);
  await f.call('flow.command',{id:f.id,command:{type:'send',input:{inputId:'first',text:'OWNED_LAUNCH'}}});
  await until(async()=>{const flow=await f.flow();return flow.runs[flow.activeRunId]?.activity?.jobs.length;});
  const old=await f.flow(),runId=old.activeRunId;
  await f.call('flow.command',{id:f.id,command:{type:'send',input:{inputId:'queued',text:'QUEUED_NEXT'}}});
  if(stopping){
    await until(()=>fs.readFile(f.pidFile,'utf8').then(()=>true,()=>false));
    await f.call('flow.command',{id:f.id,command:{type:'promoteInput',inputId:'queued'}});
  }
  await until(async()=>{const flow=await f.flow();return flow.phase==='idle'&&flow.timeline.some(item=>item.kind==='user'&&item.id==='queued');});
  const final=await f.flow();
  assert.equal(final.runs[runId].outcome,stopping?'stopped':'completed');
  assert.equal(final.pending.length,0);
  assert.equal(final.timeline.filter(item=>item.kind==='user'&&item.id==='queued').length,1);
  assert.equal(new Set(Object.keys(final.runs)).size,2);
  const journal=JSON.parse(await fs.readFile(path.join(f.root,'data/runtime-v2/run-journal.json'),'utf8'));
  assert.ok(Object.values(journal.processes).every(process=>process.state==='finished'&&process.cleanupConfirmed));
  assert.equal(await fs.readFile(f.late,'utf8').catch(()=>null),null);
  assert.equal(f.requests.filter(body=>JSON.stringify(body.messages).includes('［后台命令完成')&&!JSON.stringify(body.messages.filter(message=>message.role==='user').at(-1)).includes('QUEUED_NEXT')).length,0,'explicit job_output consumes the result without a second notification');
});

for(const promote of [false,true])test(`escaped POSIX output holder ${promote?'during promotion':'on exit'} fails honestly and retains queued input`,{timeout:30000,skip:process.platform==='win32'},async t=>{
  const f=await fixture(t,'escape');
  await f.call('flow.command',{id:f.id,command:{type:'send',input:{inputId:'first',text:'OWNED_LAUNCH'}}});
  await until(async()=>{const flow=await f.flow();return flow.runs[flow.activeRunId]?.activity?.jobs.length;});
  const old=await f.flow(),runId=old.activeRunId;
  await f.call('flow.command',{id:f.id,command:{type:'send',input:{inputId:'queued',text:'QUEUED_NEXT'}}});
  if(promote){
    await until(()=>fs.readFile(f.pidFile,'utf8').then(()=>true,()=>false));
    await f.call('flow.command',{id:f.id,command:{type:'promoteInput',inputId:'queued'}});
  }
  await until(async()=>{const flow=await f.flow();return flow.phase==='idle';});
  const final=await f.flow();
  assert.equal(final.runs[runId].outcome,'failed');assert.equal(final.queuePaused,true);
  assert.equal(final.pending[0].inputId,'queued');
  assert.equal(final.timeline.filter(item=>item.kind==='user'&&item.id==='queued').length,0);
  const journal=JSON.parse(await fs.readFile(path.join(f.root,'data/runtime-v2/run-journal.json'),'utf8'));
  assert.ok(Object.values(journal.processes).some(process=>process.state==='unknown'&&!process.cleanupConfirmed));
});

test('an asynchronous cleanup failure wakes no model, fails the event turn and pauses automatic dispatch',{timeout:30000,skip:process.platform==='win32'},async t=>{
 const f=await fixture(t,'async-escape');
 await f.call('flow.command',{id:f.id,command:{type:'send',input:{inputId:'first',text:'OWNED_LAUNCH'}}});
 await until(async()=>{const flow=await f.flow();return flow.phase==='idle'&&Object.values(flow.runs).some(run=>run.outcome==='awaiting-background');});
 const count=f.requests.filter(body=>body.tools?.length).length;
 await until(async()=>{const flow=await f.flow();return flow.phase==='idle'&&Object.values(flow.runs).some(run=>run.source==='event'&&run.outcome==='failed');});
 const final=await f.flow();assert.equal(final.queuePaused,true);
 assert.equal(final.backgroundJobs.length,1,'unknown cleanup remains visible independently of the failed foreground turn');
 assert.equal(final.backgroundJobs[0].cleanupConfirmed,false);assert.ok(final.backgroundJobs[0].endedAt);
 assert.equal(f.requests.filter(body=>body.tools?.length).length,count,'unsafe cleanup cannot start a continuation model');
 const state=JSON.parse(await fs.readFile(path.join(f.root,'data/runtime-v2/run-journal.json'),'utf8'));
 assert.ok(Object.values(state.processes).some(process=>process.state==='unknown'&&!process.cleanupConfirmed));
});
