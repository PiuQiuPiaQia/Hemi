// Actual desktop IPC and renderer. Closing rejects input without accepting a
// stopped run; a fresh process preserves the draft and only sends explicitly.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createServer} from 'vite';
import {_electron} from 'playwright-core';
import electronPath from 'electron';
import {initializeRuntimeStorage} from '../src/main/agent-runtime/storage-migration.mjs';
import {createFlowSnapshot} from '../src/shared/conversation-flow.mjs';
import {GOAL_CHECK_SYSTEM} from '../src/main/agent-runtime/goal-driver.mjs';
const repo=path.resolve(import.meta.dirname,'..'),out=path.join(repo,'.visual/workflow/quit-admission');
await fs.mkdir(out,{recursive:true});
const report={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,environment:process.platform+'/'+process.arch,
 commands:['node --test src/main/services/conversation-turns.test.mjs src/main/services/conversation-flow-service.test.mjs src/main/services/conversation-controller.test.mjs','npm run build','node scripts/verify-quit-admission.mjs'],
 gaps:['No installed application update, production Bot deployment or device verification.','The earlier incomplete quit was not reproduced; shutdown admission and recovery are verified with the actual local runtime.'],results:[]};
let requests=0;
const model=http.createServer(async(req,res)=>{
 try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests++;
  const checking=JSON.stringify(body.messages.filter(m=>m.role==='system')).includes(GOAL_CHECK_SYSTEM);
  const text=checking?JSON.stringify({status:'complete',reason:'已输出答复',evidence:['回复已生成'],remaining:[],nextAction:''}):'FRESH_PROCESS_REPLY';
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write(`data: ${JSON.stringify({id:'quit-fixture',model:body.model,choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})}\n\n`);
  res.write(`data: ${JSON.stringify({id:'quit-fixture',model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10}})}\n\n`);
  res.end('data: [DONE]\n\n');
 }catch(error){res.destroy(error);}
});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
const baseUrl=`http://127.0.0.1:${model.address().port}/v1`,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{for(const mode of ['dev','built']){
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-quit-admission-'));
 const initialRequests=requests;
 const result={mode,checks:[],errors:[]};report.results.push(result);let app,page,vite;
 const check=name=>{result.checks.push(name);console.log('PASS',mode,name)};
 try{
  await initializeRuntimeStorage({userDataDir:profile});
  const dir=path.join(profile,'runtime-v2/conversations');await fs.mkdir(dir,{recursive:true});
  const seed=createFlowSnapshot({conversationId:'conv-quit'});
  seed.runs.seed={runId:'seed',source:'user',inputIds:['seed-question'],startedAt:1,closedAt:2,outcome:'completed'};
  seed.timeline=[{kind:'user',id:'seed-question',runId:'seed',text:'Seed question',inputSource:'text',attachmentIds:[],acceptedAt:1,deliveredAt:1},{kind:'assistant',itemId:'seed-answer',runId:'seed',afterInputId:'seed-question',parts:[{kind:'text',partId:'seed-text',content:'Seed answer',phase:'final_answer'}]}];
  await fs.writeFile(path.join(dir,'conv-quit.json'),JSON.stringify({id:'conv-quit',version:2,title:'Quit admission fixture',customTitle:'Quit admission fixture',createdAt:Date.now(),updatedAt:Date.now(),turns:[{id:'seed-question',runId:'seed',author:'user',text:'Seed question',createdAt:1},{id:'seed-answer',runId:'seed',author:'hemi',text:'Seed answer',createdAt:2}],flow:seed}));
  await fs.writeFile(path.join(profile,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',permissionChoice:'skipped',completedAt:Date.now()}));
  if(mode==='dev'){vite=await createServer({configFile:path.join(repo,'vite.config.ts'),cacheDir:path.join(out,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});await vite.listen();}
  const env={...process.env,HEMI_USER_DATA_DIR:profile,HEMI_TEST_MIC_GRANT:'1',HEMI_BOT_AUTO_UPDATE:'0',HEMI_LLM_API_KEY:'SYNTHETIC_ONLY',HEMI_LLM_BASE_URL:baseUrl,HEMI_LLM_MODEL:'fixture'};
  if(vite)env.VITE_DEV_SERVER_URL=vite.resolvedUrls.local[0];else delete env.VITE_DEV_SERVER_URL;
  const launch=async()=>{
   app=await _electron.launch({executablePath:electronPath,args:['.'],cwd:repo,env});
   const until=Date.now()+25000;
   while(Date.now()<until){page=app.windows().find(p=>/^(http|file):/.test(p.url())&&!new URL(p.url()).searchParams.has('mode'));if(page)break;await pause(30);}
   assert.ok(page);page.on('pageerror',e=>result.errors.push(e.message));await page.getByRole('textbox',{name:'输入消息',exact:true}).waitFor();
  };
  await launch();
  await page.evaluate(baseUrl=>window.hemiVoice.saveModelProfile({id:'fixture',name:'Quit fixture',api:'openai-completions',baseUrl,apiKey:'SYNTHETIC_ONLY',models:[{id:'main',model:'fixture',thinkingLevel:'off',supportsVision:false}],makeDefault:true}),baseUrl);
  await page.reload();await page.getByRole('textbox',{name:'输入消息',exact:true}).waitFor();
  const moduleUrl=pathToFileURL(path.join(repo,'src/main/ipc/llm.ipc.mjs')).href;
  const legacy=await app.evaluate(async(_electron,url)=>{
   const require=process.getBuiltinModule('module').createRequire(url),llm=require('./llm.ipc.mjs');
   await llm.abortActiveTextModelTurn();
   const service=require('../services/conversation-flow-service.mjs').getConversationFlowService();
   return service.submitChat({conversationId:'conv-quit',inputSource:'text',messages:[{role:'user',content:'LATE_LEGACY_INPUT'}]});
  },moduleUrl);
  assert.equal(legacy.ok,false);assert.equal(legacy.code,'app-closing');check('closed execution service rejects legacy chat before accepting a run');
  await app.evaluate((_electron,url)=>{process.getBuiltinModule('module').createRequire(url)('../state.mjs').state.isQuitting=true;},moduleUrl);
  const declined=await page.evaluate(()=>window.hemiVoice.flowCommand('conv-quit',{type:'send',input:{inputId:'late-flow',text:'LATE_FLOW_INPUT',inputSource:'text'}}));
  assert.equal(declined.ok,false);assert.equal(declined.code,'app-closing');check('actual flow IPC rejects new work while quitting');
  const input=page.getByRole('textbox',{name:'输入消息',exact:true});await input.fill('DRAFT_MUST_SURVIVE_QUIT');await input.press('Enter');
  await page.getByText(/Hemi 正在退出/).first().waitFor();assert.equal(await input.inputValue(),'DRAFT_MUST_SURVIVE_QUIT');
  const flow=await page.evaluate(()=>window.hemiVoice.flowGetSnapshot('conv-quit'));
  assert.equal(flow.timeline.length,2);assert.equal(flow.pending.length,0);assert.equal(Object.keys(flow.runs).length,1);
  assert.equal(requests,initialRequests);check('UI preserves the refused draft and shows the closing reason without a stopped task');
  // Wait for the existing draft writer's durable receipt, not a fixed debounce.
  await page.waitForFunction(async()=> (await window.hemiVoice.getDraft('conv-quit'))?.text==='DRAFT_MUST_SURVIVE_QUIT');
  await app.evaluate(async({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>/^(http|file):/.test(w.webContents.getURL())&&!new URL(w.webContents.getURL()).searchParams.has('mode'));w.hide();app.emit('activate');app.emit('second-instance');await new Promise(r=>setTimeout(r,100));if(w.isVisible())throw new Error('quitting window reopened');});
  check('activation and second launch do not reopen a quitting window');
  await app.close();app=null;await launch();await pause(300);
  assert.equal(requests,initialRequests,'restart never silently resends a rejected input');
  result.restoredDraft=await page.evaluate(async()=>({resume:localStorage.getItem('hemi.conversation-resume.v1'),stored:await window.hemiVoice.getDraft('conv-quit'),input:document.querySelector('textarea.text-composer-input')?.value}));
  await page.locator('.h24-sidebar-open').filter({hasText:'Quit admission fixture'}).click();
  await page.waitForFunction(()=>document.querySelector('textarea.text-composer-input')?.value==='DRAFT_MUST_SURVIVE_QUIT');
  await page.getByRole('textbox',{name:'输入消息',exact:true}).press('Enter');
  await page.getByText('FRESH_PROCESS_REPLY',{exact:true}).waitFor({timeout:30000});
  check('fresh process restores the draft and executes only after an explicit send');
  assert.deepEqual(result.errors,[]);
 }catch(error){result.error=error.stack;result.log=(await fs.readFile(path.join(profile,'hemi.log'),'utf8').catch(()=>''))?.slice(-5000);throw error;}
 finally{await app?.close();await vite?.close();await fs.rm(profile,{recursive:true,force:true});}
}}finally{await new Promise(resolve=>model.close(resolve));await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
