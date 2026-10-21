// Run from the repository root. Verifies this read-only composition, not Hemi production behavior.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync,spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.HEMI_PREVIEW_PLAYWRIGHT||'/Users/zhangao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const dir=fileURLToPath(new URL('.',import.meta.url)),scene=new URL('./scene.html?capture',import.meta.url).href;
const shots=path.resolve('.visual/workflow/vision/home-background-motion-v1');await fs.mkdir(shots,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),errors=[];
const qa={date:new Date().toISOString(),baseHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),testedState:'Uncommitted design artifacts on baseHead',environment:{platform:process.platform,node:process.version,browser:await browser.version()},commands:['node docs/design/appearance-skins/home-background-motion-v1/export-character.mjs','node docs/design/appearance-skins/home-background-motion-v1/verify-and-export.mjs'],checks:{},gaps:['Read-only DOM/CSS snapshot, not the live Hemi application. No IPC, personal conversations, or model services.','Hemi Vite and built renderers, Electron target-platform decoding, multiwindow lifecycle and power use are not validated.','The character is the approved single-image parameter mesh; it is not a formal Cubism model.','Light skin concept only; no separate dark-mode composition.']};
const measure=()=>{
  const round=x=>Math.round(x*1000)/1000;
  return [...document.querySelectorAll('button,textarea,input,.h24-sidebar,.h24-main,.text-composer,.theme-home-copy')].map(element=>{
    const b=element.getBoundingClientRect(),style=getComputedStyle(element);
    return {tag:element.tagName,class:element.className,label:element.getAttribute('aria-label')||element.textContent.trim(),rect:[b.x,b.y,b.width,b.height].map(round),font:[style.fontFamily,style.fontSize,style.fontWeight],radius:style.borderRadius};
  });
};
let encoder;
try{
  const baseline=await browser.newContext({javaScriptEnabled:false,viewport:{width:1440,height:960}});
  const staticPage=await baseline.newPage();await staticPage.goto(new URL('../motion-preview-v2/scene-welcome.html',import.meta.url).href);await staticPage.evaluate(()=>document.fonts.ready);
  const original=await staticPage.evaluate(measure);await baseline.close();
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.on('pageerror',error=>errors.push(error.message));page.on('requestfailed',request=>errors.push(request.url()+': '+request.failure()?.errorText));
  await page.goto(scene);await page.evaluate(()=>window.sceneReady);assert.equal(await page.evaluate(()=>window.homeScene.getState().failure),null);
  const integrated=await page.evaluate(measure);assert.deepEqual(integrated,original,'Existing Hemi UI geometry/type changed');qa.checks.existingUI={comparedElements:original.length,geometryFontsRadii:'unchanged against existing scene snapshot'};
  qa.checks.anchor=await page.evaluate(()=>{
    const img=document.querySelector('.theme-home-backdrop>img'),video=document.querySelector('video'),a=img.getBoundingClientRect(),b=video.getBoundingClientRect(),s=a.height/1386;
    return {sourceOriginDelta:{x:b.x+48*s-a.x,y:b.y+16*s-a.y},sourceScaleDelta:{x:b.width/1231-a.width/1135,y:b.height/1418-a.height/1386},pointerEvents:getComputedStyle(video).pointerEvents,muted:video.muted,loop:video.loop};
  });
  assert(Math.abs(qa.checks.anchor.sourceOriginDelta.x)<.03&&Math.abs(qa.checks.anchor.sourceOriginDelta.y)<.03);assert.equal(qa.checks.anchor.pointerEvents,'none');assert.equal(qa.checks.anchor.muted,true);
  await page.evaluate(()=>window.homeScene.seek(1000));await page.screenshot({path:path.join(dir,'poster.png')});
  await page.evaluate(()=>window.homeScene.play());await page.waitForTimeout(240);await page.evaluate(()=>window.homeScene.pause());
  const paused=await page.evaluate(()=>window.homeScene.getState().time);assert(paused>1100);await page.waitForTimeout(180);assert.equal(await page.evaluate(()=>window.homeScene.getState().time),paused);qa.checks.playPause=true;
  await page.evaluate(()=>window.homeScene.seek(7900));await page.evaluate(()=>window.homeScene.play());await page.waitForTimeout(360);await page.evaluate(()=>window.homeScene.pause());const loopTime=await page.evaluate(()=>window.homeScene.getState().time);assert(loopTime<1000);qa.checks.nativeLoopWrap={timeAfterWrap:loopTime};
  qa.checks.fullSidebar=await page.evaluate(()=>{
    const first=document.querySelector('.h24-sidebar-item'),video=document.querySelector('video'),rect=()=>{const r=video.getBoundingClientRect();return [r.x,r.y,r.width,r.height]};
    let scroller=first;while(scroller&&scroller.scrollHeight<=scroller.clientHeight+8)scroller=scroller.parentElement;
    const before=rect(),count=document.querySelectorAll('.h24-sidebar-item').length;
    if(!scroller)throw new Error('No full sidebar scroller');scroller.scrollTop=scroller.scrollHeight;const after=rect(),scrollTop=scroller.scrollTop;scroller.scrollTop=0;return{count,scrollTop,before,after};
  });
  assert(qa.checks.fullSidebar.count>=50);assert(qa.checks.fullSidebar.scrollTop>0);assert.deepEqual(qa.checks.fullSidebar.before,qa.checks.fullSidebar.after);
  const bytes=await fs.readFile(path.join(dir,'character-idle-alpha-hq.webm'));
  qa.checks.transparentSource=await page.evaluate(async src=>{
    const video=document.createElement('video');video.muted=true;video.src=src;await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=reject;});video.currentTime=2.3;await new Promise(resolve=>video.onseeked=resolve);
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;const context=canvas.getContext('2d');context.drawImage(video,0,0);const data=context.getImageData(0,0,canvas.width,canvas.height).data;let transparent=0,nearlyOpaque=0;
    for(let i=3;i<data.length;i+=4){if(data[i]===0)transparent++;if(data[i]>=250)nearlyOpaque++;}return {width:video.videoWidth,height:video.videoHeight,duration:video.duration,transparent,nearlyOpaque};
  },'data:video/webm;base64,'+bytes.toString('base64'));
  assert(qa.checks.transparentSource.transparent>10000&&qa.checks.transparentSource.nearlyOpaque>10000);qa.checks.transparentSource.sha256=createHash('sha256').update(bytes).digest('hex');
  // Exercise the actual native media-error fallback after successful initialization.
  await page.evaluate(()=>{window.homeScene.getVideo().src='data:video/webm;base64,AA==';});await page.waitForFunction(()=>!!window.homeScene.getState().failure);
  qa.checks.decodeFailureFallback=await page.evaluate(()=>({state:window.homeScene.getState(),staticVisible:getComputedStyle(document.querySelector('.theme-home-backdrop>img')).visibility}));assert.equal(qa.checks.decodeFailureFallback.staticVisible,'visible');assert.equal(qa.checks.decodeFailureFallback.state.playing,false);
  await page.goto(new URL('./index.html',import.meta.url).href);await page.evaluate(()=>window.previewReady);
  await page.locator('#static').click();await page.waitForFunction(()=>window.homePreview.getState().mode==='static');assert.equal(await page.evaluate(()=>window.homePreview.getState().playing),false);
  await page.locator('#motion').click();await page.waitForFunction(()=>window.homePreview.getState().playing);await page.locator('#toggle').click();await page.waitForFunction(()=>!window.homePreview.getState().playing);qa.checks.wrapperControls=true;
  qa.checks.viewports=[];
  for(const [width,height]of [[1440,960],[980,760],[768,1024],[375,812]]){
    await page.setViewportSize({width,height});await page.evaluate(()=>window.homePreview.seek(1000));
    const frame=page.frames().find(f=>f.url().includes('/scene.html'));
    const dimensions=await frame.evaluate(()=>({viewport:innerWidth,shell:document.querySelector('.compact-shell').getBoundingClientRect().width,horizontalScroll:document.documentElement.scrollWidth}));assert(dimensions.shell<=width+.1&&dimensions.horizontalScroll<=width);
    await page.screenshot({path:path.join(shots,`home-${width}.png`),fullPage:true});qa.checks.viewports.push({width,height,...dimensions});
  }
  await page.emulateMedia({reducedMotion:'reduce'});await page.goto(new URL('./index.html',import.meta.url).href);await page.evaluate(()=>window.previewReady);qa.checks.reducedMotion=await page.evaluate(()=>window.homePreview.getState());assert.equal(qa.checks.reducedMotion.mode,'static');assert.equal(qa.checks.reducedMotion.playing,false);
  await page.emulateMedia({reducedMotion:'no-preference'});await page.setViewportSize({width:1440,height:960});await page.goto(scene);await page.evaluate(()=>window.sceneReady);
  encoder=spawn(process.env.HEMI_PREVIEW_FFMPEG||'/opt/homebrew/bin/ffmpeg',['-hide_banner','-loglevel','error','-y','-framerate','30','-f','image2pipe','-vcodec','png','-i','pipe:0','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart','-an',path.join(dir,'hemi-home-background-motion.mp4')],{stdio:['pipe','ignore','pipe']});
  let log='';encoder.stderr.on('data',data=>log+=data);const done=new Promise((resolve,reject)=>{encoder.on('error',reject);encoder.on('exit',code=>code===0?resolve():reject(new Error(log||`ffmpeg ${code}`)));});done.catch(()=>{});
  for(let frame=0;frame<240;frame++){await page.evaluate(time=>window.homeScene.seek(time),frame*1000/30);const png=await page.screenshot();if(!encoder.stdin.write(png))await once(encoder.stdin,'drain');if(frame%30===0)console.log(`Homepage movie ${frame}/240`);}
  encoder.stdin.end();await done;
  const movie=await fs.readFile(path.join(dir,'hemi-home-background-motion.mp4'));
  qa.checks.movie=await page.evaluate(async src=>{const v=document.createElement('video');v.muted=true;v.src=src;await new Promise((resolve,reject)=>{v.onloadedmetadata=resolve;v.onerror=reject;});await v.play();await new Promise(resolve=>setTimeout(resolve,200));v.pause();return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,advanced:v.currentTime>0};},'data:video/mp4;base64,'+movie.toString('base64'));assert.equal(qa.checks.movie.advanced,true);assert.equal(qa.checks.movie.duration,8);
  assert.deepEqual(errors,[]);qa.checks.browserErrors=errors;qa.result='PASS';await fs.writeFile(path.join(dir,'qa.json'),JSON.stringify(qa,null,2)+'\n');console.log(JSON.stringify(qa,null,2));
}finally{if(encoder&&encoder.exitCode===null)encoder.kill();await browser.close();}
