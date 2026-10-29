/**
 * 042 · 已安装应用发现（设置页「添加授权」清单与执行器 app_open 共用）。
 * 用户与系统应用目录顶层 .app；bundleId＋本地化显示名走 Spotlight 元数据
 * （系统应用的本地化名在 .loctable，plutil 读不到），未索引时退 Info.plist。
 * 不依赖 Electron，主进程/单测都可直接用。
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWindowsDesktopApps } from '../bot/windows-desktop-apps.mjs';

export const windowsDesktopApps = process.platform === 'win32' ? createWindowsDesktopApps() : null;

/** Windows 启动目标必须来自宿主安装目录，沿用同一 exe/AUMID 身份。 */
export async function openWindowsApplication(target, options = {}) {
  if (!windowsDesktopApps) throw new Error('Windows 应用启动不可用');
  const installed = await windowsDesktopApps.list(options);
  const verified = installed.find((app) => app.bundleId === target?.bundleId);
  if (!verified) throw new Error('应用身份已变化，请刷新应用清单');
  return windowsDesktopApps.open(verified, options);
}

/** plutil 转 JSON 读 plist / InfoPlist.strings（异步子进程，不阻塞主循环）。 */
function readPlistJson(file) {
  return new Promise((resolve) => {
    execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(String(stdout))); } catch { resolve(null); }
    });
  });
}

/**
 * 批量取 bundleId＋本地化显示名（Spotlight 元数据，一次调用约 0.1s；系统应用的
 * 本地化名在 .loctable 里，plutil 读不到）。返回 path → { bundleId, name }。
 */
function spotlightDescribe(paths) {
  return new Promise((resolve) => {
    if (!paths.length) return resolve(new Map());
    execFile('/usr/bin/mdls', ['-name', 'kMDItemCFBundleIdentifier', '-name', 'kMDItemDisplayName', '-raw', ...paths],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        const out = new Map();
        if (err && !stdout) return resolve(out);
        const values = String(stdout).split('\0');
        paths.forEach((p, i) => {
          const clean = (v) => (v && v !== '(null)' ? v.trim() : '');
          const bundleId = clean(values[i * 2]);
          const name = clean(values[i * 2 + 1]).replace(/\.app$/, '');
          if (bundleId || name) out.set(p, { bundleId, name });
        });
        resolve(out);
      });
  });
}

/** 单个 .app 兜底（Spotlight 关闭/未索引）：读 Info.plist。 */
async function describeAppFallback(appPath) {
  const info = await readPlistJson(path.join(appPath, 'Contents', 'Info.plist'));
  return {
    bundleId: typeof info?.CFBundleIdentifier === 'string' ? info.CFBundleIdentifier : '',
    name: String(info?.CFBundleDisplayName || info?.CFBundleName || '').trim(),
  };
}

/** 限并发 map（plutil 子进程不一次起上百个）。 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export const APP_ROOTS = [
  '/Applications', '/Applications/Utilities',
  '/System/Applications', '/System/Applications/Utilities',
  path.join(os.homedir(), 'Applications'),
];

/** 已安装应用扫描（用户与系统应用目录顶层 .app；结果缓存 5 分钟，弹窗重开秒出）。 */
let installedCache = { at: 0, apps: null };
export async function listInstalledApplications() {
  if (windowsDesktopApps) return (await windowsDesktopApps.list()).map((app) => ({ ...app, path: app.executable || app.launchPath || app.bundleId }));
  if (installedCache.apps && Date.now() - installedCache.at < 5 * 60_000) return installedCache.apps;
  const paths = [];
  for (const root of APP_ROOTS) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.endsWith('.app') && (e.isDirectory() || e.isSymbolicLink())) paths.push(path.join(root, e.name));
    }
  }
  const spotlight = await spotlightDescribe(paths);
  const described = await mapLimit(paths, 8, async (p) => {
    let meta = spotlight.get(p);
    if (!meta?.bundleId) meta = { ...(await describeAppFallback(p)), name: meta?.name || '' };
    return { bundleId: meta.bundleId, name: meta.name || path.basename(p).replace(/\.app$/, ''), path: p };
  });
  const apps = described.filter((a) => a.bundleId);
  installedCache = { at: Date.now(), apps };
  return apps;
}


/** 按显示名或 bundleId 精确找已安装应用（大小写不敏感；不做模糊匹配，避免启动错应用）。 */
export async function findInstalledApplication(query) {
  const q = String(query ?? '').trim().replace(/\.app$/i, '').toLowerCase();
  if (!q) return null;
  const apps = await listInstalledApplications();
  return apps.find((a) => a.bundleId.toLowerCase() === q)
    ?? apps.find((a) => a.name.toLowerCase() === q)
    ?? apps.find((a) => path.basename(a.path).replace(/\.app$/i, '').toLowerCase() === q)
    ?? null;
}
