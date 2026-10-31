export function releasePlatform(args, host = process.platform) {
  const mac = args.includes('--mac-only'), win = args.includes('--win-only'), both = args.includes('--both');
  // 2026-11 起双端同 tag 同时发布为默认；--both 显式声明同一行为。
  if ([mac, win, both].filter(Boolean).length > 1) throw new Error('平台参数只能选一个：--both（默认）或 --mac-only / --win-only。');
  if (mac) return 'mac';
  if (win) return 'win';
  if (both) return 'both';
  void host;
  return 'both';
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
