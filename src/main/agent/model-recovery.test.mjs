// Production session factory + installed Pi SDK + actual local HTTP streaming boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {createHemiSession} from './hemi-session.mjs';
import {createRunJournal} from '../agent-runtime/run-journal.mjs';
import {createContextStore} from '../agent-runtime/context-store.mjs';
import {createRunPartProjector} from '../services/flow-parts-projection.mjs';
import {applyFlowFact, createFlowSnapshot} from '../../shared/conversation-flow.mjs';

test('a failed stream retries the same model request, replacing only its partial output and keeping one completed tool', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'hemi-recovery-sdk-'));
  await writeFile(path.join(dir,'fixture.txt'),'RECOVERY_TOOL_RESULT');
  const requests=[];let afterTool=0;
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);requests.push(body);
    const hasResult=body.messages.some(message=>message.role==='tool');
    res.writeHead(200,{'content-type':'text/event-stream'});
    const send=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'recovery-test',model:'model',choices:[{index:0,delta,finish_reason}]})}\n\n`);
    if(!hasResult){send({role:'assistant',content:'先读取文件。'});send({tool_calls:[{index:0,id:'read-once',type:'function',function:{name:'read',arguments:JSON.stringify({path:path.join(dir,'fixture.txt')})}}]});send({},'tool_calls');res.end('data: [DONE]\n\n');}
    else if(afterTool++===0){send({role:'assistant',content:'FAILED_PARTIAL_SHOULD_BE_REPLACED'});setTimeout(()=>res.destroy(),30);}
    else{send({role:'assistant',content:'完整恢复内容。'});send({},'stop');res.end('data: [DONE]\n\n');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={modelKey:'p/m',providerId:'p',credentialRef:'p',model:'model',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'SYNTHETIC_ONLY'};
  const journal=createRunJournal({dir:path.join(dir,'journal')}),owner={conversationId:'test',rootRunId:'run',generation:1};
  await journal.beginRoot(owner);
  const execution={journal,owner,contextStore:createContextStore({dir:path.join(dir,'contexts')}),allowedRefs:[],purpose:'main',plan:{role:'main',primary:config,allowedFallbacks:[]},store:{resolveStrict:async()=>({ok:true,config})},budgets:{maxRequestsPerRun:60},cancelled:()=>false};
  const session=createHemiSession({cwd:dir,agentDir:dir,model:config,tools:['read'],features:{},accessWorkspaceDir:dir,executionContext:execution,initTimeoutMs:2000,stallTimeoutMs:10000});
  t.after(async()=>{session.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  let snapshot=createFlowSnapshot({conversationId:'test'});
  snapshot=applyFlowFact(snapshot,{type:'run-preparing',runId:'run',generation:1,inputIds:['input'],at:1}).snapshot;
  const projector=createRunPartProjector({runId:'run',generation:1,inputId:'input'});
  const project=event=>{for(const fact of projector.handle(event))snapshot=applyFlowFact(snapshot,fact).snapshot;};
  const recoveries=[],tools=[];
  session.on('recovery',value=>{recoveries.push(value);project({kind:'recovery',recovery:value});});
  session.on('stream',event=>{if(event.type==='hemi_request_start')project({kind:'request-start'});if(event.type==='hemi_request_reset')project({kind:'request-reset'});if(event.type==='text_delta')project({kind:'text',text:event.delta});});
  session.on('progress',event=>{tools.push(event);project({...event,kind:event.kind==='tool-start'?'tool_start':'tool_end'});});
  const result=await session.prompt('读取 fixture.txt，然后简短回复。');
  assert.equal(result.modelError,null);assert.equal(requests.length,3);
  assert.equal(tools.filter(event=>event.kind==='tool-end').length,1);
  assert.ok(recoveries.some(event=>event.phase==='waiting'));assert.equal(recoveries.at(-1).phase,'recovered');
  assert.equal(recoveries.at(-1).deadlineAt-recoveries[0].firstFailureAt,1800000);
  const text=snapshot.timeline.flatMap(item=>item.parts??[]).filter(part=>part.kind==='text').map(part=>part.content).join('');
  assert.match(text,/先读取文件。/);assert.match(text,/完整恢复内容。/);assert.doesNotMatch(text,/FAILED_PARTIAL/);
  const entries=(await session.exportEntries()).entries;
  assert.equal(entries.filter(entry=>entry.message?.role==='toolResult').length,1);
  assert.equal(entries.filter(entry=>entry.message?.role==='assistant').length,2,'SDK history must not keep an extra assistant entry for the retry');
  assert.doesNotMatch(JSON.stringify(entries),/FAILED_PARTIAL/);
  assert.deepEqual(requests[1].messages,requests[2].messages,'retry sends the identical pre-request history');
  const recorded=Object.values((await journal.snapshot()).requests);
  assert.equal(recorded.length,3);assert.equal(new Set(recorded.map(row=>row.logicalCallId)).size,2);
  assert.doesNotMatch(JSON.stringify(await journal.snapshot()),/SYNTHETIC_ONLY/);
});

test('a permanent error after recovery restores the normal stream watchdog for the next prompt', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'hemi-recovery-watchdog-'));
  let requests=0;
  const server=http.createServer(async(req,res)=>{
    for await(const _ of req) { /* Drain the actual SDK request. */ }
    requests++;
    if(requests<=2){res.writeHead(requests===1?503:401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:requests===1?'Service unavailable':'Unauthorized'}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{role:'assistant',content:'首段之后不再发送数据'},finish_reason:null}]})}\n\n`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={modelKey:'p/m',providerId:'p',credentialRef:'p',model:'model',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'SYNTHETIC_ONLY'};
  const journal=createRunJournal({dir:path.join(dir,'journal')}),owner={conversationId:'c',rootRunId:'r',generation:1};await journal.beginRoot(owner);
  const execution={journal,owner,purpose:'main',plan:{role:'main',primary:config,allowedFallbacks:[]},store:{resolveStrict:async()=>({ok:true,config})},budgets:{maxRequestsPerRun:60},cancelled:()=>false};
  const session=createHemiSession({cwd:dir,agentDir:dir,model:config,tools:[],features:{},executionContext:execution,initTimeoutMs:2000,stallTimeoutMs:500});
  t.after(async()=>{session.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const first=await session.prompt('失败后恢复');assert.match(first.modelError,/Unauthorized/);assert.equal(requests,2);
  const second=await session.prompt('检查下一轮的流停滞保护');assert.equal(second.aborted,true);assert.equal(requests,3);
});
