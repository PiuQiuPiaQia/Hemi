// 009 任务历史存储：每任务一个 JSON 文件 + 临时文件 rename 原子替换（D-1）。
//
// 职责：任务事实落盘（原话/转向/全量事件/完整报告/终态）、重启恢复扫描
// （中断补标，不续跑 D-4）、容量裁剪（50 条 D-6）、损坏容忍（corrupt 条目可见）。
// 纯函数与 IO 分离：ID/视图/终态判定可离线单测；IO 经注入目录离线覆盖。
//
// 边界：本模块只管记录——继续执行归 011，核验归 010；写失败不静默
// （受理路径抛错、其余路径返回 false 由调用方记日志）。
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { noteActivity } from '../lib/perf.mjs';
import { projectDelivery } from '../delivery/delivery.mjs';
import { artifactViews } from './artifacts.mjs';

export const HISTORY_VERSION = 1;
const ACTION_TOOLS = new Set([
  'write', 'edit',
  'ui_click', 'ui_type', 'ui_key', 'ui_scroll',
  'browser_click', 'browser_type', 'browser_act',
]);
/** 容量上限（D-6）：启动裁剪最旧。 */
export const MAX_RECORDS = 50;
/** 008 上下文摘录上限（D-3）。 */
export const CONTEXT_EXCERPT_LIMIT = 2000;
/** 004/006 全部终态 outcome（与 protocol.ts TaskOutcome 人肉同步）。 */
const TERMINAL_OUTCOMES = new Set([
  'complete',
  'stopped',
  'denied',
  'blocked',
  'partial',
  'unknown',
  'startfailed',
  'reportfailed',
]);

/** 跨重启稳定 ID（D-2）：启动序号 + 毫秒时间（36 进制）。 */
export function newTaskId(seq, now = Date.now()) {
  return `task-${seq}-${now.toString(36)}`;
}

export function isTerminalOutcome(outcome) {
  return TERMINAL_OUTCOMES.has(outcome);
}

/** 008 封装 → 摘录（前 2000 字）。 */
export function excerptContext(context, limit = CONTEXT_EXCERPT_LIMIT) {
  const text = String(context ?? '').trim();
  if (!text) return '';
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  return `${chars.slice(0, limit).join('')}\n（上下文摘录截断，原文 ${chars.length} 字）`;
}

/** 列表视图（不含事件/报告正文）。corrupt 记录在读取层单独标注。 */
export function buildRecordView(record) {
  return {
    taskId: record.taskId,
    // bug#15：续用运行次数（旧档缺省 1）。
    runs: Number(record.runs) || 1,
    taskText: record.taskText,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt ?? null,
    endedAt: record.endedAt ?? null,
    outcome: record.outcome ?? null,
    outcomeReason: record.outcomeReason ?? null,
    // 021：会话标识进视图——路由清单按会话过滤靠它（无标识的旧档案算「无主」，不进任何会话的清单）。
    conversationId: record.conversationId ?? null,
    // 024：建档来源（缺省按 voice——旧档案全是语音会话的产物）。
    inputSource: record.inputSource === 'text' ? 'text' : 'voice',
    // 033：受理时冻结的工作区快照（null＝旧任务，家目录执行语义）。
    workspace: record.workspace ?? null,
    interrupted: Boolean(record.interrupted),
    pendingOnly: Boolean(record.pendingOnly),
    steeredCount: record.steeredCount ?? 0,
    hasReport: typeof record.report === 'string' && record.report.trim().length > 0,
    // 025：历史列表头用（有交付的任务详情里会渲染结果卡）。
    hasDelivery: Boolean(record.delivery),
    // 050：有正文（新契约正文或旧档案可投影的交付）。
    hasBody: Boolean(record.resultText ?? record.delivery),
  };
}

/**
 * 017：从档案记录重建终端快照（会话存档修复用）。
 * 与渲染层截尾快照的差异在事件：这里带全量（截尾 200 条防极端膨胀），
 * 会话档案里的任务卡因此可完整回看执行历史。
 * 050 旧档案投影（AC-11，不调模型不重跑）：有 v1 delivery 的按 projectDelivery
 * 确定性投影成正文（bodySource=legacy-delivery，旧回炉句转 speechText 保留语音）；
 * 只有旧 resultText 的直接当正文（legacy-result）。投影失败降级旧 resultText。
 */
export function snapshotFromRecord(record, seq) {
  const events = Array.isArray(record.events) ? record.events : [];
  const toolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  // 启动恢复只标 interrupted，不伪造执行终态；投影时仍需说明实际中断原因。
  const outcomeReason = record.outcomeReason
    ?? (record.interrupted && !isTerminalOutcome(record.outcome) ? '应用退出，执行中断。' : null);
  // 历史卡不能永远写死 readOnly=true：GUI/文件/浏览器动作已经改变了外部状态，
  // 会话载入后仍应显示与实时卡一致的 reading 派生位。not-executed 不算动手。
  const acted = toolCalls.some(
    (call) => ACTION_TOOLS.has(call?.tool) && call?.actionState !== 'not-executed',
  );
  const verifications = Array.isArray(record.verifications) ? record.verifications : [];
  const lastVerification = verifications.at(-1) ?? null;
  const stageEvent = [...events].reverse()
    .find((event) => String(event?.text ?? '').startsWith('阶段成果：'));
  // ---- 050 正文契约字段与旧档案投影 ----
  let bodySource = record.bodySource ?? null;
  let resultText = record.resultText ?? null;
  let speechText = record.speechText ?? null;
  if (!bodySource && record.delivery && typeof record.delivery === 'object') {
    try {
      const projected = projectDelivery(record.delivery);
      if (projected.trim()) {
        bodySource = 'legacy-delivery';
        speechText = speechText ?? record.resultText ?? null;
        resultText = projected;
      }
    } catch {
      /* 投影失败（未知块类型等）降级旧 resultText */
    }
  }
  if (!bodySource && resultText) bodySource = 'legacy-result';
  return {
    seq,
    taskId: record.taskId,
    // bug#15：恢复快照带续用运行次数（与实时快照同身份落档；旧档缺省 1）。
    runs: Number(record.runs) || 1,
    phase: 'terminal',
    outcome: record.outcome ?? 'unknown',
    taskText: record.taskText,
    startedAt: record.startedAt ?? record.createdAt ?? events[0]?.at ?? null,
    endedAt: record.endedAt ?? record.updatedAt ?? events.at(-1)?.at ?? null,
    conversationId: record.conversationId ?? null,
    ...(record.agent ? { agent: record.agent, agentTitle: record.agentTitle ?? record.agent } : {}),
    ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
    ...(record.rootRunId ? { rootRunId: record.rootRunId } : {}),
    ...(record.sessionRef ? { sessionRef: record.sessionRef, worklineId: record.worklineId, resumesTaskId: record.resumesTaskId } : {}),
    progressText: record.resultText ?? outcomeReason ?? '已结束',
    conversation: record.conversation ?? null,
    /** 024：重建快照保留建档来源（会话载入后的通知静音判定不漂移）。 */
    inputSource: record.inputSource === 'text' ? 'text' : 'voice',
    readOnly: !acted,
    verifying: false,
    verified: Boolean(lastVerification) && ['complete', 'partial'].includes(record.outcome),
    stageText: stageEvent ? String(stageEvent.text).slice('阶段成果：'.length).slice(0, 80) : null,
    permission: null,
    queueCount: 0,
    steeredCount: record.steeredCount ?? 0,
    log: events.slice(-200).map((event) => ({ at: event?.at ?? 0, text: String(event?.text ?? '') })),
    resultText,
    /** 050：正文身份与语音短交代（旧档案按上表投影）。 */
    resultVersion: record.resultVersion ?? (resultText ? 1 : 0),
    bodySource,
    speechText,
    notices: Array.isArray(record.notices) ? record.notices : [],
    sources: Array.isArray(record.sources) ? record.sources : [],
    /** 050：文件改动清单；旧档案缺省＝未记录。 */
    fileChanges: record.fileChanges
      ? {
        ...record.fileChanges,
        files: (record.fileChanges.files ?? []).map((change) => ({
          ...change,
          ...(record.fileDiffs && Object.prototype.hasOwnProperty.call(record.fileDiffs, change.path)
            ? { diffAvailable: true }
            : {}),
        })),
      }
      : null,
    outcomeReason,
    lastAction: null,
    recentToolCalls: toolCalls.slice(-20),
    approvals: record.approvals ?? null,
    verification: lastVerification
      ? {
          verdict: lastVerification.verdict ?? 'unknown',
          evidence: Array.isArray(lastVerification.evidence) ? lastVerification.evidence : [],
          unchecked: Array.isArray(lastVerification.unchecked) ? lastVerification.unchecked : [],
          at: lastVerification.at ?? record.updatedAt ?? 0,
        }
      : null,
    /** 026：结构化收尾提交（旧档案缺省）。 */
    taskResult: record.taskResult ?? null,
    /** 033：受理时冻结的工作区快照（会话载入后任务卡照常显示归属；旧档案 null）。 */
    workspace: record.workspace ?? null,
    // 057：经 artifactViews 重建（实时 stat）——available:false 进详情面「不可用」
    // 分组、EACCES 等进交付组失败原因（025 R-08 的详情面在 restoreTaskResults
    // 按档案重写任务轮后被系统性剥掉，2026-10-16 找回）。
    artifacts: artifactViews(Array.isArray(record.deliverables) ? record.deliverables : []).map((item, index) => ({
      id: item?.id ?? `art-${index + 1}`,
      kind: item?.kind === 'file' ? 'file' : 'link',
      name: String(item?.name ?? ''),
      ...(item?.kind === 'file' ? { path: String(item?.path ?? '') } : { url: String(item?.url ?? '') }),
      /** 025：交付分组展示（主成果/附件）随快照透传；旧档案缺省。 */
      ...(item?.role ? { role: item.role } : {}),
      ...(item?.mediaType ? { mediaType: item.mediaType } : {}),
      registeredAt: item?.registeredAt ?? null,
      ...(item.available === false ? { available: false } : {}),
      ...(item.availability && item.availability.state !== 'ok' ? { availability: item.availability } : {}),
    })),
    /** 025：结构化成果（会话载入后任务卡照常渲染结果卡）；旧档案 null。 */
    delivery: record.delivery ?? null,
  };
}

export function emptyRecord({ taskId, taskText, context = '', now = Date.now() }) {
  return {
    version: HISTORY_VERSION,
    taskId,
    taskText,
    contextExcerpt: excerptContext(context),
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    endedAt: null,
    pendingOnly: false,
    interrupted: false,
    outcome: null,
    outcomeReason: null,
    resultText: null,
    /** 050 正文契约：正文版本（渲染去重身份＝taskId+resultVersion）。 */
    resultVersion: 0,
    /** bug#15：续用运行次数（首轮 1；恢复快照据此与实时快照同身份落档，
     *  避免 runs 缺失的快照被写成 :live 孤儿卡轮）。 */
    runs: 1,
    /** 050：正文来源；旧档案读取时投影补 legacy-delivery / legacy-result。 */
    bodySource: null,
    /** 050：语音短交代（回炉产物）。 */
    speechText: null,
    /** 050：附带提醒（不参与终态）。 */
    notices: [],
    /** 050：来源（声明 ∩ 访问记录，终态定稿）。 */
    sources: [],
    /** 050：浏览/搜索访问记录（有界 100，溯源用）。 */
    visitedUrls: [],
    /** 050：文件改动清单（终态统计）。 */
    fileChanges: null,
    report: null,
    steeredCount: 0,
    steers: [],
    events: [],
    attempts: [],
    verifications: [],
    /** 026：结构化收尾提交；旧档案缺省兼容。 */
    taskResult: null,
    deliverables: [],
    /** 025：结构化交付（v1）；050 起新任务不再写，仅旧档案读取投影。 */
    delivery: null,
    /** 053 R-02：派单规格（受理时冻结；{ objective, doneWhen[], boundaries }）。 */
    dispatch: null,
  };
}

/**
 * 任务历史存储工厂。
 * @param {object} options
 * @param {string} options.dir 存储目录（注入以便测试；生产为 userData/task-history）
 * @param {Function} options.log
 * @param {number} options.maxRecords 容量上限
 */
export function createTaskHistory({ dir, log = null, maxRecords = MAX_RECORDS } = {}) {
  if (!dir) throw new Error('task-history 缺少存储目录');
  /** taskId → record 内存缓存：读改写都在缓存，落盘即写穿。 */
  const cache = new Map();
  let storageError = null;
  let seq = 0;

  function recordPath(taskId) {
    if (!/^task-[a-z0-9-]+$/.test(String(taskId))) {
      throw new Error(`非法任务 ID：${taskId}`);
    }
    return path.join(dir, `${taskId}.json`);
  }

  function writeFile(record) {
    noteActivity('task-history-save');
    const target = recordPath(record.taskId);
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, target); // 同目录 rename：原子替换（D-1）
  }

  function tryWrite(record, label) {
    try {
      writeFile(record);
      storageError = null;
      return true;
    } catch (error) {
      storageError = `任务记录写入失败：${error.message}`;
      log?.warn(`[history] ${label} 写盘失败（${record.taskId}）：${error.message}`);
      return false;
    }
  }

  function readRecordFile(taskId) {
    const file = recordPath(taskId);
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.taskId !== 'string') throw new Error('缺 taskId');
      return parsed;
    } catch {
      return { corrupt: true, taskId };
    }
  }

  /** 受理路径（D-2/R-01）：写失败直接抛——调用方不得承诺已受理。 */
  function createRecord({ taskText, context = '', pendingOnly = false, taskId = null, conversationId = null, inputSource = 'voice', workspace = null, dispatch = null }) {
    seq += 1;
    const now = Date.now();
    const record = emptyRecord({
      taskId: taskId ?? newTaskId(seq, now),
      taskText: String(taskText ?? '').trim(),
      context,
      now,
    });
    record.pendingOnly = Boolean(pendingOnly);
    /** 053 R-02：派单规格入档（派单方写的目标/完成标准/边界；null＝旧任务无规格）。 */
    record.dispatch = dispatch && typeof dispatch === 'object' ? {
      objective: typeof dispatch.objective === 'string' ? dispatch.objective.slice(0, 400) : null,
      doneWhen: Array.isArray(dispatch.doneWhen) ? dispatch.doneWhen.map((item) => String(item).slice(0, 200)).slice(0, 12) : [],
      boundaries: dispatch.boundaries && typeof dispatch.boundaries === 'object' ? dispatch.boundaries : null,
    } : null;
    /** 021 裁决：任务归属提交会话（新会话与旧会话不关联）。 */
    record.conversationId = typeof conversationId === 'string' && conversationId ? conversationId : null;
    /** 024：建档来源（归一化落盘，旧档案缺字段按 voice 兼容）。 */
    record.inputSource = inputSource === 'text' ? 'text' : 'voice';
    /** 033：受理时冻结的工作区快照（{ id, type, name, dir }；null＝旧任务家目录语义）。
     * 049 R-04：远端快照带 host/remoteHome；旧档案没有该字段＝本机。 */
    record.workspace =
      workspace && typeof workspace === 'object' && typeof workspace.dir === 'string' && workspace.dir
        ? {
          id: typeof workspace.id === 'string' ? workspace.id : null,
          type: workspace.type === 'project' ? 'project' : workspace.type === 'default' ? 'default' : null,
          name: String(workspace.name ?? ''),
          dir: workspace.dir,
          ...(typeof workspace.host === 'string' && workspace.host ? { host: workspace.host } : {}),
          ...(typeof workspace.remoteHome === 'string' && workspace.remoteHome ? { remoteHome: workspace.remoteHome } : {}),
        }
        : null;
    mkdirSync(dir, { recursive: true });
    writeFile(record); // 故意不捕获：受理承诺以此为闸
    cache.set(record.taskId, record);
    log?.info(`[history] 建档 ${record.taskId}（${pendingOnly ? '排队未执行' : '已受理'}${record.inputSource === 'text' ? '，文字来源' : ''}）`);
    return record;
  }

  /** 起跑：pendingOnly 记录转为正式执行（同一 taskId，D-5 寻址不漂）。 */
  function startExecution(taskId, { now = Date.now() } = {}) {
    const record = cache.get(taskId) ?? readRecordFile(taskId);
    if (!record || record.corrupt) return false;
    record.pendingOnly = false;
    record.startedAt = record.startedAt ?? now;
    record.updatedAt = now;
    record.events.push({ at: now, text: '任务开始执行。' });
    cache.set(taskId, record);
    return tryWrite(record, 'startExecution');
  }

  /** bug#15：续用（session_id）时更新运行次数——快照恢复路径据此还原 runs。 */
  function recordRuns(taskId, runs, { now = Date.now() } = {}) {
    const record = cache.get(taskId) ?? readRecordFile(taskId);
    if (!record || record.corrupt) return false;
    record.runs = Number(runs) || 1;
    record.updatedAt = now;
    cache.set(taskId, record);
    return tryWrite(record, 'recordRuns');
  }

  /** 全量事件同步（D-3）：写失败不阻断执行，置 storageError 可见。 */
  function appendEvent(taskId, text, { now = Date.now() } = {}) {
    const record = cache.get(taskId) ?? readRecordFile(taskId);
    if (!record || record.corrupt) return false;
    record.events.push({ at: now, text: String(text ?? '') });
    record.updatedAt = now;
    cache.set(taskId, record);
    return tryWrite(record, 'appendEvent');
  }

  function recordSteer(taskId, { text, accepted, at = Date.now() }) {
    const record = cache.get(taskId) ?? readRecordFile(taskId);
    if (!record || record.corrupt) return false;
    record.steers.push({ text: String(text ?? ''), accepted, at });
    record.steeredCount = record.steers.length;
    record.updatedAt = at;
    record.events.push({ at, text: accepted === 'steered' ? '新指令已并入当前任务' : '新指令已排队' });
    cache.set(taskId, record);
    return tryWrite(record, 'recordSteer');
  }

  /**
   * 终态落档：完整报告原文与正文契约字段分开存（D-3）；010 核验记录若有则入
   * verifications（append-only，重试总结不触碰）；018 过程记录（结构化工具
   * 耗时 + 审批等待）随终态入档。
   */
  function finishRecord(taskId, { agent = null, agentTitle = null, toolCallId = null, rootRunId = null, sessionRef = null, worklineId = null, resumesTaskId = null, outcome, outcomeReason = null, resultText = null, resultVersion = null, conversation = null, bodySource = null, speechText = null, notices = null, sources = null, visitedUrls = null, fileChanges = null, fileDiffs = null, report = null, verification = null, taskResult = null, toolCalls = null, approvals = null, usageByModel = null, at = Date.now() }) {
    const record = cache.get(taskId) ?? readRecordFile(taskId);
    if (!record || record.corrupt) return false;
    record.outcome = outcome;
    record.outcomeReason = outcomeReason;
    record.resultText = resultText;
    if (conversation) record.conversation = conversation;
    // 056：子 agent 角色与发起它的 task 调用 id（重启后重建的快照据此原地显示在调用处）。
    if (typeof agent === 'string' && agent) record.agent = agent;
    if (typeof agentTitle === 'string' && agentTitle) record.agentTitle = agentTitle;
    if (typeof toolCallId === 'string' && toolCallId) record.toolCallId = toolCallId;
    if (typeof rootRunId === 'string' && rootRunId) record.rootRunId = rootRunId;
    if (sessionRef) record.sessionRef = sessionRef;
    if (worklineId) record.worklineId = worklineId;
    if (resumesTaskId) record.resumesTaskId = resumesTaskId;
    if (resultVersion != null) record.resultVersion = resultVersion;
    if (bodySource != null) record.bodySource = bodySource;
    if (speechText != null) record.speechText = speechText;
    if (Array.isArray(notices)) record.notices = notices.slice(0, 8);
    if (Array.isArray(sources)) record.sources = sources.slice(0, 12);
    if (Array.isArray(visitedUrls)) record.visitedUrls = visitedUrls.slice(-100);
    // 050：文件改动清单（宿主统计；null 不覆盖已有——verify 等二次终态保留原值）。
    if (fileChanges && typeof fileChanges === 'object' && Array.isArray(fileChanges.files)) {
      record.fileChanges = {
        files: fileChanges.files.slice(0, 200),
        coverage: fileChanges.coverage === 'tools+git' ? 'tools+git' : 'tools',
        degraded: typeof fileChanges.degraded === 'string' ? fileChanges.degraded : null,
        tempExcluded: Number(fileChanges.tempExcluded) || 0,
      };
    }
    // 050 R-22：Diff 审查的入档快照（有界 20 项；null 不覆盖已有）。
    if (fileDiffs && typeof fileDiffs === 'object') {
      const clean = {};
      for (const [filePath, entry] of Object.entries(fileDiffs).slice(0, 20)) {
        if (!entry || typeof entry.diff !== 'string') continue;
        clean[filePath] = { diff: entry.diff.slice(0, 65536), truncated: Boolean(entry.truncated) };
      }
      if (Object.keys(clean).length) record.fileDiffs = clean;
    }
    if (typeof report === 'string' && report.trim()) record.report = report;
    if (taskResult && typeof taskResult === 'object') record.taskResult = taskResult;
    record.endedAt = at;
    record.updatedAt = at;
    record.pendingOnly = false;
    if (Array.isArray(toolCalls) && toolCalls.length) record.toolCalls = toolCalls.slice(-20);
    if (approvals && (approvals.count > 0 || approvals.totalWaitMs > 0)) record.approvals = approvals;
    // 048 D7：按模型聚合的用量落档（白名单清洗；空聚合不落）。
    if (usageByModel && typeof usageByModel === 'object') {
      const clean = {};
      for (const [modelId, bucket] of Object.entries(usageByModel)) {
        if (!bucket || typeof bucket !== 'object') continue;
        clean[modelId] = {
          modelKey: typeof bucket.modelKey === 'string' ? bucket.modelKey : modelId,
          modelName: typeof bucket.modelName === 'string' ? bucket.modelName : '',
          calls: Number(bucket.calls) || 0,
          input: Number(bucket.input) || 0,
          output: Number(bucket.output) || 0,
          cacheRead: Number(bucket.cacheRead) || 0,
          cacheWrite: Number(bucket.cacheWrite) || 0,
          genMs: Number(bucket.genMs) || 0,
          missing: Number(bucket.missing) || 0,
        };
      }
      if (Object.keys(clean).length) record.usageByModel = clean;
    }
    if (verification && verification.verdict) {
      record.verifications = record.verifications ?? [];
      record.verifications.push({
        verdict: verification.verdict,
        evidence: Array.isArray(verification.evidence) ? verification.evidence : [],
        unchecked: Array.isArray(verification.unchecked) ? verification.unchecked : [],
        at,
      });
    }
    cache.set(taskId, record);
    return tryWrite(record, 'finishRecord');
  }

  /** 012：产物登记（append-only，R-04；同 path/url 去重）。 */
  function appendDeliverable(taskId, artifact, { at = Date.now() } = {}) {
    const record = cache.get(taskId) ?? readRecordFile(taskId);
    if (!record || record.corrupt) return false;
    record.deliverables = record.deliverables ?? [];
    const duplicated = record.deliverables.some((item) => {
      if (!item || item.kind !== artifact.kind) return false;
      return artifact.kind === 'file' ? item.path === artifact.path : item.url === artifact.url;
    });
    if (duplicated) return true;
    record.deliverables.push({ ...artifact, registeredAt: at });
    record.updatedAt = at;
    cache.set(taskId, record);
    return tryWrite(record, 'appendDeliverable');
  }

  /**
   * 025：补充已登记产物的展示元数据（role/mediaType）。重复登记的文件在
   * appendDeliverable 里按路径去重、ID 不变（technical-plan：复用已有条目 ID，
   * live 与历史引用一致）；本函数只合并展示字段，不动登记事实。
   */
  function mergeDeliverableMeta(taskId, artifactId, meta = {}, { at = Date.now() } = {}) {
    const record = cache.get(taskId) ?? readRecordFile(taskId);
    if (!record || record.corrupt) return false;
    record.deliverables = record.deliverables ?? [];
    const artifact = record.deliverables.find((item) => item?.id === String(artifactId));
    if (!artifact) return false;
    if (meta.role === 'main' || meta.role === 'attachment') artifact.role = meta.role;
    if (typeof meta.mediaType === 'string' && meta.mediaType) artifact.mediaType = meta.mediaType;
    record.updatedAt = at;
    cache.set(taskId, record);
    return tryWrite(record, 'mergeDeliverableMeta');
  }

  /**
   * 025：交付落档（结构化成果，可选字段；R-12 诊断字段 reason/degraded 同存）。
   * 覆盖语义：执行器修正后重登时以最后一次有效登记为准。
   */
  function setDelivery(taskId, delivery, { at = Date.now() } = {}) {
    const record = cache.get(taskId) ?? readRecordFile(taskId);
    if (!record || record.corrupt) return false;
    record.delivery = delivery;
    record.updatedAt = at;
    cache.set(taskId, record);
    return tryWrite(record, 'setDelivery');
  }

  function getRecord(taskId) {
    const cached = cache.get(taskId);
    if (cached) return cached;
    const record = readRecordFile(taskId);
    if (record && !record.corrupt) cache.set(taskId, record);
    return record ?? null;
  }

  function deleteTask(taskId) {
    cache.delete(taskId);
    try {
      rmSync(recordPath(taskId), { force: true });
      return true;
    } catch (error) {
      storageError = `删除任务记录失败：${error.message}`;
      log?.warn(`[history] 删除失败（${taskId}）：${error.message}`);
      return false;
    }
  }

  /**
   * 列表：新→旧；损坏文件以 { corrupt: true } 条目呈现（AC-06）。
   * storageError 非空时列表头提示。
   */
  function listTasks() {
    let ids = [];
    try {
      mkdirSync(dir, { recursive: true });
      ids = readdirSync(dir)
        .filter((name) => name.endsWith('.json') && !name.includes('.tmp-'))
        .map((name) => name.slice(0, -'.json'.length));
    } catch (error) {
      return { tasks: [], storageError: `任务记录目录不可读：${error.message}` };
    }
    const tasks = [];
    for (const taskId of ids) {
      const record = readRecordFile(taskId);
      if (!record) continue; // 文件消失（并发删除）：跳过
      if (record.corrupt) {
        tasks.push({ taskId, taskText: '(记录损坏)', corrupt: true, createdAt: 0, updatedAt: 0 });
        continue;
      }
      cache.set(taskId, record);
      tasks.push(buildRecordView(record));
    }
    tasks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { tasks, storageError };
  }

  /** 011：继续执行 = 同 taskId 下的新尝试（D-1/D-6）：attempts 记录 + 清 interrupted。 */
  function startAttempt(taskId, { kind = 'resume', at = Date.now() } = {}) {
    const record = cache.get(taskId) ?? readRecordFile(taskId);
    if (!record || record.corrupt) return false;
    record.attempts = record.attempts ?? [];
    record.attempts.push({ at, kind });
    record.interrupted = false;
    record.updatedAt = at;
    record.events.push({ at, text: `用户发起继续执行（第 ${record.attempts.length} 次尝试）。` });
    cache.set(taskId, record);
    return tryWrite(record, 'startAttempt');
  }

  /**
   * 启动恢复（D-4/R-04）：无终态且非排队未执行的记录补标 interrupted；
   * stopped 等终态保持原样；排队记录保留「未执行」。只改记录，不触执行器。
   * 已补标过的记录跳过——重复补标会每次启动追加一条重复中断事件并重写档案
   * （2026-09-30 审计：dev task-2-muibysfa 四天攒了 13 条同文事件）；
   * startAttempt 清掉 interrupted 后再被打断的，会重新走补标。
   */
  function recoverOnBoot({ now = Date.now() } = {}) {
    let marked = 0;
    const { tasks } = listTasks();
    for (const view of tasks) {
      if (view.corrupt) continue;
      const record = getRecord(view.taskId);
      if (!record) continue;
      if (record.pendingOnly) continue; // 排队未执行：保留原样，不静默启动
      if (isTerminalOutcome(record.outcome)) continue; // 终态（含 stopped）：保持
      if (record.interrupted) continue; // 已处于目标状态：不重复追加事件
      record.interrupted = true;
      record.updatedAt = now;
      record.events.push({
        at: now,
        text: '应用退出，执行中断；以上为最后已知状态，可核对结果后决定是否继续。',
      });
      if (tryWrite(record, 'recoverOnBoot')) marked += 1;
    }
    prune();
    log?.info(`[history] 启动恢复扫描完成：补标中断 ${marked} 条`);
    return { marked };
  }

  /** 容量裁剪（D-6）：按 createdAt 留最新 maxRecords 条。 */
  function prune({ now = Date.now() } = {}) {
    const { tasks } = listTasks();
    const valid = tasks.filter((view) => !view.corrupt).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    for (const view of valid.slice(maxRecords)) {
      deleteTask(view.taskId);
      log?.info(`[history] 容量裁剪移除 ${view.taskId}`);
    }
    return now;
  }

  return {
    /** 050：存储目录（文件事实的 git diff 排除宿主自己的档案写入）。 */
    get dir() { return dir; },
    createRecord,
    startExecution,
    startAttempt,
    appendEvent,
    recordSteer,
    recordRuns,
    finishRecord,
    appendDeliverable,
    mergeDeliverableMeta,
    setDelivery,
    getRecord,
    deleteTask,
    listTasks,
    recoverOnBoot,
    excerptContext,
  };
}
