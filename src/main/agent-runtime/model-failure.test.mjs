import test from 'node:test';
import assert from 'node:assert/strict';
import { modelFailure, requestWatchdog } from './model-failure.mjs';

test('structured phase facts survive localization and permanent failures take precedence over retry wording', () => {
  const timeout = modelFailure({ timeoutPhase: 'first-output', status: 200, message: '供应商任意文案' });
  assert.equal(timeout.code, 'TIMEOUT'); assert.equal(timeout.phase, 'first-output'); assert.equal(timeout.httpStatus, 200); assert.equal(timeout.retryable, true);
  for (const input of [{ status: 401, message: 'timeout' }, { status: 503, message: 'quota exceeded' }, { status: 413, message: 'server error' }, { code: 'request-limit', message: '运行请求上限' }]) assert.equal(modelFailure(input).retryable, false);
  assert.equal(modelFailure({ timeoutPhase: 'idle', aborted: true }).code, 'CANCELLED');
  assert.equal(modelFailure({ message: 'unknown failure' }).retryable, false);
});

test('connection, first-output and stream idle have distinct deadlines, and ignored provider abort still releases the caller', async () => {
  let now = 0, seq = 0;
  const jobs = new Map();
  const timers = { setTimeout(fn, delay) { const id = ++seq; jobs.set(id, { at: now + delay, fn }); return id; }, clearTimeout(id) { jobs.delete(id); } };
  const advance = ms => { now += ms; for (const [id, job] of [...jobs]) if (job.at <= now) { jobs.delete(id); job.fn(); } };
  const controller = new AbortController();
  const watchdog = requestWatchdog({ controller, timers, timeouts: { connectionMs: 60, firstOutputMs: 300, idleMs: 100 } });
  advance(59); assert.equal(controller.signal.aborted, false);
  watchdog.connected(); advance(299); assert.equal(controller.signal.aborted, false);
  watchdog.activity(); advance(99); assert.equal(controller.signal.aborted, false);
  watchdog.activity();
  const blocked = watchdog.wait(new Promise(() => {}));
  advance(100); await assert.rejects(blocked, error => error.code === 'MODEL_REQUEST_TIMEOUT' && error.phase === 'idle');
  assert.equal(watchdog.timeoutPhase, 'idle');
  watchdog.connected(); watchdog.dispose(); assert.equal(jobs.size, 0);

  const caller = new AbortController(), request = new AbortController();
  const cancelled = requestWatchdog({ controller: request, signal: AbortSignal.any([caller.signal, request.signal]), timers });
  const pending = cancelled.wait(new Promise(() => {})); caller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cancelled.timeoutPhase, null);
  cancelled.dispose(); assert.equal(jobs.size, 0);
});
