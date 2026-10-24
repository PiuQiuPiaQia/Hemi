/**
 * Windows 原子写的瞬态 rename 重试：杀毒/索引器（Defender 常驻）会瞬时占用
 * rename 目标，EPERM/EACCES/EBUSY/ENOTEMPTY 一族在 win CI 与真机上间歇出现
 * （2026-10-20 win CI 实测：invocation-store 原子写 rename 被占用导致节点
 * node-error、续跑终态 failed）。短暂退避重试跨过窗口；非该族错误与重试耗尽
 * 如实抛出，不吞真故障。
 */

const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

/**
 * @param {(from: string, to: string) => Promise<unknown>} rename 底层 rename
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

/** Synchronous stores retain their atomic commit boundary during a transient lock. */
export function retryingRenameSync(rename, { attempts = 5, baseDelayMs = 10, sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  return (from, to) => {
    for (let attempt = 0; ; attempt += 1) {
      try { return rename(from, to); }
      catch (error) {
        if (!TRANSIENT_CODES.has(error?.code) || attempt === attempts) throw error;
        sleep(baseDelayMs * (attempt + 1));
      }
    }
  };
}
