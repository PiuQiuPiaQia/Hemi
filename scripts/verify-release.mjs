#!/usr/bin/env node
/**
 * 044 · 发版后验收一键脚本：盯 CI → release 对象核对（含双 publisher 重复
 * release 的检测与抢救清理）→ latest-mac.yml / latest.yml 双清单核验 → 产物
 * 体检 → 打包冒烟（win 安装包 sha512 实测走更新器同款校验链）。
 *
 * 为什么需要它：electron-builder 26.x `--publish always` + 双 target（dmg+zip）
 * 时两个 publisher 竞争「create GitHub release」，每次发版都会产生两个同 tag
 * 的 release 对象——一个全量、一个只有 dmg.blockmap 的孤儿（v0.4.0～v0.5.1
 * 四连发实测）。残缺重复项会让公开下载直链命中缺少清单或安装包的对象。
 *
 * 用法：
 *   npm run verify:release -- [--fix] [--no-smoke] [--fresh] [vX.Y.Z]
 *   tag 缺省 = v + package.json version；--fix 才会动 release（抢救孤儿独有
 *   资产后删孤儿对象，不动 tag 与完整 release）；默认只报告。
 *   --no-smoke 跳过打包冒烟；--fresh 忽略缓存重新下载解包。
 *   HEMI_RELEASE_VERIFY_CACHE_DIR 可指定缓存根目录（版本在其下单独存放）。
 *
 * 退出码非 0 = 验收未过。
 */
import { spawnSync } from 'node:child_process';
import {
  createHash,
} from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releasePlatform } from './lib/release-platform.mjs';

// 仓库路径含中文卷名（闪迪SSD），URL.pathname 会百分号编码——必须 fileURLToPath。
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(`${repoRoot}/package.json`, 'utf8'));

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const noSmoke = args.includes('--no-smoke');
const fresh = args.includes('--fresh');
const releaseTarget = releasePlatform(args);
// 双端发版：release 对象按双端完整性核验（不跳过任一端资产）；本机冒烟按宿主平台走。
const bothMode = releaseTarget === 'both';
const macOnly = releaseTarget === 'mac' || (bothMode && process.platform === 'darwin');
const explicitTag = args.find((arg) => /^v/.test(arg));
const tag = explicitTag ?? `v${pkg.version}`;

/** 必备产物（blockmap 缺失降级为警告——差量更新关闭时无功能影响）。 */
const REQUIRED_ASSETS = ['.dmg', '-mac.zip', 'latest-mac.yml', '-setup.exe', 'latest.yml', 'uiohook-napi-1.5.5-source.tar.gz', 'licenses-macos.json', 'licenses-windows.json'];
/** 完整 release 的判别特征：公开更新所需的清单必须存在。 */
const MANIFEST = macOnly ? 'latest-mac.yml' : 'latest.yml';
/** win 的更新清单（2026-10-12 起 win 应用内更新上线，nsis target 产出）。 */
const WIN_MANIFEST = 'latest.yml';
/** 冒烟 userData 的配置件套：要么全拷要么都不拷（ASR Key 不带 onboarding.json
 *  会稳定挂悬浮球断言——引导中门闸，2026-10-08 记忆在案）。 */
const SMOKE_CONFIG_FILES = [
  'doubao-asr.json',
  'text-model.json',
  'text-model-profiles.json',
  'web-search.json',
  'onboarding.json',
];

function run(cmd, argsList, { allowFailure = false } = {}) {
  const result = spawnSync(cmd, argsList, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) {
    console.error(`✗ ${cmd} ${argsList.join(' ')} 退出码 ${result.status}`);
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(1);
  }
  return result;
}

function ghJson(apiPath) {
  return JSON.parse(run('gh', ['api', apiPath]).stdout);
}

/** 二进制资产下载：stdout 重定向到文件 fd，避免 execFileSync 缓冲整包。 */
function downloadAsset(assetId, targetPath) {
  const fd = openSync(targetPath, 'w');
  try {
    const result = spawnSync(
      'gh',
      ['api', `repos/${repo}/releases/assets/${assetId}`, '-H', 'Accept: application/octet-stream'],
      { stdio: ['ignore', fd, 'inherit'] },
    );
    if (result.status !== 0) throw new Error(`asset ${assetId} 下载失败（exit ${result.status}）`);
  } finally {
    closeSync(fd);
  }
}

async function sha512Base64(filePath) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('base64');
}

const step = (title) => console.log(`\n▶ ${title}`);
const ok = (message) => console.log(`  ✓ ${message}`);
const warn = (message) => console.log(`  ⚠ ${message}`);
const fail = (message) => {
  console.error(`  ✗ ${message}`);
  process.exit(1);
};

step('定位仓库与 tag');
const repo = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).stdout.trim();
ok(`${repo} · ${tag}（当前 package.json ${pkg.version}）`);

// ── 1. 等 CI ─────────────────────────────────────────────────────────────
step('等 release CI 跑完');
let runInfo = null;
for (let i = 0; i < 80; i += 1) {
  const list = JSON.parse(
    run('gh', [
      'run', 'list', '--workflow=release.yml', '--branch', tag, '--limit', '1',
      '--json', 'databaseId,status,conclusion',
    ]).stdout,
  );
  if (list.length > 0 && list[0].status === 'completed') {
    runInfo = list[0];
    break;
  }
  if (i === 0) console.log('  … CI 进行中，每 15s 轮询（上限 20 分钟）');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
}
if (!runInfo) fail('20 分钟内 CI 没跑完（或 workflow 没被 tag 触发——查附注标签雷）');
if (runInfo.conclusion !== 'success') {
  fail(`CI 结论 ${runInfo.conclusion}——gh run view ${runInfo.databaseId} --log-failed 定位`);
}
ok(`run ${runInfo.databaseId} success`);

// ── 2. release 对象核对（含孤儿检测与清理） ──────────────────────────────
step('release 对象核对');
const releases = ghJson(`repos/${repo}/releases?per_page=50`)
  .filter((release) => release.tag_name === tag);
if (releases.length === 0) fail(`没有 ${tag} 的 release 对象（CI success 但没发布出去？）`);
const complete = releases.filter((release) => release.assets.some((a) => a.name === MANIFEST));
if (complete.length !== 1) fail(`${complete.length} 个 release 对象都带 ${MANIFEST}，需人工裁决`);
const orphans = releases.filter((release) => release !== complete[0]);
if (orphans.length > 0) {
  for (const orphan of orphans) {
    warn(`孤儿 release ${orphan.id}（只有 ${orphan.assets.map((a) => a.name).join(', ') || '无资产'}）`);
    if (!fix) {
      warn('  带 --fix 才清理：孤儿独有资产补进完整 release 后删孤儿对象');
      continue;
    }
    for (const asset of orphan.assets) {
      if (complete[0].assets.some((a) => a.name === asset.name)) continue;
      const tmp = path.join(os.tmpdir(), `hemi-salvage-${asset.id}`);
      downloadAsset(asset.id, tmp);
      const upload = spawnSync(
        'gh',
        [
          'api', '--method', 'POST',
          `https://uploads.github.com/repos/${repo}/releases/${complete[0].id}/assets?name=${encodeURIComponent(asset.name)}`,
          '-H', 'Content-Type: application/octet-stream', '--input', tmp,
        ],
        { encoding: 'utf8' },
      );
      rmSync(tmp, { force: true });
      if (upload.status !== 0) fail(`抢救 ${asset.name} 上传失败：${upload.stderr}`);
      ok(`抢救 ${asset.name} → release ${complete[0].id}`);
    }
    run('gh', ['api', '--method', 'DELETE', `repos/${repo}/releases/${orphan.id}`]);
    ok(`孤儿 ${orphan.id} 已删（tag 不动）`);
  }
}
const release = ghJson(`repos/${repo}/releases/${complete[0].id}`);
if (release.draft) fail('release 还是草稿');
ok(`非草稿 · ${release.assets.length} 资产 · ${release.html_url}`);

// ── 3. 资产与更新清单核验（latest-mac.yml + latest.yml） ─────────────────
step(`资产与更新清单核验（${MANIFEST}）`);
for (const suffix of REQUIRED_ASSETS) {
  if (macOnly && !bothMode && (suffix === '-setup.exe' || suffix === WIN_MANIFEST || suffix === 'licenses-windows.json')) continue;
  if (!macOnly && !bothMode && ['.dmg', '-mac.zip', 'latest-mac.yml', 'licenses-macos.json'].includes(suffix)) continue;
  if (!release.assets.some((a) => a.name.endsWith(suffix))) fail(`缺 ${suffix} 产物`);
}
for (const blockmap of release.assets.filter((a) => a.name.endsWith('.blockmap'))) ok(`blockmap ${blockmap.name} 在场`);
if (!release.assets.some((a) => a.name.endsWith('.blockmap'))) {
  warn('没有任何 blockmap（差量更新关闭时无功能影响，仅记录）');
}
// Only the selected platform's installer is required or downloaded.
const winSetup = release.assets.find((a) => /-setup\.exe$/.test(a.name));
if (!winSetup) {
  if (macOnly) {
    ok('仅 macOS 发布，无 Windows 安装包');
  } else {
    fail('没找到 Windows 安装包（release-win job 没跑完？）');
  }
} else {
  ok(`Windows 安装包 ${winSetup.name} · ${(winSetup.size / 1024 / 1024).toFixed(0)} MB`);
}

/** manifest 的 files 条目（url/sha512/size；条目内字段带 4 空格缩进，正则放行前导空白）。 */
function manifestFileEntries(text) {
  return text.split(/^  - /m).slice(1).map((entry) => ({
    url: /^\s*url:\s*(\S+)\s*$/m.exec(entry)?.[1],
    size: Number(/^\s*size:\s*(\d+)\s*$/m.exec(entry)?.[1]),
    sha512: /^\s*sha512:\s*(\S+)\s*$/m.exec(entry)?.[1],
  }));
}

/** 清单核验：version 对 tag、files[].url 资产在场且 size 一致（更新器同款寻址）。 */
function verifyManifest(manifestName) {
  const asset = release.assets.find((a) => a.name === manifestName);
  const filePath = path.join(os.tmpdir(), `hemi-manifest-${asset.id}.yml`);
  downloadAsset(asset.id, filePath);
  const text = readFileSync(filePath, 'utf8');
  rmSync(filePath, { force: true });
  const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (version !== tag.slice(1)) fail(`${manifestName} version=${version} ≠ ${tag}`);
  ok(`${manifestName} version ${version}`);
  for (const entry of manifestFileEntries(text)) {
    if (!entry.url || !Number.isFinite(entry.size)) fail(`${manifestName} 条目解析失败：${entry.url ?? '无 url'}`);
    const target = release.assets.find((a) => a.name === entry.url);
    if (!target) fail(`${manifestName} 引用 ${entry.url} 但 release 上没有`);
    if (target.size !== entry.size) fail(`${entry.url}：manifest size ${entry.size} ≠ 资产 ${target.size}`);
    ok(`${entry.url} size ${entry.size} 对得上`);
  }
  return text;
}

const manifest = macOnly ? verifyManifest(MANIFEST) : null;
const winManifest = macOnly ? null : verifyManifest(WIN_MANIFEST);

// ── 4. 产物体检 + 打包冒烟 ───────────────────────────────────────────────
const IS_WIN = process.platform === 'win32';
const zipAsset = macOnly ? release.assets.find((a) => a.name.endsWith('-mac.zip')) : null;
// 产物缓存目录：mac 用 ~/Library/Caches，win 对齐 %LOCALAPPDATA%。
const cacheDir = process.env.HEMI_RELEASE_VERIFY_CACHE_DIR
  ? path.join(path.resolve(process.env.HEMI_RELEASE_VERIFY_CACHE_DIR), tag)
  : IS_WIN
  ? path.join(os.homedir(), 'AppData', 'Local', 'hemi-release-verify', tag)
  : path.join(os.homedir(), 'Library', 'Caches', 'hemi-release-verify', tag);
mkdirSync(cacheDir, { recursive: true });
const sourceAsset = release.assets.find((a) => a.name === 'uiohook-napi-1.5.5-source.tar.gz');
const sourcePath = path.join(cacheDir, sourceAsset.name);
downloadAsset(sourceAsset.id, sourcePath);
if (!readFileSync(sourcePath).equals(readFileSync(path.join(repoRoot, 'third-party', sourceAsset.name)))) fail('Release 对应源码与已验证归档不一致');
ok('Release 对应源码归档字节一致');
for (const name of [macOnly ? 'licenses-macos.json' : 'licenses-windows.json']) {
  const asset = release.assets.find((a) => a.name === name);
  const reportPath = path.join(cacheDir, name);
  downloadAsset(asset.id, reportPath);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (report.appVersion !== tag.slice(1) || !Array.isArray(report.errors) || report.errors.length) fail(`${name} 验收失败`);
  ok(`${name} 无许可分发错误`);
}
const zipPath = macOnly ? path.join(cacheDir, zipAsset.name) : null;
const appPath = path.join(cacheDir, 'Hemi.app');
if (macOnly) {
if (!fresh && existsSync(zipPath) && statSync(zipPath).size === zipAsset.size) {
  ok(`zip 已缓存 ${zipPath}（--fresh 重下）`);
} else {
  step('下载 release zip');
  mkdirSync(cacheDir, { recursive: true });
  rmSync(zipPath, { force: true });
  downloadAsset(zipAsset.id, zipPath);
  if (statSync(zipPath).size !== zipAsset.size) fail(`zip 下载不完整 ${statSync(zipPath).size} ≠ ${zipAsset.size}`);
  ok(`${zipAsset.name} · ${zipAsset.size} B`);
  rmSync(appPath, { recursive: true, force: true });
}
step('sha512 实测（更新器同款校验链）');
const zipSha = await sha512Base64(zipPath);
const manifestSha = /^sha512:\s*(.+)$/m.exec(manifest)?.[1]?.trim();
if (zipSha !== manifestSha) fail(`zip sha512 实测 ≠ manifest（${zipSha.slice(0, 12)}… vs ${manifestSha?.slice(0, 12)}…）`);
ok('sha512 与 latest-mac.yml 一致');
}

if (!macOnly) {
  step('win 安装包 sha512 实测（更新器同款校验链）');
  const exeEntry = manifestFileEntries(winManifest).find((e) => e.url === winSetup.name);
  if (!exeEntry?.sha512) fail(`${WIN_MANIFEST} 里没有 ${winSetup.name} 的 sha512`);
  const exePath = path.join(cacheDir, winSetup.name);
  if (!fresh && existsSync(exePath) && statSync(exePath).size === winSetup.size) {
    ok(`安装包已缓存 ${exePath}（--fresh 重下）`);
  } else {
    downloadAsset(winSetup.id, exePath);
    if (statSync(exePath).size !== winSetup.size) fail(`安装包下载不完整 ${statSync(exePath).size} ≠ ${winSetup.size}`);
    ok(`${winSetup.name} · ${winSetup.size} B`);
  }
  const exeSha = await sha512Base64(exePath);
  if (exeSha !== exeEntry.sha512) {
    fail(`${winSetup.name} sha512 实测 ≠ ${WIN_MANIFEST}（${exeSha.slice(0, 12)}… vs ${exeEntry.sha512.slice(0, 12)}…）`);
  }
  ok(`sha512 与 ${WIN_MANIFEST} 一致`);
  ok('Windows 包体自检与实际冒烟已由本次成功的 Windows CI 完成');
  console.log(`\n✅ ${tag} Windows 验收全过。`);
  process.exit(0);
}

step('产物体检');
if (!existsSync(appPath)) {
  // win 用系统自带 bsdtar 解 zip（libarchive 原生认 zip）。必须写全 System32
  // 路径：PATH 里若排到 Git Bash 的 GNU tar——它不认 zip，还会把 C:\ 当
  // 远端主机名（host:file 语法）报「Cannot connect to C:」。
  if (IS_WIN) run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zipPath, '-C', cacheDir]);
  else run('ditto', ['-x', '-k', zipPath, cacheDir]);
}
const appPkgPath = path.join(appPath, 'Contents', 'Resources', 'app');
const appPkg = JSON.parse(readFileSync(path.join(appPkgPath, 'package.json'), 'utf8'));
if (appPkg.version !== tag.slice(1)) fail(`包内 version ${appPkg.version} ≠ ${tag.slice(1)}`);
ok(`包内 version ${appPkg.version}`);
run(process.execPath, ['scripts/verify-release-materials.mjs']);
run(process.execPath, ['scripts/verify-distribution-licenses.mjs', appPath, path.join(cacheDir, 'licenses-macos-verified.json')]);
ok('包内原生依赖许可与对应源码在场且字节一致');
// 023 雷：build.files 漏 src/shared = 主进程 ESM 加载即抛错，应用「打不开」。
if (!existsSync(path.join(appPkgPath, 'src', 'shared', 'ipc-channels.mjs'))) fail('包内缺 src/shared/ipc-channels.mjs（023 雷）');
ok('src/shared/ipc-channels.mjs 在场');
// 私有仓更新 token（repo 转公开后撤 secret 即匿名形态，缺场降级为提示）。
if (existsSync(path.join(appPath, 'Contents', 'Resources', 'update-token.txt'))) {
  fail('公开安装包不应包含 update-token.txt');
} else {
  ok('公开仓匿名更新形态，无内置 update token');
}
// ._* 垃圾计数用 node 遍历（原 bash find 在 win 上不可依赖）。
function countAppleDouble(dir) {
  let count = 0;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return count;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('._')) count += 1;
    if (entry.isDirectory()) count += countAppleDouble(path.join(dir, entry.name));
  }
  return count;
}
const garbage = countAppleDouble(appPath);
if (garbage !== 0) fail(`包内 ._* 垃圾 ${garbage} 条`);
ok('._* 垃圾 0 条');

if (!noSmoke) {
  step('打包冒烟（本地 Electron 跑打包 app，隔离 userData）');
  const electronBin = IS_WIN
    ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  if (!existsSync(electronBin)) fail(`缺 ${electronBin}（先 npm ci）`);
  const smokeUd = path.join(cacheDir, 'smoke-ud');
  rmSync(smokeUd, { recursive: true, force: true });
  mkdirSync(smokeUd, { recursive: true });
  // 生产配置位置按平台取（win＝%APPDATA%\hemi）；拷贝用 node（原 cp 是 unix 命令）。
  const prodData = IS_WIN
    ? path.join(os.homedir(), 'AppData', 'Roaming', 'hemi')
    : path.join(os.homedir(), 'Library', 'Application Support', 'hemi');
  const present = SMOKE_CONFIG_FILES.filter((name) => existsSync(path.join(prodData, name)));
  if (present.length === SMOKE_CONFIG_FILES.length) {
    for (const name of present) {
      copyFileSync(path.join(prodData, name), path.join(smokeUd, name));
    }
    ok(`配置 5 件套已拷（${smokeUd}）`);
  } else {
    warn(`生产配置只有 ${present.length}/5 件（${present.join(', ') || '无'}）——按「要么全拷要么都不拷」不拷，冒烟走无 Key 链路`);
  }
  const smoke = spawnSync(
    electronBin,
    [appPkgPath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HEMI_SMOKE_TEST: '1', HEMI_USER_DATA_DIR: smokeUd },
      timeout: 240_000,
    },
  );
  const smokeOut = `${smoke.stdout ?? ''}${smoke.stderr ?? ''}`;
  if (smoke.status !== 0) fail(`冒烟退出码 ${smoke.status}：\n${smokeOut.split('\n').slice(-8).join('\n')}`);
  if (!smokeOut.includes('HEMI_SMOKE_RESULT=')) fail('冒烟没打 HEMI_SMOKE_RESULT');
  ok(`exit 0 · HEMI_SMOKE_RESULT 在场 · 缓存留存 ${cacheDir}`);
}

console.log(`\n✅ ${tag} 验收全过${fix ? '（孤儿已清理）' : ''}。`);
