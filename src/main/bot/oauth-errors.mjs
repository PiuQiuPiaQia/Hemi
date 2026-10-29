const STAGES = {
  catalog: '读取账号模型目录',
  inference: '验证模型连接',
  storage: '保存登录凭据',
  save: '保存模型配置',
};

const REASONS = {
  timeout: 'Bot 服务器连接服务商超时，请检查服务器出网和代理配置',
  network: 'Bot 服务器无法连接服务商，请检查服务器出网和代理配置',
  dns: 'Bot 服务器无法解析服务商域名，请检查服务器 DNS',
  tls: 'Bot 服务器无法验证服务商证书，请检查服务器时间、证书及代理配置',
  unauthorized: '服务商拒绝了登录凭据，请重新为 Bot 授权',
  forbidden: '服务商拒绝了 Bot 的访问（HTTP 403），请检查服务器出网地区及账号权限',
  region: '服务商不支持 Bot 服务器当前的出网地区',
  quota: '订阅共享额度不可用或已用尽，请在服务商处检查额度后重试',
  rate: '服务商请求过于频繁，请稍后重试',
  models: '账号没有返回 Bot 支持的模型，请检查账号权限与模型目录',
  disk: 'Bot 服务器磁盘空间不足，请释放空间后重试',
  permission: 'Bot 无法写入服务器上的账号配置，请检查目录权限',
  unknown: '操作未完成，请检查服务器连接或运行组件后重试',
};

/** Inspect provider failures internally; only fixed text and numeric status leave
 * the Host. Never return response bodies, tokens, headers, URLs or raw errors. */
export function botOAuthFailure(error, stage) {
  const pending = [error], seen = new Set(), messages = [], statuses = [];
  while (pending.length && seen.size < 12) {
    const value = pending.shift();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (typeof value === 'string') { messages.push(value); continue; }
    if (typeof value !== 'object') continue;
    messages.push(String(value.name ?? ''), String(value.code ?? ''), String(value.providerCode ?? ''), String(value.message ?? ''));
    if (Number.isInteger(value.status) && value.status >= 400 && value.status <= 599) statuses.push(value.status);
    if (value.cause) pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 4));
  }
  const text = messages.join('\n');
  const status = statuses[0] ?? Number(text.match(/(?:\bHTTP\s*|\bstatus[=: ]+|\bAPI error\s*\(|(?:^|\n)\s*)([45]\d\d)\b/i)?.[1]);
  const reason = /unsupported_country_region_territory|unsupported_country|region.*not supported/i.test(text) ? 'region'
    : /subscription_sharing_(?:usage_limit_exceeded|usage_unavailable)|insufficient_quota/i.test(text) ? 'quota'
    : /ENOSPC|EDQUOT/.test(text) ? 'disk'
    : /EACCES|EPERM/.test(text) ? 'permission'
    : /ENOTFOUND|EAI_AGAIN/.test(text) ? 'dns'
    : /CERT_|TLS_|UNABLE_TO_VERIFY|SELF_SIGNED_CERT/i.test(text) ? 'tls'
    : /TimeoutError|ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT|验证超时/i.test(text) ? 'timeout'
    : /fetch failed|ECONN(?:REFUSED|RESET)|ENETUNREACH|EHOSTUNREACH|connection error/i.test(text) ? 'network'
    // Codex 通道：凭据缺账号标识（旧直连凭据或损坏令牌）只能重新授权。
    : /Failed to extract accountId from token/i.test(text) ? 'unauthorized'
    : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 429 ? 'rate'
    : /没有返回|账号没有.*模型|模型目录.*不可用/.test(text) ? 'models' : 'unknown';
  return { stage, reason, ...(Number.isInteger(status) ? { status } : {}),
    message: `Bot 未能验证账号模型（${STAGES[stage] ?? STAGES.inference}）：${REASONS[reason]}；原配置已保留。` };
}
