// 050 · 文件事实（R-06/R-07）：任务改了哪些文件、± 多少行。
//
// 两条腿（S0 探针 probe-050-file-changes.mjs 移植，改异步 spawn）：
//  - 工具记录：write/edit 的 tool-start 捕获「首次修改前」内容（S5 Diff 与
//    ± 行数用），成功回执确认触及；非 git 目录只有这条腿（coverage='tools'）。
//  - git 快照：任务工作目录是 git 仓库时，受理时（与执行器启动并行）做首个
//    私有 index 快照，终态再做一次 → diff-tree 补获 bash 等命令改动
//    （coverage='tools+git'）。私有 GIT_INDEX_FILE 以用户 index 副本为种子
//    （保留 stat 缓存），不触碰用户 index/refs/工作树——探针 A/B 全过：
//    任务前脏改动不计入、A/M/D/R 识别、exFAT `._*` 垃圾排除、二进制无行数、
//    用户 .git/index 字节不变。
//
// 全部异步 spawn（主进程事件循环 ≥250ms 告警口径，绝不 execFileSync）；
// 快照超时 5s 降级（degraded 带原因，不阻塞终态）。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const FILE_CHANGES_LIMITS = {
  /** 快照/比对的整体预算；超时降级（degraded 带原因）。 */
  timeoutMs: 5000,
  /** S5：单文件「首次修改前」内容上限（超过只记哈希与行数）。 */
  beforeContentMaxBytes: 1024 * 1024,
  /** S5：任务总量内容预算。 */
  beforeContentTotalBytes: 20 * 1024 * 1024,
  /** 清单条数上限（超出截断并记 degraded）。 */
  files: 200,
};

const JUNK_RE = /(^|\/)\._[^/]*$/; // exFAT AppleDouble 垃圾

/** 异步 git（成功 stdout；非零退出码＝失败，带 stderr 摘要）。 */
function git(cwd, args, { env = {}, timeoutMs = FILE_CHANGES_LIMITS.timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args[0]} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args[0]} 退出码 ${code}：${stderr.trim().slice(0, 160)}`));
    });
  });
}

/** 目录是否 git 仓库（快照的前置判定；失败按「不是」处理）。 */
export async function isGitRepo(dir) {
  if (!dir) return false;
  try {
    // 预算与快照同档：冷 Windows 上 Defender 首扫 git.exe，2s 会把慢启动
    // 误判成「不是 git 仓库」（v0.6.1 win CI 实测嫌疑，原因串已入诊断）。
    await git(dir, ['rev-parse', '--absolute-git-dir'], { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 私有 index 快照：复制用户 index 作种子（保留 stat 缓存，避免全量重哈希），
 * add -A 后 write-tree。返回 { ok: true, tree } 或 { ok: false, reason }。
 * 快照会向对象库写入松散 blob（与 git add 相同，gc 可回收），不改用户侧任何状态。
 */
export async function snapshotTree(repo) {
  const { copyFileSync, existsSync } = await import('node:fs');
  let tmp;
  try {
    const gitDir = (await git(repo, ['rev-parse', '--absolute-git-dir'])).trim();
    tmp = mkdtempSync(path.join(tmpdir(), 'hemi050-idx-'));
    const idx = path.join(tmp, 'index');
    const seed = path.join(gitDir, 'index');
    if (existsSync(seed)) copyFileSync(seed, idx);
    const env = { GIT_INDEX_FILE: idx, GIT_OPTIONAL_LOCKS: '0' };
    // exFAT 的 ._* AppleDouble 垃圾排除（会被 node-gyp 类工具选中导致假变化）。
    await git(repo, ['add', '-A', '--', '.', ':(exclude,glob)**/._*'], { env });
    const tree = (await git(repo, ['write-tree'], { env })).trim();
    return { ok: true, tree };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 160) };
  } finally {
    if (tmp) {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不报 */ }
    }
  }
}

/**
 * 两个快照之间的变化（-M 识别改名），过滤 exFAT 垃圾。
 * 返回 { ok: true, files: [{ path, kind, add, del }], junkExcluded }。
 */
export async function diffTreeChanges(repo, baseTree, targetTree) {
  try {
    const numstat = await git(repo, ['diff-tree', '-r', '-M', '--numstat', '-z', baseTree, targetTree]);
    const status = await git(repo, ['diff-tree', '-r', '-M', '--name-status', baseTree, targetTree]);
    // name-status：`R100\t旧路径\t新路径`；其余为 `A\t路径`。
    const kinds = new Map();
    const fromPaths = new Map();
    for (const line of status.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      const code = parts[0];
      if (code.startsWith('R')) {
        fromPaths.set(parts[2], parts[1]);
        kinds.set(parts[2], 'R');
      } else {
        kinds.set(parts[1], code[0]);
      }
    }
    const out = [];
    let junkExcluded = 0;
    const parts = numstat.split('\0').filter((x) => x !== '');
    for (let i = 0; i < parts.length; i += 1) {
      const [add, del, maybePath] = parts[i].split('\t');
      let file = maybePath;
      if (maybePath === '') {
        i += 2;
        file = parts[i];
      }
      if (JUNK_RE.test(file)) {
        junkExcluded += 1;
        continue;
      }
      out.push({
        path: file,
        kind: kinds.get(file) ?? '?',
        ...(fromPaths.has(file) ? { fromPath: fromPaths.get(file) } : {}),
        add: add === '-' ? null : Number(add),
        del: del === '-' ? null : Number(del),
      });
    }
    return { ok: true, files: out, junkExcluded };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 160) };
  }
}

/** 两段文本的 ± 行数（git diff --no-index --numstat 同口径；临时文件落 tmpdir）。 */
export async function numstatOf(before, after) {
  const stats = await diffRaw(before, after, ['--numstat']);
  const trimmed = stats.trim();
  if (!trimmed) return { add: 0, del: 0 };
  const [add, del] = trimmed.split('\t');
  return { add: add === '-' ? null : Number(add), del: del === '-' ? null : Number(del) };
}

/**
 * 050 R-22：首次修改前 vs 最终的统一 diff 文本（S5 Diff 审查）。
 * 依赖工具记录里保住的 before 内容；git diff --no-index 出 unified 格式，
 * 输出截到 diffMaxChars（防一次巨 diff 撑爆档案）。
 */
export async function unifiedDiffOf(before, after, { diffMaxChars = 64 * 1024 } = {}) {
  const out = await diffRaw(before, after, ['--unified=3', '--no-color', '--no-prefix']);
  const chars = Array.from(out);
  if (chars.length <= diffMaxChars) return { text: out, truncated: false };
  return { text: `${chars.slice(0, diffMaxChars).join('')}\n…（差异过长已截断，共 ${chars.length} 字）`, truncated: true };
}

/** git diff --no-index（退出码 1＝有差异，不是错误）。 */
async function diffRaw(before, after, args) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'hemi050-num-'));
  try {
    const fileA = path.join(tmp, 'a');
    const fileB = path.join(tmp, 'b');
    writeFileSync(fileA, before ?? '');
    writeFileSync(fileB, after ?? '');
    // 必须 await 完再出 try——否则 finally 的 rmSync 会在 git 读取中删掉临时文件。
    return await new Promise((resolve, reject) => {
      const child = spawn('git', ['diff', '--no-index', ...args, fileA, fileB], { stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('error', reject);
      child.on('close', () => resolve(stdout));
    });
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不报 */ }
  }
}

/**
 * 工具记录合并成净变化清单（探针 C 的异步版）：
 * 按路径保留「首次修改前」与「最终」内容；改后改回/建后删＝无净变化剔除；
 * ± 行数按 numstat。before/after 为 null 表示「不存在」。
 */
export async function mergeToolTouches(touches, { readCurrent }) {
  const first = new Map();
  const lastSeen = new Map();
  for (const touch of touches) {
    if (!first.has(touch.path)) first.set(touch.path, touch.before ?? null);
    lastSeen.set(touch.path, true);
  }
  const out = [];
  for (const [filePath, before] of first) {
    const after = await readCurrent(filePath);
    if (before === after) continue; // 改后改回
    if (before == null && after == null) continue; // 建后删
    const kind = before == null ? 'A' : after == null ? 'D' : 'M';
    const stats = kind === 'A' || kind === 'M' ? await numstatOf(before, after ?? '') : { add: null, del: null };
    out.push({ path: filePath, kind, add: stats.add, del: stats.del, source: 'tool' });
  }
  return out;
}
