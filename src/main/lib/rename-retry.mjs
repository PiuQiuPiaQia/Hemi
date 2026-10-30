/**
 * Windows atomic replacement can meet handles opened without FILE_SHARE_DELETE.
 * Retry transient sharing failures, never unlink the destination or swallow a
 * permanent error. Async callers retain their existing retry policy.
 */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

/**
 * @param {(from: string, to: string) => Promise<unknown>} rename
 * @param {{ attempts?: number, baseDelayMs?: number, sleep?: (ms: number) => Promise<void> }} [options]
 */
export function retryingRename(rename, { attempts = 5, baseDelayMs = 10, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  return async (from, to) => {
    let lastError = null;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      try {
        return await rename(from, to);
      } catch (error) {
        if (!TRANSIENT_CODES.has(error?.code) || attempt === attempts) throw error;
        lastError = error;
        await sleep(baseDelayMs * (attempt + 1));
      }
    }
    throw lastError;
  };
}

/**
 * Keep the synchronous commit boundary. Five retries previously allowed only
 * 150ms of backoff: a real Windows reader/scanner lock can outlast that.
 * Bound count AND elapsed time (including time spent inside renameSync).
 * Exhaustion propagates the last original filesystem error, not a timeout.
 */
export function retryingRenameSync(rename, {
  attempts = 30, baseDelayMs = 10, maxDelayMs = 100, maxElapsedMs = 3000,
  now = () => performance.now(),
  sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  return (from, to) => {
    const started = now();
    for (let attempt = 0; ; attempt += 1) {
      try { return rename(from, to); }
      catch (error) {
        const remaining = maxElapsedMs - (now() - started);
        if (!TRANSIENT_CODES.has(error?.code) || attempt === attempts || remaining <= 0) throw error;
        sleep(Math.min(baseDelayMs * (attempt + 1), maxDelayMs, remaining));
        if (now() - started >= maxElapsedMs) throw error;
      }
    }
  };
}
