import { createJournalStorage } from './journal-storage.mjs';
import { createJournalDraft, editJournalRecord as edit, applyJournalChanges, JOURNAL_TABLES } from './journal-draft.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readTaskHandoff } from '../../shared/task-handoff.mjs';
import { createPersistenceRetry } from '../lib/persistence-retry.mjs';

const terminal = new Set(['completed','partial','failed','blocked','cancelled','interrupted','continued']);
const suspended = root => ['awaiting_user','waiting_background'].includes(root?.status) || (root?.kind === 'workflow' && root.status === 'waiting');
const owns = (root, owner) => root && root.owner.conversationId === owner.conversationId && root.owner.rootRunId === owner.rootRunId && root.owner.generation === owner.generation;
const initial = () => ({ version: 2, roots: {}, dispatches: {}, tasks: {}, inbox: {}, requests: {}, observations: {}, processes: {} });
// 受理序在 root 记录内持久递增：跨重启/跨存储读取顺序稳定的链排序依据。
const nextAdmissionSeq = s => Object.values(s.roots).reduce((max, root) => Math.max(max, root.admissionSeq ?? 0), 0) + 1;
export const BUDGET_SUMMARY_PURPOSE = 'budget-summary';
export const GOAL_VERIFICATION_PURPOSE = 'goal-verification';
const sourceRoot = (s, owner) => {
  const root = s.roots[owner.rootRunId];
  return s.roots[root?.sourceRootRunId ?? owner.rootRunId];
};
const goalIdentity = root => root?.goal?.id ?? root?.owner.rootRunId;
const goalRequests = (s, root) => Object.values(s.requests).filter(item => !item.preflight && ![BUDGET_SUMMARY_PURPOSE,GOAL_VERIFICATION_PURPOSE].includes(item.purpose)
  && goalIdentity(sourceRoot(s,item.owner)) === goalIdentity(root)).length;
// One model call may need several control-plane HTTP requests before inference.
// Keep the call reserved across preflights; a second inference or caller is denied.
const singleModelCallAvailable = (previous, request) => previous.every(item => item.preflight === true
  && typeof request.logicalCallId === 'string' && request.logicalCallId && item.logicalCallId === request.logicalCallId);
const assertExecuting = (s, owner) => {
  // 057 软复盘后 requestLimitReached 只代表硬预算收口（goal 总额或无 goal 的 per-run 上限），
  // 不再用于每段边界；段边界由根调度在回合边界主动 checkpoint（agent-task-lifecycle R-02/R-07）。
  if (sourceRoot(s, owner)?.requestLimitReached) throw new Error('执行请求已达上限，不能开始新动作');
};
const processPending = item => !item.cleanupConfirmed || item.state !== 'finished';
const pendingGoalWork = (s, owner) => {
  const belongs = item => item.owner.rootRunId === owner.rootRunId;
  return {
    requests: Object.values(s.requests).filter(item => belongs(item) && !item.endedAt).map(item => item.requestId),
    tools: Object.values(s.observations).filter(item => belongs(item) && item.phase !== 'finished').map(item => item.id),
    processes: Object.values(s.processes).filter(item => belongs(item) && processPending(item))
      .map(item => ({id:item.id, description:item.description, state:item.state, background:Boolean(item.background)})),
    tasks: Object.values(s.dispatches).filter(item => belongs(item) && item.state !== 'terminal').map(item => item.taskId),
    reports: Object.values(s.inbox).filter(item => belongs(item) && item.state === 'pending').map(item => item.eventId),
  };
};
const hasPendingWork = work => Object.values(work).some(items => items.length);
const hasUnconfirmedWork = work => hasPendingWork({...work,processes:work.processes.filter(p=>!(p.background&&p.state==='active'))});
function advanceGoalRound(s, root) {
  const goal = root.goal, used = goalRequests(s, root);
  if (goal.round >= goal.policy.maxRounds || used >= goal.policy.maxRequests) throw Object.assign(new Error('目标总预算已达到，工作尚未完成'), {code:'goal-budget-limit'});
  goal.round++; goal.requestOffset = used;
  // 057 软复盘：段交接完成，未决复盘提示随段清零。
  delete root.reviewPending;
  if (root.requestLimitReached) { (goal.limitHistory ??= []).push(root.requestLimitReached); delete root.requestLimitReached; }
  return goal;
}
// 目标恢复（goal-resume）只认被用户停止/失败/中断的终态：blocked/budget_limited 的收口
// 是宿主裁决不可自行推翻，continued 已被新 root 接续；恢复=新建 root 接续，不复活旧 root
// （terminal 集合保持终态正是防迟到续跑的栅栏）。workflow root 不参与恢复。
const RESUMABLE_STATUSES = ['cancelled','failed','partial','interrupted'];
const resumableRoot = root => root.kind !== 'workflow' && root.goal && RESUMABLE_STATUSES.includes(root.status) && root.goal.phase !== 'complete';
// 同链内挑最近可恢复 root：terminalAt 优先（root 无 startedAt 字段，兜底 createdAt）；
// 同 terminalAt（如 recover 同批中断）取后写入者，不依赖排序稳定性。
const latestRoot = roots => roots.reduce((best, root) => {
  if (!best) return root;
  const rank = item => item.terminalAt ?? item.createdAt ?? 0;
  return rank(root) >= rank(best) ? root : best;
}, null) ?? null;
// 恢复资格只属最近受理的独立主目标链：链＝同一 goal.id 的 root 序列，恢复回合、
// awaiting_user 续答、后台接续都不换 id，也不把老链重新变成「最近受理」。受理顺序
// 用持久在 root 记录内的 admissionSeq（beginRoot/resumeGoal 建根事务内递增，随
// 账本落盘；同毫秒时钟与存储读取顺序都不影响）；旧账本无 seq 的 root 按 createdAt、
// 再按写入序（历史同毫秒 ties 无可恢复证据，仅新受理有持久序）。不按 terminalAt
// ——老链晚终止/晚收口不能压过更新的独立链。辅助与 workflow root 不构成独立链，
// 也不抢主会话候选（latestRoot 仅在同链内使用）。
const mainRoot = root => root.kind !== 'workflow' && root.kind !== 'auxiliary';
const admittedAfter = (root, head) => {
  if ((root.admissionSeq ?? 0) !== (head.admissionSeq ?? 0)) return (root.admissionSeq ?? 0) > (head.admissionSeq ?? 0);
  return (root.createdAt ?? 0) >= (head.createdAt ?? 0);
};
/** 最近受理的独立主 root：链头（goal.id＝自身 rootRunId）优先代表链；已受理但
 *  尚未挂 goal 的准备中新回合同样占位（core.prepareExecution 先建 root 后由
 *  driveGoal 挂 goal，中间可失败——无 goal 的独立受理也要遮断历史链，旧停止目标
 *  不得在新回合准备中/准备失败后复活）。已带 goal 的同链后继（恢复/awaiting_user
 *  续答/后台接续新建的 root，goal.id 指向旧链头）跳过：链的受理优先级由链头决
 *  定，后继不刷新——老版账本里迟到的恢复/续接后继（admissionSeq 更高）不能把旧
 *  链顶回最新独立链之前。conversationId 过滤会话归属；except 排除当前事务正在
 *  建立的续接/恢复 root（它属于原链，不是更新的独立受理）。 */
function latestMainRoot(roots, {conversationId = null, exceptRootRunId = null} = {}) {
  let head = null;
  for (const root of roots) {
    if (!mainRoot(root)) continue;
    if (conversationId !== null && root.owner.conversationId !== conversationId) continue;
    if (exceptRootRunId !== null && root.owner.rootRunId === exceptRootRunId) continue;
    if (root.goal && root.goal.id !== root.owner.rootRunId) continue;
    if (!head || admittedAfter(root, head)) head = root;
  }
  return head;
}
/** 最近受理链的稳定身份直接用 goalIdentity：链头带 goal 用 goal.id；准备中的
 *  无 goal root 退回自身 rootRunId 占位（仅用于遮断/幂等判断，不产生可恢复摘要）。 */
const lastGoalVerdict = goal => [...(goal.verifications ?? [])].reverse().find(item => item.remaining?.length || item.nextAction) ?? null;
const goalSummaryOf = (root, extra = {}) => {
  const last = lastGoalVerdict(root.goal);
  return {goalId: goalIdentity(root), objective: root.goal.objective, phase: root.goal.phase, round: root.goal.round,
    status: root.status, sourceRootRunId: root.owner.rootRunId, nextAction: last?.nextAction ?? null,
    remaining: last?.remaining ?? [], reason: root.reason ?? null, ...extra};
};
export const dispatchIdentity = ({ conversationId, rootRunId, generation = 0, sessionId, callAnchorId, toolCallId }) => {
  if (![conversationId,rootRunId,sessionId,callAnchorId,toolCallId].every(x => typeof x === 'string' && x)) throw new Error('派单缺少可信调用身份');
  return createHash('sha256').update(JSON.stringify([conversationId,rootRunId,generation,sessionId,callAnchorId,toolCallId])).digest('hex');
};

/** 同一原子提交保存终态与 outbox；磁盘损坏绝不按空状态继续。 */
export function createRunJournal({ dir, storage = createJournalStorage(dir) }) {
  let state, tail = Promise.resolve(), pendingWrite = false;
  let retainedChanges = {};
  const retry = createPersistenceRetry(() => transaction(() => undefined));
  const watchers = new Set();
  const ready = storage.load().then(value => { state = value; });
  const transaction = (operation, { retainOnFailure = false } = {}) => {
    const run = tail.then(async () => {
      await ready;
      const { draft, changes } = createJournalDraft(state);
      const result = operation(draft);
      const commit = {};
      for (const table of JOURNAL_TABLES) if (retainedChanges[table] || changes[table]) commit[table] = { ...retainedChanges[table], ...changes[table] };
      try {
        if (Object.keys(commit).length) await storage.commit(commit);
      } catch (error) {
        // Confirmed endings fence new execution even when persistence fails.
        // Failed admissions never enter memory or the retry queue.
        if (retainOnFailure) {
          applyJournalChanges(state, changes); retainedChanges = commit; pendingWrite = true;
          for (const watch of watchers) watch();
        }
        if (pendingWrite) retry.schedule();
        throw error;
      }
      applyJournalChanges(state, changes); retainedChanges = {}; pendingWrite = false; retry.reset();
      for (const watch of watchers) watch();
      return structuredClone(result);
    });
    tail = run.catch(() => {}); return run;
  };
  const read = async fn => { await ready; await tail; return structuredClone(fn(state)); };
  return {
    ready: () => ready,
    snapshot: (options) => read(s => {
      if (!options) return s;
      const selected = initial();
      for (const table of options.tables ?? JOURNAL_TABLES) {
        if (!JOURNAL_TABLES.includes(table)) throw new Error('运行事实库查询表无效');
        selected[table] = Object.fromEntries(Object.entries(s[table]).filter(([id, row]) =>
          (!options.ids || options.ids.includes(id)) && (!options.conversationId || row.owner?.conversationId === options.conversationId)
          && (!options.rootRunId || row.owner?.rootRunId === options.rootRunId)));
      }
      return selected;
    }),
    project: projector => read(projector),
    root: owner => read(s => s.roots[owner.rootRunId] ?? null),
    /** 057 根调度等待后代必要工作：等 rootRunId+generation 树内全部进程到达终态且清理确认（R-04）。 */
    async waitForProcesses(owner, {signal} = {}) {
      await ready;
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const dispose = () => { watchers.delete(check); signal?.removeEventListener('abort', abort); };
        const abort = () => { dispose(); reject(signal.reason ?? new DOMException('等待已取消','AbortError')); };
        const pendingNow = () => Object.values(state.processes).filter(item => item.owner.rootRunId === owner.rootRunId && item.owner.generation === owner.generation
          && processPending(item));
        const check = () => {
          if (!owns(state.roots[owner.rootRunId], owner)) {dispose(); reject(new Error('执行归属已失效')); return;}
          if (!pendingNow().length) {dispose(); resolve(true);}
        };
        signal?.addEventListener('abort', abort, {once:true});
        check();
      });
    },
    /** 目标只等待实际依赖的后台命令；退出事实写入时唤醒，不轮询或消费输出。 */
    async waitForProcessUpdate(owner, ids, {signal} = {}) {
      await ready;await tail;signal?.throwIfAborted();
      if (!Array.isArray(ids) || !ids.length || ids.some(id => {
        const p=state.processes[id];return !p?.background || p.owner.conversationId!==owner.conversationId || owner.taskId;
      })) throw new Error('等待的后台命令不存在或不属于当前目标');
      return new Promise((resolve,reject)=>{
        const dispose=()=>{watchers.delete(check);signal?.removeEventListener('abort',abort);};
        const abort=()=>{dispose();reject(signal?.reason??new DOMException('等待已取消','AbortError'));};
        const check=()=>{
          const root=state.roots[owner.rootRunId];
          if (!owns(root,owner)||terminal.has(root.status)) {abort();return;}
          const jobs=ids.map(id=>state.processes[id]);
          if(jobs.some(p=>p.state!=='active')) {dispose();resolve({kind:'settled'});}
        };
        watchers.add(check);signal?.addEventListener('abort',abort,{once:true});check();
      });
    },
    // Event-driven budget fence. Abandoning a wait removes its listener; it never consumes work/results.
    async waitForRequestLimit(owner, {signal, cleared = false} = {}) {
      await ready;
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const dispose = () => { watchers.delete(check); signal?.removeEventListener('abort', abort); };
        const abort = () => { dispose(); reject(signal.reason ?? new DOMException('等待已取消','AbortError')); };
        const check = () => {
          if (!owns(state.roots[owner.rootRunId], owner)) {dispose(); reject(new Error('执行归属已失效')); return;}
          const root = sourceRoot(state, owner);
          if (!root || terminal.has(root.status) || root.goal?.phase !== 'active' || Boolean(root.requestLimitReached) !== cleared) {
            dispose(); resolve(structuredClone(root));
          }
        };
        watchers.add(check); signal?.addEventListener('abort', abort, {once:true}); check();
      });
    },
    beginRoot: (owner, facts = {}) => transaction(s => {
      const old = edit(s, 'roots', owner.rootRunId);
      if (old) {
        if (JSON.stringify(old.owner) !== JSON.stringify(owner) || terminal.has(old.status)) throw new Error('根目标已失效或终结，不得重新执行');
        if (old.status === 'awaiting_user') throw new Error('目标正在等待用户答复，不能自行恢复');
        if (old.status === 'waiting_background') throw new Error('后台目标只能由所属结果事件恢复');
      }
      const busy = Object.values(s.roots).find(r => r.owner.rootRunId !== owner.rootRunId && r.owner.conversationId === owner.conversationId && r.kind !== 'auxiliary' && !terminal.has(r.status) && !suspended(r));
      if (busy && (old?.kind ?? facts.kind) !== 'auxiliary') throw new Error('该对话已有执行中的根目标');
      if (old) {
        if (suspended(old)) old.status = 'running';
        return old;
      }
      return s.roots[owner.rootRunId] = { owner, status: 'running', createdAt: Date.now(), admissionSeq: nextAdmissionSeq(s), ...facts };
    }),
    suspendRoot: owner => transaction(s => {
      const root = edit(s, 'roots', owner.rootRunId);
      if (!owns(root, owner) || terminal.has(root.status) || (root.kind && root.kind !== 'workflow')) throw new Error('工作流根目标已失效，不能挂起');
      root.kind = 'workflow';
      root.status = 'waiting';
      return root;
    }),
    suspendGoal: owner => transaction(s => {
      const root=edit(s, 'roots', owner.rootRunId);
      if(!owns(root,owner)||terminal.has(root.status)||root.goal?.phase!=='active'||hasUnconfirmedWork(pendingGoalWork(s,owner)))throw new Error('目标尚未到达后台交接边界');
      root.status='waiting_background';root.goal.phase='waiting_background';root.suspendedAt=Date.now();
      return root.goal;
    }),
    backgroundBudgetExhausted: owner => read(s=>{
      const root=s.roots[owner.rootRunId],goal=root?.goal;
      if(!owns(root,owner)||!goal)throw new Error('目标归属已失效');
      const used=goalRequests(s,root),cap=Math.min(goal.policy.maxRequestsPerRound,root.policySnapshot?.budgets?.maxRequestsPerRun??goal.policy.maxRequestsPerRound);
      return used>=goal.policy.maxRequests||(goal.round>=goal.policy.maxRounds&&used>=goal.requestOffset+cap);
    }),
    backgroundYieldReady: owner => read(s=>!hasUnconfirmedWork(pendingGoalWork(s,owner))),
    rootForFlow: (conversationId,runId) => read(s=>s.roots[runId]?.owner.conversationId===conversationId?runId:Object.values(s.roots).find(root=>root.owner.conversationId===conversationId&&root.eventRunIds?.includes(runId))?.owner.rootRunId??runId),
    /** 只读：最近受理独立主目标链的恢复摘要（goalId 必须命中该链才受理）；无候选返回 null。
     *  历史链已被更新的独立目标遮断（含准备中/准备失败的无 goal 新回合、老版账本的迟到
     *  同链后继）：默认与显式旧 goalId 都不提供恢复，不按用户文字猜任务。可选 generation：
     *  先选最近独立链再校验代际，跨代不显示也不回退历史同代链。同链 goal 已有非终态接续
     *  （执行中/等答复/等后台，含恢复/续接新建 root）时返回 alreadyActive 摘要，供受理层
     *  幂等返回「目标已在进行中」。 */
    findResumableGoal: (conversationId, {goalId, generation} = {}) => read(s => {
      const mine = Object.values(s.roots).filter(root => root.owner.conversationId === conversationId);
      const head = latestMainRoot(mine);
      if (!head) return null;
      if (generation != null && head.owner.generation !== generation) return null;
      const identity = goalIdentity(head);
      if (goalId && goalId !== identity) return null;
      const active = mine.find(root => !terminal.has(root.status) && goalIdentity(root) === identity);
      if (active) return {alreadyActive: true, goalId: identity, rootRunId: active.owner.rootRunId};
      const source = latestRoot(mine.filter(root => resumableRoot(root) && goalIdentity(root) === identity));
      if (!source) return null;
      const used = goalRequests(s, source);
      return goalSummaryOf(source, {unconfirmedWork: hasUnconfirmedWork(pendingGoalWork(s, source.owner)),
        budgetExhausted: source.goal.round >= source.goal.policy.maxRounds || used >= source.goal.policy.maxRequests});
    }),
    /** 用户显式恢复终态目标：新建 root 接续（goal.id 保持，goalRequests 按 identity 跨 root
     *  连续，累计预算不清零）；旧 root 标 continued，迟到续跑仍被终态栅栏挡住。
     *  只受理最近受理的独立主目标链：历史链被更新的独立目标（含无 goal 的准备中新
     *  回合）遮断后，默认与显式旧 goalId 一并拒绝——不按用户文字猜任务，也不因老链
     *  晚收口复活；来源 root 与恢复回合必须同会话 generation（回卷后的旧时间线不可
     *  跨代恢复）。 */
    resumeGoal: (owner, {goalId} = {}) => transaction(s => {
      const mine = Object.values(s.roots).filter(root => root.owner.conversationId === owner.conversationId);
      const head = latestMainRoot(mine);
      const identity = head ? goalIdentity(head) : null;
      if (!head || (goalId && goalId !== identity)) throw Object.assign(new Error('没有可恢复的目标'), {code:'goal-not-resumable'});
      // 同 goal 已有非终态接续（执行中/等答复/等后台，含此前恢复/续接新建的 root）：
      // 幂等拒绝并给出既有 root，重复点击无害。
      const active = mine.find(root => !terminal.has(root.status) && goalIdentity(root) === identity);
      if (active) throw Object.assign(new Error('目标已在进行中'), {code:'goal-already-active', rootRunId: active.owner.rootRunId});
      const source = latestRoot(mine.filter(root => resumableRoot(root) && goalIdentity(root) === identity));
      if (!source) throw Object.assign(new Error('没有可恢复的目标'), {code:'goal-not-resumable'});
      if (source.owner.generation !== owner.generation) throw Object.assign(new Error('会话已回卷，旧时间线的目标不能跨代恢复'), {code:'goal-generation-mismatch'});
      const busy = mine.find(root => root.owner.rootRunId !== owner.rootRunId && root.kind !== 'auxiliary' && !terminal.has(root.status) && !suspended(root));
      if (busy) throw Object.assign(new Error('该对话已有执行中的根目标'), {code:'busy'});
      if (hasUnconfirmedWork(pendingGoalWork(s, source.owner))) throw Object.assign(new Error('来源目标仍有未确认的收尾工作'), {code:'goal-unconfirmed-work'});
      const goal = source.goal, used = goalRequests(s, source);
      if (used >= goal.policy.maxRequests || goal.round >= goal.policy.maxRounds) throw Object.assign(new Error('目标总预算已达到，工作尚未完成'), {code:'goal-budget-limit'});
      if (s.roots[owner.rootRunId]) throw new Error('恢复回合的根目标已存在');
      // 形状沿用 beginGoal 的 awaiting_user 续接分支：恢复回合随后的 beginGoal 走 `root.goal ??=`
      // 幂等复用，不覆盖账本 goal。
      const cloned = {...structuredClone(goal), phase: 'active', round: goal.round + 1, requestOffset: used,
        budgetExhausted: false, continuedFrom: source.owner.rootRunId};
      delete cloned.waitingForUser;
      const sourceInfo = {rootRunId: source.owner.rootRunId, status: source.status, reason: source.reason ?? null};
      s.roots[owner.rootRunId] = {owner, status: 'running', createdAt: Date.now(), admissionSeq: nextAdmissionSeq(s),
        ...(source.policySnapshot ? {policySnapshot: structuredClone(source.policySnapshot)} : {}),
        ...(source.workspace ? {workspace: structuredClone(source.workspace)} : {}),
        goal: cloned};
      // 旧 root 标 continued 必须经 edit() 拷贝进变更集——draft 的行内 mutation 不落盘。
      const sourceEdit = edit(s, 'roots', source.owner.rootRunId);
      Object.assign(sourceEdit, {status: 'continued', continuedBy: owner.rootRunId, terminalAt: Date.now()});
      sourceEdit.goal.phase = 'continued';
      return {goal: cloned, source: sourceInfo};
    }),
    /** flow 快照的目标投影：活跃主目标优先（resumable=false）；否则仅当最近受理的
     *  独立主目标链存在可恢复 root 时给出 resumable 摘要——历史链被更新的独立
     *  目标（含普通问答）遮断后不再投影，防旧停止目标顶替恢复入口。辅助/workflow
     *  root 不参与投影；awaiting_user/后台等待链不产生恢复投影（走各自入口）。
     *  可选 generation：跨代活跃与恢复摘要都不投影，也不回退历史同代链。 */
    goalProjection: (conversationId, {generation} = {}) => read(s => {
      const mine = Object.values(s.roots).filter(root => root.owner.conversationId === conversationId && root.goal);
      const active = mine.find(root => root.kind !== 'workflow' && root.kind !== 'auxiliary' && !terminal.has(root.status) && !suspended(root)
        && (generation == null || root.owner.generation === generation));
      if (active) {
        const summary = goalSummaryOf(active);
        return {goal: {goalId: summary.goalId, objective: summary.objective, phase: summary.phase, round: summary.round,
          status: summary.status, nextAction: summary.nextAction, remaining: summary.remaining, resumable: false}};
      }
      const head = latestMainRoot(Object.values(s.roots).filter(root => root.owner.conversationId === conversationId));
      if (!head) return {goal: null};
      if (generation != null && head.owner.generation !== generation) return {goal: null};
      const source = latestRoot(mine.filter(root => resumableRoot(root) && goalIdentity(root) === goalIdentity(head)));
      if (!source) return {goal: null};
      const summary = goalSummaryOf(source);
      return {goal: {goalId: summary.goalId, objective: summary.objective, phase: summary.phase, round: summary.round,
        status: summary.status, nextAction: summary.nextAction, remaining: summary.remaining, resumable: true}};
    }),
    resumeBackgroundGoal: (owner,{flowRunId}={}) => transaction(s => {
      const root=edit(s, 'roots', owner.rootRunId);
      if(!owns(root,owner)||root.status!=='waiting_background'||root.goal?.phase!=='waiting_background')throw new Error('后台目标已停止或已恢复');
      if(hasUnconfirmedWork(pendingGoalWork(s,owner)))throw Object.assign(new Error('后台命令清理未确认，已阻止后续执行'),{code:'cleanup-unconfirmed'});
      root.status='running';root.goal.phase='active';
      if(flowRunId)(root.eventRunIds??=[]).push(flowRunId);
      return advanceGoalRound(s,root);
    }),
    beginGoal: (owner, objective, policy, continuation = null) => transaction(s => {
      const root = edit(s, 'roots', owner.rootRunId);
      if (!owns(root, owner) || terminal.has(root.status) || owner.taskId) throw new Error('目标归属已失效');
      if (!root.goal && continuation) {
        const previous = edit(s, 'roots', continuation.rootRunId);
        if (!previous || previous.owner.conversationId !== owner.conversationId || previous.owner.generation !== owner.generation
          || previous.status !== 'awaiting_user' || previous.goal?.phase !== 'awaiting_user' || !continuation.inputId || typeof continuation.answer !== 'string') throw new Error('等待答复的目标已变化，不能续接');
        // 迟到答复不得复活被更新独立目标遮断的旧链：等待中的链必须是本会话最近受理
        // 的独立主链（按会话过滤；当前正在建立的续接 root 除外——它属于等待链本链）。
        // 已受理但尚未挂 goal 的准备中新回合同样算更新受理（prepareExecution 先建
        // root 后挂 goal，准备失败也不留恢复窗口）。
        const latest = latestMainRoot(Object.values(s.roots), {conversationId: owner.conversationId, exceptRootRunId: owner.rootRunId});
        if (!latest || goalIdentity(previous) !== goalIdentity(latest)) throw new Error('等待答复的目标已变化，不能续接');
        const used = goalRequests(s,previous);
        const budgetExhausted=previous.goal.round >= previous.goal.policy.maxRounds || used >= previous.goal.policy.maxRequests;
        root.goal = {...structuredClone(previous.goal),id:goalIdentity(previous),phase:'active',round:previous.goal.round+1,requestOffset:used,budgetExhausted,
          replies:[...(previous.goal.replies ?? []),{inputId:continuation.inputId,text:continuation.answer,runId:owner.rootRunId}],continuedFrom:continuation.rootRunId};
        delete root.goal.waitingForUser;
        Object.assign(previous,{status:'continued',continuedBy:owner.rootRunId,terminalAt:Date.now()});
        previous.goal.phase='continued';
      }
      root.goal ??= { id:owner.rootRunId, objective, policy, phase: 'active', round: 1, requestOffset: 0, verifications: [], startedAt: Date.now() };
      return root.goal;
    }),
    checkGoal: owner => transaction(s => {
      const root = edit(s, 'roots', owner.rootRunId);
      if (!owns(root, owner) || terminal.has(root.status) || !root.goal || root.goal.phase !== 'active') throw new Error('目标不能校验');
      const work=pendingGoalWork(s, owner);
      // 正常后台进程交给目标检查判断依赖；在途前台动作和清理未知仍拒绝完成。
      if (hasUnconfirmedWork(work)) throw new Error('目标仍有未确认的执行，不能判定完成');
      root.goal.phase = 'checking';
      return root.goal;
    }),
    recordGoalCheck: (owner, verdict) => transaction(s => {
      const root = edit(s, 'roots', owner.rootRunId);
      if (!owns(root, owner) || terminal.has(root.status) || root.goal?.phase !== 'checking') throw new Error('目标校验已失效');
      root.goal.verifications.push({ ...verdict, round: root.goal.round, at: Date.now() });
      root.goal.phase = verdict.status === 'complete' ? 'complete' : verdict.status === 'blocked' ? 'blocked' : verdict.status === 'awaiting_user' ? 'awaiting_user' : 'active';
      if (verdict.status === 'awaiting_user') root.goal.waitingForUser={question:verdict.question,reason:verdict.reason,at:Date.now()};
      return root.goal;
    }),
    recordGoalVerificationAttempt: (owner, result) => transaction(s => {
      const root = edit(s, 'roots', owner.rootRunId);
      if (!owns(root, owner) || terminal.has(root.status) || root.goal?.phase !== 'checking') throw new Error('目标校验已失效');
      const requests = Object.values(s.requests).filter(item => item.owner.rootRunId === owner.rootRunId
        && item.purpose === GOAL_VERIFICATION_PURPOSE && item.goalRound === root.goal.round);
      const attempts = (root.goal.verificationAttempts ??= []);
      const calls = new Set(requests.map(item => item.logicalCallId ?? item.requestId));
      if (result.attempt !== calls.size || !requests.length || requests.some(item => !item.endedAt)
        || attempts.some(item => item.round === root.goal.round && item.attempt === result.attempt)) throw new Error('目标校验响应缺少已收口的请求');
      attempts.push({round:root.goal.round, attempt:result.attempt, valid:result.valid, errorCode:result.errorCode,bypassed:Boolean(result.bypassed),
        finishReason:result.finishReason, responseChars:result.responseChars, responseHash:result.responseHash, responseShape:result.responseShape, at:Date.now()});
    }),
    continueGoal: owner => transaction(s => {
      const root = edit(s, 'roots', owner.rootRunId), goal = root?.goal;
      if (!owns(root, owner) || terminal.has(root.status) || (goal?.phase !== 'active' || goal.verifications.at(-1)?.status !== 'continue' || goal.verifications.at(-1)?.round !== goal.round)) throw new Error('目标已停止或缺少续跑校验，不能续跑');
      return advanceGoalRound(s, root);
    }),
    // A segment handoff is not a completion verdict. Already accepted background work keeps its owner.
    checkpointGoal: (owner, {signal} = {}) => transaction(s => {
      signal?.throwIfAborted();
      const root = edit(s, 'roots', owner.rootRunId);
      if (!owns(root, owner) || owner.taskId || root.kind === 'auxiliary' || terminal.has(root.status)
        || root.goal?.phase !== 'active') throw new Error('目标已停止，不能交接');
      // 057 软复盘：交接依据从硬触顶标志改为「段预算已在回合边界耗尽」；硬预算路径由 advanceGoalRound 收口。
      const roundCap = Math.min(root.goal.policy.maxRequestsPerRound, root.policySnapshot?.budgets?.maxRequestsPerRun ?? root.goal.policy.maxRequestsPerRound);
      if (!root.requestLimitReached && goalRequests(s, root) < root.goal.requestOffset + roundCap) throw new Error('段预算尚未耗尽，不能交接');
      const work = pendingGoalWork(s, owner);
      if (!hasPendingWork(work)) return null;
      if (Object.values(s.requests).some(item => item.owner.rootRunId === owner.rootRunId && !item.owner.taskId && !item.endedAt)
        || Object.values(s.observations).some(item => item.owner.rootRunId === owner.rootRunId && !item.owner.taskId && item.phase !== 'finished')) throw new Error('主执行尚未到达安全交接边界');
      const round = root.goal.round;
      advanceGoalRound(s, root);
      (root.goal.checkpoints ??= []).push({round, at:Date.now(), work});
      return {goal:root.goal, work};
    }),
    endGoal: (owner, phase, reason) => transaction(s => {
      const root = edit(s, 'roots', owner.rootRunId);
      if (!owns(root, owner) || !root.goal) throw new Error('目标归属已失效');
      // A late verifier must never turn a cancelled/interrupted goal into success.
      if (root.goal.phase !== 'complete') Object.assign(root.goal, {phase, reason, endedAt: Date.now()});
      return root.goal;
    }),
    finishRoot: (owner, status, reason = null) => transaction(s => {
      if (!terminal.has(status) && !['awaiting_user','waiting_background'].includes(status)) throw new Error('根目标终态无效');
      const root = edit(s, 'roots', owner.rootRunId);
      if (!root || JSON.stringify(root.owner) !== JSON.stringify(owner)) throw new Error('根目标身份已失效');
      if (terminal.has(root.status)) return root;
      if(status==='waiting_background'){
        if(root.goal?.phase!=='waiting_background')throw new Error('缺少后台交接事实');
        return root;
      }
      if(status==='completed'&&root.goal?.phase==='complete'&&hasUnconfirmedWork(pendingGoalWork(s,owner)))throw new Error('目标收口时仍有未确认的执行结果');
      if (status === 'blocked' && (root.goal?.phase !== 'blocked' || root.goal.verifications.at(-1)?.status !== 'blocked')) throw new Error('缺少目标阻塞的校验事实');
      if (status === 'awaiting_user') {
        if (root.goal?.phase !== 'awaiting_user') throw new Error('缺少等待用户答复的校验事实');
        root.status='awaiting_user';root.suspendedAt=Date.now();return root;
      }
      if (status === 'completed' && ((root.requestLimitReached && !root.goal) || (root.goal && root.goal.phase !== 'complete'))) {
        status = 'partial'; reason ??= root.goal?.reason ?? '目标尚未通过完成校验';
      }
      if (root.goal && status !== 'completed' && !['blocked','budget_limited','no_progress','failed'].includes(root.goal.phase)) Object.assign(root.goal, {phase: status === 'cancelled' ? 'cancelled' : 'interrupted', reason});
      root.status = status; root.reason = reason ?? (status === 'blocked' ? root.goal.reason : null); root.terminalAt = Date.now();
      if (status !== 'completed') for (const [id, item] of Object.entries(s.inbox)) if (item.owner.rootRunId === owner.rootRunId && item.state !== 'consumed') edit(s, 'inbox', id).state = 'obsolete';
      return root;
    }, { retainOnFailure: true }),
    reserveDispatch: (key, facts) => transaction(s => {
      if (s.dispatches[key]) {
        if (!owns(s.dispatches[key], facts.owner)) throw new Error('派单身份不属于当前目标');
        return { existing: true, ...s.dispatches[key] };
      }
      const root = s.roots[facts.owner.rootRunId];
      if (!owns(root, facts.owner) || terminal.has(root.status) || suspended(root)) throw new Error('根目标已停止或挂起，不能派单');
      assertExecuting(s, facts.owner);
      // 持久任务身份在受理的同一事务分配；t1 等显示编号不能成为重启后的主键。
      const record = { ...facts, key, owner: facts.owner, taskId: `task-${randomUUID()}`, createdAt: Date.now(), state: 'reserved' };
      s.dispatches[key] = record; return { existing: false, ...record };
    }),
    recordReceipt: (key, receipt) => transaction(s => {
      const record = edit(s, 'dispatches', key); if (!record) throw new Error('派单锚点不存在');
      if (record.taskId && receipt.ok && receipt.taskId && receipt.taskId !== record.taskId) throw new Error('派单回执的任务身份不匹配');
      record.receipt = receipt; record.state = record.result || receipt.ok === false ? 'terminal' : 'accepted'; return record;
    }),
    completeTask: ({ dispatchKey, owner, result }) => transaction(s => {
      readTaskHandoff(result, owner);
      const key = result.taskId;
      if (!owns(s.roots[owner.rootRunId], owner)) throw new Error('子任务终态归属无效');
      if (dispatchKey && !owns(s.dispatches[dispatchKey], owner)) throw new Error('子任务派单归属无效');
      if (dispatchKey && s.dispatches[dispatchKey].taskId && (s.dispatches[dispatchKey].taskId !== key || owner.taskId !== key)) throw new Error('子任务终态的持久身份不匹配');
      if (s.tasks[key]) {
        if (!owns(s.tasks[key], owner) || s.tasks[key].owner.taskId !== owner.taskId) throw new Error('子任务身份已被其他目标占用');
        return s.tasks[key];
      }
      const record = { owner, result, terminalAt: Date.now() }; s.tasks[key] = record;
      if (dispatchKey && s.dispatches[dispatchKey]) Object.assign(edit(s, 'dispatches', dispatchKey), { result, state: 'terminal' });
      // 057 统一 accepted：所有已受理派单的结算事实都写入 inbox，不再由 background/stopRequested
      // 决定是否产生事件；根目标失效时事件标 obsolete（结果仍可查，不唤醒模型）。
      const eventId = `complete:${key}`;
      s.inbox[eventId] = { eventId, owner, taskId: key, state: terminal.has(s.roots[owner.rootRunId]?.status) ? 'obsolete' : 'pending', result };
      return record;
    }),
    pending: owner => read(s => Object.values(s.inbox).filter(e => e.owner.conversationId === owner.conversationId && e.owner.rootRunId === owner.rootRunId && e.owner.generation === owner.generation && e.state === 'pending')),
    /** 057 软复盘到期读数：当前段预算是否已在回合边界耗尽（不含硬预算标志，那由 requestStart 维护）。 */
    reviewDue: owner => read(s => {
      const root = s.roots[owner.rootRunId];
      if (!owns(root, owner) || !root.goal || root.goal.phase !== 'active') return false;
      const roundCap = Math.min(root.goal.policy.maxRequestsPerRound, root.policySnapshot?.budgets?.maxRequestsPerRun ?? root.goal.policy.maxRequestsPerRound);
      return goalRequests(s, root) >= root.goal.requestOffset + roundCap;
    }),
    /** 057 软复盘点唤醒：子任务跨段后根调度在等待边界被唤醒复盘；不中断子任务执行（R-02/H-01）。 */
    async waitForReview(owner, {signal} = {}) {
      await ready;
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const dispose = () => { watchers.delete(check); signal?.removeEventListener('abort', abort); };
        const abort = () => { dispose(); reject(signal.reason ?? new DOMException('等待已取消','AbortError')); };
        const check = () => {
          const root = sourceRoot(state, owner);
          if (!owns(state.roots[owner.rootRunId], owner) || !root || terminal.has(root.status) || root.goal?.phase !== 'active') {dispose(); resolve(null); return;}
          if (root.reviewPending) {dispose(); resolve(structuredClone(root.reviewPending));}
        };
        watchers.add(check); signal?.addEventListener('abort', abort, {once:true});
        check();
      });
    },
    consume: (ids, entryId) => transaction(s => {
      for (const id of ids) if (s.inbox[id]?.state === 'pending') Object.assign(edit(s, 'inbox', id), { state: 'consumed', injectedEntryId: entryId, consumedAt: Date.now() });
      return ids;
    }),
    observationStart: record => transaction(s => {
      if (s.observations[record.id]) return { existing: true, ...s.observations[record.id] };
      const root = s.roots[record.owner.rootRunId];
      if (!owns(root, record.owner) || terminal.has(root.status) || suspended(root)) throw new Error('根目标已停止或挂起，不能开始工具');
      assertExecuting(s, record.owner);
      const next = { ...record, phase: 'started', startedAt: Date.now() }; s.observations[record.id] = next;
      return { existing: false, ...next };
    }),
    observationEnd: (id, result) => transaction(s => {
      const record = edit(s, 'observations', id); if (!record) throw new Error('工具观察身份不存在');
      return Object.assign(record, result, { phase: 'finished', endedAt: Date.now() });
    }),
    processStart: (record) => transaction(s => {
      if (!owns(s.roots[record.owner.rootRunId], record.owner) || terminal.has(s.roots[record.owner.rootRunId].status) || suspended(s.roots[record.owner.rootRunId])) throw new Error('所属目标已停止或挂起，命令未启动');
      assertExecuting(s, record.owner);
      if (!Number.isSafeInteger(record.pid) || record.pid <= 1 || !record.token) throw new Error('命令进程身份无效');
      if (s.processes[record.id]) throw new Error('重复命令进程身份');
      return s.processes[record.id] = {...record, state:'active', startedAt:Date.now()};
    }),
    processEnd: (id, result) => transaction(s => {
      if (!s.processes[id]) throw new Error('命令进程身份不存在');
      return Object.assign(edit(s, 'processes', id), result, {endedAt:Date.now()});
    }),
    processBackground: id => transaction(s => {
      const record = edit(s, 'processes', id);
      if (!record) throw new Error('命令进程身份不存在');
      record.background = true;
      return record;
    }),
    requestStart: (owner, request, limit) => transaction(s => {
      const root = edit(s, 'roots', owner.rootRunId);
      if (!owns(root, owner) || terminal.has(root.status) || suspended(root)) throw new Error('根目标已停止或挂起，禁止新请求');
      const sourceRootId = root.sourceRootRunId ?? owner.rootRunId;
      const source = edit(s, 'roots', sourceRootId);
      if (root.kind === 'auxiliary' && source && ['cancelled','failed','blocked','interrupted','continued','awaiting_user'].includes(source.status)) throw new Error('所属目标已停止或等待答复，禁止辅助请求');
      if (s.requests[request.requestId]) throw new Error('重复请求身份');
      if (request.purpose === BUDGET_SUMMARY_PURPOSE) {
        const previous = Object.values(s.requests).filter(item => item.owner.rootRunId === owner.rootRunId && item.purpose === BUDGET_SUMMARY_PURPOSE);
        if (owner.taskId || root.kind === 'auxiliary' || request.role !== 'main' || !root.requestLimitReached || root.budgetSummary?.state !== 'preparing'
          || !singleModelCallAvailable(previous, request)) throw new Error('任务总结机会不可用');
        if (!request.preflight) Object.assign(root.budgetSummary, { state: 'requested', requestId: request.requestId });
      } else if (request.purpose === GOAL_VERIFICATION_PURPOSE) {
        const previous = Object.values(s.requests).filter(item => item.owner.rootRunId === owner.rootRunId
          && item.purpose === GOAL_VERIFICATION_PURPOSE && item.goalRound === root.goal?.round);
        if (owner.taskId || root.kind === 'auxiliary' || request.role !== 'main' || root.goal?.phase !== 'checking'
          || root.goal.verificationAttempts?.some(item => item.round === root.goal.round)
          || !singleModelCallAvailable(previous, request)) throw new Error('目标校验请求不可用');
        request = {...request, goalRound: root.goal.round};
      } else {
        // 057 软复盘：段边界（maxRequestsPerRound）只作为回合边界复盘记账，不再拒绝请求；
        // 硬预算（goal 总额 maxRequests，或无 goal 会话的 per-run 上限）仍原子拒绝（agent-task-lifecycle R-07）。
        const perRun = source?.policySnapshot?.budgets?.maxRequestsPerRun ?? limit;
        const hardCap = source?.goal ? source.goal.policy.maxRequests : perRun;
        const used = goalRequests(s,source);
        if (source?.requestLimitReached || used >= hardCap) {
          (source ?? root).requestLimitReached ??= { limit: hardCap, at: Date.now() };
          // 先提交触顶事实，再在事务外拒绝；否则 throw 会回滚，兄弟执行者看不到停止新工作的边界。
          return { requestDenied: true, limit: hardCap };
        }
        // 软段越界：请求照常准入，只留复盘提示唤醒根调度（子任务不等祖先，R-02；父在等待边界复盘，H-01）。
        if (source?.goal && source.goal.phase === 'active') {
          const roundCap = Math.min(source.goal.policy.maxRequestsPerRound, source.policySnapshot?.budgets?.maxRequestsPerRun ?? source.goal.policy.maxRequestsPerRound);
          if (used >= source.goal.requestOffset + roundCap) source.reviewPending ??= { at: Date.now(), round: source.goal.round };
        }
      }
      return s.requests[request.requestId] = { ...request, owner, startedAt: Date.now(), coverage: 'unknown' };
    }).then(result => {
      if (result.requestDenied) throw Object.assign(new Error(`运行请求上限 ${result.limit} 已达到，未完成工作已停止`), { code: 'request-limit' });
      return result;
    }),
    beginBudgetSummary: owner => transaction(s => {
      const root = edit(s, 'roots', owner.rootRunId);
      if (!owns(root, owner) || owner.taskId || root.kind === 'auxiliary' || terminal.has(root.status) || suspended(root) || !root.requestLimitReached) throw new Error('根目标已停止或未触顶，不能总结');
      if (root.budgetSummary) return { existing: true, ...root.budgetSummary };
      root.budgetSummary = { state: 'preparing', startedAt: Date.now() };
      return { existing: false, ...root.budgetSummary };
    }),
    finishBudgetSummary: (owner, result) => transaction(s => {
      const root = edit(s, 'roots', owner.rootRunId);
      if (!owns(root, owner) || terminal.has(root.status) || !root.budgetSummary) throw new Error('总结归属已失效');
      if (['complete','fallback'].includes(root.budgetSummary.state)) return root.budgetSummary;
      Object.assign(root.budgetSummary, result, { state: result.fallback ? 'fallback' : 'complete', endedAt: Date.now() });
      return root.budgetSummary;
    }),
    requestResponse: (requestId, response) => transaction(s => {
      const request = edit(s, 'requests', requestId); if (!request) throw new Error('请求身份不存在');
      return Object.assign(request, response, { responseAt: Date.now() });
    }),
    requestRecovery: (requestId, recovery) => transaction(s => {
      const request = edit(s, 'requests', requestId); if (!request) throw new Error('请求身份不存在');
      return Object.assign(request, { recovery });
    }),
    requestEnd: (requestId, result) => transaction(s => {
      if (!s.requests[requestId]) throw new Error('请求身份不存在');
      return Object.assign(edit(s, 'requests', requestId), result, { endedAt: Date.now() });
    }),
    recover: () => transaction(s => {
      // Background processes are not replayable after a host restart.
      for(const [id, value] of Object.entries(s.roots))if(value.status==='waiting_background'){
        const root = edit(s, 'roots', id);
        Object.assign(root,{status:'interrupted',reason:'进程重启；不会自动重放后台任务',terminalAt:Date.now()});
        if(root.goal)root.goal.phase='interrupted';
      }
      for (const [id, root] of Object.entries(s.roots)) if (root.goal && !terminal.has(root.status) && !suspended(root)) Object.assign(edit(s, 'roots', id).goal, {phase: 'interrupted', reason: '进程重启；等待用户核对后继续'});
      for (const [id, root] of Object.entries(s.roots)) if (!terminal.has(root.status) && !suspended(root)) Object.assign(edit(s, 'roots', id), { status: 'interrupted', reason: '进程重启；不会自动重放副作用', terminalAt: Date.now() });
      for (const [id, dispatch] of Object.entries(s.dispatches)) if (!['terminal','interrupted'].includes(dispatch.state)) Object.assign(edit(s, 'dispatches', id), {state:'interrupted', interruptionReason:'进程重启；受理不代表完成，不自动重投'});
      for (const [id, observation] of Object.entries(s.observations)) if (observation.phase === 'started') Object.assign(edit(s, 'observations', id), {phase:'unknown', interruptionReason:'进程重启，工具是否生效需要核对'});
      for (const [id, request] of Object.entries(s.requests)) if (!request.endedAt) Object.assign(edit(s, 'requests', id), {coverage:'unknown', interruptionReason:'进程重启，实际用量未确认'});
      for (const [id, event] of Object.entries(s.inbox)) if (event.state !== 'consumed') edit(s, 'inbox', id).state = 'obsolete';
      return { recovered: true };
    }),
    async flush() { await tail; if (pendingWrite) await transaction(() => undefined); },
    dispose: () => retry.dispose(),
  };
}
