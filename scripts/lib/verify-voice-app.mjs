// Isolated harness: production renderer, IPC, ASR, controller and agent runtime.
// Only microphone permission / duplex device acquisition are replaced here.
import { app, ipcMain, Menu, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { initializeStableSafeStorageIdentity, saveStoredConfig } from '../../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../../src/main/ipc/index.mjs';
import { createMainWindow } from '../../src/main/windows/main-window.mjs';
import { installNativeShell } from '../../src/main/windows/native-shell.mjs';
import { disposeTaskManager } from '../../src/main/ipc/task.ipc.mjs';
import { stopActiveAsrSession } from '../../src/main/ipc/asr.ipc.mjs';
import { IPC } from '../../src/shared/ipc-channels.mjs';

app.setName('hemi');
app.setPath('userData', process.env.HEMI_USER_DATA_DIR);
app.whenReady().then(async () => {
  initializeStableSafeStorageIdentity();
  const file = path.join(app.getPath('userData'), 'text-model-profiles.json');
  const profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
  profiles.providers[0].encryptedApiKey = safeStorage.encryptString('TEST_ONLY').toString('base64');
  fs.writeFileSync(file, JSON.stringify(profiles));
  await saveStoredConfig({ apiKey: 'TEST_ONLY', ttsEnabled: false });
  await registerAllIpcHandlers();
  ipcMain.removeHandler(IPC.permissions.microphoneStatus);
  ipcMain.handle(IPC.permissions.microphoneStatus, () => 'granted');
  ipcMain.removeHandler(IPC.duplex.start);
  ipcMain.handle(IPC.duplex.start, () => ({ ok: false, reason: 'isolated-device-test' }));
  installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: true });
  await createMainWindow();
}).catch(error => { console.error(error); app.exit(1); });
app.on('before-quit', () => { void stopActiveAsrSession(); void disposeTaskManager(); });
