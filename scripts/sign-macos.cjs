const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { cleanAppleDouble } = require('./after-pack-clean.cjs');
const exec = promisify(execFile);

// Use electron-builder's own signer and preserve its entitlements/ignore rules.
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
const { signAsync } = builderRequire('@electron/osx-sign');
const machOMagic = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

function isCode(file) {
  if (path.basename(file).startsWith('._')) return false;
  if (fs.statSync(file).isDirectory()) return /\.(app|framework)$/.test(file);
  const fd = fs.openSync(file, 'r');
  try {
    const magic = Buffer.alloc(4);
    return fs.readSync(fd, magic, 0, 4, 0) === 4 && machOMagic.has(magic.readUInt32BE());
  } finally {
    fs.closeSync(fd);
  }
}

async function signCode(options) {
  const originalIgnore = options.ignore == null ? [] : Array.isArray(options.ignore) ? options.ignore : [options.ignore];
  // osx-sign treats every binary asset as signable. Detached signatures on PNG,
  // fonts, archives, etc. create AppleDouble files on exFAT. The enclosing bundle
  // seals these resources; only Mach-O code and nested bundles need signing.
  // Pass one predicate: osx-sign 1.3.3 drops an Array in validateOptsIgnore.
  const ignore = file => originalIgnore.some(rule => typeof rule === 'function' ? rule(file) : file.match(rule)) || !isCode(file);
  await signAsync({ ...options, ignore });
}

async function hasNativeAttributes(directory) {
  const probe = fs.mkdtempSync(path.join(directory, 'hemi-signing-fs-'));
  try {
    const file = path.join(probe, 'probe');
    fs.writeFileSync(file, 'probe');
    await exec('/usr/bin/xattr', ['-w', 'com.hemi.signing-probe', '1', file]);
    return !fs.existsSync(path.join(probe, '._probe'));
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(probe), `._${path.basename(probe)}`), { force: true });
  }
}

function apparentBytes(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const file = path.join(directory, entry.name);
    return total + (entry.isDirectory() ? apparentBytes(file) : fs.lstatSync(file).size);
  }, 0);
}

module.exports = async function signMac(options) {
  const app = path.resolve(options.app);
  if (await hasNativeAttributes(path.dirname(app))) return signCode(options);

  // Even signing Mach-O executables can create provenance xattrs on exFAT.
  // Sign on a native-attribute filesystem, then copy only sealed file contents.
  const temporary = path.resolve(process.env.HEMI_MAC_SIGNING_TEMP_DIR || os.tmpdir());
  if (!await hasNativeAttributes(temporary)) throw new Error('Signing temporary directory must support native extended attributes (APFS or HFS+). Set HEMI_MAC_SIGNING_TEMP_DIR.');
  const space = fs.statfsSync(temporary);
  if (space.bavail * space.bsize < apparentBytes(app) + 512 * 1024 * 1024) throw new Error('Not enough signing staging space. Set HEMI_MAC_SIGNING_TEMP_DIR to a native filesystem with free space.');
  const staging = fs.mkdtempSync(path.join(temporary, 'hemi-signing-app-'));
  const stagedApp = path.join(staging, path.basename(app));
  const originalPath = file => path.resolve(file) === stagedApp ? options.app : path.resolve(file).replace(`${stagedApp}${path.sep}`, `${app}${path.sep}`);
  try {
    await exec('/usr/bin/ditto', ['--norsrc', '--noextattr', app, stagedApp]);
    await cleanAppleDouble(stagedApp);
    const originalIgnore = options.ignore == null ? [] : Array.isArray(options.ignore) ? options.ignore : [options.ignore];
    await signCode({
      ...options, app: stagedApp,
      binaries: options.binaries?.map(file => path.resolve(file).replace(`${app}${path.sep}`, `${stagedApp}${path.sep}`)),
      ignore: file => originalIgnore.some(rule => typeof rule === 'function' ? rule(originalPath(file)) : originalPath(file).match(rule)),
      optionsForFile: options.optionsForFile ? file => options.optionsForFile(originalPath(file)) : undefined,
    });
    fs.rmSync(app, { recursive: true, force: true });
    await exec('/usr/bin/ditto', ['--norsrc', '--noextattr', stagedApp, app]);
    await cleanAppleDouble(app);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
};
