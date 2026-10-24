// Real desktop IPC/SSH and mobile workspace/RPC adapters against the actual Bot Host.
// Model execution and native transport are explicit fixtures; no credentials or personal data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer,preview} from 'vite';
import {_electron,chromium} from 'playwright-core';
import electronPath from 'electron';
import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';
const repo=path.resolve(import.meta.dirname,'..'),root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-permission-apps-')),out=path.join(repo,'.visual/workflow/shared-permission-status/apps');await fs.mkdir(out,{recursive:true});
process.env.HEMI_BOT_DATA_DIR=path.join(root,'cloud/data');process.env.HEMI_USER_DATA_DIR=path.join(root,'host-profile');
const {serve}=await import('../src/main/bot/cli.mjs');
const report={date:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:process.platform+'/'+process.arch,results:[]};
const running=new Map(),pending=new Map(),decisions=[];let permissionCallback,service,browser;
const wait=async fn=>{const end=Date.now()+15000;while(!await fn()){assert.ok(Date.now()<end,'condition timed out');await new Promise(r=>setTimeout(r,30));}};
try{
 service=await serve({defaultDir:path.join(root,'workspace'),validateModel:async()=>{},executorFactory:({onPermission})=>{permissionCallback=onPermission;return{
  run(spec,apply){return new Promise(resolve=>running.set(spec.conversationId,{spec,apply,resolve}));},async stop(id){running.get(id)?.resolve({stopped:true});},
  decide(id,permissionId,value){const p=pending.get(id+':'+permissionId);if(!p||!p.options.includes(value))return false;pending.delete(id+':'+permissionId);decisions.push({id,permissionId,value});return true;},
  async close(){for(const item of running.values())item.resolve({stopped:true});},
 };}});
 const hello=await service.host.request('handshake'),request=(method,p={})=>service.host.request(method,{instanceId:hello.instanceId,requestId:randomUUID(),...p});
 await request('model.sync',{source:'manual',models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'fake',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'TEST_ONLY'}]});

 const start=async title=>{const {id}=await request('session.create',{modelKey:'fixture/model'});await request('session.rename',{id,title});await request('flow.command',{id,command:{type:'send',input:{inputId:randomUUID(),text:'隔离授权状态验证'}}});await wait(()=>running.has(id));return id;};
 const ask=(id,title,options=['批准一次（原始值）','拒绝'])=>{const {spec}=running.get(id),permissionId=randomUUID();const p={id:permissionId,title,options,kind:'action',tool:'bash',args:{command:'cat /isolated/file.txt'},note:'隔离测试请求'};pending.set(id+':'+permissionId,p);permissionCallback(spec,p);return spec.runId+':'+permissionId;};
 const ssh=path.join(root,'ssh.mjs'),cli=path.join(repo,'src/main/bot/cli.mjs');
 await fs.writeFile(ssh,`#!${process.execPath}\nimport{spawn}from'node:child_process';if(process.argv.includes('-O'))process.exit(0);const command=process.argv.at(-1);if(!command.includes('cli.mjs'))process.exit(1);let body='';for await(const chunk of process.stdin)body+=chunk;const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},command.endsWith(' watch')?'watch':'rpc'],{env:{...process.env,HEMI_BOT_DATA_DIR:${JSON.stringify(process.env.HEMI_BOT_DATA_DIR)}},stdio:['pipe','pipe','inherit']});child.stdin.end(body);child.stdout.pipe(process.stdout);child.on('close',code=>process.exit(code??1));`,{mode:0o700});
 browser=await chromium.launch({executablePath:process.env.HEMI_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 for(const mode of ['dev','built']){
  const result={mode,checks:[],errors:[]};report.results.push(result);const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};
  const id=await start('共享授权-'+mode),other=(await request('session.create',{modelKey:'fixture/model'})).id;await request('session.rename',{id:other,title:'其他会话-'+mode});const permissionId=ask(id,'PC Bot 授权原始选项');
  const profile=path.join(root,mode,'profile');await fs.mkdir(path.join(profile,'bot'),{recursive:true});
  await fs.writeFile(path.join(profile,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',permissionChoice:'skipped',completedAt:Date.now()}));
  await fs.writeFile(path.join(profile,'appearance.json'),JSON.stringify({schemaVersion:1,skinId:'classic',mode:'light'}));
  await fs.writeFile(path.join(profile,'bot/connection.json'),JSON.stringify({host:'isolated-permission',instanceId:hello.instanceId,protocol:hello.protocol,version:hello.version,home:root,dataDir:process.env.HEMI_BOT_DATA_DIR,boundAt:Date.now()}));
  const desktopVite=mode==='dev'?await createServer({configFile:path.join(repo,'vite.config.ts'),cacheDir:path.join(root,mode,'desktop-cache'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}}):null;if(desktopVite)await desktopVite.listen();let app;
  try{
   const env={...process.env,HEMI_USER_DATA_DIR:profile,HEMI_SSH_BIN:ssh,HEMI_TEST_MIC_GRANT:'1'};if(desktopVite)env.VITE_DEV_SERVER_URL=desktopVite.resolvedUrls.local[0];else delete env.VITE_DEV_SERVER_URL;
   app=await _electron.launch({executablePath:electronPath,args:['.'],cwd:repo,env});let page;
   await wait(()=>{page=app.windows().find(p=>/^(http|file):/.test(p.url())&&!new URL(p.url()).searchParams.has('mode'));return !!page;});page.setDefaultTimeout(15000);page.on('pageerror',e=>result.errors.push(e.message));
   await page.getByRole('button',{name:'Bot',exact:true}).click();await wait(async()=>(await page.evaluate(()=>window.hemiVoice.bot.getState())).online);
   await page.locator('.h24-sidebar-open').filter({hasText:'共享授权-'+mode}).click();
   const card=page.getByRole('alertdialog',{name:'操作授权请求'}).filter({hasText:'PC Bot 授权原始选项'});await card.waitFor();await page.locator('.h24-sidebar-open').filter({hasText:'其他会话-'+mode}).click();await card.waitFor({state:'hidden'});await page.locator('.h24-sidebar-open').filter({hasText:'共享授权-'+mode}).click();await card.waitFor();assert.equal(await page.getByText('其他会话的授权',{exact:true}).count(),0);await page.getByText('等待确认',{exact:true}).waitFor();assert.equal(await card.locator('.countdown-track').count(),0);
   await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(w=>!new URL(w.webContents.getURL()).searchParams.has('mode'));win.setContentSize(1280,900);win.show();win.focus();});await page.bringToFront();
   await page.keyboard.press('Escape');assert.equal((await request('session.open',{id})).permissions[permissionId].status,'pending');await page.screenshot({path:path.join(out,mode+'-desktop-permission.png')});
   await card.getByRole('button',{name:'批准一次（原始值）',exact:true}).click();await card.waitFor({state:'hidden'});assert.equal((await request('session.open',{id})).permissions[permissionId].status,'approved');assert.equal(decisions.at(-1).value,'批准一次（原始值）');check('PC Bot uses actual SSH/IPC: persistent wait, scoped card, raw decision receipt and Escape');
   ask(id,'PC 停止授权任务');const stopCard=page.getByRole('alertdialog',{name:'操作授权请求'}).filter({hasText:'PC 停止授权任务'});await stopCard.waitFor();await stopCard.getByRole('button',{name:'停止任务'}).click();await wait(async()=>!(await request('session.open',{id})).flow.activeRunId);await stopCard.waitFor({state:'hidden'});check('PC shared card stops the actual active run');
  }catch(e){result.desktopError=e.stack;if(app){const pages=app.windows();for(const p of pages)if(/^(http|file):/.test(p.url())&&!new URL(p.url()).searchParams.has('mode')){await p.screenshot({path:path.join(out,mode+'-desktop-failure.png')}).catch(()=>{});result.body=await p.locator('body').innerText();}}throw e;}finally{await app?.close();await desktopVite?.close();}
  // Real mobile app, actual workspace client and Host; native RPC/events are transport fixtures.
  const mobileId=await start('wise 共享授权-'+mode),mobilePermission=ask(mobileId,'wise 原始选项授权');
  const mobileRoot=path.join(repo,'apps/mobile'),options={root:mobileRoot,configFile:path.join(mobileRoot,'vite.config.ts'),cacheDir:path.join(root,mode,'mobile-cache'),logLevel:'error'};
  const mobileServer=mode==='dev'?await createServer({...options,server:{host:'127.0.0.1',port:0,strictPort:false}}):await preview({...options,preview:{host:'127.0.0.1',port:0}});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});let networkDown=false,holdDecision=false,releaseDecision,dropDecision=false;
  try{
   if(mode==='dev')await mobileServer.listen();await installMobileBotEvents(context,service.host,{offline:()=>networkDown});
   await context.exposeBinding('__permissionRpc',async(_source,{method,params})=>{if(networkDown)return{ok:false,code:'network',message:'Isolated offline'};if(holdDecision&&method==='permission.decide')await new Promise(r=>{releaseDecision=r;});try{const result=await service.host.request(method,params);if(dropDecision&&method==='permission.decide'){dropDecision=false;return{ok:false,code:'network',message:'Isolated reply lost'};}return{ok:true,result};}catch(e){return{ok:false,code:e.code??'failed',message:e.message};}});
   const target={endpoint:'https://127.0.0.1:29421',botInstanceId:hello.instanceId,name:'Isolated permissions'};
   await context.addInitScript(target=>{
    window.CapacitorCustomPlatform={name:'ios'};
    window.Capacitor={PluginHeaders:[{name:'HemiBot',methods:['restore','request'].map(name=>({name,rtype:'promise'}))}],async nativePromise(plugin,method,options){if(method==='restore')return{active:target};if(method==='request'){const v=await window.__permissionRpc(options);if(!v.ok)throw Object.assign(new Error(v.message),{code:v.code});return v;}throw Error('Unexpected native call');}};
   },target);
   const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>result.errors.push(e.message));await page.goto(mobileServer.resolvedUrls.local[0]);await page.getByRole('textbox',{name:'消息',exact:true}).waitFor();
   // The most recently created session is selected. Other conversations' requests stay hidden.
   const card=page.getByRole('group',{name:'Bot 操作确认'}).filter({hasText:'wise 原始选项授权'});await card.waitFor();assert.equal(await page.getByText('其他会话的授权',{exact:true}).count(),0);assert.deepEqual(await card.getByRole('button').allTextContents(),['批准一次（原始值）','拒绝']);await page.screenshot({path:path.join(out,mode+'-wise-permission.png')});
   holdDecision=true;await card.getByRole('button',{name:'批准一次（原始值）',exact:true}).click();await wait(()=>!!releaseDecision);assert.equal(await card.getByRole('button',{name:'拒绝',exact:true}).isDisabled(),true);holdDecision=false;releaseDecision();await card.waitFor({state:'hidden'});assert.equal((await request('session.open',{id:mobileId})).permissions[mobilePermission].status,'approved');assert.equal(decisions.at(-1).value,'批准一次（原始值）');check('wise actual workspace/Host: raw options, conversation scope and in-flight disabling');
   const uncertain=ask(mobileId,'wise 丢失确认回执');await page.getByText('wise 丢失确认回执',{exact:true}).waitFor();dropDecision=true;await page.getByRole('group',{name:'Bot 操作确认'}).getByRole('button',{name:'拒绝',exact:true}).click();await page.getByRole('status').filter({hasText:'确认结果待核对，请恢复连接后刷新。'}).waitFor();assert.equal((await request('session.open',{id:mobileId})).permissions[uncertain].status,'denied');check('lost permission reply preserves the Host result and shows the existing uncertain-result toast');
   ask(mobileId,'wise 离线授权卡');await page.getByText('wise 离线授权卡',{exact:true}).waitFor();networkDown=true;await page.getByText('Bot 连接已断开',{exact:true}).waitFor({timeout:20000});const offlineCard=page.getByRole('group',{name:'Bot 操作确认'});assert.equal(await offlineCard.getByRole('button').first().isDisabled(),true);await page.screenshot({path:path.join(out,mode+'-wise-offline.png')});networkDown=false;await page.getByRole('button',{name:'恢复连接',exact:true}).click();await page.getByText('Bot 连接已断开',{exact:true}).waitFor({state:'hidden'});await wait(async()=>!await offlineCard.getByRole('button').first().isDisabled());await offlineCard.getByRole('button',{name:'拒绝',exact:true}).click();await offlineCard.waitFor({state:'hidden'});check('wise delayed offline notice disables cards and reconnect restores the current pending request');
   assert.deepEqual(result.errors,[]);check('no application renderer errors');
  }catch(e){result.mobileError=e.stack;throw e;}finally{await context.close();await mobileServer.close();await request('flow.command',{id:mobileId,command:{type:'stop'}});}
 }
}finally{await browser?.close();await service?.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.rm(root,{recursive:true,force:true});}
