import { ipcMain, Menu, shell } from 'electron';

import { IPC } from '../../shared/ipc-channels.mjs';
import { logFilePath, logRendererLine } from '../lib/logger.mjs';
import { state } from '../state.mjs';
import { showWindowMenu } from '../windows/app-menu.mjs';

export function registerAppIpc() {
  ipcMain.handle(IPC.app.showMenu, (event, request) => {
    const window = state.mainWindow;
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('FORBIDDEN');
    }
    return showWindowMenu({ Menu, window, request });
  });
  ipcMain.on(IPC.app.log, (_event, line) => {
    logRendererLine(line);
  });

  // 在 Finder 里定位 hemi.log，排查时可直接把文件拖给协作者。
  ipcMain.handle(IPC.app.revealLog, async () => {
    await shell.showItemInFolder(logFilePath());
    return true;
  });
}
