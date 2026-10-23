#!/usr/bin/env node
/**
 * 043 R-20 · 跨平台测试入口：node --test 在 cmd/PowerShell 下吃不到带引号的
 * glob（单引号不是 Windows shell 的引用符），这里用 Node 自己枚举测试文件，
 * 显式列表喂给 node --test。mac 行为不变（原来 shell 不展开引号内 glob，
 * 也是 node --test 自己 glob）。
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 递归收集目录下 *.test.mjs（跳过 node_modules 与隐藏目录）。 */
function collectTestFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

const roots = ['src/main', 'src/renderer/src', 'src/shared', 'packages/conversation-flow/test'];
const files = roots.flatMap((relative) => collectTestFiles(path.join(root, relative)));
if (!files.length) {
  console.error('[test] 没有找到任何 *.test.mjs（检查 src/main 与 src/renderer/src）');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: root,
});
process.exit(result.status ?? 1);
