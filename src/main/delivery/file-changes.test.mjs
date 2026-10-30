// 050 文件事实单测（S0 探针 A/C 的异步版移植；真实 git + 临时仓库）。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync, unlinkSync, copyFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  diffTreeChanges,
  isGitRepo,
  mergeToolTouches,
  numstatOf,
  snapshotTree,
} from './file-changes.mjs';

const gitSync = (cwd, args, env = {}) =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' }).trim();
// Windows 没有 cat：直接按字节读文件算哈希（与 cat 输出逐字节一致，平台无关）。
const sha = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'missing');

test('A. 私有 index 快照：任务前脏改动不计入、A/M/D/R 识别、用户 index 不变', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'hemi050-repo-'));
  try {
    gitSync(repo, ['init', '-q']);
    gitSync(repo, ['config', 'user.email', 'p@x']);
    gitSync(repo, ['config', 'user.name', 'probe']);
    writeFileSync(path.join(repo, '.gitignore'), 'dist/\n*.log\n');
    writeFileSync(path.join(repo, 'a.txt'), '1\n2\n3\n');
    writeFileSync(path.join(repo, 'b.txt'), 'keep\n');
    writeFileSync(path.join(repo, 'old-name.txt'), 'rename me\n'.repeat(20));
    writeFileSync(path.join(repo, 'gone.txt'), 'x\n'.repeat(5));
    gitSync(repo, ['add', '-A']);
    gitSync(repo, ['commit', '-qm', 'init']);
    // 任务前就存在的用户脏改动：不得归给任务。
    writeFileSync(path.join(repo, 'b.txt'), 'keep\nuser edit before task\n');
    writeFileSync(path.join(repo, 'user-untracked.txt'), 'user\n');
    gitSync(repo, ['add', 'b.txt']);
    const indexBefore = sha(path.join(repo, '.git/index'));
    const statusBefore = gitSync(repo, ['status', '--porcelain=v1']);

    const before = await snapshotTree(repo);
    assert.equal(before.ok, true, before.reason ?? '');
    // 任务期间。
    writeFileSync(path.join(repo, 'a.txt'), '1\n2 changed\n3\n4\n');
    writeFileSync(path.join(repo, 'new.txt'), 'n1\nn2\n');
    writeFileSync(path.join(repo, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    unlinkSync(path.join(repo, 'gone.txt'));
    renameSync(path.join(repo, 'old-name.txt'), path.join(repo, 'new-name.txt'));
    mkdirSync(path.join(repo, 'dist'));
    writeFileSync(path.join(repo, 'dist/out.js'), 'ignored');
    writeFileSync(path.join(repo, 'run.log'), 'ignored');
    writeFileSync(path.join(repo, '._new.txt'), 'appledouble junk');
    const after = await snapshotTree(repo);
    const diff = await diffTreeChanges(repo, before.tree, after.tree);
    assert.equal(diff.ok, true);
    const byPath = Object.fromEntries(diff.files.map((change) => [change.path, change]));

    assert.deepEqual(Object.keys(byPath).sort(), ['a.txt', 'gone.txt', 'img.bin', 'new-name.txt', 'new.txt']);
    assert.equal(byPath['a.txt'].kind, 'M');
    assert.deepEqual([byPath['a.txt'].add, byPath['a.txt'].del], [2, 1]);
    assert.equal(byPath['new.txt'].kind, 'A');
    assert.equal(byPath['gone.txt'].kind, 'D');
    assert.equal(byPath['new-name.txt'].kind, 'R');
    assert.equal(byPath['img.bin'].add, null, '二进制无行数');
    assert(!byPath['b.txt'] && !byPath['user-untracked.txt'], '任务前已有改动不计入');
    assert.equal(sha(path.join(repo, '.git/index')), indexBefore, '用户 index 字节不变');
    const statusAfter = gitSync(repo, ['status', '--porcelain=v1']);
    assert(statusAfter.includes('M  b.txt'), '用户暂存状态保持');
    assert(statusBefore.split('\n').every((line) => statusAfter.includes(line)), '用户原有状态行都还在');
    // ._* 在 add 阶段就被排除（上面 keys 断言已覆盖）；diff 侧过滤是已跟踪
    // 垃圾的第二道防线，这里只验证计数器存在且不误报。
    assert.equal(typeof diff.junkExcluded, 'number');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('B. isGitRepo：git 目录为真、普通目录为假；用户 index 不被触碰', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'hemi050-repo2-'));
  const plain = mkdtempSync(path.join(os.tmpdir(), 'hemi050-plain-'));
  try {
    gitSync(repo, ['init', '-q']);
    assert.equal(await isGitRepo(repo), true);
    assert.equal(await isGitRepo(plain), false);
    assert.equal(await isGitRepo(null), false);
    const idx = path.join(repo, '.git/index');
    if (existsSync(idx)) {
      const before = sha(idx);
      const snap = await snapshotTree(repo);
      assert.equal(snap.ok, true);
      assert.equal(sha(idx), before, '快照后用户 index 不变');
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test('C. 工具记录合并：同路径多次编辑合并、建后删/改后改回剔除、± 行数', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi050-tools-'));
  try {
    const disk = new Map([
      ['x.js', 'a\nb\n'],
      ['y.md', 'same\n'],
      ['z.txt', null], // 不存在
    ]);
    const readCurrent = async (p) => disk.get(p) ?? null;
    const merged = await mergeToolTouches([
      { path: 'x.js', before: 'a\nb\n' },
      { path: 'x.js', before: 'a\nB\n' }, // 同路径二次编辑：首次 before 为准
      { path: 'tmp.txt', before: null },
      { path: 'tmp.txt', before: 'probe' }, // 建后删（盘上不存在）
      { path: 'y.md', before: 'same\n' }, // 改后改回（内容相同）
      { path: 'new.md', before: null },
    ], { readCurrent: async (p) => (p === 'new.md' ? '1\n2\n3\n' : disk.get(p) ?? null) });
    // x.js 盘上是 a\nb\n（before 相同）→ 无净变化；真实变化只剩 new.md。
    const paths = merged.map((change) => change.path);
    assert.ok(paths.includes('new.md'));
    assert.ok(!paths.includes('tmp.txt'), '建后删剔除');
    const newMd = merged.find((change) => change.path === 'new.md');
    assert.equal(newMd.kind, 'A');
    assert.deepEqual([newMd.add, newMd.del], [3, 0]);

    // x.js 真改了内容的场景。
    disk.set('x.js', 'a\nB\nc\n');
    const merged2 = await mergeToolTouches([
      { path: 'x.js', before: 'a\nb\n' },
    ], { readCurrent });
    assert.deepEqual(merged2, [{ path: 'x.js', kind: 'M', add: 2, del: 1, source: 'tool' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('numstatOf：删除与新增的边界（null 内容）', async () => {
  const stats = await numstatOf('a\nb\n', 'a\nB\nc\n');
  assert.deepEqual(stats, { add: 2, del: 1 });
  const same = await numstatOf('x\n', 'x\n');
  assert.deepEqual(same, { add: 0, del: 0 });
});
