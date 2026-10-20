import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createWorkspaceFileIndex, walkWorkspaceEntries } from './workspace-file-index.mjs';

function fakeTree(tree) {
  // 键归一成 POSIX 形态：遍历在 win 用 path.join 产反斜杠目录（产品行为正确），
  // 查表前先归一，双平台同一棵树（2026-10-20 win CI：嵌套目录查表落空被静默跳过）。
  const key = (dir) => dir.split(path.sep).join('/');
  return async (dir) => {
    const entries = tree[key(dir)];
    if (!entries) throw new Error('ENOENT');
    return entries.map((entry) => {
      const isDirectory = entry.endsWith('/');
      // 真实 Dirent 的 name 不带尾斜杠。
      return { name: entry.replace(/\/$/, ''), isDirectory: () => isDirectory, isFile: () => !isDirectory };
    });
  };
}

test('063 R-08：工作区有界遍历——忽略依赖目录与 ._* 垃圾，收集文件与文件夹', async () => {
  const tree = {
    '/ws': ['README.md', 'src/', 'node_modules/', '._junk', '.DS_Store'],
    '/ws/src': ['main.js', 'util/'],
    '/ws/src/util': ['helper.js'],
    '/ws/node_modules': ['should-not-appear.js'],
  };
  const { files, folders } = await walkWorkspaceEntries('/ws', { readdir: fakeTree(tree) });
  assert.deepEqual(files.map((f) => f.refPath), ['README.md', 'src/main.js', 'src/util/helper.js']);
  assert.deepEqual(folders.map((f) => f.refPath), ['src', 'src/util']);
});

test('063：不可读目录跳过不失败；条目数超限置 truncated', async () => {
  const tree = {
    '/ws': ['a/', 'b/'],
    '/ws/a': Array.from({ length: 5 }, (_, i) => `f${i}.txt`),
    '/ws/b': ['g.txt'],
  };
  const { files, truncated } = await walkWorkspaceEntries('/ws', {
    readdir: fakeTree(tree),
    maxEntries: 4,
  });
  assert.equal(files.length <= 4, true);
  assert.equal(truncated, true);
  const broken = await walkWorkspaceEntries('/gone', { readdir: fakeTree({}) });
  assert.deepEqual(broken.files, []);
});

test('063：TTL 缓存命中不重复收集；过期后重取', async () => {
  let collects = 0;
  let now = 0;
  const index = createWorkspaceFileIndex({
    now: () => now,
    ttlMs: 1000,
    collect: async () => {
      collects += 1;
      return { files: [], folders: [], truncated: false };
    },
  });
  await index.entriesOf('ws-1');
  await index.entriesOf('ws-1');
  assert.equal(collects, 1);
  now += 1001;
  await index.entriesOf('ws-1');
  assert.equal(collects, 2);
  index.invalidate('ws-1');
  await index.entriesOf('ws-1');
  assert.equal(collects, 3);
});
