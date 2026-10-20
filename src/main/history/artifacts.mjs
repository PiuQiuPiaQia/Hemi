// 012 任务成果 · 纯函数层：路径展开 / 链接提取 / 可执行判定 / 可用性查证 / 打开解析。
//
// 边界（R-07/AC-05）：渲染层只传 taskId + artifactId，目标由主进程从档案解析——
// 任意字符串不能成为本地执行命令；可执行产物只定位不运行；link 只认 https。
// 本模块不做 IO（stat 注入），node --test 离线覆盖。
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 可执行产物：默认只定位（Finder/资源管理器显示），不自动运行。
 * 043：补 Windows 形态——exe/安装包/脚本/快捷方式/间接执行（.lnk/.url 指向
 * 任意目标）。跨平台同一集合：mac 上收到 .exe 也只定位（保守方向）。
 */
export const EXECUTABLE_EXTENSIONS = new Set([
  // macOS / POSIX
  '.app', '.sh', '.command', '.scpt', '.tool',
  // Windows 可执行与安装包
  '.exe', '.com', '.msi', '.msix', '.appx',
  // Windows 脚本（含 PowerShell）
  '.bat', '.cmd', '.ps1', '.vbs', '.js', '.hta', '.scr',
  // 间接执行：快捷方式与 URL 捷径指向任意目标
  '.lnk', '.url',
]);
/** 报告里提取的结果链接上限。 */
export const MAX_ARTIFACT_LINKS = 5;

/** ~ 路径展开（write/edit 回执里的 path 常以 ~ 开头）。 */
export function expandTildePath(inputPath, home = os.homedir()) {
  const raw = String(inputPath ?? '').trim();
  if (!raw) return '';
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
  return raw;
}

export function isExecutablePath(inputPath) {
  return EXECUTABLE_EXTENSIONS.has(path.extname(String(inputPath ?? '')).toLowerCase());
}

/**
 * 从完整报告提取 https 结果链接：去重、截尾标点、上限 5 条；
 * 非 https 协议一律忽略（AC-05）。
 *
 * URL 本体只认 ASCII 安全字符：反引号、引号、尖括号与一切非 ASCII
 * （中文、全角标点）一律截断——报告里常见的「`https://…`：说明」写法，
 * 之前会把反引号和后半截说明吞进链接（2026-09-20 真机档案实录）。
 */
export function extractHttpsLinks(report, limit = MAX_ARTIFACT_LINKS) {
  const matches =
    String(report ?? '').match(
      /https:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%()[\]-]+/g,
    ) ?? [];
  const seen = new Set();
  const urls = [];
  for (const raw of matches) {
    const url = raw.replace(/[.,;:!?)\])}、。」』】》]+$/, '');
    try {
      if (new URL(url).protocol !== 'https:') continue;
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= limit) break;
  }
  return urls;
}

/** 档案 deliverables → 视图：可用性实时查证（不缓存为真，R-05/AC-03）。
 * 049：远端产物（host）不做本机 stat——available 留空（未查证），查证经预览/
 * 下载链路按 SSH 进行（R-15 的「暂时无法确认」细化归 050 接入）。 */
export function artifactViews(deliverables, { statNow = (p) => statSync(p) } = {}) {
  return (Array.isArray(deliverables) ? deliverables : [])
    .filter((artifact) => artifact && artifact.id)
    .map((artifact) => {
      const base = {
        id: artifact.id,
        kind: artifact.kind,
        name: artifact.name,
        registeredAt: artifact.registeredAt ?? null,
        // 025：交付分组展示（main/attachment）与类型标识；旧档案缺省。
        ...(artifact.role ? { role: artifact.role } : {}),
        ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
      };
      if (artifact.kind !== 'file') {
        // 旧档案可能存进被截坏的链接（反引号/中文粘连）：展示前按同一套
        // 规则重新截取一次，截不出可用的就按失效显示。
        const cleaned = extractHttpsLinks(String(artifact.url ?? ''))[0] ?? null;
        return { ...base, url: cleaned, available: cleaned !== null };
      }
      // 049：远端产物带 host——不查本机文件系统，available 不置真。
      if (artifact.host) {
        return {
          ...base,
          path: artifact.path,
          host: artifact.host,
          available: undefined,
          size: null,
          executable: isExecutablePath(artifact.path),
        };
      }
      let available = false;
      let size = null;
      // 050 R-08：细分可用状态（ok／missing＝原位置缺失；EACCES 等＝unreadable）。
      let availability = { state: 'missing' };
      try {
        const stats = statNow(artifact.path);
        available = stats.isFile();
        size = stats.size ?? null;
        availability = available ? { state: 'ok' } : { state: 'missing' };
      } catch (error) {
        available = false;
        availability = { state: error?.code === 'EACCES' || error?.code === 'EPERM' ? 'unreadable' : 'missing' };
      }
      return {
        ...base,
        path: artifact.path,
        available,
        size,
        executable: isExecutablePath(artifact.path),
        availability,
      };
    });
}

/**
 * 打开解析（不做 IO，返回意图由 IPC 层执行）：
 *   kind 'open'   → shell.openPath
 *   kind 'reveal' → shell.showItemInFolder（可执行产物 / 用户点「显示」）
 *   kind 'link'   → shell.openExternal（仅 https）
 */
export function resolveForOpen(record, artifactId, { intent = 'open', statNow = (p) => statSync(p) } = {}) {
  const artifact = (record?.deliverables ?? []).find((item) => item?.id === String(artifactId));
  if (!artifact) return { ok: false, message: '没有这个成果条目' };
  if (artifact.kind !== 'file') {
    // 打开前同样重新截取：旧档案里的截坏链接不能原样丢给浏览器。
    const cleaned = extractHttpsLinks(String(artifact.url ?? ''))[0];
    if (!cleaned) {
      return { ok: false, message: '只支持打开 https 结果链接' };
    }
    return { ok: true, kind: 'link', url: cleaned };
  }
  // 049 R-11：远端文件绝不交给本机打开器（打开/访达都不行）——同名字样本机
  // 路径属于另一台机器。入口只剩预览与「下载到本机」。
  if (artifact.host) {
    return {
      ok: false,
      message: `这是服务器 ${artifact.host} 上的文件，不在本机打开：请用「预览」查看，或下载到本机`,
    };
  }
  let stats;
  try {
    stats = statNow(artifact.path);
  } catch {
    return { ok: false, message: '文件已不可用（可能被移动或删除），原任务不会重新执行' };
  }
  if (!stats.isFile()) {
    return { ok: false, message: '文件已不可用（可能被移动或删除），原任务不会重新执行' };
  }
  if (intent === 'reveal' || isExecutablePath(artifact.path)) {
    return { ok: true, kind: 'reveal', path: artifact.path };
  }
  return { ok: true, kind: 'open', path: artifact.path };
}
