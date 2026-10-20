/**
 * 044 · 应用内更新服务：包一层 electron-updater，产出设置页「关于与更新」
 * 消费的线性状态机。分发走 update-bridge 的回环桥（私有仓事实见该文件头注）。
 *
 * 行为口径：
 * - 未打包实例（dev/冒烟/自驱动）一律 supported=false，检查/下载直接回执
 *   拒绝，不碰 electron-updater（它对 dev 实例本身就会抛错）。
 * - 打包实例 mac/win 都支持：差异只在安装路——mac 走 Squirrel（真证书）或
 *   自研换包（未签名，见 detectSigningMode 注释）；win 的 NSIS 静默更新不校验
 *   签名，一律 quitAndInstall 原生路。
 * - autoDownload=false：发现新版本只亮状态，下载由用户在设置页点按钮。
 * - autoInstallOnAppQuit=true：下载完成后正常退出也会自动装上，按钮只是
 *   「立刻重启安装」的捷径。
 * - 关闭差量更新（blockmap）：产物 ~414MB 全量下载，换掉回环桥上 Range
 *   分段转发的整类失败模式；家庭带宽下可接受。
 */
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { createUpdateBridge, defaultChannelFile } from './update-bridge.mjs';

// ESM 里同步 require 内置模块（child_process 的 execFileSync/spawn 都要同步语义）。
const nodeRequire = createRequire(import.meta.url);

const STARTUP_CHECK_DELAY_MS = 15_000;

/**
 * electron-updater 的下载缓存目录名（打在 app-update.yml 的 updaterCacheDirName，
 * 由 appId 派生）。下载完成后 zip + update-info.json 落 ~/Library/Caches/<此名>/pending/。
 */
const UPDATER_CACHE_DIR_NAME = 'hemi-desktop-updater';

/**
 * 默认 token 装载：CI 构建时 afterPack 把只读 PAT 写进 Resources/update-token.txt
 * （HEMI_UPDATE_TOKEN secret，仅 contents:read）。文件缺失＝匿名（repo 公开后
 * 的形态），读取失败也按匿名处理——更新检查不该被 token 问题打死。
 */
export function defaultLoadToken(resourcesPath) {
  return readFile(path.join(resourcesPath, 'update-token.txt'), 'utf8')
    .then((text) => text.trim() || null)
    .catch(() => null);
}

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
    const execFn = exec ?? ((...args) => nodeRequire('node:child_process').execFileSync(...args));
    const out = `${execFn('codesign', ['-dv', '--verbose=2', execPath], { encoding: 'utf8' })}`;
    const match = /TeamIdentifier=(.+)/.exec(out);
    const team = match?.[1]?.trim();
    if (team && team !== 'not set') return 'certified';
    return 'ad-hoc';
  } catch {
    return 'unsigned';
  }
}

/** 找下载缓存里最新的 zip（单更新流里只有一个；字节已经过 sha512 校验）。 */
export async function findCachedUpdateZip({ cacheDir, readdirImpl = readdir } = {}) {
  const pending = path.join(cacheDir, 'pending');
  let entries;
  try {
    entries = await readdirImpl(pending, { withFileTypes: true });
  } catch {
    return null;
  }
  const zips = entries.filter((e) => e.isFile() && e.name.endsWith('.zip'));
  if (zips.length === 0) return null;
  // pending 不带 mtime 元数据，取字典序最大即可（单更新流；并发下载本来不支持）。
  return path.join(pending, zips.map((e) => e.name).sort().at(-1));
}

/**
 * 自研换包安装脚本（未签名形态）：等旧进程退出→新版顶位→清理→重启。
 * 失败路径都有回滚：旧包先挪走，新包顶位失败则旧包放回。
 */
const SWAP_SCRIPT = `#!/bin/sh
APP="$1"; NEW_DIR="$2"; PID="$3"; LOG="$4"
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
  resourcesPath = process.resourcesPath,
  loadToken = null,
  fetchImpl = globalThis.fetch,
  createBridge = createUpdateBridge,
  updaterFactory = defaultUpdaterFactory,
  timeoutSet = (fn, ms) => setTimeout(fn, ms),
  execFn = null,
  spawnFn = null,
  homeDir = null,
  appBundlePath = null,
  platform = process.platform,
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
  let bridge = null;
  let setupPromise = null;

  const resolveToken = loadToken ?? (() => defaultLoadToken(resourcesPath));

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
    const message = error?.message ?? String(error);
    state.phase = 'error';
    state.errorMessage = message;
    log?.warn?.(`更新流程失败：${message}`);
    broadcastFn(getState());
  }

  async function ensureSetup() {
    if (!setupPromise) {
      setupPromise = (async () => {
        const token = await resolveToken();
        bridge = await createBridge({ token, fetchImpl, log, channelFile: defaultChannelFile(platform) });
        autoUpdater = await updaterFactory();
        autoUpdater.autoDownload = false;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.disableDifferentialDownload = true;
        // electron-updater 自带 logger 直写 console——统一走本服务的日志，
        // 别在生产控制台刷噪声。
        autoUpdater.logger = null;
        autoUpdater.setFeedURL({ provider: 'generic', url: bridge.url });
        autoUpdater.on('checking-for-update', () => setPhase('checking'));
        autoUpdater.on('update-available', (info) =>
          setPhase('available', { availableVersion: info?.version ?? null }));
        autoUpdater.on('update-not-available', () =>
          setPhase('not-available', { availableVersion: null, progressPercent: null }));
        autoUpdater.on('download-progress', (progress) =>
          setPhase('downloading', {
            progressPercent: Math.max(0, Math.round(progress?.percent ?? 0)),
          }));
        autoUpdater.on('update-downloaded', (info) =>
          setPhase('downloaded', {
            availableVersion: info?.version ?? state.availableVersion,
            progressPercent: 100,
          }));
        autoUpdater.on('error', (error) => fail(error));
        log?.info?.(`更新服务就绪（分发桥 ${bridge.url}）`);
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
    try {
      await ensureSetup();
      setPhase('checking');
      await autoUpdater.checkForUpdates();
      // 事件一般先于 promise 到达；仍停在 checking 说明事件没来，按无更新收敛。
      if (state.phase === 'checking') setPhase('not-available');
      return { ok: true };
    } catch (error) {
      fail(error);
      return { ok: false, code: 'check-failed', message: error?.message ?? String(error) };
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
    try {
      setPhase('downloading', { progressPercent: 0 });
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (error) {
      fail(error);
      return { ok: false, code: 'download-failed', message: error?.message ?? String(error) };
    }
  }

  /**
   * 自研换包安装（未签名/ad-hoc 形态，Squirrel 拒装时的产品路）：
   * 1. 缓存 zip（sha512 已由 electron-updater 下载层校验）ditto 解包到旧包同卷暂存区；
   * 2. 校验暂存包版本确实是待装版本（防换错包/坏包）；
   * 3. 写分离脚本：等本进程退出→旧包挪走→新包顶位（失败回滚）→重启；
   * 4. app.quit() 走正常退出清理（before-quit 收尾都执行）。
   */
  async function installViaSwap() {
    const cacheDir = path.join(home, 'Library', 'Caches', UPDATER_CACHE_DIR_NAME);
    const zipPath = await findCachedUpdateZip({ cacheDir });
    if (!zipPath) {
      return { ok: false, code: 'not-downloaded', message: '下载缓存里没有安装包' };
    }
    const staging = `${bundlePath}.update-${Date.now()}`;
    exec('rm', ['-rf', staging]);
    exec('ditto', ['-x', '-k', zipPath, staging]);
    const plist = path.join(staging, 'Hemi.app', 'Contents', 'Info.plist');
    const plistText = await readFile(plist, 'utf8').catch(() => '');
    const staged = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plistText)?.[1];
    if (!staged || staged !== state.availableVersion) {
      exec('rm', ['-rf', staging]);
      return { ok: false, code: 'staged-mismatch', message: `暂存包版本异常：${staged ?? '读不到'}（预期 ${state.availableVersion}）` };
    }
    const { writeFile: writeFileImpl } = await import('node:fs/promises');
    const scriptPath = path.join(home, '.hemi-update-swap.sh');
    await writeFileImpl(scriptPath, SWAP_SCRIPT, { mode: 0o755 });
    const swapLog = path.join(home, 'Library', 'Logs', 'hemi-update-swap.log');
    log?.info?.(`换包安装：${zipPath} → ${staging}（脚本 ${scriptPath}，日志 ${swapLog}）`);
    spawnDetached('/bin/sh', [scriptPath, bundlePath, staging, String(process.pid), swapLog], {
      detached: true,
      stdio: 'ignore',
    });
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
    // win 的 NSIS 静默更新不校验签名（electron-updater 只在配置了签名校验的
    // mac 路径做），exe 的完整性由下载层 sha512 把关——一律原生 quitAndInstall。
    if (platform === 'win32') {
      autoUpdater.quitAndInstall();
      return { ok: true };
    }
    // 真证书签名走 Squirrel 原生路；未签名/ad-hoc 自研换包（见 detectSigningMode 注释）。
    const signingMode = detectSigningMode({ execPath: process.execPath, exec: execFn });
    if (signingMode === 'certified') {
      // quitAndInstall 走正常退出流程（before-quit 清理会执行），装完后拉起。
      autoUpdater.quitAndInstall();
      return { ok: true };
    }
    try {
      return await installViaSwap();
    } catch (error) {
      fail(error);
      return { ok: false, code: 'install-failed', message: error?.message ?? String(error) };
    }
  }

  /** 启动后的静默检查：只亮状态不下载，失败只落日志。 */
  function scheduleStartupCheck({ delayMs = STARTUP_CHECK_DELAY_MS } = {}) {
    if (!supported) return;
    const timer = timeoutSet(() => {
      void check();
    }, delayMs);
    // 不拦着进程退出（Electron 主进程里定时器持有事件循环引用）。
    timer?.unref?.();
  }

  async function dispose() {
    if (bridge) await bridge.close().catch(() => {});
    bridge = null;
  }

  return {
    getState,
    check,
    download,
    install,
    scheduleStartupCheck,
    dispose,
    setBroadcast(fn) {
      broadcastFn = fn ?? (() => {});
    },
  };
}
