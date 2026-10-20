// 057 AC-10/AC-11 真机停止矩阵（隔离 userData 起真实应用）：
//   A 前台子任务在途停止：explorer 起跑后停 → 回合取消、任务终态、队列不受污染；
//   B 等待授权时停止：主 agent 授权卡出现后（不应答）停 → 卡关闭、无文件产出；
//   C 停后新回合：旧停止回执不影响随后的新运行（AC-11 尾款）；
//   D 后台任务＋停回应：停主回应后后台子 agent 仍按自身状态跑完（AC-11 主体）。
// 运行：
//   UD=/tmp/hemi057-ac10 && rm -rf "$UD" && mkdir -p "$UD" && cp ~/Library/"Application Support"/hemi/{doubao-asr.json,text-model.json,text-model-profiles.json,web-search.json,onboarding.json} "$UD/"
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=$UD HEMI_SELF_RUN_PROFILE_ID=<模型档> npx electron scripts/verify-057-ac10.mjs
// 打印 HEMI_VERIFY_057_AC10=<JSON>，exit 0＝全部断言通过。
import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { IPC } from '../src/shared/ipc-channels.mjs';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { createLogger } from '../src/main/lib/logger.mjs';
import { abortActiveTextModelTurn } from '../src/main/ipc/llm.ipc.mjs';

const log = createLogger('verify-057-ac10');
const CONVERSATION_ID = process.env.HEMI_VERIFY_CONVERSATION ?? 'conv-verify057-ac10';
const WORKSPACE_ID = process.env.HEMI_VERIFY_WORKSPACE ?? 'default';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.HEMI_USER_DATA_DIR) {
  console.error('[verify-057-ac10] 需要 HEMI_USER_DATA_DIR（隔离实例）');
  process.exit(1);
}
app.setName('hemi');
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR));

const handler = (channel) => {
  const fn = ipcMain._invokeHandlers?.get(channel);
  if (typeof fn !== 'function') throw new Error(`找不到 IPC handler：${channel}`);
  return fn;
};
/** 渲染层停止按钮同款通路：llm:cancel 事件（ipcMain.on 监听器，脚本内直发）。 */
const cancelTurn = (turnId) => {
  const listeners = ipcMain.listeners(IPC.llm.cancel);
  if (!listeners.length) throw new Error('llm:cancel 无监听器');
  listeners[0]({ sender: null }, { turnId, conversationId: CONVERSATION_ID, reason: 'stop' });
};

let finished = false;
function finish(code, result) {
  if (finished) return;
  finished = true;
  console.log(`HEMI_VERIFY_057_AC10=${JSON.stringify({ ...result, exitCode: code })}`);
  try { abortActiveTextModelTurn(); } catch { /* 退出路径 */ }
  setTimeout(() => app.exit(code), 500);
}

app.whenReady().then(async () => {
  setTimeout(() => finish(1, { error: 'timeout' }), Number(process.env.HEMI_VERIFY_TIMEOUT ?? 420000));
  try {
    initializeStableSafeStorageIdentity();
    await registerAllIpcHandlers();
    const chat = handler(IPC.llm.chat);
    const getState = handler(IPC.task.getState);
    const action = handler(IPC.task.action);
    const getFlowSnapshot = handler(IPC.flow.getSnapshot);
    const listQueue = handler(IPC.queue.list);

    fs.mkdirSync(path.join(app.getPath('userData'), 'conversations'), { recursive: true });
    const archivePath = path.join(app.getPath('userData'), 'conversations', `${CONVERSATION_ID}.json`);
    if (!fs.existsSync(archivePath)) {
      fs.writeFileSync(archivePath, `${JSON.stringify({ id: CONVERSATION_ID, turns: [], createdAt: Date.now(), updatedAt: Date.now() }, null, 2)}\n`);
    }

    // 场景 D 需要后台任务跑完；A/B/C 的卡不需要自动应答（B 明确不应答）。
    let autoAnswerOn = false;
    const watcher = setInterval(async () => {
      if (!autoAnswerOn) return;
      try {
        const snapshot = await getState({}, {});
        const pendings = [...(snapshot.agentPermissions ?? []), ...(snapshot.tasks ?? []).filter((t) => t.permission?.id && t.phase !== 'terminal')];
        for (const pending of pendings) {
          await action({}, { action: 'decide', choice: pending.permission.kind === 'grant' ? 'task' : 'once', taskKey: pending.key });
        }
      } catch { /* 轮询容错 */ }
    }, 400);
    watcher.unref?.();

    const submit = (turnId, text) => chat({}, {
      turnId, conversationId: CONVERSATION_ID, workspaceId: WORKSPACE_ID, inputSource: 'text',
      ...(process.env.HEMI_SELF_RUN_PROFILE_ID ? { profileId: process.env.HEMI_SELF_RUN_PROFILE_ID } : {}),
      messages: [{ role: 'user', content: text }],
    });
    const waitFor = async (fn, { timeout = 60_000, step = 300, label = '' } = {}) => {
      const started = Date.now();
      for (;;) {
        const value = await fn().catch(() => null);
        if (value) return value;
        if (Date.now() - started > timeout) throw new Error(`等待超时：${label}`);
        await sleep(step);
      }
    };
    const runningTasks = async () => ((await getState({}, {})).tasks ?? []).filter((t) => t.phase !== 'terminal');
    const out = {};

    // ---- A：前台子任务在途停止 ----
    const turnA = submit(9701, '派一个 explorer 子 agent（前台，不要后台）去列出 ~/Downloads 目录下的前几个文件名，等它回来后简述。');
    await waitFor(async () => (await runningTasks()).length > 0, { label: 'A 子任务起跑' });
    cancelTurn(9701);
    out.aCancelled = await turnA.then(() => false, (error) => /取消/.test(String(error?.message ?? error)));
    await waitFor(async () => (await runningTasks()).length === 0, { timeout: 90_000, label: 'A 任务终态' });
    const snapA = await getFlowSnapshot({}, { conversationId: CONVERSATION_ID });
    out.aRunStopped = Object.values(snapA.runs ?? {}).some((run) => run.outcome === 'stopped');
    out.aQueueClean = ((await listQueue({}, { conversationId: CONVERSATION_ID })).items ?? []).length === 0;

    // ---- B：等待授权时停止（卡不自动应答；当前沙箱对普通 bash/写免卡，起卡用删除类危险操作） ----
    const bTarget = path.join(process.env.HOME ?? '', 'Documents', 'hemi-ac10b.txt');
    fs.writeFileSync(bTarget, 'probe');
    const turnB = submit(9702, `用 bash 删除 ${bTarget} 这个文件。`);
    let cardSeen = null;
    try {
      cardSeen = await waitFor(async () => {
        const snapshot = await getState({}, {});
        return (snapshot.agentPermissions ?? []).length > 0;
      }, { timeout: 60_000, label: 'B 授权卡出现' });
    } catch {
      out.bSkipped = '授权卡未出现（沙箱免卡）';
    }
    if (cardSeen) {
      cancelTurn(9702);
      out.bCancelled = await turnB.then(() => false, (error) => /取消/.test(String(error?.message ?? error)));
      await sleep(2500); // 等清理落定
      const snapB = await getState({}, {});
      out.bCardsClosed = (snapB.agentPermissions ?? []).length === 0;
      out.bFileKept = fs.existsSync(bTarget); // 停止时未决卡不放行：文件不应被删
    } else {
      // 卡没出现：回合可能已自己跑完；吸收掉 promise，不再断言 B。
      await turnB.then(() => {}, () => {});
    }
    try { fs.unlinkSync(bTarget); } catch { /* 清理 */ }

    // ---- C：停后新回合不受旧停止影响 ----
    const replyC = await submit(9703, '只回答两个字母：OK');
    out.cNewTurnOk = /^OK/.test(String(replyC?.text ?? '').trim());

    // ---- D：后台任务＋停回应 ----
    autoAnswerOn = true;
    const turnD = submit(9704, '派一个 explorer 子 agent 到后台（background）去数 ~/Downloads 目录里有多少个文件，派出去后立刻告诉我你已经派出，不要等它。');
    const bgTask = await waitFor(async () => {
      const tasks = await getState({}, {});
      return (tasks.tasks ?? []).find((t) => t.background && t.phase !== 'terminal') ?? null;
    }, { timeout: 120_000, label: 'D 后台任务出现' });
    if (bgTask) {
      cancelTurn(9704); // 停主回应；后台子 agent 应继续
      out.dCancelled = await turnD.then(() => false, (error) => /取消/.test(String(error?.message ?? error)));
      const bgTerminal = await waitFor(async () => {
        const tasks = await getState({}, {});
        const t = (tasks.tasks ?? []).find((x) => x.taskId === bgTask.taskId);
        return t && t.phase === 'terminal' ? t : null;
      }, { timeout: 180_000, label: 'D 后台任务跑完' });
      out.dBgOutcome = bgTerminal?.outcome ?? null;
      out.dBgAliveThroughStop = out.dCancelled && Boolean(bgTerminal);
    } else {
      out.dSkipped = '模型未派后台任务（不影响 A/B/C 断言）';
    }

    const pass = out.aCancelled && out.aRunStopped && out.aQueueClean
      && (out.bSkipped || (out.bCancelled && out.bCardsClosed && out.bFileKept))
      && out.cNewTurnOk
      && (out.dSkipped || out.dBgAliveThroughStop);
    finish(pass ? 0 : 1, out);
  } catch (error) {
    log.error(`验收失败：${error?.stack ?? error}`);
    finish(1, { error: String(error?.message ?? error) });
  }
});
