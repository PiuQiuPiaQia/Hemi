/** Retry state writes only. Execution/admission must keep their own durable boundary. */
export function createPersistenceRetry(retry) {
  const delays = [1000, 2000, 5000, 10000, 30000, 60000];
  let timer = null, attempt = 0, disposed = false;
  const reset = () => { clearTimeout(timer); timer = null; attempt = 0; };
  const schedule = () => {
    if (disposed || timer) return;
    timer = setTimeout(async () => {
      timer = null;
      try { await retry(); reset(); }
      catch { schedule(); }
    }, delays[Math.min(attempt++, delays.length - 1)]);
    timer.unref?.();
  };
  return { schedule, reset, dispose() { disposed = true; reset(); } };
}
