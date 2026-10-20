/**
 * 菜单里的路径：家目录收成 ~，过长时留头尾、中间折叠（尾部是能认出项目的部分，
 * CSS 的尾部省略恰好把它切掉）。完整路径放 title。
 */
export function displayPath(dir: string, max = 40): string {
  const path = dir.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/, '~');
  if (path.length <= max) return path;
  const sep = path.includes('/') ? '/' : '\\';
  const parts = path.split(sep);
  const head = parts[0] || sep;
  let tail = parts[parts.length - 1];
  for (let i = parts.length - 2; i > 0; i -= 1) {
    const next = `${parts[i]}${sep}${tail}`;
    if (head.length + next.length + 3 > max) break;
    tail = next;
  }
  return `${head}${parts[0] ? sep : ''}…${sep}${tail}`;
}
