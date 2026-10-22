import { app, ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels.mjs';
import { state } from '../state.mjs';
import { appearanceCaller } from '../windows/appearance-window.mjs';
import { getOAuthRuntime, getProfiles } from '../lib/profiles-holder.mjs';
import { createOAuthLogin } from '../services/oauth-login.mjs';

export function registerOAuthIpc() {
  const runtime = getOAuthRuntime();
  const service = createOAuthLogin({ runtime, credentials: runtime.credentials, profiles: getProfiles(), openExternal: url => shell.openExternal(url) });
  app.on('before-quit', () => service.dispose());
  const handle = (channel, run) => ipcMain.handle(channel, async (event, payload) => {
    if (event.sender !== state.mainWindow?.webContents || !appearanceCaller(event, true)) throw new Error('账号登录仅允许在 Hemi 主窗口操作');
    return run(payload ?? {});
  });
  handle(IPC.oauth.start, async ({ provider }) => {
    const directory = await getProfiles().list();
    if (directory.corrupt) throw new Error('模型目录损坏，修复后才能登录');
    if (directory.envOverride) throw new Error('环境变量正在覆盖模型配置，请先移除覆盖再登录。');
    return service.start(provider);
  });
  handle(IPC.oauth.getState, () => service.getState());
  handle(IPC.oauth.answer, payload => service.answer(payload));
  handle(IPC.oauth.cancel, ({ id }) => service.cancel(id));
  handle(IPC.oauth.logout, ({ provider }) => service.logout(provider));
  return service;
}
