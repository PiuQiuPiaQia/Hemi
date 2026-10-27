/** Provider text is interpreted only at this adapter boundary. Recovery uses failure facts. */
export function modelFailure({ status = null, message = '', code = '', aborted = false, phase = 'provider', outputStarted = false, timeoutPhase = null } = {}) {
  const text = `${code} ${message}`;
  const failure = (kind, retryable, summary) => ({ kind, code: kind.toUpperCase().replaceAll('-', '_'), retryable, phase, httpStatus: status, transportCode: code || null, outputStarted, message: summary });
  if (aborted) return failure('cancelled', false, '模型请求已停止');
  if (timeoutPhase) return { ...failure('timeout', true, { connection: '模型连接等待超时', 'first-output': '模型首个输出等待超时', idle: '模型输出流长时间没有新事件' }[timeoutPhase]), phase: timeoutPhase };
  if (/HEMI_RECOVERY_|运行请求上限|执行归属|预算/i.test(text)) return failure('budget', false, message);
  if (/quota|credit|balance|billing|payment.required|余额|配额|额度/i.test(text)) return failure('quota', false, message);
  if ([401, 403].includes(status) || /invalid.?api.?key|authentication|unauthorized|凭据/i.test(text)) return failure('auth', false, message);
  if (/context.*(length|window|limit)|上下文.*(超|限)/i.test(text)) return failure('context', false, message);
  if ([400, 404, 405, 413, 422].includes(status) || /unsupported.modality|invalid.request/i.test(text)) return failure('invalid-request', false, message);
  if (status === 429 || /rate.?limit|too many requests/i.test(text)) return failure('rate-limit', true, message || '模型服务请求较多');
  if ([408, 504].includes(status) || /timeout|timed.out|超时/i.test(text)) return failure('timeout', true, message);
  if ([500, 502, 503].includes(status)) return failure('service', true, message || `模型服务暂时不可用（HTTP ${status}）`);
  if (/ENETDOWN|ENETUNREACH|EHOSTUNREACH/i.test(text)) return failure('offline', true, message);
  if (/ECONN|ENOTFOUND|EAI_AGAIN|UND_ERR|fetch failed|connection error|network error|socket|terminated|connection.*(closed|reset)|连接中断/i.test(text)) return failure('transport', true, message);
  return failure('unknown', false, message);
}

export const MODEL_REQUEST_TIMEOUTS = Object.freeze({ connectionMs: 60000, firstOutputMs: 300000, idleMs: 300000 });

/** A request owns connection, first-output and idle deadlines; cancellation stays distinct. */
export function requestWatchdog({ controller, signal = controller.signal, timeouts = {}, remainingMs = () => Infinity, timers = { setTimeout, clearTimeout } }) {
  const policy = { ...MODEL_REQUEST_TIMEOUTS, ...timeouts };
  for (const value of Object.values(policy)) if (!Number.isFinite(value) || value <= 0) throw new Error('模型请求超时策略必须是正数');
  let timer, timeoutPhase = null, phase = 'connection';
  const arm = next => {
    timers.clearTimeout(timer);
    if (signal.aborted) return;
    phase = next;
    const limit = next === 'connection' ? policy.connectionMs : next === 'first-output' ? policy.firstOutputMs : policy.idleMs;
    timer = timers.setTimeout(() => {
      timeoutPhase = phase;
      controller.abort(Object.assign(new Error('模型请求超时'), { code: 'MODEL_REQUEST_TIMEOUT', phase }));
    }, Math.max(1, Math.min(limit, next === 'idle' ? Infinity : remainingMs())));
  };
  arm('connection');
  return {
    get phase() { return phase; },
    get timeoutPhase() { return timeoutPhase; },
    connected() { arm('first-output'); },
    activity() { arm('idle'); },
    wait(pending) {
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(pending).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
        if (signal.aborted) abort();
      });
    },
    dispose() { timers.clearTimeout(timer); },
  };
}
