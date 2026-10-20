import { ipcMain } from 'electron';

import { state } from '../state.mjs';
import { showMainWindow } from '../windows/main-window.mjs';
import {
  finishFloatingDrag,
  handleTaskHover,
  startFloatingDrag,
  updateFloatingDragPosition,
} from '../windows/floating-surface.mjs';
import { IPC } from '../../shared/ipc-channels.mjs';

function isFloatingSender(event) {
  return Boolean(
    state.floatingWindow &&
      !state.floatingWindow.isDestroyed() &&
      event.sender === state.floatingWindow.webContents,
  );
}

/**
 * 022：长按命令的发送主体抽出来给全局 Option 快捷键复用（悬浮球 IPC 与
 * 全局键盘钩子走同一条 floating:command 链路，主窗口渲染层只有一种语义）。
 */
export function sendFloatingHoldStart() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  finishFloatingDrag(false);
  state.mainWindow.webContents.send(IPC.floating.command, 'hold-start');
}

export function sendFloatingHoldEnd() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  state.mainWindow.webContents.send(IPC.floating.command, 'hold-end');
}

export function sendFloatingHoldCancel() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  state.mainWindow.webContents.send(IPC.floating.command, 'hold-cancel');
}

/** 悬停来源有两个：悬浮球与任务菜单本体（宽限期逻辑在 floating-surface）。 */
function isTaskHoverSender(event) {
  return (
    isFloatingSender(event) ||
    Boolean(
      state.taskPopoverWindow &&
        !state.taskPopoverWindow.isDestroyed() &&
        event.sender === state.taskPopoverWindow.webContents,
    )
  );
}

export function registerFloatingIpc() {
  ipcMain.on(IPC.floating.showMain, () => {
    showMainWindow();
  });

  ipcMain.on(IPC.floating.holdStart, (event) => {
    if (!isFloatingSender(event)) return;
    sendFloatingHoldStart();
  });

  ipcMain.on(IPC.floating.holdEnd, (event) => {
    if (!isFloatingSender(event)) return;
    sendFloatingHoldEnd();
  });

  // 悬浮球失焦/取消的按住不算「松手提交」：单独一条命令让渲染层区分。
  ipcMain.on(IPC.floating.holdCancel, (event) => {
    if (!isFloatingSender(event)) return;
    sendFloatingHoldCancel();
  });

  ipcMain.on(IPC.floating.dragStart, (event) => {
    if (
      !isFloatingSender(event) ||
      !state.floatingWindow ||
      state.floatingWindow.isDestroyed()
    ) {
      return;
    }
    startFloatingDrag();
  });

  ipcMain.on(IPC.floating.dragMove, (event, point) => {
    if (!isFloatingSender(event) || !state.floatingWindow) return;
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
    updateFloatingDragPosition(point);
  });

  ipcMain.on(IPC.floating.dragEnd, (event) => {
    if (
      !isFloatingSender(event) ||
      !state.floatingWindow ||
      state.floatingWindow.isDestroyed()
    ) {
      return;
    }
    finishFloatingDrag(true);
  });

  // 004：悬浮球 hover 出任务菜单，菜单本体 hover 续命、离开隐藏。
  ipcMain.on(IPC.floating.taskHover, (event, hovered) => {
    if (!isTaskHoverSender(event)) return;
    handleTaskHover(Boolean(hovered));
  });
}
