// Isolated UI harness: production IPC/services/window; no desktop hook / floating surfaces.
import { app, Menu, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { initializeStableSafeStorageIdentity } from '../../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../../src/main/ipc/index.mjs';
import { createMainWindow } from '../../src/main/windows/main-window.mjs';
import { installNativeShell } from '../../src/main/windows/native-shell.mjs';
import { disposeTaskManager } from '../../src/main/ipc/task.ipc.mjs';

app.setName('hemi');
app.setPath('userData', process.env.HEMI_USER_DATA_DIR);
app.whenReady().then(async () => {
  initializeStableSafeStorageIdentity();
  const file = path.join(app.getPath('userData'), 'text-model-profiles.json');
  const profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
  profiles.providers[0].encryptedApiKey = safeStorage.encryptString('TEST_ONLY').toString('base64');
  fs.writeFileSync(file, JSON.stringify(profiles));
  await registerAllIpcHandlers();
  installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: true });
  await createMainWindow();
}).catch(error => { console.error(error); app.exit(1); });
app.on('before-quit', () => { void disposeTaskManager(); });
