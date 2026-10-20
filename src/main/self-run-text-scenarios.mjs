// 024 文字输入 · 场景化自驱动验收（AC-03/09/10/11/12 中可自动化部分）：
//   S1 草稿生命周期（AC-11）：收起/展开、进出设置保留；新建对话清空。
//   S2 失败与重试（AC-10）：坏端点真实失败 → 原话保留+重试入口 → 修复配置 →
//      重试成功且用户消息不重复；成功后旧重试入口消失。
//   S3 键盘语义（AC-03 可自动半）：Enter 经真实 React 键路径发送；
//      isComposing=true 的 Enter 不发送（真实输入法仍需人工）；
//      textarea 内空格不被全局拦截（2026-09-28 裁决：空格按住说话退役，
//      按住说话走全局 Option 快捷键/悬浮球长按）。
//   S4 可访问性属性（AC-12 可自动半）：label/describedby/按钮名称齐全。
//   S5 通话混用（AC-09，条件执行）：仅当系统已授予麦克风（TCC）时点「开始
//      通话」→ 通话中打字发送 → 麦克风仍开启 → 结束通话；未授权则记录状态跳过。
//
// 运行：HEMI_SMOKE_TEST=1 HEMI_SELF_RUN_TEXT_SCENARIOS=1 HEMI_USER_DATA_DIR=<UD> npx electron .
import { app, ipcMain, systemPreferences } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { IPC } from '../shared/ipc-channels.mjs';
import { createLogger } from './lib/logger.mjs';
import { disposeTaskManager } from './ipc/task.ipc.mjs';
import { shutdownBrowserBridgeService } from './services/browser-bridge-service.mjs';

const log = createLogger('selfrun-scene');
const UD = app.getPath('userData');
const MODEL_STORE = path.join(UD, 'text-model.json');
/** 坏端点：连接立刻被拒（不碰真实网络，失败确定性高）。 */
const BAD_BASE_URL = 'http://127.0.0.1:9/';
const TIMEOUT_MS = Number(process.env.HEMI_SELF_RUN_TIMEOUT ?? 240000);

const handler = (channel) => {
  const fn = ipcMain._invokeHandlers?.get(channel)
    ?? ipcMain._handlers?.get?.(channel)
    ?? ipcMain._handlers?.[channel];
  if (typeof fn !== 'function') throw new Error(`找不到 IPC handler：${channel}`);
  return fn;
};

/** 步骤记录：{ step, pass, detail }。 */
const steps = [];
const record = (step, pass, detail = '') => {
  steps.push({ step, pass, detail });
  log.info(`${pass ? '✓' : '✗'} ${step}${detail ? `（${detail}）` : ''}`);
};
const assertStep = (step, condition, detail) => {
  record(step, Boolean(condition), detail ?? String(condition));
  return Boolean(condition);
};

let savedModelConfig = null;

export async function prepareTextScenarios() {
  const micChannel = IPC.permissions.microphoneStatus;
  ipcMain._invokeHandlers?.set?.(micChannel, async () => 'granted');
  ipcMain._handlers?.set?.(micChannel, async () => 'granted');
  // S2 前置：备份真实模型配置并落一个坏端点（bootstrap 只看 hasApiKey，不受影响）。
  savedModelConfig = JSON.parse(fs.readFileSync(MODEL_STORE, 'utf8'));
  fs.writeFileSync(MODEL_STORE, JSON.stringify({ ...savedModelConfig, baseUrl: BAD_BASE_URL }, null, 2));
  log.info(`场景就绪：模型端点暂指坏地址（${BAD_BASE_URL}），S2 修复阶段还原`);
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  const failed = steps.filter((s) => !s.pass);
  console.log(`\nHEMI_TEXT_SCENARIOS_RESULT=${JSON.stringify({ steps, failed: failed.length, exitCode: failed.length ? 1 : 0 })}`);
  try { disposeTaskManager(); } catch { /* 退出路径 */ }
  void shutdownBrowserBridgeService().catch(() => {});
  setTimeout(() => app.exit(failed.length ? 1 : 0), 500);
}

/** 在渲染层执行一段脚本（自动包 async IIFE：顶层 await 合法，返回值经 promise 回传）。 */
const inRenderer = (mainWindow, code) =>
  mainWindow.webContents.executeJavaScript(`(async () => { ${code} })()`, true);

/** 渲染层工具箱：等待、React 受控赋值、点击、键盘分发。 */
const RENDER_TOOLS = `
  window.__sr = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async waitFor(fn, ms = 20000, label = '') {
      const deadline = Date.now() + ms;
      let last;
      while (Date.now() < deadline) {
        last = fn();
        if (last) return last;
        await this.sleep(250);
      }
      throw new Error('waitFor 超时：' + label);
    },
    async setDraft(text) {
      const el = document.querySelector('.text-composer-input');
      if (!el) throw new Error('composer 不在');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      // 等 React 重渲染（受控状态更新是异步的），否则发送按钮还是旧禁用态。
      await this.sleep(180);
    },
    async send() {
      const btn = await this.waitFor(() => {
        const b = document.querySelector('.text-composer-send');
        return b && !b.disabled ? b : null;
      }, 10000, '发送按钮可用');
      btn.click();
      await this.sleep(180);
    },
    draft: () => document.querySelector('.text-composer-input')?.value ?? null,
    key(textarea, init) {
      const el = textarea ?? document.querySelector('.text-composer-input');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
    },
    counts() {
      const turns = [...document.querySelectorAll('.conversation-list .chat-turn')];
      const users = turns.filter((t) => !t.classList.contains('assistant'));
      // 「正在想/回应中」是占位气泡，不算真实回复。
      const assists = turns.filter(
        (t) => t.classList.contains('assistant') && !t.querySelector('.thinking-copy, .streaming-copy'),
      );
      return {
        users: users.length,
        assistants: assists.length,
        lastAssistant: (assists.at(-1)?.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 80),
        thinking: Boolean(document.querySelector('.chat-turn .thinking-copy, .chat-turn .streaming-copy')),
        retryBtn: Boolean(document.querySelector('.btn-retry')),
      };
    },
    clickBy(label) {
      const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent.trim().includes(label));
      if (!btn) throw new Error('按钮未找到：' + label);
      btn.click();
    },
  };
  true;
`;

async function injectTools(mainWindow) {
  await inRenderer(mainWindow, RENDER_TOOLS);
}

export async function runTextScenarios({ mainWindow }) {
  const end = Date.now() + TIMEOUT_MS;
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /error|uncaught/i.test(message)) log.warn(`[renderer] ${message}`);
  });
  const guard = (error) => {
    record('harness 异常', false, String(error?.message ?? error));
    finish();
  };
  try {
    // 页面加载完成再注入（whenReady 时 webContents 可能仍在导航中）。
    for (let i = 0; i < 100 && mainWindow.webContents.isLoadingMainFrame(); i += 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 800));
    await injectTools(mainWindow);
    try {
      await inRenderer(mainWindow, `return window.__sr.waitFor(() => document.querySelector('.text-composer-input'), 30000, 'composer 出现')`);
    } catch (error) {
      const page = await inRenderer(mainWindow, `return (document.querySelector('.setup-shell')?.textContent ?? document.body.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 200)`);
      throw new Error(`composer 未出现，页面状态：${page}`);
    }

    // ---- S1 草稿生命周期（AC-11）----
    const DRAFT = '草稿要跨收起与设置往返';
    await inRenderer(mainWindow, `await window.__sr.setDraft(${JSON.stringify(DRAFT)})`);
    await inRenderer(mainWindow, `window.__sr.clickBy('收起对话')`);
    const collapsedNoComposer = await inRenderer(mainWindow, `return !document.querySelector('.text-composer-input')`);
    assertStep('S1 收起面板后输入区消失', collapsedNoComposer);
    await inRenderer(mainWindow, `window.__sr.clickBy('展开对话')`);
    const draftAfterToggle = await inRenderer(mainWindow, `return window.__sr.draft()`);
    assertStep('S1 重新展开草稿保留', draftAfterToggle === DRAFT, `draft=${JSON.stringify(draftAfterToggle)}`);

    await inRenderer(mainWindow, `window.__sr.clickBy('设置')`);
    const settingsShown = await inRenderer(mainWindow, `return window.__sr.waitFor(() => document.querySelector('.settings-nav'), 8000, '设置页')`).catch(() => false);
    assertStep('S1 进入设置页', Boolean(settingsShown));
    if (settingsShown) {
      await inRenderer(mainWindow, `window.__sr.clickBy('返回主窗口')`);
      await inRenderer(mainWindow, `return window.__sr.waitFor(() => document.querySelector('.text-composer-input'), 8000, '返回主界面')`);
      const draftAfterSettings = await inRenderer(mainWindow, `return window.__sr.draft()`);
      assertStep('S1 进出设置草稿保留', draftAfterSettings === DRAFT, `draft=${JSON.stringify(draftAfterSettings)}`);
    }
    await inRenderer(mainWindow, `window.__sr.clickBy('新建对话')`);
    await inRenderer(mainWindow, `window.__sr.sleep(300)`);
    const draftAfterNew = await inRenderer(mainWindow, `return window.__sr.draft()`);
    assertStep('S1 新建对话清空草稿', draftAfterNew === '', `draft=${JSON.stringify(draftAfterNew)}`);

    // ---- S2 失败与重试（AC-10，坏端点已在 prepare 落盘）----
    const FAIL_TEXT = '这条会失败的话';
    await inRenderer(mainWindow, `await window.__sr.setDraft(${JSON.stringify(FAIL_TEXT)})`);
    const sendDisabled = await inRenderer(mainWindow, `return document.querySelector('.text-composer-send')?.disabled ?? null`);
    await inRenderer(mainWindow, `window.__sr.send()`);
    const failState = await inRenderer(
      mainWindow,
      `return window.__sr.waitFor(() => window.__sr.counts().retryBtn ? window.__sr.counts() : null, 30000, '失败态+重试按钮')`,
    ).catch(async () => {
      const diag = await inRenderer(mainWindow, `return ({
        counts: window.__sr.counts(),
        draft: window.__sr.draft(),
        detail: document.querySelector('.focus-detail')?.textContent ?? null,
        mode: document.querySelector('.mode-label')?.textContent ?? null,
      })`);
      log.warn(`S2 超时诊断：${JSON.stringify(diag)}`);
      return null;
    });
    if (!failState) throw new Error(`S2 未出现失败态（sendDisabled=${sendDisabled}）`);
    assertStep('S2 失败后出现重试入口', failState.retryBtn);
    assertStep('S2 失败原话保留且仅一条', failState.users === 1, `users=${failState.users}`);
    const draftEditableDuringError = await inRenderer(mainWindow, `
      return (async () => {
        await window.__sr.setDraft('失败期间还能写');
        const v = window.__sr.draft();
        await window.__sr.setDraft('');
        return v;
      })()`);
    assertStep('S2 失败期间草稿仍可编辑', draftEditableDuringError === '失败期间还能写');

    // 修复配置：还原真实端点（走正式 saveConfig 处理器，渲染层语义同设置页保存）。
    const saveConfig = handler(IPC.llm.saveConfig);
    await saveConfig({}, {
      baseUrl: savedModelConfig.baseUrl,
      model: savedModelConfig.model,
      ...(savedModelConfig.apiKeyEncrypted ? {} : {}),
    });
    log.info(`模型端点已还原：${savedModelConfig.baseUrl}`);
    await inRenderer(mainWindow, `window.__sr.clickBy('重试')`);
    const retryState = await inRenderer(
      mainWindow,
      `return window.__sr.waitFor(() => { const c = window.__sr.counts(); return c.assistants >= 1 && !c.retryBtn && !c.thinking ? c : null; }, ${Math.min(end - Date.now(), 120000)}, '重试成功（真实回复且不再思考）')`,
    );
    assertStep('S2 重试后获得回复且用户消息不重复', retryState.users === 1 && retryState.lastAssistant.length > 0, `users=${retryState.users} reply=${retryState.lastAssistant}`);
    assertStep('S2 成功后旧重试入口消失', !retryState.retryBtn);

    // ---- S3 键盘语义（AC-03 可自动半）----
    // 上一回合已完全落定（非 thinking）才能演示 Enter 发送——在途时 Enter 被忙碌
    // 守卫拒绝是 S2 的正确行为，不是本步的失败。
    await inRenderer(mainWindow, `await window.__sr.setDraft('1 加 1 等于几？只回答阿拉伯数字')`);
    await inRenderer(mainWindow, `window.__sr.key(document.querySelector('.text-composer-input'))`);
    const enterState = await inRenderer(
      mainWindow,
      `return window.__sr.waitFor(() => { const c = window.__sr.counts(); return c.users === 2 && c.assistants >= 2 ? c : null; }, ${Math.min(end - Date.now(), 120000)}, 'Enter 发送成功')`,
    );
    assertStep('S3 Enter 键路径发送成功', enterState.users === 2, `users=${enterState.users}`);

    await inRenderer(mainWindow, `await window.__sr.setDraft('不该发出的候选确认')`);
    const orbActiveBefore = await inRenderer(mainWindow, `return document.querySelector('.voice-orb-wrap')?.dataset.active ?? 'false'`);
    await inRenderer(mainWindow, `window.__sr.key(document.querySelector('.text-composer-input'), { isComposing: true })`);
    await inRenderer(mainWindow, `window.__sr.sleep(600)`);
    const imeState = await inRenderer(mainWindow, `return ({ ...window.__sr.counts(), draft: window.__sr.draft() })`);
    assertStep('S3 候选确认合成 Enter 不发送', imeState.users === 2 && imeState.draft === '不该发出的候选确认', `users=${imeState.users}`);
    await inRenderer(mainWindow, `
      const el = document.querySelector('.text-composer-input');
      const before = el.value;
      el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }));
      return ({ before })`);
    const orbActiveAfter = await inRenderer(mainWindow, `return document.querySelector('.voice-orb-wrap')?.dataset.active ?? 'false'`);
    // 2026-09-28 裁决后这是回归守护：空格必须彻底回归普通按键，任何窗口内
    // 全局拦截（录音、焦点清抢）都不应再现。
    assertStep('S3 输入区空格不被全局拦截（空格 PTT 已退役）', orbActiveBefore === 'false' && orbActiveAfter === 'false', `orb ${orbActiveBefore}→${orbActiveAfter}`);
    await inRenderer(mainWindow, `await window.__sr.setDraft('')`);

    // ---- S4 可访问性属性（AC-12 可自动半）----
    const a11y = await inRenderer(mainWindow, `return (() => {
      const input = document.querySelector('.text-composer-input');
      const send = document.querySelector('.text-composer-send');
      const desc = document.getElementById('text-composer-desc');
      return {
        inputLabel: input?.getAttribute('aria-label') ?? null,
        describedBy: input?.getAttribute('aria-describedby') ?? null,
        descText: desc?.textContent ?? null,
        sendLabel: send?.getAttribute('aria-label') ?? null,
        sendTitle: send?.getAttribute('title') ?? null,
      };
    })()`);
    assertStep(
      'S4 label/描述/按钮名称齐全',
      a11y.inputLabel === '输入消息'
        && (a11y.describedBy ?? '').includes('text-composer-desc')
        && (a11y.descText ?? '').includes('Shift+Enter')
        && a11y.sendLabel === '发送消息',
      JSON.stringify(a11y),
    );

    // ---- S5 通话混用（AC-09，条件执行：真实 TCC 已授权才跑）----
    let micStatus = systemPreferences.getMediaAccessStatus('microphone');
    if (micStatus !== 'granted') {
      log.info('S5 尝试请求麦克风授权（系统弹窗；不应答则 25s 后跳过）');
      try {
        await Promise.race([
          systemPreferences.askForMediaPermissions(),
          new Promise((r) => setTimeout(() => r('timeout'), 25000)),
        ]);
      } catch { /* 弹窗被拒/超时都继续 */ }
      micStatus = systemPreferences.getMediaAccessStatus('microphone');
    }
    if (micStatus === 'granted') {
      await inRenderer(mainWindow, `window.__sr.clickBy('开始通话')`);
      const callOn = await inRenderer(mainWindow, `return window.__sr.waitFor(() => document.querySelector('.mode-label')?.textContent === '通话中', 15000, '通话接通')`).catch(() => null);
      assertStep('S5 通话接通', Boolean(callOn));
      if (callOn) {
        await inRenderer(mainWindow, `await window.__sr.setDraft('通话里打一句话：只回数字 7')`);
        await inRenderer(mainWindow, `window.__sr.send()`);
        const callReply = await inRenderer(
          mainWindow,
          `return window.__sr.waitFor(() => { const c = window.__sr.counts(); return c.assistants >= 3 ? c : null; }, ${Math.min(end - Date.now(), 120000)}, '通话中回复')`,
        ).catch(() => null);
        assertStep('S5 通话中文字可发送并有回复', Boolean(callReply), callReply ? `reply=${callReply.lastAssistant}` : '超时');
        const stillCall = await inRenderer(mainWindow, `return document.querySelector('.mode-label')?.textContent`);
        assertStep('S5 发送后麦克风仍开启（未挂断）', stillCall === '通话中', `mode=${stillCall}`);
        await inRenderer(mainWindow, `window.__sr.clickBy('结束通话')`);
        const callOff = await inRenderer(mainWindow, `return window.__sr.waitFor(() => document.querySelector('.mode-label')?.textContent !== '通话中', 8000, '挂断')`).catch(() => false);
        assertStep('S5 结束通话', Boolean(callOff));
      }
    } else {
      record('S5 通话混用（跳过：dev 二进制无麦克风 TCC 授权）', false, `mic=${micStatus}，需真机人工`);
    }

    finish();
  } catch (error) {
    guard(error);
  }
}
