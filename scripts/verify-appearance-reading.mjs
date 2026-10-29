// Real Electron reading-background regression, with generated data and no model calls.
// Run with VITE_DEV_SERVER_URL for Vite and without it after build:renderer.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import electronPath from 'electron';
import {_electron} from 'playwright-core';
import {createConversationStore} from '../src/main/history/conversation-store.mjs';
const mode=process.env.VITE_DEV_SERVER_URL?'dev':'built';
const out=path.resolve(`.visual/workflow/vision/appearance-reading/${mode}`);
const ud=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-appearance-reading-'));
await fs.mkdir(out,{recursive:true});
const report={mode,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),node:process.version,platform:`${process.platform}/${process.arch}`,userData:ud,checks:[],errors:[]};
const check=(name,ok,detail)=>{report.checks.push({name,ok,detail});assert.ok(ok,`${name}: ${JSON.stringify(detail)}`);console.log('PASS',name,detail??'');};
const store=createConversationStore({dir:path.join(ud,'conversations')});
assert.ok(store.saveSession({id:'conv-reading-motion',workspaceId:'default',turns:[{id:'u-reading',author:'user',createdAt:Date.now(),text:'检查对话流角色背景'},{id:'h-reading',author:'hemi',createdAt:Date.now()+1,text:'这是隔离测试记录，不调用模型。'}]}).ok);
store.renameSession('conv-reading-motion','角色背景验证');
await fs.writeFile(path.join(ud,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',permissionChoice:'skipped',completedAt:Date.now()}));
await fs.writeFile(path.join(ud,'appearance.json'),JSON.stringify({schemaVersion:1,skinId:'cafe-blue',mode:'light'}));
let app,page;
const main=source=>app.evaluate(({BrowserWindow},source)=>{const win=BrowserWindow.getAllWindows().find(w=>!new URL(w.webContents.getURL()).searchParams.has('mode'));return new Function('win',source)(win);},source);
const sample=()=>page.locator('.theme-home-actor>video').evaluate(v=>({src:v.currentSrc,paused:v.paused,readyState:v.readyState,time:v.currentTime,duration:v.duration}));
const playing=async name=>{
 await page.waitForFunction(()=>{const v=document.querySelector('.theme-home-actor>video');return v&&v.readyState>=2&&!v.paused;});
 const before=await sample();await page.waitForTimeout(650);const after=await sample();
 const delta=(after.time-before.time+after.duration)%after.duration;
 check(name,!!after.src&&after.src.includes('.webm')&&!after.paused&&delta>.2,{before,after,delta});
};
const paused=async name=>{
 await page.waitForFunction(()=>document.querySelector('.theme-home-actor>video')?.paused===true,null,{polling:100});
 const before=await sample();await page.waitForTimeout(400);const after=await sample();
 check(name,Math.abs(after.time-before.time)<.08,{before,after});
};
try{
 app=await _electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,HEMI_USER_DATA_DIR:ud}});
 page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.waitForFunction(()=>window.hemiVoice?.getAppearanceBootstrap?.()?.activity.visible);
 // Do not steal desktop focus. Skip the intro through its actual control if still present.
 const skip=page.getByRole('button',{name:'跳过',exact:true});if(await skip.count())await skip.click();
 await page.waitForFunction(()=>document.querySelector('.appearance-stage')?.dataset.startup==='done');
 check('visual-ready allows native window to show and startup releases overlay',await main('return win.isVisible()')&&await page.locator('.startup-overlay').count()===0);
 await page.locator('.h24-sidebar-open').filter({hasText:'角色背景验证'}).click();
 await page.waitForFunction(()=>document.querySelector('.theme-home-backdrop')?.dataset.view==='reading');
 await playing('reading plays real character video');
 const draft=page.locator('textarea.text-composer-input');await draft.fill('输入过程中背景仍播放');await draft.focus();
 await playing('reading keeps playing with draft and focused composer');
 const input=await draft.elementHandle();
 for(const skinId of ['cafe-purple','cafe-orange','cafe-gold','cafe-red','cafe-blue']){
  const old=await page.locator('.theme-home-actor>video').elementHandle();
  const result=await page.evaluate(skinId=>window.hemiVoice.setAppearance({requestId:crypto.randomUUID(),skinId,mode:'light'}),skinId);assert.ok(result.ok);
  await page.waitForFunction(id=>document.documentElement.dataset.skin===id,skinId);
  await playing(`${skinId} reading video advances`);
  check(`${skinId} releases old decoder and preserves input`,await old.evaluate(v=>!v.isConnected&&!v.getAttribute('src')&&v.readyState===0)&&await input.evaluate(el=>el.isConnected&&el.value==='输入过程中背景仍播放'));
 }
 await main('win.blur()');await playing('visible unfocused reading continues');
 await page.evaluate(()=>{window.__readingActivity=[];window.hemiVoice.onAppearanceActivity(value=>window.__readingActivity.push(value));});
 await main('win.__readingEvents=[];for(const event of ["hide","show","blur","minimize"])win.on(event,()=>win.__readingEvents.push(event));win.hide()');await page.waitForTimeout(350);
 report.hideDiagnostic={native:await main('return {id:win.id,url:win.webContents.getURL(),visible:win.isVisible(),minimized:win.isMinimized(),events:win.__readingEvents,hideListeners:win.listenerCount("hide")}').catch(e=>e.message),renderer:await page.evaluate(()=>({hidden:document.hidden,activity:window.__readingActivity})),video:await sample()};
 console.log('HIDE DIAGNOSTIC',JSON.stringify(report.hideDiagnostic));
 if(!report.hideDiagnostic.native.events?.includes('hide')){
  report.gaps=['Electron hide() changed isVisible to false without emitting hide; native hidden pause could not be verified. Following hide/show/minimize checks explicitly inject lifecycle events.'];
  await main('win.emit("hide")');
 }
 await paused(report.gaps?'hide activity pauses reading (injected lifecycle event)':'native hide pauses reading');
 await main('win.showInactive();'+(report.gaps?'win.emit("show")':''));await playing('showInactive resumes reading without focus');
 await main('win.minimize();'+(report.gaps?'win.emit("minimize")':''));await paused(report.gaps?'minimize activity pauses reading (injected lifecycle event)':'native minimize pauses reading');
 await main('win.restore();win.showInactive();'+(report.gaps?'win.emit("restore")':''));await playing('restore resumes reading');
 // Exercise document visibility independently of native activity (Chromium lifecycle emulation).
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Emulation.setPageVisibilityState',{visibilityState:'hidden'}).catch(async()=>{
  // Electron does not expose this experimental CDP command on all Chromium versions.
  report.documentVisibilitySimulation=true;
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
 });
 await paused('document hidden pauses reading');
 if(report.documentVisibilitySimulation)await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
 else await cdp.send('Emulation.setPageVisibilityState',{visibilityState:'visible'});
 await playing('document visible resumes reading');
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.waitForFunction(()=>!document.querySelector('.theme-home-actor>video'));
 check('reduced motion uses static image',await page.locator('.theme-home-actor>img').isVisible());
 await page.emulateMedia({reducedMotion:'no-preference'});await playing('motion preference restored resumes reading');
 await page.screenshot({path:path.join(out,'reading-motion.png')});
 const readingVideo=await page.locator('.theme-home-actor>video').elementHandle();
 await draft.fill('');await page.getByRole('button',{name:'新建对话',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.theme-home-backdrop')?.dataset.view==='home');
 await draft.fill('主页输入');await draft.focus();await playing('home also plays while typing');
 check('home and reading share one media instance without reload',await readingVideo.evaluate(v=>v.isConnected&&v===document.querySelector('.theme-home-actor>video')));
 const homeVideo=await page.locator('.theme-home-actor>video').elementHandle();
 await page.getByRole('button',{name:'工作流',exact:true}).click();await page.getByTestId('workflow-studio').waitFor();
 await page.waitForFunction(()=>document.querySelector('.theme-home-backdrop')?.dataset.view==='other'&&!document.querySelector('.theme-home-actor>video'));
 check('other pages stay static and release decoder',await page.locator('.theme-home-actor>img').isVisible()&&await homeVideo.evaluate(v=>!v.isConnected&&!v.getAttribute('src')&&v.readyState===0));
 check('no uncaught renderer errors',report.errors.length===0,report.errors);
}catch(error){report.failure=error.message;if(page&&!page.isClosed())await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;
}finally{
 if(app){await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 if(report.gaps?.length)console.warn('VALIDATION GAPS',report.gaps);
 if(report.documentVisibilitySimulation)console.warn('DOCUMENT VISIBILITY: simulated document.hidden and visibilitychange, not native occlusion');
 console.log('EVIDENCE',out);
}
