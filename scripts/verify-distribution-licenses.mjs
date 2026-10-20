#!/usr/bin/env node
// Check a real unpacked distribution. This is a notice-presence check and native
// file inventory, not a completed audit of the libraries linked into each binary.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/verify-distribution-licenses.mjs <unpacked-app> <report.json>');
const appPath = fs.realpathSync(input);
const reportPath = path.resolve(output);
if (reportPath === appPath || reportPath.startsWith(`${appPath}${path.sep}`)) throw new Error('Write the report outside the application');
const resources = path.join(appPath, fs.existsSync(path.join(appPath, 'Contents')) ? 'Contents/Resources' : 'resources');
const code = path.join(resources, 'app'); // Hemi packages with asar: false.
const slash = value => value.replaceAll('\\', '/');
const relative = file => slash(path.relative(appPath, file));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const errors = [];
const notices = [];
function compare(source, target) {
  const from = path.join(root, source), to = path.join(resources, target);
  if (!fs.existsSync(from) || !fs.existsSync(to)) { errors.push(`Missing notice: ${target}`); return; }
  const expected = fs.readFileSync(from), actual = fs.readFileSync(to);
  if (!expected.equals(actual)) errors.push(`Notice differs from build input: ${target}`);
  notices.push({ path: relative(to), bytes: actual.length, sha256: sha256(actual) });
}
compare('node_modules/electron/dist/LICENSE', 'licenses/Electron-LICENSE.txt');
compare('node_modules/electron/dist/LICENSES.chromium.html', 'licenses/LICENSES.chromium.html');
compare('LICENSE', 'app/LICENSE');
compare('THIRD-PARTY-NOTICES.md', 'app/THIRD-PARTY-NOTICES.md');
compare('src/main/workflows/vendor/flowgram-engine/LICENSE', 'app/src/main/workflows/vendor/flowgram-engine/LICENSE');
compare('third-party/sources.json', 'app/third-party/sources.json');
compare('node_modules/@earendil-works/pi-mcp/LICENSES/modelcontextprotocol-typescript-sdk.txt', 'app/node_modules/@earendil-works/pi-mcp/LICENSES/modelcontextprotocol-typescript-sdk.txt');
for (const name of fs.readdirSync(path.join(root, 'third-party/licenses')).sort()) {
  if (name.startsWith('._')) continue;
  if (fs.statSync(path.join(root, 'third-party/licenses', name)).isFile()) compare(`third-party/licenses/${name}`, `app/third-party/licenses/${name}`);
}
for (const name of ['renderer-components.json', 'renderer-third-party.txt', 'conversation-virtualization.txt']) {
  compare(`src/renderer/public/licenses/${name}`, `app/dist-renderer/licenses/${name}`);
}
const rendererFile = path.join(code, 'dist-renderer/licenses/renderer-components.json');
let renderer;
if (fs.existsSync(rendererFile)) {
  renderer = JSON.parse(fs.readFileSync(rendererFile, 'utf8'));
  if (renderer.lockfileSha256 !== sha256(fs.readFileSync(path.join(root, 'package-lock.json')))) errors.push('Renderer notice manifest has a stale lockfile hash');
  for (const item of renderer.components) if (item.reviewRequired) errors.push(`Unresolved renderer notice: ${item.name}@${item.version}`);
}
const nativeFiles = [], owners = new Map();
function ownerOf(file) {
  for (let dir = path.dirname(file); dir.startsWith(`${code}${path.sep}`); dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!pkg.name || !pkg.version) continue;
    const key = relative(dir);
    if (!owners.has(key)) {
      const files = fs.readdirSync(dir).filter(name => /^(licen[cs]e|notice|copying)([.-]|$)/i.test(name) && fs.statSync(path.join(dir, name)).isFile());
      owners.set(key, { path: key, name: pkg.name, version: pkg.version, license: pkg.license ?? null, notices: files.sort().map(name => ({ path: relative(path.join(dir, name)), sha256: sha256(fs.readFileSync(path.join(dir, name))) })) });
    }
    return key;
  }
  return null;
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    if (!entry.isFile() || entry.name.startsWith('._')) continue;
    // Suffixes cover shipped addons, shared libraries and WASM. Also inspect
    // extensionless files for PE, ELF and Mach-O executable/fat binary magic.
    let native = /\.(node|dylib|so(?:\.\d+)*|dll|wasm|exe)$/i.test(entry.name);
    if (!native && !path.extname(entry.name)) {
      const fd = fs.openSync(file, 'r'), header = Buffer.alloc(4);
      try { fs.readSync(fd, header, 0, 4, 0); } finally { fs.closeSync(fd); }
      native = ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex')) || header.subarray(0, 2).toString() === 'MZ';
    }
    if (native) {
      const owner = ownerOf(file), bytes = fs.readFileSync(file);
      if (!owner) errors.push(`Native file without package identity: ${relative(file)}`);
      nativeFiles.push({ path: relative(file), owner, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
}
walk(path.join(code, 'node_modules'));
if (!nativeFiles.length) errors.push('No native files found; check the supplied distribution path');
const report = {
  scope: 'Actual distribution notices and npm-owned native files. Electron frameworks use Electron/Chromium notices; embedded Rust/C/C++ dependencies still require a separate audit.',
  appVersion: JSON.parse(fs.readFileSync(path.join(code, 'package.json'), 'utf8')).version,
  electronVersion: fs.readFileSync(path.join(root, 'node_modules/electron/dist/version'), 'utf8').trim(),
  lockfileSha256: sha256(fs.readFileSync(path.join(root, 'package-lock.json'))),
  notices, rendererComponents: renderer?.components.length ?? 0,
  nativeOwners: [...owners.values()].sort((a, b) => a.path.localeCompare(b.path)),
  nativeFiles: nativeFiles.sort((a, b) => a.path.localeCompare(b.path)),
  remainingReview: ['libuiohook corresponding source and relinking materials (deferred)', 'Embedded native dependency inventories and their license obligations'],
  errors,
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ notices: notices.length, rendererComponents: report.rendererComponents, nativeFiles: nativeFiles.length, nativeOwners: owners.size, errors }));
if (errors.length) process.exitCode = 1;
