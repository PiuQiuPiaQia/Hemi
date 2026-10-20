// 024 自驱动文字入口验收：起完整真实应用（含 renderer），从真实 textarea 填入
// 文本并点击发送，跑完 文字回合 → LLM → execute_task → 门控确认卡 → 任务终态 →
// 交代 的全链路。证据口径（AC-04/07/10）：
//   - 用户消息恰好入列一次（文字不经过 ASR，无 utterance 修订）；
//   - 任务快照 inputSource === 'text'（文字任务全链路静音的事实来源）；
//   - tts:speak 调用数 === 0（受理语/授权提醒/阶段简报/终态交代全部静音）。
// 确认卡按卡种自动应答（授权卡＝本任务允许、风险卡＝允许这次）；全部证据收齐后打印 JSON 并退出（exit 0 = 通过）。
//
// 运行（主工作区根目录，配置从真实 userData 拷贝——safeStorage 同机可解密）：
//   UD=/tmp/hemi-text-ud && rm -rf "$UD" && mkdir -p "$UD"
//   cp ~/Library/"Application Support"/hemi/{doubao-asr.json,text-model.json} "$UD/"
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR="$UD" \
//   HEMI_SELF_RUN_TEXT='在 /tmp/hemi-text-selfrun 目录创建 hello.txt，内容写：024 文字自测' \
//   npx electron .
import { app, ipcMain } from 'electron';

import { IPC } from '../shared/ipc-channels.mjs';
import { createLogger } from './lib/logger.mjs';
import { disposeTaskManager } from './ipc/task.ipc.mjs';
import { shutdownBrowserBridgeService } from './services/browser-bridge-service.mjs';

const log = createLogger('selfrun-text');
const TASK_TEXT = process.env.HEMI_SELF_RUN_TEXT
  ?? '在 /tmp/hemi-text-selfrun 目录创建 hello.txt，内容写：024 文字自测';
const TIMEOUT_MS = Number(process.env.HEMI_SELF_RUN_TIMEOUT ?? 300000);

/** 本轮 tts:speak 调用记录（验收要求为空数组）。 */
let ttsCalls = [];

const handler = (channel) => {
  const fn = ipcMain._invokeHandlers?.get(channel)
    ?? ipcMain._handlers?.get?.(channel)
    ?? ipcMain._handlers?.[channel];
  if (typeof fn !== 'function') throw new Error(`找不到 IPC handler：${channel}`);
  return fn;
};

/**
 * 窗口加载前完成的环境整形（必须在 registerAllIpcHandlers 之后、
 * createMainWindow 之前调用）：
 * - 麦克风状态包装为 granted：隔离实例拿不到系统授权会把渲染层锁在
 *   SetupScreen——文字入口本就不依赖麦克风（R-12），这里只为通过启动判定；
 * - 包装 tts:speak 计数（contextIsolation 下渲染层不可注入，主进程是唯一采样点）。
 */
export async function prepareTextSelfRun() {

  const micChannel = IPC.permissions.microphoneStatus;
  const originalMic = handler(micChannel);
  ipcMain._invokeHandlers?.set?.(micChannel, async () => 'granted');
  ipcMain._handlers?.set?.(micChannel, async () => 'granted');
  void originalMic;

  const ttsChannel = IPC.tts.speak;
  const originalTts = handler(ttsChannel);
  const wrappedTts = (event, payload) => {
    ttsCalls.push({ turnId: payload?.turnId, text: String(payload?.text ?? '').slice(0, 40) });
    return originalTts(event, payload);
  };
  ipcMain._invokeHandlers?.set?.(ttsChannel, wrappedTts);
  ipcMain._handlers?.set?.(ttsChannel, wrappedTts);

  log.info(`文字自驱动就绪，将注入：「${TASK_TEXT}」`);
}

let finished = false;
function finish(code, result) {
  if (finished) return;
  finished = true;
  console.log(`\nHEMI_TEXT_SELF_RUN_RESULT=${JSON.stringify({ ...result, exitCode: code })}`);
  try { disposeTaskManager(); } catch { /* 退出路径 */ }
  void shutdownBrowserBridgeService().catch(() => {});
  setTimeout(() => app.exit(code), 500);
}

/** 在渲染层执行一段自包含异步脚本（返回值必须可结构化克隆）。 */
async function inRenderer(mainWindow, code) {
  return mainWindow.webContents.executeJavaScript(code, true);
}

/** 等待 composer 出现（bootstrap 完成 + 展开面板 + 模型已配置三关全过）。 */
async function waitForComposer(mainWindow) {
  return inRenderer(
    mainWindow,
    `(async () => {
      const deadline = Date.now() + 30000;
      let setupText = null;
      while (Date.now() < deadline) {
        if (document.querySelector('.text-composer-input')) return true;
        const setup = document.querySelector('.setup-shell');
        if (setup) setupText = (setup.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 160);
        await new Promise((r) => setTimeout(r, 300));
      }
      return { error: '30s 内未见 .text-composer-input', setupText };
    })()`,
  );
}

/** 填草稿（React 受控组件：原生 value setter + input 事件）并点击发送。 */
async function submitViaComposer(mainWindow, text) {
  return inRenderer(
    mainWindow,
    `(async () => {
      const el = document.querySelector('.text-composer-input');
      if (!el) return { error: 'composer 不在' };
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      const btn = document.querySelector('.text-composer-send');
      if (!btn) return { error: '发送按钮不在' };
      if (btn.disabled) return { error: '发送按钮禁用（忙碌/待提交语音/模型未配置）', draft: el.value };
      btn.click();
      await new Promise((r) => setTimeout(r, 200));
      return { clicked: true, draftAfter: document.querySelector('.text-composer-input')?.value ?? '' };
    })()`,
  );
}

/** 从真实 DOM 收集证据：用户消息计数、助手回复、草稿残留。 */
function evidenceScript(text) {
  return `(() => {
    const turns = [...document.querySelectorAll('.conversation-list .chat-turn')];
    const userMsgs = turns.filter((t) => !t.classList.contains('assistant'));
    const assistants = turns.filter((t) => t.classList.contains('assistant'));
    const composer = document.querySelector('.text-composer-input');
    return {
      userTotal: userMsgs.length,
      userMatch: userMsgs.filter((t) => t.textContent.includes(${JSON.stringify(text.slice(0, 18))})).length,
      assistantCount: assistants.length,
      lastAssistant: (assistants.at(-1)?.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 120),
      draftLeft: composer?.value ?? null,
    };
  })()`;
}

export async function runTextSelfRun({ mainWindow }) {
  const result = {
    taskText: TASK_TEXT,
    submitted: false,
    userMatch: 0,
    assistantCount: 0,
    taskOutcome: null,
    taskInputSource: null,
    taskResult: null,
    ttsCallCount: -1,
    errors: [],
  };
  try {
    // 页面加载完成再驱动（whenReady 时 webContents 可能仍在导航中）。
    for (let i = 0; i < 100 && mainWindow.webContents.isLoadingMainFrame(); i += 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 800));
    const ready = await waitForComposer(mainWindow);
    if (ready !== true) throw new Error(ready?.error ?? 'composer 未就绪');

    const submit = await submitViaComposer(mainWindow, TASK_TEXT);
    if (submit?.error) throw new Error(`提交失败：${submit.error}（草稿：${submit.draft ?? ''}）`);
    result.submitted = true;
    log.info('文字已通过真实 composer 提交，等待 LLM → 任务链');

    // 轮询：权限卡自动应答；任务终态后收证。
    const getState = handler(IPC.task.getState);
    const action = handler(IPC.task.action);
    const deadline = Date.now() + TIMEOUT_MS;
    let settled = false;
    while (!settled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const snapshot = await getState({}, {});
      const tasks = snapshot?.tasks ?? [];
      for (const pending of tasks.filter((t) => t.phase !== 'terminal' && t.permission?.id)) {
        // 042：授权卡（grant）→ 本任务允许；风险卡（action）→ 允许这次。
        const choice = pending.permission.kind === 'grant' ? 'task' : 'once';
        log.info(`确认卡出现 → 自动应答：${choice}（${pending.key}）`);
        await action({}, { action: 'decide', choice, taskKey: pending.key });
      }
      const done = tasks.filter((t) => t.phase === 'terminal');
      if (tasks.length && done.length === tasks.length) {
        settled = true;
        const main = tasks.find((t) => TASK_TEXT.slice(0, 18).includes(t.taskText.slice(0, 6)) || t.taskText.includes('hello.txt') || t.taskText.includes('024')) ?? done[0];
        result.taskOutcome = main.outcome;
        result.taskInputSource = main.inputSource ?? null;
        result.taskResult = (main.resultText ?? '').slice(0, 120);
      }
    }
    if (!settled) throw new Error('任务未在超时内到达终态');

    // DOM 证据 + TTS 计数（终态后的简报/交代都计入窗口后才定论）。
    await new Promise((r) => setTimeout(r, 1500));
    const evidence = await inRenderer(mainWindow, evidenceScript(TASK_TEXT));
    Object.assign(result, evidence);
    result.ttsCallCount = ttsCalls.length;
    if (ttsCalls.length) result.ttsCalls = ttsCalls;

    const pass = result.submitted
      && result.userMatch === 1
      && result.assistantCount >= 1
      && result.taskOutcome === 'complete'
      && result.taskInputSource === 'text'
      && result.ttsCallCount === 0;
    finish(pass ? 0 : 1, result);
  } catch (error) {
    result.errors.push(String(error?.message ?? error));
    finish(1, result);
  }
}
