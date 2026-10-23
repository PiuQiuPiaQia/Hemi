// Design-prototype policy; production recovery is not wired to this module.
export const RECOVERY_WINDOW_MS = 30 * 60 * 1000;
export const RETRY_DELAYS_MS = Object.freeze([1000, 2000, 5000, 10000, 20000, 30000, 60000]);

export function retryDelayMs(attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError('attempt must be a positive integer');
  return RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
}

export function recoveryPlan({startedAt, now, attempt, notBefore = now}) {
  if (![startedAt, now, notBefore].every(Number.isFinite)) throw new TypeError('timestamps must be finite');
  const deadlineAt = startedAt + RECOVERY_WINDOW_MS;
  const proposedAt = Math.max(now + retryDelayMs(attempt), notBefore);
  const expired = now >= deadlineAt;
  const nextRetryAt = !expired && proposedAt < deadlineAt ? proposedAt : null;
  return {deadlineAt, remainingMs: Math.max(0, deadlineAt - now), nextRetryAt, wakeAt: expired ? null : nextRetryAt ?? deadlineAt, expired};
}
