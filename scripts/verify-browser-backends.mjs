// Real Electron, production browser tools/services, local fixture pages and a real
// Chrome extension. No model endpoint or personal browser profile is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import electronPath from 'electron';
import { _electron, chromium } from 'playwright-core';

const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-browser-backends-'));
const userData = path.join(temporary, 'userData');
const output = path.resolve(process.env.HEMI_BROWSER_EVIDENCE ?? `.visual/workflow/vision/browser-backends/${mode}`);
await fs.mkdir(userData); await fs.mkdir(output, { recursive: true });
const report = { mode, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTree: true, node: process.version, platform: `${process.platform}/${process.arch}`, userData, checks: [], errors: [] };
report.sources = Object.fromEntries(await Promise.all([
  'src/main/services/browser-bridge-service.mjs', 'src/main/services/headless-browser-service.mjs',
  'src/main/agent/gate/pi-browser.mjs', 'src/main/ipc/executor.ipc.mjs', 'src/main/ipc/index.mjs',
  'src/renderer/src/windows/voice/browser-section.tsx', 'extensions/chrome-extension/service_worker.js',
  'extensions/chrome-extension/page-operations.js', 'extensions/chrome-extension/manifest.json', 'package-lock.json',
].map(async file => [file, createHash('sha256').update(await fs.readFile(new URL(`../${file}`, import.meta.url))).digest('hex')])));
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
const server = http.createServer((req, res) => {
  if (req.url === '/slow') { report.slowStarted = true; return; }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url === '/a') res.setHeader('set-cookie', 'HEMI_BACKEND=a; Path=/; SameSite=Lax');
  res.end(`<!doctype html><title>Browser backend fixture</title><h1>BACKEND_${req.url}</h1>
    <input id="name" aria-label="姓名"><input type="password" value="PRIVATE_FIXTURE_PASSWORD">
    <select id="city" aria-label="城市"><option value="a">北京东</option><option value="b">北京西</option><option value="c">上海</option></select>
    <button id="submit" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value+' SUBMITTED';document.querySelector('#count').textContent=++window.count">提交</button>
    <p id="result">READY</p><p id="count">0</p><p id="cookies"></p>
    <a href="/popup" target="_blank">打开新页</a>
    <script>window.count=0;window.__hemiRefs=[document.body];window.__hemiTmp=document.body;document.querySelector('#cookies').textContent='COOKIE_'+document.cookie;</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const portProbe = http.createServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const bridgePort = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
await fs.writeFile(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
await fs.writeFile(path.join(userData, 'doubao-asr.json'), JSON.stringify({ browserControlEnabled: true, computerUseEnabled: false }));
const moduleUrl = name => new URL(`../${name}`, import.meta.url).href;
const boot = path.join(temporary, 'boot.mjs');
await fs.writeFile(boot, `import {app} from 'electron'; app.setPath('userData', ${JSON.stringify(userData)});
  const {getBrowserBridgeService}=await import(${JSON.stringify(moduleUrl('src/main/services/browser-bridge-service.mjs'))});
  const {createHeadlessBrowserService}=await import(${JSON.stringify(moduleUrl('src/main/services/headless-browser-service.mjs'))});
  const {default:hemiBrowser}=await import(${JSON.stringify(moduleUrl('src/main/agent/gate/pi-browser.mjs'))});
  const {chromium}=await import(${JSON.stringify(moduleUrl('node_modules/playwright-core/index.mjs'))});
  const launched=[];
  const trackedChromium={executablePath:()=>chromium.executablePath(),launch:async options=>{const browser=await chromium.launch(options);launched.push(browser);return browser;}};
  const service=getBrowserBridgeService({ports:[${bridgePort}],statePath:${JSON.stringify(path.join(userData, 'browser-bridge-state.json'))},
    headlessFactory:()=>createHeadlessBrowserService({loadChromium:async()=>trackedChromium})});
  const clients=new Map();
  globalThis.__browserAudit={service,launched,clients,
    async invoke(id,name,params={}){if(!clients.has(id)){const bridge=service.createClient({taskId:id});const tools={};hemiBrowser({registerTool:t=>tools[t.name]=t},{config:{enabled:true},bridge});clients.set(id,{bridge,tools});}return clients.get(id).tools[name].execute('audit',params,null);},
    async raw(id,op,params={}){const bridge=clients.get(id).bridge;await bridge.ensureReady();return bridge.request(op,params);},
    async end(id){await clients.get(id)?.bridge.endSession();},
    async processIds(){const result=[];for(const browser of launched.filter(b=>b.isConnected())){const session=await browser.newBrowserCDPSession();const info=await session.send('SystemInfo.getProcessInfo');await session.detach();result.push(...info.processInfo.filter(p=>p.type==='browser').map(p=>p.id));}return result;},
    async timeout(url){const bounded=createHeadlessBrowserService({loadChromium:async()=>trackedChromium,opTimeout:{'session.navigate':200,default:5000}});const client=bounded.createClient({taskId:'timeout'});try{await client.ensureReady();await client.request('session.navigate',{url});return '';}catch(error){return error.message;}finally{await bounded.stop();}},
    backend(id){return clients.get(id)?.bridge.backend;},
    diagnostics(){return {launched:launched.length,connected:launched.filter(b=>b.isConnected()).length,contexts:launched.filter(b=>b.isConnected()).flatMap(b=>b.contexts()).length,tasks:service.activeTaskIds};}};
  await service.start(); await import(${JSON.stringify(moduleUrl('src/main/index.mjs'))});`);

let app, page, extension;
const invoke = (id, name, params = {}) => app.evaluate((_, args) => globalThis.__browserAudit.invoke(...args), [id, name, params]);
const raw = (id, op, params = {}) => app.evaluate((_, args) => globalThis.__browserAudit.raw(...args), [id, op, params]);
const end = id => app.evaluate((_, id) => globalThis.__browserAudit.end(id), id);
const backend = id => app.evaluate((_, id) => globalThis.__browserAudit.backend(id), id);
const diagnostics = () => app.evaluate(() => globalThis.__browserAudit.diagnostics());
async function eventually(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function screenshot(name) {
  await page.locator('#settings-browser').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, `${name}.png`), scale: 'css' });
}
try {
  app = await _electron.launch({ executablePath: electronPath, args: [boot], env: { ...process.env, HEMI_USER_DATA_DIR: userData } });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  report.electron = await app.evaluate(() => ({ version: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node }));
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForSelector('textarea.text-composer-input');
  report.rendererUrl = page.url();
  const nav = await invoke('headless-a', 'browser_navigate', { url: `${origin}/a`, read: true });
  check('No extension: production navigation and merged read use headless', await backend('headless-a') === 'headless' && nav.content[0].text.includes('BACKEND_/a'));
  await invoke('headless-a', 'browser_type', { selector: '#name', text: '无头填写' });
  await invoke('headless-a', 'browser_click', { selector: '#submit' });
  check('Headless DOM input and click reach the real page', (await invoke('headless-a', 'browser_extract', { selector: '#result' })).content[0].text.includes('无头填写 SUBMITTED'));
  const shot = await invoke('headless-a', 'browser_screenshot');
  check('Headless screenshot returns real JPEG', shot.content[1].data.startsWith('/9j/'));
  await fs.writeFile(path.join(output, 'headless-page.jpg'), Buffer.from(shot.content[1].data, 'base64'));
  const snap = await raw('headless-a', 'tab.snapshot');
  check('v2 snapshot is isolated and excludes password values', snap.v === 2 && !JSON.stringify(snap).includes('PRIVATE_FIXTURE_PASSWORD'));
  const target = snap.click.find(item => item.text.includes('提交'));
  const receipt = await raw('headless-a', 'tab.refAct', { action: 'click', index: Number(target.i), dispatchId: 'same-click' });
  await raw('headless-a', 'tab.refAct', { action: 'click', index: Number(target.i), dispatchId: 'same-click' });
  check('Reference action ignores forged main-world refs and deduplicates dispatch', receipt.status === 'ok' && (await invoke('headless-a', 'browser_extract', { selector: '#count' })).content[0].text.endsWith('2'));
  const selection = snap.select[0];
  check('Ambiguous select does not apply a value', (await raw('headless-a', 'tab.refAct', { action: 'select', index: Number(selection.i), text: '北京', dispatchId: 'ambiguous' })).status === 'ambiguous');
  check('Exact select uses the shared reference implementation', (await raw('headless-a', 'tab.refAct', { action: 'select', index: Number(selection.i), text: '上海', dispatchId: 'exact-select' })).status === 'ok');
  await invoke('headless-a', 'browser_navigate', { url: `${origin}/fresh` });
  check('Navigation invalidates old snapshot references', (await raw('headless-a', 'tab.refAct', { action: 'click', index: Number(target.i), dispatchId: 'stale-reference' })).status === 'stale');
  await invoke('headless-b', 'browser_navigate', { url: `${origin}/b` });
  check('Concurrent headless tasks isolate cookies', (await diagnostics()).contexts === 2 && (await invoke('headless-b', 'browser_extract', { selector: '#cookies' })).content[0].text.endsWith('COOKIE_'));
  await end('headless-b');
  check('Ending one task preserves the other context', (await diagnostics()).contexts === 1);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '电脑与浏览器', exact: true }).click();
  await eventually(async () => (await page.evaluate(() => window.hemiVoice.getBrowserBridge())).backend === 'headless', 'real status IPC');
  await page.getByText('独立无头浏览器 · 独立登录状态', { exact: true }).waitFor();
  check('Actual IPC and settings show headless without an old-extension warning', await page.getByText('旧版扩展：请到 chrome://extensions 重新加载').count() === 0);
  check('Disconnected extension offers login-state reuse beside the download button', await page.getByText('下载并安装 Chrome 扩展，可复用你已有的登录状态。', { exact: true }).isVisible());
  for (const width of [1440, 768, 560]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find(win => !win.getURL().includes('mode='))?.setSize(width, 960), width);
    await delay(150); await screenshot(`headless-settings-${width}`);
    check(`Browser settings fit the ${width}px viewport`, await page.evaluate(() => [...document.querySelectorAll('#settings-browser .h37-row')].every(row => row.getBoundingClientRect().right <= innerWidth + 1)));
  }
  report.visualScope = '1440/768/560 desktop window widths; Hemi enforces a 560px minimum and currently defines only the light theme. Dark theme and 375px mobile layout are inapplicable.';

  const extensionDir = path.join(temporary, 'extension');
  await fs.cp(new URL('../extensions/chrome-extension/', import.meta.url), extensionDir, { recursive: true });
  const worker = path.join(extensionDir, 'service_worker.js');
  await fs.writeFile(worker, (await fs.readFile(worker, 'utf8')).replace('const BRIDGE_PORTS = [9467, 9468, 9469, 9470];', `const BRIDGE_PORTS = [${bridgePort}];`));
  const testingChrome = process.env.HEMI_TEST_CHROME ?? path.join(os.homedir(), '.cache/puppeteer/chrome/mac_arm-155.0.8059.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  extension = await chromium.launchPersistentContext(path.join(temporary, 'extension-profile'), {
    executablePath: testingChrome, headless: false, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  await eventually(() => app.evaluate(() => globalThis.__browserAudit.service.extVersion === '0.3.2'), 'real extension hello');
  await invoke('headless-a', 'browser_extract');
  check('Late extension does not replace an active headless session', await backend('headless-a') === 'headless');
  const before = (await diagnostics()).launched;
  await invoke('extension-a', 'browser_navigate', { url: `${origin}/extension`, read: true });
  check('New tasks prefer the real connected extension', await backend('extension-a') === 'extension' && (await diagnostics()).launched === before);
  await invoke('extension-a', 'browser_type', { selector: '#name', text: '扩展填写' });
  await invoke('extension-a', 'browser_click', { selector: '#submit' });
  const extensionSnap = await raw('extension-a', 'tab.snapshot');
  check('Refactored extension executes shared DOM and snapshot operations', (await invoke('extension-a', 'browser_extract')).content[0].text.includes('扩展填写 SUBMITTED') && extensionSnap.v === 2);
  await extension.close(); extension = null;
  const switched = await invoke('extension-a', 'browser_extract').then(() => '', error => error.message);
  check('Disconnected extension falls back with an explicit page-reopen instruction', await backend('extension-a') === 'headless' && switched.includes('先 browser_navigate'));
  await invoke('extension-a', 'browser_navigate', { url: `${origin}/after-disconnect`, read: true });
  await end('extension-a'); await end('headless-a');
  check('Task completion releases every context and headless process', (await diagnostics()).connected === 0 && (await diagnostics()).tasks.length === 0);
  const slow = invoke('stopped', 'browser_navigate', { url: `${origin}/slow` }).then(() => 'unexpected success', () => 'cancelled');
  await eventually(() => report.slowStarted, 'navigation in flight');
  await end('stopped');
  check('Stopping an in-flight navigation closes its context and process', await slow === 'cancelled' && (await diagnostics()).connected === 0);
  const timedOut = await app.evaluate((_, url) => globalThis.__browserAudit.timeout(url), `${origin}/slow`);
  check('Operation timeout reclaims the real headless process', timedOut.includes('超时') && (await diagnostics()).connected === 0);
  check('Renderer has no uncaught errors', report.errors.length === 0);
  await invoke('quit-test', 'browser_navigate', { url: `${origin}/quit` });
  const processIds = await app.evaluate(() => globalThis.__browserAudit.processIds());
  check('Quit check observes the actual owned browser process', processIds.length > 0);
  await app.close(); app = null;
  await eventually(() => processIds.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }), 'owned browser exits with Hemi');
  check('Application quit closes the owned headless browser', true);
  report.ok = true;
} catch (error) {
  report.failure = error.stack; process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  console.error(error);
} finally {
  await extension?.close().catch(() => {});
  if (app) {
    await app.evaluate(() => globalThis.__browserAudit.service.stopHub()).catch(() => {});
    await app.close().catch(() => {});
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok ?? false, checks: report.checks.length, report: path.join(output, 'report.json'), failure: report.failure }));
}
