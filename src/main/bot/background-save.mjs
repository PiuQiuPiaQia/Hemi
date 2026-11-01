import process from 'node:process';

/**
 * Transient Windows replacement failures worth a background retry: the commit
 * swap (`rename <uuid>.tmp -> state.json`) met a handle opened without
 * FILE_SHARE_DELETE. Scoped to rename commits so content serialization errors
 * and unrelated filesystem conditions (ENOSPC, ENOENT, ...) are never retried.
 */
const TRANSIENT_COMMIT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

export function isTransientRenameCommitError(error, platform = process.platform) {
  return platform === 'win32'
    && TRANSIENT_COMMIT_CODES.has(error?.code)
    && typeof error?.syscall === 'string'
    && error.syscall.startsWith('rename');
}

const defaultOnSaveError = (error, { attempts }) => {
  console.error(
    `[bot] state.json 后台保存失败（含首次尝试共 ${attempts} 次，已停止重试；修改仍在内存，下次变更会重新落盘）：`,
    error,
  );
};

const defaultOnNotifyError = (error) => {
  console.error('[bot] state.json 已落盘，但保存通知监听器失败：', error);
};

/**
 * Failure boundary for the debounced background save started by laterSave().
 *
 * The first attempt runs synchronously inside the timer callback and keeps the
 * historical commit semantics. If it fails with a transient Windows rename
 * error, exactly one background retry pass runs, yielding to the event loop
 * between attempts (the lock holder may need the loop to release). Every
 * attempt re-serializes the latest state — no stale snapshot is ever replayed
 * — and at most one retry pass is in flight. An explicit successful save
 * supersedes the pass via noteCommitted(), which frees the slot immediately so
 * the next save() can start a fresh pass or commit synchronously; the stale
 * pass drops out when it wakes up and can neither write, report, nor release
 * the slot a newer pass owns. Permanent failures or exhaustion are reported
 * exactly once through onError, never swallowed and never masquerading as a
 * successful save. A listener that throws after a successful commit is
 * isolated through onNotifyError and is never misread as a disk failure worth
 * retrying.
 *
 * `attempt` and `retryAttempt` must stay synchronous: a normal return still
 * means "durably written", so callers may rely on state.json being updated
 * when they observe them succeed.
 */
export function createBackgroundSaver({
  attempt,
  retryAttempt = attempt,
  committed,
  isRetryable = (error) => isTransientRenameCommitError(error),
  onError = defaultOnSaveError,
  onNotifyError = defaultOnNotifyError,
  yield: yieldTurn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryAttempts = 6,
  retryBaseDelayMs = 20,
  retryMaxDelayMs = 150,
  retryBudgetMs = 1000,
  now = Date.now,
} = {}) {
  // Identity of the single in-flight retry pass, or null. A token — not a
  // shared boolean — so superseding a pass frees the slot for the next save
  // while the stale pass can still recognize (and ignore) itself on wake-up.
  let active = null;
  let stopped = false;
  let lastError = null;

  // Diagnostic callbacks are injectable; a broken one must never escape
  // save(), never replace or hide the original disk error, and never trigger
  // a second report cycle (which could become an unhandled rejection).
  const diagnose = (kind, callback, error, context) => {
    try {
      callback(error, context);
    } catch (callbackError) {
      console.error(`[bot] state.json 保存诊断回调（${kind}）自身抛出异常，原始错误保留如下：`, error);
      console.error('[bot] 诊断回调异常本身：', callbackError);
    }
  };
  const reportSaveFailure = (error, attempts) => {
    lastError = error; // history of the latest failure; kept, never auto-cleared
    diagnose('onError', onError, error, { attempts });
  };
  // A delivered candidate always means the write reached the disk; listener
  // failures are isolated so they can neither abort the save nor be retried.
  const deliver = (candidate) => {
    try {
      committed(candidate);
    } catch (error) {
      diagnose('onNotifyError', onNotifyError, error);
    }
  };

  const runRetry = async (token) => {
    const started = now();
    let failures = 0;
    try {
      for (;;) {
        await yieldTurn(Math.min(retryBaseDelayMs * 2 ** failures, retryMaxDelayMs));
        // Superseded by an explicit save or shutdown: that commit now owns
        // state.json, so this stale pass must neither write nor report — and
        // it must not release the identity of a newer pass below.
        if (stopped || active !== token) return;
        failures += 1;
        let candidate;
        try {
          candidate = retryAttempt();
        } catch (error) {
          if (!isRetryable(error) || failures >= retryAttempts || now() - started >= retryBudgetMs) {
            reportSaveFailure(error, failures + 1);
            return;
          }
          continue;
        }
        deliver(candidate);
        return;
      }
    } finally {
      // Only the still-active owner releases the slot; a late stale pass and
      // its late errors must not clear a newer pass.
      if (active === token) active = null;
    }
  };

  return {
    /** Debounce-timer entry point. Never throws; never leaves an unhandled rejection. */
    save() {
      if (stopped || active) return;
      let candidate;
      try {
        candidate = attempt();
      } catch (error) {
        if (!isRetryable(error)) {
          reportSaveFailure(error, 1);
          return;
        }
        const token = {};
        active = token;
        void runRetry(token).catch((error) => {
          // Scheduler-level failure (e.g. a throwing injected yield): report
          // the late error without touching a slot a newer pass may own.
          reportSaveFailure(error, 0);
        });
        return;
      }
      deliver(candidate);
    },
    /**
     * An explicit successful save supersedes the in-flight pass immediately:
     * the slot is freed so the next save() can start a fresh pass or commit
     * synchronously; the stale pass discards itself on wake-up.
     */
    noteCommitted() {
      active = null;
    },
    get retrying() {
      return active !== null;
    },
    get lastError() {
      return lastError;
    },
    close() {
      stopped = true;
      active = null;
    },
  };
}
