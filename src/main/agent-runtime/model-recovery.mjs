import { randomUUID } from 'node:crypto';

export const RECOVERY_WINDOW_MS = 30 * 60 * 1000;
export const RECOVERY_DELAYS_MS = Object.freeze([1000, 2000, 5000, 10000, 20000, 30000, 60000]);
export const recoveryDelayMs = attempt => RECOVERY_DELAYS_MS[Math.min(Math.max(0, attempt - 1), RECOVERY_DELAYS_MS.length - 1)];

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, (Date.parse(value) || now) - now);
}

/** Classify the HTTP boundary before a provider's SDK flattens it to errorMessage. */
export function classifyModelFailure({ status = null, message = '', code = '', aborted = false } = {}) {
  const text = `${code} ${message}`;
  if (aborted || /AbortError|HEMI_RECOVERY_|运行请求上限|执行归属|预算|unsupported.modality/i.test(text)) return null;
  if (/quota|credit|balance|billing|payment.required|余额|配额|额度/i.test(text)) return null;
  if ([400, 401, 403, 404, 405, 413, 422].includes(status)
    || /invalid.?api.?key|authentication|unauthorized|context.*(length|window|limit)|上下文.*(超|限)|invalid.request/i.test(text)) return null;
  if (status === 429) return { category: 'rate-limit', summary: '服务请求较多' };
  if ([408, 500, 502, 503, 504].includes(status)) return { category: 'service', summary: `模型服务暂时不可用（HTTP ${status}）` };
  if (/ENETDOWN|ENETUNREACH|EHOSTUNREACH/i.test(text)) return { category: 'offline', summary: '网络暂时不可达' };
  if (/ECONN|ENOTFOUND|EAI_AGAIN|UND_ERR|fetch failed|connection error|network error|socket|terminated|connection.*(closed|reset)|timeout|timed.out|超时|连接中断/i.test(text)) {
    return { category: 'network', summary: '模型连接中断' };
  }
  return null;
}

/** One owner per logical model request. All retries share its deadline and AbortSignal. */
export function createModelRecovery({ signal, isOnline = () => true, onState = () => {}, now = Date.now,
  timers = { setTimeout, clearTimeout }, windowMs = RECOVERY_WINDOW_MS } = {}) {
  let state = null, wake = null, disposed = false;
  const publish = (phase, patch = {}) => {
    state = { ...state, ...patch, phase, updatedAt: now() };
    const record = { at: now(), phase, attempt: state.attempt, summary: state.summary };
    state.history = [...(state.history ?? []), record].slice(-64);
    onState(structuredClone(state));
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
      state ??= { id: randomUUID(), firstFailureAt: now(), deadlineAt: now() + windowMs, attempt: 0, attemptsMade: 0, history: [] };
      const attempt = state.attempt + 1;
      const notBefore = Math.max(now() + 1000, now() + (failure.retryAfterMs ?? 0));
      const nextRetryAt = Math.max(now() + recoveryDelayMs(attempt), notBefore);
      publish(isOnline() ? 'waiting' : 'offline', { ...classification, attempt, notBefore, nextRetryAt: Math.min(nextRetryAt, state.deadlineAt) });
      try { await waitUntil(Math.min(nextRetryAt, state.deadlineAt)); }
      catch (error) { publish('stopped', { nextRetryAt: null }); throw error; }
      if (now() >= state.deadlineAt) { publish('expired', { nextRetryAt: null, summary: '自动恢复已到期（30 分钟）' }); return false; }
      // Offline checks are bounded by the same absolute deadline, without issuing HTTP.
      while (!isOnline()) {
        publish('offline', { nextRetryAt: Math.min(now() + 60000, state.deadlineAt) });
        try { await waitUntil(state.nextRetryAt); }
        catch (error) { publish('stopped', { nextRetryAt: null }); throw error; }
        if (now() >= state.deadlineAt) { publish('expired', { nextRetryAt: null, summary: '自动恢复已到期（30 分钟）' }); return false; }
      }
      publish('connecting', { nextRetryAt: null, attemptsMade: attempt });
      return true;
    },
    success() { if (state && !signal?.aborted) publish('recovered', { nextRetryAt: null }); },
    dispose() { disposed = true; wake?.(); wake = null; },
  };
}
