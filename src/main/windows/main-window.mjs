import path from 'node:path';
import { app, BrowserWindow, screen } from 'electron';

import { appIconPath, preloadPath } from '../paths.mjs';
import { openExternalIfAllowed } from '../lib/external-links.mjs';
import { createLogger } from '../lib/logger.mjs';
import { BRAND_NAME, isSmokeTest, state } from '../state.mjs';
import { loadRenderer } from './loader.mjs';
import { mainWindowSizeFor } from './main-window-size.mjs';
import { createWindowStateStore, restoreBounds, SAVE_DEBOUNCE_MS } from './window-state-store.mjs';
import { markCurrentCaptionRead } from '../services/caption-read-state.mjs';
import { IPC } from '../../shared/ipc-channels.mjs';
import {
  hideFloatingWindow,
  reconcileFloatingVisibility,
} from './floating-surface.mjs';

export const MAIN_WINDOW_COMPACT = { width: 560, height: 680 };
export const MAIN_WINDOW_EXPANDED = { width: 980, height: 680 };

function clampPositionToDisplay(x, y, width, height) {
  const proposedCenter = {
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2),
  };
  const { workArea } = screen.getDisplayNearestPoint(proposedCenter);

  return {
    x: Math.min(
      workArea.x + workArea.width - width,
      Math.max(workArea.x, Math.round(x)),
    ),
    y: Math.min(
      workArea.y + workArea.height - height,
      Math.max(workArea.y, Math.round(y)),
    ),
  };
}

export function setMainWindowExpanded(expanded) {
  const mainWindow = state.mainWindow;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 最大化（zoom）态下 setBounds 只改还原尺寸、屏幕上仍是满幅，先退出再切宽度档。
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  const current = mainWindow.getBounds();
  const target = expanded ? MAIN_WINDOW_EXPANDED : MAIN_WINDOW_COMPACT;
  const next = clampPositionToDisplay(
    current.x + (current.width - target.width) / 2,
    current.y + (current.height - target.height) / 2,
    target.width,
    target.height,
  );

  mainWindow.setBounds(
    { ...next, ...target },
    process.platform === 'darwin' && !isSmokeTest,
  );
}

export function showMainWindow() {
  const mainWindow = state.mainWindow;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  hideFloatingWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

export async function createMainWindow() {
  // 初始尺寸按主屏工作区等比例（2026-09-26 用户裁决：比固定 980×680 更高更宽），
  // 居中落位；窗口仍可自由拖拽调整（minWidth 与收起档对齐）。
  // 尺寸/位置保留（2026-10-19）：上次退出时的记录优先（夹回可见工作区），
  // 无记录或冒烟走等比例默认。
  const { workArea } = screen.getPrimaryDisplay();
  const initialSize = mainWindowSizeFor(workArea);
  const initialBounds = {
    x: Math.round(workArea.x + (workArea.width - initialSize.width) / 2),
    y: Math.round(workArea.y + (workArea.height - initialSize.height) / 2),
    ...initialSize,
  };
  let windowStateStore = null;
  let restoreMaximized = false;
  let bounds = initialBounds;
  if (!isSmokeTest) {
    windowStateStore = createWindowStateStore({
      filePath: path.join(app.getPath('userData'), 'window-state.json'),
      log: createLogger('window-state'),
    });
    const saved = windowStateStore.load();
    const restored = saved && restoreBounds(saved.bounds, {
      displays: screen.getAllDisplays().map((display) => display.workArea),
      min: { width: MAIN_WINDOW_COMPACT.width, height: 620 },
    });
    if (restored) {
      bounds = restored;
      restoreMaximized = saved.maximized === true;
    }
  }
  state.mainWindow = new BrowserWindow({
    ...bounds,
    // 024 全页面重构：对话优先布局自带响应式（≤880px 侧栏收抽屉），
    // 窗口放开拖拽调size；560×680 是收起档的下限，与 MAIN_WINDOW_COMPACT 对齐。
    minWidth: MAIN_WINDOW_COMPACT.width,
    minHeight: 620,
    show: false,
    resizable: true,
    // 最大化开关接管系统级「缩放/还原」通路（2026-10-10）：mac 双击顶栏拖拽区、
    // 红绿灯绿钮（fullscreenable:false 时绿钮语义＝zoom）、win 原生标题栏双击与
    // 最大化钮全走这里，关着就整体失灵。真全屏仍不放开（保持 fullscreenable:false）。
    maximizable: true,
    fullscreenable: false,
    title: BRAND_NAME,
    icon: appIconPath,
    backgroundColor: '#fafcfb',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // 红绿灯与 52px 顶栏（2026-10-03 用户裁决自 62 调低，渲染层
    // --hemi-topbar-h）的中线对齐：灯钮高 ~12px，y = 26 - 6 = 20；
    // x 与设计稿一致（左内边距 22），品牌区从 88px 起。
    trafficLightPosition: { x: 22, y: 20 },
    webPreferences: {
      preload: preloadPath,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const mainWindow = state.mainWindow;

  // 尺寸/位置保留：拖拽/缩放期间防抖落盘（getNormalBounds 在最大化时存还原
  // 尺寸）；真退出（close 不再被拦截）立即补存一次，覆盖防抖未到期的尾段调整。
  let saveTimer = null;
  const persistWindowState = () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (isSmokeTest || !windowStateStore || mainWindow.isDestroyed()) return;
    windowStateStore.save({
      bounds: mainWindow.getNormalBounds(),
      maximized: mainWindow.isMaximized(),
    });
  };
  if (windowStateStore) {
    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(persistWindowState, SAVE_DEBOUNCE_MS);
    };
    mainWindow.on('resize', scheduleSave);
    mainWindow.on('move', scheduleSave);
    mainWindow.on('maximize', scheduleSave);
    mainWindow.on('unmaximize', scheduleSave);
  }

  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
    const publishActivity = () => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.ui.devWindowActivity, {
        visible: mainWindow.isVisible() && !mainWindow.isMinimized(),
      });
    };
    for (const event of ['show', 'hide', 'minimize', 'restore']) mainWindow.on(event, publishActivity);
  }

  // Never spawn in-app popups for links; hand allowlisted ones to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalIfAllowed(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    if (!isSmokeTest) mainWindow?.show();
    if (restoreMaximized) mainWindow?.maximize();
  });
  mainWindow.on('show', hideFloatingWindow);
  mainWindow.on('focus', hideFloatingWindow);
  mainWindow.on('focus', markCurrentCaptionRead);
  mainWindow.on('blur', reconcileFloatingVisibility);
  mainWindow.on('hide', reconcileFloatingVisibility);
  mainWindow.on('restore', hideFloatingWindow);
  mainWindow.on('minimize', reconcileFloatingVisibility);
  mainWindow.on('close', (event) => {
    if (state.isQuitting) {
      persistWindowState();
      return;
    }
    event.preventDefault();
    mainWindow?.hide();
    reconcileFloatingVisibility();
  });
  mainWindow.on('closed', () => {
    if (saveTimer) clearTimeout(saveTimer);
    state.mainWindow = null;
  });

  await loadRenderer(mainWindow, 'main');
}
