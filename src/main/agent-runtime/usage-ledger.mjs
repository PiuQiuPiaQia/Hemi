import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { hydrateCandidate } from './model-policy.mjs';
import { createModelRecovery, retryAfterMs } from './model-recovery.mjs';
import { modelFailure, requestWatchdog } from './model-failure.mjs';
import { piModelOf, sdkThinkingLevelOf } from '../lib/pi-model.mjs';
import { isSameCandidate } from '../lib/model-routing.mjs';
import { createRequestImageProjector, isRequestMediaTooLarge } from './request-images.mjs';

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const candidateIndex = provider => provider === 'hemi-fallback' ? 1 : /^hemi-fallback-\d+$/.test(provider) ? Number(provider.split('-').at(-1)) : 0;
export function usageOf(message) {
  const usage = message?.usage;
  if (!usage || !['input','output','cacheRead','cacheWrite'].some(key => Number(usage[key]) > 0)) return { uncachedInput: null, output: null, cacheRead: null, cacheWrite: null };
  return { uncachedInput: Number(usage.input) || 0, output: Number(usage.output) || 0, cacheRead: Number(usage.cacheRead) || 0, cacheWrite: Number(usage.cacheWrite) || 0 };
}

/** 包住 SDK 共用 streamFunction，压缩同样经过这里；fetch 边界逐次记真实 HTTP 尝试。 */
export function controlledStream(stream, getExecution) {
  const projectImages = createRequestImageProjector();
  const reducedEndpoints = new Set();
  return (model, context, options = {}) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const execution = getExecution();
      let lastRequestId = null, finalMessage, physical = model;
      const recovery = createModelRecovery({ signal: options.signal, isOnline: execution?.isOnline,
        onState: async state => {
          if (lastRequestId) await execution.journal.requestRecovery(lastRequestId, state);
          execution?.onRecovery?.(state);
        }, ...(execution?.recoveryTestClock ?? {}) });
      execution?.onRecoveryControl?.(recovery);
      const failedMessage = error => ({ role: 'assistant', content: [], api: physical.api, provider: physical.provider, model: physical.id,
        usage: zeroUsage(), stopReason: options.signal?.aborted ? 'aborted' : 'error', errorMessage: String(error.message ?? error), timestamp: Date.now() });
      let boundaryFailure, startForwarded = false, retrying = false;
      try {
        if (!execution || execution.cancelled?.() || execution.fatalError) throw new Error(execution?.fatalError ?? '执行归属已失效');
        const plan = execution.plan, candidates = [plan.primary, ...plan.allowedFallbacks];
        if (model.provider !== 'hemi-routing' && candidates[candidateIndex(model.provider)]?.model !== model.id) throw new Error('实际模型不在冻结计划中');
        let index = execution.selectedCandidateIndex ?? candidateIndex(model.provider);
        if (!candidates[index]) throw new Error('实际模型不在冻结计划中');
        const logicalCallId = `call-${randomUUID()}`;
        const hasTools = context.tools?.length || context.messages?.some(message => message.role === 'system' && message.toolsAdded?.length);
        const purpose = execution.purpose && !['main','subagent'].includes(execution.purpose) ? execution.purpose : execution.compacting?.() || !hasTools ? 'compaction' : execution.purpose;
        const canRecover = ['main', 'subagent'].includes(execution.purpose) && !execution.compacting?.();
        const hasImages = (context.messages ?? []).some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image'));
        const originalContext = structuredClone(context.messages ?? []);
        let projection, mediaRetried = false, lastEndpoint;
        execution.onRequestStart?.();
        while (true) {
          options.signal?.throwIfAborted();
          if (execution.cancelled?.()) throw new DOMException('执行归属已失效', 'AbortError');
          const candidate = candidates[index];
          if (hasImages && candidate.supportsVision !== true) throw new Error('unsupported-modality：实际候选不支持历史中的图像，未删图或发出请求');
          const live = await hydrateCandidate(candidate, execution.store);
          physical = execution.resolveModel ? execution.resolveModel(candidate, index) : piModelOf(candidate, index === 0 ? 'hemi' : index === 1 ? 'hemi-fallback' : `hemi-fallback-${index}`);
          if (!physical) throw new Error('冻结候选没有注册到模型运行时');
          execution.onCandidateSelected?.(candidate, index);
          const endpoint = `${candidate.api}:${candidate.baseUrl}`;
          if (!projection || endpoint !== lastEndpoint) {
            projection = await projectImages(originalContext, { mode: reducedEndpoints.has(endpoint) ? 'retry' : 'normal', signal: options.signal });
            lastEndpoint = endpoint; mediaRetried = false;
            if (projection.stats.omitted || projection.stats.resized) execution.onImageProjection?.(projection.stats);
          }
          await execution.beforeRequest?.();
          const ids = [], attempts = new Map(), transport = {}, attempt = new AbortController();
          const signal = options.signal ? AbortSignal.any([options.signal, attempt.signal]) : attempt.signal;
          const timeouts = Object.fromEntries([['connectionMs','connectionTimeoutMs'],['firstOutputMs','firstOutputTimeoutMs'],['idleMs','streamIdleTimeoutMs']].filter(([, key]) => execution.budgets[key] !== undefined).map(([name,key]) => [name,execution.budgets[key]]));
          const watchdog = requestWatchdog({ controller: attempt, signal, timeouts,
            remainingMs: () => recovery.state ? recovery.state.deadlineAt - (execution.recoveryTestClock?.now ?? Date.now)() : Infinity });
          let resetSent = !retrying, responseStarted = false;
          const trackedFetch = async (url, init) => {
            if (execution.cancelled?.() || signal.aborted) throw signal.reason ?? new DOMException('执行归属已失效', 'AbortError');
            const requestId = `request-${randomUUID()}`;
            const { apiKey: _secret, encryptedApiKey: _encrypted, ...publicCandidate } = candidate;
            try { await execution.journal.requestStart(execution.owner, { requestId, logicalCallId, purpose, role: plan.role, candidateIndex: index, actualModel: publicCandidate, cost: { status: 'unknown' } }, execution.budgets.maxRequestsPerRun); }
            catch (error) { boundaryFailure = error; throw error; }
            ids.push(requestId); attempts.set(requestId, { startedAt: Date.now() }); lastRequestId = requestId;
            try {
              const response = await (options.fetch ?? globalThis.fetch)(url, { ...init, signal });
              transport.status = response.status;
              attempts.get(requestId).status = response.status;
              transport.retryAfterMs = retryAfterMs(response.headers?.get('retry-after'));
              watchdog.connected();
              // 收到响应头不是请求终态；额度与完成校验必须仍看见这次在途生成。
              try { await execution.journal.requestResponse(requestId, { httpStatus: response.status }); }
              catch (error) { boundaryFailure = error; throw error; }
              return response;
            } catch (error) {
              transport.code = error.cause?.code ?? error.code;
              transport.message = String(error.message);
              throw error;
            }
          };
          finalMessage = null;
          try {
            // 跨供应商时不继承上一候选的认证头；各 provider 注册负责自身请求认证。
            const { apiKey: _key, headers: _headers, env: _env, ...crossProviderOptions } = options;
            const requestOptions = physical.provider === model.provider ? options : crossProviderOptions;
            const inner = await watchdog.wait(stream(physical, { ...context, messages: structuredClone(projection.messages) }, { ...requestOptions,
              apiKey: live.apiKey, reasoning: physical.provider === model.provider ? options.reasoning : sdkThinkingLevelOf(candidate.thinkingLevel) === 'off' ? undefined : sdkThinkingLevelOf(candidate.thinkingLevel),
              maxTokens: Math.min(options.maxTokens ?? physical.maxTokens, physical.maxTokens), maxRetries: 0, signal, fetch: trackedFetch }));
            const iterator = inner[Symbol.asyncIterator]();
            try { while (true) {
              const next = await watchdog.wait(iterator.next());
              if (next.done) break;
              const event = next.value;
              if (options.signal?.aborted || execution.cancelled?.()) throw new DOMException('已停止恢复', 'AbortError');
              if (event.type === 'done' || event.type === 'error') finalMessage = event.message ?? event.error;
              else if (event.type === 'start') {
                if (!startForwarded) { output.push(event); startForwarded = true; }
              } else {
                watchdog.activity();
                if (!resetSent) { execution.onRequestReset?.(); resetSent = true; }
                if ((event.type.endsWith('_delta') && event.delta) || event.type === 'toolcall_end') responseStarted = true;
                output.push(event);
              }
            } } finally { if (signal.aborted) void Promise.resolve(iterator.return?.()).catch(() => {}); }
          } catch (error) { finalMessage = failedMessage(error); }
          finally { watchdog.dispose(); }
          if (watchdog.timeoutPhase && !options.signal?.aborted) finalMessage = failedMessage(signal.reason);
          const unsuccessful = !finalMessage || ['error','aborted'].includes(finalMessage.stopReason);
          const failure = unsuccessful ? modelFailure({ ...transport, phase: watchdog.phase, outputStarted: responseStarted,
            timeoutPhase: watchdog.timeoutPhase, message: finalMessage?.errorMessage ?? transport.message ?? 'provider 流未返回终态',
            aborted: Boolean(options.signal?.aborted || execution.cancelled?.()) || (finalMessage?.stopReason === 'aborted' && !watchdog.timeoutPhase) }) : null;
          if (failure) finalMessage = { ...(finalMessage ?? failedMessage(failure)), errorMessage: failure.message, stopReason: failure.kind === 'cancelled' ? 'aborted' : 'error' };
          const tokenUsage = usageOf(finalMessage);
          for (const [position, requestId] of ids.entries()) {
            const last = position === ids.length - 1, meta = attempts.get(requestId);
            const recordedFailure = last ? failure : meta.status >= 400 ? modelFailure({ status: meta.status, message: `HTTP ${meta.status}` }) : null;
            const recordedUsage = last ? tokenUsage : { uncachedInput: null, output: null, cacheRead: null, cacheWrite: null };
            const coverage = last && tokenUsage.uncachedInput !== null ? 'complete' : 'unknown';
            await execution.journal.requestEnd(requestId, { tokenUsage: recordedUsage, coverage, error: recordedFailure?.message ?? null, failure: recordedFailure });
            execution.onAttemptRecorded?.({ candidate, requestId, purpose, stopReason: recordedFailure ? 'error' : finalMessage?.stopReason,
              isError: Boolean(recordedFailure), coverage, tokenUsage: recordedUsage, startedAt: meta.startedAt, genMs: Date.now() - meta.startedAt });
          }
          execution.onRequestRecorded?.();
          if (boundaryFailure) throw boundaryFailure;
          if (!ids.length) throw new Error(finalMessage?.errorMessage ?? 'provider 没有经过受控 HTTP 请求边界，无法确认实际模型请求');
          if (!failure) {
            if (!resetSent) execution.onRequestReset?.();
            if (mediaRetried) reducedEndpoints.add(endpoint);
            await recovery.success();
            break;
          }
          if (!responseStarted && isRequestMediaTooLarge({ ...transport, message: failure.message })) {
            if (!mediaRetried && projection.stats.bytesAfter > 0) {
              const reduced = await projectImages(originalContext, { mode: 'retry', signal: options.signal });
              if (reduced.stats.bytesAfter < projection.stats.bytesAfter) {
                projection = reduced; mediaRetried = true; retrying = true;
                execution.onImageProjection?.(reduced.stats);
                continue;
              }
            }
            finalMessage.errorMessage = `${transport.status === 413 ? '模型请求体超过服务限制（HTTP 413）' : '模型图片请求超过服务限制'}。请减少本轮附件或输入内容；原始会话记录已保留。`;
            break;
          }
          if (!canRecover || !failure.retryable) break;
          // 已经输出的同一次请求只在原候选恢复；已提交工具结果在请求前历史中，不会重放。
          const next = responseStarted ? -1 : candidates.findIndex((item, i) => i > index && (!hasImages || item.supportsVision === true) && !isSameCandidate(candidate, item));
          if (!await recovery.failed({ ...failure, retryAfterMs: transport.retryAfterMs })) break;
          if (next >= 0) index = next;
          retrying = true;
        }
        if (recovery.state?.phase === 'expired') finalMessage = { ...finalMessage, errorMessage: 'HEMI_RECOVERY_EXPIRED: 自动恢复已到期（30 分钟）。当前进度已保留，可以稍后重新开始。' };
        output.push(['error','aborted'].includes(finalMessage.stopReason)
          ? { type: 'error', reason: finalMessage.stopReason, error: finalMessage }
          : { type: 'done', reason: finalMessage.stopReason, message: finalMessage });
      } catch (error) {
        const message = failedMessage(error);
        output.push({ type: 'error', reason: message.stopReason, error: message });
      } finally {
        recovery.dispose(); execution?.onRecoveryControl?.(null); execution?.onRequestEnd?.(); output.end();
      }
    })();
    return output;
  };
}

/** 真实请求账本的展示投影：角色来自冻结执行计划，与使用哪个模型无关。 */
export function usageRecordsFromJournal(state, conversationId) {
  return Object.values(state.requests).filter(row => row.owner.conversationId === conversationId).map(row => ({
    source: row.owner.taskId || row.purpose === 'subagent' ? 'task' : row.purpose === 'title' ? 'title' : 'chat',
    // 旧的 main 请求有明确身份；旧子请求没有角色时不猜测。
    role: row.role ?? (!row.owner.taskId && row.purpose === 'main' ? 'main' : undefined),
    modelKey: row.actualModel.modelKey ?? `${row.actualModel.baseUrl}/${row.actualModel.model}`,
    modelName: row.actualModel.name ?? row.actualModel.model,
    requestedModel: row.actualModel.model,
    input: row.tokenUsage?.uncachedInput ?? 0, output: row.tokenUsage?.output ?? 0,
    cacheRead: row.tokenUsage?.cacheRead ?? 0, cacheWrite: row.tokenUsage?.cacheWrite ?? 0,
    genMs: row.endedAt ? row.endedAt - row.startedAt : 0, at: row.startedAt, calls: 1,
    missing: row.coverage === 'complete' ? 0 : 1, purpose: row.purpose,
    coverage: row.coverage, costStatus: row.cost?.status ?? 'unknown', taskId: row.owner.taskId,
  }));
}
