import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';

const ALLOWED = /^(?:MEMORY\.md|SCRATCHPAD\.md|daily\/\d{4}-\d{2}-\d{2}\.md|recovery\/[0-9a-f-]{36}\.json)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

/** Read-only file transport for the runtime's original files. No memory parsing or mutations. */
export async function listRuntimeFiles(root) {
  const rootStat = await fs.lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!rootStat) return [];
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('运行目录不是普通目录');
  const files = [];
  for (const name of ['MEMORY.md', 'SCRATCHPAD.md', 'daily', 'recovery']) {
    const target = path.join(root, name);
    let stat;
    try { stat = await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) continue;
    const names = stat.isDirectory() ? (await fs.readdir(target)).map(file => `${name}/${file}`) : [name];
    for (const relativePath of names) {
      if (!ALLOWED.test(relativePath)) continue;
      const item = await fs.lstat(path.join(root, relativePath)).catch(() => null);
      if (item?.isFile() && !item.isSymbolicLink()) files.push({ path: relativePath, size: item.size, modifiedAt: item.mtimeMs });
    }
  }
  return files.sort((a, b) => b.path.localeCompare(a.path));
}

export async function readRuntimeFile(root, relativePath) {
  if (typeof relativePath !== 'string' || !ALLOWED.test(relativePath)) throw new Error('不能读取此运行文件');
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('运行目录不是普通目录');
  const actualRoot = await fs.realpath(root);
  const parent = path.dirname(path.join(actualRoot, relativePath));
  const actualParent = await fs.realpath(parent);
  if (actualParent !== parent) throw new Error('不能通过链接读取运行文件');
  const handle = await fs.open(path.join(actualRoot, relativePath), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('文件过大或不是普通文件');
    const bytes = Buffer.alloc(Math.min(MAX_BYTES + 1, stat.size + 1));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error('文件过大');
    return { path: relativePath, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)), modifiedAt: stat.mtimeMs };
  } finally { await handle.close(); }
}
