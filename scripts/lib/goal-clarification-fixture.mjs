// Actual Host/SDK/files; only the model HTTP boundary is synthetic.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createBotHost} from '../../src/main/bot/host.mjs';
import {GOAL_CHECK_SYSTEM} from '../../src/main/agent-runtime/goal-driver.mjs';
export const CLARIFICATION_QUESTION='proof.txt 里需要写什么内容？';
export async function createClarificationFixture({verificationFailsAfterAnswer=false,clientId='clarification-fixture'}={}) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-clarify-'))),dataDir=path.join(root,'data'),workspace=path.join(root,'workspace');await fs.mkdir(workspace);
 const requests=[];let seedCalls=0,host,instanceId;
 const exists=file=>fs.stat(path.join(workspace,file)).then(()=>true,()=>false);
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
  const checking=body.messages.some(m=>m.role==='system'&&String(m.content).includes(GOAL_CHECK_SYSTEM));
  const text=JSON.stringify(body.messages),answered=text.includes('CLARIFIED_VALUE'),cancelled=text.includes('取消之前');
  let content,tool;
  if(checking){
   const done=cancelled||await exists('proof.txt');
   content=verificationFailsAfterAnswer&&answered?'invalid verification JSON':JSON.stringify(done?{status:'complete',reason:'用户最新要求已完成',evidence:[cancelled?'已按最新指令取消旧目标':'实际文件已写入且经 read 工具核对'],remaining:[],nextAction:''}:{status:'awaiting_user',question:CLARIFICATION_QUESTION,reason:'助手需要用户提供文件内容',evidence:[`助手已经询问：${CLARIFICATION_QUESTION}`],remaining:['得到用户内容后写入并核对 proof.txt'],nextAction:'等待用户回答文件内容'});
  } else if(cancelled)content='已取消之前的文件任务。';
  else if(!await exists('seed.txt')){seedCalls++;tool={name:'write',args:{path:'seed.txt',content:'INITIAL_EFFECT_ONCE'}};}
  else if(!answered)content=CLARIFICATION_QUESTION;
  else if(!await exists('proof.txt'))tool={name:'write',args:{path:'proof.txt',content:'CLARIFIED_VALUE'}};
  else {
   const afterAnswer=body.messages.slice(body.messages.findLastIndex(m=>m.role==='user'&&JSON.stringify(m.content).includes('CLARIFIED_VALUE'))+1);
   if(!afterAnswer.some(m=>m.role==='tool'&&String(m.content).includes('CLARIFIED_VALUE')))tool={name:'read',args:{path:'proof.txt'}};
   else content='已写入并读回核对 CLARIFIED_VALUE。';
  }
  res.writeHead(200,{'content-type':'text/event-stream'});
  const delta=tool?{role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}:{role:'assistant',content};
  for(const [value,finish]of [[delta,null],[{},tool?'tool_calls':'stop']])res.write('data: '+JSON.stringify({id:randomUUID(),model:'clarification',choices:[{index:0,delta:value,finish_reason:finish}],...(finish?{usage:{prompt_tokens:30,completion_tokens:10}}:{})})+'\n\n');
  res.end('data: [DONE]\n\n');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const start=async()=>{host=await createBotHost({dataDir,defaultDir:workspace,allowLoopbackModels:true,validateModel:async()=>{}});({instanceId}=await host.request('handshake'));};await start();
 const call=(method,params={})=>host.request(method,{instanceId,requestId:randomUUID(),...params},{clientId});
 await call('model.sync',{models:[{modelKey:'test/clarification',providerId:'test',model:'clarification',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'SYNTHETIC_ONLY'}]});
 const {id}=await call('session.create');
 return {root,dataDir,workspace,id,requests,call,get host(){return host;},get seedCalls(){return seedCalls;},
  send:(text,inputId=randomUUID())=>call('flow.command',{id,command:{type:'send',input:{inputId,text}}}),
  flow:()=>call('flow.snapshot',{id}),journal:()=>fs.readFile(path.join(dataDir,'runtime-v2/run-journal.json'),'utf8').then(JSON.parse),
  async restart(){await host.close();await start();},
  async close(){await host.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});},
 };
}
