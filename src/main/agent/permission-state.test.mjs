import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  browserBridgeStatePathFor,
  cleanupLegacyExecutorInstall,
} from './permission-state.mjs';

test('cleanupLegacyExecutorInstall：删除 userData/executor 整目录，缺失时静默', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hemi-legacy-'));
  try {
    const legacy = path.join(dir, 'executor', 'pi', 'node_modules', 'x');
    mkdirSync(legacy, { recursive: true });
    await writeFile(path.join(legacy, 'cli.js'), 'old install');
    await writeFile(path.join(dir, 'executor', 'installed.json'), '{}');

    const removed = await cleanupLegacyExecutorInstall({ userDataDir: dir, log: null });
    assert.equal(removed, true);
    assert.equal(existsSync(path.join(dir, 'executor')), false);

    const again = await cleanupLegacyExecutorInstall({ userDataDir: dir, log: null });
    assert.equal(again, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('桥状态文件路径位于 userData 根（不再进 executor/ 目录）', () => {
  assert.equal(browserBridgeStatePathFor('/u'), path.join('/u', 'browser-bridge-state.json'));
});
