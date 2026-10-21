import { app, BrowserWindow, screen } from 'electron';

import {
  FLOATING_CAPTION_MAX_WIDTH,
  FLOATING_CAPTION_SIZE,
  computeFloatingCaptionLayout,
} from '../lib/floating-caption-layout.mjs';
import {
  readStoredConfig,
  resolveConfig,
  saveStoredConfig,
} from '../lib/config-store.mjs';
import { createLogger } from '../lib/logger.mjs';
import { appIconPath, preloadPath } from '../paths.mjs';
import { isOnboardingInProgress } from '../ipc/onboarding.ipc.mjs';
import { isSmokeTest, state } from '../state.mjs';
import { IPC } from '../../shared/ipc-channels.mjs';
import { loadRenderer } from './loader.mjs';
import { waitForAppearance } from './appearance-window.mjs';

export const FLOATING_ORB_SIZE = 92;
const FLOATING_ORB_MARGIN = 24;
/** 悬浮窗总高：窗口只有球本体（下方通话药丸 2026-10-04 删除）。 */
const FLOATING_SURFACE_HEIGHT = FLOATING_ORB_SIZE;
/**
 * 悬浮球水平方向需要的边距（左或右）：字幕卡居中于球的条件是
 * `边距 ≥ 卡片宽/2 + 卡片内边距 − 球半径`，即 300/2 + 16 − 92/2 = 120。
 * 小于它，贴边的球会让卡片被迫左偏（用户报过「气泡和球没对齐」）。
 * 既用于默认落点；用户主动拖到边上时仍按最小让位处理
 * （见 floating-caption-layout.mjs）。
 */
const FLOATING_ORB_HORIZONTAL_MARGIN = 120;
const FLOATING_ORB_EDGE_MARGIN = 76;
const FLOATING_DRAG_THRESHOLD = 6;
const FLOATING_DRAG_POLL_MS = 16;
const FLOATING_VISIBILITY_POLL_MS = 350;

let floatingDragState = null;
let floatingShowInFlight = null;
let floatingVisibilityTimer = null;
const floatingLog = createLogger('floating');

// macOS 实测（2026-09-20 排查）：setVisibleOnAllWorkspaces(true,
// { visibleOnFullScreen: true }) 会把应用注册成辅助应用（lsappinfo type 翻成
// UIElement），Dock 图标随之消失——悬浮面懒创建后「图标又没了」的根因就是它。
// 窗口的跨空间/全屏可见是窗口级 collection 行为，与 Dock 常驻（应用激活策略）
// 互不冲突，所以设完行为立刻重申 Dock（幂等）。去掉 visibleOnFullScreen 就不
// 翻，但悬浮球/字幕必须能盖在全屏应用上，不能去掉。
function showOnAllWorkspacesKeepingDock(win) {
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.platform === 'darwin') app.dock?.show();
}

/** 004 悬浮任务菜单：球上方的小卡（任务状态 + 停止），悬停出现、离开淡出。 */
const TASK_POPOVER_SIZE = { width: 350, height: 200 };
let taskPopoverHideTimer = null;
let taskHoverOpenTimer = null;

function clearTaskPopoverTimers() {
  if (taskPopoverHideTimer) {
    clearTimeout(taskPopoverHideTimer);
    taskPopoverHideTimer = null;
  }
  if (taskHoverOpenTimer) {
    clearTimeout(taskHoverOpenTimer);
    taskHoverOpenTimer = null;
  }
}

function positionTaskPopover() {
  const popover = state.taskPopoverWindow;
  const orb = state.floatingWindow;
  if (!popover || popover.isDestroyed() || !orb || orb.isDestroyed()) return;
  const [orbX, orbY] = orb.getPosition();
  const orbCenter = { x: orbX + FLOATING_ORB_SIZE / 2, y: orbY + FLOATING_ORB_SIZE / 2 };
  const { workArea } = screen.getDisplayNearestPoint(orbCenter);
  const x = Math.min(
    Math.max(workArea.x, Math.round(orbCenter.x - TASK_POPOVER_SIZE.width / 2)),
    workArea.x + workArea.width - TASK_POPOVER_SIZE.width,
  );
  const aboveY = orbY - TASK_POPOVER_SIZE.height - 12;
  const y = aboveY >= workArea.y ? aboveY : orbY + FLOATING_ORB_SIZE + 12;
  popover.setPosition(x, y);
}

async function createTaskPopoverWindow() {
  if (state.taskPopoverWindow && !state.taskPopoverWindow.isDestroyed()) {
    return state.taskPopoverWindow;
  }
  state.taskPopoverWindow = new BrowserWindow({
    icon: appIconPath,
    ...TASK_POPOVER_SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: preloadPath,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const popover = state.taskPopoverWindow;
  popover.setAlwaysOnTop(true, 'floating');
  popover.setBackgroundColor('#00000000');
  popover.setHasShadow(false);
  showOnAllWorkspacesKeepingDock(popover);
  popover.on('closed', () => {
    state.taskPopoverWindow = null;
  });
  await loadRenderer(popover, 'task-popover');
  return popover;
}

/** 悬浮球/菜单各自的 mouseenter/leave 都走这里：宽限期内回到任一侧都不隐藏。 */
export function handleTaskHover(hovered) {
  clearTaskPopoverTimers();
  if (hovered) {
    // 开菜单有 200ms 延迟（防误触），期间离开就当没悬停过。
    taskHoverOpenTimer = setTimeout(() => {
      taskHoverOpenTimer = null;
      void (async () => {
        const popover = await createTaskPopoverWindow();
        positionTaskPopover();
        if (!popover.isVisible() && await waitForAppearance(popover) && !popover.isDestroyed()) popover.showInactive();
      })();
    }, 200);
    return;
  }
  taskPopoverHideTimer = setTimeout(() => {
    taskPopoverHideTimer = null;
    const popover = state.taskPopoverWindow;
    if (popover && !popover.isDestroyed() && popover.isVisible()) popover.hide();
  }, 400);
}

/** 球被拖走时菜单跟着消失（下次悬停重新定位出现）。 */
export function hideTaskPopover() {
  clearTaskPopoverTimers();
  const popover = state.taskPopoverWindow;
  if (popover && !popover.isDestroyed() && popover.isVisible()) popover.hide();
}

function clampFloatingOrbPosition(x, y) {
  const proposedCenter = {
    x: Math.round(x + FLOATING_ORB_SIZE / 2),
    y: Math.round(y + FLOATING_ORB_SIZE / 2),
  };
  const { workArea } = screen.getDisplayNearestPoint(proposedCenter);
  const horizontalMargin = Math.min(
    FLOATING_ORB_EDGE_MARGIN,
    Math.max(0, Math.floor((workArea.width - FLOATING_ORB_SIZE) / 2)),
  );

  return {
    x: Math.min(
      workArea.x + workArea.width - FLOATING_ORB_SIZE - horizontalMargin,
      Math.max(workArea.x + horizontalMargin, Math.round(x)),
    ),
    y: Math.min(
      workArea.y + workArea.height - FLOATING_SURFACE_HEIGHT,
      Math.max(workArea.y, Math.round(y)),
    ),
  };
}

function defaultFloatingPosition() {
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  return {
    x:
      workArea.x +
      workArea.width -
      FLOATING_ORB_SIZE -
      FLOATING_ORB_HORIZONTAL_MARGIN,
    y:
      workArea.y +
      workArea.height -
      FLOATING_SURFACE_HEIGHT -
      FLOATING_ORB_MARGIN,
  };
}

function positionFloatingCaption(orbX, orbY) {
  const captionWindow = state.floatingCaptionWindow;
  if (!captionWindow || captionWindow.isDestroyed()) return;

  const orbCenter = {
    x: Math.round(orbX + FLOATING_ORB_SIZE / 2),
    y: Math.round(orbY + FLOATING_ORB_SIZE / 2),
  };
  const { workArea } = screen.getDisplayNearestPoint(orbCenter);
  const { x, y, anchorX, maxWidth, placement } = computeFloatingCaptionLayout({
    orbX,
    orbY,
    orbSize: FLOATING_ORB_SIZE,
    workArea,
  });
  state.lastCaptionLayout = { anchorX, maxWidth, placement };

  captionWindow.setPosition(x, y);
  if (!captionWindow.webContents.isLoadingMainFrame()) {
    captionWindow.webContents.send(
      IPC.floating.captionLayout,
      state.lastCaptionLayout,
    );
  }
}

async function createFloatingCaptionWindow() {
  if (
    state.floatingCaptionWindow &&
    !state.floatingCaptionWindow.isDestroyed()
  ) {
    return state.floatingCaptionWindow;
  }

  state.floatingCaptionWindow = new BrowserWindow({
    icon: appIconPath,
    ...FLOATING_CAPTION_SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: preloadPath,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const captionWindow = state.floatingCaptionWindow;
  captionWindow.setAlwaysOnTop(true, 'floating');
  captionWindow.setBackgroundColor('#00000000');
  captionWindow.setHasShadow(false);
  captionWindow.setIgnoreMouseEvents(true);
  showOnAllWorkspacesKeepingDock(captionWindow);
  captionWindow.on('closed', () => {
    state.floatingCaptionWindow = null;
  });

  await loadRenderer(captionWindow, 'caption');
  if (state.floatingWindow && !state.floatingWindow.isDestroyed()) {
    const [orbX, orbY] = state.floatingWindow.getPosition();
    positionFloatingCaption(orbX, orbY);
  }
  return captionWindow;
}

async function createFloatingWindow() {
  if (state.floatingWindow && !state.floatingWindow.isDestroyed()) {
    return state.floatingWindow;
  }

  state.floatingWindow = new BrowserWindow({
    icon: appIconPath,
    width: FLOATING_ORB_SIZE,
    height: FLOATING_SURFACE_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: preloadPath,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const orbWindow = state.floatingWindow;
  orbWindow.setAlwaysOnTop(true, 'floating');
  orbWindow.setBackgroundColor('#00000000');
  orbWindow.setHasShadow(false);
  showOnAllWorkspacesKeepingDock(orbWindow);
  orbWindow.on('move', () => {
    if (!state.floatingWindow || state.floatingWindow.isDestroyed()) return;
    const [orbX, orbY] = state.floatingWindow.getPosition();
    positionFloatingCaption(orbX, orbY);
    hideTaskPopover();
  });
  orbWindow.on('blur', () => finishFloatingDrag(true));
  orbWindow.on('closed', () => {
    finishFloatingDrag(false);
    state.floatingWindow = null;
    if (
      state.floatingCaptionWindow &&
      !state.floatingCaptionWindow.isDestroyed()
    ) {
      state.floatingCaptionWindow.hide();
    }
  });

  const stored = await readStoredConfig();
  const position = stored.floatingOrbPosition ?? defaultFloatingPosition();
  const clamped = clampFloatingOrbPosition(position.x, position.y);
  orbWindow.setPosition(clamped.x, clamped.y);
  await loadRenderer(orbWindow, 'orb');
  positionFloatingCaption(clamped.x, clamped.y);
  return orbWindow;
}

export async function createFloatingSurface() {
  const orb = await createFloatingWindow();
  const caption = await createFloatingCaptionWindow();
  const [orbX, orbY] = orb.getPosition();
  positionFloatingCaption(orbX, orbY);
  return { orb, caption };
}

function isMainWindowForeground() {
  const mainWindow = state.mainWindow;
  return Boolean(
    mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.isVisible() &&
      !mainWindow.isMinimized() &&
      mainWindow.isFocused(),
  );
}

/**
 * 全屏调暗已改为渲染层 CSS 静止态默认半透明（2026-09-23，用户反馈探测
 * 漏拍导致球常亮），主进程不再轮询前台窗口全屏状态。
 */

/**
 * 通知球窗口自身的隐藏/重现（2026-09-24）。Chromium 在窗口 hide() 时
 * 不派发 mouseleave，:hover 会冻结在旧值——「点球弹主窗、点别处回来后
 * 球常亮」的根因。渲染层收到后重置 JS 驱动的悬停态（data-hovered）。
 */
function notifyOrbVisibility(visible) {
  const orb = state.floatingWindow;
  if (!orb || orb.isDestroyed()) return;
  if (orb.webContents.isLoadingMainFrame()) return;
  orb.webContents.send(IPC.floating.visibilityChanged, visible);
}

export function hideFloatingWindow() {
  finishFloatingDrag(false);
  const orb = state.floatingWindow;
  // reconcile 轮询会在主窗口前台期间反复调用本函数；只在真正发生
  // 可见→隐藏跳变时广播，避免每 350ms 刷一条重置消息。
  const wasVisible = Boolean(orb && !orb.isDestroyed() && orb.isVisible());
  // 任务小卡挂在球上方，球一藏它就成了无根的浮窗——且球隐藏时光标还停在
  // 原位，mouseleave 不会触发，400ms 宽限定时器永远排不上，卡会一直留在屏上。
  hideTaskPopover();
  if (wasVisible) notifyOrbVisibility(false);
  if (orb && !orb.isDestroyed()) {
    orb.hide();
  }
  if (
    state.floatingCaptionWindow &&
    !state.floatingCaptionWindow.isDestroyed()
  ) {
    state.floatingCaptionWindow.hide();
  }
}

export function updateFloatingDragPosition(pointer) {
  if (
    !floatingDragState ||
    !state.floatingWindow ||
    state.floatingWindow.isDestroyed()
  ) {
    return;
  }

  const deltaX = pointer.x - floatingDragState.pointerX;
  const deltaY = pointer.y - floatingDragState.pointerY;
  if (
    !floatingDragState.dragging &&
    Math.hypot(deltaX, deltaY) < FLOATING_DRAG_THRESHOLD
  ) {
    return;
  }

  if (!floatingDragState.dragging) {
    floatingDragState.dragging = true;
    state.floatingWindow.webContents.send(IPC.floating.dragDetected);
  }

  const next = clampFloatingOrbPosition(
    floatingDragState.windowX + deltaX,
    floatingDragState.windowY + deltaY,
  );
  const [currentX, currentY] = state.floatingWindow.getPosition();
  if (next.x === currentX && next.y === currentY) return;
  state.floatingWindow.setPosition(next.x, next.y);
  positionFloatingCaption(next.x, next.y);
}

export function startFloatingDrag() {
  finishFloatingDrag(false);
  if (!state.floatingWindow || state.floatingWindow.isDestroyed()) return;
  const pointer = screen.getCursorScreenPoint();
  const [windowX, windowY] = state.floatingWindow.getPosition();
  floatingDragState = {
    pointerX: pointer.x,
    pointerY: pointer.y,
    windowX,
    windowY,
    dragging: false,
    timer: setInterval(() => {
      updateFloatingDragPosition(screen.getCursorScreenPoint());
    }, FLOATING_DRAG_POLL_MS),
  };
}

export function finishFloatingDrag(savePosition) {
  const dragState = floatingDragState;
  floatingDragState = null;
  if (dragState?.timer) clearInterval(dragState.timer);
  if (
    !savePosition ||
    !dragState?.dragging ||
    !state.floatingWindow ||
    state.floatingWindow.isDestroyed()
  ) {
    return;
  }
  const [x, y] = state.floatingWindow.getPosition();
  void saveStoredConfig({ floatingOrbPosition: { x, y } });
}

/** 冒烟测试直接驱动主进程的拖动状态机，避免复制一套拖动逻辑。 */
export function setFloatingDragState(nextState) {
  floatingDragState = nextState;
}

export async function showFloatingOrbIfNeeded({ allowSmoke = false } = {}) {
  if (
    (!allowSmoke && isSmokeTest) ||
    state.isQuitting ||
    isMainWindowForeground()
  ) {
    return;
  }
  // 032：首启引导进行中不暴露语音悬浮入口——第 3 屏存了 ASR Key 也不提前
  // 启用；完成后由完成钩子/常规轮询恢复。
  if (isOnboardingInProgress()) return;
  if (floatingShowInFlight) return floatingShowInFlight;

  floatingShowInFlight = (async () => {
    const [stored, config] = await Promise.all([
      readStoredConfig(),
      resolveConfig(),
    ]);
    if (!stored.floatingOrbEnabled || !config.apiKey) return;

    const { orb, caption } = await createFloatingSurface();
    if (!await waitForAppearance(orb) || !await waitForAppearance(caption)) return;
    if (!isMainWindowForeground()) {
      positionFloatingCaption(...orb.getPosition());
      caption.showInactive();
      orb.showInactive();
      // 刚重现：清掉窗口隐藏期间冻结的悬停态。
      notifyOrbVisibility(true);
    }
  })();

  try {
    await floatingShowInFlight;
  } catch (error) {
    console.error('Unable to show floating voice surface:', error);
  } finally {
    floatingShowInFlight = null;
  }
}

export function reconcileFloatingVisibility() {
  if (isSmokeTest || state.isQuitting) return;
  if (isMainWindowForeground()) {
    hideFloatingWindow();
    return;
  }

  const orbVisible = Boolean(
    state.floatingWindow &&
      !state.floatingWindow.isDestroyed() &&
      state.floatingWindow.isVisible(),
  );
  const captionVisible = Boolean(
    state.floatingCaptionWindow &&
      !state.floatingCaptionWindow.isDestroyed() &&
      state.floatingCaptionWindow.isVisible(),
  );
  if (!orbVisible || !captionVisible) void showFloatingOrbIfNeeded();
}

export function startVisibilityPolling() {
  floatingVisibilityTimer = setInterval(
    reconcileFloatingVisibility,
    FLOATING_VISIBILITY_POLL_MS,
  );
  floatingVisibilityTimer.unref?.();
}

export function stopVisibilityPolling() {
  if (floatingVisibilityTimer) {
    clearInterval(floatingVisibilityTimer);
    floatingVisibilityTimer = null;
  }
}
