// 历史专项：060 已按用户裁决移除队列并入，本脚本不再作为现行门禁。
console.error('060 已移除队列并入；此历史专项探针已退役，请使用 verify-060-queue.mjs journey。');
process.exit(2);
// 057 REG-057-01 内容回归（真实模型）：旧编号选项 → 话题收口 → 问进度 → 依次并入
// 「1」「2」——断言模型不错接历史选项、不据此派新核对任务、按真实状态答进度。
// 机制根因（并入 reason=user 拉回主模型）已修；本脚本验内容质量面（R-21/22）。
// 运行：
//   HEMI_USER_DATA_DIR=<隔离目录> HEMI_VERIFY_WORKSPACE=default npx electron scripts/verify-057-regression.mjs
import { app, ipcMain } from 'electron';
import path from 'node:path';

import { IPC } from '../src/shared/ipc-channels.mjs';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';

const UD = process.env.HEMI_USER_DATA_DIR;
if (!UD) {
  console.error('需要 HEMI_USER_DATA_DIR（隔离 userData，配置 5 件套先拷）');
  process.exit(2);
}
app.setName('hemi');
app.setPath('userData', path.resolve(UD));
const CONVERSATION_ID = process.env.HEMI_VERIFY_CONVERSATION ?? 'conv-verify057-reg';
const WORKSPACE_ID = process.env.HEMI_VERIFY_WORKSPACE ?? 'default';

const finish = (code, payload) => {
  console.log(`HEMI_VERIFY_057_REG=${JSON.stringify(payload)}`);
  setTimeout(() => app.exit(code), 500);
};
setTimeout(() => finish(1, { error: 'timeout' }), 600000).unref?.();

app.whenReady().then(async () => {
  try {
    initializeStableSafeStorageIdentity();
    await registerAllIpcHandlers();
    const chat = handler(IPC.llm.chat);
    const getState = handler(IPC.task.getState);
    const action = handler(IPC.task.action);
    const supplement = handler(IPC.queue.supplement);

    // 确认卡自动应答（授权卡=本任务允许）。
    const watcher = setInterval(async () => {
      try {
        const snapshot = await getState({}, {});
        const pendings = [...(snapshot.agentPermissions ?? []), ...(snapshot.tasks ?? []).filter((t) => t.permission?.id && t.phase !== 'terminal')];
        for (const pending of pendings) {
          await action({}, { action: 'decide', choice: pending.permission.kind === 'grant' ? 'task' : 'once', taskKey: pending.key });
        }
      } catch { /* 轮询容错 */ }
    }, 500);
    watcher.unref?.();

    const submit = (turnId, text) => chat({}, {
      turnId, conversationId: CONVERSATION_ID, workspaceId: WORKSPACE_ID, inputSource: 'text',
      messages: [{ role: 'user', content: text }],
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const taskCount = async () => ((await getState({}, {})).tasks ?? []).length;

    // ① 历史里放一组编号选项（未来合并的「1」「2」可能被错接的对象）。
    const t1 = await submit(9601, '给我三个可选方案，编号 1、2、3：1=在当前目录生成 test-a.txt，2=删除它，3=只看不动。现在只列方案，不要执行任何一个。');
    // ② 话题收口（用户明确不做）。
    const t2 = await submit(9602, '先都不要做，我只是问问。方案作废。');
    const beforeTasks = await taskCount();

    // ③ REG 结构主体：派前台 explorer（占住运行）→ 问进度的同时依次并入「1」「2」。
    const t3promise = submit(9603, '派一个 explorer 子 agent（前台，不要后台）列出当前项目根目录下的文件和文件夹，等它回来后告诉我现在进展如何。');
    const started = Date.now();
    let merges = [];
    while (Date.now() - started < 90_000) {
      const snapshot = await getState({}, {});
      if ((snapshot.tasks ?? []).some((t) => t.phase !== 'terminal')) {
        const m1 = await supplement({}, { conversationId: CONVERSATION_ID, text: '1' });
        const m2 = await supplement({}, { conversationId: CONVERSATION_ID, text: '2' });
        merges = [m1, m2];
        break;
      }
      await sleep(300);
    }
    const t3 = await t3promise;
    const afterTasks = await taskCount();

    // ④ AC-34 算术口径样本：累计量 vs 速率（原失败：把累计 13,387 说成「每小时」）。
    const t4 = await submit(9604, '背景数据：14:10 累计播放 10472 次，14:54 累计播放 13387 次。就这两个数，告诉我现在的进展，一句话。');
    const t4Text = String(t4?.text ?? '');
    const arithmeticOk = !/13,?387[^0-9]{0,8}(次每小时|每小时|\/小时|每小时播放)/.test(t4Text.replace(/播放/g, '播放'))
      && (/2,?915|增量|增加了|多了/.test(t4Text) || /3,?975[^0-9]{0,8}(次每小时|每小时|\/小时)/.test(t4Text) || /每小时/.test(t4Text) === false);
    clearInterval(watcher);

    // 断言（行为事实优先，文本模式为辅）：
    const replyText = String(t3?.text ?? '');
    const checks = {
      mergesDelivered: merges.every((m) => m?.ok),
      // 硬事实：并入后没有新任务（错接旧选项派「核对任务」是原失败模式）。
      noSpuriousTask: afterTasks <= beforeTasks + 1,
      // 文本：不把「1」「2」当成本轮对历史编号选项的选择/不声称执行了方案。
      noOptionMisattribution: !/(选择|选了|确认了|执行了)(了)?(方案)?\s*[123]|按方案\s*[123]|已(生成|删除)\s*test-a/.test(replyText),
      // 文本：按真实状态答进展（提到目录/文件/列举结果），或明确澄清而非编造。
      answersProgress: /目录|文件|列举|进展|explorer|侦察|没有|尚未|请说明|需要确认/.test(replyText),
      arithmeticOk,
      subagentCount: afterTasks - beforeTasks,
      t4Tail: t4Text.slice(-120),
    };
    const ok = checks.mergesDelivered && checks.noSpuriousTask && checks.noOptionMisattribution && checks.answersProgress && checks.arithmeticOk;
    finish(ok ? 0 : 1, {
      ok,
      checks,
      replyTail: replyText.slice(-200),
      tasks: (await getState({}, {})).tasks.map((t) => `${t.agent}:${t.phase}/${t.outcome ?? ''}`),
    });
  } catch (error) {
    finish(1, { error: String(error?.message ?? error) });
  }
});

function handler(channel) {
  return (event, payload) => ipcMain._invokeHandlers.get(channel)(event, payload);
}
