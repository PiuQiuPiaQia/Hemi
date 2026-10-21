import assert from 'node:assert/strict';
import test from 'node:test';
import { findHeadlessExecutable } from './headless-browser-service.mjs';

test('无头程序发现支持 macOS 用户安装、Windows Edge、Linux 与已安装的 Playwright 浏览器', () => {
  for (const [platform, env, executable] of [
    ['darwin', {}, '/Users/test/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['win32', { PROGRAMFILES: 'C:\\Program Files' }, 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['linux', {}, '/usr/bin/chromium'],
    ['linux', {}, '/cache/chromium/chrome'],
  ]) {
    assert.equal(findHeadlessExecutable({ platform, env, home: '/Users/test', bundled: '/cache/chromium/chrome', exists: file => file === executable }), executable);
  }
});

test('显式程序配置缺失时不静默换程序；没有浏览器时给出安装指引', () => {
  assert.throws(() => findHeadlessExecutable({ env: { HEMI_BROWSER_EXECUTABLE: '/missing' }, exists: () => false }), /HEMI_BROWSER_EXECUTABLE/);
  assert.throws(() => findHeadlessExecutable({ env: {}, exists: () => false }), /安装 Chrome、Edge 或 Chromium/);
});
