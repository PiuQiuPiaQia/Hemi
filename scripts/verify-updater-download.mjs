// Real MacUpdater HTTP/checksum path, fresh application data, no native install.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { app, autoUpdater as nativeUpdater } from 'electron';
import { createUpdaterService } from '../src/main/services/updater.mjs';

if (process.platform !== 'darwin') throw new Error('This verification requires macOS');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-updater-download-'));
app.setPath('userData', path.join(root, 'userData'));
const cacheName = `hemi-updater-verify-${randomUUID()}`;
const cache = path.join(os.homedir(), 'Library/Caches', cacheName);
const bytes = Buffer.from('verified download fixture; never handed to Squirrel');
let corrupt = false, nativeChecks = 0, downloads = 0;
const originalNativeCheck = nativeUpdater.checkForUpdates;
nativeUpdater.checkForUpdates = () => { nativeChecks++; throw new Error('Squirrel must not receive ad-hoc downloads'); };
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/latest-mac.yml')) {
    const expected = corrupt ? Buffer.concat([bytes, Buffer.from('second version')]) : bytes;
    const sha512 = createHash('sha512').update(expected).digest('base64');
    res.end(`version: 99.0.${corrupt ? 2 : 1}\nfiles:\n  - url: Hemi-99.0.${corrupt ? 2 : 1}-arm64-mac.zip\n    sha512: ${sha512}\n    size: ${expected.length}\npath: Hemi-99.0.${corrupt ? 2 : 1}-arm64-mac.zip\nsha512: ${sha512}\nreleaseDate: '2026-10-25T00:00:00Z'\n`);
  } else if (req.url.includes('.zip')) { downloads++; res.end(corrupt ? Buffer.from('tampered bytes') : bytes); }
  else { res.writeHead(404); res.end(); }
});
let service;
void app.whenReady().then(async () => {
try {
  await fs.mkdir(path.join(root, 'userData'), { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = path.join(root, 'app-update.yml');
  await fs.writeFile(config, `updaterCacheDirName: ${cacheName}\n`);
  const require = createRequire(import.meta.url);
  const { MacUpdater } = require('electron-updater');
  const updater = new MacUpdater();
  updater.forceDevUpdateConfig = true;
  updater.updateConfigPath = config;
  const shim = { isPackaged: true, getVersion: () => app.getVersion() };
  service = createUpdaterService({ app: shim, platform: 'darwin',
    feedUrl: `http://127.0.0.1:${server.address().port}`,
    updaterFactory: async () => updater, execFn: () => 'TeamIdentifier=not set' });
  assert.equal((await service.check()).ok, true);
  assert.equal(service.getState().phase, 'available');
  assert.equal((await service.download()).ok, true);
  assert.equal(service.getState().phase, 'downloaded');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(service.getState().phase, 'downloaded', 'download remains usable instead of failing in Squirrel');
  assert.equal(nativeChecks, 0);
  assert.equal(downloads, 1);
  corrupt = true;
  assert.equal((await service.check()).ok, true);
  assert.equal((await service.download()).ok, false);
  assert.equal(service.getState().phase, 'error');
  assert.match(service.getState().errorMessage, /校验失败/);
  assert.equal(nativeChecks, 0);
  console.log('HEMI_UPDATER_DOWNLOAD_RESULT=' + JSON.stringify({ pass: true, realMacUpdater: true, verifiedDownload: true, corruptedDownloadRejected: true, nativeChecks, downloads }));
  await fs.rm(cache, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
  app.exit(0);
} catch (error) {
  console.error(error);
  await fs.rm(cache, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
  app.exit(1);
} finally {
  nativeUpdater.checkForUpdates = originalNativeCheck;
  server.closeAllConnections(); server.close();
}
});
