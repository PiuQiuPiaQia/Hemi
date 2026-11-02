// Actual desktop IPC + renderer regression: large child details, manual reads,
// complete QAs and continuous upward input. Synthetic, isolated data only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createServer} from 'vite';
import {_electron} from 'playwright-core';
import electronPath from 'electron';
import {initializeRuntimeStorage} from '../src/main/agent-runtime/storage-migration.mjs';
import {createFlowSnapshot} from '../src/shared/conversation-flow.mjs';

const repo=path.resolve(import.meta.dirname,'..');
const out=path.join(repo,'.visual/workflow/history-reading');
await fs.mkdir(out,{recursive:true});
const report={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:process.platform+'/'+process.arch,renderers:[]};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(id,title,{oversizedQuestion=false}={}){
 const flow=createFlowSnapshot({conversationId:id}),turns=[],at=Date.now()-100000;
 for(let i=0;i<100;i++){
  const runId='run-'+i,inputId='input-'+i,itemId='answer-'+i;
  const text=oversizedQuestion&&i===99?'Oversized final question. '.repeat(14000):'Question '+i;
  const content='Answer '+i+'\n\n'+ 'Synthetic reading content. '.repeat(100);
  flow.runs[runId]={runId,source:'user',startedAt:at+i,closedAt:at+i+1,outcome:'completed',inputIds:[inputId]};
  flow.timeline.push({kind:'user',id:inputId,runId,text,inputSource:'text',attachmentIds:[],acceptedAt:at+i,deliveredAt:at+i});
  const parts=[{kind:'text',partId:'text-'+i,phase:'final_answer',content}];
  if(!oversizedQuestion){
   const taskId='task-'+Math.floor(i/10),toolCallId='call-'+Math.floor(i/10);
   parts.push({kind:'delegation',partId:'delegation-'+i,taskId,toolCallId});
   const conversation={messages:[{id:'child-question',author:'user',text:'Synthetic task question',parts:[]},{id:'child-answer',author:'assistant',text:'Synthetic child detail. '.repeat(14000),parts:[]}]};
   const execution={taskId,toolCallId,conversationId:id,rootRunId:runId,agent:'researcher',agentTitle:'Synthetic researcher',phase:'terminal',outcome:'complete',taskText:'Synthetic child '+taskId,conversation,runs:1};
   flow.tasks[taskId]={...execution,executions:{[toolCallId]:execution}};
  }
  flow.timeline.push({kind:'assistant',itemId,runId,afterInputId:inputId,parts});
  turns.push({id:inputId,runId,author:'user',text,createdAt:at+i},{id:itemId,runId,author:'hemi',text:content,createdAt:at+i+1});
 }
 flow.revision=1;
 return {id,title,customTitle:title,version:2,createdAt:at,updatedAt:at+(oversizedQuestion?0:10000),turns,flow};
}
try{for(const mode of process.argv.includes('--built-only')?['built']:process.argv.includes('--dev-only')?['dev']:['dev','built']){
 const userData=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-history-reading-'));
 const result={mode,checks:[],errors:[]};report.renderers.push(result);
 let app,server;
 const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};
 try{
  await initializeRuntimeStorage({userDataDir:userData});
  const dir=path.join(userData,'runtime-v2/conversations');await fs.mkdir(dir,{recursive:true});
  for(const record of [fixture('conv-heavy','Heavy child history'),fixture('conv-continuation','Long QA history',{oversizedQuestion:true})])await fs.writeFile(path.join(dir,record.id+'.json'),JSON.stringify(record));
  await fs.writeFile(path.join(userData,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',permissionChoice:'skipped',completedAt:Date.now()}));
  if(mode==='dev'){server=await createServer({configFile:path.join(repo,'vite.config.ts'),cacheDir:path.join(out,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});await server.listen();}
  const env={...process.env,HEMI_USER_DATA_DIR:userData,HEMI_TEST_MIC_GRANT:'1',HEMI_BOT_AUTO_UPDATE:'0',HEMI_LLM_API_KEY:'SYNTHETIC_ONLY',HEMI_LLM_BASE_URL:'http://127.0.0.1:9/v1',HEMI_LLM_MODEL:'fixture'};
  if(server)env.VITE_DEV_SERVER_URL=server.resolvedUrls.local[0];else delete env.VITE_DEV_SERVER_URL;
  app=await _electron.launch({executablePath:electronPath,args:['.'],cwd:repo,env});
  let page;const deadline=Date.now()+25000;
  while(!page&&Date.now()<deadline){page=app.windows().find(p=>{try{return !new URL(p.url()).searchParams.has('mode')&&!p.url().startsWith('about:');}catch{return false;}});if(!page)await pause(30);}
  assert.ok(page);page.setDefaultTimeout(25000);page.on('pageerror',e=>{if(!e.message.includes('ResizeObserver loop'))result.errors.push(e.message)});
  await page.getByRole('textbox',{name:'输入消息',exact:true}).waitFor();
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('mode='));w.setContentSize(1440,900);w.show();w.focus();});
  await app.evaluate(async(_electron,url)=>{
   const {getConversationFlowService}=process.getBuiltinModule('module').createRequire(url)('./conversation-flow-service.mjs');
   const service=getConversationFlowService(),original=service.historyFor.bind(service);globalThis.__historyPages=[];
   service.historyFor=(...args)=>{const page=original(...args);globalThis.__historyPages.push({questions:page.snapshot.timeline.filter(item=>item.kind==='user').length,first:page.snapshot.timeline[0]?.kind,last:page.snapshot.timeline.at(-1)?.kind});return page;};
  },pathToFileURL(path.join(repo,'src/main/services/conversation-flow-service.mjs')).href);
  await page.waitForFunction(()=>Number(document.querySelector('.h67-virtual-transcript')?.dataset.virtualTotal)>=30);
  const rows=()=>page.locator('.h67-virtual-transcript').evaluate(el=>Number(el.dataset.virtualTotal));
  result.initialRows=await rows();assert.ok(result.initialRows<200);check('large child execution details keep a useful initial QA page');
  const viewport=page.locator('[data-transcript-scroll] [data-slot="scroll-area-viewport"]');
  // Each new upward event belongs to the same touch gesture. No second click,
  // wheel pause, pointerdown or scrollend is needed to fetch the next page.
  await viewport.evaluate(v=>{v.scrollTop=0;v.dispatchEvent(new TouchEvent('touchstart',{touches:[new Touch({identifier:1,target:v,clientY:100})],bubbles:true}));v.dispatchEvent(new TouchEvent('touchmove',{touches:[new Touch({identifier:1,target:v,clientY:180})],bubbles:true}));});
  await page.waitForFunction(n=>Number(document.querySelector('.h67-virtual-transcript').dataset.virtualTotal)>n,result.initialRows);
  await page.waitForFunction(()=>!document.querySelector('.h24-history-load[aria-busy=true]'));
  const firstRead=await rows();
  await viewport.evaluate(v=>{v.scrollTop=0;v.dispatchEvent(new TouchEvent('touchmove',{touches:[new Touch({identifier:1,target:v,clientY:260})],bubbles:true}));});
  await page.waitForFunction(n=>Number(document.querySelector('.h67-virtual-transcript').dataset.virtualTotal)>n,firstRead);
  check('continuous upward reading fetches successive history pages');
  const stable=await rows();await page.waitForTimeout(350);assert.equal(await rows(),stable);check('programmatic prepend does not drain remaining history');
  await page.getByRole('button',{name:'回到底部',exact:true}).click();
  await page.waitForFunction(n=>Number(document.querySelector('.h67-virtual-transcript').dataset.virtualTotal)===n,result.initialRows);check('returning to live end still reclaims history');
  await page.locator('.h24-sidebar-open').filter({hasText:'Long QA history'}).click();
  await page.waitForFunction(()=>Number(document.querySelector('.h67-virtual-transcript')?.dataset.virtualTotal)===20);
  const longInitial=await rows();
  await viewport.evaluate(v=>v.scrollTop=0);
  await page.getByRole('button',{name:'加载更早消息',exact:true}).click();
  await page.waitForFunction(n=>Number(document.querySelector('.h67-virtual-transcript').dataset.virtualTotal)>n,longInitial);
  await page.waitForTimeout(450);assert.equal(await rows(),longInitial+20,'a manual read adds ten complete QAs and is retained');
  check('a long QA stays whole and manual loading adds ten complete QAs');
  await viewport.evaluate(v=>v.scrollTop=0);
  const prior=await rows();await viewport.evaluate(v=>v.dispatchEvent(new WheelEvent('wheel',{deltaY:-80,bubbles:true})));
  await page.waitForFunction(n=>Number(document.querySelector('.h67-virtual-transcript').dataset.virtualTotal)>n,prior);
  await page.waitForTimeout(200);assert.ok(await rows()>prior);check('upward reading continues after a manual continuation read');
  await app.evaluate(async(_electron,url)=>{
   const {getConversationFlowService}=process.getBuiltinModule('module').createRequire(url)('./conversation-flow-service.mjs');
   const controller=getConversationFlowService().controllerFor('conv-continuation'),runId='new-own-send';
   controller.applyFact({type:'run-preparing',runId,source:'user',inputIds:['new-own-user'],at:Date.now()});
   controller.applyFact({type:'run-started',runId,at:Date.now()});
   controller.applyFact({type:'input-delivered',runId,input:{inputId:'new-own-user',text:'New own send after history reading',inputSource:'text',attachmentIds:[]},at:Date.now()});
   controller.applyFact({type:'run-closed',runId,outcome:'completed',at:Date.now()});
  },pathToFileURL(path.join(repo,'src/main/services/conversation-flow-service.mjs')).href);
  await page.getByText('New own send after history reading',{exact:true}).waitFor();
  await page.waitForTimeout(250);
  const userBox=await page.getByText('New own send after history reading',{exact:true}).boundingBox(),viewBox=await viewport.boundingBox();
  result.ownSend={userBox,viewBox};
  assert.ok(userBox.y>=viewBox.y&&userBox.y+userBox.height<=viewBox.y+viewBox.height+2,'new own message is positioned inside the viewport');
  check('a newly appended user still returns to the live end');
  result.pages=await app.evaluate(()=>globalThis.__historyPages);
  assert.ok(result.pages.length>=4);assert.ok(result.pages.every(page=>page.questions===10&&page.first==='user'&&page.last==='assistant'));
  check('actual IPC history pages contain ten whole question-answer groups');
  assert.deepEqual(result.errors,[]);
 }catch(error){result.error=error.stack;result.windows=await Promise.all((app?.windows()??[]).map(async p=>({url:p.url(),text:(await p.locator('body').innerText().catch(()=>''))?.slice(0,2000)})));result.log=(await fs.readFile(path.join(userData,'hemi.log'),'utf8').catch(()=>''))?.slice(-4000);console.error(JSON.stringify(result,null,2));throw error;}
 finally{await app?.close();await server?.close();await fs.rm(userData,{recursive:true,force:true});}
}}finally{await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
