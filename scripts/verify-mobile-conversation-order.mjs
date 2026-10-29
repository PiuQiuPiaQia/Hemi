// Actual iOS renderer/workspace/shared SDK and Bot Host; native networking and model execution are fixtures.
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

const repo=path.resolve(import.meta.dirname,'..'),appRoot=path.join(repo,'apps/mobile');
const out=path.join(repo,'.visual/workflow/vision/mobile-conversation-order');await fs.mkdir(out,{recursive:true});
const report={date:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,
  node:process.version,platform:process.platform+'/'+process.arch,results:[],gaps:['iOS Capacitor network bridge and model executor are fixtures; no installed phone or production Bot update.']};
const wait=async read=>{const until=Date.now()+15000;while(!await read()){assert.ok(Date.now()<until,'mobile order verification timed out');await new Promise(resolve=>setTimeout(resolve,20));}};
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{for(const mode of ['dev','built']){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-mobile-order-ui-')),dataDir=path.join(root,'data'),live=new Map();
  const options={dataDir,defaultDir:path.join(root,'workspace'),validateModel:async()=>{},executorFactory:()=>({
    run(spec,apply){return new Promise(resolve=>live.set(spec.conversationId,{spec,apply,resolve}));},
    async stop(id){live.get(id)?.resolve({stopped:true});},async close(){for(const run of live.values())run.resolve({stopped:true});},
  })};
  let host=await createBotHost(options);const {instanceId}=await host.request('handshake');
  const request=(method,params={})=>host.request(method,{instanceId,requestId:randomUUID(),...params},{clientId:'fixture-pc'});
  await request('model.sync',{models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'fixture',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'TEST_ONLY'}]});
  const names=['较新会话','较早会话','旧会话','置顶会话'],ids=[];
  for(const title of names){const {id}=await request('session.create');ids.push(id);await request('session.rename',{id,title});}
  const [newest,middle,old,pinned]=ids;
  await host.close();const file=path.join(dataDir,'state.json'),seed=JSON.parse(await fs.readFile(file,'utf8')),now=Date.now();
  for(const [index,id] of ids.entries())seed.sessions[id].updatedAt=now-[1000,2*86400000,5*86400000,7*86400000][index];
  seed.sessions[pinned].pinned=true;seed.order=[pinned,newest,middle,old];await fs.writeFile(file,JSON.stringify(seed));host=await createBotHost(options);
  const viteOptions={root:appRoot,configFile:path.join(appRoot,'vite.config.ts'),cacheDir:path.join(root,'cache'),logLevel:'error'};
  const server=mode==='dev'?await createServer({...viteOptions,server:{host:'127.0.0.1',port:0,strictPort:false}}):await preview({...viteOptions,preview:{host:'127.0.0.1',port:0}});
  const context=await browser.newContext({viewport:{width:375,height:812},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
  const result={mode,checks:[],errors:[],screenshots:[]};report.results.push(result);let page;
  try{
    if(mode==='dev')await server.listen();await installMobileBotEvents(context,host);
    await context.exposeBinding('__orderRpc',async(_,{method,params})=>{
      try{return{ok:true,result:await host.request(method,params,{clientId:'fixture-mobile'})};}
      catch(error){return{ok:false,code:error.code??'failed',message:error.message};}
    });
    await context.addInitScript(({instanceId})=>{
      window.CapacitorCustomPlatform={name:'ios'};window.Capacitor={PluginHeaders:[{name:'HemiBot',methods:['restore','request'].map(name=>({name,rtype:'promise'}))}],
        async nativePromise(_plugin,method,options){
          if(method==='restore')return{active:{endpoint:'https://127.0.0.1:29421',botInstanceId:instanceId,name:'Isolated order fixture'}};
          if(method==='request'){const value=await window.__orderRpc(options);if(!value.ok)throw Object.assign(new Error(value.message),{code:value.code});return value;}
          throw new Error('Unexpected native method');
        }};
    },{instanceId});
    page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>result.errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')result.errors.push(message.text());});
    const drawer=page.getByRole('dialog',{name:'对话列表',exact:true});
    const open=async()=>{await page.getByRole('button',{name:'打开对话列表',exact:true}).click();await drawer.waitFor();};
    const order=async expected=>{await wait(async()=>JSON.stringify(await drawer.locator('.drawer-row-title').allTextContents())===JSON.stringify(expected));};
    const select=async name=>{await drawer.locator('.drawer-row').filter({hasText:name}).click();await drawer.waitFor({state:'hidden'});};
    const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};
    await page.goto(server.resolvedUrls.local[0]);await open();await order(['置顶会话','较新会话','较早会话','旧会话']);
    await select('旧会话');await open();await order(['置顶会话','较新会话','较早会话','旧会话']);
    assert.equal((await request('session.open',{id:old,activate:false})).updatedAt,seed.sessions[old].updatedAt);
    check('opening an unchanged old conversation leaves its date and position intact');

    const start=async id=>{await request('flow.command',{id,command:{type:'send',input:{inputId:randomUUID(),text:'Held list verification'}}});await wait(()=>live.has(id));};
    await start(old);const run=live.get(old);
    run.apply({type:'part-appended',runId:run.spec.runId,generation:run.spec.generation,part:{kind:'text',partId:'output',content:'后台持续输出'}});
    await drawer.locator('.drawer-row').filter({hasText:'旧会话'}).locator('.run-dot').waitFor();
    await order(['置顶会话','较新会话','较早会话','旧会话']);
    await start(newest);await drawer.locator('.drawer-row').filter({hasText:'较新会话'}).locator('.run-dot').waitFor();
    const oldTime=(await request('session.open',{id:old,activate:false})).updatedAt;
    assert.ok((await request('session.open',{id:newest,activate:false})).updatedAt>oldTime);
    await select('旧会话');await open();await order(['置顶会话','较新会话','旧会话','较早会话']);
    assert.equal((await request('session.open',{id:old,activate:false})).updatedAt,oldTime);
    check('live statuses update without moving rows; selection applies true update times and inserts the old row in the middle');

    for(let i=0;i<20;i++)run.apply({type:'part-updated',runId:run.spec.runId,generation:run.spec.generation,partId:'output',patch:{content:'持续输出 '+i}});
    await page.waitForTimeout(100);await order(['置顶会话','较新会话','旧会话','较早会话']);
    run.resolve({});await drawer.locator('.drawer-row').filter({hasText:'旧会话'}).locator('.run-dot').waitFor({state:'hidden'});
    await order(['置顶会话','较新会话','旧会话','较早会话']);
    await select('较早会话');await open();await order(['置顶会话','旧会话','较新会话','较早会话']);
    check('streaming and completion preserve row positions; the next open refreshes all rows without promoting the selected older chat');
    await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});
    await page.reload();await open();await order(['置顶会话','旧会话','较新会话','较早会话']);
    assert.equal(await drawer.locator('.drawer-group[aria-label="置顶"] .drawer-row-title').textContent(),'置顶会话');
    for(const width of [375,414]){
      await page.setViewportSize({width,height:812});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      const name=`${mode}-${width}.png`;await page.screenshot({path:path.join(out,name),animations:'disabled'});result.screenshots.push(name);
    }
    check('cached reload preserves the chosen order and Host pinning at iPhone widths');
    assert.deepEqual(result.errors,[]);
  }catch(error){result.failure=error.stack;if(page)await page.screenshot({path:path.join(out,`${mode}-failure.png`)}).catch(()=>{});throw error;}
  finally{await context.close();await server.close();await host.close();await fs.rm(root,{recursive:true,force:true});}
}}
finally{await browser.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
