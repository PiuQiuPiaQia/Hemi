type HemiBridge = Window['hemiVoice'];

/**
 * Hands a URL to the system browser. The main process re-validates the link
 * against its host allowlist, so an unknown URL is simply ignored.
 */
export function openExternal(url: string) {
  const bridge = (window as Window & { hemiVoice?: HemiBridge }).hemiVoice;
  if (!bridge) return;
  void bridge.openExternal(url);
}

/** 056：对话内容里的链接（模型给出、域名不可预知）——任意 http/https 交默认浏览器。 */
export function openContentLink(url: string) {
  const bridge = (window as Window & { hemiVoice?: HemiBridge }).hemiVoice;
  if (!bridge) return;
  void (bridge.openLink ?? bridge.openExternal)(url);
}
