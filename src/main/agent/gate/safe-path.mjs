/**
 * 042 · safe-path：文件路径规范化与越界判定（P3 实施核心）。
 * 行为由 scripts/perm-path-race-probe.mjs（P0-3，11/11）钉死：
 *  - 授权根/比较一律用真实路径（macOS 的 /tmp、/var 都是符号链接，字面比较必错）；
 *  - 完整路径分段比较，不做裸字符串前缀（/a/bc 不误中 /a/b）；
 *  - 已存在目标 realpath；新文件走「最近存在父目录＋未存在段拼接」；
 *  - final segment 拒符号链接＋打开后 fstat 复核是 Node 下可得的最强防线
 *    （无 O_NOFOLLOW；彻底封闭需 openat2/受限文件服务，残余窗口已记录）。
 */
import { lstat, realpath, open, stat, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';

export function expandTilde(p, home) {
  const text = String(p ?? '');
  if (text === '~') return home;
  if (text.startsWith('~/')) return path.join(home, text.slice(2));
  return text;
}

/** 相对路径按显式 base（任务 cwd）解析，绝不用 process.cwd。 */
export function absolutize(p, { home, base = null }) {
  const abs = path.isAbsolute(p) ? p : path.resolve(base ?? home, p);
  return path.normalize(abs);
}

/** 分段包含（含自身）。root/target 都应为规范化的绝对路径。 */
export function isWithin(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (r === t) return true;
  return t.startsWith(`${r}${path.sep}`);
}

/** 最近存在父目录＋未存在段（realpath 对不存在路径抛 ENOENT 的替代）。 */
export async function resolveNearestExisting(p) {
  let cur = path.resolve(p);
  const missing = [];
  for (;;) {
    try {
      return { real: await realpath(cur), missing };
    } catch {
      missing.unshift(path.basename(cur));
      const parent = path.dirname(cur);
      if (parent === cur) throw new Error(`无法解析路径：${p}`);
      cur = parent;
    }
  }
}

/**
 * 目标落点解析：返回 { abs, real, exists }。
 * real 是授权比较用的真实路径（新文件＝最近存在父目录真实路径＋未存在段）。
 */
export async function resolveTarget(p, { home, base = null }) {
  const abs = absolutize(expandTilde(p, home), { home, base });
  const st = await lstat(abs).catch(() => null);
  if (st) {
    // 一律 realpath（不只看 final segment）：中间段是链接（ws/h -> ~）时字面 abs
    // 看似在工作区内，真实落点却在外——授权/禁止清单都只认真实路径。
    const real = await realpath(abs).catch(() => null);
    if (real) return { abs, real, exists: true, isDirectory: st.isDirectory(), isSymlink: st.isSymbolicLink() };
    // 悬空链接：按最近存在父目录解析，final segment 仍是链接——读写层会拒。
  }
  const { real: parentReal, missing } = await resolveNearestExisting(abs);
  return { abs, real: path.join(parentReal, ...missing), exists: false, parentReal, missing, isSymlink: Boolean(st?.isSymbolicLink()) };
}

/**
 * 打开并复核（读路径）：final segment 拒符号链接；打开后 fstat 与预期 dev/ino 比对，
 * 防「检查与打开之间被替换」的竞态（P0-3 用例 5 实测可发现）。
 */
export async function openVerifiedRead(expectedReal) {
  // 打开授权判定用的真实路径本身（不经字面路径上的任何链接）；final segment 拒链接，
  // 打开后 fstat 与打开前 lstat 的 dev/ino 比对，发现「检查与打开之间被替换」。
  const st = await lstat(expectedReal).catch(() => null);
  if (!st) return { ok: false, reason: 'not-found' };
  if (st.isSymbolicLink()) return { ok: false, reason: 'final-segment-symlink' };
  const fh = await open(expectedReal, 'r');
  const opened = await fh.stat();
  if (opened.dev !== st.dev || opened.ino !== st.ino) {
    await fh.close().catch(() => {});
    return { ok: false, reason: 'replaced-during-open' };
  }
  return { ok: true, fh, stat: opened };
}

/** 写入用受控临时文件＋同范围提交（技术方案 §6.1）。 */
export async function atomicWriteWithin(dir, file, text) {
  const target = path.join(dir, file);
  const tmp = path.join(dir, `.${path.basename(file)}.hemi-tmp-${process.pid}-${Date.now()}`);
  await mkdir(path.dirname(target), { recursive: true });
  // 覆盖已存在文件时保留原权限位（脚本的 +x 不能因 edit 丢失）。
  const prev = await stat(target).catch(() => null);
  try {
    await writeFile(tmp, text, { encoding: 'utf-8', mode: prev ? prev.mode & 0o7777 : 0o644 });
    if (prev) await chmod(tmp, prev.mode & 0o7777);
    await rename(tmp, target);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  return target;
}
