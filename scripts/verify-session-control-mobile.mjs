// Actual mobile renderer and production Host/controller; native transport and model execution are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer, preview} from 'vite';
import {chromium} from 'playwright-core';
import {createBotHost} from '../src/main/bot/host.mjs';
import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';

const repo=path.resolve(import.meta.dirname,'..'),root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-mobile-control-'));
const out=path.join(repo,'.visual/workflow/session-control-mobile');await fs.mkdir(out,{recursive:true});
process.env.HEMI_USER_DATA_DIR=path.join(root,'profile');
const report={date:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,
  command:'node scripts/verify-session-control-mobile.mjs',node:process.version,platform:`${process.platform}/${process.arch}`,results:[],gaps:['Native transport and model execution are controlled fixtures.']};
const live=new Map(),stopped=[];
const host=await createBotHost({dataDir:path.join(root,'data'),defaultDir:path.join(root,'workspace'),validateModel:async()=>{},executorFactory:()=>({
  run(spec,apply){return new Promise(resolve=>live.set(spec.conversationId,{spec,apply,resolve}));},
  async stop(id){stopped.push(id);live.get(id)?.resolve({stopped:true});},async close(){for(const run of live.values())run.resolve({stopped:true});},
})});
const {instanceId}=await host.request('handshake');
const request=(method,p={})=>host.request(method,{instanceId,requestId:randomUUID(),...p},{clientId:'pc'});
await request('model.sync',{source:'manual',models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'fixture',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'SYNTHETIC_ONLY'}]});
const wait=async read=>{const end=Date.now()+12000;while(!await read()){assert.ok(Date.now()<end,'condition timed out');await new Promise(resolve=>setTimeout(resolve,20));}};
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {for(const mode of ['dev','built']){
  const {id}=await request('session.create');
  const options={root:path.join(repo,'apps/mobile'),configFile:path.join(repo,'apps/mobile/vite.config.ts'),cacheDir:path.join(root,mode+'-cache'),logLevel:'error'};
  const server=mode==='dev'?await createServer({...options,server:{host:'127.0.0.1',port:0}}):await preview({...options,preview:{host:'127.0.0.1',port:0}});if(mode==='dev')await server.listen();
  const context=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  const result={mode,checks:[],screenshots:[],errors:[]};report.results.push(result);
  const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};
  let page;
  try{
    await installMobileBotEvents(context,host);
    await context.exposeBinding('__sessionControlRpc',async(_source,{method,params})=>{
      try{return{ok:true,result:await host.request(method,params,{clientId:'browser-verification'})};}
      catch(error){return{ok:false,code:error.code??'failed',message:error.message};}
    });
    await context.addInitScript(target=>{window.CapacitorCustomPlatform={name:'ios'};window.Capacitor={PluginHeaders:[{name:'HemiBot',methods:['restore','request'].map(name=>({name,rtype:'promise'}))}],async nativePromise(_plugin,method,options){if(method==='restore')return{active:target};if(method==='request'){const result=await window.__sessionControlRpc(options);if(!result.ok)throw Object.assign(new Error(result.message),{code:result.code});return result;}throw new Error('Unexpected native method');}};},{endpoint:'https://127.0.0.1:29421',botInstanceId:instanceId,name:'Control fixture'});
    page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>result.errors.push(error.message));
    await page.goto(server.resolvedUrls.local[0]);
    const input=page.getByRole('textbox',{name:'消息',exact:true});await input.waitFor();
    await wait(async()=>{const snapshot=await request('snapshot',{id});return !snapshot.sessions.find(item=>item.id===id).control;});
    check('viewing a conversation does not occupy it');
    await input.fill('手机发起长任务');await page.getByRole('button',{name:'发送消息',exact:true}).click();await wait(()=>live.has(id));
    await wait(async()=>(await request('snapshot',{id})).sessions.find(item=>item.id===id).control?.ownerId==='browser-verification');
    await input.fill('保留在手机的下一条草稿');
    const taken=await request('session.control',{id,action:'takeover'});assert.equal(taken.ok,true);
    await page.getByRole('button',{name:'抢占会话',exact:true}).waitFor();
    await wait(async()=>await input.getAttribute('readonly')!==null);
    assert.equal(await input.inputValue(),'保留在手机的下一条草稿');assert.equal(stopped.includes(id),false);
    assert.ok((await request('flow.snapshot',{id})).activeRunId);
    for(const width of [375,414]){await page.setViewportSize({width,height:812});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);const file=path.join(out,`${mode}-occupied-${width}.png`);await page.screenshot({path:file});result.screenshots.push(file);}
    check('takeover changes the previous device to read-only, retains its draft and keeps the running task');
    await page.getByRole('button',{name:'抢占会话',exact:true}).click();await wait(async()=>await input.getAttribute('readonly')===null);
    assert.equal(await input.inputValue(),'保留在手机的下一条草稿');
    await assert.rejects(()=>request('flow.command',{id,controlEpoch:taken.control.epoch,command:{type:'stop',targetRunId:live.get(id).spec.runId}}),/会话已被/);
    const run=live.get(id);run.apply({type:'part-appended',runId:run.spec.runId,generation:run.spec.generation,part:{partId:'reply',kind:'text',content:'原任务继续完成'}});run.resolve({});
    await page.getByText('原任务继续完成',{exact:true}).waitFor();
    check('explicitly reclaiming restores editing and fences the old owner without restarting the model');
    assert.deepEqual(result.errors,[]);
  }catch(error){result.failure=error.stack;if(page)await page.screenshot({path:path.join(out,mode+'-failure.png')}).catch(()=>{});throw error;}
  finally{await context.close();await server.close();}
}}
finally{await browser.close();await host.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');await fs.rm(root,{recursive:true,force:true});}
