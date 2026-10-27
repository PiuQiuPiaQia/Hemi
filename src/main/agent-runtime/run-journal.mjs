import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const terminal = new Set(['completed','partial','failed','cancelled','interrupted','continued']);
const suspended = root => root?.status === 'awaiting_user' || (root?.kind === 'workflow' && root.status === 'waiting');
const owns = (root, owner) => root && root.owner.conversationId === owner.conversationId && root.owner.rootRunId === owner.rootRunId && root.owner.generation === owner.generation;
const initial = () => ({ version: 2, roots: {}, dispatches: {}, tasks: {}, inbox: {}, requests: {}, observations: {}, processes: {} });
export const BUDGET_SUMMARY_PURPOSE = 'budget-summary';
export const GOAL_VERIFICATION_PURPOSE = 'goal-verification';
const sourceRoot = (s, owner) => {
  const root = s.roots[owner.rootRunId];
  return s.roots[root?.sourceRootRunId ?? owner.rootRunId];
};
const goalIdentity = root => root?.goal?.id ?? root?.owner.rootRunId;
const goalRequests = (s, root) => Object.values(s.requests).filter(item => ![BUDGET_SUMMARY_PURPOSE,GOAL_VERIFICATION_PURPOSE].includes(item.purpose)
  && goalIdentity(sourceRoot(s,item.owner)) === goalIdentity(root)).length;
const assertExecuting = (s, owner) => {
  if (sourceRoot(s, owner)?.requestLimitReached) throw new Error('执行请求已达上限，不能开始新动作');
};
export const dispatchIdentity = ({ conversationId, rootRunId, generation = 0, sessionId, callAnchorId, toolCallId }) => {
  if (![conversationId,rootRunId,sessionId,callAnchorId,toolCallId].every(x => typeof x === 'string' && x)) throw new Error('派单缺少可信调用身份');
  return createHash('sha256').update(JSON.stringify([conversationId,rootRunId,generation,sessionId,callAnchorId,toolCallId])).digest('hex');
};

/** 同一原子提交保存终态与 outbox；磁盘损坏绝不按空状态继续。 */
export function createRunJournal({ dir }) {
  const file = path.join(dir, 'run-journal.json');
  let state, tail = Promise.resolve();
  const ready = (async () => {
    await mkdir(dir, { recursive: true });
    try { state = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`运行事实库读取失败：${error.message}`); state = initial(); }
    state.observations ??= {};
    state.processes ??= {};
    if (state.version !== 2 || ['roots','inbox','dispatches','tasks','requests','observations','processes'].some(key => !state[key] || typeof state[key] !== 'object' || Array.isArray(state[key]))) throw new Error('运行事实库版本或结构损坏');
  })();
  const transaction = operation => {
    const run = tail.then(async () => {
      await ready;
      const next = structuredClone(state), result = operation(next);
      const tmp = `${file}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
      await rename(tmp, file); state = next;
      return structuredClone(result);
    });
    tail = run.catch(() => {}); return run;
  };
  const read = async fn => { await ready; await tail; return structuredClone(fn(state)); };
  return {
    ready: () => ready,
    snapshot: () => read(s => s),
    root: owner => read(s => s.roots[owner.rootRunId] ?? null),
    beginRoot: (owner, facts = {}) => transaction(s => {
      const old = s.roots[owner.rootRunId];
      if (old) {
        if (JSON.stringify(old.owner) !== JSON.stringify(owner) || terminal.has(old.status)) throw new Error('根目标已失效或终结，不得重新执行');
        if (old.status === 'awaiting_user') throw new Error('目标正在等待用户答复，不能自行恢复');
      }
      const busy = Object.values(s.roots).find(r => r.owner.rootRunId !== owner.rootRunId && r.owner.conversationId === owner.conversationId && r.kind !== 'auxiliary' && !terminal.has(r.status) && !suspended(r));
      if (busy && (old?.kind ?? facts.kind) !== 'auxiliary') throw new Error('该对话已有执行中的根目标');
      if (old) {
        if (suspended(old)) old.status = 'running';
        return old;
      }
      return s.roots[owner.rootRunId] = { owner, status: 'running', createdAt: Date.now(), ...facts };
    }),
    suspendRoot: owner => transaction(s => {
      const root = s.roots[owner.rootRunId];
      if (!owns(root, owner) || terminal.has(root.status) || (root.kind && root.kind !== 'workflow')) throw new Error('工作流根目标已失效，不能挂起');
      root.kind = 'workflow';
      root.status = 'waiting';
      return root;
    }),
    beginGoal: (owner, objective, policy, continuation = null) => transaction(s => {
      const root = s.roots[owner.rootRunId];
      if (!owns(root, owner) || terminal.has(root.status) || owner.taskId) throw new Error('目标归属已失效');
      if (!root.goal && continuation) {
        const previous = s.roots[continuation.rootRunId];
        if (!previous || previous.owner.conversationId !== owner.conversationId || previous.owner.generation !== owner.generation
          || previous.status !== 'awaiting_user' || previous.goal?.phase !== 'awaiting_user' || !continuation.inputId || typeof continuation.answer !== 'string') throw new Error('等待答复的目标已变化，不能续接');
        const used = goalRequests(s,previous);
        if (previous.goal.round >= previous.goal.policy.maxRounds || used >= previous.goal.policy.maxRequests) throw Object.assign(new Error('目标总预算已达到，工作尚未完成'), {code:'goal-budget-limit'});
        root.goal = {...structuredClone(previous.goal),id:goalIdentity(previous),phase:'active',round:previous.goal.round+1,requestOffset:used,
          replies:[...(previous.goal.replies ?? []),{inputId:continuation.inputId,text:continuation.answer,runId:owner.rootRunId}],continuedFrom:continuation.rootRunId};
        delete root.goal.waitingForUser;
        Object.assign(previous,{status:'continued',continuedBy:owner.rootRunId,terminalAt:Date.now()});
        previous.goal.phase='continued';
      }
      root.goal ??= { id:owner.rootRunId, objective, policy, phase: 'active', round: 1, requestOffset: 0, verifications: [], startedAt: Date.now() };
      return root.goal;
    }),
    checkGoal: owner => transaction(s => {
      const root = s.roots[owner.rootRunId];
      if (!owns(root, owner) || terminal.has(root.status) || !root.goal || root.goal.phase !== 'active') throw new Error('目标不能校验');
      const belongs = item => item.owner.rootRunId === owner.rootRunId;
      if (Object.values(s.requests).some(item => belongs(item) && !item.endedAt)
        || Object.values(s.observations).some(item => belongs(item) && item.phase !== 'finished')
        || Object.values(s.processes).some(item => belongs(item) && (!item.cleanupConfirmed || item.state !== 'finished'))
        || Object.values(s.dispatches).some(item => belongs(item) && item.state !== 'terminal')
        || Object.values(s.inbox).some(item => belongs(item) && item.state === 'pending')) throw new Error('目标仍有未确认的执行，不能判定完成');
      root.goal.phase = 'checking';
      return root.goal;
    }),
    recordGoalCheck: (owner, verdict) => transaction(s => {
      const root = s.roots[owner.rootRunId];
      if (!owns(root, owner) || terminal.has(root.status) || root.goal?.phase !== 'checking') throw new Error('目标校验已失效');
      root.goal.verifications.push({ ...verdict, round: root.goal.round, at: Date.now() });
      root.goal.phase = verdict.status === 'complete' ? 'complete' : verdict.status === 'blocked' ? 'blocked' : verdict.status === 'awaiting_user' ? 'awaiting_user' : 'active';
      if (verdict.status === 'awaiting_user') root.goal.waitingForUser={question:verdict.question,reason:verdict.reason,at:Date.now()};
      return root.goal;
    }),
    continueGoal: owner => transaction(s => {
      const root = s.roots[owner.rootRunId], goal = root?.goal;
      if (!owns(root, owner) || terminal.has(root.status) || (goal?.phase !== 'active' || goal.verifications.at(-1)?.status !== 'continue' || goal.verifications.at(-1)?.round !== goal.round)) throw new Error('目标已停止或缺少续跑校验，不能续跑');
      const used = goalRequests(s,root);
      if (goal.round >= goal.policy.maxRounds || used >= goal.policy.maxRequests) throw Object.assign(new Error('目标总预算已达到，工作尚未完成'), {code: 'goal-budget-limit'});
      goal.round++; goal.requestOffset = used;
      if (root.requestLimitReached) { (goal.limitHistory ??= []).push(root.requestLimitReached); delete root.requestLimitReached; }
      return goal;
    }),
    endGoal: (owner, phase, reason) => transaction(s => {
      const root = s.roots[owner.rootRunId];
      if (!owns(root, owner) || !root.goal) throw new Error('目标归属已失效');
      // A late verifier must never turn a cancelled/interrupted goal into success.
      if (root.goal.phase !== 'complete') Object.assign(root.goal, {phase, reason, endedAt: Date.now()});
      return root.goal;
    }),
    finishRoot: (owner, status, reason = null) => transaction(s => {
      if (!terminal.has(status) && status !== 'awaiting_user') throw new Error('根目标终态无效');
      const root = s.roots[owner.rootRunId];
      if (!root || JSON.stringify(root.owner) !== JSON.stringify(owner)) throw new Error('根目标身份已失效');
      if (terminal.has(root.status)) return root;
      if (status === 'awaiting_user') {
        if (root.goal?.phase !== 'awaiting_user') throw new Error('缺少等待用户答复的校验事实');
        root.status='awaiting_user';root.suspendedAt=Date.now();return root;
      }
      if (status === 'completed' && ((root.requestLimitReached && !root.goal) || (root.goal && root.goal.phase !== 'complete'))) {
        status = 'partial'; reason ??= root.goal?.reason ?? '目标尚未通过完成校验';
      }
      if (root.goal && status !== 'completed' && root.goal.phase !== 'blocked' && root.goal.phase !== 'budget_limited') Object.assign(root.goal, {phase: status === 'cancelled' ? 'cancelled' : 'interrupted', reason});
      root.status = status; root.reason = reason; root.terminalAt = Date.now();
      if (status !== 'completed') for (const item of Object.values(s.inbox)) if (item.owner.rootRunId === owner.rootRunId && item.state !== 'consumed') item.state = 'obsolete';
      return root;
    }),
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
      const record = s.dispatches[key]; if (!record) throw new Error('派单锚点不存在');
      if (record.taskId && receipt.ok && receipt.taskId && receipt.taskId !== record.taskId) throw new Error('派单回执的任务身份不匹配');
      record.receipt = receipt; record.state = record.result || receipt.ok === false ? 'terminal' : 'accepted'; return record;
    }),
    completeTask: ({ dispatchKey, owner, result, background }) => transaction(s => {
      const key = result.taskId;
      if (!owns(s.roots[owner.rootRunId], owner)) throw new Error('子任务终态归属无效');
      if (dispatchKey && !owns(s.dispatches[dispatchKey], owner)) throw new Error('子任务派单归属无效');
      if (dispatchKey && s.dispatches[dispatchKey].taskId && (s.dispatches[dispatchKey].taskId !== key || owner.taskId !== key)) throw new Error('子任务终态的持久身份不匹配');
      if (s.tasks[key]) {
        if (!owns(s.tasks[key], owner) || s.tasks[key].owner.taskId !== owner.taskId) throw new Error('子任务身份已被其他目标占用');
        return s.tasks[key];
      }
      const record = { owner, result, terminalAt: Date.now() }; s.tasks[key] = record;
      if (dispatchKey && s.dispatches[dispatchKey]) Object.assign(s.dispatches[dispatchKey], { result, state: 'terminal' });
      if (background) {
        const eventId = `complete:${key}`;
        s.inbox[eventId] = { eventId, owner, taskId: key, state: terminal.has(s.roots[owner.rootRunId]?.status) ? 'obsolete' : 'pending', result };
      }
      return record;
    }),
    pending: owner => read(s => Object.values(s.inbox).filter(e => e.owner.conversationId === owner.conversationId && e.owner.rootRunId === owner.rootRunId && e.owner.generation === owner.generation && e.state === 'pending')),
    consume: (ids, entryId) => transaction(s => {
      for (const id of ids) if (s.inbox[id]?.state === 'pending') Object.assign(s.inbox[id], { state: 'consumed', injectedEntryId: entryId, consumedAt: Date.now() });
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
      const record = s.observations[id]; if (!record) throw new Error('工具观察身份不存在');
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
      return Object.assign(s.processes[id], result, {endedAt:Date.now()});
    }),
    processBackground: id => transaction(s => {
      const record = s.processes[id];
      if (!record) throw new Error('命令进程身份不存在');
      record.background = true;
      return record;
    }),
    requestStart: (owner, request, limit) => transaction(s => {
      const root = s.roots[owner.rootRunId];
      if (!owns(root, owner) || terminal.has(root.status) || suspended(root)) throw new Error('根目标已停止或挂起，禁止新请求');
      const sourceRootId = root.sourceRootRunId ?? owner.rootRunId;
      const source = s.roots[sourceRootId];
      if (root.kind === 'auxiliary' && source && ['cancelled','failed','interrupted','continued','awaiting_user'].includes(source.status)) throw new Error('所属目标已停止或等待答复，禁止辅助请求');
      if (s.requests[request.requestId]) throw new Error('重复请求身份');
      if (request.purpose === BUDGET_SUMMARY_PURPOSE) {
        if (owner.taskId || root.kind === 'auxiliary' || request.role !== 'main' || !root.requestLimitReached || root.budgetSummary?.state !== 'preparing') throw new Error('任务总结机会不可用');
        Object.assign(root.budgetSummary, { state: 'requested', requestId: request.requestId });
      } else if (request.purpose === GOAL_VERIFICATION_PURPOSE) {
        if (owner.taskId || root.kind === 'auxiliary' || request.role !== 'main' || root.goal?.phase !== 'checking'
          || Object.values(s.requests).some(item => item.owner.rootRunId === owner.rootRunId && item.purpose === GOAL_VERIFICATION_PURPOSE && item.goalRound === root.goal.round)) throw new Error('目标校验请求不可用');
        request = {...request, goalRound: root.goal.round};
      } else {
        const cap = source?.goal ? Math.min(source.goal.requestOffset + Math.min(source.goal.policy.maxRequestsPerRound, source.policySnapshot?.budgets?.maxRequestsPerRun ?? limit), source.goal.policy.maxRequests) : source?.policySnapshot?.budgets?.maxRequestsPerRun ?? limit;
        const used = goalRequests(s,source);
        if (source?.requestLimitReached || used >= cap) {
          (source ?? root).requestLimitReached ??= { limit: cap, at: Date.now() };
          // 先提交触顶事实，再在事务外拒绝；否则 throw 会回滚，兄弟执行者看不到停止新工作的边界。
          return { requestDenied: true, limit: cap };
        }
      }
      return s.requests[request.requestId] = { ...request, owner, startedAt: Date.now(), coverage: 'unknown' };
    }).then(result => {
      if (result.requestDenied) throw Object.assign(new Error(`运行请求上限 ${result.limit} 已达到，未完成工作已停止`), { code: 'request-limit' });
      return result;
    }),
    beginBudgetSummary: owner => transaction(s => {
      const root = s.roots[owner.rootRunId];
      if (!owns(root, owner) || owner.taskId || root.kind === 'auxiliary' || terminal.has(root.status) || suspended(root) || !root.requestLimitReached) throw new Error('根目标已停止或未触顶，不能总结');
      if (root.budgetSummary) return { existing: true, ...root.budgetSummary };
      root.budgetSummary = { state: 'preparing', startedAt: Date.now() };
      return { existing: false, ...root.budgetSummary };
    }),
    finishBudgetSummary: (owner, result) => transaction(s => {
      const root = s.roots[owner.rootRunId];
      if (!owns(root, owner) || terminal.has(root.status) || !root.budgetSummary) throw new Error('总结归属已失效');
      if (['complete','fallback'].includes(root.budgetSummary.state)) return root.budgetSummary;
      Object.assign(root.budgetSummary, result, { state: result.fallback ? 'fallback' : 'complete', endedAt: Date.now() });
      return root.budgetSummary;
    }),
    requestResponse: (requestId, response) => transaction(s => {
      const request = s.requests[requestId]; if (!request) throw new Error('请求身份不存在');
      return Object.assign(request, response, { responseAt: Date.now() });
    }),
    requestRecovery: (requestId, recovery) => transaction(s => {
      const request = s.requests[requestId]; if (!request) throw new Error('请求身份不存在');
      return Object.assign(request, { recovery });
    }),
    requestEnd: (requestId, result) => transaction(s => {
      if (!s.requests[requestId]) throw new Error('请求身份不存在');
      return Object.assign(s.requests[requestId], result, { endedAt: Date.now() });
    }),
    recover: () => transaction(s => {
      for (const root of Object.values(s.roots)) if (root.goal && !terminal.has(root.status) && !suspended(root)) Object.assign(root.goal, {phase: 'interrupted', reason: '进程重启；等待用户核对后继续'});
      for (const root of Object.values(s.roots)) if (!terminal.has(root.status) && !suspended(root)) Object.assign(root, { status: 'interrupted', reason: '进程重启；不会自动重放副作用', terminalAt: Date.now() });
      for (const dispatch of Object.values(s.dispatches)) if (!['terminal','interrupted'].includes(dispatch.state)) Object.assign(dispatch, {state:'interrupted', interruptionReason:'进程重启；受理不代表完成，不自动重投'});
      for (const observation of Object.values(s.observations)) if (observation.phase === 'started') Object.assign(observation, {phase:'unknown', interruptionReason:'进程重启，工具是否生效需要核对'});
      for (const request of Object.values(s.requests)) if (!request.endedAt) Object.assign(request, {coverage:'unknown', interruptionReason:'进程重启，实际用量未确认'});
      for (const event of Object.values(s.inbox)) if (event.state !== 'consumed') event.state = 'obsolete';
      return { recovered: true };
    }),
    flush: () => tail,
  };
}
