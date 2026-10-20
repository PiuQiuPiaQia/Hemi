#!/usr/bin/env node
/** 以项目已有的 Electron 将 SVG 母版导出为 PNG，供图标导出脚本使用。 */
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const source = path.resolve(process.argv[2]);
const destination = path.resolve(process.argv[3]);
const size = 1024;

// 不将当前显示器的色彩配置烘焙进品牌资源。
app.commandLine.appendSwitch('force-color-profile', 'srgb');

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: size,
    height: size,
    useContentSize: true,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const svg = readFileSync(source).toString('base64');
  await window.loadURL('about:blank');
  // Canvas 导出直接使用 sRGB 像素；capturePage 会经过 macOS 显示器色彩转换。
  const dataUrl = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = ${size};
      canvas.height = ${size};
      const context = canvas.getContext('2d', { colorSpace: 'srgb' });
      context.drawImage(image, 0, 0, ${size}, ${size});
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('SVG 母版加载失败'));
    image.src = ${JSON.stringify(`data:image/svg+xml;base64,${svg}`)};
  })`);
  writeFileSync(destination, Buffer.from(dataUrl.split(',')[1], 'base64'));
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
