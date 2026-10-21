#!/usr/bin/env node
/** macOS dev 使用真正名为 Hemi.app 的应用包，确保 Dock 标签与品牌一致。 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import electronExecutable from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readPlist = (file) => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));

export function prepareDevRuntime({
  platform = process.platform,
  projectRoot = root,
  executable = electronExecutable,
  cacheRoot = path.join(homedir(), 'Library', 'Caches', 'Hemi', 'dev-runtime'),
} = {}) {
  if (platform !== 'darwin') return executable;

  const sourceBundle = path.resolve(path.dirname(executable), '..', '..');
  const sourceInfo = readPlist(path.join(sourceBundle, 'Contents', 'Info.plist'));
  const { productName } = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const workspace = createHash('sha256').update(projectRoot).digest('hex').slice(0, 12);
  const runtimeRoot = path.join(cacheRoot, workspace, sourceInfo.CFBundleVersion);
  const bundle = path.join(runtimeRoot, `${productName}.app`);
  const ready = path.join(runtimeRoot, '.runtime-ready');
  let changed = !existsSync(ready) || !existsSync(bundle);
  if (changed) {
    mkdirSync(runtimeRoot, { recursive: true });
    cpSync(sourceBundle, bundle, {
      recursive: true,
      verbatimSymlinks: true,
      // 工作区是 exFAT，缓存放本机 APFS；不复制 AppleDouble 垃圾。
      filter: (file) => !path.basename(file).startsWith('._'),
    });
  }

  // 保留 Electron 的二进制名：它决定 app.isPackaged 和开发态资源定位。
  // Dock 使用的应用包目录仍是 Hemi.app。
  const nativeExecutable = path.join(bundle, 'Contents', 'MacOS', sourceInfo.CFBundleExecutable);
  if (!existsSync(nativeExecutable)) {
    copyFileSync(executable, nativeExecutable);
    changed = true;
  }
  chmodSync(nativeExecutable, statSync(executable).mode);

  const infoPath = path.join(bundle, 'Contents', 'Info.plist');
  // dev 用独立图标（build/icon-dev.icns）：Dock 里必须和装好的打包版一眼可分，
  // 否则两个同名 Hemi 并存时分不清点哪个。图标文件名也带 -dev，避免与品牌资源同名。
  const expected = {
    ...sourceInfo,
    CFBundleDisplayName: productName,
    CFBundleName: productName,
    CFBundleExecutable: sourceInfo.CFBundleExecutable,
    CFBundleIconFile: `${productName}-dev.icns`,
  };
  if (!isDeepStrictEqual(readPlist(infoPath), expected)) {
    const temporary = `${infoPath}.tmp`;
    execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', temporary, '-'], { input: JSON.stringify(expected) });
    renameSync(temporary, infoPath);
    changed = true;
  }

  const icon = path.join(bundle, 'Contents', 'Resources', expected.CFBundleIconFile);
  const sourceIcon = path.join(projectRoot, 'build/icon-dev.icns');
  if (!existsSync(icon) || !readFileSync(icon).equals(readFileSync(sourceIcon))) {
    copyFileSync(sourceIcon, icon);
    changed = true;
  }
  if (changed) {
    const now = new Date();
    utimesSync(bundle, now, now);
    execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', bundle]);
    writeFileSync(ready, `${sourceInfo.CFBundleVersion}\n`);
    console.log(`[dev] ${productName}.app 开发运行时已就绪`);
  }
  return nativeExecutable;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(prepareDevRuntime());
}
