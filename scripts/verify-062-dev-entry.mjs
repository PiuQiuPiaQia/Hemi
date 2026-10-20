// 062 补充真机验证（AC-07 开发入口）：Vite dev server（React StrictMode 生效）＋
// 真实主进程起应用，走一轮真实模型交付 → 对话入口 → 打开/关闭/再打开预览 Tab。
// AGENTS「React 双入口」口径：构建产物通过不覆盖开发模式的双挂载故障，这里
// 用 dev URL 重走。exit 0＝全过。
//
// 运行：node scripts/verify-062-dev-entry.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = path.join('node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const realUserData = path.join(os.homedir(), 'Library', 'Application Support', 'hemi');
const VITE_PORT = Number(process.env.HEMI_DEV_PORT_VERIFY || 5175);
const PORT = 9477;
const MARK = `d${Date.now().toString(36).slice(-6)}`;
const SVG_NAME = `hemi062-dev-${MARK}.svg`;
const evidenceDir = path.resolve(
  process.env.HEMI_062_EVIDENCE ?? path.join('.visual', 'workflow', 'vision', `062-dev-${Date.now()}`),
);
fs.mkdirSync(evidenceDir, { recursive: true });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi062dev-'));
const UD = path.join(root, 'userData');
fs.mkdirSync(path.join(UD, 'conversations'), { recursive: true });
for (const name of ['text-model.json', 'text-model-profiles.json', 'onboarding.json']) {
  const source = path.join(realUserData, name);
  if (!fs.existsSync(source)) throw new Error(`缺真实配置：${source}`);
  fs.copyFileSync(source, path.join(UD, name));
}
try {
  const profilesPath = path.join(UD, 'text-model-profiles.json');
  const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  const keys = (profiles.providers ?? []).flatMap((provider) =>
    (provider.models ?? []).map((model) => `${provider.id}/${model.id}`),
  );
  const deepseek = keys.find((key) => key.includes('deepseek')) ?? profiles.defaultModelId ?? keys[0];
  profiles.defaultModelId = deepseek;
  profiles.lastConversationModelKey = deepseek;
  fs.writeFileSync(profilesPath, JSON.stringify(profiles));
  console.log(`[062d] 会话模型钉死：${deepseek}`);
} catch (error) {
  console.warn(`[062d] 模型钉死失败（沿用原配置）：${error.message}`);
}
console.log(`[062d] 标记：${MARK}\n[062d] 实例：${UD}\n[062d] 证据：${evidenceDir}`);

const checks = {};
let electronChild = null;
let viteChild = null;
const shutdown = () => {
  for (const child of [electronChild, viteChild]) {
    if (child && child.pid) { try { child.kill('SIGKILL'); } catch { /* 已退 */ } }
  }
};
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });

// 1) 起 Vite dev server（HEMI_DEV_PORT 指定独立端口，避开可能被占的 5173）。
const viteLog = fs.openSync(path.join(evidenceDir, 'vite.log'), 'w');
viteChild = spawn(process.execPath, ['scripts/dev-renderer.mjs'], {
  env: { ...process.env, HEMI_DEV_PORT: String(VITE_PORT) },
  stdio: ['ignore', viteLog, viteLog],
});
let viteUp = false;
for (let i = 0; i < 60; i += 1) {
  viteUp = await fetch(`http://127.0.0.1:${VITE_PORT}/`).then((r) => r.ok).catch(() => false);
  if (viteUp) break;
  await sleep(500);
}
if (!viteUp) throw new Error(`vite dev server 30s 未就绪（127.0.0.1:${VITE_PORT}，日志见 vite.log）`);
console.log(`[062d] vite dev server 就绪：127.0.0.1:${VITE_PORT}`);

// 2) 起 Electron（VITE_DEV_SERVER_URL → renderer 走 dev 入口，StrictMode 生效）。
const electronLog = fs.openSync(path.join(evidenceDir, 'electron-dev.log'), 'w');
electronChild = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, HEMI_USER_DATA_DIR: UD, VITE_DEV_SERVER_URL: `http://127.0.0.1:${VITE_PORT}` },
  stdio: ['ignore', electronLog, electronLog],
});
fs.closeSync(electronLog);

let targets = null;
for (let i = 0; i < 120; i += 1) {
  targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => null);
  if (targets?.some((t) => t.type === 'page' && !/mode=/.test(t.url))) break;
  await sleep(500);
}
const page = targets?.find((t) => t.type === 'page' && !/mode=/.test(t.url));
if (!page) throw new Error('dev 主窗口 60s 未就绪');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args?.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
  }
  if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expression, timeoutMs = 30_000) => {
  const result = await Promise.race([
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    sleep(timeoutMs).then(() => null),
  ]).catch(() => null);
  if (result == null) return undefined;
  if (result?.exceptionDetails) throw new Error(`page-eval: ${result.exceptionDetails.text ?? ''}`.slice(0, 200));
  return result?.result?.value;
};
await send('Runtime.enable');
for (let i = 0; i < 120; i += 1) {
  if (await evalJs('window.hemiVoice && Boolean(document.querySelector("textarea")) && !document.querySelector(".setup-shell")')) break;
  await sleep(500);
}
const shot = async (name) => {
  const frame = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(evidenceDir, `${name}.png`), Buffer.from(frame.data, 'base64'));
  console.log(`[062d] 截图 ${name}.png`);
};
const wait = async (label, predicate, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
};
const latestArchive = () => {
  const dir = path.join(UD, 'conversations');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('._'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
};
const decodeDataUrlText = (dataUrl) => Buffer.from(String(dataUrl).split(',')[1] ?? '', 'base64').toString('utf8');

try {
  // 确认 renderer 走的是 dev URL（双入口口径：这轮证据属于开发入口）。
  const locationHref = await evalJs('location.href');
  checks['1-renderer是dev入口'] = String(locationHref ?? '').includes(`127.0.0.1:${VITE_PORT}`);
  console.log(`[062d] renderer URL：${locationHref}`);

  // 真实模型一轮：主 agent 生成 SVG 并声明交付。
  const how = await evalJs(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(
      `在桌面（~/Desktop）创建 ${SVG_NAME}：一张 240x120 的 SVG，紫色矩形，里面写文字 062DEV${MARK}。创建后用 register_delivery 声明这个文件为正式交付。`,
    )});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('.text-composer-send')].find((e) => e.offsetParent !== null);
    if (btn && !btn.classList.contains('is-stop')) { btn.click(); return 'clicked'; }
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return 'enter';
  })()`);
  console.log(`[062d] 发送（${how}）`);
  const artifact = await wait('dev 入口交付登记', () => {
    const artifacts = latestArchive()?.flow?.artifacts;
    return artifacts ? Object.values(artifacts).find((a) => a?.name === SVG_NAME) ?? null : null;
  }, 240_000);
  checks['2-dev入口登记交付'] = Boolean(artifact.path);
  console.log(`[062d] 登记：${artifact.path}`);
  await wait('回合收口', () => latestArchive()?.flow?.phase === 'idle', 240_000).catch(() => null);

  // 打开 → 关闭 → 再打开（AGENTS「两种入口都要重走」的路径）。
  await wait('对话入口 chip', () => evalJs(`Boolean([...document.querySelectorAll('.h62-deliverable-chip')].find((c) => c.textContent.includes(${JSON.stringify(SVG_NAME)})))`));
  await evalJs(`(() => { [...document.querySelectorAll('.h62-deliverable-chip')].find((c) => c.textContent.includes(${JSON.stringify(SVG_NAME)}))?.click(); return true; })()`);
  await wait('dev 入口预览打开', () => evalJs(`Boolean(document.querySelector('.h24-preview'))`));
  checks['3-打开预览'] = true;
  await shot('dev-open');
  await evalJs(`(() => { [...document.querySelectorAll('.h24-preview-tab-close')].at(-1)?.click(); return true; })()`);
  await wait('关闭后面板收起', async () => !(await evalJs(`Boolean(document.querySelector('.h24-preview'))`)));
  checks['4-关闭预览'] = true;
  await evalJs(`(() => { [...document.querySelectorAll('.h62-deliverable-chip')].find((c) => c.textContent.includes(${JSON.stringify(SVG_NAME)}))?.click(); return true; })()`);
  const reopened = await wait('再打开预览并读出内容', async () => {
    const full = await evalJs(`(() => { const img = document.querySelector('img.h24-preview-image'); return img ? String(img.src ?? '') : null; })()`);
    if (!full) return null;
    return decodeDataUrlText(full).includes(`062DEV${MARK}`) ? full : null;
  });
  checks['5-再打开读取成功'] = Boolean(reopened);
  await shot('dev-reopen');
  console.log(`[062d] 再打开读出 062DEV${MARK}`);

  checks['6-零renderer错误'] = consoleErrors.length === 0;
  if (consoleErrors.length) console.warn(`[062d] renderer errors：${JSON.stringify(consoleErrors.slice(0, 5))}`);
} finally {
  shutdown();
  await sleep(1_500);
  try { ws.close(); } catch { /* 已关 */ }
  fs.closeSync(viteLog);
}

fs.writeFileSync(path.join(evidenceDir, 'checks.json'), JSON.stringify({ checks, mark: MARK, userData: UD }, null, 2));
const failed = Object.entries(checks).filter(([, ok]) => !ok);
console.log(`HEMI_062D_RESULT=${JSON.stringify({ checks, failed: failed.map(([k]) => k) })}`);
if (failed.length) {
  console.error(`[062d] 未过项：${failed.map(([k]) => k).join(' | ')}`);
  process.exit(1);
}
console.log('[062d] 全部断言通过');
process.exit(0);
