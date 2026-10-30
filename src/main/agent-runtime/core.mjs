import { sessionModelOptions } from '../agent/session-model-options.mjs';
import { usageRecordsFromJournal } from './usage-ledger.mjs';
import { projectUsageHistory } from './usage-history.mjs';
import { currentExecutionScope } from './execution-scope.mjs';
import { recoverOwnedProcesses } from './owned-processes.mjs';
import os from 'node:os';
import path from 'node:path';
import {commandDeadline} from '../agent/gate/command-deadline.mjs';
import { mkdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRunJournal, dispatchIdentity } from '../agent-runtime/run-journal.mjs';
import { formatSubagentResult } from '../agent/agent-tools.mjs';
import { createContextStore } from './context-store.mjs';
import { createConversationHistoryReader } from './conversation-history.mjs';
import {driveGoal, goalPolicy as normalizeGoalPolicy, goalEvidence, verifyGoalCompletion} from './goal-driver.mjs';
import { budgetSummaryFacts } from './budget-summary.mjs';
import { sessionCompatibility } from './model-policy.mjs';
import { sessionLoadoutRevision, roleSessionRevision } from './session-revision.mjs';
import { createSessionStore } from './session-store.mjs';
import { isNativeSessionReference, nativeSessionReference } from './session-reference.mjs';

import { createMainAgent, buildAgentAppendSystem, entriesFromTurns } from '../agent/main-agent.mjs';
import { createHemiSession, backgroundCommandEvent } from '../agent/hemi-session.mjs';
import { createSubagentManager } from '../agent/subagents.mjs';
import { loadRoles, buildRoutingSection, ROLE_NAMES } from '../agent/agent-roles.mjs';
import { discoverProjectSkills } from '../skills/project-skills.mjs';
import { resolveRoleModel } from '../lib/role-models.mjs';
import { describeModelError } from '../lib/model-routing.mjs';
import { freezeModelPolicy, resolveModelPlan, hydrateModelPlan } from '../agent-runtime/model-policy.mjs';
import { acquireAgentEnvironment } from './process-environment.mjs';
import { buildWorkspaceContextBlock } from '../workspace/context.mjs';
import { hydrateWorkflowModel } from '../workflows/workflow-model-plan.mjs';
import { createWorkflowNodeAgent } from '../agent/workflow-node-agent.mjs';

/**
 * 056 · 主 agent 与子 agent 的运行时装配（取代 055 的 brain-registry 与 task.ipc 的执行器工厂）。
 *
 * 职责：
 *   - 每对话一个主 agent（LRU 驻留，Pi 原生保存条目，Hemi 档案仅存 agentSession 引用）；
 *     模型/工作区/系统段变化时导出条目换新实例（缓存随 system 变化自然失效）；
 *   - 子 agent 管理器单例（四个角色），会话工厂按角色定义裁工具面与模型；
 *   - 后台子 agent 终态 → 主 agent 隐藏消息唤醒（空闲 triggerTurn、忙时 followUp）；
 *   - 主 agent 的确认请求接入子 agent 管理器的同一确认环（task:state 快照）；
 *   - 固定／路由均可执行；角色只定义工具面，模型来自受理时冻结策略。
 *     （fixer 不可用时退回按需模式并留痕，不出现「编排者无人可派」）。
 */

const MAX_RESIDENT = 8;
const safeDirName = (id) => String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown';
/** 056：对话级授权范围（授权卡「本任务允许」落这里，主 agent 与子 agent 共用）。 */
const conversationGrantScope = (conversationId) => `conv-${safeDirName(conversationId)}`;

export async function resolveWorkspacePlacement(workspace, { log } = {}) {
  const realHome = await realpath(os.homedir()).catch(() => os.homedir());
  if (workspace?.host) throw new Error('远程工作区需要宿主提供执行位置适配');
  const dir = workspace?.dir && path.isAbsolute(workspace.dir)
    ? await realpath(workspace.dir).catch(() => workspace.dir)
    : null;
  const usable = dir && dir !== realHome && dir !== path.parse(dir).root;
  return {
    cwd: dir ?? realHome,
    accessWorkspaceDir: usable ? dir : null,
    loadContextFiles: Boolean(usable),
    remote: null,
  };
}


/** 主 agent／子 agent 共用的 Skill 清单：Hemi 技能库（受控快照）＋项目 Skill（本机工作区）。 */
export function collectSkills({ skillService, workspace }) {
  let lease = null;
  try {
    lease = skillService?.snapshot?.(null) ?? null;
  } catch {
    lease = null;
  }
  const library = (lease?.items ?? []).map((item) => ({ id: item.id, name: item.name, path: item.path, source: 'library', description: item.description ?? '' }));
  const project = workspace?.host ? [] : discoverProjectSkills(workspace?.dir ?? null);
  const names = new Set(library.map((item) => item.name));
  const merged = [...library, ...project.filter((item) => !names.has(item.name))];
  return { items: merged, release: () => lease?.release?.() };
}

/**
 * 模型计划：手选物理模型或带备用的路由快照（038 虚拟模型只承担故障切换）。
 * config＝主模型 ResolvedConfig；fallback＝备用（可空）。
 */

/**
 * @param {object} deps
 * @param {(cid) => object|null} deps.loadArchiveAgent  档案里的 {header, entries}
 * @param {(cid) => Array|null} deps.loadArchiveTurns  旧档案 turns
 * @param {(cid) => object|null} [deps.loadArchiveSession] 当前实例的公开会话档案
 * @param {(cid, payload) => boolean} deps.saveArchiveAgent
 * @param {(cid, result, meta) => void} deps.onEventTurn 事件唤醒回合的产出收口（llm.ipc）
 * @param {() => object} deps.getSkillService
 * @param {() => object} deps.getWorkspaceService
 * @param {object} deps.history 任务档案
 * @param {(task) => void} [deps.onModelUsage]
 * @param {(snapshot) => void} deps.onTaskState  子 agent 快照广播
 */
export function createAgentRuntime({
  userDataDir,
  getProfiles,
  resolveCapabilities,
  resolvePlacement = resolveWorkspacePlacement,
  getAccessService,
  createBrowserClient = () => null,
  sessionOptions = {},
  appendSystem: hostSystem = [],
  onSession = null,
  onPermissionRequest = null,
  permissionTimeoutMs,
  loadArchiveAgent,
  loadArchiveTurns,
  loadArchiveSession = null,
  saveArchiveAgent,
  onEventTurn,
  onBackgroundReady = null,
  getSkillService = () => null,
  nativeMemory = false,
  goalPolicy = {},
  onGoalVerification = null,
  getWorkspaceService = () => null,
  getWorkflowService = null,
  history,
  onModelUsage = null,
  isOnline = () => true,
  onTaskState,
  onDeliveryDeclared = null,
  log,
}) {
  if (!userDataDir || !getProfiles || !resolveCapabilities || !getAccessService) throw new Error('执行运行时缺少宿主依赖');
  const environment = nativeMemory ? acquireAgentEnvironment({ dataDir: userDataDir }) : null;
  const agentDir = path.join(userDataDir, 'pi-agent');
  try { mkdirSync(agentDir, { recursive: true }); } catch { /* inMemory 会话仍可跑 */ }
  const journal = createRunJournal({ dir: path.join(userDataDir, 'runtime-v2') });
  const sessionStore = createSessionStore({ dir: path.join(userDataDir, 'runtime-v2/sessions'), log });
  const contextStore = createContextStore({ dir: path.join(userDataDir, 'runtime-v2/contexts') });
  const conversationHistory = loadArchiveSession ? createConversationHistoryReader({ loadSession: loadArchiveSession, contextStore }) : null;
  const journalReady = journal.ready().then(() => recoverOwnedProcesses(journal, {log})).then(() => journal.recover());
  void journalReady.catch(error => log?.error?.(error.message));
  const dispatchInFlight = new Map();
  // Pending goals hold no foreground slot. Only a live, unconsumed result may wake one.
  const backgroundGoals = new Map(), retainedCommandSessions = new Map();
  let shuttingDown = false;
  async function wakeBackground(owner,{review=false}={}) {
    const pending=backgroundGoals.get(owner?.rootRunId);
    if(shuttingDown||!pending||pending.queued||pending.ctx.generation!==owner.generation)return;
    if(!review&&!commandSessions(owner.conversationId).some(session=>session.hasTreeCommandResults?.(owner)))return;
    const root=await journal.root(owner);
    if(shuttingDown||pending.queued||backgroundGoals.get(owner.rootRunId)!==pending||root?.status!=='waiting_background')return;
    if(!onBackgroundReady)return;
    pending.queued=true;pending.review=review;
    try { if(await onBackgroundReady(owner.conversationId,{rootRunId:owner.rootRunId,generation:owner.generation})===false)pending.queued=false; }
    catch(error){pending.queued=false;log?.warn?.(`后台结果通知失败：${error.message}`);}
  }
  function observeCommands(session) {
    session.on('command-settled',job=>{void (async()=>{
      if(job.status==='cancelled'){
        const pending=backgroundGoals.get(job.owner.rootRunId);
        if(pending&&!commandSessions(job.owner.conversationId).some(source=>source.hasTreeCommands?.(job.owner))){
          const jobs=Object.values((await journal.snapshot()).processes).filter(p=>p.background&&p.owner.rootRunId===job.owner.rootRunId&&p.owner.generation===job.owner.generation);
          if(jobs.every(p=>p.status==='cancelled')){
            backgroundGoals.delete(job.owner.rootRunId);
            await journal.finishRoot(job.owner,'cancelled','后台命令已停止');
            for(const source of commandSessions(job.owner.conversationId))source.releaseGoalCommands?.(job.owner);
          }else await wakeBackground(job.owner);
        }
      }else await wakeBackground(job.owner);
    })().catch(error=>log?.warn?.(`后台结果交接失败：${error.message}`));});
  }
  const ownerOf = ctx => ({ conversationId: ctx.conversationId, rootRunId: ctx.runId, generation: ctx.generation ?? 0 });
  const sessionRefOf = (ctx, execution) => execution.sessionRef ?? ctx.sessionRef ?? `main-${safeDirName(ctx.conversationId)}`;
  const sessionRecord = (ctx, execution) => {
    const publicCandidate = candidate => { const { apiKey, ...rest } = candidate; return rest; };
    return { owner: execution.owner, role: execution.plan.role, workspace: ctx.workspace,
      sessionRef: sessionRefOf(ctx, execution), worklineId: execution.worklineId ?? null, roleRevision: execution.roleRevision ?? null,
      runCount: execution.runCount ?? null, contextRefs: execution.allowedRefs ?? null,
      modelPlan: { ...execution.plan, primary: publicCandidate(execution.plan.primary), allowedFallbacks: execution.plan.allowedFallbacks.map(publicCandidate) } };
  };
  const executionFor = (ctx, plan, purpose = 'main') => ({ isOnline, journal, contextStore, store: getProfiles(ctx), owner: ownerOf(ctx), plan,
    ...(purpose==='main'?{commandControl:request=>backgroundCommand(ctx.conversationId,{...request,runId:ctx.runId})}:{}),
    validateConversationSource: source => conversationHistory?.validateSource(source) ?? false,
    budgets: ctx.policySnapshot.budgets, sessionRef: ctx.sessionRef, purpose, onRequestRecorded: () => onModelUsage?.({ conversationId: ctx.conversationId }), allowedRefs: null, cancelled: () => Boolean(ctx.cancelled),
    openSession: ({ cwd, entries, source, execution }) => sessionStore.open(sessionRefOf(ctx, execution), {
      cwd, entries, source, record: sessionRecord(ctx, execution), reset: purpose === 'main' && source === null,
    }),
    persistSession: async (checkpoint, execution) => {
      if (checkpoint.ref !== sessionRefOf(ctx, execution)) throw new Error('会话保存引用不匹配');
      await sessionStore.checkpoint(checkpoint, sessionRecord(ctx, execution));
      if (purpose === 'main' && agents.get(ctx.conversationId)?.ctx === ctx) await persist(ctx.conversationId);
    },
  });

  // 标题等无工具副作用的辅助作业，与业务目标分别收口，实际请求仍归属原目标的额度和费用。
  const auxiliaryJobs = new Map();
  async function auxiliaryCall({ config, conversationId, sourceRootRunId = null, purpose, ...options }) {
    await journalReady;
    const state = await journal.snapshot();
    const source = sourceRootRunId ? state.roots[sourceRootRunId] : Object.values(state.roots).filter(root => root.kind !== 'auxiliary' && root.owner.conversationId === conversationId).at(-1);
    const owner = { conversationId, rootRunId: `aux-${randomUUID()}`, generation: source?.owner.generation ?? 0 };
    const snapshot = await freezeModelPolicy({ store: getProfiles(), modelKey: config.modelKey, fixedConfig: config, budgets: source?.policySnapshot?.budgets });
    const plan = resolveModelPlan(snapshot);
    await journal.beginRoot(owner, { kind: 'auxiliary', purpose, sourceRootRunId: source?.owner.rootRunId ?? null });
    const controller = new AbortController();
    const relay = () => controller.abort(); options.signal?.addEventListener('abort', relay, { once: true });
    if (options.signal?.aborted) controller.abort();
    auxiliaryJobs.set(owner.rootRunId, { sourceRootRunId: source?.owner.rootRunId, controller });
    try {
      const { chatTurn } = await import('../services/text-model.mjs');
      const result = await chatTurn({ ...config, ...options, signal: controller.signal, maxPreStreamRetries: 0,
        runtimeExecution: { journal, store: getProfiles(), owner, plan, budgets: snapshot.budgets, purpose, onRequestRecorded: () => onModelUsage?.({conversationId}), cancelled: () => controller.signal.aborted } });
      await journal.finishRoot(owner, 'completed'); return result;
    } catch (error) { await journal.finishRoot(owner, controller.signal.aborted ? 'cancelled' : 'failed', error.message); throw error; }
    finally { options.signal?.removeEventListener('abort', relay); auxiliaryJobs.delete(owner.rootRunId); }
  }

  async function auxiliarySession({ plan, conversationId = '__workflow-preparation__', purpose, prompt, signal }) {
    await journalReady;
    const ctx = { conversationId, runId: `aux-${randomUUID()}`, sessionRef: `session-${randomUUID()}`, policySnapshot: plan.policySnapshot, modelPlan: plan.modelPlan, workspace: null, cancelled: false };
    await journal.beginRoot(ownerOf(ctx), { kind: 'auxiliary', purpose });
    const session = createHemiSession({ cwd: userDataDir, agentDir, ...sessionModelOptions({config:plan.config,fallbacks:plan.modelPlan.allowedFallbacks}),
      mode:'run', tools:[], label:purpose, executionContext:executionFor(ctx,plan.modelPlan,purpose), log });
    const abort = () => { ctx.cancelled=true;void session.abort(); };
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try {
      await session.ready();const result=await session.prompt(prompt);
      if(result.aborted||result.modelError)throw new Error(result.modelError ?? '辅助作业已停止');
      await journal.finishRoot(ownerOf(ctx),'completed');
      const requests=Object.values((await journal.snapshot()).requests).filter(row=>row.owner.rootRunId===ctx.runId);
      return {...result,modelCalls:requests.map(row=>({modelKey:row.actualModel.modelKey,model:row.actualModel.model,at:row.startedAt,input:row.tokenUsage?.uncachedInput??0,output:row.tokenUsage?.output??0,cacheRead:row.tokenUsage?.cacheRead??0,cacheWrite:row.tokenUsage?.cacheWrite??0,missing:row.coverage==='complete'?0:1}))};
    } catch(error){await journal.finishRoot(ownerOf(ctx),ctx.cancelled?'cancelled':'failed',error.message);throw error;}
    finally {signal?.removeEventListener('abort',abort);session.dispose();}
  }
  async function observeTransport({ config, purpose, fetchImpl, run }) {
    await journalReady;
    const inherited = currentExecutionScope(), parent = inherited?.execution;
    const owner = parent?.owner ?? { conversationId: config.conversationId ?? '__auxiliary__', rootRunId: `aux-${randomUUID()}`, generation: 0 };
    if (!parent) await journal.beginRoot(owner, { kind: 'auxiliary', purpose });
    const actualModel = Object.fromEntries(['modelKey','providerId','model','api','baseUrl','supportsVision'].filter(key => config[key] !== undefined).map(key => [key,config[key]]));
    const trackedFetch = async (url, init) => {
      const requestId = `request-${randomUUID()}`;
      if (parent?.cancelled?.() || inherited?.signal?.aborted || parent?.fatalError) throw new Error(parent?.fatalError ?? '所属目标已停止');
      try { await journal.requestStart(owner, { requestId, logicalCallId: requestId, purpose, role: parent?.plan?.role ?? 'auxiliary', actualModel, cost: {status:'unknown'} }, parent?.budgets.maxRequestsPerRun ?? 60); }
      catch(error) { if(parent && error.code !== 'request-limit')parent.fatalError=error.message;throw error; }
      try {
        const response = await fetchImpl(url, inherited?.signal ? { ...init, signal: AbortSignal.any([inherited.signal, ...(init?.signal?[init.signal]:[])]) } : init);
        let tokenUsage = null;
        if (response.headers.get('content-type')?.includes('application/json')) {
          const payload = await response.clone().json().catch(()=>null), usage=payload?.usage;
          if (usage && ['input_tokens','prompt_tokens','output_tokens','completion_tokens','cache_read_input_tokens'].some(key=>Number.isFinite(usage[key]))) tokenUsage = { uncachedInput: usage.input_tokens ?? Math.max(0,(usage.prompt_tokens ?? 0)-(usage.prompt_tokens_details?.cached_tokens ?? 0)), cacheRead: usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0, output: usage.output_tokens ?? usage.completion_tokens ?? 0 };
        }
        await journal.requestEnd(requestId, { httpStatus:response.status, tokenUsage, coverage:tokenUsage?'complete':'unknown' });parent?.onRequestRecorded?.();return response;
      } catch(error) { await journal.requestEnd(requestId,{error:error.message,coverage:'unknown'});throw error; }
    };
    try { const result=await run(trackedFetch);if(!parent)await journal.finishRoot(owner,'completed');return result; }
    catch(error) { if(!parent)await journal.finishRoot(owner,'failed',error.message);throw error; }
  }
  const roles = loadRoles();
  const accessService = () => getAccessService();
  const roleTools = tools => sessionOptions.tools ? tools.filter(tool => sessionOptions.tools.includes(tool)) : tools;

  /** conversationId → { agent, key, lastUsedAt, ctx }。ctx＝最近一回合的冻结上下文（工具执行期读）。 */
  const agents = new Map();
  // LRU 导出异步完成时实例已不驻留；单独保留写入身份，回卷／重建即可作废旧写入。
  const archiveWriters = new Map();

  // ---- 子 agent ----

  async function currentRoleLoadout(workspace) {
    const [caps, placement] = await Promise.all([resolveCapabilities(), resolvePlacement(workspace, {log})]);
    const skills = collectSkills({skillService: getSkillService(), workspace});
    try { return await sessionLoadoutRevision({caps, placement, skills: skills.items, agentDir, memoryEnabled: false}); }
    finally { skills.release(); }
  }

  async function createRoleSession({ role, conversationId, accessId, workspace, inputSource, modelPlan, sessionRef, sessionSource, sessionState = null }) {
    const caps = await resolveCapabilities();
    const placement = await resolvePlacement(workspace, { log });
    const skills = collectSkills({ skillService: getSkillService(), workspace });
    try {
      if (modelPlan.loadoutRevision && modelPlan.loadoutRevision !== await sessionLoadoutRevision({caps, placement, skills: skills.items, agentDir, memoryEnabled: false})) throw new Error('工具、技能或项目规范已变化，请重新派单');
    } catch (error) { skills.release(); throw error; }
    const modelOptions = sessionModelOptions({ config: modelPlan.config, fallback: modelPlan.fallback, fallbacks: modelPlan.allowedFallbacks, visionOn: false, vision: caps.vision });
    const session = createHemiSession({
      ...sessionOptions,
      ...placement,
      agentDir, sessionSource, nativeMemory: false,
      ...modelOptions,
      // 只读角色（explorer/oracle）走 052 只读边界，不走 055 的 verify 阶段：verify 对未授权
      // 路径一律自动拒绝、不弹卡（那是「复核已授权产物」的语义）；侦察是一等调查者，读新
      // 路径要能请求授权。只读边界照样硬拒写文件、写类命令与界面动作。
      mode: 'run',
      ...(role.mode === 'verify' ? { boundary: 'readonly' } : {}),
      tools: roleTools(role.tools),
      executionContext: { ...modelPlan.executionContext, sessionRef, roleRevision: roleSessionRevision(role, modelPlan),
        worklineId: sessionState?.worklineId, runCount: sessionState?.runCount },
      // 057：产出文件的角色可声明正式交付（白名单里有才挂，verify 只读不挂）。
      delivery: role.mode === 'run' && role.tools.includes('register_delivery'),
      appendSystem: [
        role.systemPrompt,
        ...hostSystem,
        '所有文字输出一律用中文（代码、命令、路径、文件内容除外）。提到 Hemi 时用这个名字，不要自称 pi。',
      ],
      features: caps.features,
      extensionConfig: caps.extensionConfig,
      browserBridge: caps.browserOn && role.tools.some((tool) => tool.startsWith('browser_'))
        ? createBrowserClient({ taskId: accessId, taskLabel: role.title })
        : null,
      skills: skills.items,
      accessId,
      interactiveOwner: modelPlan.interactiveOwner,
      grantScopeId: conversationId ? conversationGrantScope(conversationId) : null,
      accessService: accessService(),
      label: `${role.name} ${accessId}`,
      log,
    });
    observeCommands(session);
    onSession?.({conversationId, role: role.name, session, modelPlan});
    if(modelPlan.onProgress)session.on('progress',modelPlan.onProgress);
    if(modelPlan.onModelCall)session.on('model-call',call=>modelPlan.onModelCall(call,role.name,modelPlan.config));
    // Skill 快照随子会话释放（受控版本的引用计数）。
    const dispose = session.dispose;
    session.dispose = () => {
      skills.release();
      dispose();
    };
    try { await session.ready(); } catch (error) { session.dispose(); throw error; }
    void inputSource;
    return session;
  }

  const subagents = createSubagentManager({
    onPermissionRequest,
    ...(permissionTimeoutMs === undefined ? {} : {permissionTimeoutMs}),
    createSession: createRoleSession,
    restoreSession: async ({ sessionId, role, conversationId, workspace, inputSource, modelPlan }) => {
      const record = await sessionStore.load(sessionId, conversationId);
      const roleRevision = roleSessionRevision(role, modelPlan);
      if (record.role !== role.name) throw new Error('角色不兼容');
      if ((record.owner.generation ?? 0) !== (modelPlan.executionContext?.owner?.generation ?? 0)) throw new Error('对话已回卷，旧子会话不能恢复执行');
      const reason = sessionCompatibility({ previous: record.modelPlan, next: modelPlan, workspace, previousWorkspace: record.workspace, roleRevision, previousRoleRevision: record.roleRevision });
      if (reason) throw new Error(reason);
      const session = await createRoleSession({ role, conversationId, accessId: sessionId, workspace, inputSource, modelPlan, sessionRef: sessionId, sessionSource: nativeSessionReference(sessionId), sessionState: record });
      return { role, conversationId, workspace, modelPlan, generation: record.owner.generation ?? 0, phase: 'terminal', finalized: true, session, historyId: record.owner.taskId, sessionRef: sessionId, worklineId: record.worklineId, contextRefs: record.contextRefs ?? [], runs: record.runCount ?? 1 };
    },
    history,
    onModelUsage,
    cleanupAccessTask: (taskId) => accessService().cleanupTask(taskId),
    onSettled: async (task, result) => {
      result.reportRef = await contextStore.put({ owner: { conversationId: task.conversationId, rootRunId: task.rootRunId, taskId: result.taskId, generation: task.generation ?? 0 }, kind: 'report', content: [{ type: 'text', text: [task.resultText, result.outcomeReason ? `［宿主错误详情］\n${result.outcomeReason}` : null].filter(Boolean).join('\n\n') }], source: { kind: 'tool', tool: 'task' } });
      task.reportRef = result.reportRef;
      await task.session?.persistExecution?.();
      // 057 统一 accepted：所有派单结算（含前台参数与单条停止）都写入结果存储与 inbox，
      // 不再由 background/stopRequested 决定是否产生事件（agent-task-lifecycle R-03/R-11）。
      await journal.completeTask({ dispatchKey: task.dispatchKey, owner: { conversationId: task.conversationId, rootRunId: task.rootRunId, generation: task.generation ?? 0, taskId: result.taskId }, result });
    },
    onTerminal: (event) => notifyTaskTerminal(event),
    // 062：子 agent 的 register_delivery 声明提升到会话 flow（llm.ipc 统一查证登记）。
    onDeliveryDeclared: (declaration) => onDeliveryDeclared?.(declaration),
    log,
  });
  subagents.onChange((snapshot) => onTaskState?.(snapshot));

  /** 后台子 agent 终态 → 唤醒所属对话的主 agent。 */
  function notifyTaskTerminal(result) {
    // 工作流节点的子工作由节点自己等候／取报告，不唤醒普通对话主 agent。
    if (result?.rootRunId?.startsWith('wrun-')) return;
    const conversationId = result?.conversationId;
    const entry = conversationId ? agents.get(conversationId) : null;
    // 064：结果由当前根目标在安全边界消费，不自行开启另一个 event-run。
    if (!entry || entry.activeRootRunId !== result.rootRunId) return;
    return; // 已持久化 inbox；runRootTurn 负责消费并保序。
  }

  // ---- 主 agent ----

  function cwdKeyOf(placement) {
    return placement.remote ? `${placement.remote.host}:${placement.remote.dir}` : placement.cwd;
  }

  /**
   * 取（或建）对话的主 agent。plan 变化（模型/工作区/系统段/能力开关）时导出条目换新。
   * @param {object} turn 本回合冻结上下文：{ conversationId, workspace, config, fallback, inputSource, profileId, … }
   */
  async function obtain(turn) {
    const { conversationId } = turn;
    const caps = await resolveCapabilities();
    const placement = await resolvePlacement(turn.workspace, { log });
    const skills = collectSkills({ skillService: getSkillService(), workspace: turn.workspace });
    // 角色可用性：解析不出模型（如 designer 没有视觉模型）的角色不进路由卡。
    const available = new Set();
    for (const name of ROLE_NAMES) {
      const resolved = await resolveRoleModel({ role: roles.get(name), store: getProfiles(turn), mainConfig: turn.config, routed: Boolean(turn.routed), snapshot: turn.policySnapshot });
      if (resolved.ok) available.add(name);
    }
    let workspaceBlock = '';
    const view = turn.workspace?.id ? getWorkspaceService()?.resolve(turn.workspace.id) ?? null : null;
    if (view?.type === 'project' && view.status === 'ok' && !view.host) workspaceBlock = buildWorkspaceContextBlock(view);
    const appendSystem = buildAgentAppendSystem({
      routingSection: buildRoutingSection(roles, { available }),
      workspaceBlock,
    });
    appendSystem.push(...hostSystem);
    const modelOptions = sessionModelOptions({ config: turn.config, fallback: turn.fallback, fallbacks: turn.modelPlan?.allowedFallbacks, visionOn: false, vision: caps.vision });
    const key = JSON.stringify({
      model: turn.config?.modelKey ?? turn.config?.model, fallback: turn.fallback?.modelKey ?? null, routed: Boolean(turn.routed),
      // 不在驻留 key／日志中保留凭据；有效模型／扩展配置变化必须重建 provider 闭包。
      config: createHash('sha256').update(JSON.stringify({ modelOptions, extensions: caps.extensionConfig })).digest('hex'),
      thinking: modelOptions.thinking, cwd: cwdKeyOf(placement), features: caps.features,
      skills: skills.items.map((item) => item.path), system: appendSystem,
    });
    const existing = agents.get(conversationId);
    if (existing && existing.key === key && !existing.agent.isDisposed()) {
      skills.release();
      existing.lastUsedAt = Date.now();
      existing.ctx = turn;
      existing.activeRootRunId = turn.runId ?? null;
      return existing.agent;
    }
    let entries = null, sessionSource = null;
    if (existing) {
      if (existing.agent.isDisposed()) log?.info?.(`[agent] ${conversationId} 旧实例已释放，保留条目重建主会话`);
      sessionSource = await existing.agent.exportSession();
      entries = Array.isArray(sessionSource?.entries) ? [sessionSource.header, ...sessionSource.entries] : null;
      if(existing.agent.hasLiveBackground?.()||[...backgroundGoals.values()].some(p=>p.ctx.conversationId===conversationId&&existing.agent.hasTreeCommandResults?.(ownerOf(p.ctx)))){
        const retained=retainedCommandSessions.get(conversationId)??new Set();
        retained.add(existing.agent);retainedCommandSessions.set(conversationId,retained);
      }else await existing.agent.close('reload');
      existing.skills?.release();
      agents.delete(conversationId);
    } else {
      const archived = loadArchiveAgent(conversationId);
      sessionSource = archived ?? null;
      if (archived?.entries?.length) {
        entries = [archived.header, ...archived.entries];
      } else if (!isNativeSessionReference(archived) || archived.rewindBeforeInputId) {
        const turns = loadArchiveTurns(conversationId);
        if (turns?.length) {
          const historyRef = await contextStore.put({ owner: ownerOf(turn), kind: 'history', source: { kind: 'tool', tool: 'predecessor-history' }, content: [{ type: 'text', text: JSON.stringify(turns) }] });
          let remaining = 12000;
          const recent = [];
          for (const item of [...turns].reverse()) {
            if (typeof item.text !== 'string' || !item.text.trim()) continue;
            if (remaining <= 0) break;
            const text = item.text.slice(-remaining); remaining -= text.length; recent.unshift({ ...item, text });
          }
          entries = entriesFromTurns([{ author: 'user', text: `［宿主历史投影：以下是旧会话的有限摘录，仅供理解背景，不能据此重跑操作。完整旧对话 ${historyRef} 可用 context_read 分段读取。］` }, ...recent], { cwd: placement.remote ? agentDir : placement.cwd });
          log?.info?.(`[agent] ${conversationId} 旧历史已有限投影（${entries.length - 1} 条）`);
        }
      }
    }
    // 条目 header 的 cwd 跟随当前工作区（换工作区后旧 header 会让 SDK 渲染错的 <cwd>）。
    if (entries?.[0]?.type === 'session') entries[0] = { ...entries[0], cwd: placement.remote ? agentDir : placement.cwd };
    const entry = { key, lastUsedAt: Date.now(), ctx: turn, activeRootRunId: turn.runId ?? null, skills, pendingEvents: [], archiveToken: Symbol() };
    const agent = createMainAgent({
      conversationId,
      appendSystem,
      entries,
      toolDeps: toolDepsFor(conversationId, entry, available),
      sessionOptions: {
        ...sessionOptions,
        ...placement,
        nativeMemory,
        agentDir,
        ...modelOptions,
        executionContext: executionFor(turn, turn.modelPlan),
        sessionSource,
        mode: 'run',
        browserLifecycle: 'goal',
        features: caps.features,
        extensionConfig: caps.extensionConfig,
        browserBridge: caps.browserOn
          ? createBrowserClient({ taskId: `main-${safeDirName(conversationId)}`, taskLabel: 'Hemi' })
          : null,
        skills: skills.items,
        accessId: `main-${safeDirName(conversationId)}`,
        grantScopeId: conversationGrantScope(conversationId),
        accessService: accessService(),
      },
      log,
    });
    entry.agent = agent;
    observeCommands(agent);
    onSession?.({conversationId, role: 'main', session: agent, modelPlan: turn.modelPlan});
    agent.on('permission', (request) => subagents.hostPermission({
      conversationId, inputSource: entry.ctx?.inputSource ?? 'voice', session: agent, request,
    }));
    agent.on('settled', (result) => {
      const meta = entry.pendingEvents.shift() ?? null;
      onEventTurn?.(conversationId, result, meta);
      void persist(conversationId);
    });
    agents.set(conversationId, entry);
    archiveWriters.set(conversationId, entry.archiveToken);
    evictLRU(conversationId);
    try {
      await agent.ready();
    } catch (error) {
      agents.delete(conversationId);
      if (archiveWriters.get(conversationId) === entry.archiveToken) archiveWriters.delete(conversationId);
      agent.dispose();
      skills.release();
      throw error;
    }
    return agent;
  }

  function toolDepsFor(conversationId, entry, available) {
    return {
      ...(conversationHistory ? { conversationRead: (args, signal) => {
        const ctx = entry.ctx;
        return conversationHistory.read(args, { owner: ownerOf(ctx), signal, cancelled: () => Boolean(ctx.cancelled) });
      } } : {}),
      ...(!entry.ctx?.frozenRoleModels && getWorkflowService ? {
        workflowPreparation: async (args, signal) => {
          const ctx = entry.ctx;
          signal?.throwIfAborted();
          if (ctx.cancelled) throw new DOMException('根目标已停止', 'AbortError');
          return getWorkflowService().managePreparation({ ...args, conversationId, owner: ownerOf(ctx), signal });
        },
      } : {}),
      agents: [...available],
      spawn: async ({ agent: roleName, prompt, description, background, sessionId, signal, toolCallId, requirements, contextRefs = [] }) => {
        const role = roles.get(roleName);
        if (!role || !available.has(roleName)) return { ok: false, error: `没有可用的子 agent「${roleName}」` };
        const ctx = entry.ctx;
        const frozen = ctx.frozenRoleModels?.[roleName];
        const resolved = ctx.policySnapshot
          ? await resolveRoleModel({ role, store: getProfiles(ctx), mainConfig: ctx.config, routed: Boolean(ctx.routed), snapshot: ctx.policySnapshot, requirements })
          : frozen ? { ok: true, config: frozen, source: 'role' }
          : { ok: false, message: `本次执行缺少冻结模型策略：${roleName}` };
        if (!resolved.ok) return { ok: false, error: resolved.message };
        resolved.modelPlan.loadoutRevision = await currentRoleLoadout(ctx.workspace);
        if (ctx.cancelled) return { ok: false, error: '根目标已停止' };
        const owner = ownerOf(ctx);
        const callAnchorId = entry.agent?.callAnchor(toolCallId);
        const dispatchKey = dispatchIdentity({ ...owner, sessionId: conversationId, callAnchorId, toolCallId });
        if (dispatchInFlight.has(dispatchKey)) return dispatchInFlight.get(dispatchKey);
        const execute = (async () => {
          await journalReady;
          const reserved = await journal.reserveDispatch(dispatchKey, { owner, callAnchorId, toolCallId });
          if (reserved.existing) {
            if (reserved.result) return { ok: true, background: false, result: reserved.result };
            if (reserved.receipt) return reserved.receipt;
            return { ok: false, error: '该派单已受理但执行状态未知；请核对已有结果，不会重复启动' };
          }
          const receipt = await subagents.spawn({
          role, prompt, description, background, sessionId, signal, toolCallId, dispatchKey, taskId: reserved.taskId, generation: owner.generation,
          conversationId, inputSource: ctx.inputSource, workspace: ctx.workspace,
          // 060 R-22：记所属主运行（插队停止按根目标取消，不限前台/后台）。
          rootRunId: typeof ctx.runId === 'string' && ctx.runId ? ctx.runId : null,
          modelPlan: { ...resolved.modelPlan, executionContext: { ...executionFor(ctx, resolved.modelPlan, 'subagent'), allowedRefs: [...new Set([ctx.inputRef, ...contextRefs].filter(Boolean))] }, config: resolved.config, fallback: resolved.modelPlan?.allowedFallbacks[0] ?? null, source: resolved.source, frozen: Boolean(ctx.frozenRoleModels), onModelCall:ctx.workflowUsage, onProgress:ctx.workflowTrace, interactiveOwner: ctx.frozenRoleModels ? ctx.runId : undefined },
          });
          await journal.recordReceipt(dispatchKey, receipt);
          return receipt;
        })();
        dispatchInFlight.set(dispatchKey, execute);
        try { return await execute; } finally { dispatchInFlight.delete(dispatchKey); }
      },
      status: ({ id }) => subagents.status({ conversationId, keyOrId: id }),
      waitFor: async (id, opts) => {
        const result = await subagents.waitFor(id, { ...opts, conversationId });
        if (result) await journal.consume([`complete:${result.taskId}`], `tool:${opts?.toolCallId ?? id}`);
        return result;
      },
      message: (id, text) => subagents.message(id, text, { conversationId, rootRunId: entry.ctx.runId }),
      cancel: (id) => subagents.stop(id, { reason: 'cancel', conversationId, rootRunId: entry.ctx.runId }),
      runtimeDiagnostics: () => entry.ctx?.runtimeDiagnostics?.() ?? { ok: false },
    };
  }

  const pendingClosures = new Set();
  const workflowClosures = new Set();
  function retiring(work) {
    const promise = Promise.resolve(work).catch(error => log?.warn?.(`释放执行会话失败：${error.message}`));
    pendingClosures.add(promise);
    void promise.finally(() => pendingClosures.delete(promise));
    return promise;
  }

  function evictLRU(keep) {
    if (agents.size <= MAX_RESIDENT) return;
    const candidates = [...agents.entries()]
      .filter(([id, entry]) => id !== keep && !entry.activeRootRunId && !entry.waitingForUser && !entry.agent?.isBusy()
        && ![...backgroundGoals.values()].some(p=>p.ctx.conversationId===id)
        && !commandSessions(id).some(session=>session.hasLiveBackground?.()))
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [id, entry] of candidates) {
      if (agents.size <= MAX_RESIDENT) break;
      retiring((async () => {
        try {
          const payload = await entry.agent.exportSession();
          if (payload && archiveWriters.get(id) === entry.archiveToken) await saveArchiveAgent(id, payload);
        } finally { await entry.agent.close('reload'); entry.skills?.release(); }
      })());
      agents.delete(id);
    }
  }

  /** 工作流使用同一套主／子 agent 装配与确认环，节点会话独立释放，不进入对话 LRU。 */
  async function openWorkflowNode({ nodeSpec, executionOwner, invocation, skills = [], bridge = null, bridgeUrl = null, applicationRef = null, signal, onModelCall,onTrace }) {
    signal?.throwIfAborted();
    const plan = await hydrateWorkflowModel(invocation.run.modelPlan, getProfiles());
    const workspace = invocation.run.workspace ?? getWorkspaceService()?.resolve('default');
    const placement = await resolvePlacement(workspace, { log });
    const caps = await resolveCapabilities();
    const available = new Set(Object.keys(plan.roleModels));
    const context = { conversationId: invocation.conversationId, workspace, ...plan, policySnapshot: plan.policySnapshot, frozenRoleModels: plan.roleModels, runId: executionOwner.workflowRunId, sessionRef: `session-${executionOwner.attemptId}`, inputSource: 'text' };
    const entry = { ctx: context };
    await journalReady;
    await journal.beginRoot(ownerOf(context), { kind: 'workflow', policySnapshot: context.policySnapshot, workspace });
    let waitingReason=null,externalOutcomeUnknown=false;
    const main = createMainAgent({
      conversationId: invocation.conversationId,
      appendSystem: [
        ...buildAgentAppendSystem({ routingSection: buildRoutingSection(roles, { available }) }),
        '这是独立工作流节点。只执行本节点目标；派出的工作须在交付前等待完成，不遗留后台工作。',
        ...(bridgeUrl ? [`浏览器目标：${bridgeUrl}`] : []),
        ...(applicationRef ? [`桌面目标应用：${applicationRef}`] : []),
      ],
      toolDeps: toolDepsFor(invocation.conversationId, entry, available),
      sessionOptions: {
        ...sessionOptions,
        ...placement, agentDir, nativeMemory,
        executionContext: executionFor(context, plan.modelPlan),
        ...sessionModelOptions({ config: plan.config, fallback: plan.fallback, fallbacks: plan.modelPlan?.allowedFallbacks, visionOn: false, vision: caps.vision }),
        mode: 'run',

        extraExtensions:[{name:'workflow-control',factory:pi=>pi.registerTool({name:'workflow_wait',label:'等待用户操作',description:'需要用户登录或补充必要信息时暂停节点，等待用户点击继续。',parameters:{type:'object',properties:{message:{type:'string'}},required:['message']},async execute(_id,args){waitingReason=String(args.message);queueMicrotask(()=>{void main.requestHandoff();});return {content:[{type:'text',text:'已暂停，等待用户操作'}]};}})}],
        features: caps.features, extensionConfig: caps.extensionConfig,
        browserBridge: bridge, skills,
        interactiveOwner: executionOwner.workflowRunId,
        accessId: `wf-${executionOwner.workflowRunId}-${executionOwner.attemptId}`,
        grantScopeId: conversationGrantScope(invocation.conversationId), accessService: accessService(),
      }, log,
    });
    entry.agent = main;
    const usageWrites = [],usedTools=new Set();
    let callSeq = 0;
    const recordCall=(call,role='main',config=plan.config)=>{
      const actual = [config,plan.fallback].filter(Boolean).find(candidate => candidate.model===call.model) ?? config;
      const record = {role,id:`${executionOwner.attemptId}-${++callSeq}`,modelKey:actual.modelKey,model:call.model,at:Date.now(),missing:call.usageDetail?0:1,...call.usageDetail};
      if(onModelCall) { const write = Promise.resolve(onModelCall(record)); void write.catch(() => {}); usageWrites.push(write); }
    };
    const recordProgress=event=>{
      if(event.kind==='tool-end'&&!event.background&&!event.isError&&event.actionState!=='not-executed')usedTools.add(event.tool);
      if(event.browser?.steps?.some(step=>step.status==='dispatched-unknown')) {
        externalOutcomeUnknown=true;waitingReason='外部操作回执丢失，请核对是否已完成；确认后才能继续，避免重复提交。';
        queueMicrotask(()=>{void main.requestHandoff();});
      }
      if(!onTrace||!['tool-start','tool-end'].includes(event.kind))return;
      const write=Promise.resolve(onTrace({at:Date.now(),kind:event.kind,tool:event.tool,isError:Boolean(event.isError),externalOutcomeUnknown}));void write.catch(()=>{});usageWrites.push(write);
    };
    context.workflowTrace=recordProgress;
    main.on('progress',recordProgress);
    context.workflowUsage=recordCall;
    main.on('model-call',call=>recordCall(call));
    main.on('permission', request => subagents.hostPermission({ conversationId: invocation.conversationId, inputSource: 'text', session: main, request }));
    try { await main.ready(); signal?.throwIfAborted(); }
    catch (error) { await main.close('reload'); throw error; }
    const abort = async () => {
      context.cancelled = true;
      subagents.clearHostedPermission(invocation.conversationId);
      await Promise.all([main.abort(), subagents.cancelByRootRun(executionOwner.workflowRunId, { reason: 'stop' })]);
    };
    const session = { prompt: async text => {
      const result = await runOwnedTurn(entry, {userText:text});
      if (result.budgetLimited) throw Object.assign(new Error(result.lastText), { code: 'request-limit' });
      if(waitingReason){const error=new Error(waitingReason);error.code='waiting';error.externalOutcomeUnknown=externalOutcomeUnknown;throw error;}
      const owned = [...subagents._internals.tasks.values()].filter(task => task.rootRunId === executionOwner.workflowRunId);
      signal?.throwIfAborted();
      const failed = owned.find(task => task.outcome !== 'complete');
      if (failed) throw new Error(`子任务未成功：${failed.outcomeReason ?? failed.outcome}`);
      return {...result,toolNames:[...usedTools]};
    }, abort, dispose: () => { retiring(release()); }, isBusy: () => main.isBusy(), requestHandoff: () => main.requestHandoff() };
    let releasePromise;
    function release() {
      releasePromise ??= (async () => {
        try { await abort(); await Promise.all(usageWrites); }
        finally {
          for (const task of subagents._internals.tasks.values()) if (task.rootRunId === executionOwner.workflowRunId && task.phase === 'terminal') {
            try { task.session?.dispose(); } finally { task.session = null; }
          }
          await main.close('session-end');
          workflowClosures.delete(release);
        }
      })();
      return releasePromise;
    }
    workflowClosures.add(release);
    return { agent: createWorkflowNodeAgent({ session, nodeSpec, executionOwner, log }), release };
  }

  async function prepareExecution(ctx) {
    await journalReady;await journal.beginRoot(ownerOf(ctx), {policySnapshot:ctx.policySnapshot,workspace:ctx.workspace});
    return executionFor(ctx,ctx.modelPlan,'input-preparation');
  }
  async function runRootTurn(conversationId, args) {
    const entry = agents.get(conversationId);
    if (!entry || entry.ctx.cancelled) throw new Error('目标已停止');
    const ctx = entry.ctx, owner = ownerOf(ctx), controller = new AbortController();
    if(ctx.continuationOf)ctx.continuationOf=await journal.rootForFlow(conversationId,ctx.continuationOf);
    entry.goalController = controller; entry.activeRootRunId = owner.rootRunId;
    await journalReady;
    await journal.beginRoot(owner, {policySnapshot:ctx.policySnapshot, workspace:ctx.workspace});
    try {
      const result = await driveGoal({journal, owner, objective:args.userText, policy:normalizeGoalPolicy(goalPolicy), signal:controller.signal,
        initialEvent:args.hostEvent??null,
        continuation:ctx.continuationOf ? {rootRunId:ctx.continuationOf,inputId:args.inputId,answer:args.userText} : null,
        run: hostEvent => {
          entry.agent.setActivityPhase(hostEvent ? 'continuing' : 'running');
          return runOwnedTurn(entry, {...args, hostEvent, goalRound:true});
        },
        verify: (objective, evidence) => {
          entry.agent.setActivityPhase('verifying');
          return verifyGoalCompletion({execution:{...executionFor(ctx, ctx.modelPlan), actualCandidate:entry.actualCandidate}, objective, evidence, signal:controller.signal, onCall:call=>onGoalVerification?.(conversationId,call)});
        },
        evidence: async () => goalEvidence((await entry.agent.exportEntries())?.entries ?? [], await journal.snapshot(), owner),
        persist: () => entry.agent.checkpointExecution(),
        backgroundPending:()=>commandSessions(conversationId).some(session=>session.hasTreeCommands?.(owner)||session.hasTreeCommandResults?.(owner)),
        cleanup: async () => {
          await Promise.all([entry.agent.abort({commandOwner:owner}), subagents.cancelByRootRun(owner.rootRunId, {reason:'stop'})]);
        },
      });
      if(result.waitingForBackground)backgroundGoals.set(owner.rootRunId,{ctx:{...ctx,cancelled:false},args:{...args,hostEvent:null},queued:false});
      entry.agent.setActivityPhase('finishing');
      if (result.completionText) {
        await entry.agent.recordGoalCompletion(result.completionText, controller.signal);
        result.texts = [...result.texts, result.completionText];
        result.lastText = result.completionText;
      }
      return result;
    } finally { if (entry.goalController === controller) { entry.goalController = null; entry.activeRootRunId = null; } }
  }
  function backgroundContext(conversationId,rootRunId){
    const pending=backgroundGoals.get(rootRunId);
    return pending?.ctx.conversationId===conversationId?pending.ctx:null;
  }
  async function resumeBackground(conversationId,{rootRunId,generation,flowRunId},{onReady=()=>{}}={}){
    const pending=backgroundGoals.get(rootRunId),ctx=pending?.ctx;
    if(shuttingDown||!ctx||ctx.conversationId!==conversationId||ctx.generation!==generation)return {aborted:true,skipped:true};
    const owner=ownerOf(ctx),root=await journal.root(owner);
    if(root?.status!=='waiting_background'){backgroundGoals.delete(rootRunId);return {aborted:true,skipped:true};}
    if(!pending.review&&!commandSessions(conversationId).some(session=>session.hasTreeCommandResults?.(owner))){
      pending.queued=false;
      if(!commandSessions(conversationId).some(session=>session.hasTreeCommands?.(owner))){
        backgroundGoals.delete(rootRunId);await journal.finishRoot(owner,'interrupted','后台结果已被读取，不再自动续跑');
      }
      return {aborted:true,skipped:true};
    }
    // Reuse the original owner and frozen model policy; this is no new user goal.
    try{await journal.resumeBackgroundGoal(owner,{flowRunId});}
    catch(error){
      if(error.code!=='goal-budget-limit')throw error;
      backgroundGoals.delete(rootRunId);
      await Promise.all(commandSessions(conversationId).map(session=>session.abort({commandOwner:owner})));
      await subagents.cancelByRootRun(rootRunId,{reason:'stop'});
      await journal.endGoal(owner,'budget_limited',error.message);
      return {goalComplete:false,halted:{kind:'budget_limited',reason:error.message},texts:[],usages:[],toolNames:[],requests:0};
    }
    backgroundGoals.delete(rootRunId);
    ctx.cancelled=false;ctx.flowRunId=flowRunId;
    const events=(await Promise.all(commandSessions(conversationId).map(session=>session.collectTreeCommands?.(owner)??[]))).flat();
    const agent=await obtain(ctx);
    await onReady(agent,ctx);
    const hostEvent=events.length?backgroundCommandEvent(events):{customType:'hemi_background_command_review',content:'［后台命令状态观察 · 用户请求核对已有任务，不是新目标］\n读取现有命令状态和输出；不要重复启动。'};
    hostEvent.content=[`原目标：${root.goal.objective}`,hostEvent.content,'只处理上述实际结果，继续原目标；不要重启已受理的命令，不恢复已取消的工作。'].join('\n');
    return runRootTurn(conversationId,{...pending.args,hostEvent});
  }
  /** 上下文容量快照（渲染层轮末/切换会话时拉取；无在途会话返回 null）。 */
  function contextUsageFor(conversationId) {
    const entry = agents.get(conversationId);
    try { return entry?.agent?.contextUsage?.() ?? null; } catch { return null; }
  }
  async function runOwnedTurn(entry, args) {
    if (!entry || entry.ctx.cancelled) throw new Error('根目标已停止或主会话已失效');
    const ctx = entry.ctx, agent = entry.agent, conversationId = ctx.conversationId;
    const owner = ownerOf(ctx);
    await journalReady;
    await journal.beginRoot(owner, { policySnapshot: ctx.policySnapshot, workspace: ctx.workspace });
    entry.activeRootRunId = owner.rootRunId;
    ctx.inputRef = await contextStore.put({ owner, kind: 'source', content: [{ type: 'text', text: [args.userText, args.contextText].filter(Boolean).join('\n\n') }] });
    const execution = executionFor(ctx, ctx.modelPlan);
    agent.setExecutionContext(execution);
    const startEntryCount = (await agent.exportEntries())?.entries?.length ?? 0;
    let combined = { texts: [], usages: [], toolNames: [], requests: 0 };
    const append = result => {
      combined = { ...combined, ...result, texts: [...combined.texts, ...(result.texts ?? [])], usages: [...combined.usages, ...(result.usages ?? [])], toolNames: [...combined.toolNames, ...(result.toolNames ?? [])], requests: combined.requests + (result.requests ?? 0) };
    };
    try {
      append(await agent.runTurn(args));
      if (combined.modelError) throw new Error(`回合未完成：${describeModelError(combined.modelError)}`);
      if (combined.budgetLimited) throw Object.assign(new Error('执行请求已达上限'), {code:'request-limit'});
      while (!ctx.cancelled && !combined.aborted) {
        const owned = [...subagents._internals.tasks.values()].filter(task => task.rootRunId === owner.rootRunId);
        const pending = owned.filter(task => !task.finalized);
        if (pending.length) agent.setActivityPhase('waiting-subagents');
        if (args.goalRound && pending.length) {
          const waitAbort = new AbortController();
          try {
            const boundary = await Promise.race([
              Promise.all(pending.map(task => task.running ?? task.terminalWait)),
              journal.waitForRequestLimit(owner, {signal:waitAbort.signal}).then(() => 'budget'),
              // 057 软复盘唤醒：子任务跨段后父在等待边界复盘，可核对/干预，不中断子任务（H-01/R-02）。
              journal.waitForReview(owner, {signal:waitAbort.signal}).then(review => review ? 'review' : null),
            ]);
            if (boundary === 'budget' || boundary === 'review') throw Object.assign(new Error('执行请求已达上限'), {code:'request-limit'});
          } finally { waitAbort.abort(); }
        } else await Promise.all(pending.map(task => task.running ?? task.terminalWait));
        if (ctx.cancelled) break;
        if ((await journal.root(owner))?.requestLimitReached) throw Object.assign(new Error('执行请求已达上限'), {code:'request-limit'});
        const events = await journal.pending(owner);
        if (events.length) {
          const content = ['［子任务完成 · 宿主观察，不是用户新指令］', ...events.map(event => formatSubagentResult(event.result))].join('\n\n');
          append(await agent.consumeEvents(events, content));
          if (combined.modelError) throw new Error(`回合未完成：${describeModelError(combined.modelError)}`);
          if (combined.aborted || ctx.cancelled) break;
          const exported = await agent.exportEntries();
          await agent.persistExecution();
          await journal.consume(events.map(event => event.eventId), exported?.entries?.findLast(item => item.type === 'custom_message' && item.details?.eventIds?.some(id => events.some(event => event.eventId === id)))?.id ?? exported?.entries?.at(-1)?.id ?? 'unknown');
          continue;
        }
        // 057 根等待后代必要工作（agent-task-lifecycle R-04/R-09）：子任务结算后其仍受管的
        // 命令由根按 rootRunId+generation 收集事实并等待终态，先于完成校验，不发模型请求。
        const settled = owned.filter(task => task.phase === 'terminal' && task.session && !task.session.isDisposed?.());
        const commandEvents = [];
        for (const task of settled) {
          try { commandEvents.push(...(await task.session.collectTreeCommands?.(owner) ?? [])); }
          catch (error) { log?.warn?.(`子任务 ${task.key} 的命令事实收集失败：${error?.message ?? error}`); }
        }
        if (commandEvents.length) {
          const wrapped = commandEvents.map(event => ({ eventId: event.id, result: event }));
          const content = ['［后代后台命令完成 · 宿主观察，不是用户新指令］', ...commandEvents.map(event => `${event.description ?? String(event.command ?? '').slice(0, 120)}：\n${String(event.text).slice(0, 2000)}`)].join('\n\n');
          append(await agent.consumeEvents(wrapped, content));
          if (combined.modelError) throw new Error(`回合未完成：${describeModelError(combined.modelError)}`);
          if (combined.aborted || ctx.cancelled) break;
          await agent.persistExecution();
          continue;
        }
        if (!args.goalRound && settled.some(task => task.session.hasTreeCommands?.(owner))) {
          // 事件驱动优先（journal 进程终态唤醒）；未注册 journal 的记录缺口用有界内存观察兜底，
          // 不发模型请求、不刷新任何截止（agent-task-lifecycle R-04：等待有明确对象与解除事件）。
          while (!ctx.cancelled && !combined.aborted && settled.some(task => task.session.hasTreeCommands?.(owner))) {
            agent.setActivityPhase('waiting-subagents');
            await Promise.race([
              journal.waitForProcesses(owner).catch(() => {}),
              new Promise(resolve => setTimeout(resolve, 500)),
            ]);
          }
          continue;
        }
        break;
      }
      if (combined.aborted || ctx.cancelled) await subagents.cancelByRootRun(owner.rootRunId, { reason: 'stop' });
      return { ...combined, aborted: combined.aborted || Boolean(ctx.cancelled) };
    } catch (error) {
      // 057 软复盘唤醒（reviewPending）与硬预算触顶共用回合收口路径：复盘不清除工作、不取消目标。
      const rootNow = await journal.root(owner);
      const limited = rootNow?.requestLimitReached || rootNow?.reviewPending;
      if (limited && (error.code === 'request-limit' || execution.requestLimited || combined.budgetLimited) && !execution.fatalError && !ctx.cancelled && !combined.aborted) {
        try {
          const owned = [...subagents._internals.tasks.values()].filter(task => task.rootRunId === owner.rootRunId);
          if (ctx.cancelled) throw new DOMException('任务已停止', 'AbortError');
          if (args.goalRound) {
            // Persist reports already available; the goal driver can hand off while accepted work remains live.
            const events = await journal.pending(owner);
            let entries = (await agent.exportEntries())?.entries ?? [];
            const anchor = event => entries.findLast(item => item.type === 'custom_message' && item.details?.eventIds?.includes(event.eventId));
            const unseen = events.filter(event => !anchor(event));
            if (unseen.length) await agent.recordEvents(unseen, ['［子任务完成 · 宿主观察，不是用户新指令］', ...unseen.map(event => formatSubagentResult(event.result))].join('\n\n'));
            await agent.persistExecution();
            entries = (await agent.exportEntries())?.entries ?? [];
            for (const event of events) {
              const entry = anchor(event);
              if (!entry) throw new Error('子任务报告尚未保存，不能续跑');
              await journal.consume([event.eventId], entry.id);
            }
            return {...combined, modelError:null, aborted:false, budgetLimited:true};
          }
          await Promise.all(owned.filter(task => !task.finalized).map(task => task.running ?? task.terminalWait));
          if (ctx.cancelled) throw new DOMException('任务已停止', 'AbortError');
          const state = await journal.snapshot();
          const observations = Object.values(state.observations).filter(item => item.owner.rootRunId === owner.rootRunId);
          // 仅取本轮已通过工具边界投影的历史文本，不从 outputRef 旁路读取未经复核的原始结果。
          const toolResults = ((await agent.exportEntries())?.entries ?? []).slice(startEntryCount)
            .filter(item => item.message?.role === 'toolResult').slice(-8)
            .map(({ message }) => ({ tool: message.toolName, isError: Boolean(message.isError), text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(-1000) }));
          const facts = budgetSummaryFacts({ limit: limited.limit, userText: args.userText, texts: combined.texts, tasks: owned, observations, artifacts: args.getBudgetArtifacts?.() ?? [], toolResults });
          const report = await agent.summarizeLimit({ execution, ...facts });
          if (ctx.cancelled) throw new DOMException('任务已停止', 'AbortError');
          await agent.persistExecution();
          return { ...combined, modelError: null, aborted: false, budgetLimited: true, lastText: report.text, texts: [...combined.texts, report.text] };
        } catch (summaryError) { error = summaryError; }
      }
      ctx.cancelled = true;
      try { await Promise.all([agent.abort({commandOwner:owner}), subagents.cancelByRootRun(owner.rootRunId, { reason: 'stop' })]); }
      catch (cleanupError) { cleanupError.pendingStop = true; throw cleanupError; }
      throw error;
    } finally { entry.actualCandidate = execution.actualCandidate; if (!args.goalRound && entry.activeRootRunId === owner.rootRunId) entry.activeRootRunId = null; }
  }

  function commandSessions(conversationId) {
    return [...new Set([agents.get(conversationId)?.agent,...(retainedCommandSessions.get(conversationId)??[]),...[...subagents._internals.tasks.values()]
      .filter(task=>task.conversationId===conversationId).map(task=>task.session)])].filter(session=>session&&!session.isDisposed?.());
  }
  async function backgroundCommand(conversationId,request) {
    request={...request,runId:await journal.rootForFlow(conversationId,request.runId)};
    const entry=agents.get(conversationId);
    const pending=backgroundGoals.get(request.runId);
    if(!entry || (!pending&&(entry.ctx.runId!==request.runId || entry.ctx.cancelled)))throw new Error('当前目标已变化');
    if(request.action==='review'&&pending){await wakeBackground(ownerOf(pending.ctx),{review:true});return {accepted:true};}
    const controllerOwner=ownerOf(entry.ctx),sources=commandSessions(conversationId);
    if(request.action==='review')return entry.agent.backgroundCommand(request);
    const buckets=await Promise.all(sources.map(session=>session.backgroundCommand({action:'list',controllerOwner})));
    if(request.action==='list')return buckets.flat();
    const index=buckets.findIndex(jobs=>jobs.some(job=>job.id===request.jobId));
    if(index>=0)return sources[index].backgroundCommand({...request,controllerOwner});
    throw new Error('命令不存在或不属于当前会话');
  }

  async function completeConversation(conversationId, status, reason = null, rootRunId = null) {
    if (!rootRunId) throw new Error('收口缺少根目标身份');
    await journalReady;
    rootRunId=await journal.rootForFlow(conversationId,rootRunId);
    const normalized = status === 'stopped' ? 'cancelled' : status === 'awaiting-user' ? 'awaiting_user' : status === 'awaiting-background' ? 'waiting_background' : status;
    let root = (await journal.snapshot()).roots[rootRunId];
    if (root?.owner.conversationId !== conversationId) return;
    try {
      // 已完成进程的结果保存可能与校验响应同时到达；收口前保存这些事实，不等待活进程。
      const entry=agents.get(conversationId);
      if(entry?.ctx.runId===rootRunId&&normalized!=='waiting_background'){
        const events=(await Promise.all(commandSessions(conversationId).map(session=>session.collectTreeCommands?.(root.owner)??[]))).flat();
        if(events.length)await entry.agent.recordCommandEvents(events);
      }
      if (['running','waiting','awaiting_user','waiting_background','stopping'].includes(root.status)) root = await journal.finishRoot(root.owner, normalized, reason);
    } finally {
      // Read the retained in-memory fact after a failed write; a late call must
      // not turn an already cancelled/completed root back into a user wait.
      const finishedRoot = await journal.root(root.owner);
      const entry = agents.get(conversationId);
      if (entry?.activeRootRunId === rootRunId) entry.activeRootRunId = null;
      if(!['awaiting_user','waiting_background'].includes(finishedRoot?.status)){
        backgroundGoals.delete(rootRunId);
        for(const session of commandSessions(conversationId))session.releaseGoalCommands?.(root.owner);
      }
      if (entry?.ctx.runId === rootRunId) {
        entry.waitingForUser = finishedRoot?.status === 'awaiting_user';
        if (!entry.waitingForUser) await entry.agent.reclaimBrowserPages();
      }
      if(finishedRoot?.status==='waiting_background')await wakeBackground(root.owner);
    }
  }

  async function suspendWorkflow(conversationId, rootRunId) {
    await journalReady;
    const root = (await journal.snapshot()).roots[rootRunId];
    if (root?.owner.conversationId === conversationId) await journal.suspendRoot(root.owner);
  }

  async function usageRecordsFor(conversationId) {
    await journalReady;
    return usageRecordsFromJournal(await journal.snapshot(), conversationId);
  }

  /** 使用记录页：全局跨会话请求历史（筛选影响统计，分页只切 records；口径见 usage-history.mjs）。 */
  async function usageHistory(options = {}) {
    await journalReady;
    return projectUsageHistory(await journal.snapshot(), options);
  }

  function get(conversationId) {
    const entry = agents.get(String(conversationId ?? ''));
    if (!entry) return null;
    entry.lastUsedAt = Date.now();
    return entry.agent;
  }

  async function persist(conversationId) {
    const entry = agents.get(String(conversationId ?? ''));
    if (!entry) return false;
    const payload = await entry.agent.exportSession();
    return payload && agents.get(String(conversationId)) === entry && archiveWriters.get(String(conversationId)) === entry.archiveToken
      ? saveArchiveAgent(String(conversationId), payload) : false;
  }

  /**
   * 024 回卷／会话删除：档案被剪，条目作废——下次 obtain 从（已剪）档案重建；该对话的子 agent
   * 一并停掉，对话级临时授权清掉（LRU 驱逐不清：对话仍在，回来时授权照旧有效；进程退出时
   * 内存授权随之消失）。
   */
  function invalidate(conversationId) {
    for(const [id,pending]of backgroundGoals)if(pending.ctx.conversationId===conversationId)backgroundGoals.delete(id);
    for(const session of retainedCommandSessions.get(conversationId)??[])session.dispose();
    retainedCommandSessions.delete(conversationId);
    archiveWriters.delete(String(conversationId ?? ''));
    const entry = agents.get(String(conversationId ?? ''));
    entry?.goalController?.abort();
    subagents.disposeConversation(String(conversationId ?? ''));
    try { accessService().cleanupTask(conversationGrantScope(conversationId)); } catch { /* 尽力而为 */ }
    if (!entry) return;
    subagents.clearHostedPermission(conversationId);
    retiring(entry.agent.close('reload').finally(() => entry.skills?.release()));
    agents.delete(String(conversationId ?? ''));
    log?.info?.(`[agent] ${conversationId} 档案被剪，主 agent 将按新档案重建`);
  }

  async function abort(conversationId, options) {
    if(!options?.preserveBackground)for(const [id,pending]of backgroundGoals)if(pending.ctx.conversationId===conversationId){
      backgroundGoals.delete(id);await journal.finishRoot(ownerOf(pending.ctx),'cancelled','用户停止后台工作');
    }
    const agent = get(conversationId);
    const entry = agents.get(conversationId);
    if (entry?.ctx) {
      entry.ctx.cancelled = true;
      entry.goalController?.abort();
      for (const job of auxiliaryJobs.values()) if (job.sourceRootRunId === entry.ctx.runId) job.controller.abort();
    }
    subagents.clearHostedPermission(conversationId);
    if (agent) await agent.abort(options);
    if(!options?.preserveBackground)await Promise.all(commandSessions(conversationId).filter(session=>session!==agent).map(session=>session.abort()));
  }

  async function requestHandoff(conversationId) {
    const entry=agents.get(conversationId),ctx=entry?.ctx,controller=entry?.goalController;
    // 目标检查登记的等待发生在 SDK prompt 外，插队也必须先取消这个事件等待。
    if(entry?.agent.isWaitingForBackground?.()) {ctx.cancelled=true;controller?.abort();}
    await entry?.agent.requestHandoff();
    if(ctx&&entry?.ctx===ctx){ctx.cancelled=true;controller?.abort();}
  }

  async function stopRoot(conversationId, runId, {reason = 'stop', inputs = []} = {}) {
    const entry = agents.get(conversationId);
    runId=await journal.rootForFlow(conversationId,runId);
    // A delayed stop cannot abort a newer root in the same conversation.
    if (entry?.activeRootRunId && entry.ctx.runId !== runId) throw new Error('当前运行已变化');
    const pending=backgroundGoals.get(runId);
    if(pending?.ctx.conversationId===conversationId){
      backgroundGoals.delete(runId);
      await journal.finishRoot(ownerOf(pending.ctx),'cancelled','用户停止后台目标');
      await Promise.all(commandSessions(conversationId).map(session=>session.abort({commandOwner:ownerOf(pending.ctx)})));
      await subagents.cancelByRootRun(runId,{reason});
      await entry?.agent.recordGoalStop({runId,reason,inputs});
      await persist(conversationId);
      return;
    }
    await Promise.all([
      !entry || entry.ctx.runId === runId ? abort(conversationId) : null,
      subagents.cancelByRootRun(runId, {reason}),
    ]);
    if (entry?.ctx.runId === runId) {
      await entry.agent.recordGoalStop({runId, reason, inputs});
      await persist(conversationId);
    }
  }

  function disposeAll() {
    shuttingDown=true;backgroundGoals.clear();
    for(const sessions of retainedCommandSessions.values())for(const session of sessions)session.dispose();
    retainedCommandSessions.clear();
    for (const [, entry] of agents) {
      entry.goalController?.abort();
      entry.agent.dispose();
      entry.skills?.release();
    }
    for (const job of auxiliaryJobs.values()) job.controller.abort();
    agents.clear();
    archiveWriters.clear();
    subagents.disposeAll();
  }

  let closePromise = null;
  function close() {
    closePromise ??= closeRuntime();
    return closePromise;
  }
  async function closeRuntime() {
    shuttingDown=true;
    try {
      // Initialization/recovery also writes the journal when no conversation ran.
      await journalReady;
      const stops=await Promise.allSettled([...agents].map(async ([id, entry]) => {
        await abort(id);
        if (entry.ctx?.runId) await subagents.cancelByRootRun(entry.ctx.runId, { reason: 'stop' });
      }));
      const closes=await Promise.allSettled([...agents.values()].map(entry => entry.agent.close('session-end')));
      const releases=await commandDeadline(Promise.allSettled([...workflowClosures].map(release=>release()).concat([...pendingClosures])),20000,'执行器退出未能确认');
      const failed=[...stops,...closes,...releases].find(result=>result.status==='rejected');
      if(failed)throw failed.reason;
      await commandDeadline(Promise.all([sessionStore.flush(),journal.flush()]),10000,'执行器退出记录保存未确认');
    } finally {journal.dispose();disposeAll();environment?.release();}
  }

  return { resumeBackground, backgroundContext, backgroundCommand, isBusy: () => workflowClosures.size > 0 || [...agents.values()].some(entry => entry.activeRootRunId || entry.agent.isBusy()) || [...subagents._internals.tasks.values()].some(task => task.phase !== 'terminal'), prepareExecution, auxiliarySession, usageRecordsFor, usageHistory, observeTransport, auxiliaryCall, obtain, runRootTurn, contextUsageFor, completeConversation, suspendWorkflow, journal, executionForConversation: (id, purpose, rootRunId) => { const ctx = agents.get(id)?.ctx; if (!ctx || ctx.runId !== rootRunId || ctx.cancelled) throw new DOMException('根目标已停止', 'AbortError'); return executionFor(ctx, ctx.modelPlan, purpose); }, get, persist, invalidate, abort, stopRoot, requestHandoff, disposeAll, close, subagents, roles, openWorkflowNode };
}
