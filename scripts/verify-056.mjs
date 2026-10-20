// 056 真机验收驱动：隔离 userData 起真实应用，经 IPC.llm.chat 驱动主 agent，覆盖
//   - restart：两次进程间同一会话续聊（条目落档 agentSession → 重建 → 记得上一轮，且前缀缓存命中）；
//   - steer：主 agent 在途（派前台 explorer）时插话，插话进入同一回合；
//   - queue：主 agent 在途时追加消息 → 入队滞留（isAgentBusy 守卫不抢跑）→
//     首回合收口后自动派发 → 排队消息作为独立回答回来（056 修订的忙时默认语义）；
//   - skills：项目绑定 video 时回答列出 .claude/skills（AC-01）。
// 运行（worktree 根目录）：
//   UD=/tmp/hemi056-verify && rm -rf "$UD" && mkdir -p "$UD" && cp ~/Library/"Application Support"/hemi/{doubao-asr.json,text-model.json,text-model-profiles.json,web-search.json,onboarding.json} "$UD/"
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=$UD HEMI_VERIFY_MODE=restart-1 npx electron scripts/verify-056.mjs
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=$UD HEMI_VERIFY_MODE=restart-2 npx electron scripts/verify-056.mjs
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=$UD HEMI_VERIFY_MODE=steer HEMI_VERIFY_WORKSPACE=<项目 id> npx electron scripts/verify-056.mjs
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=$UD HEMI_VERIFY_MODE=queue HEMI_VERIFY_WORKSPACE=<项目 id> npx electron scripts/verify-056.mjs
// 每种模式打印一行 HEMI_VERIFY_056=<JSON>，exit 0＝该模式断言通过。
import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { IPC } from '../src/shared/ipc-channels.mjs';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { createLogger } from '../src/main/lib/logger.mjs';
import { abortActiveTextModelTurn } from '../src/main/ipc/llm.ipc.mjs';

const log = createLogger('verify-056');
const MODE = process.env.HEMI_VERIFY_MODE ?? 'restart-1';
const CONVERSATION_ID = process.env.HEMI_VERIFY_CONVERSATION ?? 'conv-verify056-a';
const WORKSPACE_ID = process.env.HEMI_VERIFY_WORKSPACE ?? 'default';

// 隔离 userData 必须在 app ready 前设置（与 self-run-task 同口径）。
if (!process.env.HEMI_USER_DATA_DIR) {
  console.error('[verify-056] 需要 HEMI_USER_DATA_DIR（隔离实例）');
  process.exit(1);
}
app.setName('hemi'); // 与正式应用同一 Keychain/storage 身份，拷来的密文可解密
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR));

const handler = (channel) => {
  const fn = ipcMain._invokeHandlers?.get(channel);
  if (typeof fn !== 'function') throw new Error(`找不到 IPC handler：${channel}`);
  return fn;
};
const conversationsDir = () => path.join(app.getPath('userData'), 'conversations');
const archiveOf = () => path.join(conversationsDir(), `${CONVERSATION_ID}.json`);
const hemiLog = () => {
  try { return fs.readFileSync(path.join(app.getPath('userData'), 'hemi.log'), 'utf8'); } catch { return ''; }
};

let finished = false;
function finish(code, result) {
  if (finished) return;
  finished = true;
  console.log(`HEMI_VERIFY_056=${JSON.stringify({ mode: MODE, ...result, exitCode: code })}`);
  try { abortActiveTextModelTurn(); } catch { /* 退出路径 */ }
  setTimeout(() => app.exit(code), 500);
}

app.whenReady().then(async () => {
  setTimeout(() => finish(1, { error: 'timeout' }), Number(process.env.HEMI_VERIFY_TIMEOUT ?? 300000));
  try {
    initializeStableSafeStorageIdentity();
    await registerAllIpcHandlers();
    const chat = handler(IPC.llm.chat);
    // 057 S2：llm:steer 退役，并入走 queue:supplement（steer 模式内取）。
    const getState = handler(IPC.task.getState);
    const action = handler(IPC.task.action);

    // 预置会话档案（主 agent 条目与回答才能落档；重启轮不覆盖）。
    fs.mkdirSync(conversationsDir(), { recursive: true });
    if (!fs.existsSync(archiveOf())) {
      fs.writeFileSync(archiveOf(), `${JSON.stringify({ id: CONVERSATION_ID, turns: [], createdAt: Date.now(), updatedAt: Date.now() }, null, 2)}\n`);
    }
    // 确认卡自动应答（主 agent 与子 agent）。
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
    const archive = () => JSON.parse(fs.readFileSync(archiveOf(), 'utf8'));

    if (MODE === 'restart-1') {
      const reply = await submit(9301, '记住这个暗号：蓝色鲸鱼 42。只回答「记住了」。');
      await new Promise((r) => setTimeout(r, 800));
      const saved = archive();
      const entries = saved.agentSession?.entries?.length ?? 0;
      const replyArchived = (saved.turns ?? []).some((turn) => turn.author === 'hemi' && turn.text === reply.text);
      finish(entries > 0 && replyArchived ? 0 : 1, { reply: reply.text, entries, replyArchived });
      return;
    }

    if (MODE === 'restart-2') {
      const before = archive().agentSession?.entries?.length ?? 0;
      const reply = await submit(9302, '刚才我让你记住的暗号是什么？');
      await new Promise((r) => setTimeout(r, 1000)); // 等 hemi.log 落盘
      const usage = [...hemiLog().matchAll(/turn 9302 第 \d+ 轮 usage 入 (\d+) \/ 出 \d+ tokens（缓存读 (\d+)/g)].map((m) => ({ prompt: Number(m[1]), cacheRead: Number(m[2]) }));
      const remembered = /蓝色鲸鱼/.test(reply.text) && /42/.test(reply.text);
      const firstHit = usage[0] ? usage[0].cacheRead / Math.max(1, usage[0].prompt) : 0;
      finish(before > 0 && remembered ? 0 : 1, { reply: reply.text, entriesBefore: before, remembered, usage, firstRequestCacheHit: Number(firstHit.toFixed(3)) });
      return;
    }

    if (MODE === 'steer') {
      throw new Error('060 已移除队列并入；steer 验证模式已退役，跨重启验证模式不变。');
      // 057 S2：并入走 queue:supplement（控制器 mergeInput——llm:steer 已退役）。
      const supplement = handler(IPC.queue.supplement);
      const listQueue = handler(IPC.queue.list);
      const pending = submit(9401, '派一个 explorer 子 agent（前台，不要后台）去列出当前项目根目录下的文件和文件夹，等它回来后告诉我。');
      // 等子 agent 起跑再并入（主 agent 此时阻塞在 task 工具里）。
      const started = Date.now();
      let steered = null;
      while (Date.now() - started < 60_000) {
        const snapshot = await getState({}, {});
        if ((snapshot.tasks ?? []).some((t) => t.phase !== 'terminal')) {
          steered = await supplement({}, { conversationId: CONVERSATION_ID, text: '补充：回答的最后一行请写「插话已收到」。' });
          break;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      const reply = await pending;
      const snapshot = await getState({}, {});
      const subagents = (snapshot.tasks ?? []).map((t) => `${t.agent}:${t.outcome}`);
      const queueEmpty = ((await listQueue({}, { conversationId: CONVERSATION_ID })).items ?? []).length === 0;
      const honored = /插话已收到/.test(reply.text);
      finish(steered?.ok && honored && queueEmpty ? 0 : 1, { steered, honored, queueEmpty, subagents, replyTail: reply.text.slice(-120) });
      return;
    }

    if (MODE === 'queue') {
      const enqueue = handler(IPC.queue.enqueue);
      const listQueue = handler(IPC.queue.list);
      const pending = submit(9501, '派一个 explorer 子 agent（前台，不要后台）去列出当前项目根目录下的文件和文件夹，等它回来后简单说一下。');
      // 等子 agent 起跑再追加消息（主 agent 此时阻塞在 task 工具里＝在途）。
      const started = Date.now();
      let queued = null;
      while (Date.now() - started < 60_000) {
        const snapshot = await getState({}, {});
        if ((snapshot.tasks ?? []).some((t) => t.phase !== 'terminal')) {
          queued = await enqueue({}, { conversationId: CONVERSATION_ID, text: '追加一条：只回答数字 7，别的都不说。', inputSource: 'text' });
          break;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!queued?.ok) { finish(1, { error: '追加消息没能入队', queued }); return; }
      // 在途守卫：入队瞬间条目必须停 pending（没抢在首回合前派发）。
      const held = await listQueue({}, { conversationId: CONVERSATION_ID });
      const heldPending = held.items.length === 1 && held.items[0].dispatchState === 'pending';
      const firstReply = await pending;
      // 首回合收口后队列应自动派发；轮询档案等第二条回答（只回答数字 7）。
      let queuedReply = '';
      const drainStarted = Date.now();
      while (Date.now() - drainStarted < 120_000) {
        await new Promise((r) => setTimeout(r, 1000));
        const turns = archive().turns ?? [];
        queuedReply = [...turns].reverse().find((turn) => turn.author === 'hemi' && /\b7\b/.test(turn.text))?.text ?? '';
        if (queuedReply) break;
      }
      const drained = await listQueue({}, { conversationId: CONVERSATION_ID });
      finish(heldPending && queuedReply && drained.items.length === 0 ? 0 : 1, {
        heldPending, firstReply: firstReply.text.slice(0, 80), queuedReply: queuedReply.slice(0, 80),
        queueLeft: drained.items.length,
      });
      return;
    }

    finish(1, { error: `未知模式 ${MODE}` });
  } catch (error) {
    log.error(`验收失败：${error?.stack ?? error}`);
    finish(1, { error: String(error?.message ?? error) });
  }
});
