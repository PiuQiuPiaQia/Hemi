import { clipboard, ipcMain, systemPreferences } from 'electron';

import { openContentLink, openExternalIfAllowed } from '../lib/external-links.mjs';
import { readFullKeyboardAccess } from '../windows/native-shell.mjs';
import { IPC } from '../../shared/ipc-channels.mjs';

export function registerSystemIpc() {
  ipcMain.handle(IPC.system.openExternal, (_event, url) =>
    openExternalIfAllowed(url),
  );
  // 056：对话内容里的链接（任意 http/https，默认浏览器打开）。
  ipcMain.handle(IPC.system.openLink, (_event, url) => openContentLink(url));
  ipcMain.handle(IPC.system.copyText, (_event, text) => {
    clipboard.writeText(typeof text === 'string' ? text : String(text ?? ''));
    return { ok: true };
  });
  ipcMain.handle(IPC.system.keyboardNavigation, () => ({
    fullKeyboardAccess: readFullKeyboardAccess({
      platform: process.platform,
      systemPreferences,
    }),
  }));
}
