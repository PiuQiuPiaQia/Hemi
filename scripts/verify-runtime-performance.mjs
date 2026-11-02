// Synthetic large-history benchmarks + actual desktop IPC/renderer lifecycle.
// Run after npm run build. No external model, production profile, or device.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createServer} from 'vite';
import {_electron} from 'playwright-core';
import electronPath from 'electron';
import {createRunJournal} from '../src/main/agent-runtime/run-journal.mjs';
import {createConversationStore} from '../src/main/history/conversation-store.mjs';
import {createFlowSnapshot} from '../src/shared/conversation-flow.mjs';
import {initializeRuntimeStorage} from '../src/main/agent-runtime/storage-migration.mjs';

const repo=path.resolve(import.meta.dirname,'..');
const out=path.join(repo,'.visual/workflow/runtime-performance');await fs.mkdir(out,{recursive:true});
const report={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,electron:process.versions.electron,platform:process.platform+'/'+process.arch,benchmarks:[],renderers:[]};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function measure(name,fn){
  let previous=performance.now(),lag=0;
  const timer=setInterval(()=>{const now=performance.now();lag=Math.max(lag,now-previous-5);previous=now;},5);
  await pause(15);const start=performance.now();
  try{await fn();const elapsed=performance.now()-start;await pause(15);const result={name,elapsedMs:+elapsed.toFixed(1),maxLoopLagMs:+Math.max(0,lag).toFixed(1)};report.benchmarks.push(result);console.log(result);return result;}
  finally{clearInterval(timer);}
}
function conversation(id,questions=120,bodySize=2000){
  const flow=createFlowSnapshot({conversationId:id}),turns=[];
  const now=Date.now()-questions*1000;
  for(let i=0;i<questions;i++){
    const runId='r'+i,u='u'+i,a='a'+i,text=`Answer ${i}\n\n`+'Synthetic retained history. '.repeat(Math.ceil(bodySize/28));
    flow.runs[runId]={runId,source:'user',startedAt:now+i*1000,closedAt:now+i*1000+1,outcome:'completed',inputIds:[u]};
    flow.timeline.push({kind:'user',id:u,runId,text:'Question '+i,inputSource:'text',attachmentIds:[],acceptedAt:now+i*1000,deliveredAt:now+i*1000});
    flow.timeline.push({kind:'assistant',itemId:a,runId,afterInputId:u,parts:[{kind:'text',partId:'p'+i,phase:'final_answer',content:text}]});
    turns.push({id:u,runId,author:'user',text:'Question '+i,createdAt:now+i*1000},{id:a,runId,author:'hemi',text,createdAt:now+i*1000+1});
  }
  flow.revision=1;
  return {id,version:2,title:'性能回收验证',customTitle:'性能回收验证',createdAt:now,updatedAt:now+questions*1000,turns,flow};
}
async function benchmarks(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-perf-bench-'));
  try{
    const seed={version:2,roots:{},dispatches:{},tasks:{},inbox:{},requests:{},observations:{},processes:{}};
    const old={conversationId:'old',rootRunId:'old',generation:1};seed.roots.old={owner:old,status:'completed'};
    for(let i=0;i<12000;i++)seed.requests['q'+i]={requestId:'q'+i,owner:old,startedAt:1,endedAt:2,payload:'x'.repeat(2500)};
    for(let i=0;i<6000;i++)seed.processes['p'+i]={id:'p'+i,owner:old,state:'finished',cleanupConfirmed:true,output:'x'.repeat(2000)};
    const json=JSON.stringify(seed);report.journalBytes=Buffer.byteLength(json);
    const owner={conversationId:'new',rootRunId:'new',generation:1};
    for(const baseline of [true,false]){
      const dir=path.join(root,baseline?'baseline':'optimized');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'run-journal.json'),json);
      let create=createRunJournal;
      if(baseline){const installed='/Applications/Hemi.app/Contents/Resources/app/src/main/agent-runtime/run-journal.mjs';try{create=(await import(pathToFileURL(installed))).createRunJournal;}catch{continue;}}
      const journal=create({dir});await journal.ready();await journal.beginRoot(owner);
      await measure((baseline?'baseline':'optimized')+' tool state writes',async()=>{await journal.observationStart({id:'tool',owner,tool:'synthetic'});await journal.observationEnd('tool',{outcome:'ok'});});
      await measure((baseline?'baseline':'optimized')+' scoped query',async()=>{if(journal.project)await journal.project(s=>Object.values(s.requests).filter(row=>row.owner.conversationId===owner.conversationId).length);else Object.values((await journal.snapshot()).requests).filter(row=>row.owner.conversationId===owner.conversationId);});
      journal.dispose();
    }
    const records=Array.from({length:46},(_,i)=>({source:'chat',input:i+1,output:1,at:i+1}));
    const record=conversation('conv-large',120,72000),raw=JSON.stringify(record,null,2);report.conversationBytes=Buffer.byteLength(raw);
    for(const baseline of [true,false]){
      const dir=path.join(root,baseline?'archive-baseline':'archive-optimized');await fs.mkdir(dir);await fs.writeFile(path.join(dir,record.id+'.json'),raw);
      let create=createConversationStore;
      if(baseline){try{create=(await import(pathToFileURL('/Applications/Hemi.app/Contents/Resources/app/src/main/history/conversation-store.mjs'))).createConversationStore;}catch{continue;}}
      const store=create({dir});
      await measure((baseline?'baseline':'optimized')+' 46 usage records',async()=>{if(baseline)for(const row of records)store.appendUsageRecord(record.id,row);else assert.equal(await store.appendUsageRecordsAsync(record.id,records),true);});
      assert.equal(JSON.parse(await fs.readFile(path.join(dir,record.id+'.json'),'utf8')).usageLedger.length,46);
    }
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
async function renderer(mode){
  const userData=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-perf-ui-')),dir=path.join(userData,'runtime-v2/conversations');await initializeRuntimeStorage({userDataDir:userData});await fs.mkdir(dir,{recursive:true});
  const record=conversation('conv-perf-long');
  record.predecessorAgentSession={entries:[{text:'Synthetic legacy archive. '.repeat(2000)}]};
  record.flow.runs['full-copy']={runId:'full-copy',source:'user',startedAt:1,closedAt:2,outcome:'completed',inputIds:['copy-q']};
  record.flow.timeline.push({kind:'user',id:'copy-q',runId:'full-copy',text:'Copy all chunks',inputSource:'text',attachmentIds:[],acceptedAt:1,deliveredAt:1});
  for(let i=0;i<70;i++)record.flow.timeline.push({kind:'assistant',itemId:'copy-a'+i,runId:'full-copy',afterInputId:'copy-q',parts:[{kind:'text',partId:'copy-p'+i,phase:'final_answer',content:'FULL_COPY_CHUNK '+i+' '+'.'.repeat(300)}]});
  await fs.writeFile(path.join(dir,record.id+'.json'),JSON.stringify(record));
  for(let i=0;i<3;i++){const bg=conversation('conv-perf-bg-'+i);bg.title=bg.customTitle='并行任务 '+i;bg.updatedAt=record.updatedAt-10000-i;await fs.writeFile(path.join(dir,bg.id+'.json'),JSON.stringify(bg));}
  await fs.writeFile(path.join(userData,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',permissionChoice:'skipped',completedAt:Date.now()}));
  const server=mode==='dev'?await createServer({configFile:path.join(repo,'vite.config.ts'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}}):null;
  if(server)await server.listen();
  const result={mode,launcher:'src/main/index.mjs',checks:[],errors:[]};report.renderers.push(result);let app;
  const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};
  try{
    const env={...process.env,HEMI_USER_DATA_DIR:userData,HEMI_TEST_MIC_GRANT:'1',HEMI_BOT_AUTO_UPDATE:'0',HEMI_LLM_API_KEY:'SYNTHETIC_ONLY',HEMI_LLM_BASE_URL:'http://127.0.0.1:9/v1',HEMI_LLM_MODEL:'fixture'};
    if(server)env.VITE_DEV_SERVER_URL=server.resolvedUrls.local[0];else delete env.VITE_DEV_SERVER_URL;
    app=await _electron.launch({executablePath:electronPath,args:['.'],cwd:repo,env});
    result.logs=[];app.process().stdout?.on('data',data=>result.logs.push(String(data)));app.process().stderr?.on('data',data=>result.logs.push(String(data)));
    let page;const until=Date.now()+25000;
    while(!page&&Date.now()<until){page=app.windows().find(p=>{try{return !new URL(p.url()).searchParams.has('mode')&&!p.url().startsWith('about:');}catch{return false;}});if(!page)await pause(30);}
    assert.ok(page);page.setDefaultTimeout(15000);page.on('pageerror',error=>result.errors.push(error.message));
    await page.getByRole('textbox',{name:'输入消息',exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector('.h67-virtual-transcript'));
    await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('index.html')||w.webContents.getURL().includes('127.0.0.1'));w.setContentSize(1440,900);w.show();w.focus();});
    const initial=await page.locator('.h67-virtual-transcript').evaluate(el=>Number(el.dataset.virtualTotal));assert.ok(initial>0);assert.ok(initial<record.flow.timeline.length);
    const head=await page.evaluate(()=>window.hemiVoice.flowGetSnapshot('conv-perf-long'));assert.equal(head.timeline.filter(item=>item.kind==='user').length,10);check('initial local IPC view contains ten complete QAs');
    await app.evaluate(({ipcMain,Notification})=>{Notification.prototype.show=function(){};globalThis.__performanceClipboard='';ipcMain.removeHandler('system:copy-text');ipcMain.handle('system:copy-text',(_event,text)=>{globalThis.__performanceClipboard=text;return {ok:true};});});
    await page.getByRole('button',{name:'复制完整回答',exact:true}).last().click();
    await page.waitForTimeout(100);
    const copied=await app.evaluate(()=>globalThis.__performanceClipboard);
    assert.ok(copied.includes('FULL_COPY_CHUNK 0 '));assert.ok(copied.includes('FULL_COPY_CHUNK 69 '));check('copy retrieves the entire answer beyond the retained view');
    const metadata=await page.evaluate(()=>window.hemiVoice.openConversation('conv-perf-long',{windowed:true}));assert.equal(metadata.turns.length,0);assert.equal(metadata.flow,undefined);assert.equal(metadata.predecessorAgentSession,undefined);check('renderer does not receive a duplicate full archive');
    const viewport=page.locator('[data-transcript-scroll] [data-slot="scroll-area-viewport"]');await viewport.evaluate(el=>el.scrollTop=0);
    const box=await viewport.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+50);await page.mouse.wheel(0,-1200);
    await page.waitForFunction(initial=>Number(document.querySelector('.h67-virtual-transcript').dataset.virtualTotal)>initial,initial);check('upward reading loads archived QA');
    await page.getByRole('button',{name:'回到底部',exact:true}).click();
    await page.waitForFunction(initial=>Number(document.querySelector('.h67-virtual-transcript').dataset.virtualTotal)<=initial,initial);check('returning to live end releases backfilled QA');
    const frames=page.evaluate(()=>new Promise(resolve=>{const values=[];let last,start;function frame(now){if(last!==undefined)values.push(now-last);last=now;start??=now;if(now-start<2500)requestAnimationFrame(frame);else{values.sort((a,b)=>a-b);resolve({frames:values.length,p95Ms:values[Math.ceil(values.length*.95)-1],maxMs:values.at(-1)});}}requestAnimationFrame(frame);})).catch(error=>({error:error.message}));
    const flowUrl=pathToFileURL(path.join(repo,'src/main/services/conversation-flow-service.mjs')).href;
    const streaming=app.evaluate(async(_electron,{flowUrl,id})=>{
      const {getConversationFlowService}=process.getBuiltinModule('module').createRequire(flowUrl)('./conversation-flow-service.mjs'),s=getConversationFlowService();
      const actors=[s.controllerFor(id),...Array.from({length:3},(_,i)=>s.controllerFor('conv-perf-bg-'+i))];
      for(const c of actors){c.applyFact({type:'run-preparing',runId:'stream',source:'event',inputIds:[],at:Date.now()});c.applyFact({type:'run-started',runId:'stream',at:Date.now()});c.applyFact({type:'part-appended',runId:'stream',part:{partId:'output',kind:'text',phase:'final_answer',content:'STREAM 0'}});}
      for(let i=1;i<=40;i++){for(const c of actors){c.applyFact({type:'part-updated',runId:'stream',partId:'output',patch:{content:'STREAM '+i}});void s.store.saveFlow(c.getSnapshot().conversationId,c.getSnapshot());}await new Promise(r=>setTimeout(r,25));}
      for(const c of actors)c.applyFact({type:'run-closed',runId:'stream',outcome:'completed',at:Date.now()});
      await Promise.all(actors.map(c=>s.store.flush(c.getSnapshot().conversationId)));
    },{flowUrl,id:record.id});
    const typingAt=performance.now();await page.getByRole('textbox',{name:'输入消息',exact:true}).fill('typing during four concurrent outputs');result.typingMs=+(performance.now()-typingAt).toFixed(1);
    await streaming;
    result.frames=await frames;assert.ok(result.frames.p95Ms<50,JSON.stringify(result.frames));assert.ok(result.typingMs<1000);await page.getByText('STREAM 40',{exact:true}).waitFor();check('streamed changes remain visible while actual worker saves run');
    const input=page.getByRole('textbox',{name:'输入消息',exact:true});await input.fill('draft retained through history recycling');
    await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'对话',exact:true}).click();await input.waitFor();assert.equal(await input.inputValue(),'draft retained through history recycling');check('draft survives page unmount/remount');
    await page.getByRole('button',{name:'新建对话',exact:true}).click();
    await page.locator('.h24-sidebar-open').filter({hasText:'性能回收验证'}).click();
    await page.getByText('STREAM 40',{exact:true}).waitFor();assert.equal(await input.inputValue(),'draft retained through history recycling');check('switching conversations releases and rehydrates the client without losing saved output or draft');
    await page.screenshot({path:path.join(out,mode+'.png')});assert.deepEqual(result.errors,[]);
  }catch(error){result.error=error.stack;console.error(error.stack);if(app){result.windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({url:w.webContents.getURL(),visible:w.isVisible()}))).catch(()=>[]);result.appLog=await fs.readFile(path.join(userData,'hemi.log'),'utf8').catch(()=>null);console.error(JSON.stringify({windows:result.windows,logs:result.logs?.slice(-12),appLog:result.appLog?.slice(-3000)},null,2));}throw error;}
  finally{await app?.close();await server?.close();await fs.rm(userData,{recursive:true,force:true});}
}
try{
  if(!process.argv.includes('--ui-only'))await benchmarks();
  if(!process.argv.includes('--bench-only'))for(const mode of ['dev','built'])await renderer(mode);
}finally{await fs.writeFile(path.join(out,process.argv.includes('--ui-only')?'report-ui.json':process.argv.includes('--bench-only')?'report-bench.json':'report.json'),JSON.stringify(report,null,2)+'\n');}
