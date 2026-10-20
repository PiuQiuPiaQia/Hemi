// 064：真实 renderer → IPC → 生产 SDK/工具/桥 → 隔离 Chrome 扩展。
// 仅模型端点、目标网页与复制扩展的桥端口是可控边界；不替换内部服务。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-tool-browser-read-'));
const userData = path.join(root, 'userData');
const evidence = path.resolve(process.env.HEMI_TOOL_READ_EVIDENCE ?? path.join('.visual/workflow/vision', `064-tool-browser-read-${Date.now()}`));
fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({version:1,completed:true}));
// 引导配置使用真实已完成资源，仅复制引导状态，不接触模型凭据。
const onboarding = path.join(os.homedir(), 'Library/Application Support/hemi-dev/onboarding.json');
if (fs.existsSync(onboarding)) fs.copyFileSync(onboarding, path.join(userData, 'onboarding.json'));
const requests = [], checks = {}, visits = [], reads = [];
const textOf = m => typeof m?.content === 'string' ? m.content : (m?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
let origin;
const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/observed') { reads.push(url.searchParams.get('marker')); res.end('ok'); return; }
    if (url.pathname === '/payload') { setTimeout(() => res.end('SPA_UNIQUE_064'), 850); return; }
    const marker = url.searchParams.get('marker') ?? 'CONTROL'; visits.push(marker);
    const spa = marker === 'READ_SPA', empty = marker === 'READ_STOP';
    const text = spa ? '加载中' : empty ? '' : `STATIC_UNIQUE_064_${marker} ` + '长正文'.repeat(5000);
    res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
    res.end(`<html><title>${marker}</title><body><main id="content">${text}</main><script>
const original=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'innerText');
Object.defineProperty(document.body,'innerText',{get(){fetch('/observed?marker=${marker}');return original.get.call(this)}});
${spa ? "setTimeout(()=>fetch('/payload').then(r=>r.text()).then(t=>document.querySelector('main').textContent=t),350)" : ''}
</script></body></html>`); return;
  }
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
    const body = JSON.parse(raw); requests.push(body);
    const index = body.messages.findLastIndex(m => m.role === 'user');
    const marker = textOf(body.messages[index]).match(/READ_(?:STATIC|SPA|FAIL|STOP|ONLY|DIAGNOSTIC|MEMORY)/)?.[0];
    const history = body.messages.slice(index + 1);
    const hasBrowser = body.tools?.some(t => t.function?.name === 'browser_navigate');
    const calledTool = name => history.some(m => m.tool_calls?.some(t => t.function?.name === name));
    const called = calledTool('browser_navigate');
    res.writeHead(200, {'content-type':'text/event-stream'});
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({id:'read-'+requests.length,object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
    if (marker === 'READ_MEMORY' && body.tools?.some(t=>t.function.name==='memory_read')) {
      if (!calledTool('memory_read')) {
        chunk({role:'assistant',tool_calls:[{index:0,id:'memory-child-read',type:'function',function:{name:'memory_read',arguments:'{}'}}]});chunk({},'tool_calls');
      } else { chunk({role:'assistant',content:'MEMORY_CHILD '+textOf(history.findLast(m=>m.role==='tool'))});chunk({},'stop'); }
    } else if (marker === 'READ_MEMORY' && !calledTool('task')) {
      const name = calledTool('memory_write') ? 'task' : 'memory_write';
      const args = name === 'memory_write' ? {target:'workspace',action:'add',reason:'explicit',text:'MEMORY_UNIQUE_064：这是用户明确要求保存的测试约定。'} : {agent:'explorer',description:'重读记忆验证',prompt:'READ_MEMORY_CHILD 请主动读取当前记忆，返回 MEMORY_UNIQUE_064 条目。'};
      chunk({role:'assistant',tool_calls:[{index:0,id:'memory-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}}]});chunk({},'tool_calls');
    } else if (marker && !['READ_DIAGNOSTIC','READ_MEMORY'].includes(marker) && hasBrowser && !called) {
      const args = { url: origin + '/target?marker=' + marker, ...(marker === 'READ_ONLY' ? {} : { read: true }), ...(marker === 'READ_STATIC' ? { maxChars: 12000 } : {}), ...(marker === 'READ_FAIL' ? { selector: '#intentionally-missing' } : {}) };
      chunk({role:'assistant', tool_calls:[{index:0,id:'nav-'+marker,type:'function',function:{name:'browser_navigate',arguments:JSON.stringify(args)}}]});
      chunk({},'tool_calls');
    } else if (marker === 'READ_STATIC' && hasBrowser && called && !calledTool('context_read')) {
      const ref = textOf(history.findLast(m=>m.role==='tool')).match(/ctx-[a-f0-9]{64}/)?.[0];
      if (ref) {
        chunk({role:'assistant',tool_calls:[{index:0,id:'context-'+marker,type:'function',function:{name:'context_read',arguments:JSON.stringify({ref,offset:0,limit:30000})}}]});chunk({},'tool_calls');
      } else { chunk({role:'assistant',content:marker+'_ANSWER MISSING_CONTEXT_REF'});chunk({},'stop'); }
    } else {
      const tool = history.findLast(m => m.role === 'tool');
      chunk({role:'assistant', content: (marker ?? 'AUX') + '_ANSWER ' + (tool ? textOf(tool).slice(0,500) : '本轮配置 read-audit')}); chunk({},'stop');
    }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${server.address().port}`;
const baseUrl = origin + '/v1';
fs.writeFileSync(path.join(userData,'text-model-profiles.json'),JSON.stringify({version:3,defaultModelId:'audit/main',lastConversationModelKey:'audit/main',providers:[{id:'audit',name:'本机工具验证',api:'openai-completions',baseUrl,models:[{id:'main',model:'read-audit',thinkingLevel:'default'}]}]}));
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
    env: { ...process.env, HEMI_USER_DATA_DIR: userData, HEMI_LLM_API_KEY: 'local-dummy-key', HEMI_LLM_BASE_URL: baseUrl, HEMI_LLM_MODEL: 'read-audit' }, stdio: ['ignore', log, log],
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

const targets = async () => fetch(`http://127.0.0.1:${chromePort}/json/list`).then(r => r.json());
const submit = async marker => {
  await evalJs(`(()=>{const ta=document.querySelector('textarea.text-composer-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,${JSON.stringify(marker)});ta.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor(() => evalJs(`(()=>{const b=document.querySelector('.text-composer-send:not(.is-stop)');if(!b||b.disabled)return false;b.click();return true})()`),'发送 '+marker);
};
const settle = marker => waitFor(() => evalJs(`document.body.innerText.includes(${JSON.stringify(marker+'_ANSWER')})&&!document.querySelector('.text-composer-send.is-stop,.text-composer-stop')`), '收口 '+marker);
const resultFor = marker => requests.flatMap(b => b.messages ?? []).filter(m => m.role === 'tool' && String(m.tool_call_id).includes(marker)).at(-1);
const journal = () => JSON.parse(fs.readFileSync(path.join(userData,'runtime-v2/run-journal.json')));
try {
  await start();
  // 配置走真实设置 IPC，让宿主加密测试凭据，再正常重启读取配置。
  await evalJs(`window.hemiVoice.saveModelProfile(${JSON.stringify({id:'audit',name:'本机工具验证',baseUrl,api:'openai-completions',apiKey:'TEST_ONLY',makeDefault:true,models:[{id:'main',model:'read-audit',thinkingLevel:'off'}]})})`);
  await stop(); await start();
  await chromeStart();
  for (const marker of ['READ_STATIC','READ_SPA','READ_FAIL','READ_ONLY','READ_DIAGNOSTIC','READ_MEMORY']) {
    console.log('[tool-read] scenario', marker);
    await submit(marker === 'READ_MEMORY' ? 'READ_MEMORY 请记住本工作区约定 MEMORY_UNIQUE_064，并让 explorer 主动重读核对。' : marker); await settle(marker);
    const result = textOf(resultFor(marker));
    if (marker === 'READ_STATIC') {
      assert.match(result,/STATIC_UNIQUE_064/); assert.match(result,/内容已截断/); checks.staticReadAndTruncation=true;
      const entry = Object.values(journal().observations).find(o => o.toolCallId === 'nav-'+marker);
      assert.ok(entry?.outputRef);
      const snapshot = JSON.parse(fs.readFileSync(path.join(userData,'runtime-v2/contexts',entry.outputRef+'.json')));
      assert.match(snapshot.content[0].text,/STATIC_UNIQUE_064/); assert.ok(snapshot.content[0].text.length>8000); checks.immutableOriginalContainsSamePage=true;
      const full = requests.flatMap(b=>b.messages??[]).find(m=>m.role==='tool'&&m.tool_call_id==='context-'+marker);
      assert.match(textOf(full),/STATIC_UNIQUE_064/);assert.ok(textOf(full).length>8000);checks.contextReadRetrievedOriginal=true;
    }
    if (marker === 'READ_SPA') { assert.match(result,/SPA_UNIQUE_064/); assert.doesNotMatch(result,/加载中/); checks.dynamicPageRead=true; }
    if (marker === 'READ_FAIL') { assert.match(result,/已打开/); assert.match(result,/正文读取失败/); assert.match(result,/不要重复导航/); checks.partialFailureKeepsNavigation=true; }
    if (marker === 'READ_ONLY') { assert.match(result,/已打开/); assert.equal(reads.filter(x=>x===marker).length,0); checks.oldNavigateDoesNotRead=true; }
    if (marker === 'READ_DIAGNOSTIC') {
      const body = requests.find(b => b.messages?.some(m => textOf(m).includes('READ_DIAGNOSTIC')));
      const input = body.messages.map(textOf).join('\n');
      assert.match(input,/直接依据本块回答，不重复调用工具/);
      assert.match(body.tools.find(t=>t.function.name==='get_runtime_diagnostics').function.description,/无需重复查询/);
      checks.productionDiagnosticsGuidance=true;
    } else if (marker !== 'READ_MEMORY') assert.equal(visits.filter(x=>x===marker).length,1,'同一请求只导航一次');
    if (marker === 'READ_MEMORY') {
      const child = requests.find(b=>b.tools?.some(t=>t.function.name==='memory_read')&&b.messages.some(m=>m.role==='tool'&&textOf(m).includes('MEMORY_UNIQUE_064')));
      assert.ok(child,'真实子角色主动重读本轮刚保存的记忆');
      assert.match(child.messages.filter(m=>m.role==='system').map(textOf).join('\n'),/MEMORY_UNIQUE_064/);
      assert.ok(!child.tools.some(t=>['memory_write','memory_forget','memory_restore','memory_status','scratchpad'].includes(t.function.name)));
      checks.mainWritesAndChildExplicitlyReadsMemory=true;
    }
  }
  console.log('[tool-read] scenario READ_STOP');
  await submit('READ_STOP');
  await waitFor(()=>reads.includes('READ_STOP'),'停止前真实提取已开始');
  const active = Object.values(journal().observations).find(o=>o.toolCallId==='nav-READ_STOP');
  assert.equal(active.phase,'started');
  await evalJs(`document.querySelector('.text-composer-send.is-stop,.text-composer-stop').click()`);
  await waitFor(()=>evalJs(`!document.querySelector('.text-composer-send.is-stop,.text-composer-stop')`),'停止屏障');
  const count=reads.filter(x=>x==='READ_STOP').length;
  await new Promise(r=>setTimeout(r,1000));
  assert.equal(reads.filter(x=>x==='READ_STOP').length,count,'停止完成后没有迟到提取');
  assert.equal(visits.filter(x=>x==='READ_STOP').length,1); checks.activeReadStopsWithoutRenavigation=true;
  await waitFor(async()=>!(await targets()).some(t=>t.url.includes('marker=READ_STOP')),'停止后任务页面已回收');
  checks.stopReclaimsOwnedPages=true;
  assert.ok((await targets()).some(t=>t.url===origin+'/control'));checks.controlTabPreserved=true;
  fs.writeFileSync(path.join(evidence,'requests.json'),JSON.stringify(requests,null,2));
  fs.writeFileSync(path.join(evidence,'journal.json'),JSON.stringify(journal(),null,2));
  const summary={ok:true,checks,rendererUrl:currentUrl,userData,bridgePort,requests:requests.length,boundary:'真实 renderer/IPC/controller/SDK/bridge/隔离 Chrome 扩展；外部 provider 与网页受控，仅复制扩展端口作隔离。未测试真实模型自主选择或宣称节省时长。'};
  fs.writeFileSync(path.join(evidence,'summary.json'),JSON.stringify(summary,null,2));console.log('HEMI_TOOL_BROWSER_READ='+JSON.stringify(summary));
} catch(error) { fs.writeFileSync(path.join(evidence,'requests.json'),JSON.stringify(requests,null,2));console.error(error);console.error('证据 '+evidence+' 隔离数据 '+root);process.exitCode=1; }
finally { await stop(); if(chromeChild&&chromeChild.exitCode===null){const ended=once(chromeChild,'exit');chromeChild.kill('SIGTERM');const timer=setTimeout(()=>chromeChild.kill('SIGKILL'),5000);await ended;clearTimeout(timer)} server.closeAllConnections();await new Promise(r=>server.close(r)); }
