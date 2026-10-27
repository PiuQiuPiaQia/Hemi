// Real mobile dev/built renderer and workspace client -> native RPC boundary fixture -> real Host.
// TLS authorization is verified separately by device-gateway.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer,preview} from 'vite';
import {chromium} from 'playwright-core';
import {createBotHost} from '../src/main/bot/host.mjs';
import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';
const repo=path.resolve(import.meta.dirname,'..'),app=path.join(repo,'apps/mobile'),output=path.join(repo,'.visual/workflow/native-memory/mobile');
await fs.mkdir(output,{recursive:true});
const report={results:[]},browser=await chromium.launch({executablePath:process.env.HEMI_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{for(const mode of ['dev','built']){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-native-mobile-'));
 const host=await createBotHost({dataDir:path.join(root,'data'),defaultDir:path.join(root,'workspace'),validateModel:async()=>{},executorFactory:()=>({run:async()=>({}),close:async()=>{},stop:async()=>{}})});
 const {instanceId}=await host.request('handshake');const call=(method,params={})=>host.request(method,{instanceId,requestId:randomUUID(),...params});
 await call('model.sync',{models:[{modelKey:'fixture/main',providerId:'fixture',name:'Synthetic',model:'fixture',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'SYNTHETIC'}]});await call('session.create');
 const memory=path.join(root,'data/pi-memory');await fs.mkdir(path.join(memory,'recovery'),{recursive:true});await fs.writeFile(path.join(memory,'MEMORY.md'),'# Shared Bot memory\n\nMOBILE_NATIVE_SHARED_FACT');
 const recoveryId=randomUUID();await fs.writeFile(path.join(memory,'recovery',recoveryId+'.json'),JSON.stringify({id:recoveryId,content:'MOBILE_RECOVERY_RAW'}));
 const options={root:app,configFile:path.join(app,'vite.config.ts'),cacheDir:path.join(root,'vite-cache'),logLevel:'error'};
 const server=mode==='dev'?await createServer({...options,server:{host:'127.0.0.1',port:0}}):await preview({...options,preview:{host:'127.0.0.1',port:0}});
 const context=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
 const result={mode,checks:[],screenshots:[],errors:[]};report.results.push(result);
 const check=(name,value=true)=>{assert.ok(value,name);result.checks.push(name);console.log('PASS',mode,name);};
 let holdRead=false,releaseRead;
 try{
  await installMobileBotEvents(context,host,{offline:()=>false});
  await context.exposeBinding('__nativeFilesRpc',async(_source,{method,params})=>{try{const value=await host.request(method,params);if(method==='agent-environment.read-file'&&holdRead){holdRead=false;await new Promise(resolve=>{releaseRead=resolve;});}return{ok:true,result:value};}catch(error){return{ok:false,code:error.code,message:error.message};}});
  await context.addInitScript(target=>{
   window.CapacitorCustomPlatform={name:'ios'};
   window.Capacitor={PluginHeaders:[{name:'HemiBot',methods:['restore','request'].map(name=>({name,rtype:'promise'}))}],async nativePromise(_plugin,method,options){if(method==='restore')return{active:target};if(method==='request'){const response=await window.__nativeFilesRpc(options);if(!response.ok)throw Object.assign(Error(response.message),{code:response.code});return response;}throw Error('Unexpected native call');}};
  },{endpoint:'https://127.0.0.1:29421',botInstanceId:instanceId,name:'Native file verification'});
  if(mode==='dev')await server.listen();const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>result.errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);await page.getByRole('textbox',{name:'消息',exact:true}).waitFor();
  await page.getByRole('button',{name:'打开对话列表',exact:true}).click();
  await page.getByRole('button',{name:'Bot 连接设置',exact:true}).click();
  await page.getByRole('button',{name:/共享记忆/}).click();const dialog=page.getByRole('dialog',{name:'Bot 共享记忆',exact:true});await dialog.waitFor();await dialog.getByText(/MOBILE_NATIVE_SHARED_FACT/).waitFor();
  check('current Bot raw file loads through real workspace and Host');
  await dialog.getByRole('button',{name:'刷新',exact:true}).click();await dialog.getByText(/MOBILE_NATIVE_SHARED_FACT/).waitFor();check('refresh unchanged file completes');
  await dialog.locator('select').selectOption('recovery/'+recoveryId+'.json');await dialog.getByText(/MOBILE_RECOVERY_RAW/).waitFor();check('recovery JSON is read only and explicitly selected');
  for(const width of [375,768,1440]){await page.setViewportSize({width,height:900});check(`${width}px no horizontal overflow`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const file=`${mode}-${width}.png`;await page.screenshot({path:path.join(output,file),animations:'disabled'});result.screenshots.push(file);}
  await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:path.join(output,`${mode}-dark.png`)});
  check('memory body excluded from persistent client storage',await page.evaluate(()=>![...Array(localStorage.length)].some((_,index)=>/MOBILE_NATIVE_SHARED_FACT|MOBILE_RECOVERY_RAW/.test(localStorage.getItem(localStorage.key(index))??''))));
  holdRead=true;await dialog.locator('select').selectOption('MEMORY.md');
  for(let attempt=0;!releaseRead&&attempt<100;attempt++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(releaseRead);await dialog.getByRole('button',{name:'关闭',exact:true}).click();releaseRead?.();check('closing during read is safe');
  check('no renderer errors',result.errors.length===0);
 }finally{releaseRead?.();await context.close();await server.close();await host.close();await fs.rm(root,{recursive:true,force:true});}
}}catch(error){report.error=error.stack;console.error(error.stack);process.exitCode=1;}finally{await browser.close();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));}
