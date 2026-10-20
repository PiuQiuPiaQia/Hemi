// 015 会话存储：每会话一个 JSON + 临时文件 rename 原子替换（对齐 009 task-history）。
//
// 职责：会话 turns 全量落盘（任务卡条目携带冻结快照）、最近会话定位（启动
// 继续上次对话 R-01）、列表视图、删除；容量裁剪（50 个会话 R-06）与单会话
// 条目截断（500 条）；损坏文件跳过不致命。净化/标题/视图是纯函数可离线单测；
// IO 经注入目录覆盖。会话只记对话事实——不复活任务、不触执行器。
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

// 循环规避：snapshotFromRecord 从 task-history 引入（会话修复只依赖其纯函数面）。
import { snapshotFromRecord } from './task-history.mjs';
import { firstReply, titleSource } from './conversation-title.mjs';
import { noteActivity } from '../lib/perf.mjs';
import { conversationStatus } from '../../shared/conversation-status.mjs';

// 057 S3-2d：v2＝flow 快照随档（骨架；turns 仍是载荷/档案层）。旧档启动时一次性
// 迁移（备份原档后写 v2，幂等）；缺 flow 的旧档由流服务打开时现场引导兜底。
export const CONVERSATION_VERSION = 2;
/** 会话数量上限（R-06）：保存时按 updatedAt 裁最旧。 */
export const MAX_SESSIONS = 50;
/** 单会话条目上限：超出截断最旧（防长对话无限增长）。 */
export const MAX_TURNS = 500;
/** 会话标题（D-2）：首条用户消息截 24 字。 */
export const TITLE_LIMIT = 24;
/** 手动重命名的标题上限（比派生标题宽：用户起名自己负责）。 */
export const CUSTOM_TITLE_LIMIT = 48;
/** 048：单轮思考全文落盘上限（码点）。探针难题最大 16.5k，100k 是十倍余量。 */
export const MAX_THINKING_CHARS = 100_000;
/** 048：会话用量账本上限（条数）。超出裁最旧——账本按次记录，长会话兜底。 */
export const MAX_USAGE_RECORDS = 2000;

/**
 * 048：净化用量账本（白名单清洗；source 只认五类；全零/畸形剔除；
 * 超上限裁最旧）。对话侧主进程追加、渲染层保存不触碰（saveSession 原样
 * 保留 existing 的账本——渲染层整表防抖回写不带账本字段）。
 */
export function sanitizeUsageRecords(records) {
  if (!Array.isArray(records)) return [];
  const SOURCES = ['chat', 'fallback', 'summary', 'title', 'task'];
  const clean = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if (!SOURCES.includes(record.source)) continue;
    const item = {
      source: record.source,
      modelKey: typeof record.modelKey === 'string' ? record.modelKey : '',
      modelName: typeof record.modelName === 'string' ? record.modelName : '',
      ...(typeof record.requestedModel === 'string' && record.requestedModel ? { requestedModel: record.requestedModel } : {}),
      input: Number(record.input) || 0,
      output: Number(record.output) || 0,
      cacheRead: Number(record.cacheRead) || 0,
      cacheWrite: Number(record.cacheWrite) || 0,
      genMs: Number(record.genMs) || 0,
      at: Number(record.at) || 0,
    };
    if (['main', 'explorer', 'oracle', 'fixer', 'designer', 'auxiliary'].includes(record.role)) item.role = record.role;
    if (typeof record.taskId === 'string' && record.taskId) item.taskId = record.taskId;
    if (Number.isFinite(record.calls)) item.calls = Number(record.calls) || 0;
    if (Number.isFinite(record.missing)) item.missing = Number(record.missing) || 0;
    const hasNumbers = item.input || item.output || item.cacheRead || item.cacheWrite || item.genMs;
    const missingOnly = item.missing && !hasNumbers;
    if (!hasNumbers && !missingOnly) continue; // 空记录不落
    clean.push(item);
  }
  return clean.length > MAX_USAGE_RECORDS ? clean.slice(clean.length - MAX_USAGE_RECORDS) : clean;
}

/** 手动排序索引文件（024：侧栏拖拽排序持久化）。会话文件名均为 conv-*，
 * 该名不匹配会话 ID 正则，listSessions 读到会跳过，不会误当会话。 */
const ORDER_FILE = 'order-index.json';

const SESSION_ID_RE = /^conv-[a-z0-9-]+$/;

/** 规范化手动标题：折空白、截上限；空串返回 null（回退派生标题）。 */
export function normalizeCustomTitle(raw) {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  const chars = Array.from(collapsed);
  return chars.length <= CUSTOM_TITLE_LIMIT ? collapsed : `${chars.slice(0, CUSTOM_TITLE_LIMIT).join('')}…`;
}

export function newSessionId(now = Date.now()) {
  return `conv-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 净化 turns：只保留合法字段、丢弃畸形条目；超上限截掉最旧。
 * 任务卡条目（kind='task'）携带冻结快照 taskSnap，读回后据此重建卡片。
 */
const MAX_PART_TEXT = 100_000;
const MAX_PART_CALLS = 40;

/** 056：段白名单清洗（类型/长度/工具参数只留标量）。 */
function sanitizeParts(parts) {
  const out = [];
  let calls = 0;
  for (const part of parts.slice(0, 200)) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' || part.type === 'thinking') {
      const text = typeof part.text === 'string' ? part.text.slice(0, MAX_PART_TEXT) : '';
      if (!text.trim()) continue;
      if (part.type === 'text') { out.push({ type: 'text', text }); continue; }
      const startedAt = Number(part.startedAt) || 0;
      const endedAt = Number(part.endedAt) || startedAt;
      out.push({ type: 'thinking', text, startedAt, endedAt, ...(part.interrupted === true ? { interrupted: true } : {}) });
    } else if (part.type === 'tools' && Array.isArray(part.calls)) {
      const clean = [];
      for (const call of part.calls) {
        if (calls >= MAX_PART_CALLS || !call || typeof call.tool !== 'string') continue;
        const args = {};
        for (const [key, value] of Object.entries(call.args ?? {}).slice(0, 8)) {
          if (typeof value === 'string') args[key] = value.slice(0, 300);
          else if (typeof value === 'number' || typeof value === 'boolean') args[key] = value;
        }
        clean.push({
          id: String(call.id ?? `${call.tool}-${calls}`),
          tool: call.tool,
          args,
          state: call.state === 'error' ? 'error' : 'done',
        });
        calls += 1;
      }
      if (clean.length) out.push({ type: 'tools', calls: clean });
    }
  }
  return out;
}

/** 061：用户轮附件视图的落盘清洗（与 llm.ipc sanitizeAttachmentViews 同界：≤12 项、缩略图 data:image/ ≤400KB、路径 ≤300 字）。 */
function sanitizeArchiveAttachments(views) {
  const clean = [];
  for (const view of views.slice(0, 12)) {
    if (!view || typeof view !== 'object' || typeof view.attachmentId !== 'string' || !view.attachmentId) continue;
    const item = {
      attachmentId: view.attachmentId,
      conversationId: typeof view.conversationId === 'string' ? view.conversationId : '',
      name: String(view.name ?? '附件').slice(0, 120),
      kind: view.kind === 'image' ? 'image' : 'text',
      sizeBytes: Number(view.sizeBytes ?? 0) || 0,
      status: view.status === 'failed' ? 'failed' : 'ready',
      source: view.source === 'drop' || view.source === 'paste' ? view.source : 'picker',
      registeredAt: Number.isFinite(view.registeredAt) ? view.registeredAt : 0,
    };
    if (typeof view.message === 'string' && view.message) item.message = view.message.slice(0, 160);
    if (typeof view.originPath === 'string') item.originPath = view.originPath.slice(0, 300);
    if (
      typeof view.thumbnailUrl === 'string' &&
      view.thumbnailUrl.startsWith('data:image/') &&
      view.thumbnailUrl.length <= 400_000
    ) {
      item.thumbnailUrl = view.thumbnailUrl;
    }
    if (typeof view.stagedPath === 'string' && view.stagedPath) item.stagedPath = view.stagedPath.slice(0, 300);
    clean.push(item);
  }
  return clean;
}

/** 063：用户轮引用选择的落盘清洗（kind 白名单＋身份字段按 kind 保留；≤12 项）。 */
const ARCHIVE_REFERENCE_KINDS = new Set(['attachment', 'artifact', 'context', 'workflow', 'file', 'folder', 'conversation']);
function sanitizeArchiveReferences(views) {
  const clean = [];
  for (const view of views.slice(0, 12)) {
    if (!view || typeof view !== 'object' || typeof view.kind !== 'string' || !ARCHIVE_REFERENCE_KINDS.has(view.kind)) continue;
    const item = {
      kind: view.kind,
      key: String(view.key ?? '').slice(0, 300),
      name: String(view.name ?? '引用').slice(0, 160),
      subtitle: String(view.subtitle ?? '').slice(0, 200),
    };
    for (const field of ['attachmentId', 'taskId', 'artifactId', 'contextId', 'workflowId', 'refPath', 'targetConversationId']) {
      if (typeof view[field] === 'string' && view[field]) item[field] = view[field].slice(0, 400);
    }
    if (Number.isFinite(view.workflowRevision)) item.workflowRevision = Number(view.workflowRevision);
    clean.push(item);
  }
  return clean;
}

/** 063：用户轮显式技能选择的落盘清洗（≤6 项；source 二值收敛）。 */
function sanitizeArchiveSkills(views) {
  const clean = [];
  for (const view of views.slice(0, 6)) {
    if (!view || typeof view !== 'object' || typeof view.name !== 'string' || !view.name.trim()) continue;
    clean.push({
      token: String(view.token ?? view.name).slice(0, 120),
      name: String(view.name).slice(0, 120),
      source: view.source === 'project' ? 'project' : 'library',
      skillId: String(view.skillId ?? '').slice(0, 300),
      ...(typeof view.description === 'string' && view.description ? { description: view.description.slice(0, 200) } : {}),
    });
  }
  return clean;
}

export function sanitizeTurns(turns, { maxTurns = MAX_TURNS } = {}) {
  if (!Array.isArray(turns)) return [];
  const clean = [];
  for (const turn of turns) {
    if (!turn || typeof turn !== 'object') continue;
    if (turn.author !== 'user' && turn.author !== 'hemi') continue;
    if (typeof turn.text !== 'string') continue;
    const item = {
      id: typeof turn.id === 'string' && turn.id ? turn.id : `t-${clean.length}`,
      text: turn.text,
      createdAt: typeof turn.createdAt === 'number' ? turn.createdAt : 0,
      author: turn.author,
    };
    if (turn.kind === 'task' && typeof turn.taskSeq === 'number') {
      item.kind = 'task';
      item.taskSeq = turn.taskSeq;
      // 任务卡的稳定身份（全局唯一）：落盘带回，渲染层跨会话按它对卡。
      if (typeof turn.taskId === 'string' && turn.taskId) item.taskId = turn.taskId;
      if (turn.taskSnap && typeof turn.taskSnap === 'object') item.taskSnap = turn.taskSnap;
    } else if (turn.kind === 'error') {
      // 2026-10-07 会话审计：聊天回合失败留痕——原样落盘（渲染层按 kind 不进
      // 模型上下文）；剥掉 kind 会降级成普通 hemi 消息、重载后混进上下文。
      item.kind = 'error';
    } else if (typeof turn.taskId === 'string' && turn.taskId) {
      // 026 R-09：阶段简报/终态交代所属任务的身份也落盘——历史回看时渲染
      // 轻量同任务标识；旧档缺省保持原样，不按邻接猜归属。
      item.taskId = turn.taskId;
    }
    // 061：用户轮附件视图随档冻结（白名单此前漏掉 attachments，历史附件一直
    // 只靠 flow 字段兜着）——缩略图 dataUrl（≤400KB）跨重启显示，stagedPath
    // 供粘贴图片的预览受控回退。
    if (turn.author === 'user' && Array.isArray(turn.attachments) && turn.attachments.length) {
      const attachments = sanitizeArchiveAttachments(turn.attachments);
      if (attachments.length) item.attachments = attachments;
    }
    // 063：用户轮的引用与显式技能随档冻结（重启历史气泡的标签回显来源）。
    if (turn.author === 'user' && Array.isArray(turn.references) && turn.references.length) {
      const references = sanitizeArchiveReferences(turn.references);
      if (references.length) item.references = references;
    }
    if (turn.author === 'user' && Array.isArray(turn.skills) && turn.skills.length) {
      const skills = sanitizeArchiveSkills(turn.skills);
      if (skills.length) item.skills = skills;
    }
    // 024：输入来源与消息编辑标记（旧档缺省即 voice／无标记，语义不变）。
    if (typeof turn.runId === 'string' && turn.runId) item.runId = turn.runId;
    if (turn.inputSource === 'text' || turn.inputSource === 'voice') {
      item.inputSource = turn.inputSource;
    }
    if (typeof turn.editedAt === 'number') item.editedAt = turn.editedAt;
    if (turn.withdrawn === true) item.withdrawn = true;
    if (turn.hostPersisted === true) item.hostPersisted = true;
    if (turn.taskFrozen === true) item.taskFrozen = true;
    // 048：思考与用量只随 hemi 回应落盘（白名单清洗——不补即被静默丢弃）。
    // 思考全文上限 MAX_THINKING_CHARS，超出截尾并置 truncated。
    if (turn.author === 'hemi' && turn.thinking && typeof turn.thinking === 'object') {
      const text = typeof turn.thinking.text === 'string' ? turn.thinking.text : '';
      const durationMs = Number(turn.thinking.durationMs) || 0;
      if (text || durationMs) {
        const chars = Array.from(text);
        const truncated = chars.length > MAX_THINKING_CHARS;
        item.thinking = {
          text: truncated ? `${chars.slice(0, MAX_THINKING_CHARS).join('')}…` : text,
          durationMs,
          ...(turn.thinking.interrupted === true ? { interrupted: true } : {}),
          ...(truncated ? { truncated: true } : {}),
        };
      }
    }
    // 056：回合内容按到达顺序的段（思考／正文／工具组），回看照段还原对话流。
    if (turn.author === 'hemi' && Array.isArray(turn.parts)) {
      const parts = sanitizeParts(turn.parts);
      if (parts.length) item.parts = parts;
    }
    if (turn.author === 'hemi' && turn.usage && typeof turn.usage === 'object') {
      const usage = {
        modelKey: typeof turn.usage.modelKey === 'string' ? turn.usage.modelKey : '',
        modelName: typeof turn.usage.modelName === 'string' ? turn.usage.modelName : '',
        ...(typeof turn.usage.requestedModel === 'string' && turn.usage.requestedModel ? { requestedModel: turn.usage.requestedModel } : {}),
        input: Number(turn.usage.input) || 0,
        output: Number(turn.usage.output) || 0,
        cacheRead: Number(turn.usage.cacheRead) || 0,
        cacheWrite: Number(turn.usage.cacheWrite) || 0,
        genMs: Number(turn.usage.genMs) || 0,
      };
      if (usage.input || usage.output || usage.cacheRead || usage.cacheWrite || usage.genMs) {
        item.usage = usage;
      }
    }
    clean.push(item);
  }
  return clean.length > maxTurns ? clean.slice(clean.length - maxTurns) : clean;
}

/** 会话标题（D-2）：首条用户消息截 24 字；没有就叫「新的对话」。 */
export function deriveTitle(turns) {
  const list = Array.isArray(turns) ? turns : [];
  const first = list.find(
    (turn) => turn?.author === 'user' && typeof turn.text === 'string' && turn.text.trim(),
  );
  if (!first) return '新的对话';
  const text = titleSource(list) || first.text.trim();
  const chars = Array.from(text);
  return chars.length <= TITLE_LIMIT ? text : `${chars.slice(0, TITLE_LIMIT).join('')}…`;
}

/** 记录里仍然有效的自动标题（依据＝当前首条用户消息）；作废或没有返回 null。 */
function liveAutoTitle(record, turns) {
  if (!record || record.corrupt) return null;
  if (typeof record.autoTitle !== 'string' || !record.autoTitle) return null;
  if (record.autoTitleFor !== titleSource(turns)) return null;
  return { autoTitle: record.autoTitle, autoTitleFor: record.autoTitleFor };
}

/** taskId 第三段（36 进制毫秒）→ 创建时刻；解析不了返回 0。 */
function decodeTaskTime(taskId) {
  const segment = String(taskId ?? '').split('-')[2] ?? '';
  const ms = Number.parseInt(segment, 36);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 017 会话存档修复（保存前纯函数；档案查询经注入）：
 * - 终态任务卡快照按档案记录重建——事件从渲染层截尾（7 条）换全量（截 200 条）；
 * - 错挂快照剥离（2026-09-20 真机事故：跨启动 seq 撞号，天气 turn 挂上了别的
 *   任务的快照）：turn 带稳定 ID 而快照属于别的任务＝实锤错挂；遗留档案 turn
 *   无 ID、但快照 ID 的时间成分比 turn 晚 30 分钟以上＝撞号期特征；
 * - 遗留错挂尽量找回真身：唯一「同文本 + 创建时间贴近（5 秒内）」的档案记录，
 *   找回时顺带补写 taskId（升级为稳定键）；找不回宁缺勿错（快照置空，卡不渲染）。
 * 记录不存在/未终态（在途、排队、已被容量裁剪）时保留渲染层快照不动。
 */
export function repairTaskTurns(turns, { getRecord = null, findRecordCandidate = null } = {}) {
  if (!Array.isArray(turns)) return [];
  const LEGACY_DRIFT_MS = 30 * 60 * 1000;
  return turns.map((turn) => {
    if (!turn || turn.kind !== 'task' || typeof turn.taskSeq !== 'number') return turn;
    if (turn.taskFrozen) return turn;
    const snap = turn.taskSnap && typeof turn.taskSnap === 'object' ? turn.taskSnap : null;
    const snapTaskId = typeof snap?.taskId === 'string' ? snap.taskId : null;
    const foreign = Boolean(turn.taskId && snapTaskId && snapTaskId !== turn.taskId);
    const legacyForeign = Boolean(
      !turn.taskId
      && snapTaskId
      && decodeTaskTime(snapTaskId) - (turn.createdAt ?? 0) > LEGACY_DRIFT_MS,
    );

    // 确定这个 turn 真正的任务 ID：现成的优先；遗留档案尝试找真身。
    let taskId = turn.taskId ?? null;
    if (!taskId && findRecordCandidate) {
      const found = findRecordCandidate({
        text: turn.text,
        createdAt: turn.createdAt ?? 0,
        exclude: [snapTaskId].filter(Boolean),
      });
      if (found) taskId = found;
    }

    // 有可信 ID 且档案已终态 → 按记录重建快照（全量事件）。
    // 2026-09-29 会话审计：应用退出打断的任务（interrupted、无终态）也重建——
    // 存档快照定格在运行态，历史卡会永远转圈；重建后 outcome 缺省按 unknown，
    // 「继续执行」按钮不丢（unknown 本就可续跑）。
    if (taskId && getRecord) {
      const record = getRecord(taskId);
      if (record && !record.corrupt && (record.outcome || record.interrupted)) {
        return { ...turn, taskId, taskSnap: snapshotFromRecord(record, turn.taskSeq) };
      }
    }

    // 找不回可信快照：错挂的剥掉（宁缺勿错），其余保持原样。
    if (foreign || legacyForeign) {
      return { ...turn, taskSnap: undefined };
    }
    return turn;
  });
}

/** 列表视图（不带全文）。 */
export function buildSessionView(record) {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    turnCount: Array.isArray(record.turns) ? record.turns.length : 0,
    status: conversationStatus(record.flow),
    unreadAt: typeof record.unreadAt === 'number' && record.unreadAt > 0 ? record.unreadAt : null,
    // 031：会话选中的模型配置组（缺省/null＝用默认组；旧档无此字段）。
    profileId: record.profileId ?? null,
    // 033：会话绑定的工作区身份（缺省/null＝旧会话，沿用家目录执行语义）。
    workspaceId: record.workspaceId ?? null,
  };
}

/** 渲染层旧快照不能抹掉主进程已确认的回复/任务；编辑标记仍由渲染层更新。 */
export function mergeHostTurns(existing, incoming) {
  const turns = [...incoming];
  for (const saved of existing) {
    if (!saved.hostPersisted) continue;
    let index = turns.findIndex((turn) => turn.id === saved.id);
    // 旧渲染层/既有档案的任务卡可能使用随机 ID，按 taskId 对齐同一张活卡。
    if (index < 0 && saved.kind === 'task') {
      index = turns.findIndex((turn) => turn.kind === 'task' && !turn.taskFrozen && turn.taskId === saved.taskId);
    }
    // 旧档案已交代的终态保留原位置，避免打开旧会话时补出同文气泡。
    if (index < 0 && saved.taskId && saved.kind !== 'task') {
      index = turns.findIndex((turn) => turn.kind !== 'task' && turn.taskId === saved.taskId && turn.text === saved.text);
    }
    if (index >= 0) {
      const incomingTurn = turns[index];
      const merged = { ...saved, ...incomingTurn, hostPersisted: true };
      if (saved.author === 'hemi' && saved.kind !== 'task') {
        merged.text = saved.text;
        merged.createdAt = saved.createdAt;
        if (saved.thinking) merged.thinking = saved.thinking;
        if (saved.usage) merged.usage = saved.usage;
        if (saved.parts) merged.parts = saved.parts;
      }
      turns[index] = merged;
    } else turns.push(saved);
  }
  return turns.sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_TURNS);
}

/**
 * 024 回卷剪除键（2026-10-10 仿 zcode 语义改版）：编辑重发把编辑点之后的
 * 条目整段撤下；条目 id 与任务 taskId 并入档案 cutKeys 持久化，防止宿主
 * 回写（mergeHostTurns／appendHostTurns／restoreTaskResults 补终态）把它们
 * 复活。键只增不减——taskId 全局唯一不复用，没有「撤销剪除」的路径。
 */
const MAX_CUT_KEYS = 512;

export function sanitizeCutKeys(keys, limit = MAX_CUT_KEYS) {
  if (!Array.isArray(keys)) return [];
  const out = [];
  const seen = new Set();
  for (const key of keys) {
    if (typeof key !== 'string' || !key || key.length > 128 || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= limit) break;
  }
  return out;
}

/** 条目命中剪除键（自身 id 或所属任务）即视为已撤下。 */
export function isCutTurn(turn, cutKeys) {
  if (!cutKeys || cutKeys.length === 0) return false;
  return cutKeys.includes(turn.id) || Boolean(turn.taskId && cutKeys.includes(turn.taskId));
}

/** 过滤掉命中的条目（剪除对存量与来件同时生效——来件可能来自撤下前的旧视图）。 */
export function dropCutTurns(turns, cutKeys) {
  if (!cutKeys || cutKeys.length === 0) return turns;
  return turns.filter((turn) => !isCutTurn(turn, cutKeys));
}

/**
 * 会话存储工厂。
 * @param {object} options
 * @param {string} options.dir 存储目录（注入以便测试；生产为 userData/conversations）
 * @param {Function} options.log
 * @param {number} options.maxSessions 会话数量上限
 */
export function createConversationStore({ dir, log = null, maxSessions = MAX_SESSIONS } = {}) {
  if (!dir) throw new Error('conversation-store 缺少存储目录');
  let storageError = null;

  function sessionPath(id) {
    if (!SESSION_ID_RE.test(String(id))) {
      throw new Error(`非法会话 ID：${id}`);
    }
    return path.join(dir, `${id}.json`);
  }

  function writeFile(record) {
    noteActivity('conversation-save');
    const target = sessionPath(record.id);
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, target); // 同目录 rename：原子替换（对齐 task-history D-1）
  }

  function readSessionFile(id) {
    if (!SESSION_ID_RE.test(String(id))) return null;
    let raw;
    try {
      raw = readFileSync(sessionPath(id), 'utf8');
    } catch {
      return null; // 不存在（并发删除等）：视为没有
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.turns)) {
        throw new Error('结构不完整');
      }
      return parsed;
    } catch {
      return { corrupt: true, id };
    }
  }

  /** 全量保存（D-3，渲染层防抖后调用）：upsert——已有会话保 createdAt；
   *  手动重命名过的标题跨保存保留（customTitle 优先于派生标题）。
   *  removedTurnKeys＝024 回卷剪除键：并入档案 cutKeys，剪除对存量与来件同时生效。
   *  keepUpdatedAt＝恢复性回写（补档/修复）专用：内容落盘但不改「最近对话」时间。 */
  function saveSession({ id, turns, profileId = null, workspaceId = undefined, now = Date.now(), hostWrite = false, removedTurnKeys = [], keepUpdatedAt = false, agentSessionOverride = undefined }) {
    const sessionId = String(id ?? '');
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new Error(`非法会话 ID：${sessionId}`); // 受理闸：坏 id 不落盘（对齐 009）
    }
    let clean = sanitizeTurns(turns);
    mkdirSync(dir, { recursive: true });
    const existing = readSessionFile(sessionId);
    // 单次外部来件有界；已存的撤回身份不裁掉，否则满 512 项后的编辑既不作废
    // 旧实例，也挡不住历史任务补档。墓碑只增不减，普通保存同样必须保留。
    const savedCutKeys = sanitizeCutKeys(existing && !existing.corrupt ? existing.cutKeys : [], Infinity);
    const cutKeys = [...new Set([...savedCutKeys, ...sanitizeCutKeys(removedTurnKeys)])];
    // 本次保存是否真的新增了剪除键——重复携带同一批键的防抖回写不算（IPC 层
    // 据此只在剪除真正发生时作废主 agent，否则回卷后的补存档会把新回合再杀一次）。
    const cutKeysGrew = cutKeys.length > savedCutKeys.length;
    clean = dropCutTurns(clean, cutKeys);
    if (existing && !existing.corrupt && !hostWrite) {
      clean = mergeHostTurns(dropCutTurns(sanitizeTurns(existing.turns), cutKeys), clean);
    }
    // 048：账本由主进程追加维护——渲染层整表保存不带账本字段，这里原样保留
    // 旧档账本（防 800ms 防抖回写把主进程追加的记录冲掉）。
    const usageLedger = existing && !existing.corrupt && Array.isArray(existing.usageLedger)
      ? sanitizeUsageRecords(existing.usageLedger)
      : [];
    // 056：主 agent 的 Pi 会话条目（header＋entries）同样主进程专属——渲染层保存
    // 不携带，原样保留；读写走 saveAgentSession（专字段更新，不动 updatedAt）。
    // 055 的 brainSession 字段随脑手分层退役（未发布不留兼容，下次保存即丢弃）。
    // 回卷必须同时更新模型历史。旧 saveConversation 剪除路径没有 inputId 锚点，
    // 保守清掉 SDK 历史，下次按保留下来的 turns 重建；普通保存仍原样保留。
    const agentSession = agentSessionOverride !== undefined
      ? agentSessionOverride
      : cutKeysGrew ? null : existing && !existing.corrupt ? existing.agentSession : undefined;
    const customTitle =
      existing && !existing.corrupt && typeof existing.customTitle === 'string'
        ? existing.customTitle
        : undefined;
    // P1 自动标题：生成依据（首条用户消息）没变才沿用；首条被编辑即作废，等重新生成。
    const autoTitle = liveAutoTitle(existing, clean);
    const record = {
      version: CONVERSATION_VERSION,
      id: sessionId, // 非法 id 在这里抛（sessionPath）
      title: customTitle ?? autoTitle?.autoTitle ?? deriveTitle(clean),
      ...(customTitle !== undefined ? { customTitle } : {}),
      ...(autoTitle ?? {}),
      // 031：会话级模型选择（null＝默认组）；显式传 undefined 保留旧档已存选择。
      profileId:
        profileId !== undefined && typeof profileId === 'string' && profileId
          ? profileId
          : existing && !existing.corrupt && typeof existing.profileId === 'string'
            ? existing.profileId
            : null,
      // 033：会话绑定的工作区身份（'default' 或项目 id；null＝旧会话家目录语义）。
      // 与 profileId 同款三态：payload 带键即写（null 也写），缺键保留旧档。
      workspaceId:
        workspaceId !== undefined && typeof workspaceId === 'string' && workspaceId
          ? workspaceId
          : workspaceId === null
            ? null
            : existing && !existing.corrupt && typeof existing.workspaceId === 'string'
              ? existing.workspaceId
              : null,
      createdAt: existing && !existing.corrupt ? existing.createdAt : now,
      updatedAt: now,
      turns: clean,
      ...(cutKeys.length ? { cutKeys } : {}),
      ...(usageLedger.length ? { usageLedger } : {}),
      ...(agentSession ? { agentSession } : {}),
      ...(existing?.runtimeDiagnostics?.length ? { runtimeDiagnostics: existing.runtimeDiagnostics } : {}),
      // 未读由宿主收口产生；渲染层防抖保存不能抹除或伪造已读信息。
      ...(existing && !existing.corrupt ? { unreadAt: existing.unreadAt ?? null, lastReadAt: existing.lastReadAt ?? null } : {}),
      // 057：对话流快照（flow-store 写入，主进程专属）——渲染层保存不携带，原样保留，
      // 防整档回写把 flow 冲掉（与 agentSession 同款口径；S3 统一写入链后收敛）。
      ...(existing && !existing.corrupt && existing.flow && typeof existing.flow === 'object' ? { flow: existing.flow } : {}),
    };
    // 内容没变的保存不算「更新」：渲染层打开会话后会把同一份内容防抖回写，
    // 若照常刷新 updatedAt，只是点开看一眼的会话也会被顶到列表最前
    // （2026-10-03 走查：点左侧会话列表时行序跳动）。不重写文件、不动时间。
    // 对比走净化后的口径（2026-10-11）：旧档遗留的白名单外历史标记（stale/
    // pendingResend 等）会在净化时消失，按原文对比会让点开旧会话的原样回写
    // 被当成内容变化，整档重写并刷新 updatedAt（旧会话被顶进「今天」）。
    const normalizedExisting = existing && !existing.corrupt
      ? dropCutTurns(sanitizeTurns(existing.turns), cutKeys)
      : null;
    const turnsUnchanged = normalizedExisting !== null
      && JSON.stringify(normalizedExisting) === JSON.stringify(clean);
    if (
      existing
      && !existing.corrupt
      && existing.title === record.title
      && (existing.profileId ?? null) === record.profileId
      && (existing.workspaceId ?? null) === record.workspaceId
      && JSON.stringify(existing.cutKeys ?? []) === JSON.stringify(cutKeys)
      && (existing.agentSession === agentSession || JSON.stringify(existing.agentSession ?? null) === JSON.stringify(agentSession ?? null))
      && turnsUnchanged
    ) {
      // unchanged：本次没写盘——IPC 层据此跳过 conversation:changed 广播，
      // 免得任务运行期的重复防抖保存把侧栏列表刷个不停。
      return { ok: true, unchanged: true, session: buildSessionView(existing), cutKeysGrew };
    }
    // 迁移性改写不算「最近对话」活动：turns 内容没变（只是标题重推导等净化
    // 收敛），或宿主恢复性回写显式带 keepUpdatedAt——照常落盘迁移，但保留原
    // updatedAt（点开旧会话不顶到「今天」）。touched:false 告知 IPC 层不触发
    // 自动起名（补起名只看真内容变化）。
    const preserveTs = (turnsUnchanged || keepUpdatedAt)
      && existing && !existing.corrupt && Number(existing.updatedAt) > 0;
    const finalRecord = preserveTs ? { ...record, updatedAt: Number(existing.updatedAt) } : record;
    try {
      writeFile(finalRecord);
      storageError = null;
    } catch (error) {
      storageError = `会话写入失败：${error.message}`;
      log?.warn(`[conversation] 保存失败（${sessionId}）：${error.message}`);
      return { ok: false, storageError };
    }
    prune({ keep: sessionId });
    return { ok: true, session: buildSessionView(finalRecord), cutKeysGrew, ...(preserveTs ? { touched: false } : {}) };
  }

  /** 宿主受理/终态写入；已删除的会话不得被后台结果复活，被剪除的条目同理（cutKeys）。
   *  keepUpdatedAt：恢复性回写（restoreTaskResults 补档/快照修复）不改「最近对话」时间。 */
  function appendHostTurns(id, turns, { keepUpdatedAt = false } = {}) {
    const existing = readSessionFile(id);
    if (!existing || existing.corrupt) return { ok: false, storageError: '会话不存在' };
    const cutKeys = sanitizeCutKeys(existing.cutKeys, Infinity);
    const byId = new Map(dropCutTurns(existing.turns, cutKeys).map((turn) => [turn.id, turn]));
    for (const turn of dropCutTurns(sanitizeTurns(turns), cutKeys)) {
      // bug#15：续用（runs 递增）时先把旧活卡就地冻结（旧运行记录不被新状态覆盖，
      // A-05）——渲染层并入已有同款「冻结旧卡＋新活卡」先例；新轮随后以 :r{n} id 追加。
      if (turn.kind === 'task') {
        const live = existing.turns.find((saved) => saved.kind === 'task' && !saved.taskFrozen && saved.taskId === turn.taskId);
        if (live && (turn.taskSnap?.runs ?? 1) > (live.taskSnap?.runs ?? 1)) {
          live.taskFrozen = true;
          const mapped = byId.get(live.id);
          if (mapped && mapped !== live) byId.set(live.id, { ...mapped, taskFrozen: true });
        }
      }
      const match = existing.turns.find((saved) => turn.kind === 'task'
        ? saved.kind === 'task' && !saved.taskFrozen && saved.taskId === turn.taskId
          && (saved.taskSnap?.runs ?? 1) === (turn.taskSnap?.runs ?? 1)
        : saved.id === turn.id
          // 同任务的终态交代按时间去重（2026-10-11）：050 起交代文本＝交付正文，
          // 与旧档的播报文案不等，按文本对不上——终态交代都落在任务结束后
          // 1s 内（实测 +12~38ms），阶段简报严格在结束前；已有旧交代就不按
          // 新文案补第二条。
          || (turn.taskId && saved.taskId === turn.taskId && saved.kind !== 'task'
            && (saved.text === turn.text || saved.createdAt >= turn.createdAt - 1000)));
      if (!match) {
        const stableId = byId.get(turn.id)?.taskFrozen ? `${turn.id}:live` : turn.id;
        byId.set(stableId, { ...turn, id: stableId, hostPersisted: true });
        continue;
      }
      // 命中的是同任务的旧文案交代：已有为准，不按新正文整条替换、不重复补。
      if (turn.kind !== 'task' && match.id !== turn.id && match.text !== turn.text) continue;
      byId.set(match.id, {
        ...match, ...turn, id: match.id, hostPersisted: true, createdAt: match.createdAt,
      });
    }
    // 与 mergeHostTurns 同款按 createdAt 排序：恢复路径写出的顺序必须与渲染层
    // 回写路径一致，否则紧随其后的防抖回写会因顺序差异再判一次「内容变了」
    // （2026-10-11：点开旧会话被顶到「今天」的第二触发源）。
    return saveSession({
      id,
      turns: [...byId.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
      profileId: undefined,
      hostWrite: true,
      keepUpdatedAt,
    });
  }

  function appendRuntimeDiagnostic(id, diagnostic) {
    const existing = readSessionFile(id);
    if (!existing || existing.corrupt || diagnostic?.conversationId !== id) return false;
    const recent = (existing.runtimeDiagnostics ?? []).filter((item) => item.requestId !== diagnostic.requestId);
    try {
      writeFile({ ...existing, runtimeDiagnostics: [...recent, diagnostic].slice(-40) });
      return true;
    } catch (error) {
      log?.warn(`诊断记录写入失败：${error.message}`);
      return false;
    }
  }

  /** 024 双击重命名：改 customTitle（title 同步为生效标题）；空串回退派生标题。
   *  不动 updatedAt（改名不改变「最近」语义）。会话不存在返回 null。 */
  function renameSession(id, rawTitle) {
    const sessionId = String(id ?? '');
    const record = readSessionFile(sessionId);
    if (!record || record.corrupt) return null;
    const customTitle = normalizeCustomTitle(rawTitle);
    const fallback = liveAutoTitle(record, record.turns)?.autoTitle ?? deriveTitle(record.turns);
    const next = {
      ...record,
      ...(customTitle !== null ? { customTitle, title: customTitle } : { customTitle: undefined, title: fallback }),
    };
    try {
      writeFile(next);
    } catch (error) {
      storageError = `会话重命名失败：${error.message}`;
      log?.warn(`[conversation] 重命名失败（${sessionId}）：${error.message}`);
      return { ok: false, storageError };
    }
    return { ok: true, session: buildSessionView(next) };
  }

  /** P1 自动标题候选：没手动标题、没有对得上当前首条消息的自动标题、且首轮已有回复。 */
  function autoTitleCandidate(id) {
    const record = readSessionFile(String(id ?? ''));
    if (!record || record.corrupt || typeof record.customTitle === 'string') return null;
    const turns = sanitizeTurns(record.turns);
    const source = titleSource(turns);
    const reply = firstReply(turns);
    if (!source || !reply || liveAutoTitle(record, turns)) return null;
    return { source, reply, profileId: typeof record.profileId === 'string' ? record.profileId : null };
  }

  /** P1 写入自动标题：手动标题在、或依据已变（生成期间首条被编辑）则放弃。
   *  不动 updatedAt（起名不改变「最近」语义，与重命名同口径）。 */
  function setAutoTitle(id, { title, source } = {}) {
    const sessionId = String(id ?? '');
    const record = readSessionFile(sessionId);
    if (!record || record.corrupt || typeof record.customTitle === 'string') return null;
    if (typeof title !== 'string' || !title || titleSource(sanitizeTurns(record.turns)) !== source) return null;
    const next = { ...record, title, autoTitle: title, autoTitleFor: source };
    try {
      writeFile(next);
    } catch (error) {
      log?.warn(`[conversation] 自动标题写入失败（${sessionId}）：${error.message}`);
      return { ok: false };
    }
    return { ok: true, session: buildSessionView(next) };
  }

  /** 全文读取（历史列表点开 / 启动种子化共用）；损坏或不存在返回 null。 */
  function getSession(id) {
    const record = readSessionFile(String(id ?? ''));
    if (!record || record.corrupt) return null;
    return { ...record, turns: sanitizeTurns(record.turns) };
  }

  /** 与 ZCode expectedUnreadAt 同义：旧清读回执不能吃掉后来到达的新结果。 */
  function markRead(id, expectedUnreadAt) {
    const record = readSessionFile(String(id ?? ''));
    if (!record || record.corrupt) throw new Error('找不到该会话（可能已被删除）');
    if (typeof expectedUnreadAt !== 'number' || expectedUnreadAt <= 0 || record.unreadAt !== expectedUnreadAt) {
      return { ok: true, unchanged: true, unreadAt: record.unreadAt ?? null };
    }
    writeFile({ ...record, unreadAt: null, lastReadAt: expectedUnreadAt });
    return { ok: true, unreadAt: null };
  }

  /**
   * 048：主进程追加一条用量记录（对话侧；渲染层不触碰账本）。会话不存在或
   * 损坏返回 false（如新会话首回合档案未落——记录丢一条不致命，下一次会追上）。
   * 不动 updatedAt（账本追加不是「最近对话」语义）。
   */
  function appendUsageRecord(id, record) {
    const sessionId = String(id ?? '');
    const existing = readSessionFile(sessionId);
    if (!existing || existing.corrupt) return false;
    const next = {
      ...existing,
      usageLedger: sanitizeUsageRecords([...(existing.usageLedger ?? []), record]),
    };
    try {
      writeFile(next);
    } catch (error) {
      log?.warn(`[conversation] 用量记录写入失败（${sessionId}）：${error.message}`);
      return false;
    }
    return true;
  }

  /** 最近会话（R-01 启动继续上次对话）：按 updatedAt 取最新。 */
  function lastSession() {
    const { sessions } = listSessions();
    const newest = sessions
      .filter((view) => !view.corrupt)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    return newest ? getSession(newest.id) : null;
  }

  /**
   * 056：主 agent 的 Pi 会话条目专字段读写。写＝读改写原文件（只换
   * agentSession 字段，不动 updatedAt——条目落档不是「最近对话」活动，
   * 回合本身已经通过 appendHostTurns 刷过时间）；结构异常按无处理。
   */
  function getAgentSession(id) {
    const record = readSessionFile(String(id ?? ''));
    if (!record || record.corrupt) return null;
    const stored = record.agentSession;
    if (!stored || typeof stored !== 'object' || !Array.isArray(stored.entries)) return null;
    return stored;
  }

  /** 057 S3-2d：宿主侧回卷剪除——只并键不携带 turns（渲染层不再整表回写）。
   *  返回 cutKeysGrew 供调用方触发主 agent 作废。 */
  function applyCutKeys(id, keys, { targetInputId = null } = {}) {
    const existing = readSessionFile(id);
    if (!existing || existing.corrupt) return { ok: false, storageError: '会话不存在' };
    if (targetInputId) {
      let index = existing.turns.findIndex((turn) => turn.author === 'user' && turn.id === targetInputId);
      const timeline = existing.flow?.timeline ?? [];
      const flowIndex = timeline.findIndex(item => item.kind === 'user' && item.id === targetInputId);
      const flowTail = flowIndex < 0 ? [] : timeline.slice(flowIndex);
      const flowInputIds = new Set(flowTail.filter(item => item.kind === 'user').map(item => item.id));
      const flowRunIds = new Set(flowTail.map(item => item.runId).filter(Boolean));
      // 059 旧补参轮只写 flow；正式用户身份仍然有效，不能因 turns 缺项拒绝编辑。
      // 按 flow 的后续运行定位 turns 裁剪点，保留编辑点之前的正常聊天历史。
      if (index < 0 && flowIndex >= 0 && !existing.cutKeys?.includes(targetInputId)) {
        index = existing.turns.findIndex(turn => flowInputIds.has(turn.id) || (turn.runId && flowRunIds.has(turn.runId)));
        if (index < 0) index = existing.turns.length;
      }
      if (index < 0) {
        if (existing.cutKeys?.includes(targetInputId)) {
          return { ok: true, unchanged: true, cutKeysGrew: false, session: buildSessionView(existing) };
        }
        return { ok: false, storageError: '编辑的消息已不存在，请重新打开会话' };
      }
      // 展示行 ID（run:a:input）与归档回答 ID（reply-…）不同，不能只用渲染层
      // 传来的键。以持久化用户身份定位，将这一轮及其后全部归档身份纳入剪除。
      const removed = existing.turns.slice(index);
      const removedTurnKeys = [...new Set([
        targetInputId, ...flowInputIds, ...removed.map(turn => turn.id),
        ...removed.flatMap(turn => turn.taskId ? [turn.taskId] : []), ...sanitizeCutKeys(keys),
      ])];
      const stored = existing.agentSession;
      const anchor = Array.isArray(stored?.entries) ? stored.entries.findIndex((entry) => entry.type === 'custom'
        && entry.customType === 'hemi.input' && entry.data?.inputId === targetInputId) : -1;
      // 无锚点的旧档（或编辑点已被压缩）不能保留含旧目标的摘要，按保留 turns 重建。
      const agentSessionOverride = anchor >= 0
        ? { ...stored, entries: stored.entries.slice(0, anchor) }
        : null;
      return saveSession({
        id, turns: existing.turns.slice(0, index), hostWrite: true,
        profileId: existing.profileId, workspaceId: existing.workspaceId,
        removedTurnKeys, keepUpdatedAt: true, agentSessionOverride,
      });
    }
    return saveSession({
      id,
      turns: dropCutTurns(sanitizeTurns(existing.turns), [...new Set([...sanitizeCutKeys(existing.cutKeys ?? [], Infinity), ...sanitizeCutKeys(keys)])]),
      profileId: existing.profileId, workspaceId: existing.workspaceId,
      removedTurnKeys: keys,
      keepUpdatedAt: true,
    });
  }

  function saveAgentSession(id, payload) {
    const record = readSessionFile(String(id ?? ''));
    if (!record || record.corrupt) return false;
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entries)) return false;
    const { brainSession: _retired, ...rest } = record;
    const next = { ...rest, agentSession: { header: payload.header ?? null, entries: payload.entries } };
    try {
      writeFile(next);
      return true;
    } catch (error) {
      log?.warn?.(`[conversation] 主 agent 条目写入失败（${id}）：${error.message}`);
      return false;
    }
  }

  /** 手动排序索引：读 order-index.json 的 id 序列（容忍缺失/损坏→无手动序）。 */
  function readOrderIds() {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, ORDER_FILE), 'utf8'));
      if (parsed && Array.isArray(parsed.ids)) {
        return parsed.ids.filter((id) => typeof id === 'string' && SESSION_ID_RE.test(id));
      }
    } catch {
      // 无索引或索引损坏：无手动序（首次拖拽前/异常输入，静默回退时间序）
    }
    return [];
  }

  /** 024 拖拽排序：全量写入手动顺序（渲染层发当前完整列表序）。只收存在的
   *  会话 id，去重保序；写入失败记 storageError 不抛。 */
  function reorderSessions(ids) {
    const seen = new Set();
    const ordered = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const sessionId = String(id ?? '');
      if (!SESSION_ID_RE.test(sessionId) || seen.has(sessionId)) continue;
      const record = readSessionFile(sessionId);
      if (!record || record.corrupt) continue;
      seen.add(sessionId);
      ordered.push(sessionId);
    }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, ORDER_FILE), JSON.stringify({ version: 1, ids: ordered }, null, 2), 'utf8');
      storageError = null;
      return { ok: true, count: ordered.length };
    } catch (error) {
      storageError = `会话排序写入失败：${error.message}`;
      log?.warn(`[conversation] 排序写入失败：${error.message}`);
      return { ok: false, storageError };
    }
  }

  /** 列表：未进手动序的按新→旧在前（新会话置顶），手动序过的按用户顺序
   *  稳定在后；损坏文件以 corrupt 条目殿后呈现，外来 JSON 直接跳过。 */
  function listSessions() {
    let ids = [];
    try {
      mkdirSync(dir, { recursive: true });
      ids = readdirSync(dir)
        .filter((name) => name.endsWith('.json') && !name.includes('.tmp-') && name !== ORDER_FILE)
        .map((name) => name.slice(0, -'.json'.length));
    } catch (error) {
      return { sessions: [], storageError: `会话目录不可读：${error.message}` };
    }
    const manualIds = readOrderIds();
    const manualRank = new Map(manualIds.map((id, index) => [id, index]));
    const sessions = [];
    for (const id of ids) {
      const record = readSessionFile(id);
      if (!record) continue; // 非会话命名或文件消失：跳过
      if (record.corrupt) {
        sessions.push({ id, title: '(记录损坏)', createdAt: 0, updatedAt: 0, turnCount: 0, corrupt: true });
        continue;
      }
      sessions.push(buildSessionView(record));
    }
    sessions.sort((a, b) => {
      const ra = manualRank.has(a.id);
      const rb = manualRank.has(b.id);
      if (ra && rb) return manualRank.get(a.id) - manualRank.get(b.id);
      if (ra) return 1; // 手动序整体在未排序之后
      if (rb) return -1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return { sessions, storageError };
  }

  function deleteSession(id) {
    try {
      rmSync(sessionPath(String(id ?? '')), { force: true });
      return true;
    } catch (error) {
      storageError = `删除会话失败：${error.message}`;
      log?.warn(`[conversation] 删除失败（${id}）：${error.message}`);
      return false;
    }
  }

  /** 容量裁剪（R-06）：按 updatedAt 留最新 maxSessions 个；刚保存的会话不裁。 */
  function prune({ keep = null } = {}) {
    const { sessions } = listSessions();
    const ordered = sessions
      .filter((view) => !view.corrupt)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    let removed = 0;
    for (const view of ordered.slice(maxSessions)) {
      if (view.id === keep) continue;
      deleteSession(view.id);
      removed += 1;
    }
    if (removed) log?.info(`[conversation] 容量裁剪移除 ${removed} 个会话`);
  }

  return {
    saveSession,
    applyCutKeys,
    appendHostTurns,
    appendRuntimeDiagnostic,
    renameSession,
    reorderSessions,
    getSession,
    markRead,
    lastSession,
    listSessions,
    deleteSession,
    getAgentSession,
    saveAgentSession,
    autoTitleCandidate,
    setAutoTitle,
    appendUsageRecord,
  };
}
