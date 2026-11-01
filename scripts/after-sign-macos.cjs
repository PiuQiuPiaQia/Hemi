const path = require('node:path');
const { pathToFileURL } = require('node:url');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { verifyMacSignature } = await import(pathToFileURL(path.join(__dirname, 'lib/macos-signing.mjs')).href);
  verifyMacSignature(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
};
