import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { hydrateCandidate } from './model-policy.mjs';

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const candidateIndex = provider => provider === 'hemi-fallback' ? 1 : /^hemi-fallback-\d+$/.test(provider) ? Number(provider.split('-').at(-1)) : 0;
export function usageOf(message) {
  const usage = message?.usage;
  if (!usage || !['input','output','cacheRead','cacheWrite'].some(key => Number(usage[key]) > 0)) return { uncachedInput: null, output: null, cacheRead: null, cacheWrite: null };
  return { uncachedInput: Number(usage.input) || 0, output: Number(usage.output) || 0, cacheRead: Number(usage.cacheRead) || 0, cacheWrite: Number(usage.cacheWrite) || 0 };
}

/** 包住 SDK 共用 streamFunction，压缩同样经过这里；fetch 边界逐次记真实 HTTP 尝试。 */
export function controlledStream(stream, getExecution) {
  return (model, context, options = {}) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const execution = getExecution();
      const ids = [];
      let finalMessage, boundaryFailure;
      try {
        if (!execution || execution.cancelled?.() || execution.fatalError) throw new Error(execution?.fatalError ?? '执行归属已失效');
        const plan = execution.plan;
        const candidate = [plan.primary, ...plan.allowedFallbacks][candidateIndex(model.provider)];
        if (!candidate || candidate.model !== model.id) throw new Error('实际模型不在冻结计划中');
        if (candidate.supportsVision !== true && (context.messages ?? []).some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image'))) throw new Error('unsupported-modality：实际候选不支持历史中的图像，未删图或发出请求');
        const live = await hydrateCandidate(candidate, execution.store);
        execution.onCandidateSelected?.(candidate);
        await execution.beforeRequest?.();
        const logicalCallId = `call-${randomUUID()}`;
        const messages = context.messages ?? [];
        const hasTools = context.tools?.length || messages.some(message => message.role === 'system' && (message.toolsAdded?.length));
        const purpose = execution.purpose && !['main','subagent'].includes(execution.purpose) ? execution.purpose : execution.compacting?.() || !hasTools ? 'compaction' : execution.purpose;
        const trackedFetch = async (url, init) => {
          if (execution.cancelled?.()) throw new Error('执行归属已失效');
          const requestId = `request-${randomUUID()}`;
          const { apiKey: _secret, encryptedApiKey: _encrypted, ...publicCandidate } = candidate;
          try { await execution.journal.requestStart(execution.owner, { requestId, logicalCallId, purpose, role: plan.role, actualModel: publicCandidate, cost: { status: 'unknown' } }, execution.budgets.maxRequestsPerRun); }
          catch (error) { boundaryFailure = error; throw error; }
          ids.push(requestId);
          try {
            const response = await (options.fetch ?? globalThis.fetch)(url, init);
            await execution.journal.requestEnd(requestId, { httpStatus: response.status, coverage: 'unknown' });
            return response;
          } catch (error) {
            await execution.journal.requestEnd(requestId, { error: String(error.message), coverage: 'unknown' }); throw error;
          }
        };
        const inner = await stream(model, context, { ...options, apiKey: live.apiKey, maxRetries: 0, fetch: trackedFetch });
        for await (const event of inner) {
          if (event.type === 'done' || event.type === 'error') finalMessage = event.message ?? event.error;
          else output.push(event);
        }
        const tokenUsage = usageOf(finalMessage);
        for (const [index, requestId] of ids.entries()) await execution.journal.requestEnd(requestId, {
          tokenUsage: index === ids.length - 1 ? tokenUsage : { uncachedInput: null, output: null, cacheRead: null, cacheWrite: null },
          coverage: index === ids.length - 1 && tokenUsage.uncachedInput !== null ? 'complete' : 'unknown',
          error: finalMessage?.errorMessage ?? null,
        });
        execution.onRequestRecorded?.();
        if (boundaryFailure && !ids.length) throw boundaryFailure;
        if (!ids.length) throw new Error(finalMessage?.errorMessage ?? 'provider 没有经过受控 HTTP 请求边界，无法确认实际模型请求');
        if (!finalMessage) throw new Error('provider 流未返回终态');
        output.push(finalMessage.stopReason === 'error' || finalMessage.stopReason === 'aborted'
          ? { type: 'error', reason: finalMessage.stopReason, error: finalMessage }
          : { type: 'done', reason: finalMessage.stopReason, message: finalMessage });
      } catch (error) {
        const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: options.signal?.aborted ? 'aborted' : 'error', errorMessage: error.message, timestamp: Date.now() };
        output.push({ type: 'error', reason: message.stopReason, error: message });
      } finally { output.end(); }
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
