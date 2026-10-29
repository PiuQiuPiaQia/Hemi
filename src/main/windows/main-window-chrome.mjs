// Keep native controls on the same 52px row as the renderer's --hemi-topbar-h.
// 平台窗口 chrome 的集中配置（a3a72921 引入）；Windows titleBarOverlay 统一委托
// windows-chrome.mjs 的 buildWindowsTitleBarOverlay：透明底 + 皮肤正文色（--body）
// + 缺失兜底，与 main-window.mjs 换肤订阅共用同一语义（v0.2.24 已发布口径）。
import { buildWindowsTitleBarOverlay } from './windows-chrome.mjs';

export function titleBarOverlayFor(skin) {
  return buildWindowsTitleBarOverlay(skin);
}

export function mainWindowChromeFor(platform, skin) {
  if (platform === 'darwin') return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 22, y: 20 },
  };
  if (platform === 'win32') return {
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlayFor(skin),
    autoHideMenuBar: true,
  };
  return { titleBarStyle: 'default' };
}

export function updateMainWindowChrome(window, platform, skin) {
  if (platform === 'win32') window.setTitleBarOverlay(titleBarOverlayFor(skin));
}
