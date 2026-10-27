// Real exported extension, production bridges and macOS foreground-app observations.
// No existing browser profile or application data is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { exportBrowserExtensionFiles } from '../src/main/agent/permission-state.mjs';
import { createBrowserBridgeService } from '../src/main/services/browser-bridge-service.mjs';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-browser-background-'));
const output = path.resolve(process.env.HEMI_BROWSER_BACKGROUND_EVIDENCE ?? '.visual/workflow/vision/browser-background');
await fs.mkdir(output, { recursive: true });
const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version, temporary, steps: [],
  limitations: ['Foreground checks cover ordinary navigation, pointer/input, screenshots and default target=_blank links. Scripted window.open popups can still activate Chrome; their WindowProxy semantics are preserved.'] };
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Background fixture</title><h1>BACKGROUND ${req.url}</h1>
    <input id="input"><button id="button" onclick="this.dataset.clicked='yes'">Click</button>
    <a id="blank" href="/blank" target="_blank">New tab</a>
    <button id="popup" onclick="window.open('/popup','background-popup','width=440,height=340')">Popup</button>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function freePort() {
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
const ports = [await freePort(), await freePort()];
const services = ports.map(port => createBrowserBridgeService({ ports: [port], extensionWaitMs: 2000 }));
await Promise.all(services.map(service => service.start()));
const clients = services.map((service, index) => service.createClient({ taskId: 'same-task', taskLabel: index ? 'Dev' : 'Installed' }));
const extensionDir = exportBrowserExtensionFiles({ sourceDir: fileURLToPath(new URL('../extensions/chrome-extension/', import.meta.url)), targetRoot: path.join(temporary, 'export') });
const workerFile = path.join(extensionDir, 'service_worker.js');
await fs.writeFile(workerFile, (await fs.readFile(workerFile, 'utf8')).replace('const BRIDGE_PORTS = [9467, 9468, 9469, 9470];', `const BRIDGE_PORTS = ${JSON.stringify(ports)};`));
const foreground = () => process.platform === 'darwin' ? JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit");const app=$.NSWorkspace.sharedWorkspace.frontmostApplication;JSON.stringify({pid:Number(app.processIdentifier),bundle:ObjC.unwrap(app.bundleIdentifier)});'], { encoding: 'utf8' }).trim()) : null;
const originalForeground = foreground();
function activateOriginal() {
  if (!originalForeground) return;
  execFileSync('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); const apps=$.NSWorkspace.sharedWorkspace.runningApplications; for(let i=0;i<apps.count;i++){const app=apps.objectAtIndex(i);if(Number(app.processIdentifier)===${JSON.stringify(originalForeground.pid)}){app.activateWithOptions(2);break;}}`]);
}
async function eventually(fn, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(100); }
  throw new Error(`Timeout: ${label}`);
}
async function operation(name, fn) {
  const before = foreground();
  const result = await fn(); await delay(150);
  const after = foreground();
  report.steps.push({ name, before, after, stayedBackground: before?.pid === after?.pid && after?.pid === originalForeground?.pid });
  console.log(JSON.stringify(report.steps.at(-1)));
  return result;
}
let browser;
try {
  const executablePath = process.env.HEMI_TEST_CHROME ?? path.join(os.homedir(), '.cache/puppeteer/chrome/mac_arm-155.0.8059.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  browser = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { executablePath, headless: false,
    ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`] });
  await eventually(() => services[0].connected, 'extension handshake');
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  activateOriginal(); await delay(300);
  await clients[0].ensureReady();
  const nav = await operation('navigate', () => clients[0].request('session.navigate', { url: origin + '/main', taskTitle: '验证后台网页操作' }));
  report.cursorBeforeClick = await worker.evaluate(async port => {
    const task = agents.get(`${port}/same-task`);
    return evaluateIn(task.tabId, await ensureWorld(task.tabId), '() => ({visible:window.__hemiCursor?.pointer.style.opacity,label:window.__hemiCursor?.label.textContent})');
  }, ports[0]);
  assert.equal(report.cursorBeforeClick.visible, '1');
  assert.equal(report.cursorBeforeClick.label, 'Hemi · 浏览');
  const read = await operation('read-without-click', () => clients[0].request('tab.extract'));
  assert.ok(!read.text.includes('Hemi ·'), 'Cursor label must not enter extracted page text');
  await operation('navigate-new-tab', () => clients[0].request('session.navigate', { url: origin + '/second', newTab: true }));
  await operation('click', () => clients[0].request('tab.click', { selector: '#button' }));
  await operation('type', () => clients[0].request('tab.type', { selector: '#input', text: 'background' }));
  await operation('screenshot', () => clients[0].request('tab.screenshot'));
  await operation('target-blank', () => clients[0].request('tab.click', { selector: '#blank' }));
  report.singleBridgeFocusOk = report.steps.every(step => step.stayedBackground);
  report.connectedBridges = services.map(service => service.connected);
  report.firstSession = nav.session;
  report.groups = await worker.evaluate(() => chrome.tabGroups.query({}));
  report.singleBridgeFocusOk && assert.ok(report.groups.length > 0);
  // Continue to diagnose all focus steps before asserting, so failures remain actionable.
  assert.ok(report.singleBridgeFocusOk, 'Browser operations must keep the foreground app unchanged');
  assert.ok(services[1].connected, 'The same extension must also connect to the Dev bridge');
  await clients[1].ensureReady();
  const second = await clients[1].request('session.navigate', { url: origin + '/dev', taskTitle: '检查任务分组与指针' });
  assert.equal(clients[1].backend, 'extension');
  assert.notEqual(nav.session.windowId, second.session.windowId);
  await clients[1].request('tab.click', { selector: '#button' });
  await delay(2700);
  report.devCursor = await worker.evaluate(async port => {
    const task = agents.get(`${port}/same-task`);
    return evaluateIn(task.tabId, await ensureWorld(task.tabId), '() => ({visible:window.__hemiCursor?.pointer.style.opacity,closedShadow:document.querySelector("hemi-pointer")?.shadowRoot===null})');
  }, ports[1]);
  assert.equal(report.devCursor.visible, '1');
  assert.equal(report.devCursor.closedShadow, true);
  report.groups = await worker.evaluate(() => chrome.tabGroups.query({}));
  assert.equal(report.groups.length, 2);
  assert.ok(report.groups.some(group => group.title === 'Hemi · 检查任务分组与指针'));
  await browser.pages().find(page => page.url() === origin + '/dev').screenshot({ path: path.join(output, 'dev-cursor.png') });
  await clients[0].endSession();
  assert.ok(browser.pages().some(page => page.url() === origin + '/dev'));
  await services[0].stopHub();
  await delay(300);
  assert.ok(browser.pages().some(page => page.url() === origin + '/dev'), 'Disconnecting one app must preserve the other');
  await clients[1].endSession();
  report.ok = true;
} catch (error) { report.failure = error.stack; process.exitCode = 1; console.error(error.message); }
finally {
  await Promise.allSettled(services.map(service => service.stopHub()));
  await browser?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  activateOriginal();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok ?? false, report: path.join(output, 'report.json') }));
}
