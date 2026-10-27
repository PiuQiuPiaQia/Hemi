import { randomUUID } from 'node:crypto';
import { runCommand, commandToolResult } from './command-execution.mjs';
import { currentExecutionScope } from '../../agent-runtime/execution-scope.mjs';
import { processBirth } from '../../agent-runtime/owned-processes.mjs';
import { normalizeCommandDescription } from '../../../shared/command-display.mjs';

export const COMMAND_FOREGROUND_MS = 10_000;
export const COMMAND_TIMEOUT_MS = 30 * 60_000;
const sameOwner = (a, b) => a?.conversationId === b?.conversationId && a?.rootRunId === b?.rootRunId
  && a?.generation === b?.generation && a?.taskId === b?.taskId;
const outputTail = result => [result.stdout.slice(-2000), result.stderr.slice(-2000)].filter(Boolean).join('\n').slice(-2000);

/** 进程属于目标而非一次 SDK 请求。后台只交还模型调用，取消/退出仍确认进程树清理。 */
export function createCommandScope({ onChange = () => {}, now = Date.now } = {}) {
  const active = new Set(), completed = [];
  const view = record => ({
    id: record.id, toolCallId: record.toolCallId, command: record.command.slice(0, 8000),
    commandTruncated: record.command.length > 8000, description: record.description, lastOutputAt: record.lastOutputAt,
    startedAt: record.startedAt, endedAt: record.endedAt ?? null,
    status: record.result?.status ?? (record.error ? 'failed' : 'running'),
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
    return ready.map(record => ({ ...view(record), outputRef: record.outputRef,
      text: commandToolResult(record.result).content[0].text.slice(-12_000),
    }));
  };

  async function run(options) {
    const scope = currentExecutionScope(), execution = scope?.execution;
    if (execution?.cancelled?.()) throw new DOMException('目标已停止', 'AbortError');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const record = {
      id: `command-${randomUUID()}`, controller, owner: execution?.owner,
      toolCallId: scope?.toolCallId, command: options.command, startedAt: now(),
      description: normalizeCommandDescription(options.description), lastOutputAt: null,
      background: false, output: '', promise: null, settled: false,
    };
    const token = randomUUID();
    let registered = false, ready;
    const started = new Promise(resolve => { ready = resolve; });
    let lastProgress = 0, progressTimer;
    active.add(record);
    record.promise = runCommand({ ...options, signal: controller.signal, ownerToken: token,
      onOutput: result => {
        record.output = outputTail(result);
        record.lastOutputAt = now();
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
      onSpawn: async pid => {
        if (execution?.journal) {
          const birth = await processBirth(pid);
          await execution.journal.processStart({ id: record.id, token, pid, birth, owner: execution.owner,
            command: options.command, description: record.description, cwd: options.cwd, toolCallId: record.toolCallId,
          });
          registered = true;
        }
        await options.onSpawn?.(pid);
        ready();
      },
    }).then(async result => {
      record.result = result;
      record.output = outputTail(result);
      if (registered) {
        try {
          await execution.journal.processEnd(record.id, {
            state: result.cleanupConfirmed ? 'finished' : 'unknown', cleanupConfirmed: result.cleanupConfirmed,
            status: result.status, code: result.code, output: record.output, lastOutputAt: record.lastOutputAt,
          });
        } catch (error) {
          execution.fatalError = `命令退出事实保存失败：${error.message}`;
          throw error;
        }
      }
      if (!result.cleanupConfirmed && execution) {
        execution.cleanupUnconfirmed = true;
        execution.fatalError = '命令进程尚未确认退出，已停止后续操作；请核对后重启应用';
        throw new Error(execution.fatalError);
      }
      if (record.background && execution?.contextStore) {
        record.outputRef = await execution.contextStore.put({ owner: execution.owner, kind: 'tool',
          content: commandToolResult(result).content, source: { kind: 'tool', tool: 'bash' },
        });
        if (execution.allowedRefs && !execution.allowedRefs.includes(record.outputRef)) execution.allowedRefs.push(record.outputRef);
      }
      // 完整结果已有不可变快照，等待模型收口时只保留有界尾部。
      if (record.background) record.result = { ...result,
        stdout: result.stdout.slice(-12_000), stderr: result.stderr.slice(-12_000),
        truncated: result.truncated || result.stdout.length > 12_000 || result.stderr.length > 12_000,
      };
      return record.result;
    }).catch(error => { record.error = error; throw error; }).finally(() => {
      clearTimeout(progressTimer);
      record.settled = true;
      record.endedAt = now();
      ready();
      options.signal?.removeEventListener('abort', onAbort);
      active.delete(record);
      if (record.background) completed.push(record);
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
    if (registered) await execution.journal.processBackground(record.id);
    publish();
    return { status: 'background', jobId: record.id, cleanupConfirmed: false, code: null,
      stdout: '', stderr: '', background: true, startedAt: record.startedAt,
    };
  }

  return {
    run,
    takeCompleted,
    hasBackground: owner => backgroundFor(owner).length > 0,
    async waitForCompletion(owner) {
      const records = backgroundFor(owner);
      if (!records.some(r => r.settled) && records.length) {
        await Promise.race(records.map(r => r.promise));
      }
      return takeCompleted(owner);
    },
    async abort() {
      const owned = [...active];
      for (const record of owned) record.controller.abort();
      const results = await Promise.allSettled(owned.map(record => record.promise));
      completed.length = 0;
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      if (results.some(result => !result.value.cleanupConfirmed)) throw new Error('命令所属进程未确认退出，请核对后继续');
    },
  };
}
