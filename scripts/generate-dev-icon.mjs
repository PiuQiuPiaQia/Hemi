#!/usr/bin/env node
/**
 * 从 build/icon-dev.svg 导出 dev 专用图标（PNG 与 ICNS）。
 * dev 的 Dock 图标必须和打包版一眼可分：主母版仍由 generate-app-icons.mjs 负责，
 * 这里只产出 dev 变体，不动任何品牌资源。
 * 在 macOS 运行 node scripts/generate-dev-icon.mjs；使用已有 Electron 与 sips/iconutil。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronExecutable from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') {
  throw new Error('请在 macOS 使用 sips/iconutil 导出图标；仓库直接消费已提交的资源');
}
const sourceSvg = path.join(root, 'build/icon-dev.svg');
const sourcePng = path.join(root, 'build/icon-dev.png');
execFileSync(electronExecutable, [path.join(root, 'scripts/render-app-icon.mjs'), sourceSvg, sourcePng], {
  stdio: 'inherit',
});
const master = readFileSync(sourcePng);
if (master.readUInt32BE(16) !== 1024 || master.readUInt32BE(20) !== 1024) {
  throw new Error('build/icon-dev.png 母版必须是 1024×1024');
}

const temporary = mkdtempSync(path.join(tmpdir(), 'hemi-dev-icon-'));
try {
  const iconset = path.join(temporary, 'HemiDev.iconset');
  mkdirSync(iconset);
  const resize = (size) => {
    const destination = path.join(temporary, `icon-${size}.png`);
    execFileSync('sips', ['-z', String(size), String(size), sourcePng, '--out', destination], { stdio: 'ignore' });
    return destination;
  };
  for (const size of [16, 32, 128, 256, 512]) {
    copyFileSync(size === 512 ? sourcePng : resize(size), path.join(iconset, `icon_${size}x${size}.png`));
    copyFileSync(resize(size * 2), path.join(iconset, `icon_${size}x${size}@2x.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'build/icon-dev.icns')]);
  console.log('dev 图标已导出：build/icon-dev.png、build/icon-dev.icns');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
