#!/usr/bin/env node
/**
 * 044 · 更新闭环真机验证（AC-4）：对已在运行的旧版 Hemi（CDP 端口）驱动
 * 「检查更新 → 下载 → 重启安装」全链路，证据落 .visual/workflow/vision/044/e2e/。
 *
 * 用法：node scripts/verify-update-loop.mjs
 * 前置：旧版应用以
 *   HEMI_USER_DATA_DIR=<隔离目录> <旧版 Hemi.app>/Contents/MacOS/Hemi \
 *     --remote-debugging-port=9233
 * 启动且主窗口可见；目标新版本已发布（latest-mac.yml 指向更高版本）。
 * 点击走真实 UI 按钮（CDP 只做派发与读态），状态断言走 hemiVoice 桥回执。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';

const CDP = 'http://127.0.0.1:9233';
const APP_PLIST = process.argv[2]
  ? resolve(process.argv[2])
  : '/tmp/hemi-044-e2e/Hemi.app/Contents/Info.plist';
const OUT_DIR = resolve(process.cwd(), '.visual/workflow/vision/044/e2e');
mkdirSync(OUT_DIR, { recursive: true });

const evidence = { steps: [], startedAt: new Date().toISOString() };
const log = (line) => { console.log(line); evidence.steps.push({ at: new Date().toISOString(), line }); };

function plistVersion() {
  const text = readFileSync(APP_PLIST, 'utf8');
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
  return match?.[1] ?? null;
}

async function json(path) {
  const res = await fetch(`${CDP}${path}`);
  if (!res.ok) throw new Error(`CDP ${path}: ${res.status}`);
  return res.json();
}

function call(ws, id, method, params = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onMessage = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === id) {
        ws.off('message', onMessage);
        if (msg.error) rejectPromise(new Error(JSON.stringify(msg.error)));
        else resolvePromise(msg.result);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const targets = await json('/json/list');
const main = targets.find(
  (t) => t.type === 'page' && t.title.includes('Hemi') && !/mode=(orb|caption|task-popover)/.test(t.url),
);
if (!main) throw new Error(`主窗口未找到: ${targets.map((t) => t.title).join('|')}`);
const ws = new WebSocket(main.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r) => ws.once('open', r));
let seq = 0;
const page = (method, params) => call(ws, ++seq, method, params);
await page('Page.enable');
await page('Runtime.enable');

const evalPage = async (expression) =>
  (await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;

const shot = async (name) => {
  const { data } = await page('Page.captureScreenshot', { format: 'png' });
  const file = resolve(OUT_DIR, name);
  writeFileSync(file, Buffer.from(data, 'base64'));
  log(`截图 ${name}`);
};

const getState = () => evalPage('window.hemiVoice.updaterGetState()');
const clickButton = (expression) =>
  evalPage(`(() => { const b = [...document.querySelectorAll('button')].find(${expression}); if (!b) return false; b.click(); return true; })()`);

log(`起始安装体版本：${plistVersion()}`);
const initial = await getState();
log(`初始状态：${JSON.stringify(initial)}`);
if (initial?.supported !== true) throw new Error('更新面不可用（supported=false）——用的不是打包实例？');

// —— 1. 打开设置 → 显式切「通用」页（入口可能带上次分类），走真实「检查更新」按钮 ——
if (!await evalPage("!!document.querySelector('.settings-shell')")) {
  if (!(await clickButton("(b) => b.getAttribute('aria-label') === '设置'"))) {
    throw new Error('没找到设置入口（aria-label=设置）');
  }
  await new Promise((r) => setTimeout(r, 800));
}
if (!(await clickButton("(b) => b.textContent.trim() === '通用'"))) {
  throw new Error('没找到设置分类「通用」');
}
// 等通用页内容真实出现（h37-enter 挂载动画不影响 DOM 存在性）。
let aboutSeen = false;
for (let i = 0; i < 20 && !aboutSeen; i++) {
  aboutSeen = await evalPage("!!document.getElementById('settings-about')");
  if (!aboutSeen) await new Promise((r) => setTimeout(r, 300));
}
if (!aboutSeen) throw new Error('「关于与更新」区块未渲染');
await new Promise((r) => setTimeout(r, 400));
await shot('1-settings-general.png');

// 静默检查（启动 15s）可能已 available；没有就点「检查更新」。
let state = await getState();
log(`进设置后状态：${JSON.stringify(state)}`);
if (state.phase !== 'available') {
  if (!(await clickButton("(b) => b.textContent.includes('检查更新')"))) throw new Error('没找到「检查更新」按钮');
  for (let i = 0; i < 30 && (await getState()).phase === 'checking'; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  state = await getState();
}
if (state.phase !== 'available') {
  throw new Error(`检查后未发现新版本（phase=${state.phase}，err=${state.errorMessage ?? ''}）`);
}
log(`发现新版本：v${state.availableVersion}（当前 v${state.currentVersion}）`);
await shot('2-update-available.png');

// —— 2. 真实「下载更新」按钮 ——
if (!(await clickButton("(b) => b.textContent.includes('下载更新')"))) throw new Error('没找到「下载更新」按钮');
log('已点「下载更新」，等待下载…');
let lastPercent = -1;
let downloaded = null;
const deadline = Date.now() + 20 * 60_000;
while (Date.now() < deadline) {
  const s = await getState();
  if (s.phase === 'downloaded') { downloaded = s; break; }
  if (s.phase === 'error') throw new Error(`下载失败：${s.errorMessage}`);
  if (s.progressPercent != null && s.progressPercent !== lastPercent) {
    lastPercent = s.progressPercent;
    process.stdout.write(`  进度 ${lastPercent}%\r`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!downloaded) throw new Error('下载超时（20 分钟）');
log(`下载完成：v${downloaded.availableVersion}`);
await shot('3-update-downloaded.png');

// —— 3. 真实「重启并更新」按钮：应用退出 → 安装 → 重启 ——
if (!(await clickButton("(b) => b.textContent.includes('重启并更新')"))) throw new Error('没找到「重启并更新」按钮');
log('已点「重启并更新」，等待退出-安装-重启…');
ws.close();

// 进程消失（退出安装中）→ 版本翻新 → （若调试端口复活）读桥断言。
let installDeadline = Date.now() + 5 * 60_000;
let sawRunning = false;
while (Date.now() < installDeadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const version = plistVersion();
  if (version && version !== initial.currentVersion) {
    log(`安装完成：Info.plist 版本 ${initial.currentVersion} → ${version}`);
    sawRunning = true;
    break;
  }
}
if (!sawRunning) throw new Error(`安装超时，版本仍是 ${plistVersion()}`);
evidence.finalVersion = plistVersion();

// 重启后若调试端口还活着（带参重启则可断言 UI 态），等 20s 再试一轮。
await new Promise((r) => setTimeout(r, 20_000));
try {
  const after = await json('/json/list');
  const main2 = after.find((t) => t.type === 'page' && t.title.includes('Hemi') && !/mode=(orb|caption|task-popover)/.test(t.url));
  if (main2) {
    const ws2 = new WebSocket(main2.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((r) => ws2.once('open', r));
    let seq2 = 0;
    const page2 = (method, params) => call(ws2, ++seq2, method, params);
    const state2 = (await page2('Runtime.evaluate', {
      expression: 'window.hemiVoice.updaterGetState()',
      returnByValue: true,
      awaitPromise: true,
    })).result?.value;
    log(`重启后桥状态：${JSON.stringify(state2)}`);
    evidence.stateAfterRelaunch = state2;
    ws2.close();
  } else {
    log('重启后调试端口不可用（重启未带调试参数），以 Info.plist 版本为准。');
  }
} catch {
  log('重启后调试端口不可达，以 Info.plist 版本为准。');
}

evidence.finishedAt = new Date().toISOString();
evidence.verdict = evidence.finalVersion !== initial.currentVersion ? 'PASS' : 'FAIL';
writeFileSync(resolve(OUT_DIR, 'e2e-log.json'), `${JSON.stringify(evidence, null, 2)}\n`);
log(`结论：${evidence.verdict}（${initial.currentVersion} → ${evidence.finalVersion}）`);
process.exit(evidence.verdict === 'PASS' ? 0 : 1);
