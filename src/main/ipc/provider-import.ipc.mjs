// 047：New API 导入 IPC——命令进协调器，状态事件推主窗口。
// 信任边界：sender 必须是主窗口 webContents 的受信任顶层 frame（OAuth 弹窗、
// 站点页面、其他窗口都没有导入权限）；payload 不含也不回任何秘密。
import { app, ipcMain, safeStorage, session, WebContentsView } from 'electron';

import { IPC } from '../../shared/ipc-channels.mjs';
import { createLogger } from '../lib/logger.mjs';
import { getProfiles } from '../lib/profiles-holder.mjs';
import { state as appState } from '../state.mjs';
import { createImportCoordinator } from '../services/provider-import/provider-import.mjs';

const log = createLogger('provider-import');

let coordinator = null;

export function getProviderImportService() {
  return coordinator;
}

export function registerProviderImportIpc() {
  if (coordinator) return coordinator;
  coordinator = createImportCoordinator({
    getMainWindow: () => appState.mainWindow,
    WebContentsView,
    sessionFromPartition: (partition) => session.fromPartition(partition),
    safeStorage,
    getProfilesStore: () => getProfiles(),
    journalDirPath: app.getPath('userData') + '/provider-import',
    log,
  });
  coordinator.setOwnerSender((dto) => {
    const window = appState.mainWindow;
    if (window && !window.isDestroyed()) window.webContents.send(IPC.providerImport.state, dto);
  });
  // 正常退出先落稳登录状态（包括无 expiry 的 session Cookie）；不修改业务事务状态。
  let loginMemoryFlushed = false;
  app.on('will-quit', (event) => {
    if (loginMemoryFlushed || !coordinator.hasLoginMemoryWork()) return;
    event.preventDefault();
    void coordinator.flushLoginMemory().catch(() => {
      log.warn('退出时登录状态未能保存');
    }).finally(() => {
      loginMemoryFlushed = true;
      // 等本次被 preventDefault 的退出栈退完，再重新发起退出。
      setImmediate(() => app.quit());
    });
  });

  const handle = (channel, method) => {
    ipcMain.handle(channel, async (event, payload) => {
      try {
        return await coordinator[method](event, payload ?? {});
      } catch (error) {
        // 本地错误码与中文原因；站点原始 message 不直接透传。
        const message = error?.message ?? '导入操作失败';
        log.info(`${channel} 拒绝：${String(message).slice(0, 160)}`);
        throw new Error(message);
      }
    });
  };

  handle(IPC.providerImport.start, 'start');
  handle(IPC.providerImport.getState, 'getState');
  handle(IPC.providerImport.listPending, 'listPending');
  handle(IPC.providerImport.resumePending, 'resumePending');
  handle(IPC.providerImport.checkLogin, 'checkLogin');
  handle(IPC.providerImport.setSelection, 'setSelection');
  handle(IPC.providerImport.submit, 'submit');
  handle(IPC.providerImport.retry, 'retry');
  handle(IPC.providerImport.pause, 'pause');
  handle(IPC.providerImport.resume, 'resume');
  handle(IPC.providerImport.cancel, 'cancel');
  handle(IPC.providerImport.setViewport, 'setViewport');
  return coordinator;
}
