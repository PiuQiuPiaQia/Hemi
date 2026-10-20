// native-module-hygiene 单测：AppleDouble 垃圾清理只动 ._ 文件，真身与普通文件保留。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { purgeAppleDoubleJunk } from './native-module-hygiene.mjs';

function makeModuleTree(root) {
  const pkgDir = join(root, 'uiohook-napi');
  for (const dir of [
    join(pkgDir, 'build', 'Release'),
    join(pkgDir, 'build', 'Debug'),
    join(pkgDir, 'prebuilds', 'darwin-arm64'),
  ]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '._junk.node'), 'junk');
    writeFileSync(join(dir, 'real.node'), 'real');
  }
  // 与清理无关的普通文件：不该被碰。
  writeFileSync(join(pkgDir, 'build', 'Release', 'binding.make'), 'keep');
  writeFileSync(join(pkgDir, 'prebuilds', 'darwin-arm64', 'keep.txt'), 'keep');
  return pkgDir;
}

test('清理 build/Release、build/Debug 与 prebuilds 下的 ._ 垃圾，真身保留', () => {
  const root = mkdtempSync(join(tmpdir(), 'hemi-hygiene-'));
  try {
    const pkgDir = makeModuleTree(root);
    const fakeRequire = (id) => {
      assert.equal(id, 'uiohook-napi/package.json');
      return join(pkgDir, 'package.json');
    };

    const removed = purgeAppleDoubleJunk('uiohook-napi', { resolveFn: fakeRequire });

    assert.equal(removed.length, 3);
    assert.ok(existsSync(join(pkgDir, 'build', 'Release', 'real.node')));
    assert.ok(existsSync(join(pkgDir, 'build', 'Debug', 'real.node')));
    assert.ok(existsSync(join(pkgDir, 'prebuilds', 'darwin-arm64', 'real.node')));
    assert.ok(existsSync(join(pkgDir, 'build', 'Release', 'binding.make')));
    assert.ok(existsSync(join(pkgDir, 'prebuilds', 'darwin-arm64', 'keep.txt')));
    assert.equal(existsSync(join(pkgDir, 'build', 'Release', '._junk.node')), false);
    assert.equal(existsSync(join(pkgDir, 'prebuilds', 'darwin-arm64', '._junk.node')), false);

    // 第二次调用幂等：没有垃圾就返回空。
    assert.deepEqual(
      purgeAppleDoubleJunk('uiohook-napi', { resolveFn: fakeRequire }),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('模块不可解析时静默返回空数组，不抛错', () => {
  const fakeRequire = () => {
    throw new Error('Cannot find module');
  };
  assert.deepEqual(purgeAppleDoubleJunk('not-a-pkg', { resolveFn: fakeRequire }), []);
});
