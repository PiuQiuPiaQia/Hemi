import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFlowStore } from './flow-store.mjs';

for (const code of ['EPERM', 'EBUSY']) {
  test(`production flow commit retries transient ${code} without losing sibling fields`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-flow-lock-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'conv-lock.json');
    fs.writeFileSync(target, JSON.stringify({ id: 'conv-lock', turns: [{ text: 'keep' }] }));
    const original = fs.renameSync;
    let calls = 0;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === target && ++calls < 3) throw Object.assign(new Error('temporary lock'), { code });
      return original(from, to);
    });
    const store = createFlowStore({ dir });
    await store.saveFlow('conv-lock', { schemaVersion: 1, revision: 2 });
    assert.equal(calls, 3);
    assert.equal(store.hasFailure('conv-lock'), false);
    const record = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(record.turns[0].text, 'keep');
    assert.equal(record.flow.revision, 2);
    assert.deepEqual(fs.readdirSync(dir), ['conv-lock.json']);
  });
}

test('production flow commit still rejects permanent failures and retains retryable state', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-flow-permanent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createFlowStore({ dir });
  let calls = 0;
  const original = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', () => {
    calls++;
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
  await assert.rejects(store.saveFlow('conv-fail', { schemaVersion: 1, revision: 1 }), { code: 'ENOSPC' });
  assert.equal(calls, 1);
  assert.equal(store.hasFailure('conv-fail'), true);
  mock.mock.restore();
  assert.equal(fs.renameSync, original);
  await store.saveFlow('conv-fail', { schemaVersion: 1, revision: 2 });
  assert.equal(store.hasFailure('conv-fail'), false);
  assert.equal(store.loadFlow('conv-fail').revision, 2);
});
