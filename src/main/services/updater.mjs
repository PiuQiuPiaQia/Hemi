/**
 * 044 · 应用内更新服务：包一层 electron-updater，产出设置页「关于与更新」
 * 消费的线性状态机。分发直接走公开 GitHub Release 下载地址。
 *
 * 行为口径：
 * - 未打包实例（dev/冒烟/自驱动）一律 supported=false，检查/下载直接回执
 *   拒绝，不碰 electron-updater（它对 dev 实例本身就会抛错）。
 * - 打包实例 mac/win 都支持：差异只在安装路——mac 走 Squirrel（真证书）或
 *   自研换包（未签名，见 detectSigningMode 注释）；win 的 NSIS 静默更新不校验
 *   签名，一律 quitAndInstall 原生路。
 * - autoDownload=false：发现新版本只亮状态，下载由用户在设置页点按钮。
 * - 真证书/Windows 可由原生更新器在退出时安装；ad-hoc/未签名实例下载后
 *   通过「重启安装」换包，避免 Squirrel 提前按旧包的指定要求拒绝新包。
 * - 关闭差量更新（blockmap）：直接全量下载，保留 sha512 完整性校验。
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createReadStream, readdirSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { UPDATE_FEED_URL } from '../../shared/release-info.mjs';
import { formatUpdateError } from './updater-error.mjs';

// ESM 里同步 require 内置模块（child_process 的 execFileSync/spawn 都要同步语义）。
const nodeRequire = createRequire(import.meta.url);

const STARTUP_CHECK_DELAY_MS = 15_000;

async function defaultUpdaterFactory() {
  const mod = await import('electron-updater');
  // electron-updater 是 CJS 且 autoUpdater 走 getter 导出——cjs-module-lexer
  // 认不出这种命名导出，打包 ESM 主进程里 `const { autoUpdater } = await
  // import(...)` 会拿 undefined（0.3.0 真机实测：setting 'autoDownload' of
  // undefined）。按 default 兜底取。
  const updater = mod.autoUpdater ?? mod.default?.autoUpdater ?? mod.default;
  if (!updater || typeof updater.checkForUpdates !== 'function') {
    throw new Error('electron-updater 导入形态异常（拿不到 autoUpdater）');
  }
  return updater;
}

/**
 * 安装路径判定：mac 上 electron-updater 的安装走 Squirrel.Mac（ShipIt），
 * 它用当前应用的指定要求（DR）校验新包——真证书签名的新旧包 DR 同源可过；
 * ad-hoc 的 DR 钉死 cdhash（新旧二进制必不同）、未签名更是无从校验，必然
 * 拒装（0.3.9 真机实测：did not pass validation）。所以：
 * - certified（TeamIdentifier 有效）→ quitAndInstall（Squirrel 原生路）；
 * - 其余 → swapInstaller 自研换包（sha512 已由下载层校验，退出后脚本换包）。
 */
export function detectSigningMode({ execPath, exec = null } = {}) {
  try {
    const args = ['-dv', '--verbose=2', execPath];
    let out;
    if (exec) out = String(exec('codesign', args, { encoding: 'utf8' }));
    else {
      // codesign writes its signing identity to stderr even on success.
      const result = nodeRequire('node:child_process').spawnSync('codesign', args, { encoding: 'utf8' });
      if (result.status !== 0) return 'unsigned';
      out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    }
    const match = /TeamIdentifier=(.+)/.exec(out);
    const team = match?.[1]?.trim();
    if (team && team !== 'not set') return 'certified';
    return 'ad-hoc';
  } catch {
    return 'unsigned';
  }
}

async function verifyDownloadedZip(info) {
  const file = info?.downloadedFile;
  if (typeof file !== 'string' || path.extname(file).toLowerCase() !== '.zip') throw new Error('下载回执缺少 ZIP 安装包');
  const entry = info.files?.find(item => {
    try { return path.basename(decodeURIComponent(new URL(item.url, UPDATE_FEED_URL + '/').pathname)) === path.basename(file); }
    catch { return false; }
  });
  const expected = entry?.sha512 ?? info.sha512;
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (!expected || hash.digest('base64') !== expected) {
    const error = new Error('sha512 checksum mismatch before installation');
    error.code = 'ERR_UPDATER_CHECKSUM_MISMATCH';
    throw error;
  }
  return file;
}

/** 换包暂存目录名（用户缓存区，与 electron-updater 自己的缓存目录分开，
 * 避免下载层校验失败清缓存时连带清掉正在使用的暂存包）。 */
const STAGING_DIR_NAME = 'hemi-updater-staging';
/** 换包脚本等旧进程退出最长 120s（240×0.5s）+ 解包搬运耗时；年龄超过
 * 10 分钟的暂存/.old 不可能还有脚本在用，可安全清扫。 */
const STALE_SWAP_ARTIFACT_AGE_MS = 10 * 60_000;

/**
 * 暂存目录选址：优先用户缓存区——与 /Applications 同在系统 Data 卷时，
 * 最后 mv 顶位仍是原子 rename，应用目录里不再出现可见的中转目录（也
 * 避开 /Applications 的写权限差异）。用户目录被重定向到外置/网络卷
 * （stat dev 不同）时退回旧包同目录，保证顶位动作必然同卷原子。
 */
export function pickStagingDir({ bundlePath, homeDir = null, statFn = statSync, now = Date.now() } = {}) {
  const caches = path.join(homeDir ?? '', 'Library', 'Caches');
  try {
    if (statFn(caches).dev === statFn(path.dirname(bundlePath)).dev) {
      return path.join(caches, STAGING_DIR_NAME, `staging-${now}`);
    }
  } catch { /* Caches 不可探：按异卷处理 */ }
  return `${bundlePath}.update-${now}`;
}

/**
 * 清扫换包安装的历史残留：解包/校验失败或应用侧异常退出的暂存目录、
 * 换包脚本被强杀（SIGKILL/断电）遗留的暂存目录与 Hemi.app.old、以及
 * 旧版本遗留在应用目录的 *.update-* 空壳。只清超过 STALE_SWAP_ARTIFACT_AGE_MS
 * 的条目——年轻条目可能仍有换包脚本在用；.old 仅在主包存在时才清，
 * 否则它是唯一的恢复副本。返回清理项数。
 */
export function sweepStaleSwapArtifacts({
  bundlePath,
  homeDir = null,
  now = Date.now(),
  staleAgeMs = STALE_SWAP_ARTIFACT_AGE_MS,
  readdirFn = readdirSync,
  statFn = statSync,
  removeFn = rmSync,
} = {}) {
  if (!bundlePath) return 0;
  let removed = 0;
  const removeIfStale = (dir, name) => {
    const target = path.join(dir, name);
    try {
      if (now - statFn(target).mtimeMs < staleAgeMs) return;
      removeFn(target, { recursive: true, force: true });
      removed += 1;
    } catch { /* 消失竞态：跳过自愈 */ }
  };
  const scan = (dir, keep) => {
    try {
      for (const name of readdirFn(dir)) if (keep(name)) removeIfStale(dir, name);
    } catch { /* 目录不存在/不可读：无事可清 */ }
  };
  scan(path.join(homeDir ?? '', 'Library', 'Caches', STAGING_DIR_NAME), (name) => name.startsWith('staging-'));
  const bundleDir = path.dirname(bundlePath);
  const bundleName = path.basename(bundlePath);
  scan(bundleDir, (name) => name.startsWith(`${bundleName}.update-`));
  try {
    statFn(bundlePath);
    removeIfStale(bundleDir, `${bundleName}.old`);
  } catch { /* 主包不在：.old 是唯一恢复副本，保留 */ }
  return removed;
}

/**
 * 自研换包安装脚本（未签名形态）：等旧进程退出→新版顶位→清理→重启。
 * 失败路径都有回滚：旧包先挪走，新包顶位失败则旧包放回。
 * trap 兜底：脚本任何退出路径（失败/超时/被 TERM/INT/HUP 结束）都删掉
 * 暂存目录——正常收尾的 rm 之外，被强杀在「顶位与清理之间」也不再遗留。
 */
const SWAP_SCRIPT = `#!/bin/sh
APP="$1"; NEW_DIR="$2"; PID="$3"; LOG="$4"
cleanup() { rm -rf "$NEW_DIR" 2>>"$LOG"; }
trap cleanup EXIT
trap 'exit 1' TERM INT HUP
echo "--- swap start $(date) ---" >> "$LOG"
waited=0
while kill -0 "$PID" 2>/dev/null; do
  sleep 0.5; waited=$((waited + 1))
  if [ "$waited" -gt 240 ]; then echo "timeout: old app still running" >> "$LOG"; exit 1; fi
done
sleep 1
if [ ! -d "$NEW_DIR/Hemi.app" ]; then echo "staged app missing" >> "$LOG"; exit 1; fi
OLD="$APP.old"
if ! mv "$APP" "$OLD" 2>>"$LOG"; then echo "cannot move old app (read-only volume?)" >> "$LOG"; exit 1; fi
if mv "$NEW_DIR/Hemi.app" "$APP" 2>>"$LOG"; then
  rm -rf "$OLD" "$NEW_DIR" 2>>"$LOG"
  echo "swapped ok" >> "$LOG"
else
  mv "$OLD" "$APP" 2>>"$LOG" || echo "ROLLBACK FAILED: old app at $OLD" >> "$LOG"
  echo "swap failed, restored" >> "$LOG"; exit 1
fi
open "$APP" >>"$LOG" 2>&1
echo "--- swap done $(date) ---" >> "$LOG"
`;

export function createUpdaterService({
  app,
  log = null,
  updaterFactory = defaultUpdaterFactory,
  timeoutSet = (fn, ms) => setTimeout(fn, ms),
  execFn = null,
  spawnFn = null,
  homeDir = null,
  appBundlePath = null,
  platform = process.platform,
  feedUrl = UPDATE_FEED_URL,
} = {}) {
  if (!app || typeof app.getVersion !== 'function') {
    throw new Error('createUpdaterService 需要有效的 app');
  }

  // 更新链路按平台分流：清单文件（latest-mac.yml / latest.yml）与安装路
  // （Squirrel/换包 vs NSIS 静默装）都区分 mac/win；其余平台没有分发形态，
  // 按不支持处理。
  const supportedPlatform = platform === 'darwin' || platform === 'win32';
  const supported = Boolean(app.isPackaged) && supportedPlatform;
  const unsupportedReason = !app.isPackaged
    ? 'dev'
    : (supportedPlatform ? null : 'unsupported-platform');
  const unsupportedMessage = unsupportedReason === 'dev'
    ? '开发实例不支持自动更新'
    : '当前平台不支持应用内更新，新版本去发布页下载';
  const state = {
    supported,
    unsupportedReason,
    phase: 'idle',
    currentVersion: app.getVersion(),
    availableVersion: null,
    progressPercent: null,
    errorMessage: null,
  };

  const exec = execFn ?? ((file, args, opts) =>
    nodeRequire('node:child_process').execFileSync(file, args, opts));
  const spawnDetached = spawnFn ?? ((file, args, opts) => {
    nodeRequire('node:child_process').spawn(file, args, opts)?.unref?.();
  });
  const home = homeDir ?? process.env.HOME ?? '';
  // mac 打包形态：execPath = Hemi.app/Contents/MacOS/Hemi → bundle 根上跳三级。
  const bundlePath = appBundlePath
    ?? path.resolve(process.execPath, '..', '..', '..');

  let broadcastFn = () => {};
  let autoUpdater = null;
  let setupPromise = null;
  let operation = '检查更新';
  let swapInstaller = false;
  let downloadedUpdate = null;

  function getState() {
    return { ...state };
  }

  function setPhase(phase, patch = {}) {
    // 同值不重播：check() 先写的 checking 会与库回调再报的 checking 重复，
    // 启动静默检查与用户手点叠加时广播会更吵。
    if (state.phase === phase && state.errorMessage === null) {
      const unchanged = Object.entries(patch).every(([key, value]) => state[key] === value);
      if (unchanged) return;
    }
    Object.assign(state, { phase, errorMessage: null }, patch);
    broadcastFn(getState());
  }

  function fail(error) {
    const message = formatUpdateError(error, operation);
    state.phase = 'error';
    state.errorMessage = message;
    log?.warn?.(`更新流程失败（${operation}）：${error?.stack ?? error?.message ?? String(error)}`);
    broadcastFn(getState());
    return message;
  }

  async function ensureSetup() {
    if (!setupPromise) {
      setupPromise = (async () => {
        autoUpdater = await updaterFactory();
        // MacUpdater starts Squirrel from updateDownloaded when this is true,
        // before install() can select our ad-hoc installer. Keep its verified
        // HTTP download, but never hand ad-hoc packages to native Squirrel.
        swapInstaller = platform === 'darwin' && detectSigningMode({ execPath: process.execPath, exec: execFn }) !== 'certified';
        autoUpdater.autoDownload = false;
        autoUpdater.autoInstallOnAppQuit = !swapInstaller;
        autoUpdater.disableDifferentialDownload = true;
        // electron-updater 自带 logger 直写 console——统一走本服务的日志，
        // 别在生产控制台刷噪声。
        autoUpdater.logger = null;
        autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
        autoUpdater.on('checking-for-update', () => setPhase('checking'));
        autoUpdater.on('update-available', (info) =>
          setPhase('available', { availableVersion: info?.version ?? null }));
        autoUpdater.on('update-not-available', () =>
          setPhase('not-available', { availableVersion: null, progressPercent: null }));
        autoUpdater.on('download-progress', (progress) =>
          setPhase('downloading', {
            progressPercent: Math.max(0, Math.round(progress?.percent ?? 0)),
          }));
        autoUpdater.on('update-downloaded', (info) => {
          downloadedUpdate = info;
          setPhase('downloaded', {
            availableVersion: info?.version ?? state.availableVersion,
            progressPercent: 100,
          });
        });
        autoUpdater.on('error', (error) => fail(error));
        log?.info?.(`更新服务就绪（公开下载 ${feedUrl}）`);
      })().catch((error) => {
        setupPromise = null;
        throw error;
      });
    }
    return setupPromise;
  }

  async function check() {
    if (!supported) {
      return { ok: false, code: 'unsupported', message: unsupportedMessage };
    }
    operation = '检查更新';
    try {
      await ensureSetup();
      setPhase('checking');
      await autoUpdater.checkForUpdates();
      // 事件一般先于 promise 到达；仍停在 checking 说明事件没来，按无更新收敛。
      if (state.phase === 'checking') setPhase('not-available');
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'check-failed', message: fail(error) };
    }
  }

  async function download() {
    if (!supported) {
      return { ok: false, code: 'unsupported', message: unsupportedMessage };
    }
    if (state.phase === 'downloaded') return { ok: true };
    if (state.phase !== 'available') {
      return { ok: false, code: 'no-update', message: '当前没有待下载的新版本' };
    }
    operation = '下载更新';
    try {
      setPhase('downloading', { progressPercent: 0 });
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'download-failed', message: fail(error) };
    }
  }

  /**
   * 自研换包安装（未签名/ad-hoc 形态，Squirrel 拒装时的产品路）：
   * 1. 缓存 zip（sha512 已由 electron-updater 下载层校验）ditto 解包到暂存区
   *    （用户缓存目录，与旧包同卷时；选址见 pickStagingDir），任何失败都清理；
   * 2. 校验暂存包版本确实是待装版本（防换错包/坏包）；
   * 3. 写分离脚本：等本进程退出→旧包挪走→新包顶位（失败回滚）→重启；
   * 4. app.quit() 走正常退出清理（before-quit 收尾都执行）。
   */
  async function installViaSwap() {
    if (downloadedUpdate?.version !== state.availableVersion) {
      return { ok: false, code: 'not-downloaded', message: '下载回执与待装版本不一致，请重新下载' };
    }
    const zipPath = await verifyDownloadedZip(downloadedUpdate);
    sweepStaleSwapArtifacts({ bundlePath, homeDir: home });
    const staging = pickStagingDir({ bundlePath, homeDir: home });
    exec('rm', ['-rf', staging]);
    try {
      exec('mkdir', ['-p', path.dirname(staging)]);
      exec('ditto', ['-x', '-k', zipPath, staging]);
      const plist = path.join(staging, 'Hemi.app', 'Contents', 'Info.plist');
      const plistText = await readFile(plist, 'utf8').catch(() => '');
      const staged = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plistText)?.[1];
      if (!staged || staged !== state.availableVersion) {
        exec('rm', ['-rf', staging]);
        return { ok: false, code: 'staged-mismatch', message: `暂存包版本异常：${staged ?? '读不到'}（预期 ${state.availableVersion}）` };
      }
      // Check the new bundle's resource seal without requiring the old ad-hoc
      // binary's cdhash identity to match the new version.
      exec('codesign', ['--verify', '--deep', '--strict', path.join(staging, 'Hemi.app')]);
      const { writeFile: writeFileImpl } = await import('node:fs/promises');
      const scriptPath = path.join(home, '.hemi-update-swap.sh');
      await writeFileImpl(scriptPath, SWAP_SCRIPT, { mode: 0o755 });
      const swapLog = path.join(home, 'Library', 'Logs', 'hemi-update-swap.log');
      log?.info?.(`换包安装：${zipPath} → ${staging}（脚本 ${scriptPath}，日志 ${swapLog}）`);
      // spawn 成功后暂存目录归换包脚本管（脚本 trap EXIT 兜底清理）。
      spawnDetached('/bin/sh', [scriptPath, bundlePath, staging, String(process.pid), swapLog], {
        detached: true,
        stdio: 'ignore',
      });
    } catch (error) {
      // 任何一步失败（ditto 解包/版本护栏/codesign/写脚本/拉起）都清掉暂存
      // 目录再抛——修复「安装失败后应用目录残留空壳暂存」的根因。
      exec('rm', ['-rf', staging]);
      throw error;
    }
    app.quit();
    return { ok: true };
  }

  async function install() {
    if (!supported) {
      return { ok: false, code: 'unsupported', message: unsupportedMessage };
    }
    if (state.phase !== 'downloaded') {
      return { ok: false, code: 'not-downloaded', message: '新版本还没下载完成' };
    }
    operation = '安装更新';
    // win 的 NSIS 静默更新不校验签名（electron-updater 只在配置了签名校验的
    // mac 路径做），exe 的完整性由下载层 sha512 把关——一律原生 quitAndInstall。
    if (platform === 'win32') {
      autoUpdater.quitAndInstall();
      return { ok: true };
    }
    // 真证书签名走 Squirrel 原生路；未签名/ad-hoc 自研换包（见 detectSigningMode 注释）。
    if (!swapInstaller) {
      // quitAndInstall 走正常退出流程（before-quit 清理会执行），装完后拉起。
      autoUpdater.quitAndInstall();
      return { ok: true };
    }
    try {
      return await installViaSwap();
    } catch (error) {
      return { ok: false, code: 'install-failed', message: fail(error) };
    }
  }

  /** 启动后的静默检查：只亮状态不下载，失败只落日志。 */
  function scheduleStartupCheck({ delayMs = STARTUP_CHECK_DELAY_MS } = {}) {
    if (!supported) return;
    if (platform === 'darwin') {
      // 顺带清扫上次换包安装的遗留（脚本被强杀/断电的兜底，见 sweepStaleSwapArtifacts）。
      const removed = sweepStaleSwapArtifacts({ bundlePath, homeDir: home });
      if (removed > 0) log?.info?.(`已清扫换包更新残留 ${removed} 项`);
    }
    const timer = timeoutSet(() => {
      void check();
    }, delayMs);
    // 不拦着进程退出（Electron 主进程里定时器持有事件循环引用）。
    timer?.unref?.();
  }

  return {
    getState,
    check,
    download,
    install,
    scheduleStartupCheck,
    setBroadcast(fn) {
      broadcastFn = fn ?? (() => {});
    },
  };
}
