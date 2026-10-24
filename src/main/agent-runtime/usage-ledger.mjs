import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { hydrateCandidate } from './model-policy.mjs';
import { createModelRecovery, retryAfterMs } from './model-recovery.mjs';
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
      const recovery = createModelRecovery({ signal: options.signal, isOnline: execution?.isOnline,
        onState: state => execution?.onRecovery?.(state), ...(execution?.recoveryTestClock ?? {}) });
      execution?.onRecoveryControl?.(recovery);
      let finalMessage, boundaryFailure, startForwarded = false, retrying = false;
      const failedMessage = error => ({ role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: zeroUsage(), stopReason: options.signal?.aborted ? 'aborted' : 'error', errorMessage: String(error.message ?? error), timestamp: Date.now() });
      try {
        if (!execution || execution.cancelled?.() || execution.fatalError) throw new Error(execution?.fatalError ?? '执行归属已失效');
        const plan = execution.plan;
        const candidate = [plan.primary, ...plan.allowedFallbacks][candidateIndex(model.provider)];
        if (!candidate || candidate.model !== model.id) throw new Error('实际模型不在冻结计划中');
        if (candidate.supportsVision !== true && (context.messages ?? []).some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image'))) throw new Error('unsupported-modality：实际候选不支持历史中的图像，未删图或发出请求');
        // The SDK may update its live message while streaming. Retries always use the pre-request context.
        const logicalCallId = `call-${randomUUID()}`;
        const hasTools = context.tools?.length || context.messages?.some(message => message.role === 'system' && message.toolsAdded?.length);
        const purpose = execution.purpose && !['main','subagent'].includes(execution.purpose) ? execution.purpose : execution.compacting?.() || !hasTools ? 'compaction' : execution.purpose;
        const endpoint = `${candidate.api}:${candidate.baseUrl}`;
        let projection = await projectImages(context.messages ?? [], { mode: reducedEndpoints.has(endpoint) ? 'retry' : 'normal', signal: options.signal });
        const requestContext = { ...context, messages: structuredClone(projection.messages) };
        if (projection.stats.omitted || projection.stats.resized) execution.onImageProjection?.(projection.stats);
        let mediaRetried = false;
        execution.onRequestStart?.();
        while (true) {
          options.signal?.throwIfAborted();
          if (execution.cancelled?.()) throw new DOMException('执行归属已失效', 'AbortError');
          const live = await hydrateCandidate(candidate, execution.store);
          execution.onCandidateSelected?.(candidate);
          await execution.beforeRequest?.();
          const ids = [], failure = {};
          const attempt = new AbortController();
          const signal = options.signal ? AbortSignal.any([options.signal, attempt.signal]) : attempt.signal;
          let timedOut = false, resetSent = !retrying, responseStarted = false;
          const timeoutMs = recovery.state ? Math.min(15000, Math.max(1, recovery.state.deadlineAt - (execution.recoveryTestClock?.now ?? Date.now)())) : 60000;
          let timeout = setTimeout(() => { timedOut = true; attempt.abort(new Error('模型连接超时')); }, timeoutMs);
          const trackedFetch = async (url, init) => {
            if (execution.cancelled?.() || signal.aborted) throw signal.reason ?? new DOMException('执行归属已失效', 'AbortError');
            const requestId = `request-${randomUUID()}`;
            const { apiKey: _secret, encryptedApiKey: _encrypted, ...publicCandidate } = candidate;
            try { await execution.journal.requestStart(execution.owner, { requestId, logicalCallId, purpose, role: plan.role, actualModel: publicCandidate, cost: { status: 'unknown' } }, execution.budgets.maxRequestsPerRun); }
            catch (error) { boundaryFailure = error; throw error; }
            ids.push(requestId);
            try {
              const response = await (options.fetch ?? globalThis.fetch)(url, { ...init, signal });
              failure.status = response.status;
              failure.retryAfterMs = retryAfterMs(response.headers?.get('retry-after'));
              await execution.journal.requestEnd(requestId, { httpStatus: response.status, coverage: 'unknown' });
              return response;
            } catch (error) {
              failure.code = error.cause?.code ?? error.code;
              await execution.journal.requestEnd(requestId, { error: String(error.message), coverage: 'unknown' }); throw error;
            }
          };
          finalMessage = null;
          try {
            const inner = await stream(model, { ...requestContext, messages: structuredClone(requestContext.messages) }, { ...options, apiKey: live.apiKey, maxRetries: 0, signal, fetch: trackedFetch });
            for await (const event of inner) {
              if (options.signal?.aborted || execution.cancelled?.()) throw new DOMException('已停止恢复', 'AbortError');
              if (event.type === 'done' || event.type === 'error') finalMessage = event.message ?? event.error;
              else if (event.type === 'start') {
                if (!startForwarded) { output.push(event); startForwarded = true; }
              } else {
                if (!resetSent) { execution.onRequestReset?.(); resetSent = true; }
                if ((event.type.endsWith('_delta') && event.delta) || event.type === 'toolcall_end') { responseStarted = true; clearTimeout(timeout); timeout = null; }
                output.push(event);
              }
            }
          } catch (error) { finalMessage = failedMessage(error); }
          finally { clearTimeout(timeout); }
          if (timedOut && !options.signal?.aborted) finalMessage = failedMessage(new Error('模型连接超时'));
          const tokenUsage = usageOf(finalMessage);
          for (const [index, requestId] of ids.entries()) await execution.journal.requestEnd(requestId, {
            tokenUsage: index === ids.length - 1 ? tokenUsage : { uncachedInput: null, output: null, cacheRead: null, cacheWrite: null },
            coverage: index === ids.length - 1 && tokenUsage.uncachedInput !== null ? 'complete' : 'unknown', error: finalMessage?.errorMessage ?? null,
          });
          execution.onRequestRecorded?.();
          if (boundaryFailure) throw boundaryFailure;
          if (!ids.length) throw new Error(finalMessage?.errorMessage ?? 'provider 没有经过受控 HTTP 请求边界，无法确认实际模型请求');
          if (!finalMessage) throw new Error('provider 流未返回终态');
          if (!['error','aborted'].includes(finalMessage.stopReason)) {
            if (!resetSent) execution.onRequestReset?.();
            if (mediaRetried) reducedEndpoints.add(endpoint);
            recovery.success();
            break;
          }
          // 参考 zcode 的 compact media retry：先缩减请求媒体，再重试同一次模型调用。
          // 不重跑工具、不切模型，也不让 413 进入三十分钟的网络重试。
          if (finalMessage.stopReason === 'error' && !responseStarted && isRequestMediaTooLarge({ ...failure, message: finalMessage.errorMessage })) {
            if (!mediaRetried && projection.stats.bytesAfter > 0) {
              const reduced = await projectImages(context.messages ?? [], { mode: 'retry', signal: options.signal });
              if (reduced.stats.bytesAfter < projection.stats.bytesAfter) {
                projection = reduced;
                requestContext.messages = structuredClone(reduced.messages);
                execution.onImageProjection?.(reduced.stats);
                mediaRetried = true;
                retrying = true;
                continue;
              }
            }
            const summary = failure.status === 413 || /\b413\b/.test(finalMessage.errorMessage ?? '')
              ? '模型请求体超过服务限制（HTTP 413）' : '模型图片请求超过服务限制';
            finalMessage = { ...finalMessage, errorMessage: `${summary}。请减少本轮附件或输入内容；原始会话记录已保留。` };
            break;
          }
          const enabled = ['main', 'subagent'].includes(execution.purpose);
          if (!enabled || !await recovery.failed({ ...failure, message: finalMessage.errorMessage,
            aborted: Boolean(options.signal?.aborted || execution.cancelled?.()) || (finalMessage.stopReason === 'aborted' && !timedOut) })) break;
          retrying = true;
        }
        if (recovery.state?.phase === 'expired') finalMessage = { ...finalMessage, errorMessage: 'HEMI_RECOVERY_EXPIRED: 自动恢复已到期（30 分钟）。当前进度已保留，可以稍后重新开始。' };
        output.push(['error','aborted'].includes(finalMessage.stopReason)
          ? { type: 'error', reason: finalMessage.stopReason, error: finalMessage }
          : { type: 'done', reason: finalMessage.stopReason, message: finalMessage });
      } catch (error) {
        const message = failedMessage(error);
        output.push({ type: 'error', reason: message.stopReason, error: message });
      } finally { recovery.dispose(); execution?.onRecoveryControl?.(null); output.end(); }
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
