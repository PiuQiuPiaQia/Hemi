export function releasePlatform(args, host = process.platform) {
  const mac = args.includes('--mac-only'), win = args.includes('--win-only');
  if (mac && win) throw new Error('每次只能发布一个平台，请只选择 --mac-only 或 --win-only。');
  if (mac) return 'mac';
  if (win) return 'win';
  if (host === 'darwin') return 'mac';
  if (host === 'win32') return 'win';
  throw new Error('请显式选择 --mac-only 或 --win-only。');
}

/** Keep older installed clients on /latest/download working across separate releases. */
export function relayUpdateManifest(manifest, assets) {
  return manifest.replace(/^(\s*(?:- )?(?:url|path):\s*)(\S+)(\s*)$/gm, (_line, prefix, raw, suffix) => {
    const value = raw.replace(/^(['"])(.*)\1$/, '$2');
    if (/^https:\/\//.test(value)) return prefix + value + suffix;
    const asset = assets.find(item => item.name === decodeURIComponent(value));
    if (!asset?.browser_download_url?.startsWith('https://')) throw new Error(`更新清单缺少对应资产：${value}`);
    return prefix + asset.browser_download_url + suffix;
  });
}
