/** 保守识别完整文件路径；只提供点击线索，存在性与权限仍由宿主查证。 */
export function inlineFilePath(text: string): string | null {
  if (
    !text ||
    text !== text.trim() ||
    /[\r\n<>|`]/.test(text) ||
    /(?:&&|\$\(|\$\{|;)/.test(text)
  )
    return null;
  if (/^file:\/\//i.test(text)) return text;
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[a-z]:[/\\]/i.test(text))
    return null;
  const explicit = /^(?:\/|~\/|\.\.?\/|[a-z]:[/\\])/i.test(text);
  const relative = /^[\p{L}\p{N}_.@-]+[/\\]/u.test(text);
  if (!explicit && !relative) return null;
  return /\.[a-z\d]{1,12}$/i.test(text) ? text : null;
}

export function decodeFileHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}
