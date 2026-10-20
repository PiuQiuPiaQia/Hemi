#!/usr/bin/env node
/**
 * 043 R-20 · postinstall 跨平台化：原 `find node_modules -name '._*' -delete`
 * 依赖 POSIX find（Windows cmd 没有）。递归删 exFAT 再生的 AppleDouble 垃圾
 * （AGENTS.md 打包节：node-gyp-build 会选中 ._*.node 导致 022 快捷键失灵）。
 * 失败不阻塞安装（原 `|| true` 语义）。
 */
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'node_modules');

let removed = 0;
function purge(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith('._')) {
      try {
        rmSync(full, { recursive: entry.isDirectory(), force: true });
        removed += 1;
      } catch {
        /* 删不掉的留给运行时自愈（native-module-hygiene） */
      }
    } else if (entry.isDirectory()) {
      purge(full);
    }
  }
}

try {
  purge(target);
} catch {
  /* node_modules 还没装好等情况：不阻塞 install */
}
if (removed > 0) console.log(`[postinstall] 清理 AppleDouble 垃圾 ${removed} 个`);
