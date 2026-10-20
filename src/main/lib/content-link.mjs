/**
 * 056（2026-10-14 用户反馈「对话流里的链接打不开」）：对话正文／回复里的链接是模型
 * 给出的内容链接，域名不可预知——任意 http/https 都交给默认浏览器；其他协议（file:、
 * javascript:、自定义 scheme）一律拒绝，不把本机文件或应用 URL scheme 交给系统。
 */
export function isOpenableContentLink(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}
