#!/usr/bin/env node
/**
 * 从唯一矢量母版 build/icon.svg 导出 PNG、界面、favicon、Chrome 扩展、ICNS、ICO 与移动端品牌资产。
 * 在 macOS 运行 npm run build:icons；使用已有 Electron 与系统 sips/iconutil。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
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

  // 移动端品牌资产同样出自唯一母版：iOS 图标走全出血方形（系统自切圆角），
  // Android 传统图标用母版圆角方/圆形两种，自适应前景只取 #FAFAF7 前景图形（安全区内）。
  const masterSvg = readFileSync(sourceSvg, 'utf8');
  const backgroundColor = masterSvg.match(/<path fill="(#[0-9A-Fa-f]{6})"/)?.[1];
  const glyphMatch = masterSvg.match(/<g fill="#FAFAF7">[\s\S]*?<\/g>/);
  if (!backgroundColor || !glyphMatch) {
    throw new Error('build/icon.svg 结构已变化，请同步更新移动端导出的前景/背景提取');
  }
  const glyph = glyphMatch[0];
  const renderVariant = (name, body) => {
    const svgFile = path.join(temporary, `${name}.svg`);
    writeFileSync(svgFile, `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${body}</svg>`);
    const png = path.join(temporary, `${name}.png`);
    execFileSync(electronExecutable, [path.join(root, 'scripts/render-app-icon.mjs'), svgFile, png], { stdio: 'inherit' });
    return png;
  };
  const squarePng = renderVariant('hemi-square', `<rect width="1024" height="1024" fill="${backgroundColor}"/>${glyph}`);
  const roundPng = renderVariant('hemi-round', `<circle cx="512" cy="512" r="512" fill="${backgroundColor}"/>${glyph}`);
  const glyphPng = renderVariant('hemi-glyph', glyph);

  const mobile = path.join(root, 'apps/mobile');
  const publishPng = (from, size, relativePath) => {
    const destination = path.join(mobile, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    execFileSync('sips', ['-z', String(size), String(size), from, '--out', destination], { stdio: 'ignore' });
  };
  copyFileSync(squarePng, path.join(mobile, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
  copyFileSync(sourceSvg, path.join(mobile, 'public/favicon.svg'));
  mkdirSync(path.join(mobile, 'src/assets'), { recursive: true });
  copyFileSync(sourceSvg, path.join(mobile, 'src/assets/hemi-mark.svg'));
  const launcherSizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  const foregroundSizes = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
  for (const [density, size] of Object.entries(launcherSizes)) {
    publishPng(source, size, `android/app/src/main/res/mipmap-${density}/ic_launcher.png`);
    publishPng(roundPng, size, `android/app/src/main/res/mipmap-${density}/ic_launcher_round.png`);
  }
  for (const [density, size] of Object.entries(foregroundSizes)) {
    publishPng(glyphPng, size, `android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`);
  }
  writeFileSync(
    path.join(mobile, 'android/app/src/main/res/values/ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${backgroundColor}</color>\n</resources>\n`,
  );
  // Capacitor 模板残留的默认机器人图标未被引用，移除避免品牌混入。
  rmSync(path.join(mobile, 'android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml'), { force: true });
  rmSync(path.join(mobile, 'android/app/src/main/res/drawable/ic_launcher_background.xml'), { force: true });

  // 闪屏为纯白（无第三方标志）；PNG 用 8-bit 真彩不带 alpha，逐尺寸直接生成。
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const pngChunk = (type, data) => {
    const output = Buffer.alloc(12 + data.length);
    output.writeUInt32BE(data.length);
    output.write(type, 4, 'ascii');
    data.copy(output, 8);
    output.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
    return output;
  };
  const whitePng = (width, height) => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const row = Buffer.alloc(1 + width * 3, 255);
    return Buffer.concat([
      pngSignature,
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
  };
  const writeWhite = (width, height, relativePath) => {
    const destination = path.join(mobile, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, whitePng(width, height));
  };
  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    writeWhite(2732, 2732, `ios/App/App/Assets.xcassets/Splash.imageset/${name}`);
  }
  const splashSizes = {
    mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920],
  };
  for (const [density, [width, height]] of Object.entries(splashSizes)) {
    writeWhite(width, height, `android/app/src/main/res/drawable-port-${density}/splash.png`);
    writeWhite(height, width, `android/app/src/main/res/drawable-land-${density}/splash.png`);
  }
  writeWhite(480, 320, 'android/app/src/main/res/drawable/splash.png');
  console.log('图标已导出：SVG、PNG、ICNS、ICO、界面、favicon、Chrome 扩展（16/32/48/128）、移动端（iOS/Android 图标与闪屏）');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
