// 027 R-02：预览面板「点击路径在浏览器打开」的宿主侧通路。
//
// 现有 artifact:open 的 shell.openPath 只保证系统关联应用（.md 的默认处理器
// 往往不是浏览器）；macOS 上 file:// 的 LaunchServices 默认处理器也不是浏览器。
// 这里先解析默认浏览器 bundle id（LaunchServices 偏好 plist，https 优先、http
// 兜底），用 `open -b <bundle> <file://…>` 定向；解析或定向失败再退
// shell.openExternal / shell.openPath，并在 message 里如实说明走了哪条路。
// execFile 全异步（AGENTS.md：主进程禁 spawnSync 卡事件循环）；bundle 解析
// 进程内缓存（plist 只在用户改默认浏览器时变，会话级缓存可接受）。
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const LAUNCH_SERVICES_FILES = [
  'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist',
  'Library/Preferences/com.apple.LaunchServices/com.apple.LaunchServices.plist',
];

/** 从 LSHandlers 里挑默认浏览器（https 优先；返回 bundle id 或 null）。 */
export function parseBrowserBundle(handlers) {
  const list = Array.isArray(handlers) ? handlers : [];
  for (const scheme of ['https', 'http']) {
    const entry = list.find((item) => item?.LSHandlerURLScheme === scheme);
    const bundle = typeof entry?.LSHandlerRoleAll === 'string' ? entry.LSHandlerRoleAll.trim() : '';
    if (bundle) return bundle;
  }
  return null;
}

/**
 * 工厂（依赖全注入，离线可测）。
 * @param {object} deps
 * @param {Function} [deps.exec] 异步执行（默认 child_process.execFile）
 * @param {Function} deps.openExternal Electron shell.openExternal（file:// 兜底）
 * @param {Function} deps.openPath Electron shell.openPath（系统关联应用兜底）
 * @param {string} [deps.platform] process.platform
 * @param {object} [deps.log]
 */
export function createBrowserFileOpener({
  exec = run,
  openExternal,
  openPath,
  platform = process.platform,
  home = os.homedir(),
  log = null,
} = {}) {
  let cachedBundle;

  async function defaultBrowserBundle() {
    if (platform !== 'darwin') return null;
    if (cachedBundle !== undefined) return cachedBundle;
    for (const relative of LAUNCH_SERVICES_FILES) {
      try {
        const { stdout } = await exec('plutil', ['-convert', 'json', '-o', '-', path.join(home, relative)]);
        const bundle = parseBrowserBundle(JSON.parse(stdout)?.LSHandlers);
        if (bundle) {
          cachedBundle = bundle;
          return bundle;
        }
      } catch (error) {
        log?.debug?.(`[browser-open] ${path.basename(relative)} 解析失败：${error.message}`);
      }
    }
    log?.info?.('[browser-open] 没有解析到默认浏览器，走系统兜底');
    cachedBundle = null;
    return null;
  }

  return async function openInBrowser(filePath) {
    const url = pathToFileURL(filePath).href;
    const bundle = await defaultBrowserBundle();
    if (bundle) {
      try {
        await exec('open', ['-b', bundle, url]);
        return { ok: true };
      } catch (error) {
        log?.warn?.(`[browser-open] open -b ${bundle} 失败：${error.message}`);
      }
    }
    try {
      await openExternal(url);
      return { ok: true };
    } catch (error) {
      log?.debug?.(`[browser-open] openExternal(file://) 被拒：${error.message}`);
    }
    const openError = await openPath(filePath);
    if (openError) return { ok: false, message: `打开文件失败：${openError}` };
    return {
      ok: true,
      message: '浏览器打开未生效，已用系统关联应用打开',
    };
  };
}
