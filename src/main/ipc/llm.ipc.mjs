import { withExecutionScope } from '../agent-runtime/execution-scope.mjs';
import {closeUnconfirmedCommand} from '../services/command-cleanup-failure.mjs';
import {closeConversationRun} from '../services/run-completion.mjs';
import {commandDeadline} from '../agent/gate/command-deadline.mjs';
import { ipcMain, app, shell, dialog, net } from 'electron';
import { createLocalFileActions } from '../services/local-file-actions.mjs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';

import { resolveLightModel } from '../lib/light-model.mjs';
import { describeModelError, isSameCandidate } from '../lib/model-routing.mjs';
import { freezeModelPolicy, resolveModelPlan, hydrateModelPlan } from '../agent-runtime/model-policy.mjs';
import { freezeAcceptedInput } from '../agent-runtime/freeze-input.mjs';
import { goalRunOutcome } from '../agent-runtime/goal-driver.mjs';
import { createConversationTurns } from '../services/conversation-turns.mjs';
import { finalizeTurnParts, hasNonTextParts } from '../../shared/turn-parts.mjs';
import { buildTurnContextBlock, buildWorkspaceTurnBlock } from '../services/text-model.mjs';
import { summarizeForSpeech } from '../services/mouth.mjs';
import { buildAmbientBlock } from '../services/ambient.mjs';
import { createLogger } from '../lib/logger.mjs';
import { fmtMs } from '../lib/perf.mjs';
import { state } from '../state.mjs';
import { getWorkspaceService } from './workspace.ipc.mjs';
import { IPC } from '../../shared/ipc-channels.mjs';
import { registerLlmProfilesIpc } from './llm-profiles.ipc.mjs';
import { getComposerAttachments } from './composer.ipc.mjs';
import { assembleTurnEnvelope } from '../composer/turn-envelope.mjs';
import {
  recordConversationUsage,
  persistConversationTurns,
  persistConversationInput,
  applyConversationCut,
  ensureConversationArchive,
  getConversationDiagnostics,
  recordConversationDiagnostic,
  getConversationAgent,
  saveConversationAgent,
  getConversationTurnsRaw,
  getConversationSession,
  setArchiveCutListener,
  recordContextUsage,
} from './conversation.ipc.mjs';
import { buildRuntimeDiagnostic, buildRuntimeDiagnosticBlock } from '../services/runtime-diagnostics.mjs';
import { getSkillService } from './skills.ipc.mjs';
import { replyCreatedAt } from '../../shared/transcript-order.mjs';
import { collectSkills, createAgentRuntime } from '../agent-runtime/index.mjs';
import { getConversationFlowService } from '../services/conversation-flow-service.mjs';
import { createTurnResults } from '../services/turn-results.mjs';
import { buildFlowFactsBlock, createRunPartProjector } from '../services/flow-parts-projection.mjs';
import { createTaskFactPublisher } from '../services/task-fact-publisher.mjs';
import { registerConversationDeliverable, createConversationDeliverableIo } from '../services/conversation-deliverables.mjs';
import { normalizeRemotePath } from '../delivery/register.mjs';
import { createBrowserFileOpener } from '../delivery/browser-open.mjs';
import { getRemoteService } from '../remote/remote-service.mjs';
import { getWorkflowService } from '../workflows/workflow-service.mjs';

// 请求归属会话，主进程持续运行；界面切换/重载不撤销请求。
// 057 S2：调度权归 ConversationController（每会话单槽＋队列）；conversationTurns
// 退为运行内胆的流式/落档管道（turnState/llm:delta），不再拥有第二份调度。
const conversationTurns = createConversationTurns({
  onState: (snapshot) => {
    const window = state.mainWindow;
    if (window && !window.isDestroyed()) window.webContents.send(IPC.llm.turnState, snapshot);
  },
});
const llmLog = createLogger('llm');
/** 057 流服务（registerLlmIpc 时取；事件回合收口在 register 之前就可能触发，先占位）。 */
let flowService = null;

// 031 多组模型配置目录：会话选择 → 目录组 → 默认组；环境覆盖仍最高且如实标记。
import { getProfiles } from '../lib/profiles-holder.mjs';
/** 032：onboarding.ipc 按目录视图判定默认组完整性（同一份目录实例）。 */
export { getProfiles };

// ---- 宿主依赖注入（task.ipc 注册；模块注入避免 llm ↔ task 互相 import） ----
let runtimeDeps = null;
/** task.ipc 启动时注册：{ history, onTaskState, onModelUsage, readArtifact }。 */
export function setAgentRuntimeDeps(deps) {
  runtimeDeps = deps;
}

// ---- 队列派发用的最近一份对话历史（渲染层每回合送全量，主进程随手缓存） ----
const dialogueHistoryByConversation = new Map();
function getLastDialogueHistory(conversationId = null) {
  return conversationId ? dialogueHistoryByConversation.get(conversationId) ?? [] : [];
}

/** 用户直发（llm:chat）受理时暂存的原始 payload（profileId/workspaceId/messages 等），
 *  控制器派发时由适配层取回——队列派发则按最新历史＋条目正文重建（旧 turn-queue 同口径）。 */
const pendingChatPayloads = new Map();
/** 仅兼容完整结果调用；产品输入入口只等待受理。 */
const inputResults = createTurnResults();
const stoppingRuns = new Map();
/** conversationId → Map<runId, turnId>：cancel 按 turnId 定向（旧按钮不能停新回合，R-09）。 */
const turnIdByRun = new Map();
let chatSeq = 7010;

let runtime = null;
let eventTurnSeq = 0;

const taskFactPublisher = createTaskFactPublisher({
  flowService: { has: id => flowService?.has(id), controllerFor: id => flowService.controllerFor(id) },
});

// ---- 062 · 会话交付（主/子 agent 共用登记与受控 IO） ----

/**
 * 主／子 agent 的交付声明统一落点：本机同步查证登记；远端先经 SSH 预查证
 * （049 口径：本机文件系统不接触远端路径），结果回来再登记——迟到守卫按
 * 运行是否已收口在登记函数内判定。
 */
function registerDeclaredDeliverable({ conversationId, controller, runId, file, workspace = null, taskId = null, afterInputId, generation = controller?.getSnapshot().generation }) {
  if (!controller || !file) return;
  if (workspace?.host) {
    return verifyRemoteDeliveryTarget(workspace, file.path)
      .then((verified) => {
        registerConversationDeliverable({
          controller,
          runId,
          afterInputId,
          generation,
          file,
          remote: verified.error ? { host: workspace.host, error: verified.error } : { host: workspace.host, target: verified.target, size: verified.size ?? null },
          taskId,
          log: llmLog,
        });
      })
      .catch((error) => llmLog.warn(`[delivery] 远端交付查证异常：${error?.message ?? error}`));
  }
  return registerConversationDeliverable({
    controller,
    runId,
    afterInputId,
    generation,
    file,
    ...(workspace?.dir ? { workspaceDir: workspace.dir } : {}),
    taskId,
    log: llmLog,
  });
}

/** 062：远端交付路径的 SSH 预查证（stat；不读内容）。 */
async function verifyRemoteDeliveryTarget(workspace, rawPath) {
  const remoteService = getRemoteService?.() ?? null;
  if (!remoteService) return { error: '远端连接不可用' };
  const normalized = normalizeRemotePath(rawPath, { home: workspace.remoteHome ?? null, dir: workspace.dir ?? null });
  if (!normalized) return { error: '路径为空' };
  try {
    const rfs = remoteService.remoteFsFor({ host: workspace.host, dir: path.posix.dirname(normalized) });
    const info = await rfs.stat(normalized);
    if (!info?.ok || !info.isFile) return { error: '文件没能在服务器上通过查证（连接断开或路径无效）' };
    return { target: normalized, size: info.size ?? null };
  } catch (error) {
    return { error: `远端查证失败：${error?.message ?? error}` };
  }
}

/** 062：子 agent 的 register_delivery 声明（subagents 经 agent-runtime 回传）——同一套登记口径。 */
function handleSubagentDeliveryDeclared(declaration) {
  try {
    const conversationId = declaration?.conversationId ?? null;
    if (!conversationId || !flowService?.has(conversationId)) return;
    const controller = flowService.controllerFor(conversationId);
    registerDeclaredDeliverable({
      conversationId,
      controller,
      runId: typeof declaration.rootRunId === 'string' && declaration.rootRunId ? declaration.rootRunId : null,
      file: declaration.file,
      ...(declaration.workspace ? { workspace: declaration.workspace } : {}),
      ...(declaration.taskId ? { taskId: declaration.taskId } : {}),
    });
  } catch (error) {
    llmLog.warn(`[delivery] 子 agent 交付登记异常：${error?.message ?? error}`);
  }
}

/** 062：会话绑定工作区（交付链接/读取按它解析；档案 workspaceId → 工作区服务）。 */
function conversationWorkspaceOf(conversationId) {
  try {
    const session = getConversationSession(conversationId);
    const workspaceId = session?.workspaceId ?? null;
    const view = getWorkspaceService()?.resolve(workspaceId ?? 'default') ?? null;
    if (!view || view.status !== 'ok') return null;
    return {
      dir: view.dir ?? null,
      host: view.host ?? null,
      home: view.remoteHome ?? null,
    };
  } catch {
    return null;
  }
}

/** 062：会话交付物受控 IO（渲染层预览/链接消费面；懒建，随 registerLlmIpc 装配）。 */
let conversationDeliverableIo = null;
function getConversationDeliverableIo() {
  if (conversationDeliverableIo) return conversationDeliverableIo;
  const openInBrowser = createBrowserFileOpener({
    openExternal: (url) => shell.openExternal(url),
    openPath: (filePath) => shell.openPath(filePath),
    log: llmLog,
  });
  conversationDeliverableIo = createConversationDeliverableIo({
    flowService: { has: (id) => flowService?.has(id) ?? false, controllerFor: (id) => flowService?.controllerFor(id) },
    workspaceOf: conversationWorkspaceOf,
    remoteIo: {
      read: async ({ host, filePath }) => {
        const remoteService = getRemoteService?.();
        if (!remoteService) return null;
        const rfs = remoteService.remoteFsFor({ host, dir: path.posix.dirname(String(filePath)) });
        const info = await rfs.stat(String(filePath));
        if (!info.ok || !info.isFile) return null;
        const read = await rfs.readBytes(String(filePath), 8 * 1024 * 1024);
        return read.ok ? read.buf : null;
      },
    },
    openInBrowser,
    fileActions: createLocalFileActions({
      revealPath: filePath => shell.showItemInFolder(filePath),
      openDirectory: directory => shell.openPath(directory),
      getApplicationIcon: async applicationPath => (await app.getFileIcon(applicationPath, { size: 'small' })).toDataURL(),
      chooseApplication: () => {
        const options = { title: '选择打开此文件的应用程序', defaultPath: '/Applications', properties: ['openFile'], filters: [{ name: '应用程序', extensions: ['app'] }] };
        return state.mainWindow ? dialog.showOpenDialog(state.mainWindow, options) : dialog.showOpenDialog(options);
      },
    }),
    openPath: async (filePath) => {
      const message = await shell.openPath(filePath);
      return message ? { ok: false, message } : { ok: true };
    },
    log: llmLog,
  });
  return conversationDeliverableIo;
}

/** 056：主 agent／子 agent 运行时（首个回合或 task.ipc 取快照时懒建）。 */
export function getAgentRuntime() {
  if (runtime) return runtime;
  runtime = createAgentRuntime({
    isOnline: () => net.isOnline(),
    loadArchiveAgent: getConversationAgent,
    loadArchiveTurns: getConversationTurnsRaw,
    loadArchiveSession: getConversationSession,
    saveArchiveAgent: saveConversationAgent,
    onEventTurn: handleEventTurn,
    getSkillService,
    nativeMemory: true,
    onGoalVerification: (conversationId, call) => {
      if (call.usageDetail) recordConversationUsage(conversationId, {
        source: 'chat', modelKey: call.modelKey, modelName: call.providerName,
        requestedModel: call.model, ...call.usageDetail, at: call.at,
      });
    },
    getWorkspaceService,
    getWorkflowService,
    history: runtimeDeps?.history ?? null,
    onModelUsage: runtimeDeps?.onModelUsage ?? null,
    onTaskState: (snapshot) => {
      runtimeDeps?.onTaskState?.(snapshot);
      // 聚合快照内所有任务分别进所属 flow，不能只投影 primaryTask。
      try {
        taskFactPublisher.publish(snapshot);
      } catch (error) { llmLog.warn(`任务事实投影失败：${error?.message ?? error}`); }
    },
    // 062：子 agent 的交付声明提升到会话 flow（与主 agent 同一套查证登记）。
    onDeliveryDeclared: handleSubagentDeliveryDeclared,
    log: llmLog,
  });
  // 024 回卷：档案被剪时主 agent 条目作废（conversation.ipc 监听）。
  setArchiveCutListener((conversationId) => runtime.invalidate(conversationId));
  return runtime;
}

/**
 * 事件唤醒回合（后台子 agent 完成）收口：先在流控制器占事件槽（队列续排被它挡住），
 * 回答 → 落档＋turnState 广播（announce 标记，渲染层据此播报）＋语音来源时经口压一句。
 */
function handleEventTurn(conversationId, result, meta) {
  const controller = flowService?.controllerFor(conversationId) ?? null;
  const eventRunId = `event-run-${++eventTurnSeq}`;
  controller?.applyFact({ type: 'run-preparing', runId: eventRunId, source: 'event', inputIds: [], at: Date.now() });
  const closeEventRun = (outcome) => {
    controller?.applyFact({ type: 'run-settled', runId: eventRunId, at: Date.now() });
    controller?.applyFact({ type: 'run-closed', runId: eventRunId, outcome, at: Date.now() });
  };
  const text = String(result?.lastText ?? result?.texts?.join('\n\n') ?? '').trim();
  if (!text) {
    llmLog.info(`[agent] ${conversationId} 事件回合无正文（${result?.modelError ?? '无输出'}），不落档`);
    closeEventRun('completed');
    return;
  }
  controller?.applyFact({ type: 'run-started', runId: eventRunId, at: Date.now() });
  controller?.applyFact({ type: 'part-appended', runId: eventRunId, part: { partId: `${eventRunId}:text`, kind: 'text', content: text } });
  const ctx = lastTurnCtx.get(conversationId) ?? null;
  const inputSource = ctx?.inputSource ?? 'voice';
  const turnId = 8000 + (eventTurnSeq += 1);
  const requestId = `event-${randomUUID()}`;
  const runToken = conversationTurns.begin({ conversationId, turnId, requestId });
  const responseId = `reply-${randomUUID()}`;
  const createdAt = Date.now();
  conversationTurns.update(runToken, { kind: 'text', text });
  recordUsages(conversationId, ctx, (result?.usages ?? []).filter(Boolean).map((detail) => ({ model: ctx?.config?.model ?? null, detail })));
  const finish = (payload) => {
    if (!conversationTurns.current(runToken)) return;
    const saved = persistConversationTurns(conversationId, [{ id: responseId, runId: eventRunId, createdAt, author: 'hemi', text }]);
    if (!saved.ok) llmLog.warn(`[agent] ${conversationId} 事件回答落档失败（不阻断播报）`);
    llmLog.info(`[agent] ${conversationId} 事件回合收口 ${text.length} 字${meta?.alias ? `（子 agent ${meta.alias}）` : ''}`);
    conversationTurns.settle(runToken, { result: { ...payload, responseId, createdAt, text, announce: true, inputSource } });
    // 事件回合占流槽：关闭后续排队发（暂停时不派，控制器自持口径）。
    closeEventRun('completed');
    try { recordContextUsage(conversationId); } catch { /* 收口失败不影响回合 */ }
  };
  if (inputSource !== 'voice') {
    finish({ speechText: null });
    return;
  }
  void (async () => {
    let speechText = null;
    try {
      const config = await resolveLightModel({ getProfiles, profileId: ctx?.profileId ?? null });
      if (config?.apiKey && config?.model) {
        speechText = await summarizeForSpeech({ config, question: meta?.description || ctx?.userText || '', answer: text, kind: 'task' });
      }
    } catch (error) {
      llmLog.warn(`[agent] ${conversationId} 事件回答的口语转述失败（回退全文）：${error.message}`);
    }
    finish({ speechText });
  })();
}

/** conversationId → 最近一回合的上下文（事件回合与工具执行期读取）。 */
const lastTurnCtx = new Map();

/** 主 agent 每次物理模型调用的用量记账（048 D7）。 */
function recordUsages(conversationId, ctx, usages) {
  if (!conversationId || !ctx) return;
  for (const call of usages) {
    if (!call?.detail) continue;
    const fallbackActive = Boolean(ctx.fallback && call.model === ctx.fallback.model);
    const identity = fallbackActive ? ctx.fallback : ctx.config;
    recordConversationUsage(conversationId, {
      source: fallbackActive ? 'fallback' : 'chat',
      modelKey: identity?.modelKey ?? call.model ?? '未知模型',
      modelName: identity?.name ?? '',
      requestedModel: identity?.model ?? call.model ?? '',
      ...call.detail,
      at: Date.now(),
    });
  }
}

// ================================================================ 057 S2：runtime 适配层
// 控制器的 runtime 效果＝现有执行内胆：start=executeChatTurn（自闭合：结束时自呈
// run-settled/run-closed 事实）、
// stop=conversationTurns.cancel＋主 agent abort。

// 059：workflow-start 的宿主分派器（createWorkflowFlowRouter 产物）——由工作流服务
// 装配时注入；未注入时 workflow 输入按失败自闭合（卡片标 failed），不冒充成功。
let workflowFlowRouter = null;

export function setWorkflowFlowRouter(router) {
  workflowFlowRouter = typeof router?.start === 'function' ? router : null;
}

function createLlmFlowRuntime(conversationId) {
  const controllerOf = () => flowService.controllerFor(conversationId);
  const activeTurnId = (runId) => turnIdByRun.get(conversationId)?.get(runId) ?? null;

  return {
    freezeInput: input => freezeAcceptedInput({ store: getProfiles(), workspaceService: getWorkspaceService(), input }),
    async start({ runId, envelope, source, continuationOf }) {
      // 059：workflow-start 结构化输入走宿主 workflow 分派器（S3a）——不进 executeChatTurn，
      // 不造用户文字回合；卡片事实由 router 经 part-updated 更新在同一 partId 上；
      // 终态自闭合与 chat 分支同一收口语义（run-settled＋run-closed）。
      if (envelope?.workflow) {
        const controller = controllerOf();
        const generation = controller.getSnapshot().generation;
        if (!workflowFlowRouter) {
          controller.applyFact({
            type: 'part-updated',
            runId,
            generation,
            partId: `card-${envelope.workflow.invocationId}`,
            patch: { kind: 'workflow-card', invocationId: envelope.workflow.invocationId, status: 'failed', error: '工作流运行器未装配' },
            at: Date.now(),
          });
          controller.applyFact({ type: 'run-settled', runId, at: Date.now(), generation });
          controller.applyFact({ type: 'run-closed', runId, outcome: 'failed', at: Date.now(), generation });
          return { modelUsed: null, result: null, aborted: false };
        }
        const completion = (async () => {
        try {
        const outcome = await workflowFlowRouter.start({
          runId,
          envelope,
          generation,
          applyFact: (fact) => {
            try { controller.applyFact(fact); } catch { /* 迟到事实按身份丢弃 */ }
          },
        });
        controller.applyFact({ type: 'run-settled', runId, at: Date.now(), generation });
        // 人工输入挂起（outcome waiting）按 completed 闭合 flow 运行：队列槽释放、
        // 后续输入照常派发（HI-R02/R06）；卡片停在 waiting 由 workflow 事实维护。
        const wfOutcome = outcome?.status === 'completed' || outcome?.status === 'waiting' ? 'completed' : outcome?.status === 'stopped' ? 'stopped' : 'failed';
        // 挂起保留原目标的续跑身份，但释放同会话执行占用；终态仍不可重新执行。
        if (outcome?.status === 'waiting')
          await runtime?.suspendWorkflow(conversationId, envelope.workflow.workflowRunId);
        else
          await runtime?.completeConversation(conversationId, wfOutcome, null, envelope.workflow.workflowRunId);
        controller.applyFact({ type: 'run-closed', runId, outcome: wfOutcome, at: Date.now(), generation });
        completeInput(envelope?.inputId, outcome?.ok ? null : new Error('工作流运行失败'), outcome);
        return { modelUsed: null, result: outcome, aborted: false };
        } catch (error) {
          controller.applyFact({ type: 'run-closed', runId, outcome: 'failed', at: Date.now(), generation });
          completeInput(envelope?.inputId, error, null);
        }
        })();
        void completion.catch(() => {});
        return { modelUsed: null };
      }
      const payload = source === 'queue'
        ? buildQueueChatPayload(conversationId, envelope)
        : pendingChatPayloads.get(envelope?.inputId) ?? buildQueueChatPayload(conversationId, envelope);
      pendingChatPayloads.delete(envelope?.inputId);
      if (payload && payload.turnId != null) {
        let byRun = turnIdByRun.get(conversationId);
        if (!byRun) { byRun = new Map(); turnIdByRun.set(conversationId, byRun); }
        byRun.set(runId, payload.turnId);
      }
      const controller = controllerOf();
      const generation = controller.getSnapshot().generation;
      // 057：流事件 → flow part 事实（150ms 合批冲刷——渲染层实时流仍走 llm:delta，
      // flow 补丁不必逐 token；收口/失败前强制冲净）。
      const projector = createRunPartProjector({ runId, generation, inputId: envelope?.inputId ?? null });
      let factBuffer = [];
      const pendingDeliveries = [];
      let flushTimer = null;
      const flushFacts = () => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        const facts = factBuffer;
        factBuffer = [];
        for (const fact of facts) {
          try { controller.applyFact(fact); } catch { /* 归约层按身份丢弃 */ }
        }
      };
      const bufferFact = (fact) => {
        factBuffer.push(fact);
        if (!flushTimer) {
          flushTimer = setTimeout(flushFacts, 150);
          flushTimer.unref?.();
        }
      };
      // 启动回执与执行结果分离：控制器只等待本次启动，正式内容／终态继续进 flow。
      const completion = (async () => {
      try {
        const result = await executeChatTurn(payload ?? { conversationId }, {
          runId,
          continuationOf,
          // 057：用户轮派发即落档——原始 envelope 经参数交给内胆，在 obtain 之后落档
          //（先于 obtain 落档会让首回合建新 agent 时从档案 turns 种子带上这条
          // 未回答用户轮，prompt 再供给一次＝同文双写，2026-10-15 真机钓出）。
          dispatchEnvelope: envelope,
          dispatchMeta: {
            profileId: typeof payload?.profileId === 'string' && payload.profileId ? payload.profileId
              : payload?.profileId === null ? null : undefined,
            workspaceId: typeof payload?.workspaceId === 'string' && payload.workspaceId ? payload.workspaceId
              : payload?.workspaceId === null ? null : undefined,
          },
          onStreamEvent: (event) => {
            // 062：主 agent 的正式交付声明 → 宿主查证后进 flow.artifacts＋对话入口
            //（registerConversationDeliverable 内做路径解析/边界复核/身份去重/迟到
            // 丢弃；失败如实落 notice，不再采信模型给的路径字符串）。
            if (event?.kind === 'tool_end' && event.tool === 'register_delivery' && !event.isError) {
              flushFacts();
              const files = Array.isArray(event.args?.files) ? event.args.files : [];
              const workspace = lastTurnCtx.get(conversationId)?.workspace ?? null;
              for (const file of files) {
                pendingDeliveries.push(registerDeclaredDeliverable({
                  conversationId, controller, runId, file,
                  afterInputId: projector.afterInputId, generation,
                  ...(workspace ? { workspace } : {}),
                }));
              }
            }
            for (const fact of projector.handle(event)) bufferFact(fact);
            // 派单锚点必须先于子任务快照可见。仅正文增量合批；短任务可能在
            // 150ms 内收口，否则 publisher 会把尚未入流的调用当作已撤回而丢弃。
            if ((event?.kind === 'tool_start' && event.tool === 'task') || ['recovery','request-reset'].includes(event?.kind)) flushFacts();
          },
        });
        for (const fact of projector.finish({blocked:result.blocked,halted:result.halted})) bufferFact(fact);
        flushFacts();
        await Promise.allSettled(pendingDeliveries);
        controller.applyFact({ type: 'run-settled', runId, at: Date.now(), generation });
        // 057 S3：回执用量随运行收口进快照（渲染层派生回执的用量标签同一来源）。
        const outcome = goalRunOutcome(result);
        const saveError = await closeConversationRun({controller, runId, generation, outcome,
          persist: () => runtime?.completeConversation(conversationId, outcome, null, runId), usage: result?.usage ?? null,
          ...(result.waitingForUser ? {waitingForUser: result.waitingForUser} : {}),
          ...(result.blocked ? {blocked:result.blocked} : {}),
          ...(result.halted ? {halted:result.halted} : {}),
        });
        if (saveError) llmLog.error(`turn ${runId} 终态保存失败：${saveError.message}`);
        completeInput(envelope?.inputId, saveError, saveError ? null : result);
        return { modelUsed: result?.usage?.requestedModel ?? null, result, aborted: false, ...(saveError ? {persistenceFailed:true} : {}) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if(error?.code==='cleanup-unconfirmed'){
          flushFacts();
          closeUnconfirmedCommand(controller,{runId,generation,error});
          await commandDeadline(runtime?.completeConversation(conversationId,'failed',message,runId),5000,'异常终态保存超时').catch(()=>{});
          completeInput(envelope?.inputId,error,null);
          return {aborted:false,pendingStop:false,cleanupUnconfirmed:true};
        }
        const cancelled = Boolean(controller.getSnapshot().runs[runId]?.stopRequested) || error?.name === 'AbortError' || /回合已取消/.test(message);
        if (error?.pendingStop) {
          flushFacts();
          controller.applyFact({ type: 'run-stopping', runId, reason: 'stop', generation, at: Date.now() });
          for (const fact of projector.finish({ error })) controller.applyFact(fact);
          completeInput(envelope?.inputId, error, null);
          return { aborted: false, pendingStop: true };
        }
        try { await stoppingRuns.get(runId); } catch (stopError) {
          flushFacts();
          if(stopError?.code==='cleanup-unconfirmed'){
            closeUnconfirmedCommand(controller,{runId,generation,error:stopError});
            completeInput(envelope?.inputId,stopError,null);
            return {aborted:false,pendingStop:false,cleanupUnconfirmed:true};
          }
          for (const fact of projector.finish({ error: stopError })) controller.applyFact(fact);
          llmLog.error(`turn ${runId} 停止未确认：${stopError.message}`);
          completeInput(envelope?.inputId, stopError, null);
          return { aborted: false, pendingStop: true };
        }
        flushFacts();
        for (const fact of projector.finish({ error: cancelled ? null : error, stopped: cancelled })) {
          try { controller.applyFact(fact); } catch { /* 已收口则丢弃 */ }
        }
        controller.applyFact({ type: 'run-settled', runId, at: Date.now(), generation });
        const hasArtifacts = Object.values(controller.getSnapshot().artifacts).some(artifact => artifact.producerRunId === runId || artifact.producers?.some(producer => producer.runId === runId));
        const failedOutcome = hasArtifacts ? 'partial' : 'failed';
        const saveError = await closeConversationRun({controller,runId,generation,outcome:cancelled?'stopped':failedOutcome,
          pauseQueue:!cancelled,persist:()=>runtime?.completeConversation(conversationId,cancelled?'cancelled':failedOutcome,message,runId)});
        if (saveError) llmLog.error(`turn ${runId} 终态保存失败：${saveError.message}`);
        // 057 口径：已派发的输入不因执行失败自动重排（R-07 重试需用户操作）；
        // 失败事实进 flow（notice part＋failed 运行），渲染层从快照派生。
        if (cancelled) {
          completeInput(envelope?.inputId, null, { aborted: true });
          return { aborted: true, modelUsed: null, result: null };
        }
        completeInput(envelope?.inputId, error, null);
        throw error;
      } finally {
        if (flushTimer) clearTimeout(flushTimer);
        turnIdByRun.get(conversationId)?.delete(runId);
        stoppingRuns.delete(runId);
      }
      })();
      // 执行失败已进入 flow 和结果通路；队列派发没有 IPC 等待者也不得未处理拒绝。
      void completion.catch(() => {});
      return { modelUsed: null };
    },

    async retryRecovery({ runId, recoveryId }) {
      if (controllerOf().getSnapshot().activeRunId !== runId) return { ok: false, code: 'run-changed' };
      return { ok: Boolean(runtime?.get(conversationId)?.retryConnection(recoveryId)) };
    },
    backgroundCommand: request => getAgentRuntime().backgroundCommand(conversationId,request),
    async cancelWaitingUser({ runId }) {
      await getAgentRuntime().completeConversation(conversationId, 'stopped', '用户停止等待答复', runId);
    },
    async withdraw({input}) {
      if(input.workflow)await workflowFlowRouter?.withdraw?.(input.workflow);
    },
    async stop({ runId, reason }) {
      if (stoppingRuns.has(runId)) {
        // 用户主动停止可把“等待阶段结束”升级为立即取消，仍沿用同一退出屏障。
        if (reason === 'stop') await runtime?.abort(conversationId);
        return stoppingRuns.get(runId);
      }
      // 先建立停止屏障；执行收口必须等待主会话及所有所属子工作真正退出。
      const stopping = Promise.resolve().then(async () => {
        if (workflowFlowRouter?.owns?.(runId)) {
          await workflowFlowRouter.stop({ runId, reason });
          return { ok: true };
        }
        if (reason === 'promote') await runtime?.requestHandoff(conversationId);
        const turnId = activeTurnId(runId);
        if (turnId != null) conversationTurns.cancel({ conversationId, turnId });
        const snapshot = controllerOf().getSnapshot();
        const inputs = snapshot.timeline.filter((item) => item.kind === 'user' && item.runId === runId).map((item) => item.text);
        await runtime?.stopRoot(conversationId, runId, {reason: snapshot.runs[runId]?.stopReason ?? reason, inputs});
        return { ok: true };
      });
      stoppingRuns.set(runId, stopping);
      return stopping;
    },
  };
}

function completeInput(inputId, error, result) {
  inputResults.settle(inputId, error ? { error } : result);
}

/** 队列派发的 chat payload：最新历史＋条目正文（旧 turn-queue 同口径；profile 缺省）。 */
function buildQueueChatPayload(conversationId, envelope) {
  const history = (getLastDialogueHistory(conversationId) ?? []).map((entry) => ({ ...entry }));
  chatSeq += 1;
  return {
    turnId: chatSeq,
    messages: [...history, { role: 'user', content: envelope?.text ?? '' }],
    conversationId,
    inputSource: envelope?.inputSource ?? 'text',
    attachmentIds: envelope?.attachmentIds ?? [],
    references: envelope?.references ?? [],
    // 063：显式技能选择随 inputId 冻结，派发时还原。
    skills: sanitizeSkillSelections(envelope?.skills),
    // 060 S1：队列派发时按 pending 条目还原派发资料（受理时随 inputId 冻结）。
    ...(envelope?.profileId === undefined ? {} : { profileId: envelope.profileId }),
    ...(envelope?.workspaceId === undefined ? {} : { workspaceId: envelope.workspaceId }),
    ...(Array.isArray(envelope?.attachmentViews) && envelope.attachmentViews.length ? { attachmentViews: envelope.attachmentViews } : {}),
  };
}

// ================================================================ 057 S2：queue:* 命令面
// 渲染层已切 flow 订阅（队列托盘/派发转正/回复都从快照派生）——queue:push 事件
// 翻译层退役；本节只剩命令入参校验与错误码文案。

const TEXT_LIMIT = 20_000;

/** 057 S3-2：附件视图净化（有界数组；只保展示字段）。 */
function sanitizeAttachmentViews(views) {
  if (!Array.isArray(views)) return [];
  return views
    .filter((view) => view && typeof view === 'object' && typeof view.attachmentId === 'string')
    .slice(0, 12)
    .map((view) => ({
      attachmentId: view.attachmentId,
      conversationId: typeof view.conversationId === 'string' ? view.conversationId : '',
      name: String(view.name ?? '附件').slice(0, 120),
      kind: view.kind === 'image' ? 'image' : 'text',
      sizeBytes: Number(view.sizeBytes ?? 0) || 0,
      status: view.status === 'failed' ? 'failed' : 'ready',
      ...(typeof view.message === 'string' && view.message ? { message: view.message.slice(0, 160) } : {}),
      source: view.source === 'drop' || view.source === 'paste' ? view.source : 'picker',
      ...(typeof view.originPath === 'string' ? { originPath: view.originPath.slice(0, 300) } : {}),
      // 缩略图随档案冻结（历史气泡跨重启仍显示小图）；暂存路径供重启后预览受控回退。
      ...(typeof view.thumbnailUrl === 'string' && view.thumbnailUrl.startsWith('data:image/') && view.thumbnailUrl.length <= 400_000
        ? { thumbnailUrl: view.thumbnailUrl }
        : {}),
      ...(typeof view.stagedPath === 'string' && view.stagedPath ? { stagedPath: view.stagedPath.slice(0, 300) } : {}),
      ...(Number.isFinite(view.registeredAt) ? { registeredAt: view.registeredAt } : {}),
    }));
}

/** 057 S3-2／063：`@` 引用选择净化（有界数组；kind 白名单＋身份字段按 kind 保留）。 */
const REFERENCE_KINDS = new Set(['attachment', 'artifact', 'context', 'workflow', 'file', 'folder', 'conversation']);
function sanitizeReferenceSelections(references) {
  if (!Array.isArray(references)) return [];
  return references
    .filter((view) => view && typeof view === 'object' && typeof view.kind === 'string' && REFERENCE_KINDS.has(view.kind))
    .slice(0, 12)
    .map((view) => ({
      kind: view.kind,
      key: String(view.key ?? '').slice(0, 300),
      name: String(view.name ?? '引用').slice(0, 160),
      subtitle: String(view.subtitle ?? '').slice(0, 200),
      ...(typeof view.attachmentId === 'string' ? { attachmentId: view.attachmentId.slice(0, 120) } : {}),
      ...(typeof view.taskId === 'string' ? { taskId: view.taskId.slice(0, 120) } : {}),
      ...(typeof view.artifactId === 'string' ? { artifactId: view.artifactId.slice(0, 120) } : {}),
      ...(typeof view.contextId === 'string' ? { contextId: view.contextId.slice(0, 120) } : {}),
      ...(typeof view.workflowId === 'string' ? { workflowId: view.workflowId.slice(0, 120) } : {}),
      ...(Number.isFinite(view.workflowRevision) ? { workflowRevision: Number(view.workflowRevision) } : {}),
      ...(typeof view.refPath === 'string' ? { refPath: view.refPath.slice(0, 400) } : {}),
      ...(typeof view.targetConversationId === 'string' ? { targetConversationId: view.targetConversationId.slice(0, 120) } : {}),
    }));
}

/** 063：显式技能选择净化（有界数组；token/name 必填，source 二值收敛）。 */
function sanitizeSkillSelections(skills) {
  if (!Array.isArray(skills)) return [];
  return skills
    .filter((view) => view && typeof view === 'object' && typeof view.name === 'string' && view.name.trim())
    .slice(0, 6)
    .map((view) => ({
      token: String(view.token ?? view.name).slice(0, 120),
      name: String(view.name).slice(0, 120),
      source: view.source === 'project' ? 'project' : 'library',
      skillId: String(view.skillId ?? '').slice(0, 300),
      ...(typeof view.description === 'string' && view.description ? { description: view.description.slice(0, 200) } : {}),
    }));
}

/** 057 S3-2d：用户轮随派发落档（id＝flow inputId；宿主是用户轮的事实来源）。
 *  新会话首回合由此建档（带 profile/workspace——渲染层提交时保存已退役）。 */
function persistUserTurn(conversationId, envelope, { profileId = undefined, workspaceId = undefined } = {}) {
  if (!conversationId || !envelope) return;
  const userTurn = {
    id: envelope.inputId,
    createdAt: Date.now(),
    author: 'user',
    text: String(envelope.text ?? ''),
    inputSource: envelope.inputSource === 'voice' ? 'voice' : 'text',
    ...(Array.isArray(envelope.attachmentViews) && envelope.attachmentViews.length
      ? { attachments: envelope.attachmentViews }
      : {}),
    // 063：引用与技能随档冻结（重启后历史气泡的标签回显来源）。
    ...(Array.isArray(envelope.references) && envelope.references.length
      ? { references: sanitizeReferenceSelections(envelope.references) }
      : {}),
    ...(Array.isArray(envelope.skills) && envelope.skills.length
      ? { skills: sanitizeSkillSelections(envelope.skills) }
      : {}),
  };
  try {
    const appended = persistConversationTurns(conversationId, [userTurn]);
    if (!appended?.ok) {
      ensureConversationArchive({
        id: conversationId,
        ...(profileId !== undefined ? { profileId } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        firstTurns: [userTurn],
      });
    } else if (profileId !== undefined || workspaceId !== undefined) {
      // 元数据随档（不重复建轮；空 turns 合并不动宿主事实）。
      ensureConversationArchive({ id: conversationId, ...(profileId !== undefined ? { profileId } : {}), ...(workspaceId !== undefined ? { workspaceId } : {}) });
    }
  } catch (error) {
    llmLog.warn(`用户轮落档失败（${conversationId}，不阻断回合）：${error?.message ?? error}`);
  }
}

function mapCommandError(result, fallbackMessage) {
  const messages = {
    'queue-full': `待发送队列最多 8 条，先处理几条再排`,
    'stale-input': '这条消息刚被改过，刷新后重试',
    locked: '正在发送的消息不能编辑或撤回',
    'not-found': '没有这条待发送消息',
    'run-changed': '当前运行已变化，稍后重试',
    'handoff-busy': '上一句正在接管，语音已保留，请稍后重试',
  };
  return result?.message || messages[result?.code] || fallbackMessage;
}

// ================================================================ chat 执行内胆（056 原样，调度已上移控制器）

async function executeChatTurn(payload, { onStreamEvent = null, dispatchEnvelope = null, dispatchMeta = {}, runId = null, continuationOf = null } = {}) {
  const turnId = Number(payload?.turnId) || 0;
  const turnStartedAt = Date.now();
  const conversationId = typeof payload?.conversationId === 'string' && payload.conversationId
    ? payload.conversationId
    : null;
  const runToken = conversationTurns.begin({ conversationId, turnId,
    ...(typeof payload?.requestId === 'string' ? { requestId: payload.requestId } : {}),
  });
  let bodyDeltaCount = 0;
  let firstBodyAt = null;
  let runtimeDiagnostic = null;
  let taskStartedAt = null;
  const persistReply = (reply) => {
    if (!conversationTurns.current(runToken)) throw new Error('回合已取消。');
    const responseId = `reply-${randomUUID()}`;
    const endedAt = Date.now();
    // 档案按 createdAt 排序：派过子 agent 的回合把回答排到任务卡之后。
    const createdAt = replyCreatedAt(endedAt, taskStartedAt);
    const saved = persistConversationTurns(conversationId, [{
      id: responseId, runId, createdAt, author: 'hemi', text: reply.text,
      ...(reply.thinking ? { thinking: reply.thinking } : {}),
      ...(reply.parts?.length ? { parts: reply.parts } : {}),
      ...(reply.usage ? { usage: reply.usage } : {}),
    }]);
    if (conversationId && !saved.ok) llmLog.warn(`turn ${turnId} 回复落档失败（不阻断回执）`);
    if (runtimeDiagnostic) recordConversationDiagnostic(conversationId, {
      ...runtimeDiagnostic,
      endedAt,
      durationMs: endedAt - turnStartedAt,
      thinkingDurationMs: reply.thinking?.durationMs ?? null,
      thinkingVisible: Boolean(reply.thinking?.text),
      bodyDeltaCount,
      firstBodyMs: firstBodyAt == null ? null : firstBodyAt - turnStartedAt,
    });
    const result = { ...reply, responseId, createdAt };
    conversationTurns.settle(runToken, { result });
    return result;
  };
  persistConversationInput(conversationId);
  try {
    const inputSource = payload?.inputSource === 'text' ? 'text' : 'voice';
    const profileId = typeof payload?.profileId === 'string' && payload.profileId ? payload.profileId : null;
    const policySnapshot = dispatchEnvelope?.modelPolicySnapshot ?? payload?.modelPolicySnapshot
      ?? await freezeModelPolicy({ store: getProfiles(), modelKey: profileId });
    const imageInput = (payload?.attachmentIds ?? []).some(id => getComposerAttachments()?.get?.(conversationId, id)?.kind === 'image');
    const modelPlan = await hydrateModelPlan(resolveModelPlan(policySnapshot, { requirements: imageInput ? { imageInput: true } : {} }), getProfiles());
    const routed = policySnapshot.mode === 'routed';
    const config = modelPlan.primary;
    const fallback = modelPlan.allowedFallbacks[0] ?? null;
    if (!config.model || !config.baseUrl) throw new Error('未配置文本模型，请先在设置中配置模型。');

    const workspaceId = typeof payload?.workspaceId === 'string' && payload.workspaceId ? payload.workspaceId : null;
    const workspaceView = getWorkspaceService()?.resolve(workspaceId ?? 'default') ?? null;
    if (workspaceId && (!workspaceView || workspaceView.status !== 'ok')) {
      throw new Error(workspaceView?.host
        ? `连不上 ${workspaceView.host}：${workspaceView?.message ?? ''}`
        : `工作区不可用：${workspaceView?.message ?? workspaceId}（可重新选择后重试）`);
    }
    const workspace = dispatchEnvelope?.workspaceSnapshot ?? payload?.workspaceSnapshot ?? (workspaceView?.status === 'ok'
      ? {
          id: workspaceView.id, type: workspaceView.type, name: workspaceView.name, dir: workspaceView.dir,
          ...(workspaceView.host ? { host: workspaceView.host, ...(workspaceView.remoteHome ? { remoteHome: workspaceView.remoteHome } : {}) } : {}),
        }
      : null);

    const rawMessages = Array.isArray(payload?.messages) ? payload.messages : [];
    if (conversationId) dialogueHistoryByConversation.set(conversationId, rawMessages);
    const lastUser = [...rawMessages].reverse().find((m) => m?.role === 'user');
    const userText = (typeof lastUser?.content === 'string' ? lastUser.content.trim() : '') || (payload?.attachmentIds?.length ? '请查看附件。' : '');
    if (!userText) throw new Error('本轮没有用户消息。');
    llmLog.info(`turn ${turnId} 收到回合：${conversationId ?? '无会话'} · ${inputSource} · 末条「${userText.replace(/\s+/g, ' ').slice(0, 30)}」`);

    runtimeDiagnostic = buildRuntimeDiagnostic({
      conversationId, requestId: randomUUID(), startedAt: turnStartedAt,
      config, executionConfig: null,
      version: app.getVersion(), platform: process.platform, versions: process.versions,
      userDataDir: app.getPath('userData'), isPackaged: app.isPackaged,
    });
    const runtimeBlock = buildRuntimeDiagnosticBlock(runtimeDiagnostic);
    // 063：显式技能选择——派发前按生产收集结果校验可用性；不可用如实失败，
    // 不按显示名换技能（collectSkills 的快照租约随校验结束立即释放）。
    const skillSelections = sanitizeSkillSelections(payload?.skills);
    if (skillSelections.length) {
      const { validateSkillSelections } = await import('../composer/capability-catalog.mjs');
      const collected = collectSkills({ skillService: getSkillService(), workspace });
      try {
        const verdict = validateSkillSelections(skillSelections, collected.items);
        if (!verdict.ok) {
          const detail = verdict.missing.map((item) => `${item.name}（${item.reason}）`).join('、');
          throw new Error(`这回合要用的技能已不可用，请移除或重新选择：${detail}`);
        }
      } finally {
        collected.release?.();
      }
    }
    const agentRuntime = getAgentRuntime();
    const preparationExecution = await agentRuntime.prepareExecution({ conversationId, runId, policySnapshot, modelPlan, workspace, generation: flowService.controllerFor(conversationId).getSnapshot().generation, get cancelled() { return runToken.controller.signal.aborted; } });
    const envelope = await withExecutionScope(preparationExecution, runToken.controller.signal, () => assembleTurnEnvelope({
      conversationId, userText, attachmentIds: payload?.attachmentIds,
      references: payload?.references, skills: skillSelections, orchestrator: false,
      workspace,
      visionCapable: config.supportsVision,
      readArtifact: async (taskId, artifactId) => runtimeDeps?.readArtifact?.(taskId, artifactId) ?? null,
      llmLog, turnId,
    }));

    // 冻结本回合上下文（工具执行期读取；事件回合复用最近一份）。
    const ctx = {
      conversationId, inputSource, profileId, workspace, userText, config, fallback, routed, policySnapshot, modelPlan,
      generation: flowService?.controllerFor(conversationId).getSnapshot().generation ?? 0,
      // 060 R-22：本回合主运行 id——子 agent spawn 记归属，插队停止按根目标取消。
      runId: typeof runId === 'string' && runId ? runId : null,
      continuationOf,
      runtimeDiagnostics: () => ({ ok: true, current: runtimeDiagnostic, recent: getConversationDiagnostics(conversationId) }),
    };
    lastTurnCtx.set(conversationId, ctx);

    // 用户答复续接等待中的目标，必须保留原页面。其它输入仍收掉旧运行，防止抢占后留下僵尸循环。
    if (!continuationOf) await agentRuntime.abort(conversationId).catch(() => {});
    const agent = await agentRuntime.obtain(ctx);
    // 057：用户轮派发即落档（dispatchEnvelope＝控制器的派发 envelope，含 inputId/附件视图）。
    if (dispatchEnvelope) persistUserTurn(conversationId, dispatchEnvelope, dispatchMeta);
    llmLog.info(`turn ${turnId} → 主 agent ${config.model}${routed ? '（角色路由）' : ''} @ ${config.baseUrl}${config.api === 'anthropic-messages' ? '（anthropic 协议）' : ''}${fallback ? `，备用 ${fallback.model}` : ''}${workspace ? `，工作区 ${workspace.name}` : ''}`);

    const turnContextText = [
      envelope.contextEnvelope,
      buildFlowFactsBlock(flowService?.controllerFor(conversationId).getSnapshot(), { inputSource, runId }),
      buildTurnContextBlock({ ambientBlock: buildAmbientBlock(), workspaceBlock: buildWorkspaceTurnBlock(workspace), runtimeBlock, routingBlock: `【本目标模型策略】${routed ? '自动路由：各角色使用用户为它配置的模型，未配置时跟随主 agent，共用已配置的备用模型；角色同时决定职责和工具边界。' : '具体模型：主 agent 与所有子 agent 均保持所选模型，不切备用。'}` }),
    ].filter(Boolean).join('\n\n');

    const streamEvent = (event) => {
      if (!conversationTurns.update(runToken, event)) return;
      if (event.kind === 'text') { bodyDeltaCount += 1; firstBodyAt ??= Date.now(); }
      onStreamEvent?.(event);
      const mainWindow = state.mainWindow;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.llm.delta, { turnId, conversationId, requestId: runToken.requestId, ...event });
      }
    };
    let thinkingStartedAt = null;
    let thinkingMs = 0;
    let thinkingText = '';
    const onStream = (assistantEvent) => {
      if (assistantEvent?.type === 'hemi_request_start') {
        streamEvent({ kind: 'request-start' });
      } else if (assistantEvent?.type === 'hemi_message_end') {
        streamEvent({ kind: 'message-end' });
      } else if (assistantEvent?.type === 'hemi_request_reset') {
        thinkingStartedAt = null;
        streamEvent({ kind: 'request-reset' });
      } else if (assistantEvent?.type === 'text_start') {
        // 后台收口仍在同一业务目标内，但新一次模型正文须保留段落边界。
        if (conversationTurns.getState(conversationId)?.parts?.at(-1)?.type === 'text') streamEvent({ kind: 'text', text: '\n\n' });
      } else if (assistantEvent?.type === 'text_delta') {
        const delta = typeof assistantEvent.delta === 'string' ? assistantEvent.delta : '';
        if (delta) streamEvent({ kind: 'text', text: delta });
      } else if (assistantEvent?.type === 'thinking_start') {
        thinkingStartedAt = Date.now();
        streamEvent({ kind: 'thinking_start' });
      } else if (assistantEvent?.type === 'thinking_delta') {
        const delta = typeof assistantEvent.delta === 'string' ? assistantEvent.delta : '';
        if (delta) {
          thinkingText += delta;
          streamEvent({ kind: 'thinking', text: delta });
        }
      } else if (assistantEvent?.type === 'thinking_end') {
        if (thinkingStartedAt != null) {
          thinkingMs += Date.now() - thinkingStartedAt;
          thinkingStartedAt = null;
        }
        streamEvent({ kind: 'thinking_end' });
      }
    };
    /** 056：主 agent 自己的工具调用进对话流（渲染层折叠展示）。
     *  057：tool_end 也带（摘要后）args——交付声明等「结束时才知成败、参数在开始」
     *  的捕获需要（register_delivery 的 files 只在起跑事件里完整）。 */
    const onProgress = (event) => {
      if (event.kind === 'tool-start' && event.tool === 'task') taskStartedAt ??= Date.now();
      streamEvent({
        kind: event.kind === 'tool-start' ? 'tool_start' : 'tool_end',
        tool: event.tool,
        toolCallId: event.toolCallId,
        // 交付声明参数（files/sources）是小数组且宿主要捕获——原样透传；
        // 其余工具维持摘要口径（有界、不带大段正文）。
        args: event.tool === 'register_delivery' ? (event.args ?? {}) : summarizeArgs(event.args),
        ...(event.kind === 'tool-start' ? {} : { isError: Boolean(event.isError), background: Boolean(event.background), stopped: Boolean(event.stopped), commandId: event.commandId }),
      });
    };
    const calls = [];
    const onActivity = activity => streamEvent({ kind: 'activity', activity });
    const onRecovery = recovery => streamEvent({ kind: 'recovery', recovery });
    const onModelCall = (call) => {
      if (call.usageDetail) calls.push({ model: call.model, detail: call.usageDetail });
    };

    const result = await conversationTurns.run(
      async () => {
        agent.on('stream', onStream);
        agent.on('progress', onProgress);
        agent.on('model-call', onModelCall);
        agent.on('activity', onActivity);
        agent.on('recovery', onRecovery);
        // 056：备用接替/回到主模型要留痕——之前静默切换，日志一直写着主模型，实际跑的是备用。
        const onModelRoute = (event) => {
          llmLog.info(`turn ${turnId} 模型切换 → ${event?.to?.model ?? '?'}${event?.fallbackUsed ? '（主模型失败，本回合由备用接替）' : '（回到主模型）'}`);
        };
        agent.on('model-route', onModelRoute);
        let run;
        try {
          run = await agentRuntime.runRootTurn(conversationId, { userText, inputId: dispatchEnvelope?.inputId, contextText: turnContextText, imageBlocks: envelope.imageBlocks,
            getBudgetArtifacts: () => Object.values(flowService.controllerFor(conversationId).getSnapshot().artifacts).filter(artifact => artifact.producerRunId === runId || artifact.producers?.some(producer => producer.runId === runId)),
          });
        } finally {
          agent.off('stream', onStream);
          agent.off('progress', onProgress);
          agent.off('model-call', onModelCall);
          agent.off('activity', onActivity);
          agent.off('recovery', onRecovery);
          agent.off('model-route', onModelRoute);
        }
        if (run.aborted || runToken.controller.signal.aborted) throw new Error('回合已取消。');
        if (run.modelError) throw new Error(`回合未完成：${describeModelError(run.modelError)}`);
        // 056：多轮工具往返中途的文字（「我先看看」）也是回答的一部分——全部按序拼接。
        const replyText = run.texts.join('\n\n').trim() || '刚才这一句没有生成内容，请再说一次。';
        recordUsages(conversationId, ctx, calls);
        const total = calls.reduce((acc, call) => {
          acc.input += call.detail.input; acc.output += call.detail.output;
          acc.cacheRead += call.detail.cacheRead; acc.cacheWrite += call.detail.cacheWrite;
          return acc;
        }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        for (const [index, call] of calls.entries()) {
          const prompt = call.detail.input + call.detail.cacheRead + call.detail.cacheWrite;
          llmLog.info(`turn ${turnId} 第 ${index + 1} 轮 usage ${call.model ? `${call.model} ` : ''}入 ${prompt} / 出 ${call.detail.output} tokens（缓存读 ${call.detail.cacheRead} / 写 ${call.detail.cacheWrite}）`);
        }
        // 056：回合内容按到达顺序成段（思考／正文／工具组）落档，回看与流式同一形态。
        const parts = finalizeTurnParts(conversationTurns.getState(conversationId)?.parts);
        // 用量标签记实际作答的模型（最后一次调用）：备用接替时不能仍写主模型。
        const usageOfTurn = () => {
          const answered = calls.at(-1)?.model ?? null;
          const configured = config.model;
          if (!answered || answered === configured) {
            return { modelKey: config.modelKey ?? config.model, modelName: config.name ?? '', requestedModel: configured, ...total, genMs: 0 };
          }
          const fb = fallback?.model === answered ? fallback : null;
          return {
            modelKey: fb?.modelKey ?? answered, modelName: fb?.name ?? '', requestedModel: answered,
            ...total, genMs: 0,
          };
        };
        return {
          text: replyText,
          ...(hasNonTextParts(parts) ? { parts } : {}),
          ...(thinkingText || thinkingMs ? { thinking: { text: thinkingText, durationMs: thinkingMs } } : {}),
          ...(calls.length ? { usage: usageOfTurn() } : {}),
          toolNames: run.toolNames,
          goalComplete: run.goalComplete,
          ...(run.waitingForUser ? {waitingForUser: run.waitingForUser} : {}),
          ...(run.blocked ? {blocked:run.blocked} : {}),
          ...(run.halted ? {halted:run.halted} : {}),
          ...(run.budgetLimited ? { budgetLimited: true } : {}),
        };
      },
      { token: runToken, conversationId: conversationId ?? null, turnIdLabel: `turn-${turnId}` },
    );
    let speechText = null;
    if (inputSource === 'voice' && !result.budgetLimited) {
      try {
        speechText = await summarizeForSpeech({ config, question: userText, answer: result.text,
          signal: runToken.controller.signal, executionContext: agentRuntime.executionForConversation(conversationId, 'speech', runId) });
      } catch (error) {
        llmLog.warn(`turn ${turnId} 口语转述失败（回退全文播报）：${error.message}`);
      }
    }
    llmLog.info(
      `turn ${turnId} ✓ 回应 ${result.text.length} 字（${bodyDeltaCount} 个增量分片，本轮 ${fmtMs(Date.now() - turnStartedAt)}）${speechText ? '，口语已转述' : ''}${result.toolNames?.length ? `，工具 ${result.toolNames.join(',')}` : ''}`,
    );
    return persistReply({ ...result, inputSource, finishReason: 'stop', ...(speechText ? { speechText } : {}) });
  } catch (error) {
    const cancelled = runToken.controller.signal.aborted || error?.name === 'AbortError';
    const failure = cancelled ? new Error('回合已取消。') : error;
    const message = failure instanceof Error ? failure.message : String(failure);
    if (cancelled || /回合已取消/.test(message)) {
      // 取消来源两样（用户停止／抢话替换），此处无 reason 可辨——不妄断「用户抢话」
      // （TC-057-012：旧措辞把停止收口误标抢话，身份链已证零业务重派）。
      llmLog.info(`turn ${turnId} ↩ 本回合已取消（停止或抢话让位，部分内容原位保留）`);
    } else {
      llmLog.error(`turn ${turnId} ✗ ${message}（本轮 ${fmtMs(Date.now() - turnStartedAt)}）`);
      if (!runToken.controller.signal.aborted && conversationTurns.current(runToken)) {
        persistConversationTurns(conversationId, [{
          id: `reply-error:${runToken.requestId}`, createdAt: Date.now(), author: 'hemi', kind: 'error', text: message,
        }]);
      }
    }
    conversationTurns.settle(runToken, { error: failure });
    throw failure;
  } finally {
    void runtime?.persist(conversationId).catch(() => {});
    // 上下文容量轮末收口（成功/取消/失败都到停靠点）：落档＋广播，指示器重取。
    try { recordContextUsage(conversationId); } catch { /* 收口失败不影响回合 */ }
  }
}

// ================================================================ IPC 注册

export function registerLlmIpc() {
  // 057 S2：调度权归流控制器（单注册表）；llm.ipc 挂真实 runtime 适配。
  flowService = getConversationFlowService();
  flowService.setRuntimeFactory(createLlmFlowRuntime);

  registerLlmProfilesIpc();

  ipcMain.handle(IPC.llm.getTurnState, (_event, id) => conversationTurns.getState(id));

  // 062：会话交付物的受控读取/打开与 Markdown 本地链接解析（渲染层不持路径；
  // linkPath 只是线索，主进程按会话工作区重新走同一套受控解析）。
  ipcMain.handle(IPC.delivery.readConversationDeliverable, (_event, payload) =>
    getConversationDeliverableIo().readConversationDeliverable(
      String(payload?.conversationId ?? ''),
      String(payload?.artifactId ?? ''),
      typeof payload?.linkPath === 'string' && payload.linkPath ? payload.linkPath : null,
    ));
  ipcMain.handle(IPC.delivery.openConversationDeliverable, (_event, payload) =>
    getConversationDeliverableIo().openConversationDeliverable(
      String(payload?.conversationId ?? ''),
      String(payload?.artifactId ?? ''),
      typeof payload?.linkPath === 'string' && payload.linkPath ? payload.linkPath : null,
      payload?.intent ?? 'preview-file',
      typeof payload?.applicationId === 'string' ? payload.applicationId : null,
    ));
  ipcMain.handle(IPC.delivery.listConversationDeliverableApplications, (_event, payload) =>
    getConversationDeliverableIo().listConversationDeliverableApplications(
      String(payload?.conversationId ?? ''), String(payload?.artifactId ?? ''),
      typeof payload?.linkPath === 'string' && payload.linkPath ? payload.linkPath : null,
    ));
  ipcMain.handle(IPC.delivery.resolveConversationLink, (_event, payload) =>
    getConversationDeliverableIo().resolveConversationLink(
      String(payload?.conversationId ?? ''),
      String(payload?.href ?? ''),
    ));

  // 057 S3-2d：元数据轻保存（只动 profile/workspace；旧通路的空 turns 会把
  // 档案 turns 清成整表空——saveConversation 的 turns 是权威语义）。
  ipcMain.handle(IPC.flow.saveMetadata, (_event, payload) => {
    const conversationId = String(payload?.conversationId ?? '');
    if (!conversationId) return { ok: false, code: 'invalid' };
    return ensureConversationArchive({
      id: conversationId,
      ...(payload?.profileId !== undefined ? { profileId: payload.profileId } : {}),
      ...(payload?.workspaceId !== undefined ? { workspaceId: payload.workspaceId } : {}),
    });
  });

  // 057 S3-2d：编辑回卷走宿主（退役渲染层 saveConversation(removedTurnKeys)）——
  // 档案剪除（cutKeys 并键＋主 agent 作废）＋flow 时间线裁剪（目标用户项及其后）。
  ipcMain.handle(IPC.flow.rewind, async (_event, payload) => {
    const conversationId = String(payload?.conversationId ?? '');
    const targetInputId = String(payload?.targetInputId ?? '');
    const keys = Array.isArray(payload?.removedTurnKeys) ? payload.removedTurnKeys.map(String) : [];
    if (!conversationId || !targetInputId) return { ok: false, code: 'invalid' };
    const controller = flowService.controllerFor(conversationId);
    const cut = applyConversationCut(conversationId, keys, { targetInputId });
    if (!cut?.ok) return { ok: false, code: 'storage-failed', message: cut?.storageError ?? '剪除失败' };
    controller.applyFact({ type: 'generation-bumped', cutAfterInputId: targetInputId });
    try {
      await flowService.store.saveFlow(conversationId, controller.getSnapshot());
    } catch (error) {
      return { ok: false, code: 'storage-failed', message: `回卷状态暂未保存：${error.message}` };
    }
    return { ok: true, cutKeysGrew: Boolean(cut.cutKeysGrew) };
  });

  // 029/057：队列面翻译层——控制器命令的旧渲染契约兼容（S2 UI 批次切 flow 订阅后退役）。
  ipcMain.handle(IPC.queue.enqueue, async (_event, payload) => {
    const conversationId = String(payload?.conversationId ?? '');
    const text = String(payload?.text ?? '').trim();
    if (!conversationId) return { ok: false, code: 'no-conversation', message: '排队需要先确定会话身份' };
    if (!text) return { ok: false, code: 'empty', message: '没有要排队的正文' };
    if (text.length > TEXT_LIMIT) return { ok: false, code: 'too-long', message: '这条消息太长了' };
    const result = await flowService.controllerFor(conversationId).command({
      type: 'send',
      input: {
        text,
        inputSource: payload?.inputSource === 'voice' ? 'voice' : 'text',
        attachmentIds: Array.isArray(payload?.attachmentIds) ? payload.attachmentIds : [],
        attachmentViews: sanitizeAttachmentViews(payload?.attachmentViews),
        references: sanitizeReferenceSelections(payload?.references),
        skills: sanitizeSkillSelections(payload?.skills),
      },
    });
    if (!result.ok) return { ok: false, code: result.code, message: mapCommandError(result, '排队失败') };
    const snapshot = flowService.controllerFor(conversationId).getSnapshot();
    const item = snapshot.pending.find((entry) => entry.inputId === result.inputId);
    return {
      ok: true,
      item: item ? {
        queueItemId: item.inputId, conversationId, text: item.text,
        revision: (item.editRevision ?? 0) + 1, dispatchState: item.state === 'submitting' ? 'sending' : 'pending',
        error: item.state === 'needs-review' ? '投递结果不明，待核对' : '',
        attachmentIds: item.attachmentIds ?? [], references: item.references ?? [],
        inputSource: item.inputSource ?? 'text', createdAt: item.createdAt ?? 0,
      } : null,
    };
  });

  ipcMain.handle(IPC.queue.list, (_event, payload) => {
    const conversationId = String(payload?.conversationId ?? '');
    if (!conversationId || !flowService.has(conversationId)) return { paused: false, items: [] };
    const snapshot = flowService.controllerFor(conversationId).getSnapshot();
    return {
      paused: snapshot.queuePaused,
      items: snapshot.pending.map((input) => ({
        queueItemId: input.inputId, conversationId, text: input.text,
        revision: (input.editRevision ?? 0) + 1,
        dispatchState: input.state === 'submitting' ? 'sending' : 'pending',
        error: input.state === 'needs-review' ? '投递结果不明，待核对' : '',
        attachmentIds: input.attachmentIds ?? [], references: input.references ?? [],
        inputSource: input.inputSource ?? 'text', createdAt: input.createdAt ?? 0,
      })),
    };
  });

  ipcMain.handle(IPC.queue.update, async (_event, payload) => {
    const conversationId = String(payload?.conversationId ?? '');
    const text = String(payload?.text ?? '').trim();
    if (!text) return { ok: false, code: 'empty', message: '内容不能为空' };
    const result = await flowService.controllerFor(conversationId).command({
      type: 'updateInput', inputId: payload?.queueItemId, patch: { text },
    });
    if (!result.ok) return { ok: result.code === 'stale-input' ? 'locked' : result.code, message: mapCommandError(result, '编辑失败') };
    const snapshot = flowService.controllerFor(conversationId).getSnapshot();
    const item = snapshot.pending.find((entry) => entry.inputId === payload?.queueItemId);
    return {
      ok: true,
      item: item ? {
        queueItemId: item.inputId, conversationId: String(payload?.conversationId ?? ''), text: item.text,
        revision: (item.editRevision ?? 0) + 1, dispatchState: item.state === 'submitting' ? 'sending' : 'pending',
        error: item.state === 'needs-review' ? '投递结果不明，待核对' : '',
        attachmentIds: item.attachmentIds ?? [], references: item.references ?? [],
        inputSource: item.inputSource ?? 'text', createdAt: item.createdAt ?? 0,
      } : null,
    };
  });

  // 060 R-21：显式插队——「让这条优先」。保存优先关系后才停止旧目标；旧目标停止
  // 确认后由控制器优先派发该条目（A 原位保留已停止记录、不自动续跑、不重新入队）。
  ipcMain.handle(IPC.queue.promote, async (_event, payload) => {
    const conversationId = String(payload?.conversationId ?? '');
    const queueItemId = String(payload?.queueItemId ?? '');
    if (!conversationId || !queueItemId) return { ok: false, message: '缺少会话或待发送条目' };
    const controller = flowService.controllerFor(conversationId);
    const result = await controller.command({ type: 'promoteInput', inputId: queueItemId });
    if (!result.ok) return { ok: false, message: mapCommandError(result, '优先处理失败') };
    return { ok: true, disposition: result.disposition, inputId: queueItemId };
  });

  ipcMain.handle(IPC.queue.withdraw, async (_event, payload) => {
    // 060 S1：撤回排队条目的同时清掉留存的派发 payload（受理即回执后由 we 保管）。
    pendingChatPayloads.delete(payload?.queueItemId);
    const result = await flowService.controllerFor(String(payload?.conversationId ?? '')).command({
      type: 'withdrawInput', inputId: payload?.queueItemId,
    });
    return result.ok ? { ok: true } : { ok: false, code: result.code === 'locked' ? 'locked' : 'unknown', message: mapCommandError(result, '撤回失败') };
  });

  ipcMain.handle(IPC.queue.resume, async (_event, payload) => {
    const resumeConversationId = String(payload?.conversationId ?? '');
    // 留痕：「点了继续没反应」类反馈需要能从日志分辨命令是否到达主进程（2026-10-18）。
    llmLog.info(`[queue] resume ${resumeConversationId || '（缺会话身份）'}`);
    await flowService.controllerFor(resumeConversationId).command({ type: 'resumeQueue' });
  });

  const submitChat = async (payload, { waitForResult = false } = {}) => {
    const conversationId = typeof payload?.conversationId === 'string' && payload.conversationId ? payload.conversationId : null;
    if (!conversationId) throw new Error('缺少会话身份。');
    const archived = ensureConversationArchive({ id: conversationId, profileId: payload?.profileId, workspaceId: payload?.workspaceId });
    if (!archived.ok) throw new Error(archived.storageError ?? '会话未能保存，消息未受理');
    const rawMessages = Array.isArray(payload?.messages) ? payload.messages : [];
    const lastUser = [...rawMessages].reverse().find((m) => m?.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content.trim() : '';
    if (!text && !payload?.attachmentIds?.length) throw new Error('本轮没有用户消息。');
    const requestKey = typeof payload?.requestId === 'string' && payload.requestId ? `${conversationId}:${payload.requestId}` : null;
    const inputId = typeof payload?.inputId==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(payload.inputId)?payload.inputId:`in-${requestKey ? createHash('sha256').update(requestKey).digest('hex').slice(0, 24) : randomUUID()}`;
    let modelPolicySnapshot, workspaceSnapshot;
    try {
      const accepted = flowService.controllerFor(conversationId).getSnapshot();
      const pending = accepted.pending.find(item => item.inputId === inputId);
      const known = pending || Object.values(accepted.runs).some(run => run.inputIds.includes(inputId));
      if (pending?.modelPolicySnapshot) { modelPolicySnapshot = pending.modelPolicySnapshot; workspaceSnapshot = pending.workspaceSnapshot; }
      else if (!known) ({ modelPolicySnapshot, workspaceSnapshot } = await freezeAcceptedInput({ store: getProfiles(), workspaceService: getWorkspaceService(), input: payload }));
    } catch (error) {
      if (waitForResult) throw error;
      return { ok: false, code: 'unavailable', message: error.message };
    }
    if (!pendingChatPayloads.has(inputId)) pendingChatPayloads.set(inputId, { ...payload, modelPolicySnapshot, workspaceSnapshot });
    let keepPayload = false;
    try {
      if(payload?.expectedGeneration!=null&&payload.expectedGeneration!==flowService.controllerFor(conversationId).getSnapshot().generation)return {ok:false,code:'conflict',message:'会话已被编辑，请核对后重新提交。'};
      const send = await flowService.controllerFor(conversationId).command({
        type: 'send',
        input: {
          inputId,
          text,
          modelPolicySnapshot,
          workspaceSnapshot,
          inputSource: payload?.inputSource === 'text' ? 'text' : 'voice',
          attachmentIds: Array.isArray(payload?.attachmentIds) ? payload.attachmentIds : [],
          attachmentViews: sanitizeAttachmentViews(payload?.attachmentViews),
          references: sanitizeReferenceSelections(payload?.references),
          skills: sanitizeSkillSelections(payload?.skills),
          // 060 S1：资料随同一 inputId 贯穿（派发时还原 payload；null=显式缺省组）。
          ...(payload?.profileId === undefined ? {} : { profileId: typeof payload.profileId === 'string' && payload.profileId ? payload.profileId : null }),
          ...(payload?.workspaceId === undefined ? {} : { workspaceId: typeof payload.workspaceId === 'string' && payload.workspaceId ? payload.workspaceId : null }),
        },
        // 普通文字／按住说话默认排队；连续通话在句末停顿后即时接管。
        preempt: payload?.inputSource === 'voice' && payload?.voiceMode === 'continuous' ? 'active' : 'none',
      });
      if (!send.ok) {
        const message = mapCommandError(send, '本轮没有受理，请重试。');
        // 产品发送使用显式失败回执；异常跨 IPC 后会带 Electron 的技术前缀。
        if (!waitForResult) return { ok: false, code: send.code ?? 'rejected', message };
        throw new Error(message);
      }
      if (send.disposition === 'queued' || (send.disposition === 'already-accepted' && flowService.controllerFor(conversationId).getSnapshot().pending.some((input) => input.inputId === inputId))) {
        keepPayload = true;
        return { ok: true, queued: true, disposition: 'queued', inputId };
      }
      if (send.disposition === 'preempting') {
        keepPayload = true;
        if (!waitForResult) return { ok: true, disposition: 'preempting', inputId, runId: send.runId ?? null };
        const result = await inputResults.wait(inputId);
        if (result?.error) throw result.error;
        if (result?.aborted) throw new Error('回合已取消。');
        return result;
      }
      if (send.disposition === 'started' || send.disposition === 'already-accepted') {
        if (!waitForResult) return { ok: true, disposition: 'started', inputId, runId: send.runId ?? null };
        const snapshot = flowService.controllerFor(conversationId).getSnapshot();
        if (send.disposition === 'already-accepted' && !inputResults.has(inputId) && !snapshot.runs[snapshot.activeRunId]?.inputIds.includes(inputId)) {
          throw new Error('这条输入已受理并归档，请查看会话记录；不会重复执行。');
        }
        const result = await inputResults.wait(inputId);
        if (result?.error) throw result.error;
        if (result?.aborted) throw new Error('回合已取消。');
        return result;
      }
      if (send.disposition === 'stop-requested') throw new Error('回合已取消。');
      throw new Error(`回合未受理（${send.disposition}）`);
    } finally {
      if (!keepPayload) pendingChatPayloads.delete(inputId);
    }
  };
  flowService.submitChat=payload=>submitChat(payload);
  ipcMain.handle(IPC.llm.submit, async (_event, payload) => {
    try { return await submitChat(payload); }
    catch (error) {
      llmLog.warn(`输入未受理：${error?.message ?? error}`);
      return { ok: false, code: 'submit-failed', message: error?.message || '本轮没有受理，请重试。' };
    }
  });
  ipcMain.handle(IPC.llm.chat, (_event, payload) => submitChat(payload, { waitForResult: true }));

  // 停止回应/抢话替换：经控制器（真停暂停队列、preempt 不暂停），cancel 按 turnId
  // 定向（旧按钮不能停新回合，R-09）；执行层的令牌作废与 agent abort 由 runtime.stop 承担。
  ipcMain.on(IPC.llm.cancel, (_event, payload) => {
    const target = typeof payload === 'object' && payload ? payload : { turnId: Number(payload), conversationId: null };
    const conversationId = typeof target.conversationId === 'string' ? target.conversationId : null;
    if (!conversationId || !flowService.has(conversationId)) return;
    const controller = flowService.controllerFor(conversationId);
    const snapshot = controller.getSnapshot();
    const activeRunId = snapshot.activeRunId;
    if (!activeRunId) return;
    const boundTurnId = turnIdByRun.get(conversationId)?.get(activeRunId) ?? null;
    if (target.turnId != null && Number.isFinite(Number(target.turnId)) && boundTurnId != null && Number(target.turnId) !== boundTurnId) {
      return; // 旧回合的停止请求：不作用于当前运行
    }
    void controller.command({
      type: 'stop',
      reason: target.reason === 'preempt' ? 'preempt' : 'stop',
      targetRunId: activeRunId,
    }).catch(() => {});
  });
}

/** 工具参数摘要（对话流展示用，有界、不带大段正文）。 */
function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(args).slice(0, 6)) {
    if (typeof value === 'string') out[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/** before-quit 收尾：中断所有会话请求，收走主 agent 与子 agent（条目随档）、控制器排空保存链。 */
export async function abortActiveTextModelTurn() {
  conversationTurns.abortAll();
  await runtime?.close();
  await flowService?.dropAll?.().catch(() => {});
}
