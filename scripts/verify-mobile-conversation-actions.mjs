// Real mobile renderer/workspace/Host. Native network and model execution are isolated boundaries.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer,preview} from 'vite';
import {chromium} from 'playwright-core';
import {createBotHost} from '../src/main/bot/host.mjs';
import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';
const repo=path.resolve(import.meta.dirname,'..'),app=path.join(repo,'apps/mobile'),out=path.join(repo,'.visual/workflow/mobile-conversation-actions');
await fs.mkdir(out,{recursive:true});
const report={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:process.platform+'/'+process.arch,results:[]};
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const wait=async fn=>{const end=Date.now()+10000;while(!await fn()){assert.ok(Date.now()<end,'condition timed out');await new Promise(resolve=>setTimeout(resolve,20));}};
try{for(const mode of ['dev','built']){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-actions-ui-')),live=new Map(),calls=[];
 const host=await createBotHost({dataDir:path.join(root,'data'),defaultDir:path.join(root,'workspace'),validateModel:async()=>{},executorFactory:()=>({run(spec){return new Promise(resolve=>live.set(spec.conversationId,resolve));},async stop(id){live.get(id)?.({stopped:true});},async close(){for(const resolve of live.values())resolve({stopped:true});}})});
 const {instanceId}=await host.request('handshake'),request=(method,params={})=>host.request(method,{instanceId,requestId:randomUUID(),...params});
 await request('model.sync',{models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'fixture',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'SYNTHETIC_ONLY'}]});
 const current=await request('session.create');await request('session.rename',{id:current.id,title:'当前会话'});
 const other=await request('session.create');await request('session.rename',{id:other.id,title:'待管理的历史会话'});
 const options={root:app,configFile:path.join(app,'vite.config.ts'),cacheDir:path.join(root,'cache'),logLevel:'error'};
 const server=mode==='dev'?await createServer({...options,server:{host:'127.0.0.1',port:0,strictPort:false}}):await preview({...options,preview:{host:'127.0.0.1',port:0}});
 const context=await browser.newContext({viewport:{width:375,height:812},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
 const result={mode,checks:[],errors:[],screenshots:[]};report.results.push(result);const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};
 let offline=false,rejectRename=false,dropReply=false,holdRename=false,releaseRename;
 try{
  if(mode==='dev')await server.listen();await installMobileBotEvents(context,host,{offline:()=>offline});
  await context.exposeBinding('__actionsRpc',async(_source,{method,params})=>{
   if(offline)return{ok:false,code:'network',message:'ISOLATED_OFFLINE'};calls.push({method,params});
   if(method==='session.rename'&&holdRename)await new Promise(resolve=>{releaseRename=resolve;});
   if(method==='session.rename'&&rejectRename){rejectRename=false;return{ok:false,code:'failed',message:'ISOLATED_RENAME_REJECTION'};}
   try{const value=await host.request(method,params);if(method==='session.rename'&&dropReply){dropReply=false;return{ok:false,code:'network',message:'ISOLATED_LOST_REPLY'};}return{ok:true,result:value};}catch(error){return{ok:false,code:error.code??'failed',message:error.message};}
  });
  await context.addInitScript(({instanceId})=>{window.CapacitorCustomPlatform={name:'ios'};window.Capacitor={PluginHeaders:[{name:'HemiBot',methods:['restore','request'].map(name=>({name,rtype:'promise'}))}],async nativePromise(plugin,method,options){if(method==='restore')return{active:{endpoint:'https://127.0.0.1:29421',botInstanceId:instanceId,name:'Isolated actions'}};if(method==='forget')return{};if(method==='request'){const value=await window.__actionsRpc(options);if(!value.ok)throw Object.assign(Error(value.message),{code:value.code});return value;}throw Error('Unexpected native call');}};},{instanceId});
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>result.errors.push(error.message));
  const shot=async name=>{const file=path.join(out,mode+'-'+name+'.png');await page.screenshot({path:file});result.screenshots.push(file);};
  const drawer=page.getByRole('dialog',{name:'对话列表',exact:true}),open=page.getByRole('button',{name:'打开对话列表',exact:true});
  const menu=page.getByRole('dialog',{name:'会话操作',exact:true}),rename=page.getByRole('dialog',{name:'重命名会话',exact:true}),confirmation=page.getByRole('dialog',{name:'删除会话？',exact:true});
  const actions=title=>page.getByRole('button',{name:'会话操作：'+title,exact:true});
  await page.goto(server.resolvedUrls.local[0]);await open.waitFor();await open.click();await drawer.locator('.drawer-row').filter({hasText:'当前会话'}).click();await drawer.waitFor({state:'hidden'});
  const composer=page.getByRole('textbox',{name:'消息',exact:true});await composer.fill('管理历史条目时保留的草稿');
  await open.click();await actions('待管理的历史会话').waitFor();
  assert.equal(await drawer.locator('button button').count(),0);
  for(const button of await drawer.locator('.drawer-row-actions>.icon-control').all()){const box=await button.boundingBox();assert.ok(box.width>=44&&box.height>=44);}
  await shot('list-375');await actions('待管理的历史会话').click();await menu.waitFor();assert.equal(await page.locator('.topbar-title strong').textContent(),'当前会话');
  assert.equal(await page.locator('.conversation-drawer').evaluate(node=>node.inert),true);await shot('menu-375');await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
  await wait(()=>actions('待管理的历史会话').evaluate(node=>node===document.activeElement));check('visible 44px actions are sibling buttons; opening preserves selection and Escape restores focus');
  await actions('待管理的历史会话').click();await menu.getByRole('button',{name:'重命名',exact:true}).click();await rename.getByRole('textbox',{name:'会话名称',exact:true}).fill('取消不落盘');await rename.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await request('session.open',{id:other.id})).title,'待管理的历史会话');
  await actions('待管理的历史会话').click();await menu.getByRole('button',{name:'重命名',exact:true}).click();const name=rename.getByRole('textbox',{name:'会话名称',exact:true});await name.fill('历史会话的新名称');
  rejectRename=true;await rename.getByRole('button',{name:'保存',exact:true}).click();await rename.getByRole('alert').filter({hasText:'ISOLATED_RENAME_REJECTION'}).waitFor();
  holdRename=true;dropReply=true;await rename.getByRole('button',{name:'保存',exact:true}).click();await wait(()=>!!releaseRename);assert.equal(await rename.getByRole('button',{name:'正在保存…',exact:true}).isDisabled(),true);await page.keyboard.press('Escape');assert.equal(await rename.isVisible(),true);releaseRename();holdRename=false;await rename.waitFor({state:'hidden'});
  await actions('历史会话的新名称').waitFor();assert.equal(calls.filter(call=>call.method==='session.rename').length,2);assert.equal((await request('session.open',{id:other.id})).title,'历史会话的新名称');
  await wait(()=>drawer.evaluate(node=>node.contains(document.activeElement)));await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});assert.equal(await composer.inputValue(),'管理历史条目时保留的草稿');check('rename cancel, Host rejection/retry, busy guard and lost receipt preserve the current draft');
  await page.reload();await open.waitFor();await open.click();await actions('历史会话的新名称').waitFor();
  for(const width of [375,768,1440]){await page.setViewportSize({width,height:812});await page.waitForTimeout(300);await shot('list-'+width);await actions('历史会话的新名称').click();await menu.getByRole('button',{name:'重命名',exact:true}).click();await shot('rename-'+width);await rename.getByRole('button',{name:'取消',exact:true}).click();await actions('历史会话的新名称').click();await menu.getByRole('button',{name:'删除会话',exact:true}).click();await shot('delete-'+width);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await confirmation.getByRole('button',{name:'取消',exact:true}).click();}
  await page.setViewportSize({width:375,height:812});await page.emulateMedia({colorScheme:'dark'});await actions('历史会话的新名称').click();await shot('dark-preference');await page.keyboard.press('Escape');check('375/768/1440 and dark preference layouts keep controls visible; rename persists across reload');
  offline=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await wait(()=>drawer.locator('.drawer-bot small').textContent().then(text=>text==='连接已断开'));
  await actions('历史会话的新名称').click();await menu.getByRole('status').filter({hasText:'恢复连接后可管理会话'}).waitFor();assert.equal(await menu.getByRole('button',{name:'重命名',exact:true}).isDisabled(),true);assert.equal(await menu.getByRole('button',{name:'删除会话',exact:true}).isDisabled(),true);await shot('offline-375');await page.keyboard.press('Escape');
  offline=false;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await wait(()=>drawer.locator('.drawer-bot small').textContent().then(text=>text==='已连接'));check('offline actions explain why they are disabled and recover after reconnect');
  const removes=()=>calls.filter(call=>call.method==='session.remove').length;
  await actions('历史会话的新名称').click();await menu.getByRole('button',{name:'删除会话',exact:true}).click();assert.equal(removes(),0);await confirmation.getByRole('button',{name:'取消',exact:true}).click();assert.equal(removes(),0);
  await actions('历史会话的新名称').click();await menu.getByRole('button',{name:'删除会话',exact:true}).click();await confirmation.getByRole('button',{name:'确认删除',exact:true}).click();await confirmation.waitFor({state:'hidden'});assert.equal(removes(),1);await actions('历史会话的新名称').waitFor({state:'hidden'});assert.equal((await request('snapshot')).sessions.length,1);
  await wait(()=>drawer.evaluate(node=>node.contains(document.activeElement)));await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});assert.equal(await composer.inputValue(),'管理历史条目时保留的草稿');check('delete requires explicit confirmation, deletes the selected historical item and preserves current draft/focus');
  await composer.fill('删除运行中的当前会话');await page.getByRole('button',{name:'发送消息',exact:true}).click();await wait(()=>live.has(current.id));await open.click();await actions('当前会话').click();await menu.getByRole('button',{name:'删除会话',exact:true}).click();await confirmation.getByText(/正在执行的任务也会停止/).waitFor();await confirmation.getByRole('button',{name:'确认删除',exact:true}).click();await page.getByRole('heading',{name:'还没有对话',exact:true}).waitFor();assert.equal((await request('snapshot')).sessions.length,0);assert.deepEqual(result.errors,[]);check('deleting the running current session stops it and returns to the shared empty workspace without renderer errors');
 }catch(error){result.error=error.stack;const page=context.pages()[0];if(page)await page.screenshot({path:path.join(out,mode+'-failure.png')});throw error;}finally{releaseRename?.();await context.close();await server.close();await host.close();await fs.rm(root,{recursive:true,force:true});}
}}finally{await browser.close();await fs.writeFile(path.join(out,'ui-report.json'),JSON.stringify(report,null,2));}
