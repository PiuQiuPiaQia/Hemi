import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {createAgentRuntime} from './core.mjs';
import {createHemiSession} from '../agent/hemi-session.mjs';
import {freezeWorkflowModel} from '../workflows/workflow-model-plan.mjs';

async function fixture(t,respond){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-native-lifecycle-'));
 const cleanup=[];const requests=[];const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
  const output=respond(body,requests.length);res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(`data: ${JSON.stringify({choices:[{index:0,delta:output.tool?{role:'assistant',tool_calls:[{...output.tool,index:0}]}:{role:'assistant',content:output.text??'OK'},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:output.tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}\n\ndata: [DONE]\n\n`);
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const close of cleanup)await close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
 return{root,requests,own:close=>cleanup.push(close),config:{modelKey:'p/native',providerId:'p',model:'native',api:'openai-completions',apiKey:'SYNTHETIC',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,thinkingLevel:'off'}};
}

test('workflow root loads official memory and release closes the original lifecycle', {timeout:30000}, async t=>{
 const f=await fixture(t,body=>({tool:body.messages.some(message=>message.role==='tool')?null:{id:'workflow-memory',type:'function',function:{name:'memory_write',arguments:JSON.stringify({target:'long_term',content:'WORKFLOW_NATIVE_SHARED_FACT'})}}}));
 const store={list:async()=>({defaultModelId:'p/native',roleModels:{main:'p/native'}}),resolveStrict:async()=>({ok:true,config:f.config})};
 const runtime=createAgentRuntime({userDataDir:path.join(f.root,'data'),nativeMemory:true,getProfiles:()=>store,resolveCapabilities:async()=>({features:{},extensionConfig:{}}),getAccessService:()=>null});
 f.own(()=>runtime.close());
 const plan=await freezeWorkflowModel({selection:{mode:'fixed',modelKey:'p/native'},store,roles:new Map()});
 const node=await runtime.openWorkflowNode({nodeSpec:{nodeId:'node',nodeType:'hemi-agent',nodeData:{goal:'Save shared fact'}},executionOwner:{workflowRunId:'wf-native',nodeId:'node',attemptId:'attempt-native'},invocation:{conversationId:'workflow-native',run:{modelPlan:plan,workspace:{type:'project',id:'native',dir:f.root}}}});
 try{await node.agent.run({inputs:{}});assert.match(await fs.readFile(path.join(f.root,'data/pi-memory/MEMORY.md'),'utf8'),/WORKFLOW_NATIVE_SHARED_FACT/);assert.equal(runtime.isBusy(),true);}finally{await node.release();}
 assert.equal(runtime.isBusy(),false);assert.equal(f.requests[0].tools.filter(tool=>tool.function.name==='memory_write').length,1);
});

test('real SDK automatic compaction runs original handoff hook exactly once', {timeout:30000}, async t=>{
 const f=await fixture(t,body=>({text:JSON.stringify(body).includes('context summarization assistant')?'## Goal\nContinue native memory test.\n## Progress\nPreserve open TODO.':'OK'}));
 const values={PI_MEMORY_DIR:path.join(f.root,'pi-memory'),PI_MEMORY_QMD_UPDATE:'off',PI_MEMORY_EXIT_SUMMARY:'0',PI_MEMORY_NO_SEARCH:'1',PI_MEMORY_SNAPSHOT:'per-turn'};
 const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);
 await fs.mkdir(values.PI_MEMORY_DIR);await fs.writeFile(path.join(values.PI_MEMORY_DIR,'SCRATCHPAD.md'),'- [ ] NATIVE_COMPACTION_TODO');
 const history=SessionManager.inMemory(f.root);for(let i=0;i<40;i++)history.appendMessage({role:i%2?'assistant':'user',content:[{type:'text',text:`message ${i} `+'prior context '.repeat(500)}],...(i%2?{api:'openai-completions',provider:'hemi',model:'native',usage:{input:10000,output:1000,cacheRead:0,cacheWrite:0,totalTokens:11000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop'}:{}),timestamp:i});
 const session=createHemiSession({cwd:f.root,agentDir:path.join(f.root,'agent'),nativeMemory:true,model:f.config,tools:[],features:{},entries:[history.getHeader(),...history.getEntries()],settings:{compaction:{enabled:true,reserveTokens:120000,keepRecentTokens:100}}});
 f.own(async()=>{await session.close('reload');for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 const result=await session.prompt('Continue');assert.equal(result.modelError,null);
 assert.ok((await session.exportEntries()).entries.some(entry=>entry.type==='compaction'));
 const files=await fs.readdir(path.join(values.PI_MEMORY_DIR,'daily'));const daily=await fs.readFile(path.join(values.PI_MEMORY_DIR,'daily',files[0]),'utf8');assert.match(daily,/NATIVE_COMPACTION_TODO/);assert.equal(daily.split('<!-- HANDOFF').length,2);
});

test('read-only and verification boundaries cannot load lifecycle writers',()=>{
 for(const options of [{mode:'verify'},{boundary:'readonly'}])assert.throws(()=>createHemiSession({cwd:os.tmpdir(),agentDir:os.tmpdir(),nativeMemory:true,...options}),/不能加载记忆插件/);
});
