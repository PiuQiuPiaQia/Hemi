// 数据备份 IPC（docs/requirements/data-backup.md）：设置 / 连接测试 / 立即备份 /
// 备份集列表 / 恢复准备-应用-取消。进度经 backup:progress 单向事件推给渲染层。
import { app, BrowserWindow, dialog, ipcMain } from 'electron';

import { createBackupManager } from '../services/backup-manager.mjs';
import { secretStorage } from '../lib/secret-storage.mjs';
import { IPC } from '../../shared/ipc-channels.mjs';
import { createLogger } from '../lib/logger.mjs';

const log = createLogger('backup');

let manager = null;

export function getBackupManager() {
  return manager;
}

export function registerBackupIpc() {
  if (manager) return manager;
  manager = createBackupManager({
    userDataDir: app.getPath('userData'),
    secretStorage,
    appVersion: app.getVersion(),
    // v1：快照截断防御兜底（backup-service 按收集时刻 size 截断），活跃回合只影响
    // 最后一轮增量不入档；后续接 conversation-flow 活跃 run 判定后再收紧。
    isIdle: async () => true,
    log,
    emit: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
    },
  });
  ipcMain.handle(IPC.backup.getState, () => manager.getSettings());
  ipcMain.handle(IPC.backup.saveSettings, (_event, payload) => manager.saveSettings(payload ?? {}));
  ipcMain.handle(IPC.backup.testConnection, (_event, payload) => manager.testConnection(payload?.target));
  ipcMain.handle(IPC.backup.runNow, () => manager.runBackup({ trigger: 'manual' })); // 仅轻量档，忽略任何 tier 入参
  ipcMain.handle(IPC.backup.list, () => manager.listBackups());
  ipcMain.handle(IPC.backup.restorePrepare, (_event, payload) => manager.prepareRestore(String(payload?.setName ?? '')));
  ipcMain.handle(IPC.backup.restoreApply, () => manager.applyCurrentRestore());
  ipcMain.handle(IPC.backup.restoreCancel, () => manager.cancelRestore());
  ipcMain.handle(IPC.backup.deleteSet, (_event, payload) => manager.deleteBackupSet(String(payload?.setName ?? '')));
  ipcMain.handle(IPC.backup.pickDirectory, async () => {
    const win = BrowserWindow.getAllWindows().find(w => w.isVisible()) ?? BrowserWindow.getAllWindows()[0];
    const options = { title: '选择备份文件夹', properties: ['openDirectory', 'createDirectory'] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return { canceled: result.canceled, path: result.filePaths?.[0] ?? null };
  });
  manager.startSchedule();
  return manager;
}
