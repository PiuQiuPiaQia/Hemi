// Production preload/IPC and renderer, with fresh verification data only.
import { app } from 'electron';
import { initializeStableSafeStorageIdentity } from '../../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../../src/main/ipc/index.mjs';
import { createMainWindow } from '../../src/main/windows/main-window.mjs';
import { state } from '../../src/main/state.mjs';

if (!process.env.HEMI_USER_DATA_DIR) throw new Error('Isolated userData required');
app.setName('hemi-model-list-verification');
app.setPath('userData', process.env.HEMI_USER_DATA_DIR);
app.on('before-quit', () => { state.isQuitting = true; });
void app.whenReady().then(async () => {
  initializeStableSafeStorageIdentity();
  await registerAllIpcHandlers();
  await createMainWindow();
}).catch(error => { console.error(error); app.exit(1); });
