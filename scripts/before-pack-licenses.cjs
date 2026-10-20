// Electron 44 downloads its runtime lazily. electron-builder may use its own
// download without populating node_modules/electron/dist. Prepare the matching
// notices before extraResources runs; missing sources must stop packaging.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Arch } = require('builder-util');

module.exports = async function beforePack(context) {
  const electronRoot = path.dirname(require.resolve('electron/package.json'));
  const version = require(path.join(electronRoot, 'package.json')).version;
  const targetVersion = context.packager.config.electronVersion ?? version;
  if (targetVersion !== version) throw new Error('Electron runtime and license versions must match');
  const env = { ...process.env, ELECTRON_INSTALL_PLATFORM: context.electronPlatformName, ELECTRON_INSTALL_ARCH: Arch[context.arch] };
  delete env.ELECTRON_OVERRIDE_DIST_PATH;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(electronRoot, 'install.js')], { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Electron runtime preparation failed: ${signal ?? code}`)));
  });
  const installed = (await fs.readFile(path.join(electronRoot, 'dist/version'), 'utf8')).trim().replace(/^v/, '');
  if (installed !== version) throw new Error('Electron license input version differs from the package');
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    const bytes = await fs.readFile(path.join(electronRoot, 'dist', name));
    if (!bytes.length) throw new Error(`Empty Electron notice: ${name}`);
  }
};
