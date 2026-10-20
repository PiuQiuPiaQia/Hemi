// 047 New API 导入：站点地址规范化与门禁。
//
// 规则（technical-plan §3，2026-10-15 修订）：拒绝 userinfo、非 http(s)、
// 非法主机/端口与控制字符。协议由用户在入口下拉里显二选一：http 放开给
// 自建站（含局域网/本机，明文是用户自己的选择）；不带协议的输入仍补 https。
// https 仍拒绝回环/局域网（首版门禁保留）。
// siteOrigin 是管理面板归属；页面路径/query 一律剥掉——推理地址另由协议推导。

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true;
  }
  if (/^f[cd]/.test(host.replace(/:/g, '')) && host.includes(':')) return true; // IPv6 本地/私有段
  return false;
}

/**
 * 规范化站点输入 → { ok: true, siteOrigin } 或 { ok: false, code, message }。
 * code ∈ bad-url | not-https | private-host | control-chars
 */
export function normalizeSiteUrl(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return { ok: false, code: 'bad-url', message: '先填站点地址' };
  if (CONTROL_CHARS.test(text)) return { ok: false, code: 'control-chars', message: '地址里有不被允许的字符' };
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, code: 'bad-url', message: '这个地址看起来不对，检查一下再试' };
  }
  if (url.username || url.password) return { ok: false, code: 'bad-url', message: '地址里不能带用户名密码' };
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, code: 'not-https', message: '站点地址要用 http 或 https' };
  }
  const host = url.hostname;
  if (!host || !host.includes('.') && host !== 'localhost' && !host.includes(':')) {
    return { ok: false, code: 'bad-url', message: '这个地址看起来不对，检查一下再试' };
  }
  if (url.protocol === 'https:' && isPrivateHost(host)) {
    return { ok: false, code: 'private-host', message: '不支持局域网/内网地址' };
  }
  return { ok: true, siteOrigin: url.origin };
}
