import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {randomUUID} from 'node:crypto';
import {createBotHost} from './host.mjs';import {createBotExecutor} from './runtime.mjs';import {GOAL_CHECK_SYSTEM} from '../agent-runtime/goal-driver.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const deadline=Date.now()+15000;while(true){const v=await fn();if(v)return v;assert.ok(Date.now()<deadline,'job lifecycle timed out');await pause(20);}}
const cmd=body=>`"${process.execPath}" -e "${body}"`;
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-job-host-'))),workspace=path.join(root,'workspace'),dataDir=path.join(root,'data');await fs.mkdir(workspace);
 const requests=[];let host;
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push(body);const all=JSON.stringify(body.messages),checking=all.includes(GOAL_CHECK_SYSTEM),main=body.tools?.length;
  const toolMessages=body.messages.filter(m=>m.role==='tool').map(m=>({...m,name:m.name??body.messages.flatMap(x=>x.tool_calls??[]).find(c=>c.id===m.tool_call_id)?.function?.name}));
  let content,tools;
  const tool=(name,args)=>({index:0,id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
  if(checking)content=JSON.stringify({status:'complete',reason:'真实后台命令已结束，成果存在，已取消命令没有产生副作用',evidence:['proof.txt 实际写入'],remaining:[],nextAction:''});
  else if(!main)content='后台任务验收';
  else if(!body.messages.some(m=>m.role==='tool'))tools=[
   tool('bash',{command:cmd("process.stdout.write('FIRST_ALIVE');setTimeout(()=>require('fs').writeFileSync('cancelled.txt','BAD'),10000)"),run_in_background:true,timeout_ms:14000}),
   tool('bash',{command:cmd("process.stdout.write('SECOND_ALIVE');const t=setInterval(()=>{if(require('fs').existsSync('release')){clearInterval(t);require('fs').writeFileSync('proof.txt','DONE')}},30)"),run_in_background:true,timeout_ms:14000}),
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
 return {id,call,workspace,requests,flow:()=>call('flow.snapshot',{id}),async restart(){await host.close();host=await createBotHost(options);}};
}
test('real Host/SDK: quiet observation, model job reads, UI controls, isolated stop, one goal and verified completion',{timeout:30000},async t=>{
 const f=await fixture(t);await f.call('flow.command',{id:f.id,command:{type:'send',input:{inputId:'jobs-input',text:'启动两个独立后台命令，核对实际结果。'}}});
 const initial=await until(async()=>{const s=await f.flow();return s.runs[s.activeRunId]?.activity?.jobs.length===2?s:null;}),runId=initial.activeRunId;
 const control=(action,jobId,from,targetRunId=runId)=>f.call('flow.command',{id:f.id,command:{type:'backgroundCommand',targetRunId,action,jobId,from}});
 const jobs=initial.runs[runId].activity.jobs.toSorted((a,b)=>Number(b.command.includes('FIRST_ALIVE'))-Number(a.command.includes('FIRST_ALIVE')));assert.ok(jobs.every(j=>j.deadlineAt));await until(async()=>(await f.call('session.open',{id:f.id,activate:false})).status==='waiting');
 await until(()=>f.requests.some(b=>b.messages.some(m=>m.role==='assistant'&&m.tool_calls?.some(c=>c.function.name==='job_output'))));
 const read=await until(async()=>{const r=await control('read',jobs[0].id);assert.equal(r.ok,true);return /FIRST_ALIVE/.test(r.data.text)?r:null;});assert.match(read.data.text,/FIRST_ALIVE/);
 const bad=await control('read',jobs[0].id,0,'old-run');assert.equal(bad.code,'run-changed');
 assert.equal((await control('read','another-job')).ok,false);
 const before=f.requests.filter(b=>b.tools?.length).length;const reviewed=await control('review');assert.equal(reviewed.data.accepted,true);
 await until(()=>f.requests.filter(b=>b.tools?.length).length>before);
 const stopped=await control('stop',jobs[0].id);assert.equal(stopped.ok,true);
 const still=await until(async()=>{const s=await f.flow();const jobs=s.runs[runId].activity?.jobs;return jobs?.length===1?jobs[0]:null;});assert.equal(still.id,jobs[1].id);
 await fs.writeFile(path.join(f.workspace,'release'),'go');const done=await until(async()=>{const s=await f.flow();return s.phase==='idle'?s:null;});
 assert.equal(done.runs[runId].outcome,'completed');assert.equal(done.timeline.filter(x=>x.kind==='user').length,1);assert.equal(Object.keys(done.runs).length,1);
 assert.equal(await fs.readFile(path.join(f.workspace,'proof.txt'),'utf8'),'DONE');assert.equal(await fs.stat(path.join(f.workspace,'cancelled.txt')).catch(()=>null),null);
 assert.equal(done.timeline.flatMap(x=>x.parts??[]).filter(p=>p.kind==='notice'&&p.level==='error').length,0);
 assert.equal((await f.call('handshake')).activeJobs,0);assert.equal((await control('stop',jobs[1].id)).code,'run-changed');
 const requestCount=f.requests.filter(b=>b.tools?.length).length;await f.restart();await pause(100);assert.equal(f.requests.filter(b=>b.tools?.length).length,requestCount);assert.equal((await f.flow()).runs[runId].outcome,'completed');
});
