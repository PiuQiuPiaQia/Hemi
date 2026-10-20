/**
 * Pi 会话工厂的共用件（056 起主 agent 与子 agent 共用，经 hemi-session）。
 *
 * 038 路由虚拟模型扩展（hemi-routing，056 起只承担备用故障切换）。
 * 模型定义统一在 lib/pi-model.mjs。SDK 事实（探针 pi-sdk-probe /
 * pi-056-agent-probe，1.0.0）：DefaultResourceLoader 必须先 await reload() 内联
 * 工厂才执行；dispose 后 prompt 静默返回（调用方各自做 epoch 守卫）。
 */

import { isContextOverflow, isRecoverableLength, isRetryableAssistantError } from '@earendil-works/pi-ai/compat';
import { isSameCandidate, RoutingStoppedError, routeStopReason } from '../lib/model-routing.mjs';
import { MODEL_OUTPUT_LIMIT, providerRegistrationOf, sdkThinkingLevelOf } from '../lib/pi-model.mjs';

/**
 * 038：SDK 虚拟模型扩展——主/备物理 provider + route 闭包（探针口径）。
 * routing＝{ execution: 会话主候选（主 agent 的所选模型或子 agent 的角色模型）, fallback }。
 *
 * @param {object} options
 * @param {{execution: object, fallback: object|null, requireVision?: boolean}} options.routing 候选快照
 * @param {{state: {slot: 'primary'|'fallback', fallbackUsed: boolean}}} options.runtime 路由运行态（闭包持有）
 * @param {(event: {to: object, fallbackUsed: boolean}) => void} [options.onRoute] 切换通知（宿主记账/日志）
 * @param {string} [options.name] 扩展名（日志用）
 */
export function createRoutingExtension({ routing, runtime, onRoute = null, name = 'hemi-routing' }) {
  const candidates = [routing.execution, ...(routing.fallbacks?.length ? routing.fallbacks : routing.fallback ? [routing.fallback] : [])];
  const providerOf = index => index === 0 ? 'hemi' : index === 1 ? 'hemi-fallback' : `hemi-fallback-${index}`;
  return {
    name,
    factory: (pi) => {
      pi.registerProvider('hemi', providerRegistrationOf(routing.execution));
      candidates.slice(1).forEach((candidate, index) => pi.registerProvider(providerOf(index + 1), providerRegistrationOf(candidate)));
      pi.registerVirtualModel({
        provider: name,
        id: 'auto',
        name: 'Hemi 自动路由',
        thinkingLevels: ['off', 'low', 'medium', 'high'],
        route: (request, ctx) => {
          // 057：state 带 epoch——宿主回合重置（resetRoutingForApplicationTurn）递增
          // epoch 后，SDK 回传的旧代 state 作废，改用宿主持有的新 state。否则 SDK 会把
          // 上一回合的备用 state 原样送回来，宿主重置被冲掉。
          const runtimeEpoch = runtime.epoch ?? 0;
          const incoming = request.reason !== 'direct' && request.state ? request.state : null;
          const incomingEpoch = incoming ? incoming.epoch ?? 0 : 0;
          const useIncoming = incoming && incomingEpoch === runtimeEpoch;
          const state = useIncoming ? incoming : runtime.state;
          if (useIncoming) {
            runtime.state = incoming;
          }
          const thinkingOf = (c) => sdkThinkingLevelOf(c.thinkingLevel);
          const indexOf = s => s.candidateIndex ?? (s.slot === 'fallback' ? 1 : 0);
          const physical = (c) => ctx.modelRegistry.find(providerOf(candidates.indexOf(c)), c.model);
          const candidateOf = s => candidates[indexOf(s)] ?? routing.execution;
          let next = state;
          // SDK 的 user 理由不能区分应用新回合与队列消费，备用重置由宿主边界负责。
          if (request.reason === 'retry') {
            const failed = request.failed?.message ?? null;
            // 上下文/长度超限走 SDK 原有压缩恢复，不消耗备用机会（返回当前 state）。
            const contextOverflow = Boolean(
              failed && (isContextOverflow(failed) || isRecoverableLength(failed, request.failed?.model?.maxTokens ?? MODEL_OUTPUT_LIMIT)),
            );
            // 已有内容（含思考/工具片段）或执行状态未知的工具不换模型恢复。
            const consumed = Array.isArray(failed?.content)
              && failed.content.some((part) => (part?.type === 'text' ? Boolean(part.text?.trim()) : Boolean(part)));
            if (!contextOverflow) {
              if (/\b(401|403)\b|invalid.?api.?key|authentication|凭据|运行请求上限/i.test(failed?.errorMessage ?? '')) throw new RoutingStoppedError('身份／权限或运行上限错误，不切备用', failed?.errorMessage);
              const nextIndex = indexOf(state) + 1;
              const nextCandidate = candidates[nextIndex];
              const stop = !nextCandidate && indexOf(state) > 0 ? 'fallback-exhausted' : routeStopReason({
                hasFallback: Boolean(nextCandidate),
                fallbackUsed: false,
                outputStarted: consumed,
                requireVision: routing.requireVision,
                fallbackSupportsVision: nextCandidate?.supportsVision ?? false,
                fallbackDuplicate: isSameCandidate(candidateOf(state), nextCandidate),
              });
              if (stop) {
                // SDK 以原失败收口（备用失败／不满足条件）。
                throw new RoutingStoppedError(stop, failed?.errorMessage ?? request.failed?.message?.stopReason);
              }
              next = { slot: 'fallback', fallbackUsed: true, candidateIndex: nextIndex };
            }
          }
          // state 不变化时返回原对象，避免每轮追加相同条目；变化回传宿主。
          const unchanged = indexOf(next) === indexOf(state) && next.fallbackUsed === state.fallbackUsed;
          const outgoing = unchanged ? state : next;
          if (!unchanged) {
            runtime.state = outgoing;
            const to = candidateOf(outgoing);
            onRoute?.({
              to: { modelKey: to.modelKey, name: to.name, model: to.model },
              fallbackUsed: outgoing.fallbackUsed,
            });
          }
          return {
            model: physical(candidateOf(outgoing)),
            thinkingLevel: thinkingOf(candidateOf(outgoing)),
            state: request.reason === 'direct'
              ? undefined
              : { ...outgoing, epoch: runtimeEpoch },
          };
        },
      });
    },
  };
}

/**
 * 057（AC-32）：新的**应用回合**边界重置备用——只在宿主发起用户／队列回合（prompt）
 * 时调用。SDK 的 request.reason=user 不再承担该判定：并入（steer）消化的请求同样带
 * reason=user（探针 pi-057-flow-probe B6a/B6b），沿用旧口径会把同一应用运行内的并入
 * 拉回主模型。返回是否发生实际切换（切换时经 onRoute 留痕，与 retry 切换同一出口）。
 */
export function resetRoutingForApplicationTurn({ routing, runtime, onRoute = null }) {
  const prev = runtime.state;
  // epoch 递增：SDK 回传的旧代 state（含备用槽位）自此作废。
  runtime.epoch = (runtime.epoch ?? 0) + 1;
  if (prev.slot === 'primary' && !prev.fallbackUsed) return false;
  runtime.state = { slot: 'primary', fallbackUsed: false };
  const to = routing.execution;
  onRoute?.({ to: { modelKey: to.modelKey, name: to.name, model: to.model }, fallbackUsed: false });
  return true;
}

/** SDK 重试预算耗尽时不会再调用 route；只在最终收口时按实际候选补原因，不改 SDK 历史。 */
export function settledRoutingError(message, { routing, state, aborted = false, outputStarted = false }) {
  if (!message || aborted || String(message).includes('HEMI_ROUTING_STOPPED:')) return message;
  if (!isRetryableAssistantError({ stopReason: 'error', errorMessage: String(message) })) return message;
  if (outputStarted) return new RoutingStoppedError('output-started', message).message;
  if (!routing) return new RoutingStoppedError('no-fallback', message).message;
  const index = state?.candidateIndex ?? (state?.slot === 'fallback' ? 1 : 0);
  const fallbackCount = routing.fallbacks?.length || (routing.fallback ? 1 : 0);
  return index > 0 && index >= fallbackCount
    ? new RoutingStoppedError('fallback-exhausted', message).message : message;
}

/**
 * 会话级 SDK settings（038：路由会话的重试预算＝主候选一次＋切备用一次；
 * provider 内部重试关，探针 R4 口径）。非路由会话原样返回注入值。
 * compaction 是否打开由调用方经 settings 决定（主 agent 开——历史由 SDK
 * 自动压缩管理；子 agent 维持 SDK 默认）。
 */
export function sessionSettingsOf({ routing = false, settings = {} } = {}) {
  if (!routing) return settings;
  return {
    ...settings,
    retry: {
      ...(settings.retry ?? {}),
      enabled: true,
      maxAgentDelayMs: routing.maxRetryDelayMs ?? 10000,
      maxRetries: typeof routing === 'object' ? Math.max(1, routing.fallbacks?.length ?? 1) : 1,
      provider: { ...(settings.retry?.provider ?? {}), maxRetries: 0 },
    },
  };
}
