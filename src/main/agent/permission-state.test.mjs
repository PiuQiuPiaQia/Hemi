import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  browserBridgeStatePathFor,
  cleanupLegacyExecutorInstall,
  exportBrowserExtensionFiles,
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

test('实际扩展导出后，manifest 图标、后台脚本及 importScripts 依赖全部存在且内容完整', t => {
  const targetRoot = mkdtempSync(path.join(tmpdir(), 'hemi-extension-export-'));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));
  const sourceDir = fileURLToPath(new URL('../../../extensions/chrome-extension/', import.meta.url));
  const exported = exportBrowserExtensionFiles({ sourceDir, targetRoot });
  const manifest = JSON.parse(readFileSync(path.join(exported, 'manifest.json'), 'utf8'));
  const worker = readFileSync(path.join(exported, manifest.background.service_worker), 'utf8');
  const imports = [...worker.matchAll(/importScripts\(([^)]+)\)/g)].flatMap(match => [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(item => item[1]));
  assert.ok(imports.includes('page-cursor.js'));
  for (const relative of ['manifest.json', 'hemi-task.html', manifest.background.service_worker, ...Object.values(manifest.icons), ...imports]) {
    assert.deepEqual(readFileSync(path.join(exported, relative)), readFileSync(path.join(sourceDir, relative)), relative);
  }
});

test('重新导出递归更新嵌套资源，过滤各层隐藏文件，保留已有普通文件', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'hemi-extension-refresh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source');
  const targetRoot = path.join(root, 'exports');
  const nested = path.join('icons', 'nested');
  mkdirSync(path.join(sourceDir, nested), { recursive: true });
  await writeFile(path.join(sourceDir, nested, 'icon.png'), 'first');
  await writeFile(path.join(sourceDir, nested, '._icon.png'), 'AppleDouble');
  mkdirSync(path.join(sourceDir, '.hidden'), { recursive: true });
  await writeFile(path.join(sourceDir, '.hidden', 'private'), 'excluded');
  const exported = exportBrowserExtensionFiles({ sourceDir, targetRoot });
  await writeFile(path.join(exported, nested, '._old.png'), 'old AppleDouble');
  await writeFile(path.join(exported, 'notes.txt'), 'keep');
  await writeFile(path.join(sourceDir, nested, 'icon.png'), 'updated');
  exportBrowserExtensionFiles({ sourceDir, targetRoot });
  assert.equal(readFileSync(path.join(exported, nested, 'icon.png'), 'utf8'), 'updated');
  assert.equal(readFileSync(path.join(exported, 'notes.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(path.join(exported, nested, '._icon.png')), false);
  assert.equal(existsSync(path.join(exported, nested, '._old.png')), false);
  assert.equal(existsSync(path.join(exported, '.hidden')), false);
  assert.throws(() => exportBrowserExtensionFiles({ sourceDir, targetRoot: sourceDir }), /源码目录之外/);
  assert.equal(existsSync(path.join(sourceDir, 'Hemi 浏览器控制')), false);
});
