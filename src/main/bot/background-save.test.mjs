import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createBackgroundSaver, isTransientRenameCommitError } from './background-save.mjs';
import { atomicJson } from './storage.mjs';
import { psLiteral } from './windows-transport.mjs';

const renameError = (code = 'EPERM') =>
  Object.assign(new Error(`${code}: operation not permitted, rename`), { code, syscall: 'rename' });

// Guards every case that lets the saver run background work: a regression back
// to an uncaught timer exception or an unhandled rejection fails the test.
function trackUncaught(t) {
  const seen = { exceptions: [], rejections: [] };
  const onException = (error) => seen.exceptions.push(error);
  const onRejection = (error) => seen.rejections.push(error);
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  t.after(() => {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
    assert.deepEqual(seen.exceptions, [], 'background saving produced uncaught exceptions');
    assert.deepEqual(seen.rejections, [], 'background saving produced unhandled rejections');
  });
  return seen;
}

const settle = async (saver, ms = 5000) => {
  const end = Date.now() + ms;
  while (saver.retrying) {
    assert.ok(Date.now() < end, 'background saver did not settle in time');
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test('isTransientRenameCommitError matches only Windows rename commit failures', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])
    assert.equal(isTransientRenameCommitError(renameError(code), 'win32'), true, code);
  assert.equal(isTransientRenameCommitError(renameError('EPERM'), 'darwin'), false, '非 Windows 不重试');
  assert.equal(isTransientRenameCommitError(renameError('ENOSPC'), 'win32'), false, 'ENOSPC 不是共享锁');
  assert.equal(isTransientRenameCommitError({ code: 'EPERM', syscall: 'open' }, 'win32'), false, '非 rename 阶段');
  assert.equal(isTransientRenameCommitError(new Error('boom'), 'win32'), false, '普通错误');
  assert.equal(isTransientRenameCommitError(null, 'win32'), false);
});

test('first commit failure keeps revision and notifications silent; one event-loop-yielding pass recovers exactly once', async t => {
  trackUncaught(t);
  let revision = 7;
  let saved = { revision: 7, value: 'old' };
  const notifications = [];
  let attemptCalls = 0, retryCalls = 0, armed = false;
  const saver = createBackgroundSaver({
    attempt: () => {
      attemptCalls += 1;
      if (attemptCalls === 1) throw renameError();
      return revision + 1;
    },
    retryAttempt: () => {
      retryCalls += 1;
      // The injected yield only arms this flag from a setImmediate callback:
      // a synchronous (Atomics-blocking) retry can never see it.
      assert.equal(armed, true, 'retry must run only after the event loop advanced');
      return revision + 1;
    },
    committed: (candidate) => {
      revision = candidate;
      notifications.push(candidate);
      saved = { revision: candidate, value: 'new' };
    },
    isRetryable: (error) => isTransientRenameCommitError(error, 'win32'),
    yield: () => new Promise((resolve) => setImmediate(() => { armed = true; resolve(); })),
    onError: () => { throw new Error('a recovered save must not be reported as failed'); },
  });

  saver.save(); // stands in for the laterSave timer callback: must not throw
  assert.equal(attemptCalls, 1);
  assert.equal(revision, 7, 'failure does not bump the revision');
  assert.deepEqual(notifications, [], 'failure sends no success notification');
  assert.deepEqual(saved, { revision: 7, value: 'old' }, 'failure does not commit');

  await settle(saver);
  assert.equal(armed, true, 'the pass yielded through setImmediate');
  assert.equal(retryCalls, 1, 'recovery happens exactly once');
  assert.equal(revision, 8);
  assert.deepEqual(notifications, [8], 'the recovered save notifies exactly once');
  assert.deepEqual(saved, { revision: 8, value: 'new' });
});

test('an explicit successful save supersedes the in-flight retry pass', async t => {
  trackUncaught(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let retryCalls = 0;
  const delivered = [];
  const saver = createBackgroundSaver({
    attempt: () => { throw renameError(); },
    retryAttempt: () => { retryCalls += 1; return 99; },
    committed: (candidate) => delivered.push(candidate),
    isRetryable: () => true,
    yield: () => gate,
  });

  saver.save();
  assert.equal(saver.retrying, true, 'the pass waits on the event loop');
  saver.noteCommitted(); // the explicit save() committed a newer state
  assert.equal(saver.retrying, false, 'noteCommitted frees the slot immediately');
  release();
  await settle(saver);
  assert.equal(retryCalls, 0, 'the superseded pass never writes');
  assert.deepEqual(delivered, [], 'no late notification from the old pass');
});

test('a retry pass serializes the latest state, never a stale snapshot', async t => {
  trackUncaught(t);
  let value = 'before';
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const delivered = [];
  const saver = createBackgroundSaver({
    attempt: () => { throw renameError(); },
    retryAttempt: () => {
      seen.push(value); // reads the closure at retry time, not save time
      return 42;
    },
    committed: (candidate) => delivered.push({ candidate, value }),
    isRetryable: () => true,
    yield: () => gate,
  });

  saver.save();
  value = 'edited-while-retry-pending'; // new user change lands during the yield
  release();
  await settle(saver);
  assert.deepEqual(seen, ['edited-while-retry-pending'], 'the retry sees the latest state');
  assert.deepEqual(delivered, [{ candidate: 42, value: 'edited-while-retry-pending' }]);
});

test('noteCommitted frees the slot: a new save starts a fresh pass and the stale wake-up neither writes nor clears it', async t => {
  trackUncaught(t);
  let releaseOld, releaseNew;
  const gates = [
    new Promise((resolve) => { releaseOld = resolve; }),
    new Promise((resolve) => { releaseNew = resolve; }),
  ];
  let value = 'stale';
  let retryCalls = 0;
  const delivered = [];
  const reports = [];
  const saver = createBackgroundSaver({
    attempt: () => { throw renameError(); },
    retryAttempt: () => {
      retryCalls += 1;
      return { value }; // whatever the retry sees at retry time
    },
    committed: (candidate) => delivered.push(candidate),
    isRetryable: () => true,
    yield: () => gates.shift() ?? Promise.resolve(),
    onError: (error, context) => reports.push(context.attempts),
  });

  saver.save(); // pass A parks on the old gate
  assert.equal(saver.retrying, true);
  saver.noteCommitted(); // an explicit save committed a newer state
  assert.equal(saver.retrying, false, 'noteCommitted frees the slot immediately');
  value = 'new-dirty'; // fresh change arrives
  saver.save(); // pass B starts right away and parks on the new gate
  assert.equal(saver.retrying, true, 'a new save enters a fresh pass instead of being swallowed');

  releaseOld(); // the stale pass wakes up
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saver.retrying, true, 'the stale pass must not clear the fresh pass');
  assert.deepEqual(delivered, [], 'the stale pass never writes');
  assert.deepEqual(reports, [], 'the stale pass reports nothing');

  releaseNew(); // the fresh pass commits the latest value exactly once
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, [{ value: 'new-dirty' }], 'exactly one delivery of the latest state');
  assert.equal(retryCalls, 1, 'only the fresh pass reached retryAttempt');
  assert.equal(saver.retrying, false, 'only the fresh pass released the slot');
});

test('a save freed by noteCommitted commits synchronously on its first attempt', async t => {
  trackUncaught(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let passes = 0;
  const delivered = [];
  const saver = createBackgroundSaver({
    attempt: () => {
      passes += 1;
      if (passes === 1) throw renameError();
      return 5;
    },
    retryAttempt: () => 5,
    committed: (candidate) => delivered.push(candidate),
    isRetryable: () => true,
    yield: () => gate,
    onError: () => {},
  });

  saver.save(); // parks on the gate
  assert.equal(saver.retrying, true);
  saver.noteCommitted(); // explicit save supersedes the pass
  assert.equal(saver.retrying, false);
  saver.save(); // the very first attempt now succeeds synchronously
  assert.deepEqual(delivered, [5], 'committed immediately without a second pass');
  assert.equal(saver.retrying, false);

  release(); // the stale pass wakes up after everything already committed
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, [5], 'the stale pass adds nothing');
});

test('close cancels the in-flight pass; the late wake-up neither writes nor reports', async t => {
  trackUncaught(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  const delivered = [];
  const reports = [];
  const saver = createBackgroundSaver({
    attempt: () => { throw renameError(); },
    retryAttempt: () => { writes += 1; return 1; },
    committed: (candidate) => delivered.push(candidate),
    isRetryable: () => true,
    yield: () => gate,
    onError: (error, context) => reports.push(context.attempts),
  });

  saver.save();
  assert.equal(saver.retrying, true);
  saver.close();
  assert.equal(saver.retrying, false);
  saver.save(); // closed: a no-op, never a late write
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0, 'a closed saver never writes');
  assert.deepEqual(delivered, [], 'a closed saver never notifies');
  assert.deepEqual(reports, [], 'a closed saver never reports the cancelled pass');
});

test('throwing diagnostic callbacks never escape save() and never mask the original error', async t => {
  const seen = trackUncaught(t);
  const diskError = renameError('ENOSPC');
  const consoleErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => consoleErrors.push(args);
  t.after(() => { console.error = originalConsoleError; });

  // a) permanent failure path with a throwing onError
  let reports = 0;
  const saver = createBackgroundSaver({
    attempt: () => { throw diskError; },
    onError() { reports += 1; throw new Error('broken onError'); },
  });
  saver.save(); // must not throw out of the timer callback
  assert.equal(reports, 1, 'exactly one report attempt, no retry loop');
  assert.equal(saver.lastError, diskError, 'the original disk error is preserved');
  saver.save(); // the saver stays usable
  assert.equal(reports, 2);

  // b) exhausted background path with a throwing onError: no unhandled rejection
  const saver2 = createBackgroundSaver({
    attempt: () => { throw renameError(); },
    retryAttempt: () => { throw renameError(); },
    isRetryable: () => true,
    yield: () => Promise.resolve(),
    retryAttempts: 1,
    onError() { throw new Error('broken onError'); },
  });
  saver2.save();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saver2.retrying, false, 'the pass still settles and frees its slot');

  // c) notify path with a throwing onNotifyError
  const saver3 = createBackgroundSaver({
    attempt: () => 3,
    committed() { throw new Error('listener boom'); },
    onNotifyError() { throw new Error('broken onNotifyError'); },
    onError() { throw new Error('notify failures must not reach onError'); },
  });
  saver3.save(); // must not throw, must not misclassify as a disk failure

  assert.ok(
    consoleErrors.some((args) => args.includes(diskError)),
    'the original disk error reaches the console despite the broken callback',
  );
  assert.deepEqual(seen.exceptions, [], 'no diagnostic callback error escapes as uncaught');
  assert.deepEqual(seen.rejections, [], 'no diagnostic callback error escapes as unhandled');
});

test('permanent errors are never retried; exhaustion reports once and later saves work again', async t => {
  trackUncaught(t);
  const reported = [];
  let retryCalls = 0, yields = 0;
  const saver = createBackgroundSaver({
    attempt: () => { throw renameError('ENOSPC'); },
    retryAttempt: () => { retryCalls += 1; throw renameError(); },
    committed: () => { throw new Error('must not deliver'); },
    isRetryable: (error) => isTransientRenameCommitError(error, 'win32'),
    onError: (error, context) => reported.push([error.code, context.attempts]),
    yield: () => { yields += 1; return Promise.resolve(); },
    retryAttempts: 2,
  });

  saver.save();
  assert.equal(retryCalls, 0, 'ENOSPC is not a sharing lock: no retry');
  assert.equal(yields, 0, 'permanent failures never yield');
  assert.deepEqual(reported, [['ENOSPC', 1]]);
  assert.equal(saver.retrying, false);
  assert.equal(saver.lastError.code, 'ENOSPC');

  // Second saver: transient forever -> bounded pass, single report.
  const reported2 = [];
  let retryCalls2 = 0;
  const saver2 = createBackgroundSaver({
    attempt: () => { throw renameError(); },
    retryAttempt: () => { retryCalls2 += 1; throw renameError(); },
    committed: () => {},
    isRetryable: (error) => isTransientRenameCommitError(error, 'win32'),
    onError: (error, context) => reported2.push([error.code, context.attempts]),
    yield: () => Promise.resolve(),
    retryAttempts: 2,
  });
  saver2.save();
  saver2.save(); // folded into the in-flight pass: at most one retry pass
  saver2.save();
  await settle(saver2);
  assert.equal(retryCalls2, 2, 'exactly retryAttempts background attempts');
  assert.deepEqual(reported2, [['EPERM', 3]], 'one exhaustion report counting the first attempt');
});

test('a throwing listener is isolated from the disk path and never retried', async t => {
  trackUncaught(t);
  const listenerError = Object.assign(new Error('listener EPERM'), { code: 'EPERM', syscall: 'rename' });
  const notified = [];
  let retryCalls = 0;
  const saver = createBackgroundSaver({
    attempt: () => 11,
    retryAttempt: () => { retryCalls += 1; return 11; },
    committed: () => { throw listenerError; },
    onNotifyError: (error) => notified.push(error),
    onError: () => { throw new Error('listener failure must not hit the disk error path'); },
  });
  saver.save();
  assert.deepEqual(notified, [listenerError], 'reported through the notify path');
  assert.equal(retryCalls, 0, 'listener failures are not disk failures');

  // Same isolation for the background pass that succeeded after a yield.
  let retryCalls2 = 0;
  const notified2 = [];
  const saver2 = createBackgroundSaver({
    attempt: () => { throw renameError(); },
    retryAttempt: () => { retryCalls2 += 1; return 12; },
    committed: () => { throw listenerError; },
    isRetryable: (error) => isTransientRenameCommitError(error, 'win32'),
    onNotifyError: (error) => notified2.push(error),
    yield: () => Promise.resolve(),
  });
  saver2.save();
  await settle(saver2);
  assert.equal(retryCalls2, 1, 'the pass is not re-entered because a listener threw');
  assert.deepEqual(notified2, [listenerError]);
});

test('persistent ENOSPC through the real atomic write keeps the old JSON, leaves no orphan tmp and never throws from the timer', async t => {
  trackUncaught(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-bg-save-enospc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  atomicJson(file, { generation: 'old' });
  const reported = [];
  const delivered = [];
  // Injected at the storage commit boundary: the swap itself fails forever.
  const commit = () => { throw renameError('ENOSPC'); };
  const saver = createBackgroundSaver({
    attempt: () => atomicJson(file, { generation: 'uncommitted' }, { commit }),
    retryAttempt: () => atomicJson(file, { generation: 'uncommitted' }, { commit }),
    committed: (candidate) => delivered.push(candidate),
    isRetryable: (error) => isTransientRenameCommitError(error, 'win32'),
    onError: (error, context) => reported.push([error.code, context.attempts]),
  });

  saver.save(); // laterSave timer callback semantics: returns, process survives
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { generation: 'old' }, 'old destination untouched');
  assert.deepEqual(fs.readdirSync(root), ['state.json'], 'no orphan temp file');
  assert.deepEqual(delivered, [], 'no success notification for a failed save');
  assert.deepEqual(reported, [['ENOSPC', 1]], 'the failure is visible through the report path');
});

test('background saver yields so a lock released through the parent event loop still commits', { skip: process.platform !== 'win32', timeout: 40000 }, async t => {
  trackUncaught(t);
  const delivered = [], reported = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-bg-save-lock-'));
  const file = path.join(root, 'state.json');
  atomicJson(file, { generation: 'old' });
  // Holds a read handle without FILE_SHARE_DELETE until the parent writes a
  // line to stdin — something the old synchronous blocker could never do,
  // because its 3s Atomics budget kept the event loop from sending it.
  const script = `$ErrorActionPreference='Stop'; $f=[IO.File]::Open(${psLiteral(file)},'Open','Read',[IO.FileShare]::ReadWrite); try { [Console]::Out.WriteLine('READY'); [void][Console]::In.ReadLine() } finally { $f.Dispose() }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock helper readiness timed out: ' + stderr)), 10000);
    child.stdout.once('data', (data) => {
      clearTimeout(timer);
      if (String(data).trim() === 'READY') resolve(); else reject(new Error(String(data)));
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    exited.then(([code]) => { clearTimeout(timer); if (code !== 0) reject(new Error('lock helper failed: ' + stderr)); });
  });

  const saver = createBackgroundSaver({
    // First attempt: the default storage policy blocks up to 3s and exhausts
    // against the held lock, mirroring the v0.2.44 Windows failure.
    attempt: () => {
      atomicJson(file, { generation: 'first' });
      return 1;
    },
    // Retry pass: a single rename, after the event loop had time to message
    // the helper and let it release the handle.
    retryAttempt: () => {
      atomicJson(file, { generation: 'recovered' }, { commit: (from, to) => fs.renameSync(from, to) });
      return 1;
    },
    committed: (candidate) => delivered.push(candidate),
    onError: (error) => reported.push(error),
  });

  saver.save();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { generation: 'old' }, 'still locked after the first attempt');
  assert.equal(delivered.length, 0);

  child.stdin.write('release\r\n'); // requires the yielding pass to make progress
  const end = Date.now() + 15000;
  while (saver.retrying) {
    assert.ok(Date.now() < end, 'retry pass did not settle after the lock was released');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(delivered, [1], 'exactly one success notification');
  assert.deepEqual(reported, [], 'no error report for a recovered save');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { generation: 'recovered' });
  assert.deepEqual(fs.readdirSync(root), ['state.json'], 'no orphan temp file');

  child.stdin.end();
  await exited;
});
