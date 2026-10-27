import {replyToGoalCheck} from '../../../scripts/lib/goal-model-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createBotHost} from './host.mjs';

test('real Bot SDK shares native memory across sessions and restart through Host RPC', {timeout:30000}, async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-bot-native-')));
 const requests=[];
 const provider=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);if(replyToGoalCheck(body,res))return;requests.push(body);
  if (JSON.stringify(body.messages).includes('CLOSE_IN_FLIGHT')) {
   await new Promise(resolve=>setTimeout(resolve,500));
   if (res.destroyed) return;
  }
  const index=body.messages.findLastIndex(message=>message.role==='user');
  const prompt=JSON.stringify(body.messages[index]);
  const name=prompt.includes('SAVE_BOT_NATIVE')?'memory_write':prompt.includes('READ_BOT_NATIVE')?'memory_read':null;
  const tool=name&&!body.messages.slice(index).some(message=>message.role==='tool')?{index:0,id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(name==='memory_write'?{target:'long_term',content:'BOT_NATIVE_SHARED_FACT'}:{target:'long_term'})}}:null;
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(`data: ${JSON.stringify({choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[tool]}:{role:'assistant',content:'OK'},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const options={dataDir:path.join(root,'data'),defaultDir:path.join(root,'workspace'),allowLoopbackModels:true,validateModel:async()=>{}};
 let host=await createBotHost(options);const hello=await host.request('handshake');
 const call=(method,params={})=>host.request(method,{instanceId:hello.instanceId,requestId:randomUUID(),...params});
 t.after(async()=>{await host.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await fs.rm(root,{recursive:true,force:true});});
 await assert.rejects(call('agent-environment.configure',{exitSummaryEnabled:false}));
 assert.equal(process.env.PI_MEMORY_EXIT_SUMMARY,'1');
 assert.equal(process.env.PI_MEMORY_QMD_UPDATE,'off');
 await call('model.sync',{models:[{modelKey:'test/native',providerId:'test',name:'Native',model:'native-model',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,api:'openai-completions',apiKey:'synthetic',thinkingLevel:'off'}]});
 async function send(id,text){
  const receipt=await call('flow.command',{id,command:{type:'send',input:{inputId:randomUUID(),text}}});assert.equal(receipt.ok,true);
  const until=Date.now()+15000;
  while(Date.now()<until){const detail=await call('session.open',{id});if(!detail.flow.activeRunId&&Object.values(detail.flow.runs).length){assert.equal(Object.values(detail.flow.runs).at(-1).outcome,'completed');return;}await new Promise(resolve=>setTimeout(resolve,25));}
  throw new Error('Bot did not settle');
 }
 const first=await call('session.create');await send(first.id,'SAVE_BOT_NATIVE');
 const second=await call('session.create');await send(second.id,'READ_BOT_NATIVE');
 assert.match(JSON.stringify(requests.at(-1).messages),/BOT_NATIVE_SHARED_FACT/);
 assert.equal(requests[0].tools.filter(tool=>tool.function.name==='memory_write').length,1);
 const native=await call('agent-environment.read-file',{path:'MEMORY.md'});assert.match(native.text,/BOT_NATIVE_SHARED_FACT/);
 await assert.rejects(call('agent-environment.read-file',{path:'../state.json'}));
 await assert.rejects(call('agent-environment.read-file',{instanceId:'other-bot',path:'MEMORY.md'}));
 await call('service.stop');await call('service.start');
 const resumed=await call('session.create');await send(resumed.id,'READ_BOT_NATIVE');
 assert.equal(process.env.PI_MEMORY_EXIT_SUMMARY,'1');
 await host.close();host=await createBotHost(options);
 assert.match((await call('agent-environment.read-file',{path:'MEMORY.md'})).text,/BOT_NATIVE_SHARED_FACT/);
 assert.equal((await call('agent-environment.inspect')).owner,'Bot');
 const closing=await call('session.create');
 await call('flow.command',{id:closing.id,command:{type:'send',input:{inputId:randomUUID(),text:'CLOSE_IN_FLIGHT'}}});
 const deadline=Date.now()+5000;
 while(!requests.some(request=>JSON.stringify(request.messages).includes('CLOSE_IN_FLIGHT'))) {
  assert.ok(Date.now()<deadline,'closing fixture must reach the actual model request');
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 await host.close();
 const stateFile=path.join(options.dataDir,'state.json'),settled=await fs.readFile(stateFile,'utf8');
 await new Promise(resolve=>setTimeout(resolve,250));
 assert.equal(await fs.readFile(stateFile,'utf8'),settled,'shutdown must not schedule a later state rewrite');
 host=await createBotHost(options);
});
