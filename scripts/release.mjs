#!/usr/bin/env node
/**
 * 044 · 本地发版一键脚本：门禁 → bump 版本 → commit + tag + push。
 * 重活（打包 dmg/zip、生成 latest-mac.yml、传 GitHub Releases）在 CI
 * （.github/workflows/release.yml，推 v* tag 触发）。
 *
 * 用法：
 *   npm run release -- patch|minor|major   # 按语义递增
 *   npm run release -- 0.4.0               # 显式版本
 *   --skip-tests                           # 跳过全量单测（typecheck/build 仍跑）
 *   --mac-only                             # 本次仅发布 macOS，不影响以后双平台发布
 *
 * 退出码非 0 即未发版（不产生 commit/tag/push）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// 仓库路径含中文卷名（闪迪SSD），URL.pathname 会百分号编码——必须 fileURLToPath。
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pkgPath = `${repoRoot}package.json`;

const args = process.argv.slice(2);
const skipTests = args.includes('--skip-tests');
const macOnly = args.includes('--mac-only');
const bump = args.find((arg) => !arg.startsWith('--'));

if (!bump) {
  console.error('用法：npm run release -- <patch|minor|major|显式版本> [--skip-tests] [--mac-only]');
  process.exit(1);
}

function run(cmd, argsList, { cwd = repoRoot, shell = false } = {}) {
  return execFileSync(cmd, argsList, { cwd, encoding: 'utf8', shell }).trim();
}

// Windows 上跑 npm 的口径：npm 是 .cmd 批处理——直接 spawn 报 ENOENT，
// 写全名 npm.cmd 又被 Node 的 CVE-2024-27980 修复拦（EINVAL）。门禁命令
// 参数全是本文件里的固定常量（无用户输入拼接），win 下经 shell 调用安全。
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmShell = process.platform === 'win32';

function bumpVersion(current, spec) {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const [major, minor, patch] = current.split('.').map(Number);
  if (spec === 'major') return `${major + 1}.0.0`;
  if (spec === 'minor') return `${major}.${minor + 1}.0`;
  if (spec === 'patch') return `${major}.${minor}.${patch + 1}`;
  console.error(`无法识别的版本规格：${spec}（patch / minor / major / x.y.z）`);
  process.exit(1);
}

// 1. 工作区必须干净：发版 commit 只含版本号，混进别的改动说不清。
//    只看已跟踪改动：发版 commit 只 add package.json，未跟踪文件进不来；
//    并行会话的未跟踪产物目录（如 research_*/）不该卡发版（2026-10-08 实撞）。
const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']);
if (dirty) {
  console.error('工作区有未提交改动，先提交或暂存再发版：');
  console.error(dirty);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const nextVersion = bumpVersion(pkg.version, bump);
const tag = `v${nextVersion}`;

// 已有同名 tag 直接拦（重发同一版本必须显式删 tag，别静默覆盖）。
const existingTag = run('git', ['tag', '--list', tag]);
if (existingTag) {
  console.error(`tag ${tag} 已存在；重发请先 git tag -d ${tag} && git push origin :refs/tags/${tag}`);
  process.exit(1);
}

// Releases may be prepared in an isolated, detached worktree. Publish its
// tested commit to main explicitly; never infer the destination from HEAD.
run('git', ['fetch', 'origin', 'main']);
run('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']);
if (run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) {
  throw new Error(`Remote tag ${tag} already exists`);
}
run('node', ['scripts/verify-release-materials.mjs']);

// 2. 本地门禁：单测 + typecheck + vite 构建 + 间距门禁 + 原生口径门禁。
const gates = skipTests
  ? [[npmCommand, ['run', 'typecheck']], [npmCommand, ['run', 'build']], ['node', ['scripts/check-spacing.mjs']], ['node', ['scripts/check-native.mjs']]]
  : [[npmCommand, ['test']], [npmCommand, ['run', 'typecheck']], [npmCommand, ['run', 'build']], ['node', ['scripts/check-spacing.mjs']], ['node', ['scripts/check-native.mjs']]];
for (const [cmd, argsList] of gates) {
  console.log(`\n▶ ${cmd} ${argsList.join(' ')}`);
  const useShell = cmd === npmCommand && npmShell;
  run(cmd, argsList, { shell: useShell });
}
console.log('门禁全过。');

// 3. bump + commit + tag + push。
writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, version: nextVersion }, null, 2)}\n`);
const lockPath = `${repoRoot}package-lock.json`;
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
lock.version = nextVersion;
lock.packages[''].version = nextVersion;
const lockBytes = `${JSON.stringify(lock, null, 2)}\n`;
writeFileSync(lockPath, lockBytes);
// Only package metadata changes here; the dependency graph and bundle module
// inventory are identical. Keep its lock digest synchronized without a rebuild.
const manifestPath = 'src/renderer/public/licenses/renderer-components.json';
const manifest = JSON.parse(readFileSync(`${repoRoot}${manifestPath}`, 'utf8'));
manifest.lockfileSha256 = createHash('sha256').update(lockBytes).digest('hex');
const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(`${repoRoot}${manifestPath}`, manifestBytes);
writeFileSync(`${repoRoot}dist-renderer/licenses/renderer-components.json`, manifestBytes);
run('git', ['add', 'package.json', 'package-lock.json', manifestPath]);
run('git', ['commit', '-m', `release: ${tag}${macOnly ? ' [mac-only]' : ''}`]);
// 必须附注标签：轻量标签在部分推送路径会被静默漏掉（v0.4.0 实测：tag 没上去、CI 没触发）。
run('git', ['tag', '-a', tag, '-m', tag]);
// 显式推当版 tag——旧写法 `--follow-tags` 会把本地所有未推的附注标签一起带上去：
// v0.6.3 实撞：残留的 v0.6.1 旧 tag 被一并推走，触发了一条旧版发版流水线
// （抢建 release/抢写 latest-mac.yml，须手动取消＋删 tag）。
run('git', ['push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}`]);

console.log(`
已发版 ${tag}，已推送。CI 正在构建：
  https://github.com/PiuQiuPiaQia/Hemi/actions/workflows/release.yml

产物发布后按 AGENTS.md 打包节验收：
  - dmg 表观体积与 ._ * 垃圾清零口径
  - 安装后设置 → 通用 → 关于与更新：检查更新/下载/重启安装走一轮
`);
