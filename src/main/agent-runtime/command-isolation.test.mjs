import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createAgentRuntime} from './core.mjs';
import {createRunJournal} from './run-journal.mjs';
import {freezeModelPolicy,resolveModelPlan,hydrateModelPlan} from './model-policy.mjs';
import {GOAL_CHECK_SYSTEM} from './goal-driver.mjs';

async function fixture(t, {legacy = false} = {}) {
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-command-isolation-')));
  const userDataDir=path.join(dir,'data'),warnings=[],requests=[];
  if(legacy) {
    const journal=createRunJournal({dir:path.join(userDataDir,'runtime-v2')});
    const owner={conversationId:'missing-old-conversation',rootRunId:'old-root',generation:1};
    await journal.beginRoot(owner);
    await journal.processStart({id:'legacy-command',owner,pid:99999999,token:'synthetic-old-token',birth:'old'});
    await journal.processEnd('legacy-command',{state:'unknown',cleanupConfirmed:false,status:'registration-late'});
    await journal.finishRoot(owner,'cancelled');
    journal.dispose();
  }
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);requests.push(body);
    const checking=body.messages.some(m=>m.role==='system'&&String(m.content).includes(GOAL_CHECK_SYSTEM));
    const lastInput=body.messages.findLastIndex(m=>m.role==='user');
    const acted=body.messages.slice(lastInput+1).some(m=>m.role==='tool');
    const command=`"${process.execPath}" -e "process.stdout.write('COMMAND_ISOLATION_PROOF')"`;
    const tools=acted||checking?null:[{index:0,id:randomUUID(),type:'function',function:{name:'bash',arguments:JSON.stringify({command,description:'验证独立任务'})}}];
    const content=checking?JSON.stringify({status:'complete',reason:'实际命令已经完成',evidence:['COMMAND_ISOLATION_PROOF'],remaining:[],nextAction:''}):'COMMAND_ISOLATION_DONE';
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [delta,finish]of [[tools?{role:'assistant',tool_calls:tools}:{role:'assistant',content},null],[{},tools?'tool_calls':'stop']]) {
      res.write(`data: ${JSON.stringify({id:randomUUID(),model:body.model,choices:[{index:0,delta,finish_reason:finish}],...(finish?{usage:{prompt_tokens:20,completion_tokens:10}}:{})})}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={modelKey:'test/command-isolation',providerId:'test',model:'command-isolation',api:'openai-completions',apiKey:'SYNTHETIC_ONLY',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,thinkingLevel:'off'};
  const store={list:async()=>({defaultModelId:config.modelKey}),resolveStrict:async()=>({ok:true,config})};
  const policySnapshot=await freezeModelPolicy({store,modelKey:config.modelKey});
  const modelPlan=await hydrateModelPlan(resolveModelPlan(policySnapshot),store);
  const runtime=createAgentRuntime({userDataDir,getProfiles:()=>store,resolveCapabilities:async()=>({features:{},extensionConfig:{}}),getAccessService:()=>null,
    loadArchiveAgent:()=>null,loadArchiveTurns:()=>[],saveArchiveAgent:()=>true,log:{warn:message=>warnings.push(message)}});
  t.after(async()=>{
    try {await runtime.close();}
    finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
  });
  async function start(conversationId,runId) {
    const ctx={conversationId,runId,generation:1,config,policySnapshot,modelPlan,inputSource:'text',workspace:{id:'isolation',type:'project',dir}};
    await runtime.prepareExecution(ctx);
    const agent=await runtime.obtain(ctx);
    return {ctx,agent,run:()=>runtime.runRootTurn(conversationId,{userText:'执行验证命令并交付结果',inputId:runId+'-input'})};
  }
  return {runtime,start,warnings,requests};
}

test('a missing old conversation with unknown command cleanup does not block two new conversations',{timeout:30000},async t=>{
  const f=await fixture(t,{legacy:true});
  for(const cid of ['new-a','new-b']) {
    const task=await f.start(cid,cid+'-root');
    const result=await task.run();assert.equal(result.lastText,'COMMAND_ISOLATION_DONE');
    await f.runtime.completeConversation(cid,'completed',null,task.ctx.runId);
  }
  const state=await f.runtime.journal.snapshot();
  assert.equal(state.processes['legacy-command'].cleanupConfirmed,false);
  assert.equal(state.processes['legacy-command'].state,'unknown');
  assert.ok(f.warnings.some(message=>message.includes('missing-old-conversation')));
  assert.equal(Object.values(state.processes).filter(p=>p.state==='finished'&&p.cleanupConfirmed).length,2);
});

test('a command persistence failure disposes only its session; another conversation and an explicit new task can run',{timeout:30000},async t=>{
  const f=await fixture(t);
  const failed=await f.start('affected','failed-root');
  const processEnd=f.runtime.journal.processEnd;let injected=false;
  f.runtime.journal.processEnd=async(id,result)=>{
    const record=(await f.runtime.journal.snapshot()).processes[id];
    if(!injected&&record?.owner.rootRunId==='failed-root') {injected=true;throw Error('synthetic single-command save failure');}
    return processEnd(id,result);
  };
  await assert.rejects(failed.run(),{code:'cleanup-unconfirmed'});
  assert.equal(injected,true);assert.equal(failed.agent.isDisposed(),true);
  await f.runtime.completeConversation('affected','failed','command persistence failed','failed-root');
  const other=await f.start('unaffected','other-root');
  assert.equal((await other.run()).lastText,'COMMAND_ISOLATION_DONE');
  await f.runtime.completeConversation('unaffected','completed',null,'other-root');
  const next=await f.start('affected','explicit-next-root');
  assert.notEqual(next.agent,failed.agent);
  assert.equal((await next.run()).lastText,'COMMAND_ISOLATION_DONE');
  await f.runtime.completeConversation('affected','completed',null,'explicit-next-root');
  const state=await f.runtime.journal.snapshot();
  assert.equal(state.roots['failed-root'].status,'failed');
  assert.equal(state.roots['other-root'].status,'completed');
  assert.equal(state.roots['explicit-next-root'].status,'completed');
  for(const rootRunId of ['other-root','explicit-next-root']) {
    assert.ok(Object.values(state.processes).some(record=>record.owner.rootRunId===rootRunId&&record.state==='finished'&&record.cleanupConfirmed));
  }
});

test('a corrupt shared journal still blocks execution instead of being treated as one lost command',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-command-corrupt-journal-'));
  await fs.mkdir(path.join(dir,'runtime-v2'));
  await fs.writeFile(path.join(dir,'runtime-v2/run-journal.json'),'{corrupt');
  const runtime=createAgentRuntime({userDataDir:dir,getProfiles:()=>({}),resolveCapabilities:async()=>({}),getAccessService:()=>null});
  t.after(async()=>{await runtime.close().catch(()=>{});await fs.rm(dir,{recursive:true,force:true});});
  await assert.rejects(runtime.prepareExecution({conversationId:'new',runId:'new-root',generation:1}),/运行事实库读取失败/);
});
