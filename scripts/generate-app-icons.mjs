#!/usr/bin/env node
/**
 * 从唯一矢量母版 build/icon.svg 导出 PNG、界面、favicon、Chrome 扩展、ICNS 与 ICO。
 * 在 macOS 运行 npm run build:icons；使用已有 Electron 与系统 sips/iconutil。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronExecutable from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') {
  throw new Error('请在 macOS 使用 sips/iconutil 导出图标；各平台直接消费已提交的资源');
}
const sourceSvg = path.join(root, 'build/icon.svg');
const source = path.join(root, 'build/icon.png');
execFileSync(electronExecutable, [path.join(root, 'scripts/render-app-icon.mjs'), sourceSvg, source], { stdio: 'inherit' });
const master = readFileSync(source);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
if (!master.subarray(0, 8).equals(pngSignature) || master.length < 24) {
  throw new Error('build/icon.png 必须是 PNG 母版');
}
if (master.readUInt32BE(16) !== 1024 || master.readUInt32BE(20) !== 1024) {
  throw new Error('build/icon.png 母版必须是 1024×1024');
}

const temporary = mkdtempSync(path.join(tmpdir(), 'hemi-app-icons-'));
const resize = (size, destination) => {
  mkdirSync(path.dirname(destination), { recursive: true });
  execFileSync('sips', ['-z', String(size), String(size), source, '--out', destination], { stdio: 'ignore' });
};

try {
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const pngs = new Map();
  for (const size of sizes) {
    const destination = path.join(temporary, `icon-${size}.png`);
    if (size === 1024) copyFileSync(source, destination);
    else resize(size, destination);
    pngs.set(size, destination);
  }
  const publish = (size, relativePath) => {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(pngs.get(size), destination);
  };
  publish(128, 'src/renderer/src/assets/hemi-icon.png');
  copyFileSync(sourceSvg, path.join(root, 'src/renderer/src/assets/hemi-icon.svg'));
  publish(32, 'src/renderer/public/favicon.png');
  for (const size of [16, 32, 48, 128]) {
    publish(size, `extensions/chrome-extension/icons/icon-${size}.png`);
  }

  const iconset = path.join(temporary, 'Hemi.iconset');
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    copyFileSync(pngs.get(size), path.join(iconset, `icon_${size}x${size}.png`));
    copyFileSync(pngs.get(size * 2), path.join(iconset, `icon_${size}x${size}@2x.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'build/icon.icns')]);

  // ICO 的每个帧使用标准 PNG 压缩；256px 在目录项中以 0 表示。
  const frames = sizes.filter((size) => size <= 256).map((size) => ({
    size, bytes: readFileSync(pngs.get(size)),
  }));
  const directory = Buffer.alloc(6 + frames.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  frames.forEach(({ size, bytes }, index) => {
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(bytes.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  });
  writeFileSync(path.join(root, 'build/icon.ico'), Buffer.concat([directory, ...frames.map(({ bytes }) => bytes)]));
  console.log('图标已导出：SVG、PNG、ICNS、ICO、界面、favicon、Chrome 扩展（16/32/48/128）');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
