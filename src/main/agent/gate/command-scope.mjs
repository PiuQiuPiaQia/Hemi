import { CommandOutput } from './command-output.mjs';
import { randomUUID } from 'node:crypto';
import { runCommand, commandToolResult } from './command-execution.mjs';
import { currentExecutionScope } from '../../agent-runtime/execution-scope.mjs';
import { processBirth } from '../../agent-runtime/owned-processes.mjs';
import { normalizeCommandDescription } from '../../../shared/command-display.mjs';
import {commandDeadline, cleanupFailure} from './command-deadline.mjs';
import { isBackgroundWaitCommand } from '../background-wait.mjs';

export const COMMAND_FOREGROUND_MS = 10_000;
export const COMMAND_TIMEOUT_MS = 30 * 60_000;
export const COMMAND_BACKGROUND_TIMEOUT_MS = 24 * 60 * 60_000;
const sameOwner = (a, b) => a?.conversationId === b?.conversationId && a?.rootRunId === b?.rootRunId
  && a?.generation === b?.generation && a?.taskId === b?.taskId;
// 后台命令统一归会话管理；子任务仍只可控制自己的命令。
const canControl = (record, owner) => sameOwner(record.owner, owner) || (record.background
  && !owner?.taskId && record.owner?.conversationId === owner?.conversationId && record.owner?.generation === owner?.generation);
const outputTail = result => [result.stdout.slice(-2000), result.stderr.slice(-2000)].filter(Boolean).join('\n').slice(-2000);

/** 进程持续受管；是否等待结果由当前目标决定，不推断命令是否为常驻服务。 */
export function createCommandScope({ onChange = () => {}, onSettled = () => {}, now = Date.now, persistenceTimeoutMs = 10000, settleTimeoutMs = 20000, quietReviewMs = 60000, maxQuietReviews = 3 } = {}) {
  const active = new Set(), completed = [], recordsById = new Map();
  let wake = Promise.withResolvers(), reviewRequest = null;
  const changed = () => { wake.resolve(); wake = Promise.withResolvers(); };
  let reviewOwner = null, reviews = 0;
  let quarantine = null;
  const uncertain = (execution, message) => {
    quarantine = cleanupFailure(message);
    if (execution) {execution.cleanupUnconfirmed=true;execution.fatalError=message;}
    return quarantine;
  };
  const view = record => ({
    id: record.id, toolCallId: record.toolCallId, command: record.command.slice(0, 8000),
    runId:record.owner?.rootRunId,generation:record.owner?.generation,taskId:record.owner?.taskId,
    cleanupConfirmed:record.result?.cleanupConfirmed??false,
    commandTruncated: record.command.length > 8000, description: record.description, lastOutputAt: record.lastOutputAt,
    deadlineAt:record.commandDeadlineAt, outputBytes:record.log.total, earliestOutput:record.log.total-record.log.bytes,
    startedAt: record.startedAt, endedAt: record.endedAt ?? null,
    status: record.error ? 'failed' : record.result?.status ?? 'running',
    code: record.result?.code ?? null, output: record.output,
  });
  const publish = () => onChange([...recordsById.values()].filter(r => r.background
    && (!r.settled || (r.error?.code==='cleanup-unconfirmed'&&!r.result?.cleanupConfirmed))).map(view));
  const backgroundFor = (owner, jobIds) => [...active, ...completed].filter(r => r.background
    && (!r.goalClosed || jobIds)
    && (jobIds ? jobIds.includes(r.id) && canControl(r, owner) : sameOwner(r.owner, owner)));
  const acknowledgeReview = (owner, update) => {
    if (!sameOwner(reviewOwner, owner)) throw new Error('观察不属于当前目标');
    if (update.requested && sameOwner(reviewRequest, owner)) reviewRequest = null;
    reviews++;
    for (const job of update.jobs) {
      const record = recordsById.get(job.id);
      if (record && sameOwner(record.owner, owner)) record.reviewedAtOutput = job.lastOutputAt ?? job.startedAt;
    }
  };
  // 工具批次边界与整轮收口共享同一个消费入口，不等待仍在运行的命令。
  const takeCompleted = owner => {
    const ready = completed.filter(r => sameOwner(r.owner, owner));
    for (const record of ready) completed.splice(completed.indexOf(record), 1);
    const failure = ready.find(r => r.error);
    if (failure) throw failure.error;
    return ready.filter(record => !record.collected).map(record => ({ ...view(record), outputRef: record.outputRef,
      text: commandToolResult(record.result).content[0].text.slice(-12_000),
    }));
  };

  async function run(options) {
    if (quarantine) throw quarantine;
    const scope = currentExecutionScope(), execution = scope?.execution;
    if (execution?.cancelled?.()) throw new DOMException('目标已停止', 'AbortError');
    const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : options.runInBackground ? COMMAND_BACKGROUND_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
    // 归属过滤与完成通知共用同一判定；占位等待不启动进程，也不取消已有工作。
    if (backgroundFor(execution?.owner).length && isBackgroundWaitCommand(options.command, options.description)) {
      return { status: 'waiting-background', code: null, cleanupConfirmed: true, actionState: 'not-executed' };
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const record = {
      id: `command-${randomUUID()}`, controller, execution, owner: execution?.owner,
      toolCallId: scope?.toolCallId, command: options.command, startedAt: now(),
      description: normalizeCommandDescription(options.description), lastOutputAt: null,
      background: false, output: '', promise: null, settled: false, log:new CommandOutput(), reviewedAtOutput:null,
      commandDeadlineAt:now()+timeoutMs,
      deadlineAt: now()+timeoutMs+settleTimeoutMs,
    };
    const token = randomUUID();
    let registered = false, ready;
    const started = new Promise(resolve => { ready = resolve; });
    let lastProgress = 0, progressTimer;
    active.add(record);recordsById.set(record.id,record);
    for(const [id,old] of recordsById) if(recordsById.size>64 && old.settled && !completed.includes(old))recordsById.delete(id);
    record.promise = runCommand({ ...options, timeoutMs, signal: controller.signal, ownerToken: token,
      onOutput: result => {
        record.log.append(result.channel,result.chunk);
        record.output = record.log.tail(2000);
        record.lastOutputAt = now();changed();
        options.onOutput?.(result);
        if (record.background) {
          const remaining = 1000 - (now() - lastProgress);
          if (remaining <= 0) {
            clearTimeout(progressTimer); progressTimer = null;
            lastProgress = now(); publish();
          } else if (!progressTimer) progressTimer = setTimeout(() => {
            progressTimer = null;
            lastProgress = now();
            if (!record.settled) publish();
          }, remaining);
        }
      },
      onSpawn: async (pid, isolation) => {
        if (execution?.journal) {
          const birth = await processBirth(pid);
          const registration = execution.journal.processStart({ id: record.id, token, pid, birth, ...isolation, owner: execution.owner,
            command: options.command, description: record.description, cwd: options.cwd, toolCallId: record.toolCallId,
          });
          // 登记落盘可能晚于取消收尾，必须保留真实清理结果，不能将已退出命令改成未知。
          void registration.then(async()=>{
            registered=true;
            if(record.settled) {
              const result = record.result;
              await execution.journal.processEnd(record.id, result ? {
                state:result.cleanupConfirmed?'finished':'unknown', cleanupConfirmed:result.cleanupConfirmed,
                status:result.status, code:result.code, output:record.output, lastOutputAt:record.lastOutputAt,
              } : {state:'unknown',cleanupConfirmed:false,status:'registration-late'});
            }
          }).catch(()=>{});
          try {await commandDeadline(registration,persistenceTimeoutMs,'命令归属保存超时，用户命令未启动');}
          catch(error){throw uncertain(execution,error.message);}
          registered=true;
        }
        await options.onSpawn?.(pid);
        ready();
      },
    }).then(async result => {
      record.result = result;
      record.output = outputTail(result);
      if(quarantine)throw quarantine;
      if (registered) {
        try {
          await commandDeadline(execution.journal.processEnd(record.id, {
            state: result.cleanupConfirmed ? 'finished' : 'unknown', cleanupConfirmed: result.cleanupConfirmed,
            status: result.status, code: result.code, output: record.output, lastOutputAt: record.lastOutputAt,
          }),persistenceTimeoutMs,'命令退出事实保存超时');
        } catch (error) {
          throw uncertain(execution,`命令退出事实保存失败：${error.message}`);
        }
      }
      if (!result.cleanupConfirmed) {
        throw uncertain(execution,'命令进程尚未确认退出，当前任务已停止；请先核对原命令状态');
      }
      if (record.background && execution?.contextStore) {
        record.outputRef = await commandDeadline(execution.contextStore.put({ owner: execution.owner, kind: 'tool',
          content: commandToolResult(result).content, source: { kind: 'tool', tool: 'bash' },
        }),persistenceTimeoutMs,'后台命令结果保存超时');
        if (execution.allowedRefs && !execution.allowedRefs.includes(record.outputRef)) execution.allowedRefs.push(record.outputRef);
      }
      // 完整结果已有不可变快照，等待模型收口时只保留有界尾部。
      if (record.background) record.result = { ...result,
        stdout: result.stdout.slice(-12_000), stderr: result.stderr.slice(-12_000),
        truncated: result.truncated || result.stdout.length > 12_000 || result.stderr.length > 12_000,
      };
      return record.result;
    }).catch(error => { record.error = error; if(error.code==='cleanup-unconfirmed')uncertain(execution,error.message); throw error; }).finally(() => {
      clearTimeout(progressTimer);
      record.settled = true;changed();
      record.endedAt = now();
      ready();
      options.signal?.removeEventListener('abort', onAbort);
      active.delete(record);
      if (record.background && !record.goalClosed) {
        completed.push(record);
        onSettled({...view(record), owner: record.owner, outputRef:record.outputRef, text: record.error?.message ?? commandToolResult(record.result).content[0].text});
      }
      publish();
    });
    // 后台承诺仍由宿主等待/取消；detach 之后不能留下未处理的拒绝。
    void record.promise.catch(() => {});
    const foregroundMs = options.runInBackground ? 0 : options.foregroundMs;
    if (!Number.isFinite(foregroundMs)) return record.promise;
    let timer;
    const yielded = await Promise.race([
      record.promise.then(() => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(true), Math.max(0, foregroundMs)); }),
    ]).finally(() => clearTimeout(timer));
    if (!yielded || record.settled || controller.signal.aborted) return record.promise;
    await started;
    if (record.settled || controller.signal.aborted || execution?.cancelled?.()) return record.promise;
    record.background = true;
    // 已转后台的进程随目标取消，不随当前 SDK 模型回合结束而丢失。
    options.signal?.removeEventListener('abort', onAbort);
    if (registered) {
      try {await commandDeadline(execution.journal.processBackground(record.id),persistenceTimeoutMs,'命令后台状态保存超时');}
      catch(error){
        const failure=uncertain(execution,error.message);
        controller.abort();
        await commandDeadline(record.promise,settleTimeoutMs,'命令取消未能确认').catch(()=>{});
        throw failure;
      }
    }
    publish();
    return { status: 'background', jobId: record.id, deadlineAt: record.commandDeadlineAt, cleanupConfirmed: false, code: null,
      stdout: '', stderr: '', background: true, startedAt: record.startedAt,
    };
  }

  const find = (owner, id) => {
    const record = recordsById.get(id);
    if (!record || !canControl(record,owner)) throw new Error('命令不存在或不属于当前目标');
    return record;
  };
  const inspect = (owner,id,options={}) => {
    const record=find(owner,id), output=record.log.read(options.from,options.maxBytes);
    if(options.collect && record.settled) record.collected=true;
    return {...view(record),...output,cleanupConfirmed:record.result?.cleanupConfirmed??false};
  };
  return {
    run,
    list: owner => [...recordsById.values()].filter(r=>canControl(r,owner)&&r.background).map(view),
    hasLiveBackground: () => [...active].some(r=>r.background),
    hasCompletedTree: owner => completed.some(r=>!r.collected&&r.owner?.rootRunId===owner.rootRunId&&r.owner?.generation===owner.generation&&r.owner?.conversationId===owner.conversationId),
    releaseGoal(owner) {
      const belongs=record=>record.owner?.conversationId===owner.conversationId&&record.owner?.rootRunId===owner.rootRunId&&record.owner?.generation===owner.generation;
      for(const record of recordsById.values())if(belongs(record))record.goalClosed=true;
      for(let i=completed.length-1;i>=0;i--)if(belongs(completed[i]))completed.splice(i,1);
    },
    inspect,
    async read(owner,id,{waitMs=0,signal,...options}={}) {
      const record=find(owner,id);
      if(waitMs>0 && !record.settled) {
        let timer,abort;
        try {await Promise.race([record.promise,new Promise(resolve=>{timer=setTimeout(resolve,Math.min(waitMs,30000));}),new Promise((_,reject)=>{abort=()=>reject(new DOMException('读取已取消','AbortError'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();})]);}
        finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
      }
      signal?.throwIfAborted();
      return inspect(owner,id,options);
    },
    async stop(owner,id) {
      const record=find(owner,id);
      if(!record.settled)record.controller.abort();
      try{await commandDeadline(record.promise,settleTimeoutMs,'命令停止未能确认');}
      catch(error){throw uncertain(record.execution,error.message);}
      return inspect(owner,id);
    },
    requestReview(owner) {
      if(![...active].some(r=>sameOwner(r.owner,owner)&&r.background))return false;
      reviewRequest=owner;changed();return true;
    },
    async waitForUpdate(owner, {signal, collect = true, jobIds} = {}) {
      if (jobIds) for (const id of jobIds) find(owner, id);
      if(!sameOwner(reviewOwner,owner)){reviewOwner=owner;reviews=0;if(!sameOwner(reviewRequest,owner))reviewRequest=null;}
      while(true){
        signal?.throwIfAborted();
        const pending=backgroundFor(owner, jobIds);
        if(pending.some(r=>r.settled)||!pending.length)return {kind:'settled',events:collect ? takeCompleted(owner) : []};
        const due=pending.filter(r=>r.reviewedAtOutput!==(r.lastOutputAt??r.startedAt));
        const quiet=quietReviewMs>0 && reviews<maxQuietReviews && due.some(r=>now()-(r.lastOutputAt??r.startedAt)>=quietReviewMs);
        if(reviewRequest||quiet){
          const update={kind:'review',requested:Boolean(reviewRequest),jobs:pending.map(view)};
          if(collect)acknowledgeReview(owner,update);
          return update;
        }
        const deadlines=pending.map(r=>r.deadlineAt-now());
        if(quietReviewMs>0&&reviews<maxQuietReviews)deadlines.push(...due.map(r=>quietReviewMs-(now()-(r.lastOutputAt??r.startedAt))));
        const ms=Math.max(1,Math.min(...deadlines));let timer,abort;
        try{await Promise.race([wake.promise,Promise.race(pending.map(r=>r.promise)),new Promise(resolve=>{timer=setTimeout(resolve,ms);}),new Promise((_,reject)=>{abort=()=>reject(signal.reason ?? new DOMException('等待已取消','AbortError'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();})]);}
        finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
        if(pending.some(r=>!r.settled&&now()>r.deadlineAt))throw uncertain(pending.find(r=>!r.settled)?.execution,'后台命令结果未能确认，已阻止继续执行');
      }
    },
    takeCompleted,
    acknowledgeReview,
    // 057 根调度树形收集：子任务结算后其仍受管的命令按 rootRunId+generation 归根消费（R-04/R-09）。
    // 与 takeCompleted 同一消费入口：已收集记录标记 collected，不重复投递；失败不抛（作为事实投递）。
    async collectCompletedTree(owner) {
      const sameTree = recordOwner => recordOwner?.rootRunId === owner.rootRunId && recordOwner.generation === owner.generation
        && recordOwner.conversationId === owner.conversationId;
      const finishing = [...active].filter(record => record.background && sameTree(record.owner) && (record.result || record.error));
      await Promise.all(finishing.map(record => commandDeadline(record.promise, settleTimeoutMs, '后台命令结果保存未能确认').catch(() => {})));
      const ready = completed.filter(r => sameTree(r.owner));
      for (const record of ready) completed.splice(completed.indexOf(record), 1);
      return ready.filter(record => !record.collected).map(record => ({ ...view(record), outputRef: record.outputRef,
        text: record.error ? `命令异常结束：${record.error.message}` : commandToolResult(record.result).content[0].text.slice(-12_000),
      }));
    },
    hasBackgroundTree: owner => [...active].some(r => r.background && r.owner?.rootRunId === owner.rootRunId && r.owner?.generation === owner.generation && r.owner?.conversationId === owner.conversationId),
    async collectCompleted(owner) {
      // An exited process may still be saving its result. Join only that bounded settlement, never live work.
      const finishing = [...active].filter(record => record.background && sameOwner(record.owner, owner) && (record.result || record.error));
      await Promise.all(finishing.map(record => commandDeadline(record.promise, settleTimeoutMs, '后台命令结果保存未能确认')));
      return takeCompleted(owner);
    },
    hasBackground: owner => backgroundFor(owner).length > 0,
    async waitForCompletion(owner) {
      const records = backgroundFor(owner);
      if (!records.some(r => r.settled) && records.length) {
        const remaining=Math.max(1,Math.min(...records.map(r=>r.deadlineAt-now())));
        try {await commandDeadline(Promise.race(records.map(r=>r.promise)),remaining,'后台命令结果未能确认，已阻止继续执行');}
        catch(error){if(error.code==='cleanup-unconfirmed')throw uncertain(currentExecutionScope()?.execution,error.message);throw error;}
      }
      return takeCompleted(owner);
    },
    async abort({preserveBackground = false, owner} = {}) {
      const owned = [...active].filter(record => (!owner||sameOwner(record.owner,owner))&&(!preserveBackground || !record.background));
      for (const record of owned) record.controller.abort();
      const results = await Promise.allSettled(owned.map(record => commandDeadline(record.promise,settleTimeoutMs,'命令取消未能确认完成，已阻止后续执行')));
      if (!preserveBackground) for(let i=completed.length-1;i>=0;i--)if(!owner||sameOwner(completed[i].owner,owner))completed.splice(i,1);
      if(quarantine)throw quarantine;
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw uncertain(currentExecutionScope()?.execution,failure.reason.message);
      if (results.some(result => !result.value.cleanupConfirmed)) throw uncertain(currentExecutionScope()?.execution,'命令所属进程未确认退出，当前任务已停止；请先核对原命令状态');
    },
  };
}
