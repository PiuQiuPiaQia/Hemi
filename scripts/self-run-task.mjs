// 023 真机自驱动验收 harness：隔离 userData 起真实应用，从 ASR 定稿的同一入口
// （IPC.llm.chat）注入一句话，真实跑完 主 agent（056：自己动手或派子 agent）→
// 门控确认卡 → 回答 的全链路。主 agent 与子 agent 的确认卡都自动应答（授权卡＝
// 本任务允许、风险卡＝允许这次）；回合返回且子 agent 全部终态后退出（exit 0＝
// 回合成功且没有失败的子 agent）。
// 打印一行 HEMI_SELF_RUN_RESULT JSON：回答全文、本回合工具名、子 agent 结局。
//
// 运行（主工作区根目录）：
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=/tmp/hemi-selfrun-ud \
//   HEMI_SELF_RUN_TASK='在 /tmp/hemi-selfrun-test 目录创建 hello.txt，内容写：023 真机自测' \
//   npx electron scripts/self-run-task.mjs
//
// 050 顺序多回合脚本模式（回归样例 G-1～G-6）：
//   HEMI_SELF_RUN_SCRIPT='["调研…","这些网站的域名列一下","再核实一下某项"]' \
//   …同上环境变量
// 逐回合注入、等本轮全部任务终态后再发下一句；每回合统计 execute_task 次数
// （＝本轮新建任务数）、浏览器/web 调用次数、正文首句与标记残留，结束时打印
// 一行 HEMI_SELF_RUN_SCRIPT_RESULT JSON（供验收脚本断言）。
import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { IPC } from '../src/shared/ipc-channels.mjs';
import {
  initializeStableSafeStorageIdentity,
  readStoredConfig,
  saveStoredConfig,
} from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { createLogger } from '../src/main/lib/logger.mjs';
import { disposeTaskManager } from '../src/main/ipc/task.ipc.mjs';
import { shutdownBrowserBridgeService } from '../src/main/services/browser-bridge-service.mjs';

const TASK_TEXT = process.env.HEMI_SELF_RUN_TASK
  ?? '在 /tmp/hemi-selfrun-test 目录里创建 hello.txt，内容写：023 真机自测';
/** HEMI_SELF_RUN_TASKS='任务1|||任务2'：并发注入多条 ASR 定稿（AC-14 双浏览器任务）。 */
const TASK_BATCH = (process.env.HEMI_SELF_RUN_TASKS ?? '')
  .split('|||').map((t) => t.trim()).filter(Boolean);
/** 050：顺序多回合脚本（JSON 字符串数组；优先于单任务/并发模式）。 */
const SCRIPT_TURNS = (() => {
  const raw = process.env.HEMI_SELF_RUN_SCRIPT;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'string' && t.trim())) {
      return parsed.map((t) => t.trim()).filter(Boolean);
    }
    console.error('[selfrun] HEMI_SELF_RUN_SCRIPT 必须是字符串数组');
    app.exit(1);
  } catch (error) {
    console.error(`[selfrun] HEMI_SELF_RUN_SCRIPT 解析失败：${error.message}`);
    app.exit(1);
  }
  return null;
})();
const TIMEOUT_MS = Number(process.env.HEMI_SELF_RUN_TIMEOUT ?? 300000);
/**
 * 049：HEMI_SELF_RUN_REMOTE='host::远端目录'——启动时先经 workspace.addRemote
 * 登记远端项目（probe 通过才成功）并把它作为会话绑定，之后任务全部跑在远端。
 * 配合 HEMI_SSH_BIN 可指向假 ssh（verify-049 沙箱链路）或真实服务器。
 */
const REMOTE_SPEC = process.env.HEMI_SELF_RUN_REMOTE ?? '';
/** 049 密码登录：HEMI_SELF_RUN_REMOTE_PASSWORD——随 addRemote 传入（SSH_ASKPASS 链路）。 */
const REMOTE_PASSWORD = process.env.HEMI_SELF_RUN_REMOTE_PASSWORD ?? '';
/** 050 G-1～G-6 的门槛阈值（技术方案「回归样例集」）。 */
const MARKER_RESIDUAL_RE = /【[^】\n]{1,8}】/;

const log = createLogger('selfrun');
const handler = (channel) => {
  // Electron 44：invoke handler 存在 ipcMain._invokeHandlers（Map）。
  const fn = ipcMain._invokeHandlers?.get(channel) ?? ipcMain._handlers?.get?.(channel) ?? ipcMain._handlers?.[channel];
  if (typeof fn !== 'function') {
    console.error(`[selfrun] 找不到 IPC handler：${channel}`);
    app.exit(1);
  }
  return fn;
};

app.setName('hemi'); // 与正式应用同一 Keychain/storage 身份，拷来的密文可解密
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR));

let finished = false;
async function finish(code, summary) {
  if (finished) return;
  finished = true;
  console.log(`\n=== selfrun result: ${summary} ===`);
  try { disposeTaskManager(); } catch {}
  try { await (await import('../src/main/ipc/llm.ipc.mjs')).abortActiveTextModelTurn(); } catch {}
  void shutdownBrowserBridgeService().catch(() => {});
  setTimeout(() => app.exit(code), 500);
}

/** 任务档案里的浏览器/web 调用计数（toolCalls 留最后 20 条，回归样例够用）。 */
function browserCallsFromArchive(taskId) {
  try {
    const file = path.join(app.getPath('userData'), 'runtime-v2', 'task-history', `${taskId}.json`);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (record.toolCalls ?? []).filter((call) => /^(browser_|web_)/.test(String(call?.tool ?? ''))).length;
  } catch {
    return null;
  }
}

function firstSentence(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const firstLine = raw.split('\n').find((line) => line.trim()) ?? '';
  const hit = firstLine.match(/^[^。！？!?]*[。！？!?]/);
  return (hit ? hit[0] : firstLine).slice(0, 80);
}

app.whenReady().then(async () => {
  try {
    initializeStableSafeStorageIdentity();
    // 042：三档模式退役——任务工作区自动授权，区外走授权卡（harness 自动应答）。
    // 旧 permission-state.json 不再写入也不被读取（留盘仅诊断）。
    await registerAllIpcHandlers();
    if (process.env.HEMI_SELF_RUN_ROLE_MODELS) {
      const slots = JSON.parse(process.env.HEMI_SELF_RUN_ROLE_MODELS);
      for (const [slot, value] of Object.entries(slots)) {
        const saved = await handler(IPC.llm.saveRoleModel)({}, { patch: { [slot]: value } });
        if (!saved.ok) throw new Error('隔离 harness 的角色模型保存失败');
      }
    }
    const chat = handler(IPC.llm.chat);
    const getState = handler(IPC.task.getState);
    const action = handler(IPC.task.action);

    // 049：会话绑定的工作区——远端登记优先（probe 经真实 addRemote IPC 链路）。
    let boundWorkspaceId = process.env.HEMI_SELF_RUN_LEGACY === '1'
      ? null
      : process.env.HEMI_SELF_RUN_WORKSPACE || 'default';
    if (REMOTE_SPEC) {
      const sep = REMOTE_SPEC.indexOf('::');
      const host = REMOTE_SPEC.slice(0, sep);
      const dir = REMOTE_SPEC.slice(sep + 2);
      if (!host || !dir) {
        console.error('[selfrun] HEMI_SELF_RUN_REMOTE 格式应为 host::远端目录');
        finish(1, 'bad-remote-spec');
        return;
      }
      const addRemote = handler(IPC.workspace.addRemote);
      const added = await addRemote({}, { host, dir, ...(REMOTE_PASSWORD ? { password: REMOTE_PASSWORD } : {}) });
      if (!added?.ok) {
        console.error(`[selfrun] 远端工作区登记失败：${added?.kind ?? ''} ${added?.message ?? ''}`);
        finish(1, `add-remote-failed:${added?.kind ?? 'unknown'}`);
        return;
      }
      boundWorkspaceId = added.workspace.id;
      log.info(`远端工作区已登记并绑定：${host}:${added.workspace.dir}（${boundWorkspaceId}）`);
    }

    // 轮询任务状态：卡出现 → 按卡种自动应答（授权卡=本任务允许）。
    const autoAnswer = async () => {
      const snapshot = await getState({}, {});
      const tasks = snapshot.tasks ?? [];
      // 每个在途任务的待确认卡都要应答（并发任务各自弹卡，不能只顾第一个）；
      // 056：主 agent 自己的确认卡在 agentPermissions 里，同样应答。
      const pendings = [
        ...(snapshot.agentPermissions ?? []),
        ...tasks.filter((t) => t.phase !== 'terminal' && t.permission?.id),
      ];
      for (const pending of pendings) {
        // 042：授权卡（grant）→ 本任务允许；风险卡（action）→ 允许这次。
        const kind = pending.permission.kind ?? 'action';
        const choice = kind === 'grant' ? 'task' : 'once';
        log.info(`卡出现（${String(pending.permission.summary ?? '').slice(0, 60)}…，${kind}）→ 自动应答：${choice}`);
        await action({}, { action: 'decide', choice, taskKey: pending.key });
      }
      return tasks;
    };

    const submitTurn = async (turnId, text) => {
      const reply = await chat({}, {
        turnId,
        conversationId: process.env.HEMI_SELF_RUN_CONVERSATION ?? 'conv-selfrun',
        workspaceId: boundWorkspaceId,
        ...(process.env.HEMI_SELF_RUN_PROFILE_ID
          ? { profileId: process.env.HEMI_SELF_RUN_PROFILE_ID }
          : {}),
        messages: [{ role: 'user', content: text }],
        // 057 AC-05：语音定稿走 voice 通道注入（默认 text 保持旧行为）。
        inputSource: process.env.HEMI_SELF_RUN_INPUT_SOURCE ?? 'text',
      });
      if (reply?.text) log.info(`turn ${turnId} 回应全文：「${String(reply.text).replace(/\s+/g, ' ')}」`);
      return reply;
    };

    if (SCRIPT_TURNS) {
      // ---- 050 顺序多回合：逐回合注入，等本轮任务全部终态再发下一句。 ----
      log.info(`自驱动脚本模式就绪（${SCRIPT_TURNS.length} 回合）`);
      const turnStats = [];
      const watcher = setInterval(async () => {
        try { await autoAnswer(); } catch (error) { log.warn(`轮询异常（忽略）：${error?.message ?? error}`); }
      }, 1000);
      const deadline = Date.now() + TIMEOUT_MS;
      let timedOut = false;
      try {
        for (const [index, text] of SCRIPT_TURNS.entries()) {
          const before = await autoAnswer();
          const knownKeys = new Set((before ?? []).map((t) => t.key));
          const knownTaskIds = new Set((before ?? []).map((t) => t.taskId).filter(Boolean));
          log.info(`回合 ${index + 1}/${SCRIPT_TURNS.length} 注入：「${text}」`);
          await submitTurn(9200 + index, text);
          // 等全部任务终态（顺序脚本：上一轮任务收干净才发下一句）。
          let tasks = [];
          for (;;) {
            tasks = await autoAnswer();
            if (tasks.every((t) => t.phase === 'terminal')) break;
            if (Date.now() > deadline) { timedOut = true; break; }
            await new Promise((r) => setTimeout(r, 500));
          }
          if (timedOut) break;
          const newTasks = tasks.filter((t) => !knownKeys.has(t.key));
          const archived = newTasks
            .map((t) => t.taskId)
            .filter(Boolean)
            .map((taskId) => ({ taskId, browserCalls: browserCallsFromArchive(taskId) }));
          const stat = {
            turn: index + 1,
            text,
            executeTaskCalls: newTasks.length,
            newTaskIds: newTasks.map((t) => t.taskId),
            outcomes: newTasks.map((t) => t.outcome),
            bodyFirstSentence: firstSentence(newTasks.find((t) => t.resultText)?.resultText ?? ''),
            replyFirstSentence: '',
            markerResidual: newTasks.some((t) => MARKER_RESIDUAL_RE.test(t.resultText ?? '')),
            browserCalls: archived.reduce((sum, item) => sum + (item.browserCalls ?? 0), 0),
            notices: newTasks.flatMap((t) => t.notices ?? []),
          };
          turnStats.push(stat);
          log.info(`回合 ${index + 1} 完成：${JSON.stringify(stat)}`);
        }
      } finally {
        clearInterval(watcher);
      }
      const result = {
        turns: turnStats.length,
        expected: SCRIPT_TURNS.length,
        timedOut,
        firstSentenceHit: turnStats.filter((t) => t.bodyFirstSentence).length,
        markerResidualTurns: turnStats.filter((t) => t.markerResidual).length,
        turnStats,
      };
      console.log(`HEMI_SELF_RUN_SCRIPT_RESULT=${JSON.stringify(result)}`);
      await finish(timedOut ? 1 : 0, `script turns=${turnStats.length}/${SCRIPT_TURNS.length}`);
      return;
    }

    const watcher = setInterval(async () => {
      if (finished) return;
      try { await autoAnswer(); } catch (error) { log.warn(`轮询异常（忽略）：${error?.message ?? error}`); }
    }, 500);
    setTimeout(() => finish(1, 'timeout'), TIMEOUT_MS);
    const texts = TASK_BATCH.length > 1 ? TASK_BATCH : [TASK_TEXT];
    log.info(`自驱动实例就绪，注入 ${texts.length} 条${texts.length > 1 ? `：${texts.map((t) => `「${t.slice(0, 12)}…」`).join(' ')}` : `：「${TASK_TEXT}」`}`);
    // 并发模式：多句同时注入（各自会话，互不抢占）。
    const replies = await Promise.all(texts.map(async (text, index) => {
      try {
        const reply = await chat({}, {
          turnId: 9100 + index,
          workspaceId: boundWorkspaceId,
          ...(process.env.HEMI_SELF_RUN_PROFILE_ID ? { profileId: process.env.HEMI_SELF_RUN_PROFILE_ID } : {}),
          messages: [{ role: 'user', content: text }],
          // 057 AC-05：语音定稿注入；SAME_CONV=1 时多句仍进同一会话（ASR 逐句到达的忙时追加语义）。
          inputSource: process.env.HEMI_SELF_RUN_INPUT_SOURCE ?? 'text',
          conversationId: process.env.HEMI_SELF_RUN_CONVERSATION
            ?? (process.env.HEMI_SELF_RUN_SAME_CONV === '1' ? 'conv-selfrun' : texts.length > 1 ? `conv-selfrun-${index + 1}` : 'conv-selfrun'),
        });
        log.info(`回合 #${index + 1} 回答：「${String(reply?.text ?? '').replace(/\s+/g, ' ').slice(0, 400)}」`);
        return { ok: true, text: reply?.text ?? '', toolNames: reply?.toolNames ?? [] };
      } catch (error) {
        log.warn(`回合 #${index + 1} 失败：${error?.message ?? error}`);
        return { ok: false, error: String(error?.message ?? error) };
      }
    }));
    // 后台子 agent 可能还在跑：等全部终态（事件唤醒的交代回合另行落档）。
    let tasks = [];
    for (;;) {
      tasks = await autoAnswer();
      if (tasks.every((t) => t.phase === 'terminal')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    // 064：后台结果在所属根目标内收口；不再要求额外 event-run 或靠日志计数。
    const backgroundCount = tasks.filter(t => t.background).length;
    const journalFile = path.join(app.getPath('userData'), 'runtime-v2/run-journal.json');
    let consumedCompletions = 0, completionEvents = [];
    if (backgroundCount) {
      const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
      const taskIds = new Set(tasks.filter(t => t.background).map(t => t.taskId));
      completionEvents = Object.values(journal.inbox).filter(event => taskIds.has(event.taskId));
      consumedCompletions = completionEvents.filter(event => event.state === 'consumed').length;
      log.info(`后台子 agent ${backgroundCount} 个，所属目标已消费完成事实 ${consumedCompletions} 个`);
    }
    clearInterval(watcher);
    const result = {
      consumedCompletions,
      completionEvents: completionEvents.map(event => ({ eventId: event.eventId, state: event.state, owner: event.owner })),
      replies,
      subagents: tasks.map((t) => ({ agent: t.agent, taskText: t.taskText, outcome: t.outcome, report: String(t.resultText ?? '').slice(0, 300) })),
    };
    console.log(`HEMI_SELF_RUN_RESULT=${JSON.stringify(result)}`);
    const ok = replies.every((r) => r.ok) && tasks.every((t) => t.outcome === 'complete') && consumedCompletions >= backgroundCount;
    finish(ok ? 0 : 1, `replies=${replies.filter((r) => r.ok).length}/${replies.length} subagents=${tasks.map((t) => `${t.agent}:${t.outcome}`).join(',') || 'none'}`);

  } catch (error) {
    console.error('[selfrun] 启动失败：', error);
    finish(1, 'boot-failed');
  }
});
