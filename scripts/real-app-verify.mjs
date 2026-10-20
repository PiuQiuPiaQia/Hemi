#!/usr/bin/env node
/**
 * 真机验证辅助（开发/验收，非产品链路）：通过 CDP 连接已在运行的真实 Hemi
 * 应用（--remote-debugging-port=9222 启动），抓主窗口截图、读 console 错误、
 * 并验证窗口可调（拖到 700 宽触发抽屉布局）。
 *
 * 用法：node scripts/real-app-verify.mjs <out-dir>
 * 前置：应用以 `npx electron . --remote-debugging-port=9222` 启动且主窗口已显示。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import WebSocket from 'ws';

const outDir = resolve(process.cwd(), process.argv[2] ?? '.visual/workflow/vision');
mkdirSync(outDir, { recursive: true });

const CDP = 'http://127.0.0.1:9222';

async function json(path) {
  const res = await fetch(`${CDP}${path}`);
  if (!res.ok) throw new Error(`CDP ${path}: ${res.status}`);
  return res.json();
}

function call(ws, id, method, params = {}) {
  return new Promise((resolvePromise, reject) => {
    const onMessage = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === id) {
        ws.off('message', onMessage);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolvePromise(msg.result);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const errors = [];

// —— 页面级连接：主窗口 ——
const targets = await json('/json/list');
const main = targets.find(
  (t) => t.type === 'page' && t.title.includes('Hemi') && !/mode=(orb|caption|task-popover)/.test(t.url),
);
if (!main) throw new Error(`main window target not found: ${targets.map((t) => t.title).join('|')}`);
const pageWs = new WebSocket(main.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r) => pageWs.once('open', r));
let pageSeq = 0;
const pageCall = (method, params) => call(pageWs, ++pageSeq, method, params);

await pageCall('Page.enable');
await pageCall('Runtime.enable');

// dev 二进制拿不到麦克风 TCC 授权（specs AC-09 已知限制）——对话页形态验证
// 与麦克风无关，这里在文档起始把权限状态补丁为 granted（仅本验证实例生效，
// 不触碰产品代码；ASR/通话链路仍由冒烟与自驱动 harness 真实验证）。
const micPatch = [
  'try {',
  '  const hv = window.hemiVoice;',
  '  if (hv) {',
  "    hv.getMicrophonePermissionStatus = async () => 'granted';",
  '    hv.requestMicrophonePermission = async () => true;',
  '  }',
  '} catch {}',
].join('\n');
await pageCall('Page.addScriptToEvaluateOnNewDocument', { source: micPatch });
pageWs.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails?.exception?.description ?? JSON.stringify(msg.params).slice(0, 200));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (!text.includes('Insecure Content-Security-Policy')) errors.push(`[console.${msg.params.type}] ${text.slice(0, 200)}`);
  }
});

async function shot(name) {
  const { data } = await pageCall('Page.captureScreenshot', { format: 'png' });
  const file = resolve(outDir, name);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`saved ${file}`);
}

// —— 1. 走真实 setup 流程进入对话页：dev 二进制拿不到麦克风 TCC 授权
//    （specs AC-09 已知限制），仅把桥上的权限状态补丁为 granted，
//    其余（配置保存、IPC、状态机）全走真实链路。——
const clickButton = (matcher) =>
  pageCall('Runtime.evaluate', {
    expression: `(() => {
      const b = [...document.querySelectorAll('button')].find(${matcher});
      if (b) { b.click(); return true; }
      return false;
    })()`,
    returnByValue: true,
  });
const patchMic = () =>
  pageCall('Runtime.evaluate', {
    expression: "(() => { const hv = window.hemiVoice; if (!hv) return false; hv.getMicrophonePermissionStatus = async () => 'granted'; hv.requestMicrophonePermission = async () => true; return true; })()",
    returnByValue: true,
  });

await patchMic();
await new Promise((r) => setTimeout(r, 300));
await clickButton("(b) => b.textContent.includes('允许麦克风')");
await new Promise((r) => setTimeout(r, 400));
await patchMic();
await clickButton("(b) => b.textContent.includes('下一步')");
await new Promise((r) => setTimeout(r, 500));
await patchMic();
await clickButton("(b) => /开始对话|完成/.test(b.textContent)");
await new Promise((r) => setTimeout(r, 1500));
await shot('024-real-main-980.png');

// —— 2. 窗口可调：收窄到 700（≤880 应触发抽屉布局）。resizable 窗口的
//    resizeTo 即真实拖拽走的同一 BrowserWindow 尺寸通路。——
await pageCall('Runtime.evaluate', { expression: 'window.resizeTo(700, 680)' });
await new Promise((r) => setTimeout(r, 600));
const narrow = await pageCall('Runtime.evaluate', {
  expression:
    "(() => { const el = document.querySelector('.h24-nav-toggle'); const ws = document.querySelector('.h24-workspace'); return JSON.stringify({ navToggleVisible: el ? getComputedStyle(el).display !== 'none' : false, navOpen: ws?.dataset.navOpen }); })()",
  returnByValue: true,
});
console.log('narrow(700):', narrow.result.value);
await shot('024-real-main-700.png');

// —— 3. 抽屉打开（点击菜单钮）——
await pageCall('Runtime.evaluate', {
  expression: "document.querySelector('.h24-nav-toggle')?.click()",
});
await new Promise((r) => setTimeout(r, 400));
await shot('024-real-main-700-drawer.png');

// —— 4. 回到 980 ——
await pageCall('Runtime.evaluate', { expression: 'window.resizeTo(980, 680)' });
await new Promise((r) => setTimeout(r, 500));

// —— 5. 会话标题与顶栏状态 ——
const ui = await pageCall('Runtime.evaluate', {
  expression:
    "(() => ({ title: document.querySelector('.h24-conversation-title')?.textContent ?? '', callBtn: document.querySelector('.h24-call-nav')?.textContent?.trim() ?? '', sidebar: document.querySelectorAll('.h24-sidebar-item').length, composer: Boolean(document.querySelector('.text-composer')) }))()",
  returnByValue: true,
});
console.log('ui:', JSON.stringify(ui.result.value));

console.log(`console-errors: ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log(`  - ${e}`);

pageWs.close();
process.exit(errors.length ? 3 : 0);
