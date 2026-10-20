// 057 AC-19 部分交付样本：多文件逐个声明交付的 fixer 任务，首个交付落地即停止——
// 已交付子集进 flow.artifacts/任务档案、未交付不虚构、停止后文件仍在盘上可打开。
// 运行：
//   UD=/tmp/hemi057-ac19b && rm -rf "$UD" /tmp/hemi-ac19b && mkdir -p "$UD" && cp ~/Library/"Application Support"/hemi/{doubao-asr.json,text-model.json,text-model-profiles.json,web-search.json,onboarding.json} "$UD/"
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=$UD npx electron scripts/verify-057-ac19b.mjs
// 打印 HEMI_VERIFY_057_AC19B=<JSON>，exit 0＝断言通过。
import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { IPC } from '../src/shared/ipc-channels.mjs';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { createLogger } from '../src/main/lib/logger.mjs';
import { abortActiveTextModelTurn } from '../src/main/ipc/llm.ipc.mjs';

const log = createLogger('verify-057-ac19b');
const CONVERSATION_ID = 'conv-ac19b';
const DIR = '/tmp/hemi-ac19b';
const PROFILE = process.env.HEMI_SELF_RUN_PROFILE_ID ?? 'mp-muxxaz5x-s2frgd/m-new-muxxaz5x-0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.HEMI_USER_DATA_DIR) {
  console.error('[verify-057-ac19b] 需要 HEMI_USER_DATA_DIR（隔离实例）');
  process.exit(1);
}
app.setName('hemi');
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR));

const handler = (channel) => {
  const fn = ipcMain._invokeHandlers?.get(channel);
  if (typeof fn !== 'function') throw new Error(`找不到 IPC handler：${channel}`);
  return fn;
};
const cancelTurn = (turnId) => {
  const listeners = ipcMain.listeners(IPC.llm.cancel);
  if (!listeners.length) throw new Error('llm:cancel 无监听器');
  listeners[0]({ sender: null }, { turnId, conversationId: CONVERSATION_ID, reason: 'stop' });
};

let finished = false;
function finish(code, result) {
  if (finished) return;
  finished = true;
  console.log(`HEMI_VERIFY_057_AC19B=${JSON.stringify({ ...result, exitCode: code })}`);
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

    fs.mkdirSync(path.join(app.getPath('userData'), 'conversations'), { recursive: true });
    const archiveOf = path.join(app.getPath('userData'), 'conversations', `${CONVERSATION_ID}.json`);
    if (!fs.existsSync(archiveOf)) {
      fs.writeFileSync(archiveOf, `${JSON.stringify({ id: CONVERSATION_ID, turns: [], createdAt: Date.now(), updatedAt: Date.now() }, null, 2)}\n`);
    }
    const watcher = setInterval(async () => {
      try {
        const snapshot = await getState({}, {});
        const pendings = [...(snapshot.agentPermissions ?? []), ...(snapshot.tasks ?? []).filter((t) => t.permission?.id && t.phase !== 'terminal')];
        for (const pending of pendings) {
          await action({}, { action: 'decide', choice: pending.permission.kind === 'grant' ? 'task' : 'once', taskKey: pending.key });
        }
      } catch { /* 轮询容错 */ }
    }, 400);
    watcher.unref?.();

    const taskText = `派一个 fixer 子 agent（前台，不要后台）逐个完成下面五个文件，每做完一个就立刻调用 register_delivery 声明这一个，再做下一个（不要攒到最后一起声明）：在 ${DIR} 目录创建 f1.txt 到 f5.txt，内容分别写 60 行、每行「文件 N 第 M 行」（N 为文件编号）。你自己不要动手也不要声明。`;
    const pendingTurn = chat({}, {
      turnId: 9801, conversationId: CONVERSATION_ID, workspaceId: 'default', inputSource: 'text', profileId: PROFILE,
      messages: [{ role: 'user', content: taskText }],
    });

    // 等首个交付落地（任务 artifacts ≥1 且未终态）即停。
    const started = Date.now();
    let firstDeliveryAt = null;
    let taskSnap = null;
    while (Date.now() - started < 240_000) {
      const snapshot = await getState({}, {});
      taskSnap = (snapshot.tasks ?? []).find((t) => (t.artifacts ?? []).length >= 1 && t.phase !== 'terminal') ?? null;
      if (taskSnap) { firstDeliveryAt = Date.now(); break; }
      await sleep(300);
    }
    const out = { firstDeliverySeen: Boolean(firstDeliveryAt) };
    if (!firstDeliveryAt) {
      const early = await Promise.race([pendingTurn.then(() => 'settled'), sleep(5000).then(() => 'still-running')]);
      out.error = early === 'settled' ? '任务在首个交付可观察前就结束了（模型未逐个声明或太快）' : '240s 内未见首个交付';
      finish(1, out);
      return;
    }
    out.firstDelivery = (taskSnap.artifacts ?? []).map((a) => a.name);
    cancelTurn(9801);
    out.turnCancelled = await pendingTurn.then(() => false, (error) => /取消/.test(String(error?.message ?? error)));

    // 等任务终态。
    const deadline = Date.now() + 120_000;
    for (;;) {
      const snapshot = await getState({}, {});
      taskSnap = (snapshot.tasks ?? []).find((t) => t.taskId === taskSnap.taskId) ?? taskSnap;
      if (taskSnap.phase === 'terminal') break;
      if (Date.now() > deadline) break;
      await sleep(400);
    }
    out.taskOutcome = taskSnap.outcome;

    // 已交付子集的表达：任务档案 deliverables / flow.artifacts / 盘上文件。
    const record = handler(IPC.task.getState) ? null : null;
    const histHandler = ipcMain._invokeHandlers?.get(IPC.task.historyRecord) ?? null;
    const flow = await getFlowSnapshot({}, { conversationId: CONVERSATION_ID });
    const flowArtifacts = Object.values(flow?.artifacts ?? {}).map((a) => ({ name: a.name, path: a.path, v: a.contentVersion }));
    const flowTask = Object.values(flow?.tasks ?? {}).find((t) => t.taskId === taskSnap.taskId);
    out.flowArtifacts = flowArtifacts;
    out.taskArtifacts = (taskSnap.artifacts ?? []).map((a) => a.name);
    out.flowTaskArtifacts = (flowTask?.artifacts ?? []).map((a) => a.path ?? a.name);
    out.filesOnDisk = fs.existsSync(DIR) ? fs.readdirSync(DIR).sort() : [];
    // 断言：交付过的文件在盘上（停止后仍可打开）；未声明的文件不进 artifacts。
    const declared = new Set(out.taskArtifacts);
    out.declaredFilesOnDisk = [...declared].every((name) => out.filesOnDisk.includes(name));
    out.undeliveredNotClaimed = out.taskArtifacts.length >= 1 && out.taskArtifacts.length < 5;
    out.stoppedPartial = out.taskOutcome === 'stopped' && out.undeliveredNotClaimed;
    finish(out.stoppedPartial && out.declaredFilesOnDisk && out.turnCancelled ? 0 : 1, out);
  } catch (error) {
    log.error(`验收失败：${error?.stack ?? error}`);
    finish(1, { error: String(error?.message ?? error) });
  }
});
