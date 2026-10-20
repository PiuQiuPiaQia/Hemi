#!/usr/bin/env node
/**
 * 050 S0 文件改动捕获探针：验证「工具记录为主＋git 私有 index 快照补强」方案。
 *
 *   node scripts/probe-050-file-changes.mjs [真实仓库目录，默认本仓库]
 *
 * A. 临时仓库正确性：任务前已有脏改动、新增/修改/删除/改名、被忽略文件、二进制、exFAT `._*` 垃圾；
 *    用私有 GIT_INDEX_FILE（以用户 index 的副本为种子保留 stat 缓存）做前后快照 → diff-tree，
 *    断言只出现任务期间的变化，且用户 .git/index、git status 字节不变。
 * B. 真实仓库耗时：对目标仓库连续两次快照（冷/热），记录 add -A + write-tree 用时。
 * C. 工具记录合并：同路径多次编辑合并、建后删＝无净变化、改后改回＝无净变化；+/- 用 git diff --no-index --numstat。
 * 不修改目标仓库的工作树文件、index 或 refs；快照会向对象库写入松散 blob（与 git add 相同，gc 可回收）。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, renameSync, unlinkSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const git = (cwd, args, env = {}) => execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const sha = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'missing');
const JUNK = /(^|\/)\._[^/]*$/; // exFAT AppleDouble

/** 私有 index 快照：复制用户 index 作种子（保留 stat 缓存，避免全量重哈希），add -A 后 write-tree。 */
export function snapshot(repo) {
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hemi050-idx-'));
  const idx = path.join(tmp, 'index');
  const seed = path.join(gitDir, 'index');
  if (existsSync(seed)) copyFileSync(seed, idx);
  const env = { GIT_INDEX_FILE: idx, GIT_OPTIONAL_LOCKS: '0' };
  const t0 = performance.now();
  git(repo, ['add', '-A', '--', '.', ':(exclude,glob)**/._*'], env);
  const tree = git(repo, ['write-tree'], env);
  const ms = Math.round(performance.now() - t0);
  rmSync(tmp, { recursive: true, force: true });
  return { tree, ms };
}

/** 两个快照之间的变化（-M 识别改名），过滤 exFAT 垃圾。 */
export function diffTrees(repo, a, b) {
  const numstat = git(repo, ['diff-tree', '-r', '-M', '--numstat', '-z', a, b]);
  const status = git(repo, ['diff-tree', '-r', '-M', '--name-status', a, b]);
  const kinds = new Map(status.split('\n').filter(Boolean).map((l) => { const p = l.split('\t'); return [p[p.length - 1], p[0][0]]; }));
  const out = [];
  const parts = numstat.split('\0').filter((x) => x !== '');
  for (let i = 0; i < parts.length; i++) {
    const [add, del, maybePath] = parts[i].split('\t');
    let file = maybePath;
    if (maybePath === '') { i += 2; file = parts[i]; } // 改名：-z 下旧/新路径各占一段
    if (JUNK.test(file)) continue;
    out.push({ path: file, kind: kinds.get(file) ?? '?', add: add === '-' ? null : Number(add), del: del === '-' ? null : Number(del) });
  }
  return out;
}

const results = { date: new Date().toISOString().slice(0, 10), A: {}, B: {}, C: {} };

// —— A. 临时仓库正确性 ——
{
  const repo = mkdtempSync(path.join(os.tmpdir(), 'hemi050-repo-'));
  try {
    git(repo, ['init', '-q']); git(repo, ['config', 'user.email', 'p@x']); git(repo, ['config', 'user.name', 'probe']);
    writeFileSync(path.join(repo, '.gitignore'), 'dist/\n*.log\n');
    writeFileSync(path.join(repo, 'a.txt'), '1\n2\n3\n');
    writeFileSync(path.join(repo, 'b.txt'), 'keep\n');
    writeFileSync(path.join(repo, 'old-name.txt'), 'rename me\n'.repeat(20));
    writeFileSync(path.join(repo, 'gone.txt'), 'x\n'.repeat(5));
    git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'init']);
    // 任务前就存在的用户脏改动：不得归给任务
    writeFileSync(path.join(repo, 'b.txt'), 'keep\nuser edit before task\n');
    writeFileSync(path.join(repo, 'user-untracked.txt'), 'user\n');
    git(repo, ['add', 'b.txt']); // 用户已暂存的改动
    const indexBefore = sha(path.join(repo, '.git/index'));
    const statusBefore = git(repo, ['status', '--porcelain=v1']);

    const before = snapshot(repo);
    // 任务期间
    writeFileSync(path.join(repo, 'a.txt'), '1\n2 changed\n3\n4\n');
    writeFileSync(path.join(repo, 'new.txt'), 'n1\nn2\n');
    unlinkSync(path.join(repo, 'gone.txt'));
    renameSync(path.join(repo, 'old-name.txt'), path.join(repo, 'new-name.txt'));
    mkdirSync(path.join(repo, 'dist')); writeFileSync(path.join(repo, 'dist/out.js'), 'ignored');
    writeFileSync(path.join(repo, 'run.log'), 'ignored');
    writeFileSync(path.join(repo, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    writeFileSync(path.join(repo, '._new.txt'), 'appledouble junk');
    const after = snapshot(repo);
    const changes = diffTrees(repo, before.tree, after.tree);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));

    assert.deepEqual(Object.keys(byPath).sort(), ['a.txt', 'gone.txt', 'img.bin', 'new-name.txt', 'new.txt']);
    assert.equal(byPath['a.txt'].kind, 'M'); assert.deepEqual([byPath['a.txt'].add, byPath['a.txt'].del], [2, 1]);
    assert.equal(byPath['new.txt'].kind, 'A'); assert.equal(byPath['gone.txt'].kind, 'D');
    assert.equal(byPath['new-name.txt'].kind, 'R');
    assert.equal(byPath['img.bin'].add, null, '二进制无行数');
    assert(!byPath['b.txt'] && !byPath['user-untracked.txt'], '任务前已有改动不计入');
    assert.equal(sha(path.join(repo, '.git/index')), indexBefore, '用户 index 字节不变');
    const statusAfter = git(repo, ['status', '--porcelain=v1']);
    assert(statusAfter.includes('M  b.txt'), '用户暂存状态保持');
    assert(statusBefore.split('\n').every((l) => statusAfter.includes(l)), '用户原有状态行都还在');
    results.A = {
      pass: true, changes,
      checked: ['任务前脏改动（已暂存 b.txt、未跟踪 user-untracked.txt）不计入', '新增/修改/删除/改名识别（-M）', '.gitignore 忽略项不计入', '二进制无行数（null）', 'exFAT ._* 过滤', '用户 .git/index 字节不变、暂存状态保持'],
      snapshotMs: [before.ms, after.ms],
    };
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// —— B. 真实仓库耗时（只读快照，不动其 index/refs）——
{
  const target = path.resolve(process.argv[2] || process.cwd());
  try {
    const gitDir = git(target, ['rev-parse', '--absolute-git-dir']);
    const idx = path.join(gitDir, 'index');
    const indexBefore = sha(idx);
    const files = Number(git(target, ['ls-files', '-z']).split('\0').filter(Boolean).length);
    const cold = snapshot(target); const warm = snapshot(target); const warm2 = snapshot(target);
    const same = cold.tree === warm.tree;
    const noise = same ? [] : diffTrees(target, cold.tree, warm.tree).map((c) => c.path).slice(0, 10);
    assert.equal(sha(idx), indexBefore, '真实仓库 index 字节不变');
    results.B = { repo: target, trackedFiles: files, ms: { first: cold.ms, second: warm.ms, third: warm2.ms }, stableTree: same, noiseBetweenSnapshots: noise, userIndexUntouched: true };
  } catch (e) { results.B = { repo: target, error: e.message }; }
}

// —— C. 工具记录合并（write/edit 事件 → 净变化）——
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi050-tools-'));
  const numstat = (a, b) => {
    const fa = path.join(dir, 'a'), fb = path.join(dir, 'b');
    writeFileSync(fa, a ?? ''); writeFileSync(fb, b ?? '');
    let out = '';
    try { out = execFileSync('git', ['diff', '--no-index', '--numstat', fa, fb], { encoding: 'utf8' }); } catch (e) { out = e.stdout; } // 有差异时退出码 1
    const [add, del] = (out.trim().split('\t'));
    return out.trim() ? { add: Number(add), del: Number(del) } : { add: 0, del: 0 };
  };
  /** 按路径保留「首次修改前」与「最终」内容；before=null 表示原本不存在，after=null 表示已删除。 */
  function merge(events) {
    const first = new Map(), last = new Map();
    for (const e of events) { if (!first.has(e.path)) first.set(e.path, e.before); last.set(e.path, e.after); }
    const out = [];
    for (const [p, before] of first) {
      const after = last.get(p);
      if (before === after) continue; // 改后改回 / 建后删
      const kind = before == null ? 'A' : after == null ? 'D' : 'M';
      out.push({ path: p, kind, ...numstat(before, after) });
    }
    return out;
  }
  const merged = merge([
    { path: 'x.js', before: 'a\nb\n', after: 'a\nB\n' },
    { path: 'x.js', before: 'a\nB\n', after: 'a\nB\nc\n' }, // 同路径二次编辑
    { path: 'tmp.txt', before: null, after: 'probe' },
    { path: 'tmp.txt', before: 'probe', after: null }, // 建后删
    { path: 'y.md', before: 'same\n', after: 'other\n' },
    { path: 'y.md', before: 'other\n', after: 'same\n' }, // 改后改回
    { path: 'new.md', before: null, after: '1\n2\n3\n' },
  ]);
  assert.deepEqual(merged, [{ path: 'x.js', kind: 'M', add: 2, del: 1 }, { path: 'new.md', kind: 'A', add: 3, del: 0 }]);
  results.C = { pass: true, merged, checked: ['同路径多次编辑合并为一项（首次前 vs 最终）', '建后删无净变化剔除', '改后改回无净变化剔除', '+/- 由 git diff --no-index --numstat 计算'] };
  rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify(results, null, 2));
