// 071 · SSH 目标与端口归一（远端工作区「添加服务器上的文件夹」）。
//
// 端口折进目标串（ssh://user@host:port；OpenSSH 7.7+ 原生解析，macOS/Windows
// 现役系统 ssh 均支持）：登记身份、密码池、ControlMaster 复用、远端产物下载
// 全按目标串取齐，不在每个执行点单独穿 port 参数。无端口时保持 Host 别名或
// user@host 原样——走 ~/.ssh/config（含其 Port 配置）。
//
// 纯模块（无 Node/Electron 依赖）：主进程（workspace.ipc/ssh-runner/
// remote-service）与渲染层（workspace-bar 显示）共用。

const URI_PREFIX = 'ssh://';
/** host 末尾的 :端口（普通主机名；主机段不含冒号，避免与 IPv6 混淆）。 */
const PLAIN_HOST_PORT = /^((?:[^:@/[\]]+@)?[A-Za-z0-9._-]+):(\d{1,5})$/;
/** 方括号 IPv6 的 :端口。 */
const BRACKET_HOST_PORT = /^((?:[^:@/[\]]+@)?\[[0-9A-Fa-f:.]+\]):(\d{1,5})$/;
/** ssh:// 主体：到主机/端口为止，不带路径。 */
const URI_BODY = /^[^/\s]+$/;

/** 1–65535 整数端口（字符串或数字都收）。 */
export function isValidPort(port) {
  const value = Number(port);
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** ssh://user@host:2222 → user@host:2222；其他原样。显示用，不用于 argv/命令。 */
export function formatSshTarget(target) {
  const text = String(target ?? '').trim();
  return text.startsWith(URI_PREFIX) ? text.slice(URI_PREFIX.length) : text;
}

/**
 * 服务器输入 + 可选端口 → SSH 目标串。
 * - host 可带嵌入式端口（user@host:2222、[::1]:2222、ssh://user@host:2222）；
 *   显式 port 优先于嵌入式。
 * - 有端口 → ssh://host:port；无端口 → 原样（Host 别名走 SSH 配置）。
 * - 裸 IPv6（未加方括号）配端口无法拼无歧义 URI：如实报错引导加方括号。
 * @returns {{ ok: true, target: string, port: number | null } | { ok: false, reason: string }}
 */
export function resolveRemoteTarget({ host, port = null }) {
  let base = String(host ?? '').trim();
  if (base.startsWith(URI_PREFIX)) {
    const body = base.slice(URI_PREFIX.length);
    if (!body || !URI_BODY.test(body)) {
      return { ok: false, reason: '服务器格式不对：ssh:// 地址只能到主机和端口，不带路径。' };
    }
    base = body;
  }
  let embedded = null;
  const split = PLAIN_HOST_PORT.exec(base) ?? BRACKET_HOST_PORT.exec(base);
  if (split) {
    base = split[1];
    embedded = split[2];
  }
  const explicitRaw = port == null ? null : String(port).trim();
  const finalPort = explicitRaw ? explicitRaw : embedded;
  if (finalPort != null && !isValidPort(finalPort)) {
    return { ok: false, reason: `端口填 1–65535 的数字（收到「${finalPort}」），或留空走 SSH 配置（默认 22）。` };
  }
  if (finalPort != null) {
    // 方括号外的冒号＝裸 IPv6：ssh://user@::1:2222 有歧义，要求加方括号。
    if (base.replace(/\[[^\]]*\]/g, '').includes(':')) {
      return { ok: false, reason: 'IPv6 地址要加方括号再填端口，例如 user@[2001:db8::1]:2222。' };
    }
    return { ok: true, target: `${URI_PREFIX}${base}:${finalPort}`, port: Number(finalPort) };
  }
  return { ok: true, target: base, port: null };
}
