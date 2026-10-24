import { sessionModelOptions } from '../agent/session-model-options.mjs';
import { usageRecordsFromJournal } from './usage-ledger.mjs';
import { currentExecutionScope } from './execution-scope.mjs';
import { recoverOwnedProcesses } from './owned-processes.mjs';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRunJournal, dispatchIdentity } from '../agent-runtime/run-journal.mjs';
import { formatSubagentResult } from '../agent/agent-tools.mjs';
import { createContextStore } from './context-store.mjs';
import { createConversationHistoryReader } from './conversation-history.mjs';
import { budgetSummaryFacts } from './budget-summary.mjs';
import { sessionCompatibility } from './model-policy.mjs';
import { sessionLoadoutRevision, roleSessionRevision } from './session-revision.mjs';
import { createSessionStore } from './session-store.mjs';

import { createMainAgent, buildAgentAppendSystem, entriesFromTurns } from '../agent/main-agent.mjs';
import { createHemiSession } from '../agent/hemi-session.mjs';
import { createSubagentManager } from '../agent/subagents.mjs';
import { loadRoles, buildRoutingSection, ROLE_NAMES } from '../agent/agent-roles.mjs';
import { discoverProjectSkills } from '../skills/project-skills.mjs';
import { resolveRoleModel } from '../lib/role-models.mjs';
import { describeModelError } from '../lib/model-routing.mjs';
import { freezeModelPolicy, resolveModelPlan, hydrateModelPlan } from '../agent-runtime/model-policy.mjs';
import { MEMORY_TOOL_GUIDELINES } from '../services/memory.mjs';
import { buildWorkspaceContextBlock } from '../workspace/context.mjs';
import { hydrateWorkflowModel } from '../workflows/workflow-model-plan.mjs';
import { createWorkflowNodeAgent } from '../agent/workflow-node-agent.mjs';

/**
 * 056 · 主 agent 与子 agent 的运行时装配（取代 055 的 brain-registry 与 task.ipc 的执行器工厂）。
 *
 * 职责：
 *   - 每对话一个主 agent（LRU 驻留，条目随 Hemi 会话档案走：agentSession 字段）；
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
 * @param {() => object} deps.getMemoryService
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
  getSkillService = () => null,
  getMemoryService = () => null,
  getWorkspaceService = () => null,
  getWorkflowService = null,
  history,
  onModelUsage = null,
  isOnline = () => true,
  scheduleExtraction = null,
  onTaskState,
  onDeliveryDeclared = null,
  log,
}) {
  if (!userDataDir || !getProfiles || !resolveCapabilities || !getAccessService) throw new Error('执行运行时缺少宿主依赖');
  const agentDir = path.join(userDataDir, 'pi-agent');
  try { mkdirSync(agentDir, { recursive: true }); } catch { /* inMemory 会话仍可跑 */ }
  const journal = createRunJournal({ dir: path.join(userDataDir, 'runtime-v2') });
  const sessionStore = createSessionStore({ dir: path.join(userDataDir, 'runtime-v2/sessions') });
  const contextStore = createContextStore({ dir: path.join(userDataDir, 'runtime-v2/contexts') });
  const conversationHistory = loadArchiveSession ? createConversationHistoryReader({ loadSession: loadArchiveSession, contextStore }) : null;
  const journalReady = journal.ready().then(() => recoverOwnedProcesses(journal)).then(() => journal.recover());
  void journalReady.catch(error => log?.error?.(error.message));
  const dispatchInFlight = new Map();
  const ownerOf = ctx => ({ conversationId: ctx.conversationId, rootRunId: ctx.runId, generation: ctx.generation ?? 0 });
  const executionFor = (ctx, plan, purpose = 'main') => ({ isOnline, journal, contextStore, store: getProfiles(ctx), owner: ownerOf(ctx), plan,
    validateConversationSource: source => conversationHistory?.validateSource(source) ?? false,
    budgets: ctx.policySnapshot.budgets, sessionRef: ctx.sessionRef, purpose, onRequestRecorded: () => onModelUsage?.({ conversationId: ctx.conversationId }), allowedRefs: null, cancelled: () => Boolean(ctx.cancelled),
    persistSession: async (payload, execution) => {
      const ref = execution.sessionRef ?? `main-${safeDirName(ctx.conversationId)}`;
      const publicCandidate = candidate => { const { apiKey, ...rest } = candidate; return rest; };
      await sessionStore.save(ref, { owner: execution.owner, role: execution.plan.role, workspace: ctx.workspace,
        sessionRef: execution.sessionRef ?? ref, worklineId: execution.worklineId ?? null, roleRevision: execution.roleRevision ?? null, runCount: execution.runCount ?? null, contextRefs: execution.allowedRefs ?? null,
        modelPlan: { ...execution.plan, primary: publicCandidate(execution.plan.primary), allowedFallbacks: execution.plan.allowedFallbacks.map(publicCandidate) }, payload });
      if (purpose === 'main' && agents.get(ctx.conversationId)?.ctx === ctx) await persist(ctx.conversationId);
    },
  });

  // 标题／记忆是无副作用辅助作业，与业务目标分别收口，实际请求仍归属原目标的额度和费用。
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
    const ctx = { conversationId, runId: `aux-${randomUUID()}`, policySnapshot: plan.policySnapshot, modelPlan: plan.modelPlan, workspace: null, cancelled: false };
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
    try { return await sessionLoadoutRevision({caps, placement, skills: skills.items, agentDir, memoryEnabled: Boolean(getMemoryService())}); }
    finally { skills.release(); }
  }

  async function createRoleSession({ role, conversationId, accessId, workspace, inputSource, modelPlan, entries = null }) {
    const caps = await resolveCapabilities();
    const placement = await resolvePlacement(workspace, { log });
    const skills = collectSkills({ skillService: getSkillService(), workspace });
    const memory = getMemoryService();
    try {
      if (modelPlan.loadoutRevision && modelPlan.loadoutRevision !== await sessionLoadoutRevision({caps, placement, skills: skills.items, agentDir, memoryEnabled: Boolean(memory)})) throw new Error('工具、技能或项目规范已变化，请重新派单');
    } catch (error) { skills.release(); throw error; }
    const modelOptions = sessionModelOptions({ config: modelPlan.config, fallback: modelPlan.fallback, fallbacks: modelPlan.allowedFallbacks, visionOn: false, vision: caps.vision });
    const session = createHemiSession({
      ...sessionOptions,
      ...placement,
      agentDir, entries,
      ...modelOptions,
      // 只读角色（explorer/oracle）走 052 只读边界，不走 055 的 verify 阶段：verify 对未授权
      // 路径一律自动拒绝、不弹卡（那是「复核已授权产物」的语义）；侦察是一等调查者，读新
      // 路径要能请求授权。只读边界照样硬拒写文件、写类命令与界面动作。
      mode: 'run',
      ...(role.mode === 'verify' ? { boundary: 'readonly' } : {}),
      tools: roleTools(role.tools),
      executionContext: modelPlan.executionContext,
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
      memoryClient: memory ? memory.bindTaskClient({ workspaceId: workspace?.id ?? null, mode: role.mode }) : null,
      skills: skills.items,
      accessId,
      interactiveOwner: modelPlan.interactiveOwner,
      grantScopeId: conversationId ? conversationGrantScope(conversationId) : null,
      accessService: accessService(),
      label: `${role.name} ${accessId}`,
      log,
    });
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
      const session = await createRoleSession({ role, conversationId, accessId: sessionId, workspace, inputSource, modelPlan, entries: [record.payload.header, ...record.payload.entries] });
      return { role, conversationId, workspace, modelPlan, generation: record.owner.generation ?? 0, phase: 'terminal', finalized: true, session, historyId: record.owner.taskId, sessionRef: sessionId, worklineId: record.worklineId, contextRefs: record.contextRefs ?? [], runs: record.runCount ?? 1 };
    },
    history,
    onModelUsage,
    scheduleExtraction,
    cleanupAccessTask: (taskId) => accessService().cleanupTask(taskId),
    onSettled: async (task, result) => {
      result.reportRef = await contextStore.put({ owner: { conversationId: task.conversationId, rootRunId: task.rootRunId, taskId: result.taskId, generation: task.generation ?? 0 }, kind: 'report', content: [{ type: 'text', text: [task.resultText, result.outcomeReason ? `［宿主错误详情］\n${result.outcomeReason}` : null].filter(Boolean).join('\n\n') }], source: { kind: 'tool', tool: 'task' } });
      task.reportRef = result.reportRef;
      await task.session?.persistExecution?.();
      await journal.completeTask({ dispatchKey: task.dispatchKey, owner: { conversationId: task.conversationId, rootRunId: task.rootRunId, generation: task.generation ?? 0, taskId: result.taskId }, result, background: task.background && !task.stopRequested });
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
    const memory = getMemoryService();
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
      memoryToolGuidelines: memory ? MEMORY_TOOL_GUIDELINES : '',
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
    let entries = null;
    if (existing) {
      if (existing.agent.isDisposed()) log?.info?.(`[agent] ${conversationId} 旧实例已释放，保留条目重建主会话`);
      const exported = await existing.agent.exportEntries();
      entries = exported ? [exported.header, ...exported.entries] : null;
      existing.agent.dispose();
      existing.skills?.release();
      agents.delete(conversationId);
    } else {
      const archived = loadArchiveAgent(conversationId);
      if (archived?.entries?.length) {
        entries = [archived.header, ...archived.entries];
      } else {
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
      readMemoryView: memory ? () => memory.buildView({ workspaceId: entry.ctx?.workspace?.id ?? null }) : null,
      toolDeps: toolDepsFor(conversationId, entry, available),
      sessionOptions: {
        ...sessionOptions,
        ...placement,
        agentDir,
        ...modelOptions,
        executionContext: executionFor(turn, turn.modelPlan),
        mode: 'run',
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
          role, prompt, description, background, sessionId, signal, toolCallId, dispatchKey, generation: owner.generation,
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
      memoryWrite: getMemoryService()
        ? async (args, signal) => entry.ctx?.memoryWrite?.(args, signal) ?? { ok: false, error: '记忆服务不可用' }
        : null,
      runtimeDiagnostics: () => entry.ctx?.runtimeDiagnostics?.() ?? { ok: false },
    };
  }

  function evictLRU(keep) {
    if (agents.size <= MAX_RESIDENT) return;
    const candidates = [...agents.entries()]
      .filter(([id, entry]) => id !== keep && !entry.activeRootRunId && !entry.agent?.isBusy())
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [id, entry] of candidates) {
      if (agents.size <= MAX_RESIDENT) break;
      void entry.agent.exportEntries().then((payload) => {
        if (payload && archiveWriters.get(id) === entry.archiveToken) saveArchiveAgent(id, payload);
      }).catch(() => {});
      entry.agent.dispose();
      entry.skills?.release();
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
        ...placement, agentDir,
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
      if(event.kind==='tool-end'&&!event.isError&&event.actionState!=='not-executed')usedTools.add(event.tool);
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
    catch (error) { main.dispose(); throw error; }
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
    }, abort, dispose: () => main.dispose(), isBusy: () => main.isBusy(), requestHandoff: () => main.requestHandoff() };
    return {
      agent: createWorkflowNodeAgent({ session, nodeSpec, executionOwner, log }),
      release: async () => { try { await abort(); await Promise.all(usageWrites); } finally {
        for(const task of subagents._internals.tasks.values())if(task.rootRunId===executionOwner.workflowRunId&&task.phase==='terminal') {try{task.session?.dispose();}catch(error){log?.warn?.(`释放工作流子会话失败：${error.message}`);}finally{task.session=null;}}
        main.dispose();
      } },
    };
  }

  async function prepareExecution(ctx) {
    await journalReady;await journal.beginRoot(ownerOf(ctx), {policySnapshot:ctx.policySnapshot,workspace:ctx.workspace});
    return executionFor(ctx,ctx.modelPlan,'input-preparation');
  }
  async function runRootTurn(conversationId, args) {
    return runOwnedTurn(agents.get(conversationId), args);
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
      while (!ctx.cancelled && !combined.aborted) {
        const owned = [...subagents._internals.tasks.values()].filter(task => task.rootRunId === owner.rootRunId);
        await Promise.all(owned.filter(task => !task.finalized).map(task => task.running ?? task.terminalWait));
        if (ctx.cancelled) break;
        if ((await journal.root(owner))?.requestLimitReached) throw new Error('执行请求已达上限');
        const events = await journal.pending(owner);
        if (!events.length) break;
        const content = ['［子任务完成 · 宿主观察，不是用户新指令］', ...events.map(event => formatSubagentResult(event.result))].join('\n\n');
        append(await agent.consumeEvents(events, content));
        if (combined.modelError) throw new Error(`回合未完成：${describeModelError(combined.modelError)}`);
        if (combined.aborted || ctx.cancelled) break;
        const exported = await agent.exportEntries();
        await agent.exportEntries().then(payload => executionFor(ctx,ctx.modelPlan).persistSession(payload, { ...executionFor(ctx,ctx.modelPlan), sessionRef: ctx.sessionRef }));
        await journal.consume(events.map(event => event.eventId), exported?.entries?.findLast(item => item.type === 'custom_message' && item.details?.eventIds?.some(id => events.some(event => event.eventId === id)))?.id ?? exported?.entries?.at(-1)?.id ?? 'unknown');
      }
      if (combined.aborted || ctx.cancelled) await subagents.cancelByRootRun(owner.rootRunId, { reason: 'stop' });
      return { ...combined, aborted: combined.aborted || Boolean(ctx.cancelled) };
    } catch (error) {
      const limited = (await journal.root(owner))?.requestLimitReached;
      if (limited && !ctx.cancelled && !combined.aborted) {
        try {
          // 仅等待已经受理的工作，工具继续沿用原超时；触顶账本拒绝新请求／工具／派单。
          const owned = [...subagents._internals.tasks.values()].filter(task => task.rootRunId === owner.rootRunId);
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
          await execution.persistSession(await agent.exportEntries(), execution);
          return { ...combined, modelError: null, aborted: false, budgetLimited: true, lastText: report.text, texts: [...combined.texts, report.text] };
        } catch (summaryError) { error = summaryError; }
      }
      ctx.cancelled = true;
      try { await Promise.all([agent.abort(), subagents.cancelByRootRun(owner.rootRunId, { reason: 'stop' })]); }
      catch (cleanupError) { cleanupError.pendingStop = true; throw cleanupError; }
      throw error;
    } finally { if (entry.activeRootRunId === owner.rootRunId) entry.activeRootRunId = null; }
  }

  async function completeConversation(conversationId, status, reason = null, rootRunId = null) {
    if (!rootRunId) throw new Error('收口缺少根目标身份');
    await journalReady;
    const normalized = status === 'stopped' ? 'cancelled' : status;
    const state = await journal.snapshot();
    for (const root of Object.values(state.roots)) if (root.owner.conversationId === conversationId && root.owner.rootRunId === rootRunId && ['running','waiting','stopping'].includes(root.status)) await journal.finishRoot(root.owner, normalized, reason);
    const entry = agents.get(conversationId);
    if (entry?.activeRootRunId === rootRunId) entry.activeRootRunId = null;
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

  function get(conversationId) {
    const entry = agents.get(String(conversationId ?? ''));
    if (!entry) return null;
    entry.lastUsedAt = Date.now();
    return entry.agent;
  }

  async function persist(conversationId) {
    const entry = agents.get(String(conversationId ?? ''));
    if (!entry) return false;
    const payload = await entry.agent.exportEntries();
    return payload && agents.get(String(conversationId)) === entry && archiveWriters.get(String(conversationId)) === entry.archiveToken
      ? saveArchiveAgent(String(conversationId), payload) : false;
  }

  /**
   * 024 回卷／会话删除：档案被剪，条目作废——下次 obtain 从（已剪）档案重建；该对话的子 agent
   * 一并停掉，对话级临时授权清掉（LRU 驱逐不清：对话仍在，回来时授权照旧有效；进程退出时
   * 内存授权随之消失）。
   */
  function invalidate(conversationId) {
    archiveWriters.delete(String(conversationId ?? ''));
    const entry = agents.get(String(conversationId ?? ''));
    subagents.disposeConversation(String(conversationId ?? ''));
    try { accessService().cleanupTask(conversationGrantScope(conversationId)); } catch { /* 尽力而为 */ }
    if (!entry) return;
    subagents.clearHostedPermission(conversationId);
    entry.agent.dispose();
    entry.skills?.release();
    agents.delete(String(conversationId ?? ''));
    log?.info?.(`[agent] ${conversationId} 档案被剪，主 agent 将按新档案重建`);
  }

  async function abort(conversationId) {
    const agent = get(conversationId);
    const entry = agents.get(conversationId);
    if (entry?.ctx) {
      entry.ctx.cancelled = true;
      for (const job of auxiliaryJobs.values()) if (job.sourceRootRunId === entry.ctx.runId) job.controller.abort();
    }
    subagents.clearHostedPermission(conversationId);
    if (agent) await agent.abort();
  }

  async function requestHandoff(conversationId) {
    await get(conversationId)?.requestHandoff();
  }

  async function stopRoot(conversationId, runId, {reason = 'stop', inputs = []} = {}) {
    const entry = agents.get(conversationId);
    // A delayed stop cannot abort a newer root in the same conversation.
    if (entry?.activeRootRunId && entry.ctx.runId !== runId) throw new Error('当前运行已变化');
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
    for (const [, entry] of agents) {
      entry.agent.dispose();
      entry.skills?.release();
    }
    for (const job of auxiliaryJobs.values()) job.controller.abort();
    agents.clear();
    archiveWriters.clear();
    subagents.disposeAll();
  }

  async function close() {
    // Initialization/recovery also writes the journal when no conversation ran.
    await journalReady;
    disposeAll();
    await journal.flush();
  }

  return { prepareExecution, auxiliarySession, usageRecordsFor, observeTransport, auxiliaryCall, obtain, runRootTurn, contextUsageFor, completeConversation, suspendWorkflow, journal, executionForConversation: (id, purpose, rootRunId) => { const ctx = agents.get(id)?.ctx; if (!ctx || ctx.runId !== rootRunId || ctx.cancelled) throw new DOMException('根目标已停止', 'AbortError'); return executionFor(ctx, ctx.modelPlan, purpose); }, get, persist, invalidate, abort, stopRoot, requestHandoff, disposeAll, close, subagents, roles, openWorkflowNode };
}
