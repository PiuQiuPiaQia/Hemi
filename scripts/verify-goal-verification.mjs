// Real renderer -> preload/IPC/controller -> shared runtime/Pi/HTTP/files.
// Only the model service is synthetic. Run with --dev and without it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {_electron} from 'playwright-core';
import electronPath from 'electron';
import {GOAL_CHECK_SYSTEM} from '../src/main/agent-runtime/goal-driver.mjs';

const mode=process.argv.includes('--dev')?'dev':'built';
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hemi-verifier-ui-')));
const output=path.resolve('.visual/workflow/goal-verification/fail-open',mode);
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(root,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',permissionChoice:'skipped',completedAt:Date.now()}));
fs.writeFileSync(path.join(root,'appearance.json'),JSON.stringify({schemaVersion:1,skinId:'classic',mode:'light'}));
const report={mode,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(),workingTree:true,
  node:process.version,platform:`${process.platform}/${process.arch}`,checks:[],errors:[]};
const markers=['VERIFIER_BAD','VERIFIER_HTTP','VERIFIER_CONTINUE','VERIFIER_CANCEL'];
const checks=new Map(),operations=new Map(),requests=[];
let app,page,vite,release;
const workspace=path.join(root,'workspace/default');fs.mkdirSync(workspace,{recursive:true});
const proof=marker=>path.join(workspace,`${marker}.txt`);
const verdict=done=>({status:done?'complete':'continue',reason:done?'实际文件已写入并核对':'用户要求的文件尚未写入',
  evidence:[done?'真实 write 工具回执':'目前只有说明'],remaining:done?[]:['写入指定文件'],nextAction:done?'':'调用 write 写入指定文件'});
function answer(res,body,content,tool){
  if(res.destroyed)return;
  res.writeHead(200,{'content-type':'text/event-stream'});
  const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'write-proof',type:'function',function:{name:'write',arguments:JSON.stringify(tool)}}]}:{role:'assistant',content};
  for(const [value,finish]of [[delta,null],[{},tool?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:'verification',model:body.model,
    choices:[{index:0,delta:value,finish_reason:finish}],...(finish?{usage:{prompt_tokens:20,completion_tokens:10}}:{})})}\n\n`);
  res.end('data: [DONE]\n\n');
}
const server=http.createServer(async(req,res)=>{
  try{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw),text=JSON.stringify(body.messages);
    const checking=body.messages.some(message=>message.role==='system'&&JSON.stringify(message.content).includes(GOAL_CHECK_SYSTEM));
    const marker=markers.find(value=>text.includes(value));
    if(!marker){answer(res,body,'验证对话');return;}
    requests.push({marker,checking,main:Boolean(body.tools?.length)});
    if(checking){
      checks.set(marker,(checks.get(marker)??0)+1);
      if(marker==='VERIFIER_CANCEL'){release=()=>answer(res,body,'invalid json');return;}
      if(marker==='VERIFIER_HTTP'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic verifier outage'}}));return;}
      answer(res,body,marker==='VERIFIER_BAD'?'invalid json':JSON.stringify(verdict(fs.existsSync(proof(marker)))));return;
    }
    if(!body.tools?.length){answer(res,body,'验证对话');return;}
    if(marker==='VERIFIER_CONTINUE'&&!checks.has(marker)){answer(res,body,'目前只有计划，文件还没有写入。');return;}
    if(!fs.existsSync(proof(marker))){
      if(operations.has(marker)){
        report.toolFailure=body.messages.filter(message=>message.role==='tool');answer(res,body,'工具未写入所需文件。');return;
      }
      operations.set(marker,1);answer(res,body,null,{path:proof(marker),content:'REAL_EXECUTION_ONCE'});return;
    }
    answer(res,body,'已写入并核对指定文件。');
  }catch(error){report.errors.push(String(error.stack));res.destroy();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
const wait=async(read,label)=>{
  const end=Date.now()+30000;
  while(Date.now()<end){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error(`Timeout: ${label}`);
};
const input=()=>page.locator('textarea.text-composer-input');
const flow=id=>page.evaluate(id=>window.hemiVoice.flowGetSnapshot(id),id);
const journal=()=>JSON.parse(fs.readFileSync(path.join(root,'runtime-v2/run-journal.json'),'utf8'));
async function launch(){
  app=await _electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,HEMI_USER_DATA_DIR:root,HEMI_TEST_MIC_GRANT:'1',
    HEMI_LLM_API_KEY:'SYNTHETIC_ONLY',HEMI_LLM_BASE_URL:baseUrl,HEMI_LLM_MODEL:'verifier-ui'}});
  await wait(()=>{page=app.windows().find(window=>/^(?:http|file):/.test(window.url())&&!new URL(window.url()).searchParams.has('mode'));return page;},'main window');
  page.on('pageerror',error=>report.errors.push(error.message));await input().waitFor();
  report.environment=await app.evaluate(()=>({electron:process.versions.electron,node:process.versions.node}));
}
async function send(marker){
  await page.getByRole('button',{name:'新建对话',exact:true}).click();await input().fill(`${marker} 写入指定验证文件。`);await input().press('Enter');
  return wait(()=>page.evaluate(async marker=>{
    for(const item of (await window.hemiVoice.listConversations()).sessions){
      const record=await window.hemiVoice.openConversation(item.id);
      if(record.turns.some(turn=>turn.author==='user'&&turn.text.includes(marker)))return record.id;
    }
  },marker),'persisted user input');
}
try{
  if(mode==='dev'){
    const {createServer}=await import('vite');
    vite=await createServer({configFile:path.resolve('vite.config.ts'),cacheDir:path.join(root,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});
    await vite.listen();process.env.VITE_DEV_SERVER_URL=vite.resolvedUrls.local[0];
  }else delete process.env.VITE_DEV_SERVER_URL;
  await launch();
  await page.evaluate(baseUrl=>window.hemiVoice.saveModelProfile({id:'verifier-ui',name:'校验验证',api:'openai-completions',baseUrl,apiKey:'SYNTHETIC_ONLY',
    models:[{id:'main',model:'verifier-ui',thinkingLevel:'off',supportsVision:false}],makeDefault:true}),baseUrl);
  await page.reload();await input().waitFor();
  for(const marker of markers){
    const id=await send(marker);
    if(marker==='VERIFIER_CANCEL'){
      await wait(()=>release,'held verifier request');
      await page.evaluate(id=>window.hemiVoice.flowCommand(id,{type:'stop'}),id);release();
    }
    const snapshot=await wait(async()=>{const value=await flow(id);return value.phase==='idle'&&Object.keys(value.runs).length?value:null;},'settled goal');
    const run=Object.values(snapshot.runs)[0],goal=journal().roots[run.runId].goal;
    assert.equal(run.outcome,marker==='VERIFIER_CANCEL'?'stopped':'completed');
    assert.equal(fs.readFileSync(proof(marker),'utf8'),'REAL_EXECUTION_ONCE');assert.equal(operations.get(marker),1);
    assert.equal(snapshot.timeline.filter(item=>item.kind==='user').length,1);
    assert.equal(snapshot.timeline.flatMap(item=>item.parts??[]).filter(part=>part.kind==='notice'&&part.level==='error').length,0);
    assert.equal(await page.locator('.turn-error-notice').count(),0);
    if(marker==='VERIFIER_BAD'||marker==='VERIFIER_HTTP'){
      assert.equal(checks.get(marker),1);assert.equal(goal.verifications[0].verificationBypassed,true);
      assert.equal(goal.verificationAttempts[0].bypassed,true);assert.deepEqual(goal.verifications[0].evidence,[]);
    }else if(marker==='VERIFIER_CONTINUE')assert.deepEqual(goal.verifications.map(item=>item.status),['continue','complete']);
    else assert.notEqual(goal.phase,'complete');
    await page.screenshot({path:path.join(output,`${marker}.png`)});report.checks.push(marker);
    if(marker==='VERIFIER_BAD'){
      const executionCount=()=>requests.filter(request=>request.main||request.checking).length;
      const before=executionCount();await app.close();await launch();assert.equal((await flow(id)).runs[run.runId].outcome,'completed');
      assert.equal(executionCount(),before);assert.equal(operations.get(marker),1);report.checks.push('restart preserves bypass without replay');
    }
  }
  assert.deepEqual(report.errors,[]);report.result='PASS';console.log(JSON.stringify({mode,result:'PASS',checks:report.checks}));
}catch(error){report.result='FAIL';report.failure=String(error.stack);throw error;}
finally{
  await app?.close().catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await vite?.close();
  report.requests=requests;fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));fs.rmSync(root,{recursive:true,force:true});
}
