import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {randomUUID} from 'node:crypto';
import {createBotHost} from './host.mjs';import {createBotExecutor} from './runtime.mjs';import {GOAL_CHECK_SYSTEM} from '../agent-runtime/goal-driver.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const deadline=Date.now()+15000;while(true){const v=await fn();if(v)return v;assert.ok(Date.now()<deadline,'job lifecycle timed out');await pause(20);}}
const cmd=body=>`"${process.execPath}" -e "${body}"`;
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-job-host-'))),workspace=path.join(root,'workspace'),dataDir=path.join(root,'data');await fs.mkdir(workspace);
 const requests=[];let host,releaseFollow;const followGate=new Promise(resolve=>{releaseFollow=resolve;});let followEntered=false;
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push(body);const all=JSON.stringify(body.messages),checking=all.includes(GOAL_CHECK_SYSTEM),main=body.tools?.length;
  const toolMessages=body.messages.filter(m=>m.role==='tool').map(m=>({...m,name:m.name??body.messages.flatMap(x=>x.tool_calls??[]).find(c=>c.id===m.tool_call_id)?.function?.name}));
  let content,tools;
  const tool=(name,args)=>({index:0,id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
  if(checking){
   const facts=JSON.parse(JSON.parse(body.messages.at(-1).content).evidence),live=facts.backgroundJobs.filter(j=>j.status==='running');
   content=JSON.stringify(live.length?{status:'continue',reason:'需要后台命令真实结果',evidence:['已受理命令仍在执行'],remaining:['核对退出结果'],nextAction:'等待已有命令结果',waitForJobs:live.map(j=>j.id)}
    :{status:'complete',reason:'真实后台命令已结束，成果存在，已取消命令没有产生副作用',evidence:['proof.txt 实际写入'],remaining:[],nextAction:''});
  }
  else if(!main)content='后台任务验收';
  else if(JSON.stringify(body.messages.at(-1)?.content).includes('FOLLOW_UP_QUESTION')){followEntered=true;await followGate;content='FOLLOW_UP_ANSWER';}
  else if(!body.messages.some(m=>m.role==='tool'))tools=[
   tool('bash',{command:cmd("process.stdout.write('FIRST_ALIVE');setTimeout(()=>require('fs').writeFileSync('cancelled.txt','BAD'),10000)"),run_in_background:true,timeout_ms:14000}),
   tool('bash',{command:cmd("process.stdout.write('SECOND_ALIVE');let reported=false;const t=setInterval(()=>{if(!reported&&require('fs').existsSync('progress')){reported=true;process.stdout.write('SECOND_PROGRESS')}if(require('fs').existsSync('release')){clearInterval(t);require('fs').writeFileSync('proof.txt','DONE')}},30)"),run_in_background:true,timeout_ms:14000}),
  ];
  else if(all.includes('后台命令状态观察')&&!toolMessages.some(m=>m.name==='job_list'))tools=[tool('job_list',{})];
  else if(toolMessages.some(m=>m.name==='job_list')&&!toolMessages.some(m=>m.name==='job_output')){
   const listed=JSON.parse(toolMessages.findLast(m=>m.name==='job_list').content);tools=[tool('job_output',{job_id:listed[0].id,wait_ms:30})];
  }else content=await fs.stat(path.join(workspace,'proof.txt')).catch(()=>null)?'成果已核对完成。':'已核对实际输出，命令仍在运行，继续等待。';
  res.writeHead(200,{'content-type':'text/event-stream'});
  const delta=tools?{role:'assistant',tool_calls:tools.map((x,index)=>({...x,index}))}:{role:'assistant',content};
  for(const [d,f] of [[delta,null],[{},tools?'tool_calls':'stop']])res.write('data: '+JSON.stringify({id:randomUUID(),model:'jobs',choices:[{index:0,delta:d,finish_reason:f}],...(f?{usage:{prompt_tokens:10,completion_tokens:10}}:{})})+'\n\n');res.end('data: [DONE]\n\n');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const options={dataDir,defaultDir:workspace,executorFactory:o=>createBotExecutor({...o,backgroundQuietReviewMs:500}),allowLoopbackModels:true,validateModel:async()=>{}};
 host=await createBotHost(options);const {instanceId}=await host.request('handshake');const call=(method,p={})=>host.request(method,{instanceId,requestId:randomUUID(),...p});
 t.after(async()=>{await host.close();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
 await call('model.sync',{models:[{modelKey:'test/jobs',providerId:'test',model:'jobs',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'SYNTHETIC_ONLY'}]});const {id}=await call('session.create');
 return {id,call,workspace,requests,releaseFollow,followEntered:()=>followEntered,flow:()=>call('flow.snapshot',{id}),async restart(){await host.close();host=await createBotHost(options);}};
}
test('real Host/SDK: jobs release foreground; results wait behind a question and resume the original goal once',{timeout:30000},async t=>{
 const f=await fixture(t);
 await f.call('flow.command',{id:f.id,command:{type:'send',input:{inputId:'jobs-input',text:'启动两个独立后台命令，核对实际结果。'}}});
 const initial=await until(async()=>{const s=await f.flow();return s.phase==='idle'&&Object.values(s.runs).some(r=>r.outcome==='awaiting-background')?s:null;});
 const runId=Object.keys(initial.runs)[0];
 const control=(action,jobId,targetRunId=runId)=>f.call('flow.command',{id:f.id,command:{type:'backgroundCommand',targetRunId,action,jobId}});
 const jobs=(await control('list')).data.toSorted((a,b)=>Number(b.command.includes('FIRST_ALIVE'))-Number(a.command.includes('FIRST_ALIVE')));
 assert.equal(jobs.length,2);assert.ok(jobs.every(j=>j.deadlineAt));
 assert.equal(initial.backgroundJobs.length,2);assert.ok(initial.backgroundJobs.every(job=>job.runId===runId));
 assert.equal((await f.call('flow.snapshot',{id:f.id,windowed:true})).backgroundJobs.length,2);
 await fs.writeFile(path.join(f.workspace,'progress'),'go');
 await until(async()=>{const flow=await f.flow();return flow.phase==='idle'&&flow.backgroundJobs.some(job=>job.output.includes('SECOND_PROGRESS'));});
 await until(async()=>/FIRST_ALIVE/.test((await control('read',jobs[0].id)).data?.text));
 const count=f.requests.length;await pause(150);assert.equal(f.requests.length,count,'waiting never polls the model');
 assert.equal(f.requests.filter(b=>JSON.stringify(b.messages).includes(GOAL_CHECK_SYSTEM)).length,0,'no verifier gates background handoff');
 assert.equal((await control('read',jobs[0].id,'other-run')).code,'run-changed');
 assert.equal((await control('stop',jobs[0].id)).ok,true);
 await until(async()=>(await f.flow()).backgroundJobs.length===1);
 assert.equal((await f.flow()).backgroundJobs[0].id,jobs[1].id);
 await until(async()=>{const s=await f.flow();return s.phase==='idle'&&Object.keys(s.runs).length===1;});
 await f.call('flow.command',{id:f.id,command:{type:'send',input:{inputId:'follow-input',text:'FOLLOW_UP_QUESTION'}}});
 await until(f.followEntered);
 await fs.writeFile(path.join(f.workspace,'release'),'go');
 await until(()=>fs.stat(path.join(f.workspace,'proof.txt')).catch(()=>null));
 await pause(100);const busy=await f.flow();assert.notEqual(busy.phase,'idle');
 assert.equal(Object.values(busy.runs).filter(r=>r.source==='event').length,0,'completion cannot steal the question slot');
 f.releaseFollow();
 const done=await until(async()=>{const s=await f.flow();return s.phase==='idle'&&Object.values(s.runs).filter(r=>r.source==='event').length===1?s:null;});
 assert.deepEqual(done.backgroundJobs,[]);
 assert.equal(done.timeline.filter(x=>x.kind==='user').length,2,'host completion is no fake user message');
 assert.match(JSON.stringify(done.timeline),/FOLLOW_UP_ANSWER/);
 assert.match(JSON.stringify(done.timeline),/成果已核对完成/);
 assert.equal(await fs.readFile(path.join(f.workspace,'proof.txt'),'utf8'),'DONE');
 assert.equal(await fs.stat(path.join(f.workspace,'cancelled.txt')).catch(()=>null),null);
 assert.equal(done.timeline.flatMap(x=>x.parts??[]).filter(p=>p.kind==='notice'&&p.level==='error').length,0);
 const before=f.requests.filter(b=>b.tools?.length).length;await f.restart();await pause(100);assert.equal(f.requests.filter(b=>b.tools?.length).length,before,'restart never replays old commands');
});
