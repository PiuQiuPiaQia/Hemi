import assert from 'node:assert/strict';
import test from 'node:test';

import { retryingRename } from './rename-retry.mjs';

test('retryingRename：EPERM/EBUSY 家族按退避重试，成功后正常返回', async () => {
  const sleeps = [];
  let calls = 0;
  const rename = retryingRename(
    async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error('EPERM');
        error.code = 'EPERM';
        throw error;
      }
      return 'done';
    },
    { sleep: async (ms) => sleeps.push(ms) },
  );
  assert.equal(await rename('a', 'b'), 'done');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20], '线性退避');
});

test('retryingRename：非瞬态错误立即抛出；重试耗尽抛最后一次瞬态错误', async () => {
  let calls = 0;
  const ioError = new Error('ENOSPC');
  ioError.code = 'ENOSPC';
  await assert.rejects(
    retryingRename(async () => { calls += 1; throw ioError; }, { sleep: async () => {} })('a', 'b'),
    /ENOSPC/,
  );
  assert.equal(calls, 1, '非瞬态不重试');
  let transientCalls = 0;
  const perm = new Error('EPERM');
  perm.code = 'EPERM';
  await assert.rejects(
    retryingRename(async () => { transientCalls += 1; throw perm; }, { attempts: 2, sleep: async () => {} })('a', 'b'),
    /EPERM/,
  );
  assert.equal(transientCalls, 3, 'attempts=2 → 共 3 次尝试');
});
