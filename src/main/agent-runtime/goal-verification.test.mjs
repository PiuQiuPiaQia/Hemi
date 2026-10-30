import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createRunJournal} from './run-journal.mjs';
import {goalPolicy, verifyGoalCompletion} from './goal-driver.mjs';

const complete = {status:'complete',reason:'实际结果已核对',evidence:['真实命令回执已保存'],remaining:[],nextAction:''};
const json = JSON.stringify(complete);
async function fixture(t, api, responses) {
  const dir = await mkdtemp(path.join(os.tmpdir(),'hemi-verification-'));
  const requests = [], calls = [], owner = {conversationId:'verification',rootRunId:'root',generation:1};
  const journal = createRunJournal({dir});
  const server = http.createServer(async (req,res) => {
    let raw='';for await(const chunk of req)raw+=chunk;
    requests.push(JSON.parse(raw));
    const {content, finishReason='stop', httpStatus=200, stall=false} = responses[requests.length-1] ?? {content:'UNEXPECTED_REQUEST'};
    if(stall)return;
    if(httpStatus!==200){res.writeHead(httpStatus,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic service unavailable'}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    if (api === 'anthropic-messages') {
      const events = [
        {type:'message_start',message:{id:'check',role:'assistant',model:'verifier',content:[],usage:{input_tokens:10,output_tokens:0}}},
        {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
        {type:'content_block_delta',index:0,delta:{type:'text_delta',text:content}},
        {type:'content_block_stop',index:0},
        {type:'message_delta',delta:{stop_reason:finishReason==='length'?'max_tokens':'end_turn'},usage:{output_tokens:5}},
        {type:'message_stop'},
      ];
      for(const event of events)res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } else {
      res.write(`data: ${JSON.stringify({id:'check',model:'verifier',choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})}\n\n`);
      res.end(`data: ${JSON.stringify({id:'check',choices:[{index:0,delta:{},finish_reason:finishReason}],usage:{prompt_tokens:10,completion_tokens:5}})}\n\ndata: [DONE]\n\n`);
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const config = {modelKey:'test/verifier',providerId:'test',credentialRef:'test',model:'verifier',api,apiKey:'SYNTHETIC_ONLY',
    baseUrl:`http://127.0.0.1:${server.address().port}/v1`,thinkingLevel:'off'};
  const execution = {owner,journal,store:{resolveStrict:async()=>({ok:true,config})},plan:{role:'main',primary:config,allowedFallbacks:[]},budgets:{maxRequestsPerRun:1}};
  await journal.beginRoot(owner);await journal.beginGoal(owner,'核对已执行的操作',goalPolicy({maxRequests:1}));await journal.checkGoal(owner);
  const verify = () => verifyGoalCompletion({execution,objective:'核对已执行的操作',evidence:'SYNTHETIC_RECEIPT',signal:new AbortController().signal,onCall:call=>calls.push(call)});
  return {dir,owner,journal,verify,requests,calls,execution};
}

for(const api of ['openai-completions','anthropic-messages']) {
  test(`${api}: tolerates wrapped JSON without another HTTP request`,async t=>{
    for(const content of [json,`说明\n${json}\n结束`,JSON.stringify(json),JSON.stringify(`\x60\x60\x60json\n${json}\n\x60\x60\x60`)]) {
      const f=await fixture(t,api,[{content}]);
      assert.deepEqual(await f.verify(),complete);assert.equal(f.requests.length,1);
      assert.equal(f.calls[0].isError,false);
      assert.equal(f.requests[0].model,'verifier');assert.ok(!f.requests[0].tools?.length);
      assert.deepEqual(f.requests[0].tool_choice,api==='anthropic-messages'?{type:'none'}:'none');
    }
  });
  test(`${api}: malformed JSON fails open once, retains diagnostics, and fabricates no evidence`,async t=>{
    const f=await fixture(t,api,[{content:'SENSITIVE_PROVIDER_TEXT'}]);
    const verdict=await f.verify();
    assert.equal(verdict.status,'complete');assert.equal(verdict.verificationBypassed,true);
    assert.equal(verdict.verificationFailure,'goal-verdict-json');assert.deepEqual(verdict.evidence,[]);
    assert.equal(f.requests.length,1);assert.deepEqual(f.calls.map(call=>call.isError),[true]);
    const root=await f.journal.root(f.owner),attempt=root.goal.verificationAttempts[0];
    assert.equal(root.goal.phase,'checking');assert.equal(attempt.valid,false);assert.equal(attempt.bypassed,true);
    assert.equal(attempt.responseHash,createHash('sha256').update('SENSITIVE_PROVIDER_TEXT').digest('hex'));
    assert.equal(attempt.responseShape,'other');
    assert.ok(!(await readFile(path.join(f.dir,'run-journal.json'),'utf8')).includes('SENSITIVE_PROVIDER_TEXT'));
    await f.journal.recordGoalCheck(f.owner,verdict);await f.journal.finishRoot(f.owner,'completed');
    assert.equal((await f.journal.root(f.owner)).status,'completed');
    assert.equal(Object.values((await f.journal.snapshot()).requests).length,1);
  });
  test(`${api}: invalid verdict schema and truncated responses are recorded as bypasses`,async t=>{
    for(const response of [{content:''},{content:JSON.stringify({...complete,evidence:[]})},{content:json,finishReason:'length'}]) {
      const f=await fixture(t,api,[response]);
      const verdict=await f.verify();assert.equal(verdict.verificationBypassed,true);assert.equal(f.requests.length,1);
      const attempt=(await f.journal.root(f.owner)).goal.verificationAttempts[0];
      assert.equal(attempt.bypassed,true);assert.equal(attempt.valid,false);
    }
  });
  test(`${api}: an explicit valid incomplete verdict still returns continue`,async t=>{
    const next={status:'continue',reason:'还有用户要求的验证未做',evidence:['已有文件'],remaining:['读取核验文件'],nextAction:'调用 read 核验文件'};
    const f=await fixture(t,api,[{content:`检查结果：${JSON.stringify(next)}`}]);
    assert.deepEqual(await f.verify(),next);assert.equal(f.requests.length,1);
    assert.equal((await f.journal.root(f.owner)).goal.verificationAttempts[0].bypassed,false);
  });
  test(`${api}: provider HTTP failure fails open after the real request is settled`,async t=>{
    const f=await fixture(t,api,[{httpStatus:503}]);
    const verdict=await f.verify();assert.equal(verdict.verificationBypassed,true);assert.equal(f.requests.length,1);
    const rows=Object.values((await f.journal.snapshot()).requests);assert.equal(rows[0].httpStatus,503);assert.ok(rows[0].endedAt);
    assert.equal((await f.journal.root(f.owner)).goal.verificationAttempts[0].responseShape,'unavailable');
    await f.journal.recordGoalCheck(f.owner,verdict);await f.journal.finishRoot(f.owner,'completed');
  });
}

for(const method of ['requestStart','requestResponse','requestEnd','recordGoalVerificationAttempt'])test(`local ${method} failure must not become a successful verification bypass`,async t=>{
  const f=await fixture(t,'openai-completions',[{content:json}]);
  const error=new Error('SYNTHETIC_PERSISTENCE_FAILURE');f.journal[method]=async()=>{throw error;};
  await assert.rejects(f.verify(),actual=>actual===error);
  assert.equal((await f.journal.root(f.owner)).goal.verifications.length,0);
  if(method==='requestStart')assert.equal(f.requests.length,0);
});

test('request admission remains closed after a verifier call, even if its output is malformed',async t=>{
  const f=await fixture(t,'openai-completions',[{content:'not json'}]);
  await f.verify();await assert.rejects(f.verify(),/目标校验请求不可用/);assert.equal(f.requests.length,1);
});

test('connection timeout may bypass verification, but does not cancel the user goal',async t=>{
  const f=await fixture(t,'openai-completions',[{stall:true}]);
  // Leave admission/fsync time outside this deliberately stalled HTTP response.
  // A 30ms deadline can expire before dispatch when the full suite is busy.
  f.execution.budgets.connectionTimeoutMs=2000;
  const verdict=await f.verify();assert.equal(verdict.verificationBypassed,true);
  assert.equal(f.requests.length,1);
  assert.ok(Object.values((await f.journal.snapshot()).requests)[0].endedAt);
});
