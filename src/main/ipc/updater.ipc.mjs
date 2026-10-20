/**
 * 044 · 应用内更新 IPC：状态/检查/下载/安装 + 状态广播。
 * 单例服务在 update-instance；广播发所有窗口（设置页可能开在主窗口，
 * 状态也要供后续其他入口用）。
 */
import { BrowserWindow, ipcMain } from 'electron';

import { IPC } from '../../shared/ipc-channels.mjs';
import { getUpdaterService } from '../services/update-instance.mjs';

export function registerUpdaterIpc() {
  const service = getUpdaterService();
  service.setBroadcast((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.updater.changed, state);
    }
  });
  ipcMain.handle(IPC.updater.getState, () => service.getState());
  ipcMain.handle(IPC.updater.check, () => service.check());
  ipcMain.handle(IPC.updater.download, () => service.download());
  ipcMain.handle(IPC.updater.install, () => service.install());
}

/** 启动静默检查（index.mjs 在建窗后调用；冒烟/自驱动不排）。 */
export function scheduleStartupUpdaterCheck() {
  getUpdaterService().scheduleStartupCheck();
}
