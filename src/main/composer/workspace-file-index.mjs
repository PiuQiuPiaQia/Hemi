// 063 · `@` 文件／文件夹候选的工作区索引（有界遍历＋短缓存）。
//
// 候选只是「工作区里有什么」；引用身份＝工作区 id＋相对路径，读取在
// workspace-reader.mjs 受控完成（路径包含校验）。默认（家目录）工作区不建
// 索引——深扫整个 home 既慢又吵，只有绑定的项目工作区提供文件候选。
import path from 'node:path';

/** 遍历忽略的目录名（依赖产物/仓库元数据/重缓存）。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.cache', '.pytest_cache', '.mypy_cache', 'target',
  'DerivedData', '.turbo', '.parcel-cache', 'coverage',
]);

/** 单文件体积上限不在此判（候选只列名）；条目数与深度有界。 */
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_ENTRIES = 1200;

const toPosix = (value) => value.split(path.sep).join('/');

/**
 * 本地工作区有界遍历（BFS，浅层优先）。
 * @returns {{ files: Array<{refPath:string,name:string}>, folders: Array<{refPath:string,name:string}>, truncated: boolean }}
 */
export async function walkWorkspaceEntries(dir, {
  readdir = null, maxDepth = DEFAULT_MAX_DEPTH, maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const read = readdir ?? ((target) => import('node:fs/promises').then((fs) => fs.readdir(target, { withFileTypes: true })));
  const files = [];
  const folders = [];
  let truncated = false;
  const queue = [{ dir, rel: '', depth: 0 }];
  while (queue.length) {
    const { dir: current, rel, depth } = queue.shift();
    let entries = [];
    try {
      entries = await read(current);
    } catch {
      continue; // 无权限/已删除的目录跳过，不让整次索引失败
    }
    for (const entry of entries) {
      // exFAT 的 ._* AppleDouble 垃圾与通用隐藏缓存不入候选。
      if (entry.name.startsWith('._') || entry.name === '.DS_Store') continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (files.length + folders.length >= maxEntries) { truncated = true; continue; }
        folders.push({ refPath: toPosix(childRel), name: entry.name });
        if (depth + 1 <= maxDepth) queue.push({ dir: path.join(current, entry.name), rel: childRel, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length + folders.length >= maxEntries) { truncated = true; continue; }
      files.push({ refPath: toPosix(childRel), name: entry.name });
    }
  }
  files.sort((a, b) => a.refPath.localeCompare(b.refPath));
  folders.sort((a, b) => a.refPath.localeCompare(b.refPath));
  return { files, folders, truncated };
}

/**
 * 按工作区建索引（TTL 缓存；同一工作区连续输入不重复扫盘）。
 * @param {(workspaceId: string) => Promise<{files:Array,folders:Array,truncated:boolean}|null>} collect
 */
export function createWorkspaceFileIndex({ collect, now = () => Date.now(), ttlMs = 15_000 } = {}) {
  const cache = new Map(); // workspaceKey → { value, expiresAt }
  return {
    async entriesOf(workspaceKey) {
      const hit = cache.get(workspaceKey);
      if (hit && hit.expiresAt > now()) return hit.value;
      const value = await collect(workspaceKey);
      cache.set(workspaceKey, { value, expiresAt: now() + ttlMs });
      return value;
    },
    invalidate(workspaceKey = null) {
      if (workspaceKey == null) cache.clear();
      else cache.delete(workspaceKey);
    },
  };
}
