// exFAT 会把 macOS 扩展属性写成 ._* 伴生文件。打包目录进入签名/DMG 前清除，
// 避免 node-gyp-build 把 ._*.node 当作原生模块加载。
// 044 追加：HEMI_UPDATE_TOKEN（CI secret，仅 contents:read 的只读 PAT）存在时
// 写入 Resources/update-token.txt——更新服务靠它访问私有仓的 Releases API。
// 不设则不写（repo 转公开后的匿名形态）。
const { readdir, unlink, writeFile } = require('node:fs/promises');
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
  // token 写入按平台取 Resources 路径：mac 在 .app/Contents/Resources，
  // win 在 appOutDir/resources（更新服务按 process.resourcesPath 读）。
  const resourcesDir = platformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const token = (process.env.HEMI_UPDATE_TOKEN || '').trim();
  if (token) {
    await writeFile(path.join(resourcesDir, 'update-token.txt'), `${token}\n`);
    console.log('[after-pack-clean] update token bundled');
  }
  if (platformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const removed = await clean(appPath);
  console.log(`[after-pack-clean] removed ${removed} AppleDouble files`);
};
