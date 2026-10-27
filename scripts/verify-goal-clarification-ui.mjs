// Actual mobile renderer + Host/SDK/files; only native transport and model replies are fixtures.
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {createServer,preview} from 'vite';import {chromium} from 'playwright-core';
import {createClarificationFixture,CLARIFICATION_QUESTION} from './lib/goal-clarification-fixture.mjs';
import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';
const repo=path.resolve(import.meta.dirname,'..'),app=path.join(repo,'apps/mobile'),out=path.join(repo,'.visual/workflow/goal-clarification');await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.HEMI_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const report={date:new Date().toISOString(),results:[],gaps:['Synthetic native transport, no physical iPhone/native TLS.']};
try{for(const mode of ['dev','built']){
 const f=await createClarificationFixture({clientId:'browser-verification'}),{instanceId}=await f.call('handshake');
 const options={root:app,configFile:path.join(app,'vite.config.ts'),cacheDir:path.join(f.root,'cache'),logLevel:'error'};
 const server=mode==='dev'?await createServer({...options,server:{host:'127.0.0.1',port:0}}):await preview({...options,preview:{host:'127.0.0.1',port:0}});
 const context=await browser.newContext({viewport:{width:375,height:844},reducedMotion:'reduce'}),result={mode,checks:[],errors:[],screenshots:[]};report.results.push(result);
 try{
  if(mode==='dev')await server.listen();await installMobileBotEvents(context,f.host);
  await context.exposeBinding('__goalRpc',async(_,{method,params})=>{try{return{ok:true,result:await f.host.request(method,params,{clientId:'browser-verification'})};}catch(error){return{ok:false,code:error.code,message:error.message};}});
  await context.addInitScript(target=>{window.CapacitorCustomPlatform={name:'ios'};window.Capacitor={PluginHeaders:[{name:'HemiBot',methods:['restore','request'].map(name=>({name,rtype:'promise'}))}],async nativePromise(plugin,method,options){if(method==='restore')return{active:target};if(method==='request'){const r=await window.__goalRpc(options);if(!r.ok)throw Object.assign(new Error(r.message),{code:r.code});return r;}throw Error('Unexpected native method');}};},{endpoint:'https://127.0.0.1:29421',botInstanceId:instanceId,name:'Clarification verification'});
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>result.errors.push(e.message));
  const input=page.getByRole('textbox',{name:'消息',exact:true});await page.goto(server.resolvedUrls.local[0]);await input.waitFor();
  await input.fill('创建 seed.txt 后帮我写 proof.txt，但文件内容请先向我询问。');await page.getByRole('button',{name:'发送消息',exact:true}).click();
  const waiting=page.getByText('等待你的回复',{exact:true});await waiting.waitFor();await page.getByText(CLARIFICATION_QUESTION,{exact:true}).waitFor();assert.equal(await page.locator('.turn-error-notice').count(),0);assert.equal((await f.flow()).phase,'idle');
  for(const width of [375,768,1440]){await page.setViewportSize({width,height:844});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const file=path.join(out,`${mode}-waiting-${width}.png`);await page.screenshot({path:file,fullPage:true,animations:'disabled'});result.screenshots.push(file);}
  await page.reload();await waiting.waitFor();assert.equal(await page.locator('.turn-error-notice').count(),0);result.checks.push('neutral durable user wait, reload and 375/768/1440 layouts');
  await input.fill('文件内容写入 CLARIFIED_VALUE。');await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.getByText('已写入并读回核对 CLARIFIED_VALUE。',{exact:true}).waitFor();await waiting.waitFor({state:'hidden'});
  assert.equal(await page.locator('.turn-error-notice').count(),0);const done=await f.flow();assert.equal(Object.values(done.runs).at(-1).outcome,'completed');assert.equal(f.seedCalls,1);result.checks.push('answer continues the linked goal, verifies actual file, removes wait and does not repeat prior tool');
  await page.emulateMedia({colorScheme:'dark'});const shot=path.join(out,`${mode}-complete-system-dark.png`);await page.screenshot({path:shot,fullPage:true});result.screenshots.push(shot);assert.deepEqual(result.errors,[]);console.log('PASS',mode,result.checks.join('; '));
 }catch(error){result.failure=error.stack;throw error;}finally{await context.close();await server.close();await f.close();}
}}finally{await browser.close();await fs.writeFile(path.join(out,'ui-report.json'),JSON.stringify(report,null,2)+'\n');}
