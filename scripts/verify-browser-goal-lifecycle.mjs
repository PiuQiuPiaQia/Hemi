// Real desktop IPC → runtime → Pi SDK → bridge → Chrome extension, with a local
// scripted model and synthetic manual-verification page. Never uses personal data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import electronPath from 'electron';
import {_electron,chromium} from 'playwright-core';
import {exportBrowserExtensionFiles} from '../src/main/agent/permission-state.mjs';
import {GOAL_CHECK_SYSTEM} from '../src/main/agent-runtime/goal-driver.mjs';

const mode = process.argv.includes('--dev') ? 'dev' : 'built';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-browser-goals-')));
const userData = path.join(root,'data'), evidence = path.resolve(`.visual/workflow/vision/browser-goal-lifecycle/${mode}`);
await fs.mkdir(userData); await fs.mkdir(evidence,{recursive:true});
const report = {mode,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,
  platform:`${process.platform}/${process.arch}`,node:process.version,userData,checks:[],errors:[],requests:[]};
report.sources = Object.fromEntries(await Promise.all([
  'src/main/agent/hemi-session.mjs','src/main/agent/main-agent.mjs','src/main/agent-runtime/core.mjs',
  'src/main/agent-runtime/goal-driver.mjs','src/main/agent/gate/pi-browser.mjs',
  'src/main/services/browser-bridge-service.mjs','extensions/chrome-extension/service_worker.js',
].map(async name => [name,createHash('sha256').update(await fs.readFile(name)).digest('hex')])));
let app, page, chrome, vite;
const navigations = new Map();
const markers = ['BROWSER_CONFIRM','BROWSER_CAPTCHA','BROWSER_CANCEL'];
const textOf = m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
function respond(res,content,tool) {
  res.writeHead(200,{'content-type':'text/event-stream'});
  const delta = tool ? {tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]} : {content};
  for (const [value,finish] of [[delta,null],[{},tool ? 'tool_calls' : 'stop']]) res.write(`data: ${JSON.stringify({choices:[{index:0,delta:value,finish_reason:finish}]})}\n\n`);
  res.end('data: [DONE]\n\n');
}
const server = http.createServer(async (req,res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('content-type','text/html; charset=utf-8');
      res.end('<!doctype html><title>Hemi manual verification fixture</title><h1>MANUAL_VERIFICATION</h1><input id="draft" value="PRESERVED_DRAFT"><button id="manual" onclick="document.querySelector(\'#state\').textContent=\'USER_DONE\'">手动验证完成</button><p id="state">WAITING</p>');
      return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), all = JSON.stringify(body.messages);
    const checking = body.messages.some(m => m.role === 'system' && textOf(m).includes(GOAL_CHECK_SYSTEM));
    const marker = markers.find(m => all.includes(m));
    report.requests.push({checking,marker,tools:body.tools?.length ?? 0});
    if (body.stream === false) {
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({choices:[{message:{role:'assistant',content:marker ?? '浏览器目标验证'},finish_reason:'stop'}]}));return;
    }
    if (!marker || (!checking && !body.tools?.length)) return respond(res,marker ?? '浏览器保留验证');
    if (checking) {
      const objective = JSON.parse(textOf(body.messages.findLast(m => m.role === 'user'))).objective;
      const done = JSON.stringify(objective).includes('USER_DONE');
      return respond(res,JSON.stringify({status:done ? 'complete' : 'awaiting_user',
        reason:done ? '用户操作后已读取原页面确认' : '等待用户确认或手动验证',evidence:['实际页面工具结果和助手请求'],
        remaining:done ? [] : ['用户在原页面完成操作'],nextAction:'',
        ...(done ? {} : {question:'请确认账号或手动完成原页面的人机验证，完成后告诉我。'})}));
    }
    const last = body.messages.at(-1);
    const reply = textOf(body.messages.findLast(m => m.role === 'user')).includes('USER_DONE');
    if (last.role === 'tool') {
      if (reply) assert.match(textOf(last),/USER_DONE/,'tool must actually read the manual result on the original page');
      return respond(res,reply ? '已读取原页面，验证已完成。' : '请确认账号或手动完成原页面的人机验证，完成后告诉我。');
    }
    if (reply) return respond(res,null,{name:'browser_extract',args:{selector:'#state'}});
    navigations.set(marker,(navigations.get(marker) ?? 0)+1);
    return respond(res,null,{name:'browser_navigate',args:{url:`${origin}/task/${marker}`,taskTitle:'手动验证测试',read:true}});
  } catch (error) { report.errors.push(String(error.stack)); res.destroy(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`, baseUrl = `${origin}/v1`;
const probe = http.createServer(); await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve));
const bridgePort = probe.address().port; await new Promise(resolve => probe.close(resolve));
await fs.writeFile(path.join(userData,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',completedAt:Date.now()}));
await fs.writeFile(path.join(userData,'doubao-asr.json'),JSON.stringify({browserControlEnabled:true,computerUseEnabled:false}));
await fs.writeFile(path.join(userData,'text-model-profiles.json'),JSON.stringify({version:3,defaultModelId:'browser-goals/main',lastConversationModelKey:'browser-goals/main',
  providers:[{id:'browser-goals',name:'浏览器目标验证',api:'openai-completions',baseUrl,models:[{id:'main',model:'browser-goals',thinkingLevel:'off',supportsVision:false}]}]}));
const boot = path.join(root,'boot.mjs');
await fs.writeFile(boot,`import {app} from 'electron';app.setPath('userData',${JSON.stringify(userData)});
  const {getBrowserBridgeService}=await import(${JSON.stringify(new URL('../src/main/services/browser-bridge-service.mjs',import.meta.url).href)});
  globalThis.__goalBrowserBridge=getBrowserBridgeService({ports:[${bridgePort}],statePath:${JSON.stringify(path.join(userData,'browser-bridge-state.json'))}});
  globalThis.__goalBrowserTrace=[];
  const create=globalThis.__goalBrowserBridge.createClient;
  globalThis.__goalBrowserBridge.createClient=options=>{const client=create(options);globalThis.__goalBrowserTrace.push({event:'create',...options});
    const request=client.request;client.request=(op,params)=>{globalThis.__goalBrowserTrace.push({event:'request',id:client.taskId,op});return request.call(client,op,params);};
    const end=client.endSession;client.endSession=()=>{globalThis.__goalBrowserTrace.push({event:'end',id:client.taskId,stack:new Error().stack});return end.call(client);};return client;};
  await globalThis.__goalBrowserBridge.start();await import(${JSON.stringify(new URL('../src/main/index.mjs',import.meta.url).href)});`);
async function wait(fn,label,timeout=30000) {
  const until=Date.now()+timeout;
  while (Date.now()<until) { const value=await fn(); if(value) return value; await delay(70); }
  throw new Error(`Timed out: ${label}`);
}
const check = (name,value=true) => {assert.ok(value,name);report.checks.push(name);console.log(`PASS ${mode}: ${name}`);};
const flow = cid => page.evaluate(cid => window.hemiVoice.flowGetSnapshot(cid),cid);
const input = () => page.locator('textarea.text-composer-input');
async function send(text,cid=null) {
  await input().fill(text); await input().press('Enter');
  if (cid) return cid;
  return wait(() => page.evaluate(async text => {
    for (const item of (await window.hemiVoice.listConversations()).sessions) {
      const record=await window.hemiVoice.openConversation(item.id);
      if(record.turns.some(turn => turn.author==='user'&&turn.text===text))return record.id;
    }
  },text),'persisted user input');
}
async function startWaiting(marker) {
  await page.getByRole('button',{name:'新建对话',exact:true}).click();
  const cid=await send(`${marker} 打开页面，等待我确认或手动验证。`);
  const snapshot=await wait(async()=>{const s=await flow(cid);return s?.phase==='idle'&&s.awaitingUser ? s : null;},'awaiting user');
  const browserPage=await wait(()=>chrome.pages().find(p=>p.url()===`${origin}/task/${marker}`),'retained task page');
  check(`${marker}: 等待用户后页面仍在`,!browserPage.isClosed());
  await page.screenshot({path:path.join(evidence,`${marker}-awaiting.png`)});
  return {cid,runId:snapshot.awaitingUser.runId,browserPage};
}
async function finish(item,marker) {
  await item.browserPage.locator('#draft').fill('USER_EDIT_PRESERVED');
  await item.browserPage.locator('#manual').click();
  check(`${marker}: 页面保留用户输入和手动操作状态`,await item.browserPage.locator('#draft').inputValue()==='USER_EDIT_PRESERVED');
  const original=item.browserPage;
  await send('USER_DONE 已确认账号，并手动完成页面验证。',item.cid);
  const done=await wait(async()=>{const s=await flow(item.cid);return s?.phase==='idle'&&!s.awaitingUser&&Object.keys(s.runs).length===2 ? s : null;},'completed reply');
  const run=Object.values(done.runs).at(-1);
  check(`${marker}: 用户回复续接原目标`,run.continuationOf===item.runId&&run.outcome==='completed');
  check(`${marker}: 恢复操作只读原页面，没有重新导航`,navigations.get(marker)===1);
  const journal=JSON.parse(await fs.readFile(path.join(userData,'runtime-v2/run-journal.json'),'utf8'));
  const extract=Object.values(journal.observations).find(o=>o.owner.rootRunId===run.runId&&o.tool==='browser_extract');
  check(`${marker}: 原页面读取已实际执行`,Boolean(extract));
  await wait(()=>original.isClosed(),'completed page reclaimed');
  check(`${marker}: 真正完成后关闭任务页面`);
}
try {
  if(mode==='dev') {
    const {createServer}=await import('vite');
    vite=await createServer({configFile:path.resolve('vite.config.ts'),cacheDir:path.join(root,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:0}});
    await vite.listen(); process.env.VITE_DEV_SERVER_URL=vite.resolvedUrls.local[0];
  } else delete process.env.VITE_DEV_SERVER_URL;
  app=await _electron.launch({executablePath:electronPath,args:[boot],env:{...process.env,HEMI_USER_DATA_DIR:userData,HEMI_TEST_MIC_GRANT:'1'}});
  page=await app.firstWindow(); await input().waitFor();
  page.on('pageerror',error=>report.errors.push(error.message));
  report.environment=await app.evaluate(()=>({electron:process.versions.electron,node:process.versions.node}));
  report.rendererUrl=page.url();
  await page.evaluate(baseUrl=>window.hemiVoice.saveModelProfile({id:'browser-goals',name:'浏览器目标验证',api:'openai-completions',baseUrl,apiKey:'SYNTHETIC_ONLY',
    models:[{id:'main',model:'browser-goals',thinkingLevel:'off',supportsVision:false}],makeDefault:true}),baseUrl);
  await page.reload();await input().waitFor();
  const extensionDir=await exportBrowserExtensionFiles({sourceDir:fileURLToPath(new URL('../extensions/chrome-extension/',import.meta.url)),targetRoot:path.join(root,'export')});
  const worker=path.join(extensionDir,'service_worker.js');
  await fs.writeFile(worker,(await fs.readFile(worker,'utf8')).replace('const BRIDGE_PORTS = [9467, 9468, 9469, 9470];',`const BRIDGE_PORTS = [${bridgePort}];`));
  chrome=await chromium.launchPersistentContext(path.join(root,'chrome'),{executablePath:process.env.HEMI_TEST_CHROME ?? path.join(os.homedir(),'.cache/puppeteer/chrome/mac_arm-155.0.8059.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    headless:false,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`]});
  await wait(()=>app.evaluate(()=>globalThis.__goalBrowserBridge.connected),'Chrome extension connected');
  const ordinary=chrome.pages()[0];await ordinary.goto(`${origin}/ordinary`);
  await finish(await startWaiting('BROWSER_CONFIRM'),'BROWSER_CONFIRM');
  const captcha=await startWaiting('BROWSER_CAPTCHA');
  const cancel=await startWaiting('BROWSER_CANCEL');
  await page.evaluate(({cid,runId})=>window.hemiVoice.flowCommand(cid,{type:'stop',targetRunId:runId}),{cid:cancel.cid,runId:cancel.runId});
  await wait(()=>cancel.browserPage.isClosed(),'cancelled task reclaimed');
  check('等待用户期间取消，实际关闭任务窗口');
  check('取消一个任务保留另一个等待页面和普通窗口',!captcha.browserPage.isClosed()&&!ordinary.isClosed());
  await page.locator('.h24-sidebar-item').filter({hasText:'BROWSER_CAPTCHA'}).click();
  await input().waitFor();
  await finish(captcha,'BROWSER_CAPTCHA');
  check('普通浏览器页面始终保留',!ordinary.isClosed());
  assert.deepEqual(report.errors,[]);report.ok=true;
} catch(error) {
  report.failure=String(error.stack);process.exitCode=1;
  report.browserTrace=await app?.evaluate(()=>globalThis.__goalBrowserTrace).catch(()=>null);
  const worker=chrome?.serviceWorkers()[0];
  if(worker)report.extensionTasks=await worker.evaluate(()=>[...agents.entries()]).catch(()=>null);
  if(page&&!page.isClosed())await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});
  console.error(error);
} finally {
  await app?.close().catch(()=>{});await chrome?.close().catch(()=>{});await vite?.close();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await fs.writeFile(path.join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');
  if(report.ok)await fs.rm(root,{recursive:true,force:true});
  console.log(JSON.stringify({ok:report.ok??false,checks:report.checks.length,evidence,failure:report.failure}));
}
