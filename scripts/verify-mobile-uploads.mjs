import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';
// Renderer -> native picker/byte boundary fixture -> actual Bot/controller/filesystem.
// System picker and real iOS TLS require the separate signed native build/device check.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer,preview} from 'vite';
import {chromium} from 'playwright-core';
import {createBotHost} from '../src/main/bot/host.mjs';
const repo=path.resolve(import.meta.dirname,'..'),app=path.join(repo,'apps/mobile'),output=path.join(repo,'.visual/workflow/mobile-uploads');await fs.mkdir(output,{recursive:true});
const report={date:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:process.platform+'/'+process.arch,results:[]};
const browser=await chromium.launch({executablePath:process.env.HEMI_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const wait=async predicate=>{const until=Date.now()+15000;while(Date.now()<until){if(await predicate())return;await new Promise(r=>setTimeout(r,30));}throw new Error('Upload condition timed out');};
try{for(const mode of ['dev','built']){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-upload-ui-'))),runs=[],removed=[];
 const host=await createBotHost({dataDir:path.join(root,'data'),defaultDir:path.join(root,'work'),validateModel:async()=>{},executorFactory:()=>({run:async spec=>{runs.push(spec);return{stopped:false};},stop:async()=>{},close:async()=>{}})});
 const {instanceId}=await host.request('handshake'),call=(method,params={})=>host.request(method,{instanceId,requestId:randomUUID(),...params});
 await call('model.sync',{models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'model',api:'openai-completions',baseUrl:'https://example.invalid',apiKey:'NOT_A_CREDENTIAL'}]});
 const {id}=await call('session.create'),target={endpoint:'https://127.0.0.1:29421',botInstanceId:instanceId,name:'Upload fixture'};
 const bytes=Buffer.from('ISOLATED_UPLOAD_CANARY_'.repeat(60000)),file={id:randomUUID(),name:'发布检查清单与交付说明.md',kind:'text',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 let hold=true,releaseChunk,chunkCalls=0,dropComplete=false,selection=[file];
 const config={configFile:path.join(app,'vite.config.ts'),root:app,logLevel:'error'};
 const server=mode==='dev'?await createServer({...config,server:{host:'127.0.0.1',port:0}}):await preview({...config,preview:{host:'127.0.0.1',port:0}});
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'}),result={mode,checks:[],screenshots:[],errors:[]};report.results.push(result);
 const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};
 try{
  if(mode==='dev')await server.listen();
  await installMobileBotEvents(context,host,{});
  await context.exposeBinding('__uploadsNative',async(_source,{method,params})=>{
   if(method==='pickFiles')return{files:selection};
   if(method==='readPickedFile')return{base64:bytes.subarray(params.offset,params.offset+params.length).toString('base64'),size:params.length};
   if(method==='removePickedFile'){removed.push(params.id);return{};}
   if(method==='request'){
    const rpc=params;if(rpc.method==='attachment.upload.chunk'&&++chunkCalls===2&&hold)await new Promise(resolve=>{releaseChunk=resolve;});
    try{const value=await host.request(rpc.method,rpc.params);if(dropComplete&&rpc.method==='attachment.upload.complete'){dropComplete=false;throw new Error('上传完成回执丢失，请重试核对');}return{ok:true,result:value};}
    catch(error){return{ok:false,code:error.code??'network',message:error.message};}
   }
   throw new Error('Unexpected bridge call '+method);
  });
  await context.addInitScript(target=>{
   const listeners=new Map();let next=0;
   window.__uploadKeyboard={emit(name,height){for(const item of listeners.values())if(item.name===name)item.callback({keyboardHeight:height});}};
   window.CapacitorCustomPlatform={name:'ios'};
   window.Capacitor={PluginHeaders:[{name:'HemiBot',methods:['restore','request','pickFiles','readPickedFile','removePickedFile'].map(name=>({name,rtype:'promise'}))},{name:'Keyboard',methods:[{name:'addListener',rtype:'callback'},{name:'removeListener',rtype:'promise'}]}],nativeCallback(plugin,method,options,callback){const id=String(++next);listeners.set(id,{name:options.eventName,callback});return Promise.resolve(id);},async nativePromise(plugin,method,params){
    if(plugin==='Keyboard'){listeners.delete(params.callbackId);return{};}
    if(method==='restore')return{active:target};const value=await window.__uploadsNative({method,params});if(value.ok===false)throw Object.assign(new Error(value.message),{code:value.code});return value;
   }};
  },target);
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>result.errors.push(error.message));
  const shot=async name=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const file=path.join(output,`${mode}-${name}.png`);await page.screenshot({path:file});result.screenshots.push(file);};
  await page.goto(server.resolvedUrls.local[0]);const input=page.getByRole('textbox',{name:'消息',exact:true});await input.waitFor();
  await input.fill('保留的草稿');await page.getByRole('button',{name:'添加内容',exact:true}).click();await shot('picker');
  await page.getByRole('button',{name:/^文件/}).click();await wait(()=>!!releaseChunk);await page.getByRole('progressbar').waitFor();assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isDisabled(),true);await shot('progress');
  dropComplete=true;hold=false;releaseChunk();await page.getByRole('button',{name:`重试上传 ${file.name}`,exact:true}).waitFor();await shot('retry');
  assert.equal(await input.inputValue(),'保留的草稿');await page.reload();await page.getByRole('button',{name:`重试上传 ${file.name}`,exact:true}).waitFor();const count=chunkCalls;await page.getByRole('button',{name:`重试上传 ${file.name}`,exact:true}).click();
  await page.getByRole('button',{name:`移除 ${file.name}`,exact:true}).waitFor();assert.equal(chunkCalls,count);assert.equal(await input.inputValue(),'保留的草稿');check('actual >1MB upload, confirmed progress, lost completion receipt and restart/retry without duplicate chunks');
  for(const [width,height] of [[320,568],[375,667],[390,844],[768,844],[1440,900]]){
   await page.setViewportSize({width,height});await wait(async()=>await page.locator('.mobile-shell').evaluate((node,height)=>Math.abs(node.getBoundingClientRect().height-height)<2,height));await wait(async()=>await page.getByRole('button',{name:'发送消息',exact:true}).evaluate(node=>{const box=node.getBoundingClientRect();return box.bottom<=innerHeight&&box.top>=0;}));await shot(`ready-${width}`);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   const box=await page.getByRole('button',{name:`移除 ${file.name}`,exact:true}).boundingBox();assert.ok(box.width>=44&&box.height>=44);
  }
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme:'dark'});await shot('ready-system-dark');
  await page.evaluate(()=>window.__uploadKeyboard.emit('keyboardWillShow',320));await wait(async()=>await page.locator('.mobile-shell').evaluate(node=>Math.abs(node.getBoundingClientRect().height-524)<2));
  const inputBox=await input.boundingBox();assert.ok(inputBox.y+inputBox.height<=524);await shot('ready-keyboard');await page.evaluate(()=>window.__uploadKeyboard.emit('keyboardWillHide',0));
  check('compact attachments fit 320/375/390/768/1440 widths, dark system preference and keyboard-resized container; controls >=44px');
  await input.fill('');assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isEnabled(),true);await page.getByRole('button',{name:'发送消息',exact:true}).click();await wait(()=>runs.length===1);assert.equal(runs[0].envelope.attachmentIds.length,1);assert.equal(runs[0].envelope.attachmentViews[0].name,file.name);
  const state=JSON.parse(await fs.readFile(path.join(root,'data/state.json'),'utf8')),stored=state.sessions[id].attachments[runs[0].envelope.attachmentIds[0]];assert.deepEqual(await fs.readFile(stored.path),bytes);await wait(async()=>await page.getByRole('button',{name:`移除 ${file.name}`,exact:true}).count()===0);
  check('attachment-only message reaches actual Host executor with registered IDs and exact bytes; SDK draft clears');
  await input.fill('取消后保留文字');hold=true;chunkCalls=1;releaseChunk=null;
  await page.getByRole('button',{name:'添加内容',exact:true}).click();await page.getByRole('button',{name:/^照片/}).click();await wait(()=>!!releaseChunk);
  await page.getByRole('button',{name:`取消上传 ${file.name}`,exact:true}).click();hold=false;releaseChunk();await wait(()=>removed.length===2);assert.equal(await input.inputValue(),'取消后保留文字');assert.equal(await page.locator('.composer-attachment').count(),0);check('photo source entry and in-flight cancellation clean up staged bytes and preserve text');
  selection=[];await page.getByRole('button',{name:'添加内容',exact:true}).click();await page.getByRole('button',{name:/^文件/}).click();await wait(async()=>await page.getByRole('button',{name:'添加内容',exact:true}).isEnabled());assert.equal(await page.locator('.composer-attachment').count(),0);check('system picker cancellation returns to unchanged draft');
  assert.deepEqual(result.errors,[]);
 }catch(error){result.failure=error.message;await context.pages()[0]?.screenshot({path:path.join(output,mode+'-failure.png')});throw error;}
 finally{releaseChunk?.();await context.close();await server.close();await host.close();await fs.rm(root,{recursive:true,force:true});}
}}finally{await browser.close();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');}
