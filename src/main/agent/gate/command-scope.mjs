import { CommandOutput } from './command-output.mjs';
import { randomUUID } from 'node:crypto';
import { runCommand, commandToolResult } from './command-execution.mjs';
import { currentExecutionScope } from '../../agent-runtime/execution-scope.mjs';
import { processBirth } from '../../agent-runtime/owned-processes.mjs';
import { normalizeCommandDescription } from '../../../shared/command-display.mjs';
import {commandDeadline, cleanupFailure, blockCommandCleanup} from './command-deadline.mjs';
import { isBackgroundWaitCommand } from '../background-wait.mjs';

export const COMMAND_FOREGROUND_MS = 10_000;
export const COMMAND_TIMEOUT_MS = 30 * 60_000;
const sameOwner = (a, b) => a?.conversationId === b?.conversationId && a?.rootRunId === b?.rootRunId
  && a?.generation === b?.generation && a?.taskId === b?.taskId;
const outputTail = result => [result.stdout.slice(-2000), result.stderr.slice(-2000)].filter(Boolean).join('\n').slice(-2000);

/** 进程属于目标而非一次 SDK 请求。后台只交还模型调用，取消/退出仍确认进程树清理。 */
export function createCommandScope({ onChange = () => {}, onSettled = () => {}, now = Date.now, persistenceTimeoutMs = 10000, settleTimeoutMs = 20000, quietReviewMs = 60000, maxQuietReviews = 3 } = {}) {
  const active = new Set(), completed = [], recordsById = new Map();
  let wake = Promise.withResolvers(), reviewRequest = null;
  const changed = () => { wake.resolve(); wake = Promise.withResolvers(); };
  let reviewOwner = null, reviews = 0;
  let quarantine = null;
  const uncertain = (execution, message) => {
    quarantine = cleanupFailure(message);
    blockCommandCleanup(execution?.journal,quarantine);
    if (execution) {execution.cleanupUnconfirmed=true;execution.fatalError=message;}
    return quarantine;
  };
  const view = record => ({
    id: record.id, toolCallId: record.toolCallId, command: record.command.slice(0, 8000),
    commandTruncated: record.command.length > 8000, description: record.description, lastOutputAt: record.lastOutputAt,
    deadlineAt:record.commandDeadlineAt, outputBytes:record.log.total, earliestOutput:record.log.total-record.log.bytes,
    startedAt: record.startedAt, endedAt: record.endedAt ?? null,
    status: record.error ? 'failed' : record.result?.status ?? 'running',
    code: record.result?.code ?? null, output: record.output,
  });
  const publish = () => onChange([...active].filter(r => r.background).map(view));
  const backgroundFor = owner => [...active, ...completed].filter(r => r.background && sameOwner(r.owner, owner));
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
      commandDeadlineAt:now()+(options.timeoutMs>0?options.timeoutMs:COMMAND_TIMEOUT_MS),
      deadlineAt: now()+(options.timeoutMs>0?options.timeoutMs:COMMAND_TIMEOUT_MS)+settleTimeoutMs,
    };
    const token = randomUUID();
    let registered = false, ready;
    const started = new Promise(resolve => { ready = resolve; });
    let lastProgress = 0, progressTimer;
    active.add(record);recordsById.set(record.id,record);
    for(const [id,old] of recordsById) if(recordsById.size>64 && old.settled && !completed.includes(old))recordsById.delete(id);
    record.promise = runCommand({ ...options, signal: controller.signal, ownerToken: token,
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
          // A late durable write must not resurrect an already closed command.
          void registration.then(async()=>{
            registered=true;
            if(record.settled)await execution.journal.processEnd(record.id,{state:'unknown',cleanupConfirmed:false,status:'registration-late'});
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
        throw uncertain(execution,'命令进程尚未确认退出，已停止后续操作；请核对后重启运行时');
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
      if (record.background) {
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
    return { status: 'background', jobId: record.id, cleanupConfirmed: false, code: null,
      stdout: '', stderr: '', background: true, startedAt: record.startedAt,
    };
  }

  const find = (owner, id) => {
    const record = recordsById.get(id);
    if (!record || !sameOwner(record.owner,owner)) throw new Error('命令不存在或不属于当前目标');
    return record;
  };
  const inspect = (owner,id,options={}) => {
    const record=find(owner,id), output=record.log.read(options.from,options.maxBytes);
    if(options.collect && record.settled) record.collected=true;
    return {...view(record),...output,cleanupConfirmed:record.result?.cleanupConfirmed??false};
  };
  return {
    run,
    list: owner => [...recordsById.values()].filter(r=>sameOwner(r.owner,owner)&&r.background).map(view),
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
    async waitForUpdate(owner) {
      if(!sameOwner(reviewOwner,owner)){reviewOwner=owner;reviews=0;if(!sameOwner(reviewRequest,owner))reviewRequest=null;}
      while(true){
        const pending=backgroundFor(owner);
        if(pending.some(r=>r.settled)||!pending.length)return {kind:'settled',events:takeCompleted(owner)};
        const due=pending.filter(r=>r.reviewedAtOutput!==(r.lastOutputAt??r.startedAt));
        const quiet=quietReviewMs>0 && reviews<maxQuietReviews && due.some(r=>now()-(r.lastOutputAt??r.startedAt)>=quietReviewMs);
        if(reviewRequest||quiet){
          const requested=Boolean(reviewRequest);reviewRequest=false;reviews++;
          for(const r of pending)r.reviewedAtOutput=r.lastOutputAt??r.startedAt;
          return {kind:'review',requested,jobs:pending.map(view)};
        }
        const deadlines=pending.map(r=>r.deadlineAt-now());
        if(quietReviewMs>0&&reviews<maxQuietReviews)deadlines.push(...due.map(r=>quietReviewMs-(now()-(r.lastOutputAt??r.startedAt))));
        const ms=Math.max(1,Math.min(...deadlines));let timer;
        try{await Promise.race([wake.promise,Promise.race(pending.map(r=>r.promise)),new Promise(resolve=>{timer=setTimeout(resolve,ms);})]);}
        finally{clearTimeout(timer);}
        if(pending.some(r=>!r.settled&&now()>r.deadlineAt))throw uncertain(pending.find(r=>!r.settled)?.execution,'后台命令结果未能确认，已阻止继续执行');
      }
    },
    takeCompleted,
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
    async abort() {
      const owned = [...active];
      for (const record of owned) record.controller.abort();
      const results = await Promise.allSettled(owned.map(record => commandDeadline(record.promise,settleTimeoutMs,'命令取消未能确认完成，已阻止后续执行')));
      completed.length = 0;
      if(quarantine)throw quarantine;
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw uncertain(currentExecutionScope()?.execution,failure.reason.message);
      if (results.some(result => !result.value.cleanupConfirmed)) throw uncertain(currentExecutionScope()?.execution,'命令所属进程未确认退出，请核对后重启运行时');
    },
  };
}
