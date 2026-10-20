import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 主进程语法门禁（2026-10-05「启动不了」事故后补）：src/main 与 src/shared 的
 * .mjs、preload 的 index.cjs 都不走 tsc（只查 TS/TSX），也不都有单测 import——
 * ESM 加载期语法/重复声明错误会让应用「打不开」（错误对话框被吞，023 教训同款）。
 * 这里对每个文件跑 node --check，把这一类问题拦进 npm test。
 */

const root = path.join(fileURLToPath(new URL('../', import.meta.url)), '..');

function collectMjs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectMjs(full));
    else if (full.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const files = [
  ...collectMjs(path.join(root, 'src/main')),
  ...collectMjs(path.join(root, 'src/shared')),
  path.join(root, 'src/preload/index.cjs'),
];

test(`主进程语法门禁：node --check ${files.length} 个文件（.mjs/.cjs 不经 tsc，防「启动不了」）`, () => {
  assert.ok(files.length > 20, '文件清单意外过少，检查收集逻辑');
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      failures.push(`${path.relative(root, file)}\n${(result.stderr || '').split('\n').slice(0, 4).join('\n')}`);
    }
  }
  assert.equal(failures.join('\n\n'), '', '主进程文件存在语法错误');
});
