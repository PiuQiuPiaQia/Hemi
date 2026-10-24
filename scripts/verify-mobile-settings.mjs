// Mobile renderer -> native bridge boundary fixture -> actual Bot Host/controller/filesystem.
// No real user data or external model is used. Native TLS is covered separately.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer,preview} from 'vite';
import {chromium} from 'playwright-core';
import {createBotHost} from '../src/main/bot/host.mjs';

const repo=path.resolve(import.meta.dirname,'..'),app=path.join(repo,'apps/mobile');
const output=path.join(repo,'.visual/workflow/mobile-settings');await fs.mkdir(output,{recursive:true});
const report={date:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:process.platform+'/'+process.arch,sources:{},results:[]};
for(const name of ['apps/mobile/src/app.tsx','apps/mobile/src/workspace.ts','apps/mobile/src/composer.tsx','apps/mobile/src/style.css','apps/mobile/src/host/app-viewport.ts','apps/mobile/src/bot/workspace-client.ts','apps/mobile/src/components/directory-panel.tsx','apps/mobile/src/components/dialog.tsx','apps/mobile/src/components/conversation-drawer.tsx','apps/mobile/src/components/chat-panels.tsx','packages/conversation-flow/src/components/virtual-transcript.tsx','apps/mobile/capacitor.config.ts','apps/mobile/package.json','package-lock.json','scripts/verify-mobile-settings.mjs'])report.sources[name]=createHash('sha256').update(await fs.readFile(path.join(repo,name))).digest('hex');
const browser=await chromium.launch({executablePath:process.env.HEMI_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 for(const mode of ['dev','built']) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-settings-ui-'))),work=path.join(root,'workspace'),project=path.join(work,'项目'),slow=path.join(work,'迟到的目录');
  const runs=[],requests=[];let dropUpdate=false,networkDown=false,releaseDirectory,heldDirectory;
  const host=await createBotHost({dataDir:path.join(root,'data'),defaultDir:work,validateModel:async()=>{},executorFactory:()=>({run:async spec=>{runs.push(spec);return{stopped:false};},stop:async()=>{},close:async()=>{}})});
  await fs.mkdir(project,{recursive:true});await fs.mkdir(slow);await fs.mkdir(path.join(work,'用于检查较长名称换行和点击区域的项目文件夹'));
  const {instanceId}=await host.request('handshake'),target={endpoint:'https://127.0.0.1:29421',botInstanceId:instanceId,name:'Isolated settings Bot'};
  const call=(method,params={})=>host.request(method,{instanceId,requestId:randomUUID(),...params});
  await call('model.sync',{models:[['one','模型一'],['two','模型二']].map(([key,name])=>({modelKey:`fixture/${key}`,providerId:'fixture',name,model:key,api:'openai-completions',baseUrl:'https://example.invalid',apiKey:'NOT_A_CREDENTIAL'}))});
  const other=await call('session.create');await call('session.rename',{id:other.id,title:'另一个对话'});
  const session=await call('session.create');await call('session.rename',{id:session.id,title:'移动端设置验证'});
  const options={configFile:path.join(app,'vite.config.ts'),root:app,logLevel:'error'};
  const server=mode==='dev'?await createServer({...options,server:{host:'127.0.0.1',port:0}}):await preview({...options,preview:{host:'127.0.0.1',port:0}});
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
  const result={mode,checks:[],errors:[],screenshots:[]};report.results.push(result);
  const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};
  try {
   if(mode==='dev')await server.listen();const url=server.resolvedUrls.local[0];
   await context.exposeBinding('__hemiSettingsRpc',async(_source,{method,params})=>{
    requests.push({method,params});
    if(networkDown)return{ok:false,code:'network',message:'Isolated connection unavailable'};
    if(method==='directory.list'&&params.path===heldDirectory)await new Promise(resolve=>{releaseDirectory=resolve;});
    try {const value=await host.request(method,params);if(dropUpdate&&method==='session.update'){dropUpdate=false;return{ok:false,code:'network',message:'Isolated reply lost'};}return{ok:true,result:value};}
    catch(error){return{ok:false,code:error.code??'failed',message:error.message};}
   });
   await context.addInitScript(target=>{
    const callbacks=new Map();let nextCallback=0;
    window.__hemiKeyboard={emit(eventName,keyboardHeight=0){for(const listener of callbacks.values())if(listener.eventName===eventName)listener.callback({keyboardHeight});}};
    window.CapacitorCustomPlatform={name:location.search.includes('browserViewport')?'web':'ios'};
    window.Capacitor={PluginHeaders:[{name:'HemiBot',methods:['restore','request'].map(name=>({name,rtype:'promise'}))},{name:'Keyboard',methods:[{name:'addListener',rtype:'callback'},{name:'removeListener',rtype:'promise'}]}],nativeCallback(plugin,method,options,callback){
     if(plugin!=='Keyboard'||method!=='addListener')throw new Error('Unexpected native callback');
     const id=String(++nextCallback);callbacks.set(id,{eventName:options.eventName,callback});return Promise.resolve(id);
    },async nativePromise(plugin,method,options){
     if(plugin==='Keyboard'&&method==='removeListener'){callbacks.delete(options.callbackId);return{};}
     if(method==='restore')return{active:target};
     if(method==='request'){const value=await window.__hemiSettingsRpc(options);if(!value.ok)throw Object.assign(new Error(value.message),{code:value.code});return value;}
     throw new Error('Unexpected native bridge method');
    }};
   },target);
   const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>result.errors.push(error.message));page.on('console',message=>{if(message.type()==='error')result.errors.push(message.text());});
   const shot=async name=>{const file=path.join(output,`${mode}-${name}.png`);await page.screenshot({path:file});result.screenshots.push(file);};
   const expect=async predicate=>{await assertEventually(predicate);};
   await page.goto(url);const input=page.getByRole('textbox',{name:'消息',exact:true});await input.waitFor();
   await input.fill('保留草稿，使用新的设置');
   const thinking=page.getByRole('button',{name:'思考强度：自动',exact:true});await thinking.click();
   const thinkingDialog=page.getByRole('dialog',{name:'思考强度',exact:true});await thinkingDialog.waitFor();
   assert.equal(await thinkingDialog.getByRole('button',{name:/^自动/}).getAttribute('aria-pressed'),'true');
   await shot('thinking-390');await thinkingDialog.getByRole('button',{name:/^高/}).click();await thinkingDialog.waitFor({state:'hidden'});
   await page.getByRole('button',{name:'思考强度：高',exact:true}).waitFor();
   await page.getByRole('button',{name:/^切换模型：/}).click();const models=page.getByRole('dialog',{name:'选择模型',exact:true});await models.getByRole('button',{name:/模型二/}).click();await models.waitFor({state:'hidden'});
   assert.equal(await input.inputValue(),'保留草稿，使用新的设置');
   check('composer model and thinking selectors persist through actual Host updates without clearing the SDK draft');

   const folderTrigger=page.getByRole('button',{name:/^工作目录：/});heldDirectory=work;await folderTrigger.click();
   const folders=page.getByRole('dialog',{name:'选择工作目录',exact:true}),pathInput=folders.getByRole('textbox',{name:'服务器目录路径',exact:true}),choose=folders.getByRole('button',{name:'使用此目录',exact:true});
   await expect(()=>!!releaseDirectory);await pathInput.fill(path.join(root,'missing'));releaseDirectory();heldDirectory=null;
   await folders.getByRole('button',{name:'项目',exact:true}).waitFor();assert.equal(await pathInput.inputValue(),path.join(root,'missing'));
   assert.equal(await choose.isDisabled(),true);await folders.getByRole('button',{name:'前往',exact:true}).click();
   await folders.getByRole('alert').waitFor();assert.equal(await choose.isDisabled(),true);
   await pathInput.fill(work);await folders.getByRole('button',{name:'前往',exact:true}).click();await folders.getByRole('button',{name:'项目',exact:true}).waitFor();
   heldDirectory=slow;releaseDirectory=null;await folders.getByRole('button',{name:'迟到的目录',exact:true}).click();
   await expect(()=>!!releaseDirectory);await pathInput.fill(project);await folders.getByRole('button',{name:'前往',exact:true}).click();
   await expect(async()=>await choose.isEnabled());releaseDirectory();heldDirectory=null;
   await folders.getByText('没有子文件夹',{exact:true}).waitFor();assert.equal(await pathInput.inputValue(),project);
   await folders.getByRole('button',{name:'上一级目录',exact:true}).click();await folders.getByRole('button',{name:'项目',exact:true}).waitFor();
   await folders.getByRole('button',{name:'项目',exact:true}).click();await expect(async()=>await choose.isEnabled());
   await fs.rename(project,project+'-moved');await choose.click();await folders.getByRole('alert').waitFor();assert.equal(await input.inputValue(),'保留草稿，使用新的设置');await fs.rename(project+'-moved',project);
   await choose.click();await folders.waitFor({state:'hidden'});
   await page.getByRole('button',{name:`工作目录：${project}`,exact:true}).waitFor();
   check('real server directory navigation, manual paths, parent, unreadable path rejection and stale response guard; selected directory is saved');

   dropUpdate=true;const previous=requests.filter(item=>item.method==='session.update').length;
   await page.getByRole('button',{name:'思考强度：高',exact:true}).click();await thinkingDialog.getByRole('button',{name:/^中/}).click();await thinkingDialog.waitFor({state:'hidden'});
   assert.equal(requests.filter(item=>item.method==='session.update').length,previous+1);assert.ok(requests.some(item=>item.method==='operation.get'));
   await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(()=>runs.length===1);
   assert.equal(runs[0].envelope.modelPolicySnapshot.thinkingLevel,'medium');assert.equal(runs[0].envelope.workspaceSnapshot.dir,project);assert.equal(runs[0].envelope.modelPolicySnapshot.modelKey,'fixture/two');
   check('lost settings reply uses its original receipt without mutation replay; accepted input captures selected model/thinking/directory');

   await page.reload();await page.getByRole('button',{name:'思考强度：中',exact:true}).waitFor();await page.getByRole('button',{name:`工作目录：${project}`,exact:true}).waitFor();
   for(const width of [320,375,390,768,1440]) {
    await page.setViewportSize({width,height:844});await shot(`composer-${width}`);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'思考强度：中',exact:true}).click();assert.equal(await thinkingDialog.evaluate(node=>node.scrollWidth>node.clientWidth),false);await shot(`thinking-${width}`);await thinkingDialog.getByRole('button',{name:'关闭',exact:true}).click();
   }
   await page.setViewportSize({width:375,height:480});await folderTrigger.click();await expect(async()=>await choose.isEnabled());assert.equal(await folders.evaluate(node=>node.scrollWidth>node.clientWidth),false);await choose.scrollIntoViewIfNeeded();await shot('directory-short');await folders.getByRole('button',{name:'关闭',exact:true}).click();
   await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme:'dark'});await folderTrigger.click();await expect(async()=>await choose.isEnabled());await shot('directory-system-dark');await folders.getByRole('button',{name:'关闭',exact:true}).click();
   await page.getByRole('button',{name:'打开对话列表',exact:true}).click();await page.getByRole('button',{name:/另一个对话/}).click();await page.getByRole('button',{name:'思考强度：自动',exact:true}).waitFor();await page.getByRole('button',{name:`工作目录：${work}`,exact:true}).waitFor();
   check('reload restores server settings; other conversation retains its own settings; 320/375/390/768/1440, short and system dark layouts fit');

   await call('flow.command',{id:other.id,command:{type:'send',input:{inputId:randomUUID(),text:Array.from({length:40},(_,i)=>`历史段落 ${i}：用于验证键盘打开后仍保持最后一段可见。`).join('\n\n'),inputSource:'text',attachmentIds:[]}}});
   for(let i=0;i<20;i++) {
    await expect(async()=>(await call('flow.snapshot',{id:other.id})).phase==='idle');
    await call('flow.command',{id:other.id,command:{type:'send',input:{inputId:randomUUID(),text:`历史消息 ${i}：多条消息与虚拟列表的键盘滚动回归。`,inputSource:'text',attachmentIds:[]}}});
   }
   await page.reload();await input.waitFor();
   await page.emulateMedia({colorScheme:'light'});await page.setViewportSize({width:390,height:844});
   assert.equal(await page.locator('html').getAttribute('data-viewport-owner'),'native');
   const transcript=page.locator('.conversation-frame [data-slot="scroll-area-viewport"]');await transcript.waitFor();
   const atBottom=()=>transcript.evaluate(node=>Math.abs(node.scrollHeight-node.scrollTop-node.clientHeight)<3);
   await expect(atBottom);
   const geometry=()=>page.evaluate(()=>({top:document.querySelector('.app-topbar').getBoundingClientRect().top,shell:document.querySelector('.mobile-shell').getBoundingClientRect().height,rootY:window.scrollY,rootScroll:document.scrollingElement.scrollTop,bottom:document.querySelector('.composer-context').getBoundingClientRect().bottom,flowHeight:document.querySelector('.conversation-frame').getBoundingClientRect().height}));
   const initial=await geometry();
   await page.evaluate(()=>{const original=HTMLElement.prototype.focus;window.__hemiFocusCalls=[];HTMLElement.prototype.focus=function(options){window.__hemiFocusCalls.push(options?.preventScroll===true);return original.call(this,options);};});
   for(const label of ['选择模型','选择工作目录']) {
    await page.getByRole('button',{name:label,exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
    assert.equal((await geometry()).top,initial.top);
   }
   await expect(async()=>(await page.evaluate(()=>window.__hemiFocusCalls.length))>=4);
   const focusCalls=await page.evaluate(()=>window.__hemiFocusCalls);assert.ok(focusCalls.every(Boolean));
   await input.click();
   // The real device leaves its layout viewport full-height when the keyboard overlays it.
   await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>500});visualViewport.dispatchEvent(new Event('resize'));window.__hemiKeyboard.emit('keyboardWillShow',344);window.__hemiKeyboard.emit('keyboardDidShow',344);});
   assert.equal(await page.locator('html').evaluate(node=>node.style.getPropertyValue('--app-height')),'');
   assert.equal(await page.locator('html').evaluate(node=>node.style.getPropertyValue('--sa-bottom')),'0');
   let compact=await geometry();assert.equal(compact.shell,500);assert.equal(compact.top,initial.top);assert.equal(compact.rootY,0);assert.equal(compact.rootScroll,0);assert.equal(compact.bottom,500);assert.equal(compact.flowHeight,initial.flowHeight-344);await expect(atBottom);
   await input.fill(Array.from({length:30},(_,i)=>`多行输入 ${i}`).join('\n'));await input.evaluate(node=>{node.scrollTop=node.scrollHeight;});
   compact=await geometry();assert.equal(compact.top,initial.top);assert.ok(compact.bottom<=500);
   await shot('keyboard-native-390');
   await page.getByRole('button',{name:'选择工作目录',exact:true}).click();await pathInput.waitFor();await pathInput.click();assert.equal((await geometry()).top,initial.top);await shot('keyboard-directory-390');await folders.getByRole('button',{name:'关闭',exact:true}).click();
   await input.fill('');await page.evaluate(()=>{window.__hemiKeyboard.emit('keyboardWillHide');window.__hemiKeyboard.emit('keyboardDidHide');delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'));});
   assert.equal(await page.locator('html').evaluate(node=>node.style.getPropertyValue('--sa-bottom')),'1');assert.deepEqual(await geometry(),initial);await expect(atBottom);
   await page.emulateMedia({reducedMotion:'no-preference'});
   for(let cycle=0;cycle<3;cycle++) {
    await input.click();await page.evaluate(()=>{window.__hemiKeyboard.emit('keyboardWillShow',344);window.__hemiKeyboard.emit('keyboardDidShow',344);});
    await expect(async()=>Math.abs((await geometry()).shell-500)<1);await expect(atBottom);
    await page.evaluate(()=>{window.__hemiKeyboard.emit('keyboardWillHide');window.__hemiKeyboard.emit('keyboardDidHide');});
    await expect(async()=>Math.abs((await geometry()).shell-844)<1);await expect(atBottom);
   }
   await transcript.hover();await page.mouse.wheel(0,-700);
   await expect(async()=>await page.getByRole('button',{name:'回到底部',exact:true}).isVisible());
   await page.waitForTimeout(250); // Finish the wheel gesture and deferred virtual-row measurements.
   const reading=await transcript.evaluate(node=>node.scrollTop);
   await page.evaluate(()=>window.__hemiKeyboard.emit('keyboardWillShow',344));await expect(async()=>Math.abs((await geometry()).shell-500)<1);
   const readingAfter=await transcript.evaluate(node=>node.scrollTop);result.history={before:reading,after:readingAfter};
   assert.ok(Math.abs(readingAfter-reading)<3,`reading position moved from ${reading} to ${readingAfter}`);assert.equal(await atBottom(),false);
   await page.evaluate(()=>window.__hemiKeyboard.emit('keyboardWillHide'));await expect(async()=>Math.abs((await geometry()).shell-844)<1);
   assert.ok(Math.abs(await transcript.evaluate(node=>node.scrollTop)-reading)<3);
   await page.emulateMedia({reducedMotion:'reduce'});
   check('native keyboard reduces the entire conversation container; composer and transcript resize together, end anchor survives repeated animated show/hide (bridge/viewport fixture)');

   const web=await context.newPage();await web.goto(url+'?browserViewport=1');await web.getByRole('button',{name:'手动连接',exact:true}).click();
   await web.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>500});visualViewport.dispatchEvent(new Event('resize'));});
   assert.equal(await web.locator('html').getAttribute('data-viewport-owner'),'browser');
   assert.equal(await web.locator('.mobile-shell').evaluate(node=>node.getBoundingClientRect().height),500);
   assert.equal(await web.evaluate(()=>scrollY),0);await web.screenshot({path:path.join(output,`${mode}-keyboard-browser.png`)});await web.close();
   check('browser fallback follows visualViewport with a fixed root and scrollable sheet; no native height subtraction');

   networkDown=true;await expect(async()=>await page.getByRole('button',{name:'思考强度：自动',exact:true}).isDisabled());assert.equal(await page.getByRole('button',{name:/^切换模型：/}).isDisabled(),true);assert.equal(await folderTrigger.isDisabled(),true);
   check('offline model/thinking/directory controls are disabled');
   assert.deepEqual(result.errors,[]);
  } catch(error) {
   const failed=context.pages()[0];
   if(failed){await failed.screenshot({path:path.join(output,`${mode}-failure.png`)});result.failure=await failed.evaluate(()=>({dialogs:[...document.querySelectorAll('[role="dialog"]')].map(node=>({label:node.getAttribute('aria-label'),text:node.textContent})),buttons:[...document.querySelectorAll('button')].map(node=>({label:node.getAttribute('aria-label'),text:node.textContent,inert:!!node.closest('[inert]')})),rootY:scrollY}));}
   throw error;
  } finally {releaseDirectory?.();await context.close();await server.close();await host.close();await fs.rm(root,{recursive:true,force:true});}
 }
} finally {await browser.close();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');}

async function assertEventually(predicate) {const until=Date.now()+15000;while(Date.now()<until){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Condition timed out');}
