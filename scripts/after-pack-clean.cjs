// exFAT 会把 macOS 扩展属性写成 ._* 伴生文件。打包目录进入签名/DMG 前清除，
// 避免 node-gyp-build 把 ._*.node 当作原生模块加载。
const { readdir, unlink } = require('node:fs/promises');
const path = require('node:path');

async function clean(dir) {
  let removed = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.name.startsWith('._')) {
      await unlink(absolute);
      removed++;
    } else if (entry.isDirectory()) {
      removed += await clean(absolute);
    }
  }
  return removed;
}

module.exports = async function afterPack(context) {
  const platformName = context.electronPlatformName;
  // 公开下载不需要更新 token；同时清理旧打包目录可能残留的凭据文件。
  const resourcesDir = platformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  await unlink(path.join(resourcesDir, 'update-token.txt')).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (platformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const removed = await clean(appPath);
  console.log(`[after-pack-clean] removed ${removed} AppleDouble files`);
};
