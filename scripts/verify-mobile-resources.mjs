import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';
// Native bridge/OS panel boundary fixture; actual Host, resource protocol, file bytes, SDK and renderer.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import {createServer,preview} from 'vite';import{chromium}from'playwright-core';
import{resourceFixture,wait}from'../apps/mobile/test/resource-fixture.mjs';
const repo=path.resolve(import.meta.dirname,'..'),app=path.join(repo,'apps/mobile'),out=path.join(repo,'.visual/workflow/mobile-resources');await fs.mkdir(out,{recursive:true});
const report={date:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:process.platform+'/'+process.arch,results:[]};
const browser=await chromium.launch({executablePath:process.env.HEMI_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{for(const mode of ['dev','built']){
 const f=await resourceFixture();await f.call('session.order',{ids:[f.id,f.other]});const target={endpoint:'https://127.0.0.1:29421',botInstanceId:f.instanceId,name:'Resource fixture'};
 const stages=new Map(),presented=[],removed=[],readRequests=[];let failPresent=false,hold=false,releaseChunk;
 const config={configFile:path.join(app,'vite.config.ts'),root:app,logLevel:'error'},server=mode==='dev'?await createServer({...config,server:{host:'127.0.0.1',port:0}}):await preview({...config,preview:{host:'127.0.0.1',port:0}});
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'}),result={mode,checks:[],errors:[],screenshots:[]};report.results.push(result);const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};
 try{
  if(mode==='dev')await server.listen();
  await installMobileBotEvents(context,f.host,{});
  await context.exposeBinding('__resourcesNative',async(_source,{method,params})=>{
   if(method==='request'){if(['resource.stat','resource.chunk'].includes(params.method))readRequests.push(params);if(params.method==='resource.chunk'&&params.params.artifactId===f.byName['大文件.zip']&&params.params.offset>0&&hold)await new Promise(resolve=>{releaseChunk=resolve;});try{return{ok:true,result:await f.host.request(params.method,params.params)};}catch(error){return{ok:false,code:error.code??'failed',message:error.message};}}
   if(method==='beginResource'){const id=crypto.randomUUID();stages.set(id,{meta:params,parts:[]});return{id};}
   if(method==='appendResource'){const item=stages.get(params.id);assert.equal(Buffer.concat(item.parts).length,params.offset);item.parts.push(Buffer.from(params.base64,'base64'));return{};}
   if(method==='finishResource'){const item=stages.get(params.id),bytes=Buffer.concat(item.parts);assert.equal(bytes.length,item.meta.size);assert.equal(createHash('sha256').update(bytes).digest('hex'),item.meta.sha256);return{};}
   if(method==='presentResource'){if(failPresent)throw new Error('系统面板打开失败');const item=stages.get(params.id);presented.push({action:params.action,name:item.meta.name,bytes:Buffer.concat(item.parts)});return{presented:true};}
   if(method==='removeResource'){stages.delete(params.id);removed.push(params.id);return{};}
   throw new Error('Unexpected bridge '+method);
  });
  await context.addInitScript(target=>{
   const callbacks=new Map();let next=0;window.__resourceKeyboard={emit(name,height){for(const item of callbacks.values())if(item.name===name)item.callback({keyboardHeight:height});}};
   window.CapacitorCustomPlatform={name:'ios'};window.Capacitor={PluginHeaders:[{name:'HemiBot',methods:['restore','request','beginResource','appendResource','finishResource','removeResource','presentResource'].map(name=>({name,rtype:'promise'}))},{name:'Keyboard',methods:[{name:'addListener',rtype:'callback'},{name:'removeListener',rtype:'promise'}]}],nativeCallback(plugin,method,params,callback){const id=String(++next);callbacks.set(id,{name:params.eventName,callback});return Promise.resolve(id);},async nativePromise(plugin,method,params){if(plugin==='Keyboard'){callbacks.delete(params.callbackId);return{};}if(method==='restore')return{active:target};const value=await window.__resourcesNative({method,params});if(value.ok===false)throw Object.assign(new Error(value.message),{code:value.code});return value;}};
  },target);
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>result.errors.push(error.message));
  const shot=async name=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const file=path.join(out,mode+'-'+name+'.png');await page.screenshot({path:file});result.screenshots.push(file);};
  await page.goto(server.resolvedUrls.local[0]);await page.getByRole('textbox',{name:'消息',exact:true}).waitFor();
  const open=async name=>{await page.locator('.h62-deliverable-card').getByRole('button',{name:'预览 '+name,exact:true}).click();const dialog=page.getByRole('dialog',{name,exact:true});await dialog.waitFor();return dialog;};
  let dialog=await open('交付说明.md');await dialog.getByRole('heading',{name:'MOBILE_DELIVERY',exact:true}).waitFor();await shot('markdown');
  await dialog.getByRole('button',{name:'刷新',exact:true}).waitFor();assert.equal(await dialog.getByText(/已缓存|分钟内可复用|再次打开时核对缓存/).count(),0);const initialReads=readRequests.length;assert.equal(await dialog.getByRole('button',{name:'系统预览',exact:true}).isEnabled(),true);
  for(const [label,action]of[['系统预览','open'],['保存到文件','save'],['分享','share']]){await dialog.getByRole('button',{name:label,exact:true}).click();await wait(()=>presented.at(-1)?.action===action);assert.deepEqual(presented.at(-1).bytes,f.files['交付说明.md']);await wait(()=>!stages.size);}
  assert.equal(readRequests.length,initialReads);check('registered Markdown is cached; open/save/share reuse verified bytes without more RPC and clean native staging');
  for(const width of [320,375,390,768,1440]){
   await page.setViewportSize({width,height:844});await wait(async()=>await page.locator('.mobile-shell').evaluate(node=>Math.abs(node.getBoundingClientRect().height-844)<2));await shot('preview-'+width);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   for(const button of await dialog.locator('.resource-actions button').all()){const box=await button.boundingBox();assert.ok(box.width>=44&&box.height>=44);}
  }
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme:'dark'});await shot('preview-system-dark');await page.evaluate(()=>window.__resourceKeyboard.emit('keyboardWillShow',320));await wait(async()=>await page.locator('.mobile-shell').evaluate(node=>Math.abs(node.getBoundingClientRect().height-524)<2));assert.ok((await dialog.locator('.resource-actions').boundingBox()).y+(await dialog.locator('.resource-actions').boundingBox()).height<=524);await shot('preview-keyboard');await page.evaluate(()=>window.__resourceKeyboard.emit('keyboardWillHide',0));await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  dialog=await open('预览图片.png');await wait(async()=>await dialog.locator('img.resource-preview-image').evaluate(node=>node.complete&&node.naturalWidth>0));await shot('image');await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('link',{name:'正文文件',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'BODY_PREVIEW',exact:true}).waitFor();assert.equal(await dialog.locator('.resource-actions').count(),0);await shot('body-link');await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  check('real image preview and preview-only body links; widths320/375/390/768/1440 and dark system preference fit with44px actions');
  hold=true;releaseChunk=null;dialog=await open('大文件.zip');await wait(()=>!!releaseChunk);await dialog.getByRole('progressbar',{name:'文件下载进度',exact:true}).waitFor();assert.equal(await dialog.getByRole('progressbar').getAttribute('value'),'1048576');await shot('download-progress');await page.setViewportSize({width:320,height:568});await shot('download-progress-320');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.setViewportSize({width:390,height:844});hold=false;releaseChunk();await dialog.getByText(/暂不支持在线预览/).waitFor();failPresent=true;await dialog.getByRole('button',{name:'保存到文件',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'系统面板打开失败'}).waitFor();await wait(()=>!stages.size);await shot('native-error');failPresent=false;
  hold=true;releaseChunk=null;await dialog.getByRole('button',{name:'重试',exact:true}).click();await wait(()=>!!releaseChunk);const count=presented.length;await dialog.getByRole('button',{name:'关闭',exact:true}).click();hold=false;releaseChunk();await wait(()=>!stages.size);assert.equal(presented.length,count);
  dialog=await open('大文件.zip');await dialog.getByRole('button',{name:'保存到文件',exact:true}).click();await wait(()=>presented.at(-1)?.name==='大文件.zip');assert.deepEqual(presented.at(-1).bytes,f.files['大文件.zip']);await wait(()=>!stages.size);await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  check('confirmed 1MB/total progress and percent; refresh bypasses TTL; cancel ignores late bytes; unsupported binary save uses cached exact bytes');
  assert.deepEqual(result.errors,[]);
 }catch(error){result.failure=error.message;await context.pages()[0]?.screenshot({path:path.join(out,mode+'-failure.png')});throw error;}
 finally{releaseChunk?.();await context.close();await server.close();await f.close();}
}}finally{await browser.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
