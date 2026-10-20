// 062 补充真机验证（合并前收尾）：构建产物实例上跑两段——
// A) 子 agent 派单交付（AC-01 子 agent 侧）：主 agent 经 task 工具派 fixer 在桌面生成
//    SVG 并声明 → 会话 flow.artifacts 登记（producers 带子任务归属）→ 对话入口 →
//    右侧读出本次标记；
// B) 响应式检查（AC-07 剩余项）：375／768 两个宽度下侧栏/预览形态与溢出。
// 证据（截图/断言 JSON/electron 日志）落 HEMI_062_EVIDENCE，exit 0＝全过。
//
// 运行：node scripts/verify-062-followup.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = path.join('node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const realUserData = path.join(os.homedir(), 'Library', 'Application Support', 'hemi');
const PORT = 9476;
const MARK = `s${Date.now().toString(36).slice(-6)}`;
const SUB_SVG = `hemi062-sub-${MARK}.svg`;
const evidenceDir = path.resolve(
  process.env.HEMI_062_EVIDENCE ?? path.join('.visual', 'workflow', 'vision', `062-followup-${Date.now()}`),
);
fs.mkdirSync(evidenceDir, { recursive: true });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi062sub-'));
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
  console.log(`[062f] 会话模型钉死：${deepseek}`);
} catch (error) {
  console.warn(`[062f] 模型钉死失败（沿用原配置）：${error.message}`);
}
console.log(`[062f] 标记：${MARK}\n[062f] 实例：${UD}\n[062f] 证据：${evidenceDir}`);

const checks = {};
let child = null;
const shutdown = () => {
  if (child && child.pid) { try { child.kill('SIGKILL'); } catch { /* 已退 */ } }
};
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });

async function boot() {
  const logFd = fs.openSync(path.join(evidenceDir, 'electron-followup.log'), 'w');
  child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
    env: { ...process.env, HEMI_USER_DATA_DIR: UD },
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  let targets = null;
  for (let i = 0; i < 120; i += 1) {
    targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => null);
    if (targets?.some((t) => t.type === 'page' && !/mode=/.test(t.url))) break;
    await sleep(500);
  }
  const page = targets?.find((t) => t.type === 'page' && !/mode=/.test(t.url));
  if (!page) throw new Error('主窗口 60s 未就绪');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  // renderer 侧 error 级 console 收集（AC-07「零白屏/零错误」口径）与请求回执同一条分发。
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
    console.log(`[062f] 截图 ${name}.png`);
  };
  const setWidth = async (width) => {
    // 响应式检查用视口模拟（CSS 断点按视口宽响应，与窗口缩放等效且不动真实窗口）。
    await send('Emulation.setDeviceMetricsOverride', { width, height: 860, mobile: false, deviceScaleFactor: 2 });
    await sleep(600);
  };
  return { evalJs, send, shot, setWidth, get consoleErrors() { return consoleErrors; }, close: () => { try { ws.close(); } catch { /* 已关 */ } } };
}

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
const flowDeliverables = () => {
  const artifacts = latestArchive()?.flow?.artifacts;
  return artifacts && typeof artifacts === 'object' ? artifacts : null;
};
const previewImageFull = (phase) => phase.evalJs(`(() => {
  const img = document.querySelector('img.h24-preview-image');
  return img ? String(img.src ?? '') : null;
})()`);
const decodeDataUrlText = (dataUrl) => Buffer.from(String(dataUrl).split(',')[1] ?? '', 'base64').toString('utf8');

const phase = await boot();
try {
  // ---- A) 子 agent 派单交付 ----
  const how = await phase.evalJs(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(
      `请用 task 工具派一个 fixer 子 agent 去完成（你自己不要动手）：在桌面创建 ${SUB_SVG}，内容是一张 240x120 的 SVG，绿色矩形，里面写文字 062SUB${MARK}；创建完成后由它用 register_delivery 声明这个文件为正式交付。你只需要派单、等结果、然后向用户转述。`,
    )});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('.text-composer-send')].find((e) => e.offsetParent !== null);
    if (btn && !btn.classList.contains('is-stop')) { btn.click(); return 'clicked'; }
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return 'enter';
  })()`);
  console.log(`[062f] 派单发送（${how}）`);

  const subArtifact = await wait('子 agent 交付登记（flow.artifacts）', () => {
    const artifacts = flowDeliverables();
    if (!artifacts) return null;
    return Object.values(artifacts).find((a) => a?.name === SUB_SVG) ?? null;
  }, 300_000);
  checks['A1-子agent声明→会话登记'] = true;
  const producer = (subArtifact.producers ?? [])[0] ?? {};
  checks['A2-生产归属带主运行与任务身份'] = typeof producer.runId === 'string' && producer.runId.length > 0;
  checks['A3-真实文件在盘'] = fs.existsSync(subArtifact.path) && fs.statSync(subArtifact.path).size > 0;
  console.log(`[062f] 子 agent 登记：${JSON.stringify({ artifactId: subArtifact.artifactId.slice(-32), producer, path: subArtifact.path })}`);

  await wait('回合收口（flow idle）', () => latestArchive()?.flow?.phase === 'idle', 300_000).catch(() => null);
  const chip = await phase.evalJs(`(() => {
    const chip = [...document.querySelectorAll('.h62-deliverable-chip')].find((c) => c.textContent.includes(${JSON.stringify(SUB_SVG)}));
    return chip ? { text: chip.textContent.trim() } : null;
  })()`);
  checks['A4-对话流入口'] = Boolean(chip);
  await phase.shot('A-subagent-chip');

  await phase.evalJs(`(() => { const chip = [...document.querySelectorAll('.h62-deliverable-chip')].find((c) => c.textContent.includes(${JSON.stringify(SUB_SVG)})); if (chip) chip.click(); return true; })()`);
  const image = await wait('右侧预览读出子 agent 产物', async () => {
    const full = await previewImageFull(phase);
    if (!full) return null;
    return decodeDataUrlText(full).includes(`062SUB${MARK}`) ? full : null;
  });
  checks['A5-右侧预览含子任务标记'] = true;
  await phase.shot('A-subagent-preview');
  console.log(`[062f] 子 agent 预览读出标记 062SUB${MARK}`);

  // ---- B) 响应式：375 与 768 ----
  // 375：极窄——侧栏收抽屉（880 断点＝visibility:hidden+平移出视口）、预览 modal 覆盖、收起按钮可见、无横向溢出。
  await phase.setWidth(375);
  const narrow375 = await phase.evalJs(`(() => ({
    sidebarDrawer: getComputedStyle(document.querySelector('.h24-sidebar')).visibility === 'hidden',
    preview: Boolean(document.querySelector('.h24-preview')),
    collapseVisible: Boolean([...document.querySelectorAll('.h24-preview-collapse')].find((b) => b.offsetParent !== null)),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))()`);
  checks['B1-375预览modal在场'] = narrow375.preview;
  checks['B2-375收起按钮可见'] = narrow375.collapseVisible;
  checks['B3-375无横向溢出'] = narrow375.overflowX <= 1;
  console.log(`[062f] 375 状态：${JSON.stringify(narrow375)}`);
  await phase.shot('B-375-preview');
  // 关闭预览回对话（modal 形态收起钮），再确认对话可用。
  await phase.evalJs(`(() => { [...document.querySelectorAll('.h24-preview-collapse')].find((b) => b.offsetParent !== null)?.click(); return true; })()`);
  const backFrom375 = await phase.evalJs(`(() => ({ composer: Boolean(document.querySelector('textarea')), overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth }))()`);
  checks['B4-375收起后对话可用'] = backFrom375.composer && backFrom375.overflowX <= 1;
  await phase.shot('B-375-collapsed');

  // 768：中窄——侧栏抽屉（visibility:hidden）、内容铺满、再开预览不溢出。
  await phase.setWidth(768);
  const mid768 = await phase.evalJs(`(() => ({
    sidebarDrawer: getComputedStyle(document.querySelector('.h24-sidebar')).visibility === 'hidden',
    composer: Boolean(document.querySelector('textarea')),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))()`);
  checks['B5-768侧栏收抽屉'] = mid768.sidebarDrawer;
  checks['B6-768内容铺满无溢出'] = mid768.composer && mid768.overflowX <= 1;
  console.log(`[062f] 768 状态：${JSON.stringify(mid768)}`);
  await phase.shot('B-768');
  // 再打开预览（打开→关闭→再打开的窄窗重走）。
  await phase.evalJs(`(() => { const chip = [...document.querySelectorAll('.h62-deliverable-chip')].find((c) => c.textContent.includes(${JSON.stringify(SUB_SVG)})); if (chip) chip.click(); return true; })()`);
  const reopen = await wait('768 再开预览', () => phase.evalJs(`Boolean(document.querySelector('.h24-preview'))`));
  checks['B7-768再开预览'] = Boolean(reopen);
  await phase.shot('B-768-reopen');
  const reopenOverflow = await phase.evalJs(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  checks['B8-768预览无溢出'] = reopenOverflow <= 1;

  checks['B9-全程零renderer错误'] = phase.consoleErrors.length === 0;
  if (phase.consoleErrors.length) console.warn(`[062f] renderer errors：${JSON.stringify(phase.consoleErrors.slice(0, 5))}`);
} finally {
  shutdown();
  await sleep(1_500);
  phase.close();
}

fs.writeFileSync(path.join(evidenceDir, 'checks.json'), JSON.stringify({ checks, mark: MARK, userData: UD }, null, 2));
const failed = Object.entries(checks).filter(([, ok]) => !ok);
console.log(`HEMI_062F_RESULT=${JSON.stringify({ checks, failed: failed.map(([k]) => k) })}`);
if (failed.length) {
  console.error(`[062f] 未过项：${failed.map(([k]) => k).join(' | ')}`);
  process.exit(1);
}
console.log('[062f] 全部断言通过');
process.exit(0);
