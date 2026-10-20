#!/usr/bin/env node
/**
 * 027 真机会话重开走查（AC-07 会话级）：应用优雅退出并重启后，验证
 * ①会话从磁盘种子化（交付条目回到对话流）；②Tab 不跨重启（重启后为空）；
 * ③点击成果按持久化的 taskId+artifactId 身份重新打开预览。
 *
 * 前置：应用以 HEMI_TEST_MIC_GRANT=1（产品自带测试缝隙，见
 * src/main/ipc/permissions.ipc.mjs）+ 同一隔离 userData 启动，9222 调试端口。
 * 用法：node scripts/real-app-027-reopen.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';

const OUT = resolve(process.cwd(), '.visual/workflow/vision/027-real-walkthrough');
mkdirSync(OUT, { recursive: true });
const CDP = 'http://127.0.0.1:9222';

const results = [];
const record = (ok, name, detail = '') => {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(path) {
  const res = await fetch(`${CDP}${path}`);
  if (!res.ok) throw new Error(`CDP ${path}: ${res.status}`);
  return res.json();
}

const targets = await json('/json/list');
const main = targets.find(
  (t) => t.type === 'page' && t.title.includes('Hemi') && !/mode=(orb|caption|task-popover)/.test(t.url),
);
if (!main) throw new Error(`main window target not found: ${targets.map((t) => t.title).join('|')}`);
const ws = new WebSocket(main.webSocketDebuggerUrl, { perMessageDeflate: false });
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
    errors.push(
      msg.params.exceptionDetails?.exception?.description ??
        JSON.stringify(msg.params).slice(0, 200),
    );
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (!text.includes('Insecure Content-Security-Policy')) errors.push(`[console.${msg.params.type}] ${text.slice(0, 200)}`);
  }
});
const call = (method, params = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const id = ++seq;
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function rt(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
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

async function click(selectorJs) {
  const rect = await rt(`(() => {
    const el = ${selectorJs};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!rect) return false;
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  return true;
}

try {
  await call('Page.enable');
  await call('Runtime.enable');

  // 麦克风门由启动环境的 HEMI_TEST_MIC_GRANT=1 放行；直接读真实冷启动状态。
  await waitFor('主窗渲染', () => rt(`Boolean(document.querySelector('.setup-shell, .text-composer'))`), 40_000);
  if (await rt(`Boolean(document.querySelector('.setup-shell'))`)) {
    throw new Error('仍停在引导页：确认应用以 HEMI_TEST_MIC_GRANT=1 启动');
  }

  const rows = await rt(`(() => {
    const groups = [...document.querySelectorAll('.h24-delivery-group')];
    const g = groups.find((x) => (x.querySelector('.h24-delivery-caption')?.textContent ?? '').includes('已保存的文件'));
    return g ? [...g.querySelectorAll('.h24-artifact-row')].map((b) => b.textContent.trim().slice(0, 40)) : [];
  })()`);
  record(rows.length > 0, '重启后最近会话种子化，交付条目回到对话流', `${rows.length} 条：${JSON.stringify(rows.map((r) => r.slice(0, 18)))}`);
  record(!(await rt(`Boolean(document.querySelector('.h24-preview'))`)), '重启后 Tab 不跨重启（面板未开）');

  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(OUT, '10-restart-seeded.png'), Buffer.from(data, 'base64'));
  console.log('saved 10-restart-seeded.png');

  // 点击第一个文件成果 → 按持久化档案身份重开
  await click(`(() => {
    const groups = [...document.querySelectorAll('.h24-delivery-group')];
    const g = groups.find((x) => (x.querySelector('.h24-delivery-caption')?.textContent ?? '').includes('已保存的文件'));
    return g ? g.querySelector('.h24-artifact-row') : null;
  })()`);
  await sleep(800);
  const tabKey = await rt(`document.querySelector('.h24-preview-tab [data-tab-key]')?.getAttribute('data-tab-key') ?? null`);
  const bodyText = await rt(`document.querySelector('.h24-preview-body')?.textContent?.trim().slice(0, 60) ?? null`);
  record(Boolean(tabKey), '点击成果按持久化 taskId+artifactId 重开预览', `tabKey=${tabKey}，正文「${bodyText}」`);

  const { data: d2 } = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(OUT, '11-restart-reopen.png'), Buffer.from(d2, 'base64'));
  console.log('saved 11-restart-reopen.png');

  writeFileSync(resolve(OUT, 'reopen-result.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(`\nconsole-errors: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log(`  - ${e}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== 027 会话重开结果：${results.length - failed}/${results.length} 通过 ===`);
  ws.close();
  process.exit(failed || errors.length ? 3 : 0);
} catch (error) {
  results.push({ ok: false, name: 'harness 异常', detail: String(error?.message ?? error) });
  writeFileSync(resolve(OUT, 'reopen-result.json'), JSON.stringify({ results, errors }, null, 2));
  console.error('[027-reopen] 异常：', error);
  ws.close();
  process.exit(4);
}
