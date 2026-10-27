import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acquireAgentEnvironment } from './process-environment.mjs';

test('one process has one owner and fixed native configuration; final shutdown restores its environment', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-agent-env-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = process.env.PI_MEMORY_DIR;
  const first = acquireAgentEnvironment({ dataDir: root,  });
  const second = acquireAgentEnvironment({ dataDir: root });
  try {
    assert.equal(process.env.PI_MEMORY_DIR, path.join(root, 'pi-memory'));
    assert.equal(process.env.PI_MEMORY_EXIT_SUMMARY, '1');
    assert.equal(process.env.PI_MEMORY_NO_SEARCH, '1');
    assert.equal(process.env.PI_MEMORY_QMD_UPDATE, 'off');
    assert.equal(process.env.PI_MEMORY_SNAPSHOT, 'per-turn');
    assert.throws(() => acquireAgentEnvironment({ dataDir: path.join(root, 'another-owner') }), /一个执行进程/);
    first.release();
    assert.equal(process.env.PI_MEMORY_DIR, second.memoryDir);
    first.release();
  } finally { second.release(); }
  assert.equal(process.env.PI_MEMORY_DIR, previous);
});
