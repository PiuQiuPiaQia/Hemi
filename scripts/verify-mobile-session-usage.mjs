// Actual mobile renderer/workspace -> native bridge fixture -> Bot Host usage ledger.
// Synthetic executor calls only; no credentials, model service or personal data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer, preview} from 'vite';
import {chromium} from 'playwright-core';
import {createBotHost} from '../src/main/bot/host.mjs';
import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';

const repo=path.resolve(import.meta.dirname,'..'), app=path.join(repo,'apps/mobile');
const output=path.join(repo,'.visual/workflow/mobile-session-usage');
await fs.mkdir(output,{recursive:true});
const report={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:`${os.type()} ${os.release()} ${process.arch}`,sources:{},results:[]};
for(const name of ['apps/mobile/src/app.tsx','apps/mobile/src/style.css','apps/mobile/src/workspace.ts','apps/mobile/src/bot/workspace-client.ts','packages/ui/src/info-popover.tsx','packages/conversation-flow/src/controls/session-usage-view.tsx','packages/conversation-flow/src/styles/source/touch.css'])report.sources[name]=createHash('sha256').update(await fs.readFile(path.join(repo,name))).digest('hex');
const browser=await chromium.launch({executablePath:process.env.HEMI_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
report.browser=browser.version();
const until=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Usage verification timed out');};
try {
 for(const mode of ['dev','built']) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-mobile-usage-'));
  process.env.HEMI_USER_DATA_DIR=path.join(root,'profile');
  const runs=new Map();let recordUsage,offline=false,holdSnapshot=false,heldSnapshot;
  const host=await createBotHost({dataDir:path.join(root,'data'),defaultDir:path.join(root,'work'),validateModel:async()=>{},executorFactory:options=>{
   recordUsage=options.recordUsage;
   return {run:spec=>new Promise(resolve=>runs.set(spec.conversationId,{spec,resolve})),stop:async id=>runs.get(id)?.resolve({stopped:true}),close:async()=>{for(const run of runs.values())run.resolve({stopped:true});}};
  }});
  const {instanceId}=await host.request('handshake');
  const call=(method,params={})=>host.request(method,{instanceId,requestId:randomUUID(),...params});
  await call('model.sync',{models:[{modelKey:'fixture/main',providerId:'fixture',name:'Synthetic',model:'synthetic-model',api:'openai-completions',baseUrl:'https://example.invalid',apiKey:'NOT_A_CREDENTIAL'}]});
  const missing=await call('session.create');await call('session.rename',{id:missing.id,title:'缺失用量'});
  const empty=await call('session.create');await call('session.rename',{id:empty.id,title:'空白会话'});
  const session=await call('session.create');await call('session.rename',{id:session.id,title:'模型用量验证'});
  recordUsage(missing.id,{modelKey:'fixture/main',modelName:'synthetic-model',at:1,usageDetail:null});
  const options={configFile:path.join(app,'vite.config.ts'),root:app,cacheDir:path.join(root,'vite-cache'),logLevel:'error'};
  const server=mode==='dev'?await createServer({...options,server:{host:'127.0.0.1',port:0}}):await preview({...options,preview:{host:'127.0.0.1',port:0}});
  const context=await browser.newContext({viewport:{width:375,height:812},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
  const result={mode,checks:[],errors:[],screenshots:[]};report.results.push(result);
  const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};
  try {
   await installMobileBotEvents(context,host,{offline:()=>offline});
   await context.exposeBinding('__usageRpc',async(_source,{method,params})=>{
    if(offline)return{ok:false,message:'Isolated offline'};
    try {
     const value=await host.request(method,params);
     if(method==='snapshot'&&holdSnapshot){holdSnapshot=false;await new Promise(resolve=>{heldSnapshot=resolve;});}
     return{ok:true,result:value};
    }catch(error){return{ok:false,message:error.message,code:error.code};}
   });
   await context.addInitScript(target=>{
    window.CapacitorCustomPlatform={name:'ios'};
    const callbacks=new Map();let serial=0;
    window.__usageKeyboard=height=>{for(const item of callbacks.values())if(item.eventName===(height?'keyboardWillShow':'keyboardWillHide'))item.callback({keyboardHeight:height});};
    window.Capacitor={PluginHeaders:[{name:'HemiBot',methods:['restore','request'].map(name=>({name,rtype:'promise'}))},{name:'Keyboard',methods:[{name:'addListener',rtype:'callback'},{name:'removeListener',rtype:'promise'}]}],
     nativeCallback(plugin,method,options,callback){if(plugin!=='Keyboard'||method!=='addListener')throw Error('Unexpected callback');const id=String(++serial);callbacks.set(id,{eventName:options.eventName,callback});return Promise.resolve(id);},
     async nativePromise(plugin,method,options){
      if(plugin==='Keyboard'&&method==='removeListener'){callbacks.delete(options.callbackId);return{};}
      if(method==='restore')return{active:target};
      if(method==='request'){const value=await window.__usageRpc(options);if(!value.ok)throw Object.assign(Error(value.message),{code:value.code});return value;}
      throw Error('Unexpected native call');
     }};
   },{endpoint:'https://127.0.0.1:29421',botInstanceId:instanceId,name:'Usage Bot'});
   const page=await context.newPage();page.setDefaultTimeout(12000);
   const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,left:0,right:0,bottom:34}});
   page.on('pageerror',error=>result.errors.push(error.message));
   page.on('console',message=>{if(message.type()==='error')result.errors.push(message.text());});
   const shot=async name=>{const file=path.join(output,`${mode}-${name}.png`);await page.screenshot({path:file});result.screenshots.push(file);};
   const entry=page.locator('.h48-usage-entry'),input=page.getByRole('textbox',{name:'消息',exact:true});
   const choose=async title=>{await page.getByRole('button',{name:'打开对话列表',exact:true}).tap();await page.locator('.drawer-row').filter({hasText:title}).tap();await page.getByRole('button',{name:'选择模型',exact:true}).filter({hasText:title}).waitFor();};
   if(mode==='dev')await server.listen();await page.goto(server.resolvedUrls.local[0]);await input.waitFor();
   assert.equal(await entry.count(),0);const originalComposer=await page.locator('.input-dock').boundingBox();check('empty usage does not add a footer');
   await input.fill('生成测试调用');await page.getByRole('button',{name:'发送消息',exact:true}).tap();await until(()=>runs.has(session.id));
   recordUsage(session.id,{role:'main',modelKey:'fixture/main',modelName:'synthetic-model',at:2,usageDetail:{input:200,cacheRead:800,cacheWrite:0,output:100,genMs:2000}});
   runs.get(session.id).resolve({});
   await page.waitForFunction(()=>document.querySelector('.h48-usage-entry')?.textContent.includes('50 token/s'));
   assert.match(await entry.innerText(),/缓存命中 80%/);
   const unchangedComposer=await page.locator('.input-dock').boundingBox();assert.deepEqual(unchangedComposer,originalComposer,'usage must not move or resize the composer');
   const bounds=await page.locator('.composer-surface').boundingBox(),foot=await entry.boundingBox();assert.ok(foot.y>=bounds.y+bounds.height-1);assert.equal(foot.height,20);
   await input.fill('查看用量时保留草稿');await entry.tap();
   const dialog=page.getByRole('dialog',{name:'本会话用量',exact:true});await dialog.waitFor();
   assert.equal(await dialog.evaluate(node=>!!node.closest('[inert]')),false);
   assert.match(await dialog.getByLabel('整体用量').innerText(),/80%/);
   await dialog.getByRole('button',{name:'模型',exact:true}).tap();await dialog.getByRole('table',{name:'各模型用量'}).waitFor();
   await dialog.getByRole('button',{name:'角色',exact:true}).tap();await dialog.getByRole('rowheader',{name:'主助手',exact:true}).waitFor();
   await shot('details-375');await dialog.getByRole('button',{name:'关闭本会话用量',exact:true}).tap();await dialog.waitFor({state:'hidden'});
   await page.waitForFunction(()=>document.activeElement?.classList.contains('h48-usage-entry'));
   assert.equal(await input.inputValue(),'查看用量时保留草稿');
   check('actual Host ledger drives TPS/cache; shared touch detail switches dimensions and preserves the draft');

   await page.getByRole('button',{name:'发送消息',exact:true}).tap();await until(()=>runs.get(session.id)?.spec.envelope.text==='查看用量时保留草稿');
   await page.locator('.h48-usage-dot').waitFor();
   recordUsage(session.id,{role:'explorer',modelKey:'fixture/long-model-name-for-usage-table',modelName:'very-long-model-name-for-usage-table',at:3,usageDetail:{input:100,cacheRead:100,cacheWrite:0,output:300,genMs:1000}});
   runs.get(session.id).resolve({});
   await page.waitForFunction(()=>document.querySelector('.h48-usage-entry')?.textContent.includes('133 token/s'));
   assert.match(await entry.innerText(),/缓存命中 75%/);await page.locator('.h48-usage-dot').waitFor({state:'hidden'});
   check('completion events refresh the weighted session totals without counting calls twice');

   for(const width of [320,375,414,768,1440]) {
    await page.setViewportSize({width,height:width===320?568:900});
    await shot(`footer-${width}`);await entry.tap();await dialog.waitFor();
    const panel=await dialog.boundingBox();assert.ok(panel.x>=-1&&panel.x+panel.width<=width+1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await dialog.getByRole('button',{name:'模型',exact:true}).tap();
    const table=dialog.getByRole('table',{name:'各模型用量'});assert.equal(await table.evaluate(node=>node.scrollWidth>node.clientWidth),false);
    await shot(`details-${width}`);await dialog.getByRole('button',{name:'关闭本会话用量',exact:true}).tap();await dialog.waitFor({state:'hidden'});
   }
   await page.setViewportSize({width:375,height:812});await entry.tap();await dialog.waitFor();await page.evaluate(()=>window.__usageKeyboard(300));
   assert.equal((await page.locator('.mobile-usage-slot').boundingBox()).height,0);
   await until(async()=>{const bounds=await dialog.boundingBox();return bounds&&bounds.y+bounds.height<=513;});await shot('keyboard-375');await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});await page.evaluate(()=>window.__usageKeyboard(0));
   await page.emulateMedia({colorScheme:'dark'});await shot('system-dark-375');
   assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'light');
   check('320/375/414/768/1440 fit; fixed composer, compact safe-area footer, long labels, keyboard viewport and light theme');

   await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,left:0,right:0,bottom:0}});await choose('空白会话');const noInsetComposer=await page.locator('.input-dock').boundingBox();await choose('模型用量验证');await page.waitForFunction(()=>document.querySelector('.h48-usage-entry')?.textContent.includes('133 token/s'));assert.deepEqual(await page.locator('.input-dock').boundingBox(),noInsetComposer);assert.equal((await page.locator('.mobile-usage-slot').boundingBox()).height,0);await shot('no-safe-area');await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,left:0,right:0,bottom:34}});
   check('without bottom safe-area space the footer stays clipped and the composer still does not move');

   await choose('空白会话');assert.equal(await entry.count(),0);
   await choose('缺失用量');await page.getByText('用量暂未返回',{exact:true}).waitFor();await entry.tap();await dialog.waitFor();await dialog.getByRole('rowheader',{name:'未分类',exact:true}).waitFor();assert.deepEqual(await dialog.locator('.h48-usage-total b').allTextContents(),['—','—','—','—']);await dialog.getByRole('button',{name:'关闭本会话用量',exact:true}).tap();await dialog.waitFor({state:'hidden'});
   await choose('模型用量验证');await page.waitForFunction(()=>document.querySelector('.h48-usage-entry')?.textContent.includes('133 token/s'));
   // Hold an old-session catalog response while selecting a different conversation.
   holdSnapshot=true;await call('session.rename',{id:session.id,title:'模型用量验证'});await until(()=>!!heldSnapshot);
   await choose('空白会话');heldSnapshot();heldSnapshot=undefined;
   await until(()=>!holdSnapshot);await page.waitForTimeout(200);assert.equal(await entry.count(),0);
   await choose('模型用量验证');await page.waitForFunction(()=>document.querySelector('.h48-usage-entry')?.textContent.includes('133 token/s'));
   offline=true;await page.reload();await input.waitFor();await page.waitForFunction(()=>document.querySelector('.h48-usage-entry')?.textContent.includes('133 token/s'));
   assert.match(await entry.innerText(),/75%/);await entry.tap();await dialog.waitFor();await shot('offline-details');
   check('per-session isolation, missing usage, late catalog responses and offline reload preserve the correct totals');
   assert.deepEqual(result.errors,[]);check('no renderer errors');
  }catch(error){result.error=error.stack;throw error;}
  finally{heldSnapshot?.();await context.close();await server.close();await host.close();await fs.rm(root,{recursive:true,force:true});}
 }
}finally{await browser.close();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');}
