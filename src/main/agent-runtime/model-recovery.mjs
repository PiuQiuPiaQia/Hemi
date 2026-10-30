import { randomUUID } from 'node:crypto';
import { modelFailure } from './model-failure.mjs';

export const RECOVERY_WINDOW_MS = 30 * 60 * 1000;
export const RECOVERY_DELAYS_MS = Object.freeze([1000, 2000, 5000, 10000, 20000, 30000, 60000]);
export const recoveryDelayMs = attempt => RECOVERY_DELAYS_MS[Math.min(Math.max(0, attempt - 1), RECOVERY_DELAYS_MS.length - 1)];

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, (Date.parse(value) || now) - now);
}

/** Classify the HTTP boundary before a provider's SDK flattens it to errorMessage. */
export function classifyModelFailure(input = {}) {
  const failure = input.kind ? input : modelFailure({ ...input, aborted: input.aborted || /AbortError/i.test(input.message ?? '') });
  if (!failure.retryable) return null;
  const category = ['timeout', 'transport'].includes(failure.kind) ? 'network' : failure.kind;
  return { category, summary: category === 'service' ? `模型服务暂时不可用（HTTP ${failure.httpStatus}）` : category === 'rate-limit' ? '服务请求较多' : category === 'offline' ? '网络暂时不可达' : '模型连接中断' };
}

/** One owner per logical model request. All retries share its deadline and AbortSignal. */
export function createModelRecovery({ signal, isOnline = () => true, onState = () => {}, now = Date.now,
  timers = { setTimeout, clearTimeout }, windowMs = RECOVERY_WINDOW_MS } = {}) {
  let state = null, wake = null, disposed = false;
  const publish = (phase, patch = {}) => {
    state = { ...state, ...patch, phase, updatedAt: now() };
    const record = { at: now(), phase, attempt: state.attempt, summary: state.summary };
    state.history = [...(state.history ?? []), record].slice(-64);
    return onState(structuredClone(state));
  };
  const check = () => {
    if (disposed || signal?.aborted) throw signal?.reason ?? new DOMException('已停止恢复', 'AbortError');
  };
  async function waitUntil(target) {
    let immediate = false;
    while (now() < target && !immediate) {
      check();
      await new Promise((resolve, reject) => {
        const cleanup = () => { timers.clearTimeout(timer); signal?.removeEventListener('abort', abort); wake = null; };
        const finish = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('已停止恢复', 'AbortError')); };
        const timer = timers.setTimeout(finish, Math.min(60000, Math.max(1, target - now())));
        wake = () => { immediate = true; finish(); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    check();
  }
  return {
    get state() { return state; },
    tryNow(id) {
      if (id !== state?.id || !wake || disposed || signal?.aborted || now() < state.notBefore || now() >= state.deadlineAt) return false;
      const resume = wake; wake = null; resume(); return true;
    },
    async failed(failure) {
      check();
      const classification = classifyModelFailure(failure);
      if (!classification) return false;
      // 期限锚定同一次 now()：两次取时在 Windows 时钟粒度下会漂 1ms，deadlineAt 必须精确等于窗口终点。
      const firstFailureAt = now();
      state ??= { id: randomUUID(), firstFailureAt, deadlineAt: firstFailureAt + windowMs, attempt: 0, attemptsMade: 0, history: [] };
      const attempt = state.attempt + 1;
      const notBefore = Math.max(now() + 1000, now() + (failure.retryAfterMs ?? 0));
      const nextRetryAt = Math.max(now() + recoveryDelayMs(attempt), notBefore);
      await publish(isOnline() ? 'waiting' : 'offline', { ...classification, attempt, notBefore, nextRetryAt: Math.min(nextRetryAt, state.deadlineAt) });
      try { await waitUntil(Math.min(nextRetryAt, state.deadlineAt)); }
      catch (error) { await publish('stopped', { nextRetryAt: null }); throw error; }
      if (now() >= state.deadlineAt) { await publish('expired', { nextRetryAt: null, summary: '自动恢复已到期（30 分钟）' }); return false; }
      // Offline checks are bounded by the same absolute deadline, without issuing HTTP.
      while (!isOnline()) {
        await publish('offline', { nextRetryAt: Math.min(now() + 60000, state.deadlineAt) });
        try { await waitUntil(state.nextRetryAt); }
        catch (error) { await publish('stopped', { nextRetryAt: null }); throw error; }
        if (now() >= state.deadlineAt) { await publish('expired', { nextRetryAt: null, summary: '自动恢复已到期（30 分钟）' }); return false; }
      }
      await publish('connecting', { nextRetryAt: null, attemptsMade: attempt });
      return true;
    },
    async success() { if (state && !signal?.aborted) await publish('recovered', { nextRetryAt: null }); },
    dispose() { disposed = true; wake?.(); wake = null; },
  };
}
