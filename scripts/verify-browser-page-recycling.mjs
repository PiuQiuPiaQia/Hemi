// 真实 Electron renderer → 列表/对话 IPC → 生产 Pi SDK → 本机可控 provider。
// 仅替换外部模型边界；危险命令在真实确认卡拒绝，不自动授权或补写运行态。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-browser-recycling-'));
const userData = path.join(root, 'userData');
const evidence = path.resolve(process.env.HEMI_BROWSER_RECYCLING_EVIDENCE ?? path.join('.visual/workflow/vision', `014-page-recycling-${Date.now()}`));
fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(evidence, { recursive: true });
// 独立引导配置；不读取已安装应用的个人数据。
fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
const requests = [], checks = {}, heldResponses = new Map();
const textOf = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
const server = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); res.end(`<html><title>${req.url}</title><h1>PAGE_RESOURCE_${req.url}</h1></html>`); return; }
  let raw=''; req.on('data',c=>raw+=c); req.on('end',()=>{
    const body=JSON.parse(raw); requests.push(body);
    const userIndex=body.messages.findLastIndex(m=>m.role==='user');
    const user=textOf(body.messages[userIndex]??{}), marker=user.match(/RECYCLE_[A-Z_]+/)?.[0];
    const history=body.messages.slice(userIndex+1);
    const called=name=>history.some(m=>m.tool_calls?.some(call=>call.function?.name===name));
    const browser=marker && body.tools?.some(tool=>tool.function?.name==='browser_navigate');
    if(browser && called('browser_extract') && marker==='RECYCLE_FAIL') {
      res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'INJECTED_AFTER_REAL_BROWSER_TOOLS',type:'invalid_request_error'}})); return;
    }
    res.writeHead(200,{'content-type':'text/event-stream'});
    const chunk=delta=>res.write(`data: ${JSON.stringify({id:'recycle-'+requests.length,object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,...delta}]})}\n\n`);
    const finish=()=>{chunk({delta:{content:(marker??'标题')+'_ANSWER '+origin+'/target/'+marker+'/2'},finish_reason:null});chunk({delta:{},finish_reason:'stop'});res.end('data: [DONE]\n\n');heldResponses.delete(marker)};
    const tools = !browser ? [] : !called('browser_navigate') ? [1,2].map(i=>({index:i-1,id:marker+'-nav-'+i,type:'function',function:{name:'browser_navigate',arguments:JSON.stringify({url:origin+'/target/'+marker+'/'+i,newTab:i===2})}}))
      : !called('browser_extract') ? [{index:0,id:marker+'-extract',type:'function',function:{name:'browser_extract',arguments:'{}'}}] : [];
    console.log('[page-recycling] provider', marker, 'tools', tools.length);
    if(tools.length){chunk({delta:{role:'assistant',tool_calls:tools},finish_reason:null});chunk({delta:{},finish_reason:'tool_calls'});res.end('data: [DONE]\n\n');return;}
    chunk({delta:{role:'assistant',content:(marker??'标题')+'_STREAM'},finish_reason:null});
    if(browser) heldResponses.set(marker,finish);else finish();
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(userData, 'text-model-profiles.json'), JSON.stringify({ version: 3, defaultModelId: 'audit/main', lastConversationModelKey: 'audit/main', providers: [{ id: 'audit', name: '本机回卷验证', api: 'openai-completions', baseUrl, models: [{ id: 'main', model: 'hemi-audit', thinkingLevel: 'default' }] }] }));
fs.writeFileSync(path.join(userData,'doubao-asr.json'),JSON.stringify({browserControlEnabled:true,computerUseEnabled:false}));
const waitFor = async (fn, label, timeout = 45000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`超时：${label}`);
};
let child, ws, call, evalJs, currentUrl, chromeChild, chromePort;
const freePort=async()=>{const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const p=probe.address().port;await new Promise(r=>probe.close(r));return p;};
const bridgePort=await freePort();
const boot=path.join(root,'boot.mjs');
fs.writeFileSync(boot,`import {app} from 'electron';app.setName('hemi');app.setPath('userData',${JSON.stringify(userData)});const {getBrowserBridgeService}=await import(${JSON.stringify(new URL('../src/main/services/browser-bridge-service.mjs',import.meta.url).href)});await getBrowserBridgeService({ports:[${bridgePort}],statePath:${JSON.stringify(path.join(userData,'browser-bridge-state.json'))}}).start();await import(${JSON.stringify(new URL('../src/main/index.mjs',import.meta.url).href)});`);

async function start() {
  const portProbe = http.createServer(); await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
  const port = portProbe.address().port; await new Promise(r => portProbe.close(r));
  const log = fs.openSync(path.join(evidence, `electron-${Date.now()}.log`), 'w');
  child = spawn(path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [boot, `--remote-debugging-port=${port}`], {
    env: { ...process.env, HEMI_USER_DATA_DIR: userData, HEMI_LLM_API_KEY: 'local-dummy-key', HEMI_LLM_BASE_URL: baseUrl, HEMI_LLM_MODEL: 'hemi-audit' }, stdio: ['ignore', log, log],
  }); fs.closeSync(log);
  const page = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    return targets.find(t => t.type === 'page' && !/mode=/.test(t.url));
  }, '主窗口');
  currentUrl = page.url;
  ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
  let seq = 0; const pending = new Map();
  ws.onmessage = event => { const m = JSON.parse(event.data), p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
  call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  evalJs = async expression => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };
  await ready();
}
async function ready() { await waitFor(() => evalJs('Boolean(window.hemiVoice && document.querySelector("textarea.text-composer-input") && !document.querySelector(".setup-shell"))').catch(() => false), '输入框'); }
async function stop() {
  ws?.close(); if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await exited; clearTimeout(timer);
}


const submit=async text=>{
 await evalJs(`(()=>{const ta=document.querySelector('textarea.text-composer-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await waitFor(()=>evalJs(`(()=>{const b=document.querySelector('.text-composer-send:not(.is-stop)');if(!b||b.disabled)return false;b.click();return true})()`),'发送 '+text);
 await waitFor(()=>heldResponses.has(text)||text==='RECYCLE_FAIL'&&requests.some(b=>b.messages?.some(m=>m.role==='tool'&&textOf(m).includes('PAGE_RESOURCE_'))),'真实开页并读取 '+text);
};
const newChat=async()=>{await evalJs(`document.querySelector('[aria-label="新建对话"]').click()`);await waitFor(()=>evalJs(`!document.querySelector('.h24-user-bubble')`),'新会话')};
const targets=async()=>fetch(`http://127.0.0.1:${chromePort}/json/list`).then(r=>r.json());
const tabs=async marker=>(await targets()).filter(t=>t.type==='page'&&t.url.includes('/target/'+marker+'/'));
const zero=async marker=>waitFor(async()=>(await tabs(marker)).length===0,'页面实际关闭 '+marker);
const settle=async marker=>waitFor(()=>evalJs(`document.body.innerText.includes(${JSON.stringify(marker+'_ANSWER')})&&!document.querySelector('.text-composer-send.is-stop,.text-composer-stop')`),'回合收口 '+marker);
async function chromeStart(){
 chromePort=await freePort();
 const ext=path.join(root,'extension');fs.cpSync(path.resolve('extensions/chrome-extension'),ext,{recursive:true,filter:p=>!path.basename(p).startsWith('._')});
 const worker=path.join(ext,'service_worker.js');fs.writeFileSync(worker,fs.readFileSync(worker,'utf8').replace('const BRIDGE_PORTS = [9467, 9468, 9469, 9470];',`const BRIDGE_PORTS = [${bridgePort}];`));
 const exe=process.env.HEMI_TEST_CHROME??path.join(os.homedir(),'.cache/puppeteer/chrome/mac_arm-155.0.8059.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
 const log=fs.openSync(path.join(evidence,'chrome.log'),'w');
 chromeChild=spawn(exe,[`--user-data-dir=${path.join(root,'chrome-profile')}`,`--remote-debugging-port=${chromePort}`,`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--enable-automation','--use-mock-keychain','--no-first-run','--no-default-browser-check','--disable-background-networking','--window-size=1100,780',origin+'/control'],{stdio:['ignore',log,log]});fs.closeSync(log);
 await waitFor(async()=>{try{return(await targets()).some(t=>t.url===origin+'/control')}catch{return false}},'隔离 Chrome 控制页');
 await waitFor(()=>{try{return JSON.parse(fs.readFileSync(path.join(userData,'browser-bridge-state.json'))).extVersion}catch{return false}},'真实扩展接入');
}
async function screenshot(name){await evalJs('window.hemiVoice.showMainWindow()');await call('Page.bringToFront');const shot=await call('Page.captureScreenshot',{format:'png',fromSurface:false});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(shot.data,'base64'))}
try{
 await start();
 // 走生产凭据保存入口，不能用 Electron safeStorage 冒充 Hemi 当前的 secretStorage 格式。
 const configured=await evalJs(`window.hemiVoice.saveModelProfile(${JSON.stringify({id:'audit',name:'本机回卷验证',api:'openai-completions',baseUrl,apiKey:'local-dummy-key',makeDefault:true,models:[{id:'main',model:'hemi-audit',thinkingLevel:'off'}]})})`);
 assert.ok(configured.ok);await call('Page.reload');await ready();await chromeStart();
 await submit('RECYCLE_A');assert.equal((await tabs('RECYCLE_A')).length,2);checks.twoRealPagesOpenedAndRead=true;
 await newChat();await submit('RECYCLE_B');assert.equal((await tabs('RECYCLE_B')).length,2);
 heldResponses.get('RECYCLE_A')();await zero('RECYCLE_A');assert.equal((await tabs('RECYCLE_B')).length,2);checks.otherConversationStillWorking=true;
 assert.ok((await targets()).some(t=>t.url===origin+'/control'));checks.userControlPageUntouched=true;
 await screenshot('concurrent-owned-pages');
 heldResponses.get('RECYCLE_B')();await settle('RECYCLE_B');await zero('RECYCLE_B');checks.completeReclaimsPages=true;
 await submit('RECYCLE_AGAIN');assert.equal((await tabs('RECYCLE_AGAIN')).length,2);heldResponses.get('RECYCLE_AGAIN')();await settle('RECYCLE_AGAIN');await zero('RECYCLE_AGAIN');checks.sameSdkSessionCanOpenAgain=true;
 await submit('RECYCLE_STOP');assert.equal((await tabs('RECYCLE_STOP')).length,2);
 await evalJs(`document.querySelector('.text-composer-send.is-stop,.text-composer-stop').click()`);await zero('RECYCLE_STOP');heldResponses.delete('RECYCLE_STOP');checks.stopReclaimsRealPages=true;
 await waitFor(()=>evalJs(`!document.querySelector('.text-composer-send.is-stop,.text-composer-stop')`),'停止完成');
 await submit('RECYCLE_FAIL');await zero('RECYCLE_FAIL');await waitFor(()=>evalJs(`!document.querySelector('.text-composer-send.is-stop,.text-composer-stop')`),'失败收口');checks.failureAfterToolsReclaimsPages=true;
 const state=JSON.parse(fs.readFileSync(path.join(userData,'browser-bridge-state.json')));
 assert.equal(state.tasks,0);assert.equal(state.state,'ready');checks.bridgeRemainsReadyWithNoOwnedTasks=true;
 const remaining=await targets();assert.ok(remaining.some(t=>t.url===origin+'/control'));
 const markers=remaining.filter(t=>t.type==='page'&&t.url.includes('hemi-task.html'));assert.equal(markers.length,0);checks.noPlaceholderWindowsAndControlSurvives=true;
 await screenshot('after-recycling');
 fs.writeFileSync(path.join(evidence,'requests.json'),JSON.stringify(requests,null,2));
 const summary={ok:true,checks,rendererUrl:currentUrl,bridgePort,chromePort,requests:requests.length,userData,remainingPages:remaining.filter(t=>t.type==='page').map(t=>t.url),boundary:'Real product renderer/IPC/controller/SDK/bridge/Chrome extension/Chrome pages. Local provider and local target pages; isolated browser and userData. Only bridge port in copied extension is configured for isolation.'};
 fs.writeFileSync(path.join(evidence,'summary.json'),JSON.stringify(summary,null,2));console.log('HEMI_BROWSER_PAGE_RECYCLING='+JSON.stringify(summary));
}catch(error){fs.writeFileSync(path.join(evidence,'requests.json'),JSON.stringify(requests,null,2));if(evalJs){const state=await evalJs('({url:location.href,text:document.body.innerText})').catch(()=>null);fs.writeFileSync(path.join(evidence,'failure-state.json'),JSON.stringify(state,null,2));await screenshot('failure').catch(()=>{});}console.error(error);console.error('证据 '+evidence+' 隔离数据 '+root);process.exitCode=1}
finally{await stop();if(chromeChild&&chromeChild.exitCode===null){const ended=once(chromeChild,'exit');chromeChild.kill('SIGTERM');const timer=setTimeout(()=>chromeChild.kill('SIGKILL'),5000);await ended;clearTimeout(timer)}server.closeAllConnections();await new Promise(r=>server.close(r))}
