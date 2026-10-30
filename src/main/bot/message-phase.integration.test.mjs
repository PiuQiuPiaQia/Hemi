import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBotHost } from './host.mjs';
import { replyToGoalCheck } from '../../../scripts/lib/goal-model-fixture.mjs';

test('actual Bot host retains typed progress and an answer before a trailing delivery, including restart', {timeout:30000}, async t => {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-bot-phases-')));
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);if(replyToGoalCheck(body,res))return;
    const tools=body.messages.filter(message=>message.role==='tool');
    let delta={content:'来源已登记'};
    const tool=(name,args)=>({tool_calls:[{index:0,id:`phase-${tools.length}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
    if(body.tools?.length){
      assert.match(JSON.stringify(body.messages),/消息用途协议/);
      if(tools.length===0)delta=tool('report_progress',{text:'正在核对资料'});
      else if(tools.length===1)delta={content:'**完整答案**',...tool('register_delivery',{files:[],sources:[{title:'依据',url:'https://example.com/'}]})};
    }
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const options={dataDir:path.join(root,'data'),defaultDir:root,allowLoopbackModels:true,validateModel:async()=>{}};
  let host=await createBotHost(options),hello=await host.request('handshake');
  const call=(method,params={})=>host.request(method,{instanceId:hello.instanceId,requestId:randomUUID(),...params});
  t.after(async()=>{await host.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const synced=await call('model.sync',{models:[{modelKey:'phase/main',providerId:'phase',name:'phase',model:'phase',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'synthetic',thinkingLevel:'off'}]});
  assert.equal(synced.results[0].ok,true);
  const session=await call('session.create');
  await call('flow.command',{id:session.id,command:{type:'send',input:{inputId:'phase-input',text:'核对消息用途'}}});
  let detail;
  for(let i=0;i<500;i++){
    detail=await call('session.open',{id:session.id});
    if(detail.flow.phase==='idle'&&detail.flow.timeline.some(item=>item.kind==='assistant'))break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(Object.values(detail.flow.runs).at(-1).outcome,'completed');
  const texts=detail.flow.timeline.flatMap(item=>item.parts??[]).filter(part=>part.kind==='text');
  assert.deepEqual(texts.map(part=>[part.content,part.phase]),[
    ['正在核对资料','commentary'],['**完整答案**','unclassified'],['来源已登记','unclassified'],
  ]);
  await host.close();host=await createBotHost(options);hello=await host.request('handshake');
  assert.deepEqual((await call('session.open',{id:session.id})).flow.timeline,detail.flow.timeline);
});
