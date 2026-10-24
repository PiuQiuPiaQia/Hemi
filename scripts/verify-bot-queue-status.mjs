// Actual desktop IPC/SSH and mobile workspace adapters against the production Bot Host.
// Only model execution and the native network boundary use fixtures; profiles are isolated.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer,preview} from 'vite';
import {_electron,chromium} from 'playwright-core';
import electronPath from 'electron';
import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';

const repo=path.resolve(import.meta.dirname,'..'),root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-queue-status-'));
const out=path.join(repo,'.visual/workflow/shared-bot-execution/ui');await fs.mkdir(out,{recursive:true});
process.env.HEMI_BOT_DATA_DIR=path.join(root,'cloud/data');process.env.HEMI_USER_DATA_DIR=path.join(root,'host-profile');
const {serve}=await import('../src/main/bot/cli.mjs');
const report={date:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:process.platform+'/'+process.arch,sources:{},results:[]};
for(const file of ['apps/mobile/src/app.tsx','apps/mobile/src/workspace.ts','apps/mobile/src/bot/workspace-client.ts','apps/mobile/src/style.css','src/renderer/src/windows/bot/page.tsx','src/renderer/src/windows/bot/bridge.ts','src/shared/protocol.ts','packages/conversation-flow/src/navigation/conversation-row.tsx','packages/conversation-flow/src/navigation/conversation-status-icon.tsx'])report.sources[file]=createHash('sha256').update(await fs.readFile(path.join(repo,file))).digest('hex');
const live=new Map(),blockedBy=new Map(),started=[],stopped=[];let ask,service,browser;
const wait=async fn=>{const end=Date.now()+15000;while(!await fn()){assert.ok(Date.now()<end,'condition timed out');await new Promise(resolve=>setTimeout(resolve,30));}};
try{
 service=await serve({defaultDir:path.join(root,'workspace'),validateModel:async()=>{},executorFactory:({onPermission})=>{ask=onPermission;return{
  run(spec,apply){started.push(spec.conversationId);const blocker=blockedBy.get(spec.conversationId);if(blocker)apply({type:'run-activity',runId:spec.runId,generation:spec.generation,activity:{phase:'waiting-resource',jobs:[],resources:[{toolCallId:'resource-wait',tool:'bash',since:Date.now(),resource:{host:'local',scope:'file:/isolated/workspace',mode:'write'},blockers:[{owner:{conversationId:blocker}}]}]}});return new Promise(resolve=>live.set(spec.conversationId,{spec,apply,resolve}));},
  async stop(id){stopped.push(id);live.get(id)?.resolve({stopped:true});},
  async close(){for(const item of live.values())item.resolve({stopped:true});},
 };}});
 const hello=await service.host.request('handshake'),request=(method,p={})=>service.host.request(method,{instanceId:hello.instanceId,requestId:randomUUID(),...p});
 await request('model.sync',{source:'manual',models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'fixture',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'NOT_A_CREDENTIAL'}]});
 const send=id=>request('flow.command',{id,command:{type:'send',input:{inputId:randomUUID(),text:'隔离排队消息'}}});
 const pair=async label=>{const a=(await request('session.create')).id;await request('session.rename',{id:a,title:'正在执行的较长重构任务，完成后继续处理其他会话-'+label});await send(a);await wait(()=>live.has(a));const b=(await request('session.create')).id;await request('session.rename',{id:b,title:'排队会话-'+label});blockedBy.set(b,a);await send(b);await wait(()=>live.has(b));assert.equal((await request('session.open',{id:b})).status,'queued');return{a,b};};
 const finish=async(id,text)=>{const {spec,apply,resolve}=live.get(id);if(text)apply({type:'part-appended',runId:spec.runId,generation:spec.generation,part:{partId:'reply',kind:'text',content:text}});resolve({});await wait(async()=>!(await request('flow.snapshot',{id})).activeRunId);};
 const ssh=path.join(root,'ssh.mjs'),cli=path.join(repo,'src/main/bot/cli.mjs');
 await fs.writeFile(ssh,`#!${process.execPath}\nimport{spawn}from'node:child_process';if(process.argv.includes('-O'))process.exit(0);const command=process.argv.at(-1);if(!command.includes('cli.mjs'))process.exit(1);let body='';for await(const chunk of process.stdin)body+=chunk;const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},command.endsWith(' watch')?'watch':'rpc'],{env:{...process.env,HEMI_BOT_DATA_DIR:${JSON.stringify(process.env.HEMI_BOT_DATA_DIR)}},stdio:['pipe','pipe','inherit']});child.stdin.end(body);child.stdout.pipe(process.stdout);child.on('close',code=>process.exit(code??1));`,{mode:0o700});
 browser=await chromium.launch({executablePath:process.env.HEMI_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 for(const mode of ['dev','built'])for(const platform of ['desktop','mobile']){
  const label=mode+'-'+platform,{a,b}=await pair(label),result={mode,platform,checks:[],errors:[]};report.results.push(result);
  const check=name=>{result.checks.push(name);console.log('PASS',label,name);};let server,app,context,page;
  try{
   if(platform==='desktop'){
    const profile=path.join(root,label,'profile');await fs.mkdir(path.join(profile,'bot'),{recursive:true});
    await fs.writeFile(path.join(profile,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',permissionChoice:'skipped',completedAt:Date.now()}));
    await fs.writeFile(path.join(profile,'appearance.json'),JSON.stringify({schemaVersion:1,skinId:'classic',mode:'light'}));
    await fs.writeFile(path.join(profile,'bot/connection.json'),JSON.stringify({host:'isolated-queue',instanceId:hello.instanceId,protocol:hello.protocol,version:hello.version,home:root,dataDir:process.env.HEMI_BOT_DATA_DIR,boundAt:Date.now()}));
    if(mode==='dev'){server=await createServer({configFile:path.join(repo,'vite.config.ts'),cacheDir:path.join(root,label,'cache'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});await server.listen();}
    const env={...process.env,HEMI_USER_DATA_DIR:profile,HEMI_SSH_BIN:ssh,HEMI_TEST_MIC_GRANT:'1'};if(server)env.VITE_DEV_SERVER_URL=server.resolvedUrls.local[0];else delete env.VITE_DEV_SERVER_URL;
    app=await _electron.launch({executablePath:electronPath,args:['.'],cwd:repo,env});
    await wait(()=>{page=app.windows().find(p=>/^(http|file):/.test(p.url())&&!new URL(p.url()).searchParams.has('mode'));return !!page;});
    await page.getByRole('button',{name:'Bot',exact:true}).click();await wait(async()=>(await page.evaluate(()=>window.hemiVoice.bot.getState())).online);
    await page.locator('.h24-sidebar-open').filter({hasText:'排队会话-'+label}).click();
    await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(w=>!new URL(w.webContents.getURL()).searchParams.has('mode'));win.setContentSize(1280,900);win.show();win.focus();});
    if(mode==='dev'){const graph=page.getByRole('button',{name:'移动性能监控',exact:true});await graph.waitFor();const box=await graph.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(280,95,{steps:5});await page.mouse.up();}
   }else{
    const options={configFile:path.join(repo,'apps/mobile/vite.config.ts'),root:path.join(repo,'apps/mobile'),cacheDir:path.join(root,label,'cache'),logLevel:'error'};
    server=mode==='dev'?await createServer({...options,server:{host:'127.0.0.1',port:0}}):await preview({...options,preview:{host:'127.0.0.1',port:0}});if(mode==='dev')await server.listen();
    context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
    await installMobileBotEvents(context,service.host);
    await context.exposeBinding('__queueRpc',async(_source,{method,params})=>{try{return{ok:true,result:await service.host.request(method,params)};}catch(error){return{ok:false,code:error.code??'failed',message:error.message};}});
    await context.addInitScript(target=>{window.CapacitorCustomPlatform={name:'ios'};window.Capacitor={PluginHeaders:[{name:'HemiBot',methods:['restore','request'].map(name=>({name,rtype:'promise'}))}],async nativePromise(plugin,method,options){if(method==='restore')return{active:target};if(method==='request'){const v=await window.__queueRpc(options);if(!v.ok)throw Object.assign(new Error(v.message),{code:v.code});return v;}throw Error('Unexpected native call');}};},{endpoint:'https://127.0.0.1:29421',botInstanceId:hello.instanceId,name:'Queue Bot'});
    page=await context.newPage();await page.goto(server.resolvedUrls.local[0]);
   }
   page.setDefaultTimeout(15000);page.on('pageerror',error=>result.errors.push(error.message));
   const banner=page.getByRole('status').filter({has:page.getByText('等待资源',{exact:true})}),input=platform==='desktop'?page.locator('textarea.text-composer-input'):page.getByRole('textbox',{name:'消息',exact:true});
   await banner.waitFor();await banner.getByText(/正在执行的较长重构任务/).waitFor();assert.deepEqual(started.filter(id=>id===a||id===b),[a,b]);assert.equal(await page.locator('.h24-waiting-status').count(),0,'queued messages must not pretend the model is thinking');
   await input.fill('切换会话也保留的草稿');await page.screenshot({path:path.join(out,label+'-queued.png')});
   if(platform==='mobile'){
    await page.setViewportSize({width:320,height:700});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(out,label+'-queued-320.png')});await page.setViewportSize({width:390,height:844});
   }
   check('independent executions show only their actual conflicting-resource wait and owner');
   await banner.getByRole('button',{name:'查看当前任务',exact:true}).click();await banner.waitFor({state:'hidden'});
   if(platform==='desktop'){await page.locator('.h24-sidebar-open').filter({hasText:'排队会话-'+label}).click();await page.locator('.h24-sidebar-open').filter({hasText:'排队会话-'+label}).getByRole('img',{name:'排队中',exact:true}).waitFor();}
   else{await page.getByRole('button',{name:'打开对话列表',exact:true}).click();const row=page.locator('.drawer-row').filter({hasText:'排队会话-'+label});await row.getByRole('img',{name:'排队中',exact:true}).waitFor();assert.equal(await row.getByRole('img',{name:'任务执行中',exact:true}).count(),0);await page.screenshot({path:path.join(out,label+'-drawer.png')});await row.click();}
   await banner.waitFor();await wait(async()=>await input.inputValue()==='切换会话也保留的草稿');check('active-task navigation keeps draft and queued list icon distinct from execution');
   await page.getByRole('button',{name:platform==='desktop'?'停止当前任务':'停止任务',exact:true}).click();await banner.waitFor({state:'hidden'});assert.ok(!stopped.includes(a));assert.deepEqual(started.filter(id=>id===a||id===b),[a,b]);assert.ok(stopped.includes(b));check('cancelling a queued conversation does not stop the other running task');
   await send(b);await banner.waitFor();ask(live.get(a).spec,{id:randomUUID(),title:'其他会话操作确认',options:['allow','deny']});await banner.getByText(/正在使用同一资源/).waitFor();assert.equal(await page.getByText('其他会话操作确认',{exact:true}).count(),0);check('resource wait keeps the correct owner when that owner also awaits permission');
   await finish(a);const resumed=live.get(b);resumed.apply({type:'run-activity',runId:resumed.spec.runId,generation:resumed.spec.generation,activity:{phase:'running',jobs:[],resources:[]}});await banner.waitFor({state:'hidden'});await page.locator('.h24-waiting-status').waitFor();await wait(async()=>await input.inputValue()==='切换会话也保留的草稿');
   await finish(b,'排队后自动执行的真实 Host 回复');await page.getByText('排队后自动执行的真实 Host 回复',{exact:true}).waitFor();assert.equal((await request('session.open',{id:b})).status,null);check('queue advances automatically and response arrives without resending or losing draft');
   assert.deepEqual(result.errors,[]);check('no renderer errors');
  }catch(error){result.error=error.stack;if(page){await page.screenshot({path:path.join(out,label+'-failure.png')}).catch(()=>{});result.body=await page.locator('body').innerText().catch(()=>null);}throw error;}
  finally{await app?.close();await context?.close();await server?.close();await request('flow.command',{id:a,command:{type:'stop'}});await request('flow.command',{id:b,command:{type:'stop'}});}
 }
}finally{await browser?.close();await service?.close();await fs.writeFile(path.join(out,'ui-report.json'),JSON.stringify(report,null,2));await fs.rm(root,{recursive:true,force:true});}
