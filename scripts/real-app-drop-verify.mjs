#!/usr/bin/env node
/**
 * 028 拖入路径真机验证（砍「附加」按钮的前置验证）：
 * 用 CDP Input.dispatchDragEvent 携带真实文件路径派发 dragEnter/dragOver/drop
 * ——与用户从访达拖文件是同一事件通路（页面 onDrop → webUtils 路径 → 主进程登记）。
 * 用法：node scripts/real-app-drop-verify.mjs <文件绝对路径>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';

const OUT = resolve(process.cwd(), '.visual/workflow/vision/composer-verify');
mkdirSync(OUT, { recursive: true });
const CDP = 'http://127.0.0.1:9222';
const FILE_PATH = process.argv[2];
if (!FILE_PATH) throw new Error('用法：node scripts/real-app-drop-verify.mjs <文件绝对路径>');

const results = [];
const record = (ok, name, detail = '') => {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP}/json/list`)).json();
const target = list.find(
  (t) => t.type === 'page' && t.title.includes('Hemi') && !/mode=(orb|caption|task-popover)/.test(t.url),
);
if (!target) throw new Error('main window target not found');
const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r, j) => {
  ws.once('open', r);
  ws.once('error', j);
});
let seq = 0;
const pending = new Map();
const errors = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: ok, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else ok(msg.result);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails?.exception?.description ?? JSON.stringify(msg.params).slice(0, 200));
  }
});
const call = (method, params = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`cdp call timeout: ${method}`));
    }, 20_000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolvePromise(v); },
      reject: (e) => { clearTimeout(timer); rejectPromise(e); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
await call('Page.enable');
await call('Runtime.enable');

const rt = (expression) =>
  call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then((r) => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  });

async function drag(type, x, y) {
  return call('Input.dispatchDragEvent', {
    type,
    x,
    y,
    data: {
      items: [],
      files: [FILE_PATH],
      dragOperationsMask: 1,
    },
  });
}

try {
  await waitFor('主窗渲染', async () => Boolean(await rt(`document.querySelector('.text-composer')`)));
  const rect = await rt(`(() => {
    const el = document.querySelector('.text-composer');
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  // 拖入序列：enter → over → drop（与真实拖放同事件序）。
  await drag('dragEnter', rect.x, rect.y);
  await sleep(150);
  const overActive = await rt(`document.querySelector('.text-composer')?.className.includes('is-drag-over')`);
  record(Boolean(overActive), '拖入悬停态显示（is-drag-over）');
  await drag('dragOver', rect.x, rect.y);
  await sleep(150);
  await drag('drop', rect.x, rect.y);
  await sleep(1500);

  const trayCount = await rt(`document.querySelectorAll('.h24-attach-card').length`);
  const cardName = await rt(`document.querySelector('.h24-attach-name')?.textContent ?? ''`);
  record(trayCount === 1, '拖入文件登记进附件托盘', `${trayCount} 张卡，「${cardName}」`);

  // 预览进 027 宿主
  await rt(`document.querySelector('.h24-attach-open')?.click()`);
  await sleep(1100);
  const previewText = await rt(`document.querySelector('.h24-preview-body')?.textContent?.trim().slice(0, 40) ?? ''`);
  record(previewText.includes('拖入验证'), '拖入附件预览正文可读', `「${previewText}」`);

  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(OUT, 'drop-verify.png'), Buffer.from(data, 'base64'));
  console.log('saved drop-verify.png');

  console.log(`\nconsole-errors: ${errors.length}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== 拖入验证：${results.length - failed}/${results.length} 通过 ===`);
  writeFileSync(resolve(OUT, 'drop-verify.json'), JSON.stringify({ results, errors }, null, 2));
  ws.close();
  process.exit(failed || errors.length ? 3 : 0);
} catch (error) {
  console.error('[drop-verify] 异常：', error);
  writeFileSync(resolve(OUT, 'drop-verify.json'), JSON.stringify({ results, errors, error: String(error) }, null, 2));
  try { ws.close(); } catch {}
  process.exit(4);
}

async function waitFor(label, read, timeoutMs = 30_000, interval = 500) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!value && Date.now() < deadline) {
    await sleep(interval);
    value = await read();
  }
  if (!value) throw new Error(`等待超时：${label}`);
  return value;
}
