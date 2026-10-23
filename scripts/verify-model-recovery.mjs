// Renderer -> production IPC/controller -> Hemi/Pi -> real local HTTP -> persisted flow.
// Use a fresh HEMI_USER_DATA_DIR. Run with and without VITE_DEV_SERVER_URL.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import electronPath from 'electron';

const modulePath=process.env.HEMI_PLAYWRIGHT_MODULE??path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const {_electron}=await import(pathToFileURL(modulePath).href);
const mode=process.env.VITE_DEV_SERVER_URL?'dev':'built';
const evidence=path.resolve(`.visual/workflow/vision/model-recovery/${mode}`);
const userData=fs.mkdtempSync(path.join(os.tmpdir(),`hemi-recovery-${mode}-`));
fs.mkdirSync(evidence,{recursive:true});
fs.writeFileSync(path.join(userData,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',permissionChoice:'skipped',completedAt:Date.now()}));
fs.writeFileSync(path.join(userData,'appearance.json'),JSON.stringify({schemaVersion:1,skinId:'classic',mode:'light'}));
const report={mode,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:`${process.platform}/${process.arch}`,userData,checks:[],errors:[],screenshots:[]};
const requests=[],counts=new Map(),pending=new Set();
let scenario='auto',inflightClosed=false;
const server=http.createServer(async(req,res)=>{
 try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
  const main=body.tools?.length>0;
  if(main){requests.push({scenario,body});counts.set(scenario,(counts.get(scenario)??0)+1);}
  const n=counts.get(scenario)??0;
  if(main&&(scenario==='auth'||scenario==='expiry'||n===1||(scenario==='manual'&&n===2))){
   res.writeHead(scenario==='auth'?401:503,{'content-type':'application/json',...(scenario==='auto'?{'retry-after':'5'}:{})});
   res.end(JSON.stringify({error:{message:scenario==='auth'?'Unauthorized: invalid API key':'Service unavailable',type:'api_error'}}));return;
  }
  if(main&&scenario==='stop'){
   pending.add(res);res.on('close',()=>{inflightClosed=true;pending.delete(res);});return;
  }
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const [delta,finish_reason]of [[{role:'assistant',content:main?'自动恢复成功，原任务继续。':'恢复验证'},null],[{},'stop']])res.write(`data: ${JSON.stringify({id:'model-recovery',model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
  res.end('data: [DONE]\n\n');
 }catch(error){report.errors.push(String(error));res.destroy();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(userData,'text-model-profiles.json'),JSON.stringify({version:3,defaultModelId:'recovery/main',lastConversationModelKey:'recovery/main',providers:[{id:'recovery',name:'恢复验证',api:'openai-completions',baseUrl,models:[{id:'main',model:'recovery-test',thinkingLevel:'off',supportsVision:true}]}]}));
let app,page;
const check=name=>{report.checks.push(name);console.log(`PASS ${name}`);};
const wait=async(predicate,label,timeout=25000)=>{const until=Date.now()+timeout;while(Date.now()<until){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error(`Timeout: ${label}`);};
const input=()=>page.locator('textarea.text-composer-input');
const recovery=()=>page.locator('.model-recovery-notice').last();
const flow=cid=>page.evaluate(cid=>window.hemiVoice.flowGetSnapshot(cid),cid);
const chat=marker=>page.evaluate(async marker=>(await window.hemiVoice.listConversations()).sessions.find(item=>item.title.includes(marker)),marker);
const shot=async name=>{await page.screenshot({path:path.join(evidence,`${name}.png`),scale:'css'});report.screenshots.push(`${name}.png`);};
async function send(marker){await input().fill(marker);await input().press('Enter');let record;await wait(async()=>{record=await chat(marker);return !!record;},'conversation created');return record.id;}
async function newChat(){await page.getByRole('button',{name:'新建对话',exact:true}).click();await input().waitFor();}
async function size(width){await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(w=>!new URL(w.webContents.getURL()).searchParams.has('mode'));win.setMinimumSize(300,400);win.setContentSize(width,900);},width);await page.waitForFunction(width=>innerWidth===width,width);await page.waitForTimeout(350);}
try{
 app=await _electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,HEMI_USER_DATA_DIR:userData,HEMI_TEST_MIC_GRANT:'1',HEMI_LLM_API_KEY:'SYNTHETIC_ONLY',HEMI_LLM_BASE_URL:baseUrl,HEMI_LLM_MODEL:'recovery-test'}});
 await wait(()=>{page=app.windows().find(p=>/^(http|file):/.test(p.url())&&!new URL(p.url()).searchParams.has('mode'));return !!page;},'main window');
 page.setDefaultTimeout(15000);report.rendererUrl=page.url();
 page.on('pageerror',error=>report.errors.push(error.message));page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text());});
 await page.getByRole('button',{name:'对话',exact:true}).waitFor();if(!await input().isVisible())await page.getByRole('button',{name:'对话',exact:true}).click();await input().waitFor();
 await page.evaluate(baseUrl=>window.hemiVoice.saveModelProfile({id:'recovery',name:'恢复验证',api:'openai-completions',baseUrl,apiKey:'SYNTHETIC_ONLY',models:[{id:'main',model:'recovery-test',thinkingLevel:'off',supportsVision:true}],makeDefault:true}),baseUrl);
 await page.reload();await input().waitFor();await size(1440);
 const cid=await send('RECOVERY_AUTO 检查自动恢复');
 await page.locator('.model-recovery-notice[data-phase="waiting"]').waitFor();
 const first=await flow(cid),runId=first.activeRunId,recoveryId=first.runs[runId].recovery.id;
 assert.equal(first.runs[runId].recovery.deadlineAt-first.runs[runId].recovery.firstFailureAt,1800000);
 await input().fill('恢复期间保留的草稿');await page.waitForTimeout(350);await shot('waiting-1440');
 assert.ok((await recovery().boundingBox()).height<=40);
 assert.equal(await page.locator('button.text-composer-send').isDisabled(),true);
 await page.reload();await input().waitFor();
 await wait(async()=>{const current=await flow(cid);return current?.runs[runId]?.recovery?.id===recoveryId;},'recovery survives renderer reload');
 await wait(async()=>{const current=await flow(cid);return current?.runs[runId]?.outcome==='completed';},'automatic retry completes');
 assert.equal(counts.get('auto'),2);assert.equal((await flow(cid)).timeline.filter(item=>item.kind==='user').length,1);
 assert.deepEqual(requests[0].body.messages,requests[1].body.messages);
 assert.equal(await input().inputValue(),'恢复期间保留的草稿');
 await shot('recovered');check('真实 503 → Retry-After → 自动恢复；重载保留恢复身份/原输入/草稿，无重复请求');

 scenario='manual';await newChat();const manualId=await send('RECOVERY_MANUAL 手动立即重试');
 await wait(async()=>{const current=await flow(manualId);return current?.runs[current.activeRunId]?.recovery?.phase==='waiting'&&current.runs[current.activeRunId].recovery.attempt===2;},'second backoff');
 const manualFlow=await flow(manualId),manualRun=manualFlow.activeRunId,manualRecovery=manualFlow.runs[manualRun].recovery;
 await recovery().getByRole('button',{name:'恢复详情',exact:true}).click();
 const immediate=recovery().getByRole('button',{name:'立即重试',exact:true});await wait(async()=>!await immediate.isDisabled(),'manual cooldown elapsed');await immediate.click();
 const stale=await page.evaluate(({cid,runId,id})=>window.hemiVoice.flowCommand(cid,{type:'retryRecovery',targetRunId:runId,recoveryId:id}),{cid:manualId,runId:manualRun,id:manualRecovery.id});
 assert.equal(stale.ok,false);
 await wait(async()=>Object.values((await flow(manualId)).runs).at(-1)?.outcome==='completed','manual retry complete');
 assert.equal(counts.get('manual'),3);assert.equal((await flow(manualId)).runs[manualRun].recovery.deadlineAt,manualRecovery.deadlineAt);
 check('真实立即重试 IPC 沿用原期限，重复命令被拒绝，没有额外 HTTP 请求');

 scenario='stop';await newChat();const stopId=await send('RECOVERY_STOP 停止恢复验证');
 await page.locator('.model-recovery-notice[data-phase="connecting"]').waitFor();await wait(()=>pending.size===1,'retry HTTP in flight');
 await input().fill('停止后仍在的草稿');
 await recovery().getByRole('button',{name:'停止恢复',exact:true}).click();
 await wait(async()=>{const current=await flow(stopId);return current.phase==='idle'&&Object.values(current.runs).at(-1).outcome==='stopped';},'stop confirmed');
 await wait(()=>inflightClosed,'provider socket aborted');await page.waitForTimeout(1200);
 assert.equal(counts.get('stop'),2);assert.equal(await input().inputValue(),'停止后仍在的草稿');await shot('stopped');
 check('精简状态行停止操作取消真实在途 HTTP，晚到回包/定时器不重启，草稿保留');

 scenario='auth';await newChat();const authId=await send('RECOVERY_AUTH 无效密钥');
 await wait(async()=>(await flow(authId))?.phase==='idle','auth failure settles');await page.waitForTimeout(1200);
 assert.equal(counts.get('auth'),1);assert.equal(Object.values((await flow(authId)).runs).at(-1).recovery,undefined);
 check('真实 401 直接失败，不进入自动重试');

 await app.evaluate(()=>{globalThis.__recoveryOriginalNow=Date.now;globalThis.__recoveryClockSkew=0;Date.now=()=>globalThis.__recoveryOriginalNow()+globalThis.__recoveryClockSkew;});
 scenario='expiry';await newChat();const expiryId=await send('RECOVERY_EXPIRY 三十分钟期限');
 await page.locator('.model-recovery-notice[data-phase="waiting"]').waitFor();
 await app.evaluate(()=>{globalThis.__recoveryClockSkew=31*60000;});
 await wait(async()=>Object.values((await flow(expiryId)).runs).at(-1)?.outcome==='failed','30-minute deadline after sleep');
 await app.evaluate(()=>{Date.now=globalThis.__recoveryOriginalNow;delete globalThis.__recoveryOriginalNow;});
 assert.equal(counts.get('expiry'),1);assert.equal(Object.values((await flow(expiryId)).runs).at(-1).recovery.phase,'expired');
 assert.equal(await page.getByRole('button',{name:'继续任务',exact:true}).count(),0,'deadline recovery has one restart action, not a second continue-task action');
 for(const width of [1440,768,375]){await size(width);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.ok((await recovery().boundingBox()).height<=40);await shot(`expired-${width}`);}
 await page.keyboard.press('Tab');await recovery().getByRole('button',{name:'恢复详情',exact:true}).press('Enter');
 await wait(async()=>await recovery().getByRole('button',{name:'恢复详情',exact:true}).getAttribute('aria-expanded')==='true','keyboard expands recovery details',3000);
 assert.equal(await recovery().getByRole('button',{name:'恢复详情',exact:true}).getAttribute('aria-expanded'),'true');await shot('details-375');
 check('主进程时钟跨过 30 分钟，原请求到期且不补发；三档宽度≤40px，键盘详情可用');
 assert.deepEqual(report.errors,[]);
 report.requests=Object.fromEntries(counts);report.result='PASS';
}catch(error){report.result='FAIL';report.failure=String(error.stack??error);if(page&&!page.isClosed())await shot('failure').catch(()=>{});throw error;}
finally{
 if(app)await app.evaluate(()=>{if(globalThis.__recoveryOriginalNow)Date.now=globalThis.__recoveryOriginalNow;}).catch(()=>{});
 await app?.close().catch(()=>{});for(const response of pending)response.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
}
