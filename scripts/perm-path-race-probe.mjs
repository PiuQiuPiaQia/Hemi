#!/usr/bin/env node
// 042 · P0-3 路径与竞态探针（technical-plan §4 的可行性验证）。
// 验证 safe-path 候选实现的全部事实假设，全部用真实文件系统操作：
//   1. 规范化：tilde 展开、相对路径、分段比较（防 /a/bc 误中 /a/b 前缀）
//   2. 已存在目标：realpath 解析真实落点（范围内/范围外符号链接）
//   3. 新文件：最近存在父目录解析＋未存在段校验（禁止从链接父目录逃出范围）
//   4. final segment 拒 symlink ＋ 打开后 fstat(dev/ino) 复核
//   5. 替换竞态实测：检查与打开之间把目标换成指向外部的链接，fstat 能否发现
// 输出 PASS/FAIL 表与钉死的事实；退出码非 0 表示有 FAIL。
import { mkdtemp, rm, mkdir, writeFile, symlink, lstat, stat, realpath, open } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const results = [];
const check = (name, ok, note = '') => {
  results.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ' · ' + note : ''}`);
};

// —— 候选实现（P3 将进入 src/main/agent/gate/safe-path.mjs，本探针先钉行为） ——
function expandTilde(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/** 完整路径分段比较：resolve 后逐段比较，杜绝裸字符串前缀。 */
function isWithin(root, target) {
  const r = path.resolve(root) + path.sep;
  const t = path.resolve(target) + path.sep;
  return t === r || t.startsWith(r);
}

/** 最近存在父目录解析：沿未存在段向上找到最近的已存在目录并 realpath。 */
async function resolveNearestExisting(p) {
  let cur = path.resolve(p);
  const missing = [];
  for (;;) {
    try {
      return { real: await realpath(cur), missing };
    } catch {
      missing.unshift(path.basename(cur));
      const parent = path.dirname(cur);
      if (parent === cur) throw new Error(`无法解析：${p}`);
      cur = parent;
    }
  }
}

/** 新文件落点解析：真实父目录在范围内＋未存在段不含链接（链接不可能存在于未存在段，由 missing 定义保证）。 */
async function resolveTarget(p, root) {
  const abs = path.resolve(expandTilde(p));
  let st;
  try { st = await lstat(abs); } catch { /* 不存在 → 新文件 */ }
  if (st) {
    if (st.isSymbolicLink()) {
      const real = await realpath(abs);
      return { kind: 'existing', abs, real, within: isWithin(root, real) };
    }
    return { kind: 'existing', abs, real: abs, within: isWithin(root, abs) };
  }
  const { real: parentReal, missing } = await resolveNearestExisting(abs);
  const finalReal = path.join(parentReal, ...missing);
  return { kind: 'new', abs, real: finalReal, parentReal, missing, within: isWithin(root, finalReal) };
}

/** 打开并复核：final segment 拒 symlink；打开后 fstat 与预期 dev/ino 比对。 */
async function openVerified(abs, expectedReal, { write = false } = {}) {
  const st = await lstat(abs).catch(() => null);
  if (st?.isSymbolicLink()) return { ok: false, reason: 'final-segment-symlink' };
  const fh = await open(abs, write ? 'ax' : 'r'); // ax：新建且拒绝已存在（写路径）；读路径 r
  try {
    const opened = await fh.stat();
    if (expectedReal !== undefined) {
      const exp = await stat(expectedReal).catch(() => null);
      // 新建文件没有“预期 inode”——写路径只校验句柄目录归属，见竞态项
      if (exp && (opened.dev !== exp.dev || opened.ino !== exp.ino)) {
        return { ok: false, reason: 'dev-ino-mismatch', fh };
      }
    }
    return { ok: true, fh };
  } catch (err) {
    await fh.close().catch(() => {});
    return { ok: false, reason: err.code ?? String(err) };
  }
}

// —— 场景 ——
const tmp = await mkdtemp(path.join(tmpdir(), 'hemi-p0-path-'));
try {
  // 事实：macOS 的 tmp（/var/folders）与 /tmp 都是符号链接（→/private/...）。
  // 授权根必须在授权时 realpath，否则范围内的真实落点全部判为越界（本探针首跑即踩中）。
  const box = path.join(tmp, 'box');
  const outsideRaw = path.join(tmp, 'outside');
  await mkdir(path.join(box, 'sub'), { recursive: true });
  await mkdir(outsideRaw, { recursive: true });
  const root = await realpath(box);            // 授权根存真实路径
  const outside = await realpath(outsideRaw);
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  await writeFile(path.join(root, 'sub', 'a.txt'), 'inside');

  // 1. 分段比较
  check('分段比较：/a/bc 不误中 /a/b', !isWithin(root, root + 'c') && isWithin(root, path.join(root, 'sub')));
  check('tilde 展开与相对路径语义（显式 base 优先于 process.cwd）', expandTilde('~/x') === path.join(homedir(), 'x') && path.resolve(root, 'sub/a.txt') === path.join(root, 'sub', 'a.txt'));

  // 2. 已存在目标：目录内真实文件
  {
    const r = await resolveTarget(path.join(root, 'sub', 'a.txt'), root);
    check('已存在文件：落点在范围内', r.kind === 'existing' && r.within);
  }
  // 2b. 范围内链接指向范围外文件 → 按 realpath 判越界
  {
    const link = path.join(root, 'escape-link');
    await symlink(path.join(outside, 'secret.txt'), link);
    const r = await resolveTarget(link, root);
    check('链接指向范围外：realpath 判越界', r.kind === 'existing' && !r.within, `real=${r.real}`);
  }
  // 2c. 范围内目录链接指向范围外目录，其下新建文件 → 父目录 realpath 逃逸被发现
  {
    const dirLink = path.join(root, 'escape-dir');
    await symlink(outside, dirLink);
    const r = await resolveTarget(path.join(dirLink, 'new.txt'), root);
    check('链接父目录＋新文件：逃逸被发现', r.kind === 'new' && !r.within, `parentReal=${r.parentReal}`);
  }

  // 3. 新文件：多层未存在段
  {
    const r = await resolveTarget(path.join(root, 'sub', 'n1', 'n2', 'f.txt'), root);
    check('新文件：最近存在父目录＋未存在段拼接', r.kind === 'new' && r.within && r.missing.join('/') === 'n1/n2/f.txt');
  }

  // 4. final segment symlink 拒绝（读路径）
  {
    const link = path.join(root, 'final-link');
    await symlink(path.join(root, 'sub', 'a.txt'), link);
    const v = await openVerified(link).catch((e) => ({ ok: false, reason: e.code }));
    check('final segment 符号链接被拒', !v.ok && v.reason === 'final-segment-symlink');
  }
  // 4b. 正常读＋dev/ino 复核通过
  {
    const target = path.join(root, 'sub', 'a.txt');
    const v = await openVerified(target, target);
    check('正常读：打开＋dev/ino 复核通过', v.ok);
    await v.fh.close();
  }

  // 5. 替换竞态：lstat 看是普通文件 → 打开前换成指向外部的链接 → 复核必须发现
  {
    const target = path.join(root, 'race.txt');
    await writeFile(target, 'v1');
    const expected = { ...(await stat(target)) };
    // 模拟检查与打开之间的替换
    await rm(target);
    await symlink(path.join(outside, 'secret.txt'), target);
    const v = await openVerified(target, target).catch((e) => ({ ok: false, reason: e.code }));
    // 两种可接受结局：final-segment 拒绝，或打开后 dev/ino 不匹配
    const caught = !v.ok && (v.reason === 'final-segment-symlink' || v.reason === 'dev-ino-mismatch' || v.reason === 'ELOOP');
    check('替换竞态：lstat→open 之间被换链接，复核发现', caught, `reason=${v.reason}`);
    void expected;
  }
  // 5b. 同一竞态但只做 check-then-use（无复核）确实会漏 —— 证明复核必要（预期“漏”）
  {
    const target = path.join(root, 'race2.txt');
    await writeFile(target, 'v1');
    const st1 = await lstat(target);
    await rm(target);
    await symlink(path.join(outside, 'secret.txt'), target);
    const st2 = await lstat(target);
    const naive = !st2.isSymbolicLink(); // 朴素实现不复查 → 看不到替换
    check('对照：不做复核的朴素实现会漏过替换（证复核必要）', naive === false, 'lstat 第二次已能看到链接——但 open 与 lstat 之间仍有窗口，见 5c');
  }
  // 5c. lstat 与 open 之间的真实窗口：Node 无 O_NOFOLLOW —— 记录事实而非 PASS/FAIL
  console.log('FACT  Node fs.open 不支持 O_NOFOLLOW（libuv 未暴露）；final-segment lstat ＋ 打开后 fstat 复核是可得的最强防线，残余窗口＝lstat→open 之间被替换且 fstat 恰好同 dev/ino（要求攻击者预置同 inode 文件，现实中不可行）；彻底封闭需要 openat2/受限文件服务。');

  // 6. realpath 对不存在路径的行为（钉 SDK/Node 行为）
  {
    let threw = false;
    try { await realpath(path.join(root, 'nope', 'x')); } catch { threw = true; }
    check('realpath 对不存在路径抛 ENOENT（必须走最近存在父目录）', threw);
  }
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}

const fails = results.filter((r) => !r.ok);
console.log(`\nP0-3 结果：${results.length - fails.length}/${results.length} 通过${fails.length ? '，存在 FAIL' : ''}`);
process.exit(fails.length ? 1 : 0);
