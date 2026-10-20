import { runtimeDataDir } from '../agent-runtime/storage-migration.mjs';
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';

import { IPC } from '../../shared/ipc-channels.mjs';
import { createConversationStore, repairTaskTurns } from '../history/conversation-store.mjs';
import { snapshotFromRecord } from '../history/task-history.mjs';
import { conversationTaskSeq, conversationTurnsForTask } from '../history/conversation-events.mjs';
import { createAutoTitler } from '../history/conversation-title.mjs';
import { getProfiles } from '../lib/profiles-holder.mjs';
import { resolveLightModel } from '../lib/light-model.mjs';
import { getAgentRuntime } from './llm.ipc.mjs';
import { migrateConversationDirToV2 } from '../services/conversation-migration.mjs';
import { createDraftStore } from '../lib/draft-store.mjs';
import { createLogger } from '../lib/logger.mjs';
import { getWorkspaceService } from './workspace.ipc.mjs';
import { getConversationFlowService } from '../services/conversation-flow-service.mjs';

const log = createLogger('conversation');

// ---- 017：任务档案访问（task.ipc 启动时注册；同一存储实例，缓存不分裂） ----
let taskHistoryAccess = null;
let hostConversationApi = null;
const persistedTaskVersions = new Map();

export function persistConversationTurns(conversationId, turns, options = undefined) {
  return hostConversationApi?.append(conversationId, turns, options) ?? { ok: false };
}

/** 当前请求已受理的用户消息也受宿主保护，不能被稍后的旧界面快照覆盖。 */
export function persistConversationInput(conversationId) {
  const session = hostConversationApi?.get(conversationId);
  const input = session?.turns?.findLast((turn) => turn.author === 'user' && !turn.withdrawn);
  if (input) persistConversationTurns(conversationId, [input]);
}

export function getConversationMetadata(conversationId) {
  const session = hostConversationApi?.get(conversationId);
  return session ? {profileId: session.profileId ?? null, workspaceId: session.workspaceId ?? null} : null;
}

export function getConversationDiagnostics(conversationId) {
  return hostConversationApi?.get(conversationId)?.runtimeDiagnostics ?? [];
}

export function recordConversationDiagnostic(conversationId, diagnostic) {
  return hostConversationApi?.diagnostic(conversationId, diagnostic) ?? false;
}

export function persistConversationTask(snapshot) {
  if (!snapshot?.conversationId || !snapshot.taskId) return;
  const version = snapshot.phase === 'terminal'
    ? JSON.stringify([snapshot.outcome, snapshot.endedAt, snapshot.resultText, snapshot.verifying, snapshot.log.at(-1)])
    : 'accepted';
  if (persistedTaskVersions.get(snapshot.taskId) === version) return;
  const session = hostConversationApi?.get(snapshot.conversationId);
  if (!session || session.corrupt) return;
  // 运行中的中间快照交给渲染层防抖；宿主只保证受理与终态。
  if (snapshot.phase !== 'terminal' && session.turns.some((turn) => turn.kind === 'task' && turn.taskId === snapshot.taskId)) {
    persistedTaskVersions.set(snapshot.taskId, version);
    return;
  }
  if (persistConversationTurns(snapshot.conversationId, conversationTurnsForTask(snapshot)).ok) {
    persistedTaskVersions.set(snapshot.taskId, version);
  }
}

/** task.ipc 注册：{ getRecord(taskId), findRecordCandidate({ text, createdAt, exclude }) }。 */
export function setConversationTaskHistory(access) {
  taskHistoryAccess = access;
}

/** composer.ipc @引用候选用（028 复位，055 重构误删后 2026-10-15 找回）。 */
export function getConversationTaskHistory() {
  return taskHistoryAccess;
}

// ---- 056：主 agent 条目档案桥（agent-runtime 消费）＋回卷作废监听 ----
let archiveCutListener = null;

/** llm.ipc 启动时注册：(conversationId) => void——档案被剪时作废主 agent 条目（024 回卷）。 */
export function setArchiveCutListener(fn) {
  archiveCutListener = typeof fn === 'function' ? fn : null;
}

/** 057 S3-2d：宿主档案操作（registerConversationIpc 时晚绑定——store 在函数内建）。 */
let archiveOps = null;

/** 宿主侧回卷剪除（不携带渲染层 turns）；剪除键新增时作废主 agent。 */
export function applyConversationCut(conversationId, keys, options = {}) {
  if (!archiveOps) return { ok: false, storageError: '会话服务未就绪' };
  const result = archiveOps.store.applyCutKeys(conversationId, keys, options);
  if (result?.ok && result.cutKeysGrew) {
    try { archiveCutListener?.(conversationId); } catch { /* 监听失败不影响剪除 */ }
  }
  return result;
}

/** 确保会话档案在场（新会话首回合由宿主建档）；已存在时只补元数据。 */
export function ensureConversationArchive({ id, profileId = undefined, workspaceId = undefined, firstTurns = [] }) {
  if (!archiveOps) return { ok: false, storageError: '会话服务未就绪' };
  const store = archiveOps.store;
  const existing = store.getSession(id);
  if (existing && !existing.corrupt) {
    const patch = {};
    if (profileId !== undefined && (existing.profileId ?? null) !== (profileId ?? null)) patch.profileId = profileId ?? null;
    if (workspaceId !== undefined && (existing.workspaceId ?? null) !== (workspaceId ?? null)) patch.workspaceId = workspaceId ?? null;
    if (!Object.keys(patch).length) return { ok: true, existed: true };
    return store.saveSession({ id, turns: existing.turns, ...patch, keepUpdatedAt: true });
  }
  return store.saveSession({ id, turns: firstTurns, ...(profileId !== undefined ? { profileId } : {}), ...(workspaceId !== undefined ? { workspaceId } : {}) });
}

export function getConversationAgent(conversationId) {
  return hostConversationApi?.getAgent?.(conversationId) ?? null;
}

/** 062：会话档案只读（workspaceId 等；交付链接按会话绑定的工作区解析）。 */
export function getConversationSession(conversationId) {
  const session = hostConversationApi?.get?.(conversationId) ?? null;
  return session && !session.corrupt ? session : null;
}

/** 063：@ 对话候选的会话列表（只读摘要，含 workspaceId 供工作区过滤）。 */
export function listConversationSessions() {
  if (!archiveOps) return [];
  const listing = archiveOps.store.listSessions();
  return Array.isArray(listing) ? listing : listing?.sessions ?? [];
}

export function saveConversationAgent(conversationId, payload) {
  return hostConversationApi?.saveAgent?.(conversationId, payload) ?? false;
}

/** 旧档案的 turns（R-13 纯文本转换的原料；无档案/损坏返回 null）。 */
export function getConversationTurnsRaw(conversationId) {
  const session = hostConversationApi?.get?.(conversationId);
  return session && !session.corrupt ? session.turns : null;
}

// ---- 048 D7：会话用量账本（对话侧主进程记录；任务侧经提供方合并查询） ----
let usageApi = null;
let usageTaskProvider = null;

/**
 * task.ipc 注册：(conversationId) => UsageRecord[]——任务执行的按模型聚合行
 * （档案终态 + manager 在途），source='task'。
 */
export function setUsageTaskProvider(fn) {
  usageTaskProvider = typeof fn === 'function' ? fn : null;
}

/**
 * 对话侧用量记账（llm.ipc／task.ipc 回炉/补判／本文件自动标题调用）：
 * 追加会话档案账本并广播 usage:changed。会话没落盘（新会话首回合）时记录
 * 丢弃一条不致命——下一次会追上。
 */
export function recordConversationUsage(conversationId, record) {
  if (!conversationId || !record) return false;
  const ok = usageApi ? usageApi.record(conversationId, record) : false;
  if (ok) usageApi?.notify(conversationId);
  return ok;
}

/** usage:changed 广播（task.ipc 的任务执行行也走这里；不追加账本）。 */
export function broadcastUsageChanged(conversationId) {
  usageApi?.notify(conversationId);
}

/**
 * 015 会话通道：最近 / 保存 / 列表 / 打开 / 删除。会话是纯对话事实——
 * 不复活任务、不触执行器（对齐 009 历史只读的边界）；保存失败不抛
 * （不阻断对话，返回 ok:false 由渲染层记日志，009 同款取舍）。
 * 017：保存前做任务卡快照修复（全量事件 + 错挂剥离/找回）——修复只读档案，
 * 不触执行器，边界不变。
 */

/**
 * 档案变更广播（2026-10-07 新会话不进侧栏的根因修复）：侧栏列表原来只在
 * 挂载/切换会话/窗口聚焦时重读，而新会话的档案要等首条消息后 800ms 防抖
 * 才落盘——id 定格触发的刷新跑在落盘之前，窗口不失焦就永远看不到新会话。
 * 落盘/改名/删除/排序成功后广播一次，订阅方重读列表即对齐（对齐
 * memory:changed 的全窗口转发形态）。载荷只作诊断，消费方无须依赖。
 */
function broadcastChanged(payload) {
  for (const win of [...BrowserWindow.getAllWindows()]) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send(IPC.conversation.changed, payload);
  }
}

export function registerConversationIpc() {
  // 015：会话档案（每会话一个 JSON 文件，userData/conversations/）。
  const conversationsDir = path.join(runtimeDataDir(app.getPath('userData')), 'conversations');
  const store = createConversationStore({
    dir: conversationsDir,
    log,
  });

  // 057 S3-2d：旧档一次性迁移 v2（flow 随档；备份先行、幂等、损坏不动）。
  try {
    const report = migrateConversationDirToV2(conversationsDir, { log });
    if (report.migrated || report.backups || report.skippedCorrupt) {
      log?.info?.(`[conversation] v2 迁移：${report.migrated} 份迁移、${report.backups} 份备份、${report.skippedCorrupt} 份损坏跳过、${report.skippedCurrent} 份已是 v2`);
    }
  } catch (error) {
    log?.warn?.(`[conversation] v2 迁移失败（不阻断启动，打开时现场引导兜底）：${error?.message ?? error}`);
  }

  // P1 自动标题：首轮回复落盘后用轻量模型起 ≤12 字短标题（不思考、不重试，
  // 10s 无首字即放弃）；成功即广播 kind:'title'，侧栏重读、顶栏换标题。
  // 055 R-01（Q5）：标题选模与口同一套规则——具体模型用所选，自动路由用
  // 执行模型（未配置再退默认），修掉旧的默认模型兜底依赖。
  const autoTitler = createAutoTitler({
    store,
    runModel: async ({ messages, profileId, conversationId }) => {
      const config = await resolveLightModel({ getProfiles, profileId: profileId ?? null });
      if (!config) throw new Error('所选模型或路由已不可用，暂不生成标题');
      const final = await getAgentRuntime().auxiliaryCall({ config, conversationId, purpose: 'title',
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        api: config.api,
        messages,
        tools: undefined,
        thinkingLevel: 'off',
        thinkingFormat: config.thinkingFormat,
        maxPreStreamRetries: 0,
      });
      // 048 D7：自动标题计入会话用量（成功没回用量也计 missing 次数）。
      recordConversationUsage(conversationId, {
        source: 'title',
        modelKey: config.modelKey ?? config.model,
        modelName: config.name ?? '',
        requestedModel: config.model ?? '',
        ...(final.usageDetail ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, genMs: 0 }),
        ...(final.usageDetail ? {} : { missing: 1 }),
        at: Date.now(),
      });
      return final.content;
    },
    onTitled: (session) => broadcastChanged({ kind: 'title', session }),
    log,
  });

  archiveOps = { store };
  hostConversationApi = {
    get: (id) => store.getSession(id),
    diagnostic: (id, diagnostic) => store.appendRuntimeDiagnostic(id, diagnostic),
    append: (id, turns, options) => {
      const result = store.appendHostTurns(id, turns, options);
      if (result.ok && !result.unchanged) {
        broadcastChanged({ kind: 'save', session: result.session });
        // 迁移/恢复性回写（touched:false）不触发补起名。
        if (result.touched !== false) autoTitler.schedule(id);
      }
      return result;
    },
    getAgent: (id) => store.getAgentSession(id),
    saveAgent: (id, payload) => store.saveAgentSession(id, payload),
  };

  function restoreTaskResults(session) {
    if (!session || session.corrupt) return session;
    const records = taskHistoryAccess?.listByConversation?.(session.id) ?? [];
    const recovered = records.flatMap((record) =>
      record && !record.corrupt && (record.outcome || record.interrupted)
        ? conversationTurnsForTask(snapshotFromRecord(record, conversationTaskSeq(record, session.turns)))
        : [],
    );
    // 恢复性补档不改「最近对话」时间——点开旧会话不顶到「今天」（2026-10-11）。
    if (recovered.length) persistConversationTurns(session.id, recovered, { keepUpdatedAt: true });
    return store.getSession(session.id) ?? session;
  }

  // 030：会话草稿（userData/drafts，一份会话一份；删除会话联动清理）。
  const drafts = createDraftStore({
    dir: path.join(app.getPath('userData'), 'drafts'),
    log,
  });
  ipcMain.handle(IPC.drafts.save, (_event, payload) =>
    drafts.save({
      conversationId: payload?.conversationId,
      revision: payload?.revision,
      text: payload?.text,
      skills: payload?.skills,
      references: payload?.references,
    }),
  );
  ipcMain.handle(IPC.drafts.get, (_event, payload) =>
    drafts.get(payload?.conversationId ?? ''),
  );
  ipcMain.handle(IPC.drafts.remove, (_event, payload) => ({
    ok: drafts.remove(payload?.conversationId ?? ''),
  }));


  ipcMain.handle(IPC.conversation.last, () => restoreTaskResults(store.lastSession()));

  ipcMain.handle(IPC.conversation.save, (_event, payload) => {
    const turns = repairTaskTurns(payload?.turns, {
      getRecord: taskHistoryAccess?.getRecord ?? null,
      findRecordCandidate: taskHistoryAccess?.findRecordCandidate ?? null,
    });
    const result = store.saveSession({
      id: payload?.id,
      turns,
      // 031：会话级模型配置组选择（undefined＝不动已存；null＝回落默认组）。
      profileId: typeof payload === 'object' && payload && 'profileId' in payload
        ? payload.profileId
        : undefined,
      // 033：会话绑定的工作区身份（undefined＝不动已存；'default'/项目 id/null）。
      workspaceId: typeof payload === 'object' && payload && 'workspaceId' in payload
        ? payload.workspaceId
        : undefined,
      // 024 回卷剪除键：随保存并入档案 cutKeys（条目 id＋任务 taskId）。
      removedTurnKeys: Array.isArray(payload?.removedTurnKeys) ? payload.removedTurnKeys : [],
    });
    if (!result.ok) log.warn(`会话保存失败：${result.storageError}`);
    // 回卷剪除＝主 agent 条目与展示史分叉，作废主 agent 会话（下次按新档案重建）。
    // 只在剪除键真正新增时触发——回卷后的防抖补存档会重复携带同一批键，
    // 无条件触发会把刚在回卷档案上起跑的新回合再杀一次（2026-10-14 真机钓出）。
    if (result.cutKeysGrew) {
      try { archiveCutListener?.(payload.id); } catch { /* 监听失败不影响保存 */ }
    }
    // 内容未变的保存不广播（unchanged 见 conversation-store：没写盘）；
    // 迁移性改写（touched:false，如旧档标题重推导）广播但不触发补起名。
    if (result.ok && !result.unchanged) {
      broadcastChanged({ kind: 'save', session: result.session });
      if (result.touched !== false) autoTitler.schedule(result.session.id);
    }
    // 033：绑定项目时刷新最近使用（侧栏/菜单的排序依据；默认工作区无需）。
    const boundWorkspaceId = result.ok ? result.session?.workspaceId ?? null : null;
    if (boundWorkspaceId) getWorkspaceService()?.touch(boundWorkspaceId);
    return result;
  });

  ipcMain.handle(IPC.conversation.list, () => {
    const list = store.listSessions();
    const flow = getConversationFlowService();
    return { ...list, sessions: list.sessions.map(session => {
      const status = flow.getStatus(session.id);
      return { ...session, status: status === undefined ? session.status : status };
    }) };
  });

  // 048 D7：会话用量账本——对话侧记录随会话档案；任务执行（终态档案＋在途）
  // 经 task.ipc 注册的提供方合并，每次完成推送 usage:changed。
  usageApi = {
    record: (conversationId, record) => store.appendUsageRecord(conversationId, record),
    notify: (conversationId) => {
      for (const win of [...BrowserWindow.getAllWindows()]) {
        if (!win || win.isDestroyed()) continue;
        win.webContents.send(IPC.usage.changed, { conversationId });
      }
    },
  };
  ipcMain.handle(IPC.usage.getLedger, async (_event, payload) => {
    const conversationId = typeof payload === 'string' ? payload : String(payload?.conversationId ?? '');
    const session = conversationId ? store.getSession(conversationId) : null;
    let taskRows = [];
    try {
      taskRows = conversationId && usageTaskProvider ? usageTaskProvider(conversationId) : [];
    } catch (error) {
      log.warn(`任务执行用量汇总失败（不阻断面板）：${error.message}`);
    }
    const canonical = conversationId ? await getAgentRuntime().usageRecordsFor(conversationId) : [];
    const cutover = canonical.length ? Math.min(...canonical.map(row => row.at)) : Infinity;
    return { conversationId, records: [...(session?.usageLedger ?? []), ...taskRows].filter(row => row.at < cutover).concat(canonical) };
  });

  // 载荷双形态兼容（字符串或 { id }）：019 合并时 preload 曾把 { id } 漂移成裸
  // 字符串，处理器只认对象导致所有会话「找不到」（2026-09-21 实录）——以后哪边
  // 单独改都不再出这种全灭故障。
  ipcMain.handle(IPC.conversation.open, (_event, payload) => {
    const id = typeof payload === 'string' ? payload : String(payload?.id ?? '');
    const record = store.getSession(id);
    if (!record) throw new Error('找不到该会话（可能已被删除）');
    return restoreTaskResults(record);
  });

  ipcMain.handle(IPC.conversation.markRead, (_event, payload) => {
    const result = store.markRead(payload?.id, payload?.expectedUnreadAt);
    if (!result.unchanged) broadcastChanged({ kind: 'read', id: payload.id });
    return result;
  });

  ipcMain.handle(IPC.conversation.remove, (_event, payload) => {
    const id = typeof payload === 'string' ? payload : String(payload?.id ?? '');
    const ok = store.deleteSession(id);
    if (!ok) throw new Error('删除会话失败');
    void drafts.remove(id); // 030 R-03：会话删除清对应草稿（幂等）。
    // 056：删会话同回卷——作废主 agent、停掉它的子 agent、清对话级临时授权。
    try { archiveCutListener?.(id); } catch { /* 清理失败不影响删除 */ }
    broadcastChanged({ kind: 'remove', id });
    return { ok };
  });

  // 024 双击重命名：空标题回退派生标题；会话不存在与删除同款抛错（渲染层提示）。
  ipcMain.handle(IPC.conversation.rename, (_event, payload) => {
    const id = typeof payload === 'string' ? payload : String(payload?.id ?? '');
    const title = typeof payload === 'object' && payload ? String(payload?.title ?? '') : '';
    const result = store.renameSession(id, title);
    if (!result) throw new Error('找不到该会话（可能已被删除）');
    if (!result.ok) throw new Error(result.storageError ?? '会话重命名失败');
    broadcastChanged({ kind: 'rename', session: result.session });
    return result;
  });

  // 024 拖拽排序：渲染层发当前完整列表 id 序；失败不抛（保持界面顺序，记日志）。
  ipcMain.handle(IPC.conversation.reorder, (_event, payload) => {
    const ids = Array.isArray(payload?.ids) ? payload.ids : [];
    const result = store.reorderSessions(ids);
    if (!result.ok) log.warn(`会话排序失败：${result.storageError}`);
    if (result.ok) broadcastChanged({ kind: 'reorder' });
    return result;
  });
}
