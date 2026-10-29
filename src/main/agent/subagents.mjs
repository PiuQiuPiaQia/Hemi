import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { sessionCompatibility } from '../agent-runtime/model-policy.mjs';
import { roleSessionRevision } from '../agent-runtime/session-revision.mjs';
import { readFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { diffTreeChanges, FILE_CHANGES_LIMITS, isGitRepo, mergeToolTouches, snapshotTree, unifiedDiffOf } from '../delivery/file-changes.mjs';
import { BROWSER_ACT_TOOLS, BROWSER_READ_TOOLS, VISION_ACT_TOOLS, WEB_TOOLS } from './gate/policy.mjs';
import { describeModelError } from '../lib/model-routing.mjs';
import { createTaskConversation } from './task-conversation.mjs';

/**
 * 056 · 子 agent 管理器（由 017～055 的 task-manager 收缩而来）。
 *
 * 一个子 agent＝一个角色（explorer／oracle／fixer／designer）的 Pi 会话，由主 agent
 * 的 task 工具派出。本模块是子 agent 运行态的唯一所有者：并发上限、确认环（30s
 * 主计时）、进度与过程日志、停摆看门狗、文件事实、用量账本、档案落盘，以及给
 * 渲染层的任务卡快照（task:state 通道，形状沿用 017 的 TaskStateSnapshot）。
 *
 * 与旧 task-manager 的取舍（参照 PI-Desktop ADR 0062/0166、ZCode subagent runner）：
 *   - 结果直接回到派单的主 agent（前台＝工具结果；后台＝终态事件唤醒主 agent），
 *     不再有回炉总结、只读核实、结构化收尾、自动审查——验收由主 agent 自己做；
 *   - 子会话在本对话内保活，可经 session_id 续用（同一角色、空闲时再 prompt）；
 *   - 主 agent 回合结束不连带停子 agent；只有用户停止、task_cancel、对话关闭会停；
 *   - 报告超过 MAX_REPORT_CHARS 截断回传、全文入档（PI-Desktop 12k 口径）。
 */

/** R-11/005：确认超时（30s，语音场景用户要时间看字幕）。 */
const PERMISSION_MS = 30000;
const PERMISSION_TICK_MS = 250;
/** 任务日志截尾（快照体积可控）。 */
const LOG_KEEP = 80;
/** 同时运行的子 agent 上限（PI-Desktop 每会话 10、slim 默认更低；Hemi 沿用 017 的 5）。 */
export const PARALLEL_LIMIT = 5;
/** 单个子 agent 报告回传上限（字符）；超出截断，全文在档案里。 */
export const MAX_REPORT_CHARS = 12000;
/** 结构化工具调用记录的保留条数。 */
/** 只读调研打开这么多页面后宿主提醒收手（一次）。 */
const BROWSE_NUDGE_AT = 15;
const TOOL_CALLS_KEEP = 20;
const VISITED_URLS_KEEP = 100;
const SEARCH_URL_PER_CALL = 10;
/** 终态子 agent 在快照里保留的条数（之后只在档案里）。 */
const TERMINAL_KEEP = 20;

const TOOL_STEP_LABELS = {
  write: '正在写入文件',
  edit: '正在修改文件',
  bash: '正在执行命令',
  read: '正在读取文件',
  ls: '正在查看目录',
  grep: '正在搜索内容',
  glob: '正在查找文件',
  screen_view: '正在查看屏幕',
  ui_list: '正在查看窗口列表',
  ui_tree: '正在读取界面结构',
  ui_act: '正在操作界面',
  ui_click: '正在点击界面元素',
  ui_type: '正在输入文字',
  ui_key: '正在按键',
  ui_scroll: '正在滚动界面',
  app_open: '正在打开应用',
  browser_navigate: '正在打开网页',
  browser_extract: '正在读取页面内容',
  browser_tabs: '正在查看标签页',
  browser_screenshot: '正在截取页面',
  browser_click: '正在点击网页元素',
  browser_type: '正在填写网页输入框',
  browser_act: '正在操作浏览器',
  web_search: '正在搜索资料',
  web_extract: '正在读取网页内容',
};

/** 056：只读侦察工具（过程日志也记，2026-10-15 用户反馈「看不到执行了什么」）。 */
const READ_TOOLS = ['read', 'ls', 'grep', 'glob', 'screen_view', 'ui_list', 'ui_tree', 'browser_tabs'];

const DENY_VALUE = '拒绝';
/** 各卡种合法的 decide 选项（042/052：授权卡三选一，风险卡两钮）。 */
const CHOICES_BY_KIND = { grant: ['task', 'persistent', 'deny'], action: ['task', 'once', 'deny'] };
const TASK_VALUE = '本任务允许';
const PERSISTENT_VALUE = '持续允许';
const ONCE_VALUE = '允许这次';

const SLOW_TOOL_LOG_MS = 5000;

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function fmtElapsedCn(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
}

/** 工具动作 → 日志里的人话描述（带关键参数，过程抽屉可追溯）。
 * 056（2026-10-15 用户反馈「看不到执行了什么」）：只读工具也进过程日志，
 * 描述必须带上路径/关键词——「正在读取文件」这种不带对象的标签等于没记。 */
function describeTool(tool, args = {}) {
  const shortPath = (p) => String(p ?? '').replace(/^\/Users\/[^/]+\//, '~/').slice(0, 120);
  switch (tool) {
    case 'bash': return `正在执行命令：${String(args.command ?? '').split('\n')[0].slice(0, 160)}`;
    case 'write': return `正在写入 ${shortPath(args.path)}`;
    case 'edit': return `正在修改 ${shortPath(args.path)}`;
    case 'read': return `正在读取 ${shortPath(args.path)}`;
    case 'ls': return `正在查看目录 ${shortPath(args.path)}`;
    case 'grep': {
      const where = args.path ? `（${shortPath(args.path)}）` : '';
      return `正在搜索「${String(args.pattern ?? '').slice(0, 80)}」${where}`;
    }
    case 'glob': return `正在查找文件 ${String(args.pattern ?? '').slice(0, 80)}`;
    case 'browser_navigate': return `正在打开网页 ${String(args.url ?? '').slice(0, 160)}`;
    case 'web_search': return `正在搜索「${String(args.query ?? '').slice(0, 60)}」`;
    case 'web_extract': return `正在读取网页 ${String(args.url ?? '').slice(0, 160)}`;
    case 'app_open': return `正在打开应用 ${String(args.app ?? '').slice(0, 40)}`;
    default: return TOOL_STEP_LABELS[tool] ?? `正在执行 ${tool}`;
  }
}

/** 门控拦截文案 → 终态类别（只认确认卡的精确话术；裸「超时」不算拒绝）。 */
export function classifyBlockText(text) {
  if (!text) return null;
  if (/禁止|命中/.test(text)) return 'blocked';
  if (/未获允许|拒绝了这一步/.test(text)) return 'denied';
  return null;
}

/** 报告截断（按码点）：返回 { text, truncated, total }。 */
export function clipReport(text, limit = MAX_REPORT_CHARS) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= limit) return { text: chars.join(''), truncated: false, total: chars.length };
  return { text: chars.slice(0, limit).join(''), truncated: true, total: chars.length };
}

/**
 * @param {object} deps
 * @param {(spec) => Promise<object>} deps.createSession 角色会话工厂（hemi-session 实例；
 *   spec: { role, conversationId, accessId, workspace, inputSource, modelPlan }）
 * @param {object} [deps.history] 任务档案（task-history）
 * @param {(event) => void} [deps.onTerminal] 后台子 agent 终态 → 唤醒主 agent（agent-registry 注入）
 * @param {(task) => void} [deps.onModelUsage] 用量变化（渲染层重取聚合）
 * @param {(taskId) => void} [deps.cleanupAccessTask] 终态清任务级临时授权
 */
export function createSubagentManager({
  createSession,
  restoreSession = null,
  history = null,
  onTerminal = null,
  onPermissionRequest = null,
  permissionTimeoutMs = PERMISSION_MS,
  onSettled = null,
  onModelUsage = null,
  cleanupAccessTask = null,
  onDeliveryDeclared = null,
  log = null,
  nowFn = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  stallTimeoutMs = 180_000,
  longToolTimeoutMs = 30 * 60_000,
} = {}) {
  const emitter = new EventEmitter();
  /** key → 子 agent 运行态。 */
  const tasks = new Map();
  /**
   * 主 agent 的确认请求（hostPermission 注入）：key＝`main:<conversationId>:<请求 id>`。
   * 与子 agent 共用一套 30s 主计时与 decide 口径；快照里单独列在 agentPermissions，
   * 不进 tasks（渲染层不为它插任务卡）。
   */
  const hosted = new Map();
  const admissionQueue = [];
  const drainAdmissions = () => {
    while (activeCount() < PARALLEL_LIMIT && admissionQueue.length) {
      const index = admissionQueue.findIndex(item => [...tasks.values()].filter(task => task.admitted && !task.finalized && task.rootRunId === item.task.rootRunId).length < (item.task.modelPlan?.executionContext?.budgets.maxParallelTasks ?? PARALLEL_LIMIT));
      if (index < 0) break;
      const [item] = admissionQueue.splice(index, 1);
      if (item.task.stopRequested) { item.resolve(false); continue; }
      item.task.admitted = true; item.task.cancelAdmission = null; item.resolve(true);
    }
  };
  const admit = task => new Promise(resolve => {
    const item = { task, resolve }; admissionQueue.push(item);
    task.cancelAdmission = () => { const index = admissionQueue.indexOf(item); if (index >= 0) admissionQueue.splice(index, 1); task.cancelAdmission = null; resolve(false); };
    drainAdmissions();
  });
  let seq = 0;
  let stateSeq = 0;
  let permissionTicker = null;
  let stallTicker = null;
  let streamBroadcastTimer = null;

  // ---- 快照（渲染层任务卡；形状沿用 017 TaskStateSnapshot，退役字段给空值） ----

  function taskSnapshot(task) {
    return {
      seq: task.seq,
      key: task.key,
      taskId: task.historyId ?? task.key,
      conversationId: task.conversationId ?? null,
      rootRunId: task.rootRunId ?? null,
      inputSource: task.inputSource ?? 'voice',
      workspace: task.workspace ?? null,
      /** 056：角色（任务卡徽标）与派单说明。 */
      agent: task.role.name,
      agentTitle: task.role.title,
      background: Boolean(task.background),
      phase: task.phase,
      outcome: task.outcome,
      taskText: task.description || task.prompt,
      progressText: task.progressText,
      conversation: task.conversation?.snapshot() ?? null,
      activity: task.activity ?? null,
      startedAt: task.startedAt ?? null,
      endedAt: task.endedAt ?? null,
      readOnly: task.readOnly,
      verifying: false,
      verified: false,
      stageText: null,
      permission: task.permission ? { ...task.permission } : null,
      steeredCount: task.steeredCount ?? 0,
      log: [...task.log],
      resultText: task.phase === 'terminal' ? task.resultText ?? null : null,
      resultVersion: task.resultVersion ?? 0,
      bodySource: task.resultText ? 'executor' : null,
      speechText: null,
      notices: [],
      sources: [...(task.sources ?? [])],
      fileChanges: task.fileChanges ?? null,
      fileTouchCount: (task.fileTouches ?? []).length,
      outcomeReason: task.outcomeReason ?? null,
      lastAction: task.lastAction ? { tool: task.lastAction.tool, args: { ...task.lastAction.args } } : null,
      verification: null,
      taskResult: null,
      // 057：正式交付声明（register_delivery）捕获的成果——不再固定为空。
      artifacts: [...(task.artifacts ?? [])],
      delivery: null,
      recentToolCalls: [...(task.recentToolCalls ?? [])],
      approvals: { ...(task.approvals ?? { count: 0, totalWaitMs: 0 }) },
      resumedFrom: null,
      /** 056：本次运行序号（续用同一子会话时递增）。 */
      runs: task.runs ?? 1,
      // 056：发起本次运行的主 agent task 调用 id——对话流在这次调用的位置原地显示子 agent 一行。
      toolCallId: task.toolCallId ?? null,
      sessionRef: task.sessionRef,
      worklineId: task.worklineId,
      resumesTaskId: task.resumesTaskId,
    };
  }

  function primaryTask() {
    let active = null;
    let last = null;
    for (const task of tasks.values()) {
      last = task;
      if (task.phase !== 'terminal') active = task;
    }
    return active ?? last;
  }

  function snapshot() {
    const perTask = [...tasks.values()].map(taskSnapshot);
    const primary = primaryTask();
    const legacy = primary
      ? taskSnapshot(primary)
      : {
          seq, key: null, taskId: null, phase: 'idle', outcome: null, taskText: '',
          progressText: '没有正在执行的任务', stageText: null, readOnly: true, verifying: false,
          verified: false, permission: null, steeredCount: 0, log: [], resultText: null,
          resultVersion: 0, bodySource: null, speechText: null, notices: [], sources: [],
          outcomeReason: null, lastAction: null, verification: null, taskResult: null,
          artifacts: [], delivery: null, recentToolCalls: [], approvals: null, resumedFrom: null, workspace: null,
        };
    const agentPermissions = [...hosted.values()].filter((entry) => entry.permission).map((entry) => ({
      key: entry.key,
      taskId: entry.key,
      conversationId: entry.conversationId,
      inputSource: entry.inputSource ?? 'voice',
      taskText: entry.label,
      permission: { ...entry.permission },
    }));
    return { stateSeq, seq, tasks: perTask, ...legacy, agentPermissions, queueCount: 0 };
  }

  function broadcast() {
    clearTimeout(streamBroadcastTimer);
    streamBroadcastTimer = null;
    stateSeq += 1;
    emitter.emit('change', snapshot());
  }

  function broadcastStream() {
    if (streamBroadcastTimer) return;
    streamBroadcastTimer = setTimeout(broadcast, 100);
    streamBroadcastTimer.unref?.();
  }

  function addLog(task, text) {
    const entry = { at: nowFn(), text: String(text ?? '') };
    task.log = [...task.log, entry].slice(-LOG_KEEP);
    if (task.hosted) {
      log?.info?.(`[${task.key}] ${entry.text}`);
      return;
    }
    try { history?.appendEvent?.(task.historyId, entry.text, { now: entry.at }); } catch { /* 档案失败不阻断 */ }
  }

  // ---- 确认环（每个子 agent 独立的授权请求与倒计时） ----

  function stopPermissionTicker() {
    if (permissionTicker) {
      clearIntervalFn(permissionTicker);
      permissionTicker = null;
    }
  }

  function ensurePermissionTicker() {
    if (permissionTicker || permissionTimeoutMs === 0) return;
    permissionTicker = setIntervalFn(() => {
      const now = nowFn();
      let waiting = false;
      for (const task of [...tasks.values(), ...hosted.values()]) {
        if (!task.permission) continue;
        waiting = true;
        const remaining = task.permissionDeadline - now;
        task.permission.remainingMs = Math.max(0, remaining);
        if (remaining <= 0) decide('deny', { taskKey: task.key, auto: true });
      }
      if (!waiting) stopPermissionTicker();
      broadcast();
    }, PERMISSION_TICK_MS);
    permissionTicker?.unref?.();
  }

  function handlePermission(task, request) {
    if (!task || (!task.hosted && task.phase === 'terminal')) {
      task?.session?.respondPermission(request.id, { cancelled: true });
      return;
    }
    let summary = request.title || '';
    let tool = 'unknown';
    let args = {};
    let note = null;
    let parsed = null;
    try {
      parsed = JSON.parse(request.title);
      if (parsed && typeof parsed.summary === 'string') {
        summary = parsed.summary;
        tool = typeof parsed.tool === 'string' ? parsed.tool : 'unknown';
        args = parsed.args && typeof parsed.args === 'object' ? parsed.args : {};
        if (typeof parsed.note === 'string' && parsed.note) note = parsed.note;
      }
    } catch { /* title 不是 JSON：当纯摘要用 */ }
    if (note) addLog(task, note);
    log?.info?.(`确认请求（${task.key}${task.role ? ` · ${task.role.name}` : ''}）：${summary}${note ? `｜${note}` : ''}`);
    const kind = parsed?.kind === 'grant' || parsed?.kind === 'action' ? parsed.kind : 'action';
    const options = Array.isArray(parsed?.options) && parsed.options.every((o) => typeof o === 'string')
      ? parsed.options
      : (kind === 'grant' ? [TASK_VALUE, PERSISTENT_VALUE, DENY_VALUE] : [TASK_VALUE, DENY_VALUE]);
    if (!task.hosted) task.phase = 'waiting';
    task.lastActivityAt = nowFn();
    task.permission = {
      id: request.id, summary, tool, args, note, kind, options,
      category: typeof parsed?.category === 'string' && parsed.category ? parsed.category : null,
      askedAt: nowFn(),
      remainingMs: permissionTimeoutMs,
    };
    task.permissionDeadline = nowFn() + permissionTimeoutMs;
    ensurePermissionTicker();
    onPermissionRequest?.({ conversationId: task.conversationId, rootRunId: task.rootRunId ?? null, taskKey: task.key, request, decide: value => {
      const choice = value === TASK_VALUE ? 'task' : value === PERSISTENT_VALUE ? 'persistent' : value === ONCE_VALUE ? 'once' : value === DENY_VALUE ? 'deny' : null;
      return choice ? decide(choice, { taskKey: task.key }).ok : false;
    } });
    broadcast();
  }

  /** 决定（042/052）：授权卡 task/persistent/deny，风险卡 task/once/deny；超时＝跳过本次操作。 */
  function decide(choice, { taskKey = null, auto = false } = {}) {
    const task = (taskKey && hosted.get(String(taskKey))) || (taskKey ? resolveTask(taskKey) : primaryTask());
    const permission = task?.permission;
    if (!task || !permission) return { ok: false };
    const allowed = CHOICES_BY_KIND[permission.kind] ?? CHOICES_BY_KIND.action;
    if (!allowed.includes(choice)) return { ok: false, errorCode: 'INVALID_CHOICE' };
    task.permission = null;
    if (!task.hosted) task.phase = 'running';
    if (!task.hosted && choice !== 'deny' && (permission.kind === 'action' || ['write', 'edit'].includes(permission.tool)
      || VISION_ACT_TOOLS.includes(permission.tool) || BROWSER_ACT_TOOLS.includes(permission.tool))) {
      task.readOnly = false;
    }
    const waitMs = Math.max(0, nowFn() - (permission.askedAt ?? nowFn()));
    const category = permission.category ?? (permission.kind === 'action' ? 'dangerous' : 'grant');
    task.approvals = {
      count: (task.approvals?.count ?? 0) + 1,
      totalWaitMs: (task.approvals?.totalWaitMs ?? 0) + waitMs,
      timeouts: (task.approvals?.timeouts ?? 0) + (auto ? 1 : 0),
      byCategory: { ...(task.approvals?.byCategory ?? {}), [category]: (task.approvals?.byCategory?.[category] ?? 0) + 1 },
    };
    const waitNote = fmtDuration(waitMs);
    const respond = (value) => task.session?.respondPermission(permission.id, { value });
    if (choice === 'deny') {
      if (auto) {
        task.session?.respondPermission(permission.id, { cancelled: true });
        addLog(task, `确认超时，已跳过该操作。（等待 ${waitNote}）`);
      } else {
        respond(DENY_VALUE);
        addLog(task, `已拒绝本次操作。（等待 ${waitNote}）`);
      }
    } else if (choice === 'task') {
      respond(TASK_VALUE);
      addLog(task, permission.kind === 'action'
        ? `已允许（本任务内同类操作不再询问）：${permission.summary}（等待 ${waitNote}）`
        : `已允许（本任务）：${permission.summary}（等待 ${waitNote}）`);
    } else if (choice === 'persistent') {
      respond(PERSISTENT_VALUE);
      addLog(task, `已持续允许：${permission.summary}（等待 ${waitNote}）`);
    } else {
      respond(ONCE_VALUE);
      addLog(task, `已允许本次操作：${permission.summary}（等待 ${waitNote}）`);
    }
    if (task.hosted) dropAnsweredHosted();
    broadcast();
    return { ok: true };
  }

  // ---- 停摆看门狗（工具在途＝长命令心跳；单工具超长才停） ----

  function stopStallTicker() {
    if (stallTicker) {
      clearIntervalFn(stallTicker);
      stallTicker = null;
    }
  }

  function ensureStallTicker() {
    if (stallTicker) return;
    const tickMs = Math.max(20, Math.min(15000, Math.round(stallTimeoutMs / 4)));
    const timer = setIntervalFn(() => {
      const now = nowFn();
      let runnable = false;
      let dirty = false;
      for (const task of tasks.values()) {
        if (task.phase !== 'running') continue;
        runnable = true;
        if (task.modelRequestActive || ['waiting-background', 'waiting-resource'].includes(task.activity?.phase)) {
          // 宿主有明确等待事实；后台进程的硬超时/取消负责收口，不误报模型流停摆。
          task.lastActivityAt = now;
          continue;
        }
        const active = task.activeTool;
        if (active) {
          const heldMs = now - active.startedAt;
          if (heldMs > longToolTimeoutMs) {
            const mins = Math.round(longToolTimeoutMs / 60000);
            addLog(task, `单个工具（${active.tool}）连续执行超过 ${mins} 分钟无结果，已自动停止。`);
            void stop(task.key, { reason: 'long-tool' });
            continue;
          }
          task.lastActivityAt = now;
          const next = `${task.progressBase ?? ''}（已 ${fmtElapsedCn(heldMs)}）`;
          if (next !== task.progressText) {
            task.progressText = next;
            dirty = true;
          }
          continue;
        }
        const last = Number(task.lastActivityAt ?? 0);
        if (!last || now - last <= stallTimeoutMs) continue;
        const seconds = Math.round(stallTimeoutMs / 1000);
        addLog(task, `子 agent ${seconds} 秒没有任何响应（模型流可能停摆），已自动停止。`);
        void stop(task.key, { reason: 'stall' });
      }
      if (!runnable) stopStallTicker();
      else if (dirty) broadcast();
    }, tickMs);
    timer?.unref?.();
    stallTicker = timer;
  }

  // ---- 进度 ----

  function recordVisitedUrl(task, url) {
    const value = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(value)) return;
    task.visitedUrls = [...(task.visitedUrls ?? []).filter((item) => item !== value), value].slice(-VISITED_URLS_KEEP);
  }

  function recordSearchedUrls(task, text) {
    const hits = String(text ?? '').match(/https?:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%()[\]-]+/g) ?? [];
    for (const url of hits.slice(0, SEARCH_URL_PER_CALL)) recordVisitedUrl(task, url);
  }

  /**
   * 056：只读调研的收手提醒。flash 级模型拿到「够用就停」的提示也会一路开下去（真机
   * 实录：一次调研开了 60 个页面、5 分多钟），宿主在页面数到阈值时插话一次，让它停下
   * 交付、把没看的线索列出来交主 agent 决定（主 agent 可续用同一会话接着查）。
   */
  function maybeNudgeBrowsing(task, tool) {
    if (task.role.mode !== 'verify' || task.browseNudged) return;
    if (tool !== 'browser_navigate' && tool !== 'web_extract' && tool !== 'web_search') return;
    task.pageVisits = (task.pageVisits ?? 0) + 1;
    if (task.pageVisits < BROWSE_NUDGE_AT) return;
    task.browseNudged = true;
    log?.info?.(`子 agent ${task.key} 已打开 ${task.pageVisits} 个页面，宿主提醒收手交付`);
    void task.session?.steer?.(
      `［Hemi 宿主提醒］你已经打开了 ${task.pageVisits} 个页面。停止继续浏览，基于已经看到的内容立即交付；还没核对的线索列在报告末尾，由主 agent 决定是否让你续查。`,
    )?.catch?.(() => {});
  }

  function handleProgress(task, event) {
    task.lastActivityAt = nowFn();
    if (task.phase === 'terminal') return;
    task.conversation?.progress(event);
    if (event.kind === 'tool-start') {
      task.progressBase = TOOL_STEP_LABELS[event.tool] ?? '正在执行一步操作';
      task.progressText = task.progressBase;
      task.toolExecutions ??= new Map();
      task.activeTool = { tool: event.tool, toolCallId:event.toolCallId, args:event.args, startedAt: nowFn() };
      task.toolExecutions.set(event.toolCallId ?? event.tool,task.activeTool);
      if (event.tool === 'write' || event.tool === 'edit') captureFileBefore(task, event.args?.path);
      task.lastAction = { tool: event.tool, args: event.args && typeof event.args === 'object' ? event.args : {}, at: nowFn() };
      if (['write', 'edit'].includes(event.tool) || VISION_ACT_TOOLS.includes(event.tool) || BROWSER_ACT_TOOLS.includes(event.tool)) {
        task.readOnly = false;
      }
      maybeNudgeBrowsing(task, event.tool);
    } else if (event.kind === 'tool-end') {
      const key=!event.background && event.commandId ? event.commandId : event.toolCallId ?? event.tool;
      const execution=task.toolExecutions?.get(key);
      if(event.background&&execution){
        execution.background=true;
        if(event.commandId){task.toolExecutions.delete(key);task.toolExecutions.set(event.commandId,execution);}
      }
      else task.toolExecutions?.delete(key);
      task.activeTool=[...(task.toolExecutions?.values() ?? [])].find(item=>!item.background) ?? null;
      task.progressBase = task.progressText = task.activeTool ? TOOL_STEP_LABELS[task.activeTool.tool] ?? '正在执行一步操作' : '等待模型继续';
      const endArgs = (event.args && typeof event.args === 'object' ? event.args : null)
        ?? execution?.args
        ?? (task.lastAction?.tool === event.tool ? task.lastAction?.args ?? {} : {});
      const startedAt = execution?.startedAt ?? (task.lastAction?.tool === event.tool && Number.isFinite(task.lastAction?.at) ? task.lastAction.at : null);
      const durationMs = startedAt != null ? Math.max(0, nowFn() - startedAt) : null;
      if (durationMs != null && durationMs >= SLOW_TOOL_LOG_MS) {
        log?.info?.(`慢工具 ${event.tool} ${fmtDuration(durationMs)}（${task.key}）`);
      }
      if (!event.background) task.recentToolCalls = [...(task.recentToolCalls ?? []), {
        tool: event.tool, startedAt, durationMs, isError: Boolean(event.isError),
        actionState: event.actionState ?? null, browser: event.browser ?? null,
        observationRef: event.observationRef ?? null, observationId: event.observationId ?? null,
        path: endArgs.path ?? null,
        outputExcerpt: ['read','ls','grep','glob'].includes(event.tool) || event.isError ? String(event.text ?? '').slice(0, 600) : undefined,
      }].slice(-TOOL_CALLS_KEEP);
      const durationNote = durationMs != null ? `（${fmtDuration(durationMs)}）` : '';
      const done = describeTool(event.tool, endArgs).replace(/^正在/, '');
      if (event.background) {
        if (!task.activeTool) task.progressBase = task.progressText = '等待后台命令结果';
        addLog(task, `已转后台：${done}；结果尚未确认。`);
      } else if (event.isError) {
        const kind = classifyBlockText(event.text);
        if (kind === 'denied') task.pendingDenial = event.text;
        else if (kind === 'blocked') task.pendingBlock = event.text;
        const label = event.commandId ? event.stopped ? '后台命令已停止' : '后台命令失败' : '操作未执行';
        addLog(task, `${label}：${String(event.text).slice(0, 500)}`);
      } else if (event.actionState === 'not-executed') {
        const detail = String(event.text ?? '').trim().slice(0, 500);
        addLog(task, `操作未执行：${done}${detail ? `（${detail}）` : ''}${durationNote}`);
      } else if (['write', 'edit', 'bash', 'app_open'].includes(event.tool)
        || VISION_ACT_TOOLS.includes(event.tool) || BROWSER_ACT_TOOLS.includes(event.tool)) {
        addLog(task, `已完成：${done}${durationNote}`);
      } else if (WEB_TOOLS.includes(event.tool) || BROWSER_READ_TOOLS.includes(event.tool)) {
        addLog(task, `已完成：${done}${durationNote}`);
        if (event.tool === 'browser_navigate' || event.tool === 'web_extract') recordVisitedUrl(task, endArgs?.url);
        else if (event.tool === 'web_search') recordSearchedUrls(task, event.text);
        else if (event.tool === 'browser_extract') {
          const hit = String(event.text ?? '').match(/https?:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%()[\]-]+/);
          if (hit) recordVisitedUrl(task, hit[0]);
        }
      } else if (READ_TOOLS.includes(event.tool)) {
        // 056：只读侦察（explorer 的工作几乎全是这几样）也记入过程——否则过程页
        // 只见「等待/完成」，看不到中间读了什么、搜了什么。LOG_KEEP 截尾兜底体积。
        addLog(task, `已完成：${done}${durationNote}`);
      } else if (event.tool === 'register_delivery') {
        // 057：正式交付声明→任务成果（工具侧已校验路径/格式；声明幂等——同路径只留最新）。
        captureDelivery(task, endArgs);
        addLog(task, `已完成：${done}${durationNote}`);
      }
    }
    broadcast();
  }

  // ---- 文件事实（050）：write/edit 前内容捕获 + git 快照 ----

  /** 057：register_delivery 声明 → 任务成果/来源（同路径替换、来源去重）。 */
  function captureDelivery(task, args) {
    const files = Array.isArray(args?.files) ? args.files : [];
    const sources = Array.isArray(args?.sources) ? args.sources : [];
    const artifacts = [...(task.artifacts ?? [])];
    let seq = artifacts.length;
    for (const file of files) {
      const path = typeof file?.path === 'string' ? file.path : '';
      if (!path) continue;
      const name = path.split('/').pop() || path;
      const existing = artifacts.findIndex((entry) => entry.path === path);
      const artifact = {
        id: existing >= 0 ? artifacts[existing].id : `af-${task.seq}-${(seq += 1)}`,
        kind: 'file',
        name,
        path,
        ...(typeof file.description === 'string' && file.description ? { description: file.description.slice(0, 200) } : {}),
        registeredAt: nowFn(),
      };
      if (existing >= 0) artifacts[existing] = artifact;
      else artifacts.push(artifact);
      // 062：声明同步提升到会话 flow（llm.ipc 统一做宿主查证与登记；对话入口
      // 与＋菜单消费 flow.artifacts，不读这里原文路径）。任务身份用 historyId
      // （无档时退稳定 key）——声明时刻快照 taskId 可能尚未分配。
      try {
        onDeliveryDeclared?.({
          conversationId: task.conversationId ?? null,
          rootRunId: task.rootRunId ?? null,
          taskId: task.historyId ?? task.key ?? null,
          workspace: task.workspace ?? null,
          file: { path, ...(typeof file.description === 'string' && file.description ? { description: file.description } : {}) },
        });
      } catch (error) {
        log?.warn?.(`[subagents] 交付声明提升失败（${path}）：${error?.message ?? error}`);
      }
    }
    task.artifacts = artifacts;
    const known = new Set(task.sources.map((entry) => entry.url));
    for (const source of sources) {
      const url = typeof source?.url === 'string' ? source.url : '';
      if (!url || known.has(url)) continue;
      known.add(url);
      task.sources = [...task.sources, { title: String(source?.title ?? url).slice(0, 120), url }];
    }
  }


  function captureInitialSnapshot(task) {
    const dir = task.workspace?.host ? null : task.workspace?.dir ?? null;
    if (!dir || task.role.mode !== 'run') return;
    void (async () => {
      try {
        if (!await isGitRepo(dir)) {
          task.gitSnapshot = { ok: false, reason: 'not-git' };
          return;
        }
        task.gitSnapshot = await snapshotTree(dir);
      } catch (error) {
        log?.warn?.(`文件快照异常（${task.key}）：${error?.message ?? error}`);
      }
    })();
  }

  function captureFileBefore(task, rawPath) {
    const dir = task.workspace?.dir ?? os.homedir();
    let target = String(rawPath ?? '').trim();
    if (!target || task.workspace?.host) return;
    if (target.startsWith('~/')) target = path.join(os.homedir(), target.slice(2));
    if (!path.isAbsolute(target)) target = path.join(dir, target);
    if ((task.fileTouches ?? []).some((touch) => touch.path === target)) return;
    void (async () => {
      try {
        target = realpathSync(target);
      } catch {
        try { target = path.join(realpathSync(path.dirname(target)), path.basename(target)); } catch { /* 保留原样 */ }
      }
      if ((task.fileTouches ?? []).some((touch) => touch.path === target)) return;
      let content = null;
      let lines = null;
      try {
        const stats = await stat(target);
        if (stats.isFile() && stats.size <= FILE_CHANGES_LIMITS.beforeContentMaxBytes) {
          content = await readFile(target, 'utf8');
          lines = content.length ? content.split('\n').length : 0;
        }
      } catch {
        content = null;
        lines = 0;
      }
      task.fileTouches = [...(task.fileTouches ?? []), { path: target, before: content, lines }];
    })();
  }

  async function computeFileChanges(task) {
    const dir = task.workspace?.host ? null : task.workspace?.dir ?? null;
    const touches = task.fileTouches ?? [];
    const snap = task.gitSnapshot ?? null;
    if (!snap?.ok && !touches.length) return null;
    const degraded = [];
    let coverage = 'tools';
    let files = [];
    let tempExcluded = 0;

    const toolFiles = await mergeToolTouches(touches, {
      readCurrent: async (target) => {
        try {
          const stats = await stat(target);
          if (!stats.isFile() || stats.size > FILE_CHANGES_LIMITS.beforeContentMaxBytes) return null;
          return await readFile(target, 'utf8');
        } catch {
          return null;
        }
      },
    });

    if (snap?.ok && dir) {
      coverage = 'tools+git';
      const after = await snapshotTree(dir);
      if (after.ok) {
        const diff = await diffTreeChanges(dir, snap.tree, after.tree);
        if (diff.ok) {
          tempExcluded = diff.junkExcluded;
          const toolByPath = new Map(toolFiles.map((change) => [change.path, change]));
          const sharedWorkspace = [...tasks.values()].some(
            (other) => other !== task && other.workspace?.dir === dir,
          );
          const gitFiles = diff.files
            .map((change) => {
              const absolute = path.resolve(dir, change.path);
              const toolHit = toolByPath.get(absolute);
              if (toolHit) {
                // 工具直接改的：归属明确；行数取 git（真实 diff）。
                return { ...toolHit, ...(change.fromPath ? { fromPath: path.resolve(dir, change.fromPath) } : {}), kind: change.kind, add: change.add, del: change.del, attribution: 'task' };
              }
              return {
                path: absolute,
                ...(change.fromPath ? { fromPath: path.resolve(dir, change.fromPath) } : {}),
                kind: change.kind,
                add: change.add,
                del: change.del,
                source: 'git',
                attribution: sharedWorkspace ? 'uncertain' : 'task',
              };
            });
          // 宿主自己的档案写入不是用户文件改动（userData 一般不在工作区，
          // 但隔离实例/测试会把 task-history 放进仓库——统一排除）。
          const historyDir = history?.dir ?? null;
          const isHostArtifact = (target) => Boolean(historyDir && path.resolve(target).startsWith(`${path.resolve(historyDir)}${path.sep}`));
          const toolOnly = toolFiles.filter((change) => !gitFiles.some((gitChange) => gitChange.path === change.path));
          files = [...gitFiles, ...toolOnly].filter((change) => !isHostArtifact(change.path));
        } else {
          degraded.push(`git 比对失败：${diff.reason}`);
          files = toolFiles;
          coverage = 'tools';
        }
      } else {
        degraded.push(`收尾快照失败：${after.reason}`);
        files = toolFiles;
        coverage = 'tools';
      }
    } else {
      files = toolFiles;
    }

    if (files.length > FILE_CHANGES_LIMITS.files) {
      degraded.push(`改动清单超出 ${FILE_CHANGES_LIMITS.files} 条上限，已截断`);
      files = files.slice(0, FILE_CHANGES_LIMITS.files);
    }
    // 050 R-22（S5）：工具捕获过「首次修改前」内容的文件产出统一 diff（入档，
    // 历史回看显示当时记录）；git-only 改动没有 before 内容，不显示入口（不拿
    // 工作区当前 diff 冒充）。有界：单 diff 64KB、最多 20 个文件。
    const diffs = {};
    const touchByPath = new Map(touches.map((touch) => [touch.path, touch]));
    const diffCandidates = files
      .filter((change) => change.source === 'tool' && touchByPath.has(change.path))
      .slice(0, 20);
    for (const change of diffCandidates) {
      const touch = touchByPath.get(change.path);
      if (typeof touch.before !== 'string') continue; // 超预算/二进制：无 before 内容，降级为无入口
      let after = null;
      try {
        const stats = await stat(change.path);
        if (stats.isFile() && stats.size <= FILE_CHANGES_LIMITS.beforeContentMaxBytes) {
          after = await readFile(change.path, 'utf8');
        } else if (stats.isFile()) {
          continue; // 最终内容过大：如实无 diff
        }
      } catch {
        after = null; // 已删除：diff 到空
      }
      try {
        const result = await unifiedDiffOf(touch.before, after ?? '');
        if (result.text.trim()) diffs[change.path] = { diff: result.text, truncated: result.truncated };
      } catch (error) {
        log?.warn?.(`diff 生成失败（${change.path}）：${error?.message ?? error}`);
      }
    }
    task.fileDiffs = diffs;
    if (!files.length && !degraded.length && coverage === 'tools' && !Object.keys(diffs).length) return null;
    return {
      files: files.map((change) => ({
        path: change.path,
        ...(change.fromPath ? { fromPath: change.fromPath } : {}),
        kind: change.kind,
        add: change.add,
        del: change.del,
        source: change.source ?? 'tool',
        attribution: change.attribution ?? 'task',
        ...((task.fileDiffs && Object.prototype.hasOwnProperty.call(task.fileDiffs, change.path))
          ? { diffAvailable: true }
          : {}),
      })),
      coverage,
      degraded: degraded.length ? degraded.join('；') : null,
      tempExcluded,
    };
  }
  // ---- 用量（048 账本口径） ----

  function usageIdentityOf(task, modelId) {
    const candidates = [task.modelPlan?.config, task.modelPlan?.fallback].filter(Boolean);
    const hit = candidates.find((item) => item.model === modelId);
    return hit ? { modelKey: hit.modelKey ?? modelId, modelName: hit.name ?? '' } : { modelKey: modelId, modelName: '' };
  }

  function recordModelCall(task, call) {
    const modelId = call.model ?? '未知模型';
    const identity = usageIdentityOf(task, modelId);
    const bucket = task.usageByModel[modelId] ?? { ...identity, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, genMs: 0, missing: 0 };
    bucket.calls += 1;
    if (call.usageDetail) {
      bucket.input += call.usageDetail.input;
      bucket.output += call.usageDetail.output;
      bucket.cacheRead += call.usageDetail.cacheRead;
      bucket.cacheWrite += call.usageDetail.cacheWrite;
      bucket.genMs += call.usageDetail.genMs ?? 0;
    } else {
      bucket.missing += 1;
    }
    task.usageByModel[modelId] = bucket;
    try { onModelUsage?.(task); } catch { /* 记账失败不影响运行 */ }
  }

  // ---- 生命周期 ----

  function resolveTask(keyOrId) {
    const wanted = String(keyOrId ?? '');
    if (!wanted) return null;
    if (tasks.has(wanted)) return tasks.get(wanted);
    for (const task of [...tasks.values()].reverse()) {
      if (task.historyId === wanted || task.alias === wanted || task.sessionRef === wanted) return task;
    }
    return null;
  }

  function activeCount() {
    let count = 0;
    for (const task of tasks.values()) if (task.admitted && !task.finalized) count += 1;
    return count;
  }

  function pruneTerminal() {
    const terminal = [...tasks.values()].filter((task) => task.phase === 'terminal');
    for (const task of terminal.slice(0, Math.max(0, terminal.length - TERMINAL_KEEP))) {
      // 057：仍持有树内受管命令的会话不随终态淘汰被释放（agent-task-lifecycle R-09）；
      // 命令到硬截止必然终态，由之后的淘汰轮次回收，会话保留量有界。
      try {
        if (task.session?.hasTreeCommands?.({ conversationId: task.conversationId, rootRunId: task.rootRunId, generation: task.generation ?? 0, taskId: task.historyId })) continue;
      } catch { /* 尽力而为 */ }
      try { task.session?.dispose(); } catch { /* 尽力而为 */ }
      tasks.delete(task.key);
    }
  }

  /**
   * 派一个子 agent（新开或续用）。前台：返回 Promise<结果>；后台：立刻返回 id，终态经 onTerminal。
   * @returns {Promise<{ok: boolean, key?: string, taskId?: string, background?: boolean, result?: object, error?: string}>}
   */
  function beginExecution(task, rootRunId) {
    task.stopRequested = false;
    task.finalized = false;
    task.stopCompletion = null;
    task.rootRunId = rootRunId ?? null;
    task.terminalWait = new Promise((resolve) => { task.resolveTerminal = resolve; });
  }

  async function spawn({ role, prompt, description = '', background = false, sessionId = null, conversationId = null, inputSource = 'voice', workspace = null, modelPlan = null, signal = null, toolCallId = null, rootRunId = null, dispatchKey = null, taskId = null, generation = 0 }) {
    const text = String(prompt ?? '').trim();
    if (!text) return { ok: false, error: 'prompt 不能为空' };
    let task = null, previous = null, retainedSession = null;
    if (sessionId) {
      task = resolveTask(sessionId);
      if (!task && restoreSession) {
        try { task = await restoreSession({ sessionId, role, conversationId, workspace, inputSource, modelPlan }); }
        catch (error) { return { ok: false, error: `子会话不能恢复：${error.message}` }; }
      }
      if (!task) return { ok: false, error: `没有找到子 agent 会话 ${sessionId}；不传 session_id 新开一个` };
      if (task.conversationId !== conversationId) return { ok: false, error: '这个子 agent 会话不属于当前对话' };
      if ((task.generation ?? 0) !== generation) return { ok: false, error: '对话已回卷，旧子会话不能恢复执行' };
      if (task.role.name !== role.name) return { ok: false, error: `会话 ${sessionId} 是 ${task.role.name}，不能当 ${role.name} 续用` };
      if (task.phase !== 'terminal' || !task.finalized) return { ok: false, error: `子 agent ${sessionId} 还在运行或终态尚在保存；要补充指令用 task_message，或用 task_status 等它结束` };
      if (!task.session || task.session.isDisposed()) return { ok: false, error: `子 agent ${sessionId} 的会话已释放，不能续用；不传 session_id 新开一个` };
      const incompatibility = sessionCompatibility({ previous: task.modelPlan, next: modelPlan, workspace, previousWorkspace: task.workspace,
        roleRevision: roleSessionRevision(role, modelPlan), previousRoleRevision: roleSessionRevision(task.role, task.modelPlan) });
      if (incompatibility) return { ok: false, error: `${incompatibility}；保留旧结果，请新开子会话并传必要证据引用` };
      previous = task; retainedSession = task.session;
      task = null;
    }
    {
      seq += 1;
      const key = `t${seq}`;
      let historyId = null;
      try {
        historyId = history?.createRecord({
          ...(taskId ? { taskId } : {}),
          taskText: String(description || text).slice(0, 400),
          context: text,
          conversationId,
          inputSource,
          workspace,
          dispatch: { objective: text.slice(0, 400), doneWhen: [], boundaries: role.mode === 'verify' ? { mode: 'readonly' } : null },
        })?.taskId ?? null;
        if (historyId) history?.startExecution?.(historyId, { now: nowFn() });
      } catch (error) {
        log?.warn?.(`[history] 子 agent 建档失败（不阻断）：${error.message}`);
      }
      if (taskId && historyId && historyId !== taskId) return { ok: false, error: '任务档案身份与持久派单不一致' };
      historyId = taskId ?? historyId ?? `task-${randomUUID()}`;
      task = {
        seq, key, historyId, alias: `${role.name}-${seq}`,
        role, prompt: text, description: String(description ?? '').trim(),
        background: Boolean(background), conversationId, inputSource, workspace, modelPlan,
        phase: 'running', outcome: null, outcomeReason: null, resultText: null, resultVersion: 0,
        startedAt: nowFn(), endedAt: null, readOnly: role.mode === 'verify', progressText: '准备中',
        log: [], recentToolCalls: [], approvals: null, usageByModel: {}, visitedUrls: [], sources: [],
        fileTouches: [], gitSnapshot: null, fileChanges: null, runs: previous ? (previous.runs ?? 0) + 1 : 1, steeredCount: 0, session: retainedSession,
        inheritedRefs: previous?.contextRefs ?? [],
        sessionRef: previous?.sessionRef ?? `session-${randomUUID()}`, worklineId: previous?.worklineId ?? `workline-${randomUUID()}`, resumesTaskId: previous ? previous.historyId ?? previous.key : null,
        toolCallId, dispatchKey, generation,
        // 060 R-22：所属主运行归属（插队停止按此取消 A 的所属子调用，含 background）。
        rootRunId: typeof rootRunId === 'string' && rootRunId ? rootRunId : null,
      };
      beginExecution(task, rootRunId);
      task.conversation = createTaskConversation({ taskId: historyId, prompt: text, now: nowFn });
      if (previous) previous.session = null;
      tasks.set(key, task);
      addLog(task, `${role.title}（${role.name}）开始：${(task.description || text).slice(0, 80)}`);
      captureInitialSnapshot(task);
    }
    const onAbort = () => { void stop(task.key, { reason: 'parent-abort' }); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    task.phase = 'waiting'; task.progressText = '等待执行名额';
    const launching = (async () => {
      const admitted = await admit(task);
      if (!admitted || task.stopRequested || signal?.aborted) {
        await settle(task, 'stopped', { outcomeReason: task.stopReason ?? '主任务已停止' }); return resultOf(task);
      }
      task.phase = 'running'; task.progressText = '准备中';
      try {
        if (!task.session) task.session = await createSession({
          role, conversationId, accessId: task.historyId ?? task.key, workspace, inputSource, modelPlan, sessionRef: task.sessionRef,
        });
      } catch (error) {
        const reason = `没能启动：${error?.message ?? error}`;
        await settle(task, task.stopRequested ? 'stopped' : 'startfailed', { outcomeReason: task.stopRequested ? task.stopReason : reason });
        return resultOf(task);
      }
      if (previous) previous.session = null; // 历史任务终态不变，运行实例转交新任务。
      const session = task.session;
      session.on('progress', (event) => { if (tasks.get(task.key)?.session === session) handleProgress(task, event); });
      session.on('activity', activity => {
        if (tasks.get(task.key)?.session !== session || task.phase === 'terminal') return;
        task.activity = activity;
        task.lastActivityAt = nowFn();
        task.progressText = activity.phase === 'waiting-background' ? '等待后台命令完成，随后自动继续'
          : activity.phase === 'waiting-resource' ? '等待工作区资源，释放后自动继续'
          : task.progressBase ?? '继续执行';
        broadcast();
      });
      // 模型正在流式输出（思考／正文／工具参数分片）也是活动：停摆看门狗只认工具事件会把
      // 读完资料后写长报告、或长思考的那一轮当成「模型流停摆」掐掉（10-19 t24 实录）。
      session.on('stream', event => {
        if (tasks.get(task.key)?.session !== session || task.phase === 'terminal') return;
        if (event.type === 'hemi_request_start') task.modelRequestActive = true;
        if (event.type === 'hemi_request_end') task.modelRequestActive = false;
        if (task.phase === 'running') task.lastActivityAt = nowFn();
        if (task.conversation?.stream(event)) {
          if (!task.activeTool && task.phase === 'running' && !task.activity?.phase?.startsWith('waiting-')) {
            task.progressBase = task.progressText = ['thinking_start', 'thinking_delta'].includes(event.type) ? '正在思考'
              : event.type === 'text_delta' ? '正在回复' : '等待模型响应';
          }
          broadcastStream();
        }
      });
      session.on('permission', (request) => { if (tasks.get(task.key)?.session === session) handlePermission(task, request); });
      session.on('model-call', (call) => { if (tasks.get(task.key)?.session === session) recordModelCall(task, call); });
      session.on('model-route', (event) => {
        if (tasks.get(task.key)?.session !== session) return;
        addLog(task, `模型服务暂不可用，已切换到备用模型「${event?.to?.name ?? event?.to?.model ?? ''}」继续`);
      });
        if (task.stopRequested || signal?.aborted) {
      await task.session?.abort();
      await settle(task, 'stopped', { outcomeReason: task.stopReason ?? '主任务已停止' });
      return resultOf(task);
    }
    task.lastActivityAt = nowFn();
    ensureStallTicker();
    broadcast();
    log?.info?.(`子 agent ${task.key}（${role.name}${background ? '，后台' : ''}${task.runs > 1 ? `，续用第 ${task.runs} 次` : ''}）：${(task.description || text).slice(0, 60)}`);

      return runTask(task, text);
    })();
    task.running = launching;
    if (signal?.aborted) queueMicrotask(onAbort);
    broadcast();
    void launching.finally(() => signal?.removeEventListener?.('abort', onAbort)).catch(() => {});
    // 057 统一 accepted：前台派单不再阻塞 SDK 回合等待交付；所有结算沿 inbox 投递
    // （onSettled → completeTask），由根目标在安全边界消费（agent-task-lifecycle R-02/R-03）。
    void launching.then(result => {
      try { onTerminal?.({ conversationId: task.conversationId, rootRunId: task.rootRunId, ...result }); }
      catch (error) { log?.warn?.(`子 agent 终态通知失败：${error.message}`); }
    });
    return { ok: true, key: task.key, taskId: task.historyId ?? task.key, alias: task.alias, sessionRef: task.sessionRef, background: true };
  }

  async function runTask(task, text) {
    let run = null;
    let failure = null;
    try {
      if (task.modelPlan?.executionContext) {
        const context = task.modelPlan.executionContext;
        const allowedRefs = [...new Set([...(task.inheritedRefs ?? []), ...(context.allowedRefs ?? [])])];
        task.contextRefs = allowedRefs;
        task.session.setExecutionContext?.({ ...context, allowedRefs, sessionRef: task.sessionRef, worklineId: task.worklineId, runCount: task.runs, roleRevision: roleSessionRevision(task.role, task.modelPlan), owner: { ...context.owner, taskId: task.historyId ?? task.key }, cancelled: () => task.stopRequested || context.cancelled?.() });
      }
      const inputRefs = task.contextRefs?.length ? `\n\n［宿主提供的受控上下文引用：${task.contextRefs.join('、')}；需要原约束时用 context_read 补查。］` : '';
      run = await task.session.prompt(text + inputRefs);
    } catch (error) {
      failure = error;
    }
    if (task.phase === 'terminal' && task.stopRequested) {
      // stop() 已收口（停止语义优先）。
      return resultOf(task);
    }
    if (task.stopCompletion) await task.stopCompletion;
    if (task.stopRequested || run?.aborted) {
      await settle(task, 'stopped', { outcomeReason: task.stopReason ?? '已停止', resultText: run?.lastText ?? null });
    } else if (failure) {
      await settle(task, 'unknown', { outcomeReason: `运行中断：${failure?.message ?? failure}` });
    } else if (task.pendingBlock && !run?.lastText) {
      await settle(task, 'blocked', { outcomeReason: task.pendingBlock });
    } else if (task.pendingDenial && !run?.lastText) {
      await settle(task, 'denied', { outcomeReason: task.pendingDenial });
    } else if (run?.modelError) {
      await settle(task, 'unknown', { outcomeReason: `模型调用中断：${describeModelError(run.modelError)}` });
    } else {
      await settle(task, run?.lastText ? 'complete' : 'unknown', {
        resultText: run?.lastText ?? null,
        outcomeReason: run?.lastText ? null : '子 agent 没有给出结果',
      });
    }
    return resultOf(task);
  }

  function resultOf(task) {
    const clipped = clipReport(task.resultText ?? '');
    return {
      key: task.key,
      taskId: task.historyId ?? task.key,
      alias: task.alias,
      sessionRef: task.sessionRef,
      worklineId: task.worklineId,
      resumesTaskId: task.resumesTaskId,
      agent: task.role.name,
      description: task.description,
      outcome: task.outcome,
      outcomeReason: task.outcomeReason,
      report: clipped.text,
      reportRef: task.reportRef,
      artifacts: task.artifacts ?? [],
      toolEvidence: (task.recentToolCalls ?? []).filter(call => call.observationRef).map(call => ({ tool: call.tool, outcome: call.isError ? 'error' : 'ok', ref: call.observationRef, path: call.path, excerpt: call.outputExcerpt })),
      truncated: clipped.truncated,
      totalChars: clipped.total,
      toolCalls: (task.recentToolCalls ?? []).length,
      fileChanges: task.fileChanges?.files?.map((file) => file.path).slice(0, 30) ?? [],
      usage: Object.values(task.usageByModel ?? {}).reduce((acc, bucket) => ({
        input: acc.input + bucket.input, output: acc.output + bucket.output,
        cacheRead: acc.cacheRead + bucket.cacheRead, cacheWrite: acc.cacheWrite + bucket.cacheWrite,
      }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      durationMs: (task.endedAt ?? nowFn()) - (task.startedAt ?? nowFn()),
    };
  }

  async function settle(task, outcome, extras = {}) {
    if (task.phase === 'terminal' && task.settledRun === task.runs) return;
    task.settledRun = task.runs;
    if (task.permission) {
      task.session?.respondPermission(task.permission.id, { cancelled: true });
      task.permission = null;
    }
    task.phase = 'terminal';
    task.activity = null;
    task.outcome = outcome;
    task.endedAt = nowFn();
    task.activeTool = null;
    Object.assign(task, extras);
    task.conversation?.finish({ report: task.resultText, stopped: outcome !== 'complete' });
    if (task.resultText) task.resultVersion = (task.resultVersion ?? 0) + 1;
    task.sources = (task.visitedUrls ?? []).slice(-12).map((url) => ({ url }));
    if (task.role.mode === 'run') {
      try {
        task.fileChanges = await computeFileChanges(task);
      } catch (error) {
        log?.warn?.(`文件事实计算失败（${task.key}）：${error?.message ?? error}`);
      }
    }
    addLog(task, {
      complete: '已完成。', stopped: '已停止。', denied: '用户拒绝了关键操作，已结束。',
      blocked: '被安全规则拦下，已结束。', startfailed: '没能启动。', unknown: '结束了，但没拿到明确结果。',
    }[outcome] ?? '已结束。');
    if (onSettled) {
      try { await onSettled(task, resultOf(task)); }
      catch (error) { task.outcome = 'unknown'; task.outcomeReason = `终态事实未能保存：${error.message}`; log?.error?.(task.outcomeReason); }
    }
    outcome = task.outcome;
    try {
      history?.finishRecord?.(task.historyId, {
        agent: task.role.name,
        agentTitle: task.role.title,
        toolCallId: task.toolCallId ?? null,
        rootRunId: task.rootRunId ?? null,
        sessionRef: task.sessionRef, worklineId: task.worklineId, resumesTaskId: task.resumesTaskId,
        outcome,
        outcomeReason: task.outcomeReason ?? null,
        resultText: task.resultText ?? null,
        resultVersion: task.resultVersion ?? 0,
        conversation: task.conversation?.snapshot() ?? null,
        bodySource: task.resultText ? 'executor' : null,
        sources: task.sources,
        visitedUrls: task.visitedUrls,
        fileChanges: task.fileChanges ?? null,
        fileDiffs: task.fileDiffs ?? null,
        report: task.resultText ?? null,
        toolCalls: task.recentToolCalls,
        approvals: task.approvals,
        usageByModel: task.usageByModel,
        at: task.endedAt,
      });
    } catch (error) {
      log?.warn?.(`[history] 子 agent 终态落档失败：${error.message}`);
    }
    // 057：register_delivery 声明的成果随终态落任务档案（deliverables）——快照
    // 重建（snapshotFromRecord）、@引用候选与预览读取（readArtifactPreview）都
    // 以档案 deliverables 为源；056 子 agent 化时丢了这条写侧，重启后成果不可
    // 见（2026-10-15 真机 AC-20 走查钓出）。同路径去重由 appendDeliverable 负责。
    for (const artifact of task.artifacts ?? []) {
      try {
        const isLink = artifact.kind === 'link';
        history?.appendDeliverable?.(task.historyId, {
          id: artifact.id,
          kind: isLink ? 'link' : 'file',
          name: artifact.name,
          ...(isLink ? { url: String(artifact.url ?? '') } : { path: String(artifact.path ?? '') }),
          ...(artifact.description ? { description: String(artifact.description).slice(0, 200) } : {}),
        }, { at: task.endedAt });
      } catch (error) {
        log?.warn?.(`[history] 成果落档失败（${artifact?.path ?? artifact?.id ?? '?'}）：${error.message}`);
      }
    }
    try { cleanupAccessTask?.(task.historyId ?? task.key); } catch { /* 尽力而为 */ }
    const totalMs = task.endedAt - task.startedAt;
    const usage = Object.entries(task.usageByModel ?? {}).map(([modelId, b]) => {
      const promptTokens = b.input + b.cacheRead + b.cacheWrite;
      const hit = promptTokens > 0 ? `，命中 ${((b.cacheRead / promptTokens) * 100).toFixed(1)}%` : '';
      return `${modelId} ${b.calls} 次（入 ${b.input} / 缓存读 ${b.cacheRead} / 缓存写 ${b.cacheWrite} / 出 ${b.output}${hit}）`;
    });
    log?.info?.(`子 agent 终态 ${outcome}（${task.key} · ${task.role.name} 总 ${fmtDuration(totalMs)}，工具 ${(task.recentToolCalls ?? []).length} 步${usage.length ? ` · ${usage.join('；')}` : ''}）`);
    task.finalized = true;
    drainAdmissions();
    broadcast();
    task.resolveTerminal?.(resultOf(task));
    pruneTerminal();
  }

  /** 060 R-22：按所属主运行取消（插队停止边界）——只停 rootRunId 匹配且未终态的
   *  任务（含 background 子调用）；不属于该根目标的独立后台任务不受影响。
   *  返回实际发出取消的身份列表（真实终态各自经 settle 广播，不以数量回执冒充）。 */
  async function cancelByRootRun(rootRunId, { reason = 'stop' } = {}) {
    if (!rootRunId) return { ok: false, cancelled: [] };
    const targets = [...tasks.values()].filter((task) => task.phase !== 'terminal' && task.rootRunId === rootRunId);
    for (const task of targets) {
      task.stopRequested = true;
      task.cancelAdmission?.();
      task.stopReason = reason === 'promote' ? '主任务被取代，已停止' : '主任务停止，已停止';
      addLog(task, task.stopReason);
      task.stopCompletion ??= Promise.resolve(task.session?.abort());
    }
    if (targets.length) broadcast();
    await Promise.all(targets.map((task) => task.stopCompletion));
    await Promise.all(targets.map((task) => task.terminalWait));
    // 057：已结算子任务仍受管的后代命令随根终止一并收口（R-09/R-10）；abort 幂等，空闲会话只清命令。
    for (const task of [...tasks.values()].filter((task) => task.phase === 'terminal' && task.rootRunId === rootRunId)) {
      try {
        if (task.session?.hasTreeCommands?.({ conversationId: task.conversationId, rootRunId, generation: task.generation ?? 0, taskId: task.historyId })) await task.session.abort();
      } catch (error) { log?.warn?.(`子任务 ${task.key} 的受管命令停止未确认：${error?.message ?? error}`); }
    }
    return { ok: targets.length > 0, cancelled: targets.map((task) => task.key) };
  }

  /** 停止（用户、task_cancel、看门狗、对话关闭）。会话保留以便核对部分产出，不回滚。 */
  async function stop(keyOrId = null, { reason = 'user', conversationId = null, rootRunId = null } = {}) {
    if (conversationId && !keyOrId) return { ok: false, error: '缺少当前对话的子任务身份' };
    const selected = keyOrId ? resolveTask(keyOrId) : null;
    if (keyOrId && (!selected || (conversationId && selected.conversationId !== conversationId) || (rootRunId && selected.rootRunId !== rootRunId))) return { ok: false, error: '没有可访问的所属子任务' };
    const targets = keyOrId
      ? [resolveTask(keyOrId)].filter(Boolean)
      : [...tasks.values()].filter((task) => task.phase !== 'terminal');
    let stopped = 0;
    for (const task of targets) {
      if (task.phase === 'terminal') continue;
      task.stopRequested = true;
      task.cancelAdmission?.();
      task.stopReason = { user: '用户停止', cancel: '主 agent 取消', stall: '长时间无响应，自动停止', 'long-tool': '单个工具执行过久，自动停止', 'parent-abort': '主 agent 被叫停', dispose: '对话已关闭' }[reason] ?? '已停止';
      stopped += 1;
      task.stopCompletion ??= Promise.resolve(task.session?.abort());
    }
    await Promise.all(targets.map((task) => task.stopCompletion));
    await Promise.all(targets.map((task) => task.terminalWait));
    return { ok: stopped > 0, stopped };
  }

  /** 给运行中的子 agent 补充指令（下一个模型请求前送达；不承诺对方已读）。 */
  async function message(keyOrId, text, { conversationId = null, rootRunId = null } = {}) {
    const task = resolveTask(keyOrId);
    if (!task || (conversationId && task.conversationId !== conversationId) || (rootRunId && task.rootRunId !== rootRunId)) return { ok: false, error: '没有可访问的所属子任务' };
    if (task.phase === 'terminal') return { ok: false, error: `子 agent ${keyOrId} 已结束；要继续它，用 task 并传 session_id` };
    const result = await task.session?.steer(String(text ?? ''));
    if (!result?.ok) return { ok: false, error: `指令没送达（${result?.reason ?? '会话不可用'}）` };
    task.steeredCount = (task.steeredCount ?? 0) + 1;
    addLog(task, `收到补充指令：${String(text ?? '').slice(0, 80)}`);
    broadcast();
    return { ok: true, delivered: 'queued-for-next-step' };
  }

  /** task_status 的只读视图（本对话的子 agent）。 */
  function status({ conversationId = null, keyOrId = null } = {}) {
    const list = keyOrId
      ? [resolveTask(keyOrId)].filter(Boolean)
      : [...tasks.values()].filter((task) => !conversationId || task.conversationId === conversationId);
    return list.filter(task => !conversationId || task.conversationId === conversationId).map((task) => ({
      id: task.alias,
      taskId: task.historyId ?? task.key,
      agent: task.role.name,
      description: task.description || task.prompt.slice(0, 80),
      phase: task.phase,
      outcome: task.outcome,
      background: Boolean(task.background),
      progress: task.progressText,
      waitingForUser: Boolean(task.permission),
      elapsedMs: (task.endedAt ?? nowFn()) - task.startedAt,
      toolCalls: (task.recentToolCalls ?? []).length,
      lastTool: task.lastAction?.tool ?? null,
      reusable: task.phase === 'terminal' && Boolean(task.session) && !task.session.isDisposed(),
    }));
  }

  /** 前台等待某个后台子 agent 的终态（task_status wait）。 */
  function waitFor(keyOrId, { timeoutMs = 600_000, signal = null, conversationId = null } = {}) {
    const task = resolveTask(keyOrId);
    if (!task || signal?.aborted || (conversationId && task.conversationId !== conversationId)) return Promise.resolve(null);
    if (task.finalized) return Promise.resolve(resultOf(task));
    return new Promise((resolve) => {
      let timer = null;
      const done = (value) => {
        emitter.off('change', onChange);
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(value);
      };
      const onChange = () => { if (task.finalized) done(resultOf(task)); };
      const onAbort = () => done(null);
      emitter.on('change', onChange);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      timer = setTimeout(() => done(null), timeoutMs);
      timer.unref?.();
    });
  }

  /** 用量面板：在途子 agent 的内存聚合（终态的读档案）。 */
  function usageByConversation(conversationId) {
    const rows = [];
    for (const task of tasks.values()) {
      if (task.conversationId !== conversationId || task.phase === 'terminal') continue;
      for (const [modelId, bucket] of Object.entries(task.usageByModel ?? {})) {
        rows.push({ source: 'task', modelKey: bucket.modelKey ?? modelId, modelName: bucket.modelName ?? '', input: bucket.input, output: bucket.output, cacheRead: bucket.cacheRead, cacheWrite: bucket.cacheWrite, genMs: bucket.genMs, at: nowFn(), calls: bucket.calls, missing: bucket.missing, taskId: task.historyId ?? task.key });
      }
    }
    return rows;
  }

  /**
   * 主 agent 的确认请求接入同一确认环（门控卡 → 渲染层 → decide → respondPermission）。
   * @param {{conversationId: string, inputSource?: string, session: {respondPermission: Function}, request: object}} args
   */
  function hostPermission({ conversationId, inputSource = 'voice', session, request }) {
    // 每个请求一条（主 agent 同批并行的多个确认各自排队，渲染层一次出一张）。
    const key = `main:${conversationId}:${request.id}`;
    const entry = { key, hosted: true, conversationId, inputSource, label: 'Hemi', log: [], approvals: null, permission: null, session };
    hosted.set(key, entry);
    handlePermission(entry, request);
  }

  /** decide 后撤掉已应答的主 agent 条目（快照不留死卡）。 */
  function dropAnsweredHosted() {
    for (const [key, entry] of hosted) if (!entry.permission) hosted.delete(key);
  }

  /** 主 agent 回合中止/会话释放：撤掉它挂着的确认卡。 */
  function clearHostedPermission(conversationId) {
    let changed = false;
    for (const [key, entry] of hosted) {
      if (entry.conversationId !== conversationId) continue;
      if (entry.permission) entry.session?.respondPermission(entry.permission.id, { cancelled: true });
      hosted.delete(key);
      changed = true;
    }
    if (changed) broadcast();
  }

  /** 对话关闭/回卷：停掉并释放该对话的子 agent。 */
  function disposeConversation(conversationId) {
    for (const task of [...tasks.values()]) {
      if (task.conversationId !== conversationId) continue;
      if (task.phase !== 'terminal') void stop(task.key, { reason: 'dispose' });
      try { task.session?.dispose(); } catch { /* 尽力而为 */ }
    }
  }

  function disposeAll() {
    clearTimeout(streamBroadcastTimer);
    stopPermissionTicker();
    stopStallTicker();
    for (const task of tasks.values()) {
      if (task.phase !== 'terminal') {
        task.stopRequested = true;
        task.cancelAdmission?.();
        task.stopReason = '应用退出';
      }
      try { task.session?.dispose(); } catch { /* 尽力而为 */ }
    }
  }

  return {
    cancelByRootRun,
    spawn,
    stop,
    message,
    status,
    waitFor,
    decide,
    hostPermission,
    clearHostedPermission,
    snapshot,
    usageByConversation,
    disposeConversation,
    disposeAll,
    onChange: (fn) => {
      emitter.on('change', fn);
      return () => emitter.off('change', fn);
    },
    _internals: { tasks },
  };
}
