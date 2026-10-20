// 057 AC-05 真机验收：语音定稿在忙时追加（inputSource='voice' 走真实 queue:enqueue
// 通路）→ 队列单行滞留 → 首回合收口后派发 → 独立回答；档案/flow 时间线各文本仅
// 一条用户项（无重复气泡）；重启后（reload 模式）重读档案与快照计数不变。
// 运行（worktree 根目录）：
//   UD=/tmp/hemi057-ac05 && rm -rf "$UD" && mkdir -p "$UD" && cp ~/Library/"Application Support"/hemi/{doubao-asr.json,text-model.json,text-model-profiles.json,web-search.json,onboarding.json} "$UD/"
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=$UD HEMI_VERIFY_MODE=voice npx electron scripts/verify-057-ac05.mjs
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=$UD HEMI_VERIFY_MODE=reload npx electron scripts/verify-057-ac05.mjs
// 每模式打印一行 HEMI_VERIFY_057_AC05=<JSON>，exit 0＝断言通过。
import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { IPC } from '../src/shared/ipc-channels.mjs';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { createLogger } from '../src/main/lib/logger.mjs';
import { abortActiveTextModelTurn } from '../src/main/ipc/llm.ipc.mjs';

const log = createLogger('verify-057-ac05');
const MODE = process.env.HEMI_VERIFY_MODE ?? 'voice';
const CONVERSATION_ID = process.env.HEMI_VERIFY_CONVERSATION ?? 'conv-verify057-ac05';
const WORKSPACE_ID = process.env.HEMI_VERIFY_WORKSPACE ?? 'default';
const FIRST_TASK = '派一个 explorer 子 agent（前台，不要后台）去列出当前项目根目录下的文件和文件夹，等它回来后简单说一下。';
const VOICE_TEXT = '追加一条：只回答数字 7，别的都不说。';

if (!process.env.HEMI_USER_DATA_DIR) {
  console.error('[verify-057-ac05] 需要 HEMI_USER_DATA_DIR（隔离实例）');
  process.exit(1);
}
app.setName('hemi');
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR));

const handler = (channel) => {
  const fn = ipcMain._invokeHandlers?.get(channel);
  if (typeof fn !== 'function') throw new Error(`找不到 IPC handler：${channel}`);
  return fn;
};
const conversationsDir = () => path.join(app.getPath('userData'), 'conversations');
const archiveOf = () => path.join(conversationsDir(), `${CONVERSATION_ID}.json`);
const readArchive = () => {
  try { return JSON.parse(fs.readFileSync(archiveOf(), 'utf8')); } catch { return null; }
};
/** 档案三面计数：turns 用户轮、flow 用户项、SDK 会话条目里某文本的出现次数。
 *  sdk!=1 ＝首回合种子双写回归（2026-10-15 真机钓出：persistUserTurn 先于 obtain 落档）。 */
const countUserText = (archive, text) => {
  const inTurns = (archive?.turns ?? []).filter((t) => t.author === 'user' && (t.text ?? '').includes(text)).length;
  const flowInputs = (archive?.flow?.timeline ?? []).filter((item) => item.kind === 'user' && (item.text ?? '').includes(text)).length;
  const sdkUsers = ((archive?.agentSession?.entries ?? [])
    .filter((e) => e?.message?.role === 'user')
    .map((e) => {
      const c = e.message.content;
      return typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(' ') : '');
    })
    .filter((body) => body.includes(text))).length;
  return { inTurns, flowInputs, sdkUsers };
};

let finished = false;
function finish(code, result) {
  if (finished) return;
  finished = true;
  console.log(`HEMI_VERIFY_057_AC05=${JSON.stringify({ mode: MODE, ...result, exitCode: code })}`);
  try { abortActiveTextModelTurn(); } catch { /* 退出路径 */ }
  setTimeout(() => app.exit(code), 500);
}

app.whenReady().then(async () => {
  setTimeout(() => finish(1, { error: 'timeout' }), Number(process.env.HEMI_VERIFY_TIMEOUT ?? 300000));
  try {
    initializeStableSafeStorageIdentity();
    await registerAllIpcHandlers();
    const chat = handler(IPC.llm.chat);
    const getState = handler(IPC.task.getState);
    const action = handler(IPC.task.action);
    const enqueue = handler(IPC.queue.enqueue);
    const listQueue = handler(IPC.queue.list);
    const getFlowSnapshot = handler(IPC.flow.getSnapshot);

    fs.mkdirSync(conversationsDir(), { recursive: true });
    if (!fs.existsSync(archiveOf())) {
      fs.writeFileSync(archiveOf(), `${JSON.stringify({ id: CONVERSATION_ID, turns: [], createdAt: Date.now(), updatedAt: Date.now() }, null, 2)}\n`);
    }
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

    if (MODE === 'reload') {
      // 重启后接回：档案在、计数仍为 1，flow 快照经服务端重读后同样无重复。
      const archive = readArchive();
      const voice = countUserText(archive, VOICE_TEXT);
      const first = countUserText(archive, FIRST_TASK.slice(0, 12));
      const snapshot = await getFlowSnapshot({}, { conversationId: CONVERSATION_ID });
      const snapVoice = (snapshot?.timeline ?? []).filter((item) => item.kind === 'user' && (item.text ?? '').includes(VOICE_TEXT)).length;
      const snapFirst = (snapshot?.timeline ?? []).filter((item) => item.kind === 'user' && (item.text ?? '').includes(FIRST_TASK.slice(0, 12))).length;
      const queueNow = await listQueue({}, { conversationId: CONVERSATION_ID });
      finish(voice.inTurns === 1 && voice.flowInputs === 1 && voice.sdkUsers === 1 && first.inTurns === 1 && first.flowInputs === 1 && first.sdkUsers === 1 && snapVoice === 1 && snapFirst === 1 && queueNow.items.length === 0 ? 0 : 1, {
        voice, first, snapVoice, snapFirst, queueLeft: queueNow.items.length,
      });
      return;
    }

    // ---- voice 模式：忙时语音定稿追加 ----
    const pending = chat({}, {
      turnId: 9601, conversationId: CONVERSATION_ID, workspaceId: WORKSPACE_ID, inputSource: 'text',
      messages: [{ role: 'user', content: FIRST_TASK }],
    });
    const started = Date.now();
    let queued = null;
    while (Date.now() - started < 60_000) {
      const snapshot = await getState({}, {});
      if ((snapshot.tasks ?? []).some((t) => t.phase !== 'terminal')) {
        queued = await enqueue({}, { conversationId: CONVERSATION_ID, text: VOICE_TEXT, inputSource: 'voice' });
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!queued?.ok) { finish(1, { error: '语音追加没能入队', queued }); return; }
    const held = await listQueue({}, { conversationId: CONVERSATION_ID });
    // 队列单行：恰一条、pending、inputSource 是 voice。
    const heldOk = held.items.length === 1 && held.items[0].dispatchState === 'pending' && held.items[0].inputSource === 'voice';
    const firstReply = await pending;
    // 首回合收口后自动派发：等「只回答数字 7」的独立回答落档。
    let queuedReply = '';
    const drainStarted = Date.now();
    while (Date.now() - drainStarted < 120_000) {
      await new Promise((r) => setTimeout(r, 1000));
      const turns = readArchive()?.turns ?? [];
      queuedReply = [...turns].reverse().find((turn) => turn.author === 'hemi' && /\b7\b/.test(turn.text))?.text ?? '';
      if (queuedReply) break;
    }
    await new Promise((r) => setTimeout(r, 1200)); // 等 flow 落盘稳定
    const archive = readArchive();
    const voice = countUserText(archive, VOICE_TEXT);
    const first = countUserText(archive, FIRST_TASK.slice(0, 12));
    const drained = await listQueue({}, { conversationId: CONVERSATION_ID });
    finish(heldOk && queuedReply && drained.items.length === 0
      && voice.inTurns === 1 && voice.flowInputs === 1 && voice.sdkUsers === 1
      && first.inTurns === 1 && first.flowInputs === 1 && first.sdkUsers === 1 ? 0 : 1, {
      heldOk, queued: held.items[0], firstReply: firstReply.text.slice(0, 80), queuedReply: queuedReply.slice(0, 80),
      voice, first, queueLeft: drained.items.length,
    });
  } catch (error) {
    log.error(`验收失败：${error?.stack ?? error}`);
    finish(1, { error: String(error?.message ?? error) });
  }
});
