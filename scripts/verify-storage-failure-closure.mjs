// Actual renderer -> IPC -> runtime -> filesystem. No credentials or installed data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {createServer} from 'vite';
import {_electron} from 'playwright-core';
import electronPath from 'electron';
import {GOAL_CHECK_SYSTEM} from '../src/main/agent-runtime/goal-driver.mjs';

const repo=path.resolve(import.meta.dirname,'..');
const output=path.join(repo,'.visual/workflow/storage-failure-closure');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-storage-closure-'));
await fs.mkdir(output,{recursive:true});
const report={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,
  node:process.version,platform:`${process.platform}/${process.arch}`,results:[],
  boundary:'Real dev/built renderer, preload, IPC, runtime, Pi and filesystem; local HTTP model. Atomic rename fails against an actual directory occupying each target.',
  gaps:['No installed-app, production Bot or device update.','ENOSPC/EACCES/EIO and hanging writes additionally covered by focused tests.']};
let app,page,vite,current,held;
const requests=[];
function answer(res,body,text,done=true) {
  res.write(`data: ${JSON.stringify({id:'storage-check',model:body.model,choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})}\n\n`);
  if(done) {
    res.write(`data: ${JSON.stringify({id:'storage-check',model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10}})}\n\n`);
    res.end('data: [DONE]\n\n');
  }
}
const server=http.createServer(async(req,res)=>{
  try {
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw),checking=JSON.stringify(body.messages.filter(m=>m.role==='system')).includes(GOAL_CHECK_SYSTEM);
    const main=Boolean(body.tools?.length);if(main)requests.push(body);
    res.writeHead(200,{'content-type':'text/event-stream'});
    if(checking)answer(res,body,JSON.stringify({status:'complete',reason:'实际响应已经输出',evidence:['模型输出了结果'],remaining:[],nextAction:''}));
    else if(main&&JSON.stringify(body.messages).includes('STORAGE_FAULT')&&!JSON.stringify(body.messages).includes('EXPLICIT_AFTER_RECOVERY')) {
      answer(res,body,'写入失败前已经输出的结果。',false);held={res,body};
    } else answer(res,body,main?'EXPLICIT_RECOVERY_DONE':'存储收尾验证');
  }catch(error){current?.errors.push(String(error.stack));res.destroy();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
const wait=async(predicate,label,ms=30000)=>{
  const deadline=Date.now()+ms;
  while(Date.now()<deadline){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,40));}
  throw new Error(`Timeout: ${label}`);
};
const input=()=>page.locator('textarea.text-composer-input');
const flow=id=>page.evaluate(id=>window.hemiVoice.flowGetSnapshot(id),id);
const command=(id,command)=>page.evaluate(({id,command})=>window.hemiVoice.flowCommand(id,command),{id,command});
const check=name=>{current.checks.push(name);console.log(`PASS ${current.mode}: ${name}`);};
try {
  vite=await createServer({configFile:path.join(repo,'vite.config.ts'),cacheDir:path.join(root,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});
  await vite.listen();
  for(const mode of ['dev','built']) {
    held=null;current={mode,checks:[],errors:[]};report.results.push(current);
    const profile=path.join(root,mode);await fs.mkdir(profile,{recursive:true});
    await fs.writeFile(path.join(profile,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',completedAt:Date.now()}));
    await fs.writeFile(path.join(profile,'appearance.json'),JSON.stringify({schemaVersion:1,skinId:'classic',mode:'light'}));
    await fs.writeFile(path.join(profile,'doubao-asr.json'),JSON.stringify({globalPushToTalkEnabled:false}));
    await fs.writeFile(path.join(profile,'text-model-profiles.json'),JSON.stringify({version:3,defaultModelId:'storage/main',lastConversationModelKey:'storage/main',providers:[{
      id:'storage',name:'存储收尾验证',api:'openai-completions',baseUrl,models:[{id:'main',model:'storage',thinkingLevel:'off',supportsVision:false}],
    }]}));
    const env={...process.env,HEMI_USER_DATA_DIR:profile,HEMI_TEST_MIC_GRANT:'1',HEMI_BOT_AUTO_UPDATE:'0',HEMI_LLM_API_KEY:'SYNTHETIC_ONLY',HEMI_LLM_BASE_URL:baseUrl,HEMI_LLM_MODEL:'storage'};
    if(mode==='dev')env.VITE_DEV_SERVER_URL=vite.resolvedUrls.local[0];else delete env.VITE_DEV_SERVER_URL;
    const start=async()=>{
      app=await _electron.launch({executablePath:electronPath,args:['.'],cwd:repo,env});
      await wait(()=>{page=app.windows().find(p=>/^(http|file):/.test(p.url())&&!new URL(p.url()).searchParams.has('mode'));return page;},'main window');
      page.setDefaultTimeout(10000);page.on('pageerror',error=>current.errors.push(error.message));
      await input().waitFor();
    };
    await start();current.renderer=page.url();
    await page.evaluate(baseUrl=>window.hemiVoice.saveModelProfile({id:'storage',name:'存储收尾验证',api:'openai-completions',baseUrl,apiKey:'SYNTHETIC_ONLY',models:[{id:'main',model:'storage',thinkingLevel:'off',supportsVision:false}],makeDefault:true}),baseUrl);
    await page.reload();await input().waitFor();
    await input().fill('STORAGE_FAULT 保留当前结果');await input().press('Enter');
    await wait(()=>held,'model request started');
    const cid=await wait(()=>page.evaluate(async()=>{
      const sessions=(await window.hemiVoice.listConversations()).sessions;
      return sessions.find(s=>s.title.includes('STORAGE_FAULT'))?.id;
    }),'conversation identity');
    const before=await flow(cid),runId=before.activeRunId;
    const queued=await command(cid,{type:'send',input:{text:'QUEUED_MUST_NOT_REPLAY'}});assert.equal(queued.disposition,'queued');
    const file=path.join(profile,'runtime-v2/conversations',cid+'.json'),journal=path.join(profile,'runtime-v2/run-journal.json');
    for(const target of [file,journal]){await fs.rename(target,target+'.last-good');await fs.mkdir(target);}
    const count=requests.length;
    const {res,body}=held;held=null;answer(res,body,'当前生成结束。');
    const closed=await wait(async()=>{const s=await flow(cid);return s.phase==='idle'&&s.runs[runId].outcome==='failed'?s:null;},'failed run closes despite terminal persistence failure');
    assert.equal(closed.activeRunId,null);assert.equal(closed.queuePaused,true);assert.equal(closed.pending.length,1);
    assert.ok(JSON.stringify(closed.timeline).includes('写入失败前已经输出的结果'));
    check('actual filesystem failure closes the run, preserves output and pauses accepted input');
    await page.locator('.turn-error-notice').last().waitFor();
    assert.doesNotMatch(await page.locator('.turn-error-retry').last().innerText(),/发送|重试中/);
    assert.equal(await page.locator('.streaming-copy').count(),0);
    await page.screenshot({path:path.join(output,mode+'-failed.png')});
    check('renderer shows the storage failure without an active retry or streaming cursor');
    for(const target of [journal,file]){await fs.rm(target,{recursive:true});await fs.rename(target+'.last-good',target);}
    await wait(async()=>{
      const saved=JSON.parse(await fs.readFile(file,'utf8')),state=JSON.parse(await fs.readFile(journal,'utf8'));
      return saved.flow?.phase==='idle'&&saved.flow.runs[runId]?.outcome==='failed'&&state.roots[runId]?.status==='failed';
    },'both stores retry pending terminal state');
    assert.equal(requests.length,count,'state recovery must not repeat model calls');
    check('storage recovery saves both terminal records without replaying a model or queued input');
    await page.reload();await input().waitFor();
    const afterReload=await flow(cid);assert.equal(afterReload.runs[runId].outcome,'failed');assert.equal(afterReload.queuePaused,true);
    await app.close();app=null;await start();
    const afterRestart=await flow(cid);assert.equal(afterRestart.runs[runId].outcome,'failed');assert.equal(afterRestart.pending.length,1);assert.equal(afterRestart.queuePaused,true);
    assert.equal(requests.length,count);check('renderer reload and process restart preserve failure and leave queued work paused');
    // An explicit new command is admitted once after state persistence recovers.
    const next=await command(cid,{type:'send',input:{text:'EXPLICIT_AFTER_RECOVERY'}});assert.equal(next.ok,true);
    if(next.disposition==='queued')await command(cid,{type:'promoteInput',inputId:next.inputId});
    await wait(async()=>{const s=await flow(cid);return Object.values(s.runs).some(r=>r.runId!==runId&&r.outcome==='completed');},'explicit new run completes');
    assert.equal(requests.length,count+1);check('explicitly requested new work succeeds once after recovery');
    await app.close();app=null;
  }
  assert.ok(report.results.every(result=>result.errors.length===0));report.ok=true;
}catch(error){report.ok=false;report.error=String(error.stack);throw error;}
finally {
  await app?.close().catch(()=>{});await vite?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  report.finishedAt=new Date().toISOString();report.environmentRoot=root;
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
}
