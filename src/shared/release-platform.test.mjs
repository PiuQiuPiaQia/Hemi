import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { releasePlatform, relayUpdateManifest } from '../../scripts/lib/release-platform.mjs';
const require = createRequire(import.meta.url);
const { parseUpdateInfo, resolveFiles } = require('electron-updater/out/providers/Provider.js');

test('release defaults to both platforms; single-platform flags override', () => {
  assert.equal(releasePlatform([], 'darwin'), 'both');
  assert.equal(releasePlatform([], 'win32'), 'both');
  assert.equal(releasePlatform([], 'linux'), 'both');
  assert.equal(releasePlatform(['--both'], 'win32'), 'both');
  assert.equal(releasePlatform(['--mac-only'], 'win32'), 'mac');
  assert.equal(releasePlatform(['--win-only'], 'darwin'), 'win');
  assert.throws(() => releasePlatform(['--mac-only', '--win-only'], 'darwin'));
  assert.throws(() => releasePlatform(['--both', '--mac-only'], 'darwin'));
});

test('companion update manifest preserves its version and checksum while pointing to its own installer', () => {
  const manifest = 'version: 0.2.17\nfiles:\n  - url: Hemi-0.2.17-setup.exe\n    sha512: original-checksum\n    size: 123\npath: Hemi-0.2.17-setup.exe\nsha512: original-checksum\n';
  const url = 'https://github.com/PiuQiuPiaQia/Hemi/releases/download/v0.2.17/Hemi-0.2.17-setup.exe';
  const relayed = relayUpdateManifest(manifest, [{ name: 'Hemi-0.2.17-setup.exe', browser_download_url: url }]);
  assert.equal(relayed, manifest.replaceAll('Hemi-0.2.17-setup.exe', url));
  assert.equal(relayUpdateManifest(relayed, []), relayed);
  const info = parseUpdateInfo(relayed, 'latest.yml', new URL('https://github.com/PiuQiuPiaQia/Hemi/releases/latest/download/latest.yml'));
  assert.equal(info.version, '0.2.17');
  const [file] = resolveFiles(info, new URL('https://github.com/PiuQiuPiaQia/Hemi/releases/latest/download/'));
  assert.equal(file.url.href, url);
  assert.equal(file.info.sha512, 'original-checksum');
});

test('manifest relay resolves quoted and encoded filenames and refuses missing installers', () => {
  const manifest = 'version: 0.2.17\nfiles:\n  - url: "Hemi-0.2.17-arm64-mac.zip"\npath: Hemi%20Mac.zip\n';
  const assets = ['Hemi-0.2.17-arm64-mac.zip', 'Hemi Mac.zip'].map(name => ({ name, browser_download_url: 'https://example.invalid/' + encodeURIComponent(name) }));
  const relayed = relayUpdateManifest(manifest, assets);
  assert.match(relayed, /url: https:\/\/example.invalid\/Hemi-0.2.17-arm64-mac.zip/);
  assert.match(relayed, /path: https:\/\/example.invalid\/Hemi%20Mac.zip/);
  assert.throws(() => relayUpdateManifest(manifest, []), /更新清单缺少对应资产/);
});
