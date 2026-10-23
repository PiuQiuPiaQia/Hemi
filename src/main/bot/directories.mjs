import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fail } from './storage.mjs';

export async function cloudDirectory(
  raw,
  { writable = false, controlDir } = {},
) {
  let target = String(raw ?? '').trim();
  if (target === '~') target = os.homedir();
  else if (target.startsWith('~/'))
    target = path.join(os.homedir(), target.slice(2));
  if (!path.isAbsolute(target) || target.includes('\0'))
    fail('请输入服务器上的绝对文件夹路径。');
  try {
    const real = await fs.realpath(target);
    if (
      controlDir &&
      (real === controlDir || real.startsWith(controlDir + path.sep))
    )
      fail('Bot 的运行数据目录不能作为工作目录。', 'permission');
    if (!(await fs.stat(real)).isDirectory())
      fail('这不是一个文件夹。', 'missing');
    await fs.access(
      real,
      constants.R_OK | constants.X_OK | (writable ? constants.W_OK : 0),
    );
    return real;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      fail('服务器上找不到这个文件夹。', 'missing');
    if (error.code === 'EACCES' || error.code === 'EPERM')
      fail('当前服务器账号没有访问这个文件夹的权限。', 'permission');
    throw error;
  }
}
export async function listCloudDirectories(raw, options) {
  const dir = await cloudDirectory(raw, options);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const folders = [];
  for (const entry of entries.slice(0, 5000)) {
    if (entry.name.startsWith('.')) continue;
    const candidate = path.join(dir, entry.name);
    if (
      entry.isDirectory() ||
      (entry.isSymbolicLink() &&
        (await fs.stat(candidate).then(
          (s) => s.isDirectory(),
          () => false,
        )))
    )
      folders.push({ name: entry.name, path: candidate });
  }
  return {
    path: dir,
    parent: path.dirname(dir),
    home: os.homedir(),
    folders: folders.sort((a, b) => a.name.localeCompare(b.name)),
    truncated: entries.length > 5000,
  };
}
