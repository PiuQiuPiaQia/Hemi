// Render a self-contained requirement prototype at exact CSS viewports.
// Usage: node scripts/render-requirement-design.mjs requirements/NNN-.../designs/version
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const designDir = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Design directory required');
const manifest = JSON.parse(await readFile(path.join(designDir, 'scenes.json'), 'utf8'));
const outputDir = path.join(designDir, 'exports');
const chromeBin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function portFor(profile) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch { await sleep(100); }
  }
  throw new Error('Chrome DevTools port unavailable');
}

async function connect(port) {
  let page;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page'); }
    catch { /* Chrome is starting */ }
    if (page) break;
    await sleep(100);
  }
  if (!page) throw new Error('Chrome page unavailable');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  return {
    assertNoErrors() { if (errors.length) throw new Error(errors.join('\n')); },
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const key = ++id;
        pending.set(key, { resolve, reject });
        socket.send(JSON.stringify({ id: key, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function loaded(cdp, state) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await cdp.call('Runtime.evaluate', {
      expression: `document.readyState==='complete'&&(window.hemiWorkspacePrototype?.snapshot().state===${JSON.stringify(state)}||(document.body.classList.contains('canvas')&&document.querySelector('[data-state="${state}"].active')!==null))`,
      returnByValue: true,
    });
    if (result.result.value === true) return;
    await sleep(100);
  }
  throw new Error('Prototype did not initialize');
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

const profile = await mkdtemp(path.join(os.tmpdir(), 'hemi-requirement-design-'));
await mkdir(outputDir, { recursive: true });
const browser = spawn(chromeBin, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore', detached: true });
let cdp;
try {
  cdp = await connect(await portFor(profile));
  await cdp.call('Page.enable');
  await cdp.call('Runtime.enable');
  let total = 0;
  for (const scene of manifest.scenes) {
    for (const width of scene.widths) {
      const height = scene.height ?? (width === 375 ? 1000 : 900);
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      const url = `${pathToFileURL(path.join(designDir, 'index.html')).href}?state=${encodeURIComponent(scene.state)}&canvas=1`;
      await cdp.call('Page.navigate', { url });
      await loaded(cdp, scene.state);
      const metrics = (await cdp.call('Runtime.evaluate', {
        expression: "({width:innerWidth,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth})",
        returnByValue: true,
      })).result.value;
      cdp.assertNoErrors();
      if (metrics.width !== width || metrics.scroll > width || metrics.body > width) {
        throw new Error(`${scene.state}-${width} horizontal overflow: ${JSON.stringify(metrics)}`);
      }
      if (scene.assert && !await evaluate(cdp, scene.assert)) {
        throw new Error(`${scene.state}-${width}: scene layout assertion failed`);
      }
      await cdp.call('Runtime.evaluate', { expression: "Promise.all([...document.images].map(img=>img.decode().catch(()=>{})))", awaitPromise: true });
      const image = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
      const target = path.join(outputDir, `${scene.state}-${width}.png`);
      await writeFile(target, Buffer.from(image.data, 'base64'));
      console.log(`${path.basename(target)} ${String((await stat(target)).size)} B`);
      total++;
    }
  }
  for (const flow of manifest.flows ?? []) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: flow.width ?? 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.call('Page.navigate', { url: `${pathToFileURL(path.join(designDir, 'index.html')).href}?state=${encodeURIComponent(flow.start)}&canvas=1` });
    await loaded(cdp, flow.start);
    for (const step of flow.steps) {
      if (step.click) {
        const point = await evaluate(cdp, `(() => { const item=document.querySelector(${JSON.stringify(step.click)}); if(!item||item.disabled||item.closest('[inert]')) return null; item.scrollIntoView({block:'nearest',inline:'nearest'}); const r=item.getBoundingClientRect(); if(!r.width||!r.height) return null; const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y); return hit&&(item===hit||item.contains(hit))?{x,y}:null; })()`);
        if (!point) throw new Error(`${flow.name}: click target not reachable ${step.click}`);
        await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
        await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      }
      if (step.input) {
        const changed = await evaluate(cdp, `(() => { const item=document.querySelector(${JSON.stringify(step.input)}); if(!item||!item.getClientRects().length||item.closest('[inert]')) return false; item.focus(); item.value=${JSON.stringify(step.value)}; item.dispatchEvent(new Event('input',{bubbles:true})); item.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
        if (!changed) throw new Error(`${flow.name}: missing input ${step.input}`);
      }
      if (step.key) {
        const keyCodes = { Enter: 13, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Tab: 9, Home: 36, End: 35, Delete: 46 };
        const key = { key: step.key, code: step.key, windowsVirtualKeyCode: keyCodes[step.key] ?? 0 };
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      }
      await sleep(step.waitMs ?? 30);
      cdp.assertNoErrors();
      if (step.expect) {
        const actual = await evaluate(cdp, "window.hemiWorkspacePrototype?.snapshot().state ?? document.querySelector('[data-state].active')?.dataset.state");
        if (actual !== step.expect) throw new Error(`${flow.name}: expected ${step.expect}, got ${actual}`);
      }
      if (step.assert && !await evaluate(cdp, step.assert)) {
        throw new Error(`${flow.name}: interaction assertion failed: ${step.assert}`);
      }
    }
    console.log(`flow ${flow.name}: passed`);
  }
  console.log(`${path.basename(designDir)}: ${total} screenshots, ${(manifest.flows ?? []).length} flows, no horizontal overflow or runtime errors; pointer targets reachable`);
} finally {
  cdp?.close();
  try { process.kill(-browser.pid, 'SIGKILL'); } catch { /* already exited */ }
  await rm(profile, { recursive: true, force: true });
}
