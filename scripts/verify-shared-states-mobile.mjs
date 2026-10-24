// Actual mobile renderer/workspace and Bot Host; only native RPC/events are transport fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer,preview} from 'vite';
import {chromium} from 'playwright-core';
import {createBotHost} from '../src/main/bot/host.mjs';
import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';
const repo=path.resolve(import.meta.dirname,'..'),app=path.join(repo,'apps/mobile'),out=path.join(repo,'.visual/workflow/shared-states-lists/mobile');await fs.mkdir(out,{recursive:true});
const report={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:process.platform+'/'+process.arch,results:[]};
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const wait=async fn=>{const end=Date.now()+10000;while(!await fn()){assert.ok(Date.now()<end,'condition timed out');await new Promise(r=>setTimeout(r,20));}};
try{for(const mode of ['dev','built']){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-state-mobile-'));
 const host=await createBotHost({dataDir:path.join(root,'data'),defaultDir:path.join(root,'workspace'),validateModel:async()=>{},executorFactory:()=>({run:async()=>({stopped:false}),stop:async()=>{},close:async()=>{}})});
 const {instanceId}=await host.request('handshake');let nextId=0;const request=(method,params={})=>host.request(method,{instanceId,requestId:'fixture-'+(++nextId),...params});
 await request('model.sync',{source:'manual',models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'fixture',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'TEST_ONLY'}]});
 const options={root:app,configFile:path.join(app,'vite.config.ts'),cacheDir:path.join(root,'cache'),logLevel:'error'};
 const server=mode==='dev'?await createServer({...options,server:{host:'127.0.0.1',port:0,strictPort:false}}):await preview({...options,preview:{host:'127.0.0.1',port:0}});
 const context=await browser.newContext({viewport:{width:375,height:812},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
 const result={mode,checks:[],errors:[],screenshots:[]};report.results.push(result);const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};let restoreCount=0,restoreFailure=true,restoreWaiters=[],failCreate=true;
 try{
  if(mode==='dev')await server.listen();await installMobileBotEvents(context,host);
  await context.exposeBinding('__statesRestore',async()=>{restoreCount++;if(restoreFailure){await new Promise(resolve=>{restoreWaiters.push(resolve);});throw Error('ISOLATED_RESTORE_FAILURE');}return{active:{endpoint:'https://127.0.0.1:29421',botInstanceId:instanceId,name:'Isolated states'}};});
  await context.exposeBinding('__statesRpc',async(_source,{method,params})=>{if(method==='session.create'&&failCreate){failCreate=false;return{ok:false,code:'failed',message:'ISOLATED_CREATE_FAILURE'};}try{return{ok:true,result:await host.request(method,params)};}catch(error){return{ok:false,code:error.code??'failed',message:error.message};}});
  await context.addInitScript(()=>{window.CapacitorCustomPlatform={name:'ios'};window.Capacitor={PluginHeaders:[{name:'HemiBot',methods:['restore','request'].map(name=>({name,rtype:'promise'}))}],async nativePromise(plugin,method,options){if(method==='restore')return window.__statesRestore();if(method==='forget')return{};if(method==='request'){const value=await window.__statesRpc(options);if(!value.ok)throw Object.assign(Error(value.message),{code:value.code});return value;}throw Error('Unexpected native call');}};});
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>result.errors.push(e.message));const shot=async name=>{const file=path.join(out,mode+'-'+name+'.png');await page.screenshot({path:file});result.screenshots.push(file);};
  await page.goto(server.resolvedUrls.local[0]);await page.locator('[data-state-view="loading"]').filter({hasText:'正在恢复 Bot 连接…'}).waitFor();await wait(()=>restoreWaiters.length>0);await page.waitForTimeout(100);restoreFailure=false;for(const release of restoreWaiters)release();await page.getByRole('alert').filter({hasText:'无法读取本机连接身份'}).waitFor();await shot('restore-error-375');await page.getByRole('button',{name:'重试恢复连接',exact:true}).click();await page.getByRole('heading',{name:'还没有对话',exact:true}).waitFor();check('native restore uses shared loading/error views and retries into the actual empty workspace');
  await page.getByRole('button',{name:'新建对话',exact:true}).click();await page.getByText('未能新建对话，请重试。',{exact:true}).waitFor();assert.equal((await request('snapshot')).sessions.length,0);await page.getByRole('button',{name:'新建对话',exact:true}).click();await page.getByRole('textbox',{name:'消息',exact:true}).waitFor();await page.getByRole('heading',{name:'今天想做什么？',exact:true}).waitFor();await shot('welcome-375');check('failed creation stays recoverable; successful retry creates a real conversation and shared welcome state');
  const other=await request('session.create');await request('session.rename',{id:other.id,title:'列表选择验证'});
  const open=page.getByRole('button',{name:'打开对话列表',exact:true});await open.click();const drawer=page.getByRole('dialog',{name:'对话列表',exact:true});await drawer.waitFor();await drawer.getByRole('button',{name:'搜索对话',exact:true}).click();const search=drawer.getByRole('textbox',{name:'搜索对话标题',exact:true});await search.fill('不会匹配任何会话');await drawer.locator('[data-state-view="empty"]').getByText('没有找到相关对话',{exact:true}).waitFor();await shot('search-empty-375');await search.fill('列表选择验证');await drawer.getByRole('button').filter({hasText:'列表选择验证'}).waitFor();await drawer.getByRole('button').filter({hasText:'列表选择验证'}).click();await drawer.waitFor({state:'hidden'});await page.locator('.topbar-title strong').filter({hasText:'列表选择验证'}).waitFor();check('shared drawer groups and search empty state select the real Host conversation');
  await page.getByRole('textbox',{name:'消息',exact:true}).fill('切换列表后保留的草稿');await open.click();await drawer.waitFor();await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});assert.equal(await page.getByRole('textbox',{name:'消息',exact:true}).inputValue(),'切换列表后保留的草稿');check('drawer focus/close behavior retains the current draft');
  for(const width of [375,768,1440]){await page.setViewportSize({width,height:812});await page.waitForTimeout(350);await open.click();await drawer.waitFor();await shot('list-'+width);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});}
  await page.setViewportSize({width:375,height:812});await page.emulateMedia({colorScheme:'dark'});await page.waitForTimeout(350);await shot('dark-preference');assert.deepEqual(result.errors,[]);check('375/768/1440 layouts, system dark preference and no renderer errors');
 }catch(error){result.error=error.stack;throw error;}finally{await context.close();await server.close();await host.close();await fs.rm(root,{recursive:true,force:true});}
}}finally{await browser.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
