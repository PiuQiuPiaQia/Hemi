import { textFactOf } from '../../shared/message-phase.mjs';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createAgentRuntime } from '../agent-runtime/core.mjs';
import { goalRunOutcome } from '../agent-runtime/goal-driver.mjs';
import {runBackgroundTurn} from '../agent-runtime/background-turn.mjs';
import { isNativeSessionReference } from '../agent-runtime/session-reference.mjs';
import { resolveModelPlan, hydrateModelPlan } from '../agent-runtime/model-policy.mjs';
import { createHemiSession } from '../agent/hemi-session.mjs';
import { createRunPartProjector } from '../services/flow-parts-projection.mjs';
import { createTaskFactPublisher } from '../services/task-fact-publisher.mjs';
import { createPermissionService } from '../services/permission-service.mjs';
import {commandDeadline} from '../agent/gate/command-deadline.mjs';

const TOOLS = ['context_read', 'task_read', 'conversation_read', 'get_runtime_diagnostics', 'read', 'write', 'edit', 'ls', 'grep', 'glob', 'bash', 'register_delivery',
  'browser_navigate', 'browser_extract', 'browser_tabs', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_act', 'web_search', 'web_extract',
  'screen_view', 'ui_list', 'ui_click', 'ui_type', 'ui_key', 'ui_scroll', 'ui_tree', 'ui_act', 'app_open'];
const CLOUD_SYSTEM = `你是 Hemi，运行在用户的 ${process.platform === 'win32' ? 'Windows' : 'Linux'} 远端主机上。所有文件、命令和浏览器操作都在这台主机执行，浏览器登录状态也属于这台主机。${process.platform === 'win32' ? 'bash 工具在此执行 Windows cmd.exe 命令，不是 POSIX bash；需要 PowerShell 时显式调用 powershell.exe -NoProfile -NonInteractive -Command。路径使用 Windows 绝对路径。桌面工具操作这台 Windows 主机已登录用户的桌面；会话锁定、注销或桌面助手不可用时如实报告，不能改为控制客户端电脑。Windows 快捷键使用 ctrl/alt/win，不使用 macOS 的 cmd。Windows 组合快捷键及包含 Emoji 等非 BMP 字符的键入使用 delivery="foreground"，让驱动短暂置前目标窗口后投递并恢复；用户明确要求全程后台时遵守该限制，改用可用的 UIA 语义操作或如实报告。动作结果须通过界面或目标应用的实际内容核对，不反复重放已生效的输入。' : '本主机不提供图形桌面控制。'}用用户的语言完成已授权的工作。没有麦克风、录音或语音能力；不能宣称已操作客户端电脑。敏感操作遵守宿主确认，不绕过门控。生成交付文件时使用 register_delivery 登记真实路径。`;

export async function validateCloudModel(config, {signal: externalSignal} = {}) {
  externalSignal?.throwIfAborted();
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'hemi-bot-validation-'),
  );
  const access = createPermissionService({dir: path.join(temporary, 'access-store')});
  let session;
  let timer;
  let abortListener;
  let transportError;
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  try {
    // Validation may finish before the default session's asynchronous store load.
    // Own and await initialization so cleanup cannot race its pending writes.
    await access.load();
    session = createHemiSession({
      cwd: temporary,
      agentDir: temporary,
      accessService: access,
      model: config,
      tools: [],
      appendSystem: ['你是 Hemi。仅验证模型连接，回复 OK。'],
      features: {},
      // A connection check is one attempt. SDK retries otherwise start another
      // turn, hit maxRunRequests and replace the original error with an abort.
      settings: {retry: {enabled: false, provider: {maxRetries: 0}}},
      fetchImpl: async (url, init = {}) => {
        let response;
        try {
          response = await fetch(url, {...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal});
        } catch (error) { transportError = error; throw error; }
        // Native transports can flatten HTTP status/code into generic text.
        // Keep this cause inside the Host; oauth-errors emits only fixed text.
        transportError = response.ok ? null : {status: response.status, message: (await response.clone().text().catch(() => '')).slice(0, 32768)};
        return response;
      },
      maxRunRequests: 1,
      initTimeoutMs: 20000,
      stallTimeoutMs: 30000,
    });
    const result = await Promise.race([
      (async () => {
        await session.ready();
        return session.prompt('Reply OK.');
      })(),
      new Promise((_, reject) => {
        abortListener = () => reject(signal.reason);
        signal.addEventListener('abort', abortListener, {once: true});
        if (signal.aborted) abortListener();
        timer = setTimeout(() => controller.abort(new Error('模型验证超时')), 45000);
        timer.unref?.();
      }),
    ]);
    if (result.modelError || result.aborted || !result.texts.length)
      throw new Error('模型验证失败', {cause:transportError || result.modelError || {aborted:result.aborted,textCount:result.texts.length}});
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abortListener);
    controller.abort();
    session?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Cloud host bindings only. Desktop and Bot share the same execution runtime. */
export function createBotExecutor({dataDir, readEntries, readConversation, saveEntries, onPermission, onDelivery, recordUsage, getModel, attachmentPrompt, flowService, capabilities, desktop = null, goalPolicy, backgroundQuietReviewMs = 60000}) {
  const active = new Map(), generations = new Map(), cancelledBeforeStart = new Set();
  const access = createPermissionService({dir: dataDir}), ready = access.load();
  const taskFacts = flowService ? createTaskFactPublisher({flowService}) : null;
  const profilesFor = ctx => ({
    async list() { return {roleModels: {}, defaultModelId: ctx?.policySnapshot?.fixedKey}; },
    async resolveStrict(key) {
      const revision = ctx?.policySnapshot?.revisions?.[key];
      if (!revision) return {ok: false, message: '任务缺少受理时的模型版本。'};
      return {ok: true, config: getModel(key, revision)};
    },
  });
  const deliver = (owner, files) => {
    const pending = Promise.resolve(onDelivery(owner.spec, files));
    void pending.catch(() => {});owner.deliveries.push(pending);
  };
  const runtime = createAgentRuntime({
    userDataDir: dataDir, getProfiles: profilesFor, nativeMemory: true, goalPolicy, onGoalVerification:(id,call)=>recordUsage?.(id,call),
    resolveCapabilities: () => capabilities.resolve(),
    createBrowserClient: options => capabilities.createBrowserClient(options),
    getSkillService: () => capabilities.skills,
    loadArchiveSession: readConversation,
    getAccessService: () => access,
    sessionOptions: {backgroundQuietReviewMs,desktopClient: desktop, tools: [...TOOLS, 'task', 'task_status', 'task_message', 'task_cancel', 'memory_write', 'memory_read', 'memory_forget', 'memory_restore', 'scratchpad'], permissionTimeoutMs: 0, controlRoots: [dataDir, path.join(os.homedir(), '.local/share/hemi-bot'), path.join(os.homedir(), '.config/systemd/user/hemi-bot.service'), path.resolve(import.meta.dirname, '../../..')]},
    appendSystem: [CLOUD_SYSTEM], permissionTimeoutMs: 0,
    loadArchiveAgent(id) {
      const owner = active.get(id);if (!owner) return null;
      const entries = readEntries(id, owner.spec.generation, owner.spec.envelope?.inputId);
      if (isNativeSessionReference(entries)) return entries;
      return entries?.length ? {header: entries[0], entries: entries.slice(1)} : null;
    },
    loadArchiveTurns: () => [],
    saveArchiveAgent(id, payload) {
      const generation = generations.get(id);return generation === undefined ? false : saveEntries(id, generation, payload);
    },
    onPermissionRequest({conversationId, request, decide}) {
      const owner = active.get(conversationId);if (!owner || owner.ctx.cancelled) return;
      owner.permissions.set(request.id, {request, decide});
      let card = {};try {card = JSON.parse(request.title);} catch {}
      onPermission(owner.spec, {...request, title: typeof card.summary === 'string' ? card.summary : request.title,
        kind: card.kind === 'grant' ? 'grant' : 'action', tool: card.tool ?? '', args: card.args ?? {}, note: card.note ?? ''});
    },
    onTaskState: snapshot => taskFacts?.publish(snapshot),
    onBackgroundReady:(id,event)=>flowService?.controllerFor(id).enqueueBackground(event),
    onBackgroundJobs:(id,view)=>{if(flowService?.has(id))flowService.controllerFor(id).applyFact({type:'background-jobs',...view});},
    onDeliveryDeclared({conversationId, rootRunId, file}) {
      const owner = active.get(conversationId);
      if (owner && owner.spec.runId === rootRunId && !owner.ctx.cancelled) deliver(owner, [file]);
    },
    onSession({conversationId, role, session, modelPlan}) {
      session.on('model-call', call => {
        const owner = active.get(conversationId);if (!owner) return;
        const candidates = [modelPlan.primary, ...modelPlan.allowedFallbacks];
        const config = candidates.find(candidate => candidate.modelKey === call.modelKey) ?? modelPlan.primary;
        recordUsage(conversationId, {...call, role, modelKey: config.modelKey, modelName: config.model, providerName: config.name ?? '', at: Date.now()});
      });
    },
  });
  return {
    async run(spec, apply) {
      await ready;
      const {conversationId, generation, runId, envelope, continuationOf} = spec;
      if (cancelledBeforeStart.delete(conversationId)) return {stopped: true};
      if(spec.background){
        const ctx=runtime.backgroundContext(conversationId,spec.background.rootRunId);
        if(!ctx)return {stopped:true};
        const owner={spec,ctx,stopped:false,permissions:new Map(),deliveries:[],settled:Promise.withResolvers()};
        active.set(conversationId,owner);
        try{
          const result=await runBackgroundTurn({runtime,conversationId,runId,generation,background:spec.background,apply,onDelivery:files=>deliver(owner,files)});
          await Promise.all(owner.deliveries);
          return {stopped:result.aborted,waitingForBackground:result.waitingForBackground,waitingForUser:result.waitingForUser,blocked:result.blocked,halted:result.halted};
        }finally{if(active.get(conversationId)===owner)active.delete(conversationId);owner.settled.resolve();}
      }
      if (generations.has(conversationId) && generations.get(conversationId) !== generation) runtime.invalidate(conversationId);
      generations.set(conversationId, generation);
      const ctx = {conversationId, generation, runId, continuationOf, policySnapshot: envelope.modelPolicySnapshot, workspace: envelope.workspaceSnapshot, inputSource: 'text', cancelled: false,
        runtimeDiagnostics: () => ({ok: true, host: 'Bot', platform: process.platform, capabilities: capabilities.view()})};
      const owner = {spec, ctx, stopped: false, permissions: new Map(), deliveries: [], settled: Promise.withResolvers()};active.set(conversationId, owner);
      const projector = createRunPartProjector({runId, generation, inputId: envelope.inputId});
      const fact = event => {for (const value of projector.handle(event)) apply(value);};
      let session, outcome = 'failed', cleanupUnconfirmed = false;
      const onStream = event => {
        const text = textFactOf(event);
        if (text) fact(text);
        else if (event.type === 'thinking_delta') fact({kind: 'thinking', text: event.delta});
        else if (event.type === 'thinking_end') fact({kind: 'thinking_end'});
        else if (event.type === 'hemi_message_end') fact({kind: 'message-end'});
        else if (event.type === 'hemi_request_start') fact({kind: 'request-start'});
        else if (event.type === 'hemi_request_reset') fact({kind: 'request-reset'});
      };
      const onActivity = activity => fact({kind: 'activity', activity});
      const onRecovery = recovery => fact({kind: 'recovery', recovery});
      const onProgress = event => {
        fact({...event, kind: event.kind === 'tool-start' ? 'tool_start' : 'tool_end'});
        if (event.kind === 'tool-end' && event.tool === 'register_delivery' && !event.isError) deliver(owner, event.args?.files ?? []);
      };
      try {
        const modelPlan = await hydrateModelPlan(resolveModelPlan(ctx.policySnapshot, {requirements: envelope.attachmentViews?.some(file => file.kind === 'image') ? {imageInput: true} : {}}), profilesFor(ctx));
        Object.assign(ctx, {modelPlan, config: modelPlan.primary, fallback: modelPlan.allowedFallbacks[0] ?? null, routed: ctx.policySnapshot.mode === 'routed'});
        await runtime.prepareExecution(ctx);
        if (ctx.cancelled) return {stopped: true};
        session = await runtime.obtain(ctx);
        if (ctx.cancelled) return {stopped: true};
        session.on('stream', onStream);session.on('activity', onActivity);session.on('recovery', onRecovery);session.on('progress', onProgress);
        apply({type: 'run-started', runId, generation, at: Date.now(), modelUsed: modelPlan.primary.modelKey});
        const input = await attachmentPrompt({...envelope, conversationId}, modelPlan.primary);
        if (ctx.cancelled) return {stopped: true};
        const result = await runtime.runRootTurn(conversationId, {userText: input.text, inputId: envelope.inputId, imageBlocks: input.images ?? []});
        await Promise.all(owner.deliveries);await runtime.persist(conversationId);
        outcome = goalRunOutcome(result, {cancelled: ctx.cancelled});
        for (const value of projector.finish({stopped: result.aborted || ctx.cancelled, halted:result.halted,blocked:outcome==='blocked'?result.blocked:null})) apply(value);
        return {stopped: result.aborted || ctx.cancelled,waitingForBackground:result.waitingForBackground,waitingForUser:result.waitingForUser,halted:result.halted,blocked:outcome==='blocked'?result.blocked:null};
      } catch (error) {
        cleanupUnconfirmed = error.code === 'cleanup-unconfirmed';
        for (const value of projector.finish({error: owner.stopped ? null : error, stopped: owner.stopped})) apply(value);
        error.flowReported = true;
        if (!owner.stopped || cleanupUnconfirmed) throw error;
        return {stopped: true};
      } finally {
        session?.off('stream', onStream);session?.off('activity', onActivity);session?.off('recovery', onRecovery);session?.off('progress', onProgress);
        try {
          const completion=runtime.completeConversation(conversationId,cleanupUnconfirmed?'failed':owner.stopped?'stopped':outcome,null,runId);
          if(cleanupUnconfirmed)await commandDeadline(completion,10000,'异常命令终态保存未确认，请核对后重启运行时');else await completion;
        }
        finally {if (active.get(conversationId) === owner) active.delete(conversationId);owner.settled.resolve();}
      }
    },
    backgroundCommand: (id,request) => runtime.backgroundCommand(id,request),
    async cancelWaitingUser(id,runId) {await runtime.completeConversation(id,'stopped','用户停止等待答复',runId);},
    async stop(id) {
      const owner = active.get(id);
      if (!owner) {cancelledBeforeStart.add(id);return;}
      owner.stopped = true;owner.ctx.cancelled = true;
      await runtime.stopRoot(id, owner.spec.runId, {inputs: owner.spec.envelope ? [owner.spec.envelope.text] : []});
    },
    decide(id, permissionId, value) {
      const owner = active.get(id), pending = owner?.permissions.get(permissionId);
      if (!pending || !pending.request.options.includes(value)) return false;
      const result = pending.decide(value);if (result) owner.permissions.delete(permissionId);return result;
    },
    async close() {
      try {
        await ready;
        const running = [...active.values()];
        const stops = await commandDeadline(Promise.allSettled(running.map(owner => this.stop(owner.spec.conversationId))),20000,'Bot 命令停止未能确认');
        await commandDeadline(Promise.all(running.map(owner => owner.settled.promise)),20000,'Bot 运行退出未能确认');
        const failure=stops.find(result=>result.status==='rejected');
        if(failure)throw failure.reason;
      } finally {taskFacts?.dispose();await runtime.close();}
    },
  };
}
