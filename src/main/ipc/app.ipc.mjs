import { ipcMain, shell } from 'electron';

import { IPC } from '../../shared/ipc-channels.mjs';
import { logFilePath, logRendererLine } from '../lib/logger.mjs';

export function registerAppIpc() {
  ipcMain.on(IPC.app.log, (_event, line) => {
    logRendererLine(line);
  });

  // 在 Finder 里定位 hemi.log，排查时可直接把文件拖给协作者。
  ipcMain.handle(IPC.app.revealLog, async () => {
    await shell.showItemInFolder(logFilePath());
    return true;
  });
}
