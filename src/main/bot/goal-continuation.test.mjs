import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createBotHost} from './host.mjs';
import {GOAL_CHECK_SYSTEM} from '../agent-runtime/goal-driver.mjs';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read) { const end=Date.now()+30000; while(true){const value=await read();if(value)return value;assert.ok(Date.now()<end,'goal did not settle');await wait(25);} }
const verdict = (status='complete') => ({status,reason:status==='complete'?'工具结果证明成果已写入并核对':'还有用户要求的成果未写入',evidence:status==='complete'?['实际 write 工具已写入 proof.txt']:['尚未产生所需文件'],remaining:status==='complete'?[]:['写入并核对 proof.txt'],nextAction:status==='complete'?'':'调用 write 工具写入 proof.txt，不要再次只报告计划'});
async function fixture(t, mode, goalPolicy={}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-goal-'))), dataDir=path.join(root,'data'), workspace=path.join(root,'workspace');await fs.mkdir(workspace);
  const requests=[];let generated=0,checks=0,releaseCheck;
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
    const checking=body.messages.some(message=>message.role==='system'&&String(message.content).includes(GOAL_CHECK_SYSTEM));
    let content,tool;
    if(checking){
      checks++;
      if(mode==='cancel'||mode==='cancel-blocked'||mode==='cancel-invalid')await new Promise(resolve=>{releaseCheck=resolve;});
      content=mode==='invalid'||mode==='fail-open'||mode==='cancel-invalid'?'not json':JSON.stringify(verdict(mode==='blocked'||mode==='cancel-blocked'?'blocked':mode==='no-progress'||mode==='round-limit'||!await fs.stat(path.join(workspace,'proof.txt')).catch(()=>null)?'continue':'complete'));
      if(mode==='background-chunk'){
        const facts=JSON.parse(JSON.parse(body.messages.at(-1).content).evidence),live=facts.backgroundJobs.filter(j=>j.status==='running');
        if(live.length)content=JSON.stringify({...verdict('continue'),remaining:['核对原命令的实际结果'],nextAction:'等待原后台命令结果',waitForJobs:live.map(j=>j.id)});
      }
    } else {
      generated++;
      if(mode==='fail-open') {
        if(generated===1)tool={id:'side-effect-once',type:'function',function:{name:'bash',arguments:JSON.stringify({command:`"${process.execPath}" -e "require('fs').appendFileSync('proof.txt','goal proof\\n')"`,yield_ms:1000})}};
        else content='命令回执已核对，操作完成。';
      } else if(mode==='background-chunk') {
        if(!body.messages.some(message=>message.role==='tool'))tool={id:'quota-background',type:'function',function:{name:'bash',arguments:JSON.stringify({command:`"${process.execPath}" -e "setTimeout(()=>require('fs').writeFileSync('proof.txt','goal proof'),500)"`,run_in_background:true,yield_ms:20})}};
        else content='等待已受理的命令完成。';
      } else if(mode==='subagent-chunk') {
        const main=body.tools?.some(tool=>tool.function.name==='task');
        if(!main) { await wait(30); content='CHILD_CAP_REPORT'; }
        else if(!body.messages.some(message=>message.role==='tool'&&JSON.stringify(message).includes('taskId')))tool={id:'child-dispatch',type:'function',function:{name:'task',arguments:JSON.stringify({agent:'fixer',prompt:'只报告 CHILD_CAP_REPORT，不调用工具',description:'子任务额度交接',background:true})}};
        else if(!JSON.stringify(body.messages).includes('hemi_goal_continuation')&&!JSON.stringify(body.messages).includes('宿主目标续跑'))content='等待子任务报告。';
        else if(!await fs.stat(path.join(workspace,'proof.txt')).catch(()=>null))tool={id:randomUUID(),type:'function',function:{name:'write',arguments:JSON.stringify({path:'proof.txt',content:'goal proof'})}};
        else content='文件已写入，任务完成。';
      } else
      if(mode==='chunk' && generated===1)tool={id:'read-initial',type:'function',function:{name:'ls',arguments:'{"path":"."}'}};
      else if(mode==='blocked' && !body.messages.some(message=>message.role==='tool'))tool={id:'external-resource',type:'function',function:{name:'bash',arguments:JSON.stringify({command:`"${process.execPath}" -e "process.stderr.write('EXTERNAL_RESOURCE_UNAVAILABLE');process.exit(23)"`,yield_ms:1000})}};
      else if(mode==='blocked')content='已核对命令输出，外部资源尚不可用；请恢复资源后继续。';
      else if(generated===1 || mode==='no-progress'||mode==='round-limit'||mode==='invalid'||mode==='cancel'||mode==='cancel-blocked')content='我会继续完成，文件尚未写入。';
      else if(!await fs.stat(path.join(workspace,'proof.txt')).catch(()=>null))tool={id:randomUUID(),type:'function',function:{name:'write',arguments:JSON.stringify({path:'proof.txt',content:'goal proof'})}};
      else content='文件已写入，任务完成。';
    }
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [delta,finish] of [[tool?{role:'assistant',tool_calls:[{...tool,index:0}]}:{role:'assistant',content},null],[{},tool?'tool_calls':'stop']])res.write('data: '+JSON.stringify({id:randomUUID(),model:'goal-fixture',choices:[{index:0,delta,finish_reason:finish}],...(finish?{usage:{prompt_tokens:30,completion_tokens:15}}:{})})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const hostOptions={dataDir,defaultDir:workspace,goalPolicy,allowLoopbackModels:true,validateModel:async()=>{}};
  let host=await createBotHost(hostOptions);
  const {instanceId}=await host.request('handshake');const call=(method,p={})=>host.request(method,{instanceId,requestId:randomUUID(),...p});
  t.after(async()=>{releaseCheck?.();await host.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  await call('model.sync',{models:[{modelKey:'test/goal',providerId:'test',name:'Goal fixture',model:'goal-fixture',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'SYNTHETIC_ONLY'}]});
  const {id}=await call('session.create');
  const send=(inputId='goal-input')=>call('flow.command',{id,command:{type:'send',input:{inputId,text:'写入 proof.txt，内容为 goal proof'}}});
  const flow=()=>call('flow.snapshot',{id});
  const journal=async()=>JSON.parse(await fs.readFile(path.join(dataDir,'runtime-v2/run-journal.json'),'utf8'));
  return {host,call,id,send,flow,journal,root,workspace,requests,get checks(){return checks;},release:()=>releaseCheck?.(),async restart(){await host.close();host=await createBotHost(hostOptions);}};
}

test('real Bot/SDK automatically continues an unfinished answer under one input and verifies the actual file', {timeout:45000}, async t=>{
  const f=await fixture(t,'continue');await f.send();const flow=await until(async()=>{const v=await f.flow();return v.phase==='idle'&&Object.keys(v.runs).length?v:null;});
  assert.equal(Object.values(flow.runs)[0].outcome,'completed',JSON.stringify(flow.timeline));assert.equal(flow.timeline.filter(item=>item.kind==='user').length,1);assert.equal(Object.keys(flow.runs).length,1);
  assert.equal(await fs.readFile(path.join(f.workspace,'proof.txt'),'utf8'),'goal proof');
  const j=await f.journal(),root=Object.values(j.roots).find(root=>root.owner.conversationId===f.id);
  assert.equal(root.goal.round,2);assert.equal(root.goal.phase,'complete');assert.equal(root.goal.verifications.length,2);
  assert.equal(f.requests.filter(body=>body.messages.some(message=>message.role==='system'&&String(message.content).includes(GOAL_CHECK_SYSTEM))).length,2);
});

test('shared request chunk exhausts softly inside one round, completes after one review, and preserves the original total budget', {timeout:45000}, async t=>{
  const f=await fixture(t,'chunk',{maxRounds:5,maxRequests:20,maxRequestsPerRound:1});
  await f.send();await until(async()=>{const v=await f.flow();return v.phase==='idle'&&Object.keys(v.runs).length;});
  const root=Object.values((await f.journal()).roots).find(root=>root.owner.conversationId===f.id);
  assert.equal(root.status,'completed',JSON.stringify(root.goal));assert.equal(root.goal.phase,'complete');
  assert.equal(root.goal.round,1,'软段边界下主模型单回合内跨段连续工作，不再强制分段续跑');
  assert.equal(root.goal.verifications.length,1,'一次复盘即判定 complete');assert.equal(root.goal.verifications[0].status,'complete');
  assert.equal(root.goal.requestOffset,0,'软放行不产生跨段偏移');assert.equal(root.goal.limitHistory,undefined,'未发生硬触顶落账');
  assert.equal(await fs.readFile(path.join(f.workspace,'proof.txt'),'utf8'),'goal proof');
});

test('real Bot/SDK delivers a failing command to the main agent and closes blocked without an error notice', {timeout:45000}, async t=>{
 const f=await fixture(t,'blocked');await f.send();
 const flow=await until(async()=>{const v=await f.flow();return v.phase==='idle'&&Object.keys(v.runs).length?v:null;});
 const run=Object.values(flow.runs)[0],root=(await f.journal()).roots[run.runId];
 assert.equal(run.outcome,'blocked');assert.equal(root.status,'blocked');assert.equal(root.goal.phase,'blocked');assert.equal(run.blocked.reason,root.goal.reason);
 const parts=flow.timeline.flatMap(x=>x.parts??[]);assert.equal(parts.filter(p=>p.kind==='notice'&&p.level==='error').length,0);
 assert.equal(parts.filter(p=>p.kind==='notice'&&p.level==='info').length,1);assert.ok(parts.some(p=>p.kind==='tool'&&p.status==='error'));
 assert.ok(f.requests.some(body=>body.tools?.length&&body.messages.some(message=>message.role==='tool'&&JSON.stringify(message).includes('EXTERNAL_RESOURCE_UNAVAILABLE'))),'main agent must consume the actual command failure');
 assert.equal((await f.call('handshake')).activeJobs,0);assert.equal(flow.activeRunId,null);
 const ownedRequestCount=Object.values((await f.journal()).requests).filter(row=>row.owner.rootRunId===run.runId).length;
 await f.restart();await wait(100);const restored=await f.flow(),restoredJournal=await f.journal();
 assert.equal(Object.values(restoredJournal.requests).filter(row=>row.owner.rootRunId===run.runId).length,ownedRequestCount);
 assert.equal(restored.runs[run.runId].outcome,'blocked');assert.equal(restoredJournal.roots[run.runId].status,'blocked');
 await f.send('explicit-next-input');const next=await until(async()=>{const v=await f.flow();return v.phase==='idle'&&Object.keys(v.runs).length===2?v:null;});
 assert.ok(Object.values(next.runs).every(r=>r.outcome==='blocked'));assert.equal(next.timeline.filter(x=>x.kind==='user').length,2);
});

for(const [mode,policy] of [['no-progress',{noProgressRounds:3}],['round-limit',{maxRounds:2,noProgressRounds:5}]])test(`real Bot leaves ${mode} task incomplete and records its reason`,{timeout:45000},async t=>{
  const f=await fixture(t,mode,policy);await f.send();const flow=await until(async()=>{const v=await f.flow();return v.phase==='idle'&&Object.keys(v.runs).length?v:null;});
  assert.equal(Object.values(flow.runs)[0].outcome,'partial');const root=Object.values((await f.journal()).roots).find(root=>root.owner.conversationId===f.id);
  assert.notEqual(root.status,'completed');assert.equal(root.goal.phase,mode==='round-limit'?'budget_limited':'no_progress');assert.ok(root.goal.reason);
  const notices=flow.timeline.flatMap(item=>item.parts??[]).filter(part=>part.kind==='notice');assert.ok(notices.some(part=>/未完成|未确认完成|预算|进展/.test(part.text)));
  assert.equal(notices.filter(p=>p.level==='error').length,0);
  if(mode==='no-progress')assert.equal(f.checks,3);
});

test('real Bot fails open on verifier format error without repeating a completed command or creating another input', {timeout:45000}, async t=>{
 const f=await fixture(t,'fail-open');await f.send();const flow=await until(async()=>{const v=await f.flow();return v.phase==='idle'&&Object.keys(v.runs).length?v:null;});
 assert.equal(Object.values(flow.runs)[0].outcome,'completed');assert.equal(f.checks,1);
 assert.equal(await fs.readFile(path.join(f.workspace,'proof.txt'),'utf8'),'goal proof\n');
 assert.equal(flow.timeline.filter(item=>item.kind==='user').length,1);assert.equal(Object.keys(flow.runs).length,1);
 assert.equal(flow.timeline.flatMap(item=>item.parts??[]).filter(item=>item.kind==='notice'&&item.level==='error').length,0);
 const j=await f.journal(),root=Object.values(j.roots).find(root=>root.owner.conversationId===f.id);
 assert.equal(root.goal.round,1);assert.equal(root.goal.verifications.length,1);
 assert.equal(root.goal.verificationAttempts[0].bypassed,true);assert.equal(root.goal.verifications[0].verificationBypassed,true);
 assert.equal(Object.values(j.processes).filter(item=>item.owner.rootRunId===root.owner.rootRunId).length,1);
 await f.restart();await wait(100);assert.equal(await fs.readFile(path.join(f.workspace,'proof.txt'),'utf8'),'goal proof\n');
});

for(const mode of ['cancel','cancel-blocked','cancel-invalid'])test(`stop during completion verification rejects late ${mode} and never starts a continuation`, {timeout:45000}, async t=>{
  const expectedChecks=1;
  const f=await fixture(t,mode);await f.send();await until(()=>f.checks===expectedChecks);
  const checking=await f.flow();
  assert.equal(checking.phase,'running');
  assert.equal(checking.runs[checking.activeRunId].activity.phase,'verifying');
  const answer=checking.timeline.flatMap(item=>item.parts??[]).filter(part=>part.kind==='text').at(-1);
  assert.ok(answer?.endedAt, 'Bot 在校验前也必须关闭正文输出，快照可恢复该事实');
  await f.call('flow.command',{id:f.id,command:{type:'stop'}});f.release();
  const flow=await until(async()=>{const v=await f.flow();return v.phase==='idle'?v:null;});
  assert.equal(Object.values(flow.runs)[0].outcome,'stopped');await wait(100);assert.equal(f.checks,expectedChecks);
  const root=Object.values((await f.journal()).roots).find(root=>root.owner.conversationId===f.id);assert.notEqual(root.goal.phase,'complete');
});


test('real background child report is consumed once when the shared request chunk hits its limit', {timeout:45000}, async t=>{
 const f=await fixture(t,'subagent-chunk',{maxRounds:6,maxRequests:30,maxRequestsPerRound:3});await f.send();const flow=await until(async()=>{const v=await f.flow();return v.phase==='idle'&&Object.keys(v.runs).length?v:null;});
 assert.equal(Object.values(flow.runs)[0].outcome,'completed',JSON.stringify(flow.timeline.flatMap(item=>item.parts??[]).filter(part=>part.kind==='notice')));
 const j=await f.journal(),root=Object.values(j.roots).find(root=>root.owner.conversationId===f.id&&root.kind!=='auxiliary');
 assert.equal(root.goal.phase,'complete');assert.ok(root.goal.round>=2);assert.equal(await fs.readFile(path.join(f.workspace,'proof.txt'),'utf8'),'goal proof');
 const inbox=Object.values(j.inbox).filter(item=>item.owner.rootRunId===root.owner.rootRunId);assert.ok(inbox.length);assert.ok(inbox.every(item=>item.state==='consumed'));
 assert.equal(Object.values(j.dispatches).filter(item=>item.owner.rootRunId===root.owner.rootRunId).length,1,'the accepted child must not be dispatched twice');
});


test('accepted background command finishes despite a shared chunk limit before completion is verified', {timeout:45000}, async t=>{
 const f=await fixture(t,'background-chunk',{maxRequestsPerRound:1});await f.send();const flow=await until(async()=>{const v=await f.flow();return v.phase==='idle'&&Object.values(v.runs).some(run=>run.source==='event'&&run.outcome==='completed')?v:null;});assert.equal(Object.values(flow.runs)[0].outcome,'awaiting-background',JSON.stringify(flow.timeline.flatMap(item=>item.parts??[]).filter(part=>part.kind==='notice')));
 assert.equal(await fs.readFile(path.join(f.workspace,'proof.txt'),'utf8'),'goal proof');const j=await f.journal(),processes=Object.values(j.processes).filter(item=>item.owner.conversationId===f.id);assert.equal(processes.length,1);assert.equal(processes[0].state,'finished');assert.equal(processes[0].cleanupConfirmed,true);assert.notEqual(processes[0].status,'cancelled');
 const root=Object.values(j.roots).find(root=>root.owner.conversationId===f.id&&root.kind!=='auxiliary');assert.equal(root.goal.phase,'complete');assert.ok(root.goal.round>=2);assert.equal(root.goal.verifications.length,1);assert.equal(root.goal.verifications[0].status,'complete');
});
