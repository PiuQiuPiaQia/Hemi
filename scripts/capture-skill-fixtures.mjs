import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const devPort = Number(process.env.HEMI_DEV_PORT || 5173);
const output = path.resolve('.visual/workflow/vision');
const profile = await mkdtemp(path.join(os.tmpdir(), 'hemi-skill-visual-'));
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await sleep(100); }
  }
  if (!port) throw new Error('Chrome 调试端口不可用');
  let page;
  for (let i = 0; i < 100; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page'); }
    catch { /* 启动中 */ }
    if (page) break;
    await sleep(100);
  }
  if (!page) throw new Error('Chrome 页面不可用');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
    }
    if (!pending.has(message.id)) return;
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message);
  });
  const call = (method, params = {}) => new Promise((resolve) => {
    const next = ++id;
    pending.set(next, resolve);
    socket.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await call('Runtime.evaluate', { expression, returnByValue: true });
    if (response.error || response.result.exceptionDetails) throw new Error(response.error?.message ?? response.result.exceptionDetails.text);
    return response.result.result.value;
  };
  await call('Page.enable');
  await call('Runtime.enable');
  await mkdir(output, { recursive: true });
  // 034 v3（2026-10-02 布局重构）：入口＝图标栏页面 tab；home 场景等 rail＋对话列表，
  // 市场场景等全宽列表；settings-model 只在 1440 档补拍（多状态仅宽档）。
  const waitSelector = (scene) => ({
    'skill-home-entry': '.h24-sidebar-new',
    'skill-mp-preview': '.h34-confirm-bar',
    'skill-mp-detail': '.h34-steps',
    'skill-mp-installed': '.h34-detail details',
    'skill-builtin': '.h34-list-rows .h34-list-row',
  }[scene] ?? '.h34-list-row');
  const waitExpression = (scene) =>
    scene === 'settings-model'
      ? `document.body.textContent.includes('悬浮球')`
      : `Boolean(document.querySelector('${waitSelector(scene)}'))`;
  // 034 v3 确定性断言：rail 常驻 48px；技能中心＝侧栏隐藏、顶栏市场按钮/返回钮不存在；
  // 首页＝侧栏可见、旧入口（侧栏市场/底栏设置/悬浮球）不存在。
  const sceneAssertion = (scene) => {
    if (scene === 'settings-model') return `Boolean(document.querySelector('.settings-form-section'))`;
    const market = scene !== 'skill-home-entry';
    return `(() => {
      const rail = document.querySelector('.h24-navrail');
      if (!rail) return 'rail 缺失';
      if (Math.round(rail.getBoundingClientRect().width) !== 48) return 'rail 宽度 ' + rail.getBoundingClientRect().width;
      if (rail.querySelectorAll('.h24-navrail-item').length !== 3) return 'rail 项数不为 3';
      const sidebar = document.querySelector('.h24-sidebar');
      const sidebarVisible = sidebar && getComputedStyle(sidebar).display !== 'none';
      if (${market} === true && sidebarVisible) return '技能中心下对话列表应隐藏';
      if (${market} === false && !sidebarVisible) return '首页下对话列表应可见';
      if (document.querySelector('.h34-sidebar-market, .h34-top-market, .h34-top-back, .h24-sidebar-foot')) return '旧入口残留';
      return true;
    })()`;
  };
  const scenes = [
    ['skill-home-entry', [1440, 768, 375]],
    ['skill-market', [1440, 768, 375]],
    ['skill-mp-detail', [1440, 375]],
    ['skill-mp-preview', [1440]],
    ['skill-mp-installed', [1440]],
    ['skill-builtin', [1440]],
    ['settings-model', [1440]],
  ];
  for (const [scene, widths] of scenes) {
    for (const width of widths) {
      const height = width === 375 ? 1000 : 900;
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await call('Page.navigate', { url: `http://127.0.0.1:${devPort}/fixtures.html?scene=${scene}` });
      let loaded = false;
      for (let i = 0; i < 100; i++) {
        loaded = await evaluate(waitExpression(scene)).catch(() => false);
        if (loaded) break;
        await sleep(100);
      }
      if (!loaded) throw new Error(`${scene}-${width} 未加载`);
      await sleep(150);
      const assertion = await evaluate(sceneAssertion(scene));
      if (assertion !== true) throw new Error(`${scene}-${width} 断言失败：${assertion}`);
      const metrics = await evaluate('({ width: innerWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth })');
      if (metrics.scroll > width || metrics.body > width) throw new Error(`${scene}-${width} 横向溢出：${JSON.stringify(metrics)}`);
      if (errors.length) throw new Error(`${scene}-${width} 浏览器错误：${errors.join('; ')}`);
      const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
      const target = path.join(output, `${scene}-${width}.png`);
      await writeFile(target, Buffer.from(shot.result.data, 'base64'));
      console.log(target);
    }
  }
} finally {
  socket?.close();
  browser.kill('SIGTERM');
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
