#!/usr/bin/env node
/**
 * 032 真机首启引导走查（CDP 驱动真实应用，五屏全链路）。
 *
 * 前置：应用以空隔离 userData + 9222 调试端口启动（无 ASR/模型配置）：
 *   HEMI_USER_DATA_DIR=<空目录> npx electron . --remote-debugging-port=9222
 *
 * 用法（分段对应验收矩阵，bash 编排负责启停应用）：
 *   node scripts/real-app-032-onboarding.mjs fresh-full   # 五屏走完 → 主界面
 *   node scripts/real-app-032-onboarding.mjs partial      # 走到模型屏就停（AC-5 续接前半）
 *   node scripts/real-app-032-onboarding.mjs resume-check # 重启后：仍在引导、停在模型步
 *   node scripts/real-app-032-onboarding.mjs return-check # 完成后重启：直达主界面（AC-7）
 *   node scripts/real-app-032-onboarding.mjs orb-gate     # 悬浮球门控：进行中不出现、完成后恢复
 *   node scripts/real-app-032-onboarding.mjs repair-check # 配置失效：不回引导 + 修复条 + 直达
 *   node scripts/real-app-032-onboarding.mjs repair-clear # 磁盘补回配置后回读：修复条消失
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';

const PHASE = process.argv[2] ?? 'fresh-full';
const UD = process.env.HEMI_USER_DATA_DIR;
if (!UD) throw new Error('需要 HEMI_USER_DATA_DIR 指向走查用的隔离 userData');
const OUT = resolve(process.cwd(), '.visual/workflow/vision/032-real-onboarding');
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
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (!text.includes('Insecure Content-Security-Policy')) errors.push(`[console.error] ${text.slice(0, 200)}`);
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

async function waitFor(label, read, timeoutMs = 30_000, interval = 400) {
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

async function shot(name) {
  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(OUT, name), Buffer.from(data, 'base64'));
  console.log(`saved ${name}`);
}

/** React 受控输入：原生 setter + input 事件。 */
async function typeInto(selectorJs, value) {
  await rt(`(() => {
    const el = ${selectorJs};
    if (!el) throw new Error('input not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

const title = () => rt(`document.querySelector('.onboarding-title')?.textContent ?? ''`);
const stepCount = () => rt(`document.querySelector('.onboarding-step-count')?.textContent?.trim() ?? ''`);
const mainUiReady = () => rt(`Boolean(document.querySelector('.text-composer'))`);

async function walkToModel(prefix) {
  await waitFor('引导页渲染', () => rt(`Boolean(document.querySelector('.setup-shell .onboarding-scene'))`), 40_000);

  record((await title()) === '你好，我是 Hemi。', 'AC-1 欢迎屏标题与文案');
  record((await stepCount()) === '1 / 5', '顶栏步数指示 1/5');
  record(
    await rt(`[...document.querySelectorAll('.setup-shell button')].every((b) => !/跳过/.test(b.textContent))`),
    'AC-1 欢迎屏无跳过引导入口',
  );
  await shot(`${prefix}10-welcome.png`);

  await click(`[...document.querySelectorAll('.onboarding-primary')].find((b) => b.textContent.includes('开始设置'))`);
  await waitFor('麦克风屏', async () => (await title()) === '开启麦克风');
  record((await stepCount()) === '2 / 5', '步数指示 2/5');
  record(
    await rt(`Boolean([...document.querySelectorAll('.onboarding-secondary')].find((b) => b.textContent.includes('稍后开启')))`),
    'AC-2 权限页有「稍后开启」，未自动弹系统权限窗',
  );
  await shot(`${prefix}20-permission.png`);

  // 稍后开启 → 未开启说明 → 继续（AC-2：跳过可继续且说明影响）。
  await click(`[...document.querySelectorAll('.onboarding-secondary')].find((b) => b.textContent.includes('稍后开启'))`);
  await waitFor('麦克风未开启说明', async () => (await title()) === '麦克风未开启');
  await shot(`${prefix}21-permission-skipped.png`);
  await click(`[...document.querySelectorAll('.onboarding-primary')].find((b) => b.textContent.includes('继续'))`);
  await waitFor('语音服务屏', async () => (await title()) === '连接语音服务');
  record((await stepCount()) === '3 / 5', '步数指示 3/5');

  // 未填 Key 点「保存并继续」应被禁用（不发起保存）。
  const disabledEarly = await rt(`Boolean([...document.querySelectorAll('.onboarding-primary')].find((b) => b.textContent.includes('保存并继续'))?.disabled)`);
  record(disabledEarly, 'AC-3 未填密钥时保存被禁用');
  await typeInto(`document.getElementById('onboarding-asr-key')`, 'test-asr-key-032');
  await shot(`${prefix}30-asr.png`);
  await click(`[...document.querySelectorAll('.onboarding-primary')].find((b) => b.textContent.includes('保存并继续'))`);
  await waitFor('模型屏（ASR 已存推进）', async () => (await title()) === '连接主脑模型', 30_000);
  record((await stepCount()) === '4 / 5', 'AC-1 ASR 保存后推进到模型屏');
}

async function finishModel(prefix) {
  // 测试连接：三项未填全时按钮禁用；填全后发起真实请求，失败就地反馈且保留输入。
  const testDisabledEarly = await rt(`Boolean(document.querySelector('.onboarding-test-button')?.disabled)`);
  record(testDisabledEarly, 'AC-4 未填三项时「测试连接」禁用');
  await typeInto(`document.getElementById('onboarding-model-url')`, 'https://api.example.com/v1');
  await typeInto(`document.getElementById('onboarding-model-name')`, 'example-chat');
  await typeInto(`document.getElementById('onboarding-model-key')`, 'test-key-032');
  await shot(`${prefix}40-model.png`);
  await click(`document.querySelector('.onboarding-test-button')`);
  const testError = await waitFor(
    '测试失败就地反馈',
    () => rt(`document.querySelector('.onboarding-test-result')?.getAttribute('data-kind')`),
    45_000,
  );
  record(testError === 'error', 'AC-4 不可达端点的测试失败就地反馈（网络/服务错误，非崩溃）', `kind=${testError}`);
  const keptUrl = await rt(`document.getElementById('onboarding-model-url')?.value`);
  record(keptUrl === 'https://api.example.com/v1', 'AC-4 测试失败后输入保留');
  // 改字段后旧结果即失效（迟到的旧回执不覆盖新输入）。
  await typeInto(`document.getElementById('onboarding-model-name')`, 'example-chat-2');
  const staleCleared = await rt(`!document.querySelector('.onboarding-test-result')`);
  record(staleCleared, 'AC-4 改字段后旧测试结果立即失效');
  await typeInto(`document.getElementById('onboarding-model-name')`, 'example-chat');

  await click(`[...document.querySelectorAll('.onboarding-primary')].find((b) => b.textContent.includes('保存并继续'))`);
  await waitFor('完成屏', async () => (await title()) === '设置好了', 30_000);
  record((await stepCount()) === '5 / 5', '完成屏步数指示 5/5', await stepCount());
  await shot(`${prefix}50-complete.png`);
}

async function completeOnboarding() {
  await click(`[...document.querySelectorAll('.onboarding-primary')].find((b) => b.textContent.includes('开始使用'))`);
  await waitFor('主界面', () => mainUiReady(), 40_000);
  record(!(await rt(`Boolean(document.querySelector('.setup-shell'))`)), 'AC-1 完成后进入主界面');
  await shot('60-main.png');
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(resolve(UD, file), 'utf8'));
  } catch {
    return null;
  }
}

try {
  await call('Page.enable');
  await call('Runtime.enable');

  if (PHASE === 'fresh-full') {
    await walkToModel('full-');
    await finishModel('full-');
    await completeOnboarding();

    const onboarding = readJsonSafe('onboarding.json');
    record(onboarding?.phase === 'complete', '完成屏「开始使用」写入 onboardingVersion（phase=complete）', JSON.stringify(onboarding)?.slice(0, 120));
    const profiles = readJsonSafe('text-model-profiles.json');
    const savedKey = profiles?.defaultModelId ?? '';
    const savedProvider = (profiles?.providers ?? []).find((p) => `${p.id}` === String(savedKey).split('/')[0]);
    record(
      Boolean(savedProvider?.models?.some((m) => `${savedProvider.id}/${m.id}` === savedKey && m.model === 'example-chat'))
        && Boolean(savedProvider?.encryptedApiKey) && !savedProvider?.plainApiKey,
      'AC-4 引导保存的分组即默认分组，Key 密文落盘（无明文）',
      `default=${savedKey}`,
    );
    record(existsSync(resolve(UD, 'doubao-asr.json')), '第 3 屏 ASR Key 已持久保存（doubao-asr.json 存在）');
    record(!existsSync(resolve(UD, 'executor')), '清洁度：userData 无 executor/ 目录');
  } else if (PHASE === 'partial') {
    await walkToModel('part-');
    record((await title()) === '连接主脑模型', 'AC-5 前半：停在模型屏（第 4 屏）');
    const onboarding = readJsonSafe('onboarding.json');
    record(onboarding?.phase === 'in_progress' && onboarding?.step === 'model', '进行中状态已落盘（step=model）', JSON.stringify(onboarding)?.slice(0, 120));
    await shot('part-40-model.png');
  } else if (PHASE === 'resume-check') {
    await waitFor('引导页渲染（重启续接）', () => rt(`Boolean(document.querySelector('.setup-shell .onboarding-scene'))`), 40_000);
    record((await title()) === '连接主脑模型', 'AC-5 重启后回到未完成的模型步', await title());
    record((await stepCount()) === '4 / 5', 'AC-5 步数仍 4/5');
    const onboarding = readJsonSafe('onboarding.json');
    record(onboarding?.phase === 'in_progress', 'AC-5 已存 ASR Key 不被误判为存量用户（仍 in_progress）', JSON.stringify(onboarding)?.slice(0, 120));
    // 返回语音步：应显示已保存卡（不回显明文）。
    await click(`[...document.querySelectorAll('.onboarding-back')].find((b) => b.textContent.includes('返回'))`);
    await waitFor('语音步已保存卡', async () => (await title()) === '语音服务已保存');
    const keyEcho = await rt(`document.querySelector('.onboarding-saved')?.textContent ?? ''`);
    record(!keyEcho.includes('test-asr-key-032'), 'AC-8 已存密钥不回显明文（只显示已保存）', keyEcho.slice(0, 40));
    await shot('resume-30-asr-saved.png');
  } else if (PHASE === 'return-check') {
    await waitFor('主界面渲染（回访直达）', () => mainUiReady(), 40_000);
    record(!(await rt(`Boolean(document.querySelector('.setup-shell'))`)), 'AC-7 已完成用户重启直达主界面');
    const onboarding = readJsonSafe('onboarding.json');
    record(onboarding?.phase === 'complete', '引导状态保持 complete（不重弹）');
    await shot('return-60-main.png');
  } else if (PHASE === 'orb-gate') {
    // 窗口外入口（验证矩阵）：进行中（ASR 已存、停在模型步）隐藏主窗 →
    // 悬浮球/字幕条不得出现；完成后隐藏 → 按设置恢复。
    await walkToModel('orbgate-');
    await rt(`window.hemiVoice.hideMainWindow()`);
    await sleep(4000); // 可见性轮询 350ms，留足裕量
    const duringOnboarding = (await json('/json/list')).filter((t) => /mode=(orb|caption)/.test(t.url));
    record(duringOnboarding.length === 0, '引导进行中隐藏主窗：悬浮球/字幕条不出现', `${duringOnboarding.length} 个悬浮目标`);
    await rt(`window.hemiVoice.showMainWindow()`);
    await sleep(1000);
    await finishModel('orbgate-');
    await completeOnboarding();
    await rt(`window.hemiVoice.hideMainWindow()`);
    await waitFor('完成后悬浮球出现', async () =>
      (await json('/json/list')).some((t) => /mode=orb/.test(t.url)), 15_000);
    const captionToo = (await json('/json/list')).some((t) => /mode=caption/.test(t.url));
    record(captionToo, '完成后悬浮字幕条随球恢复（按既有设置）');
    await rt(`window.hemiVoice.showMainWindow()`);
    await sleep(600);
  } else if (PHASE === 'repair-check') {
    // 完成后配置失效（AC-7）：删 ASR + 模型组 → 不回引导；模型就近提示；
    // 语音入口出修复条 → 直达设置语音子页；未修复前提示不消失。
    await waitFor('主界面渲染（配置被删）', () => mainUiReady(), 40_000);
    record(!(await rt(`Boolean(document.querySelector('.setup-shell'))`)), 'AC-7 删 ASR+模型组后不回引导');
    const composerHint = await waitFor(
      '模型未配置就近提示',
      () => rt(`document.querySelector('.text-composer-hint')?.textContent ?? ''`),
    );
    record(/配置主脑模型/.test(composerHint), 'AC-7 模型缺失靠近输入区提示', composerHint.trim().slice(0, 30));
    await click(`document.querySelector('.h24-call-nav')`);
    const stripText = await waitFor(
      'ASR 修复条出现',
      () => rt(`document.querySelector('.h24-repair-strip')?.textContent ?? ''`),
    );
    record(/语音服务密钥/.test(stripText) && /文字对话仍可继续/.test(stripText), 'AC-7 ASR 缺失修复条（语音不可用、文字可继续）', stripText.slice(0, 40));
    await shot('repair-70-strip.png');
    await click(`document.querySelector('.h24-repair-strip button')`);
    await waitFor('设置页打开', () => rt(`Boolean(document.querySelector('.settings-shell'))`));
    // 041 六分类：子 tab 退役，修复条直达「语音与通话」一级分类（aria-current 判定）。
    const voiceTab = await rt(`document.querySelector('.settings-nav .h37-settings-navitem[aria-current="true"]')?.textContent ?? ''`);
    record(voiceTab.includes('语音'), '修复条直达设置「语音与通话」页', voiceTab);
    await shot('repair-71-settings-voice.png');
    await click(`document.querySelector('.settings-shell .icon-btn')`);
    await sleep(1500);
    const stripStill = await rt(`document.querySelector('.h24-repair-strip')?.textContent ?? ''`);
    record(/语音服务密钥/.test(stripStill), '未修复前提示不消失（关设置不误清）', stripStill.slice(0, 30));
  } else if (PHASE === 'repair-clear') {
    // 磁盘侧补回 ASR 配置后（bash 编排 cp），开/关设置触发回读 → 修复条消失。
    await waitFor('主界面渲染', () => mainUiReady(), 40_000);
    const stripBefore = await rt(`document.querySelector('.h24-repair-strip')?.textContent ?? ''`);
    record(/语音服务密钥/.test(stripBefore), '补配置后、回读前修复条仍在', stripBefore.slice(0, 30));
    await click(`document.querySelector('.h24-repair-strip button')`);
    await waitFor('设置页打开', () => rt(`Boolean(document.querySelector('.settings-shell'))`));
    await click(`document.querySelector('.settings-shell .icon-btn')`);
    await sleep(1800);
    const stripGone = await rt(`!document.querySelector('.h24-repair-strip')`);
    record(stripGone, 'AC-7 修复后提示消失（留在主界面，不回引导）');
    await shot('repair-72-cleared.png');
  } else {
    throw new Error(`未知阶段：${PHASE}`);
  }

  record(errors.length === 0, '无渲染异常/console 错误', errors.slice(0, 3).join(' | ').slice(0, 200));
  writeFileSync(resolve(OUT, `onboarding-${PHASE}-result.json`), JSON.stringify({ phase: PHASE, results, errors }, null, 2));
  console.log(`\n${PHASE}: ${results.filter((r) => r.ok).length}/${results.length} 断言通过`);

  const failed = results.filter((r) => !r.ok);
  ws.close();
  process.exit(failed.length ? 1 : 0);
} catch (error) {
  console.error(error);
  writeFileSync(resolve(OUT, `onboarding-${PHASE}-result.json`), JSON.stringify({ phase: PHASE, results, errors, fatal: String(error) }, null, 2));
  process.exit(1);
}
