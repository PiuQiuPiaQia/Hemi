// 订阅余额查询（ChatGPT / GLM bigmodel）。其余 OAuth 供应商明确 unsupported。
//
// Endpoint 证据：
// - GLM（已确认）：GET https://bigmodel.cn/api/monitor/usage/quota/limit，BigModel 项目令牌
//   Bearer 鉴权。真实形状见 .visual/bigmodel-quota-large-before/-after.json（脱敏）与
//   .visual/workflow/vision-report-bigmodel-quota.md（2026-10-25 生产受控验证）：
//   {code:200, data:{level, limits:[{type:'CREDIT_LIMIT', unit:3|6, number, usage,
//   currentValue, remaining, percentage, nextResetTime}]}}。
//   unit:3/number:5＝5 小时池，unit:6/number:1＝每周池；percentage 为整数截断的已用百分比；
//   usage−currentValue 与 remaining 可差 1（服务端取整）→ 绝对剩余以 remaining 为准，
//   remainingPercent 优先 remaining/usage，percentage 只作回退。
// - ChatGPT（Codex 通道）：https://chatgpt.com/backend-api/wham/usage —— 本地
//   CC Switch 3.x 二进制字符串（headers: Authorization / User-Agent: codex-cli / Accept /
//   ChatGPT-Account-Id；响应 struct CodexUsageResponse{rate_limit} ＋
//   CodexRateLimitWindow{used_percent, limit_window_seconds, reset_after_seconds}，
//   primary=5 小时、secondary=周窗口）。pi-ai 的 Codex OAuth 令牌受众就是
//   chatgpt.com/backend-api，与 codex-cli 同通道。解析只认明确字段，不认识的一律
//   'unavailable'，绝不本地估算、绝不补 0。
//
// 安全边界：
// - 令牌只来自 runtime.models.getAuth（过期时在凭据锁内刷新）与 Hemi 自己的 credentials
//   存储；access/refresh/JWT 不进 renderer DTO、错误消息或日志（redactText 兜底）。
// - 请求只发上方固定 endpoint，redirect: 'error'，无域名探测、无重定向跟随。
// - 缓存按「账号指纹」单条存储；登出/重登录/在途返回都以指纹复核，防跨账户串数据。
//   指纹用非秘密派生值（openai＝accountId；bigmodel＝codingAuthKey），可安全比较。

import { isOAuthProvider, OAUTH_PROVIDERS } from './oauth-models.mjs';
import { codingAuthKey } from './bigmodel-coding-auth.mjs';

const OPENAI_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const BIGMODEL_QUOTA_URL = 'https://bigmodel.cn/api/monitor/usage/quota/limit';
const SUPPORTED = new Set(['openai', 'bigmodel']);

const DEFAULTS = {
  ttlMs: 60_000, // 成功结果缓存时长
  failureTtlMs: 15_000, // 失败结果短缓存：renderer 重挂载不重复打失败接口
  forceMinIntervalMs: 10_000, // force 绕过缓存但受此限频，防止连点狂请求
  timeoutMs: 12_000,
  responseCapBytes: 262_144,
};

/** 非字符串/非有限数一律 null——未知保持未知，不造 0。 */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 相对秒（codex reset_after_seconds）或 epoch 秒/毫秒（glm resets_at）统一成 epoch 毫秒。 */
function epochMs(value, at = Date.now()) {
  const raw = finiteNumber(value);
  if (raw === null) return null;
  if (raw > 1e11) return raw; // 已是毫秒
  if (raw > 1e9) return raw * 1000; // epoch 秒
  return at + raw * 1000; // 相对秒
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

/** 错误/日志文本脱敏：剥 URL userinfo/query/hash，JWT 与长 token 串打码，截断。 */
export function redactText(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, part => part.replace(/\/\/[^/\s:@]+:[^/\s@]+@/, '//').replace(/[?#].*$/, ''))
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '…')
    .replace(/[A-Za-z0-9_-]{32,}/g, '…')
    .slice(0, 300);
}

/** 只为拼 ChatGPT-Account-Id 请求头做本地 JWT 解码；claims 不离开本模块。
 *  payload 同时兼容标准 base64 与 base64url（pi-ai 用 atob，测试 fixture 用 base64url）。 */
function jwtStringClaim(token, claim) {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const parsed = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    // Codex 令牌把账号标识嵌在 'https://api.openai.com/auth' 下；旧直连令牌在顶层。
    const value = parsed?.[claim] ?? parsed?.['https://api.openai.com/auth']?.[claim];
    return typeof value === 'string' && value ? value : null;
  } catch { return null; }
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** codex 窗口：只有百分比（used_percent），used/limit 服务器没给就不设。
 *  reset 优先 reset_at（服务端绝对时间）；used_percent=0 时 reset 是占位值，不展示。 */
function codexWindow(raw, at) {
  if (!isObject(raw)) return null;
  const used = finiteNumber(raw.used_percent);
  const resetsAt = used === 0 ? null : epochMs(raw.reset_at ?? raw.reset_after_seconds, at);
  if (used === null && resetsAt === null) return null;
  return {
    remainingPercent: used === null ? null : clampPercent(100 - used),
    ...(resetsAt !== null ? { resetsAt } : {}),
  };
}

/** 窗口身份只认 limit_window_seconds（实测 primary 可能是周窗口，位置不可信）。
 *  2026-10-30 实测：primary_window={used_percent:49, limit_window_seconds:604800,
 *  reset_after_seconds, reset_at}、secondary_window=null——与 CC Switch 按秒数
 *  识别（18000=5 小时 / 604800=周 / 2592000=30 天）一致。 */
const CODEX_WINDOW_KINDS = [
  { seconds: 18000, id: 'five-hour', label: '5 小时' },
  { seconds: 604800, id: 'weekly', label: '本周（7 天）' },
  { seconds: 2592000, id: 'thirty-day', label: '30 天' },
];

function codexWindows(body, at) {
  const limits = body?.rate_limit;
  if (!isObject(limits)) return [];
  const seen = new Set();
  const found = [];
  for (const raw of [limits.primary_window, limits.secondary_window]) {
    const kind = CODEX_WINDOW_KINDS.find(item => finiteNumber(raw?.limit_window_seconds) === item.seconds);
    if (!kind || seen.has(kind.id)) continue;
    const parsed = codexWindow(raw, at);
    if (!parsed) continue;
    seen.add(kind.id);
    found.push({ id: kind.id, label: kind.label, ...parsed });
  }
  // 展示顺序固定：5 小时 → 周 → 30 天（与 GLM 一致，短的在前）。
  const order = new Map(CODEX_WINDOW_KINDS.map((item, index) => [item.id, index]));
  return found.sort((a, b) => order.get(a.id) - order.get(b.id));
}

// 已确认的 GLM 池语义（.visual 验证报告）：unit:3＝小时、unit:6＝周（number 为数量）。
const GLM_POOL_UNITS = new Map([[3, { id: 'five-hour', label: '5 小时' }], [6, { id: 'weekly', label: '本周（7 天）' }]]);

/** GLM 窗口：limits[] 条目；绝对剩余以服务端 remaining 为准（与 usage−currentValue 可差 1＝取整，不重算）。 */
function glmWindow(raw) {
  if (!isObject(raw) || raw.type !== 'CREDIT_LIMIT') return null;
  const meta = GLM_POOL_UNITS.get(raw.unit);
  if (!meta) return null; // 未知池单位：不造标签，跳过
  const usage = finiteNumber(raw.usage);
  const remaining = finiteNumber(raw.remaining);
  const used = finiteNumber(raw.currentValue);
  const resetsAt = epochMs(raw.nextResetTime);
  const percentage = finiteNumber(raw.percentage);
  const remainingPercent = remaining !== null && usage !== null && usage > 0
    ? clampPercent((remaining / usage) * 100)
    : percentage !== null && percentage >= 0 && percentage <= 100 ? clampPercent(100 - percentage) : null;
  // 任一字段已知就保留窗口（used/limit 已知而百分比未知 → remainingPercent 保持 null）。
  if (remainingPercent === null && remaining === null && used === null && usage === null && resetsAt === null) return null;
  return {
    ...meta,
    remainingPercent,
    ...(remaining !== null ? { remaining } : {}),
    ...(used !== null ? { used } : {}),
    ...(usage !== null ? { limit: usage, unit: 'credits' } : {}),
    ...(resetsAt !== null ? { resetsAt } : {}),
  };
}

function glmWindows(body) {
  const data = isObject(body?.data) ? body.data : body;
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const windows = [];
  for (const raw of limits) {
    const window = glmWindow(raw);
    if (window) windows.push(window);
  }
  return windows;
}

/** 账号指纹：跨刷新稳定、重登录才变化；读不到凭据返回 null（未登录）。 */
export function accountKey(provider, credential) {
  if (provider === 'openai') {
    // Codex 通道凭据以 accountId 标识账号；旧直连凭据（只有 clientId、无 accountId）
    // 视为不完整，由调用方要求重新登录。
    return typeof credential?.accountId === 'string' && credential.accountId ? `openai:${credential.accountId}` : null;
  }
  if (provider === 'bigmodel') {
    try { return `bigmodel:${codingAuthKey(credential)}`; } catch { return null; }
  }
  return null;
}

export function createSubscriptionQuota({
  runtime, credentials, fetchImpl = (...args) => globalThis.fetch(...args), log,
  now = Date.now, ...overrides
} = {}) {
  const limits = { ...DEFAULTS, ...overrides };
  /** provider → { key, view, expiresAt, completedAt }。单条按账号指纹复核。 */
  const cache = new Map();
  /** provider → Promise<{ key, view }>；并发调用合并到一次网络请求。 */
  const inflight = new Map();

  const baseOf = provider => ({ provider, windows: [], fetchedAt: now() });
  const unavailable = (provider, message) => ({ ...baseOf(provider), status: 'unavailable', message });
  const signedOut = (provider, message = '尚未登录这个账号。') => ({ ...baseOf(provider), status: 'signed-out', message });
  const cloneView = view => structuredClone(view);

  async function readJson(response) {
    const text = await response.text();
    if (text.length > limits.responseCapBytes) throw new Error('响应超出预期大小');
    return JSON.parse(text);
  }

  function httpFailure(provider, status, vendor) {
    if (status === 401 || status === 403) {
      return unavailable(provider, vendor === 'ChatGPT'
        ? 'ChatGPT 额度查询未获授权，请重新登录后再试。'
        : 'GLM 编程套餐额度查询未获授权，请重新登录后再试。');
    }
    if (status === 429) return unavailable(provider, `${vendor}额度查询过于频繁，请稍后再试。`);
    return unavailable(provider, `${vendor}额度查询失败（HTTP ${status}），请稍后重试。`);
  }

  function failure(provider, error, vendor) {
    log?.warn?.(`${vendor}额度查询失败：${redactText(error?.message)}`);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (error instanceof SyntaxError) return unavailable(provider, `${vendor}额度接口返回了无法解析的结果，请稍后重试。`);
    return unavailable(provider, `${vendor}额度查询失败，请检查网络后重试。`);
  }

  async function fetchOpenai({ signal }) {
    // getAuth 在凭据锁内完成过期刷新；失败（invalid_grant 等）→ 需要重新登录。
    let token;
    try {
      const auth = await runtime.models.getAuth('openai', { signal });
      token = auth?.auth?.apiKey;
    } catch (error) {
      log?.warn?.(`ChatGPT 登录状态刷新失败：${redactText(error?.message)}`);
      return unavailable('openai', 'ChatGPT 登录状态无法确认，请重新登录后再试。');
    }
    if (typeof token !== 'string' || !token) return signedOut('openai', '登录已失效，请重新登录。');
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      // CC Switch 对同一 endpoint 即用此 UA；后端可能按 UA 放行。
      'user-agent': 'codex-cli',
    };
    // Codex 凭据自带 accountId（登录时取自 JWT claim）；旧直连凭据没有该字段，
    // 仅当 access token 本地解码出该 claim 时兜底携带，绝不把 JWT 内容发往其他地方。
    let credential = null;
    try { credential = await credentials.read('openai'); } catch { /* 读不到就不带头，由指纹复核兜底 */ }
    const accountId = credential?.accountId ?? jwtStringClaim(token, 'chatgpt_account_id');
    if (accountId) headers['chatgpt-account-id'] = accountId;
    const response = await fetchImpl(OPENAI_USAGE_URL, {
      headers, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)]) : AbortSignal.timeout(limits.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return httpFailure('openai', response.status, 'ChatGPT');
    }
    const windows = codexWindows(await readJson(response), now());
    if (!windows.length) return unavailable('openai', 'ChatGPT 没有返回可识别的额度窗口。');
    return { ...baseOf('openai'), status: 'ok', windows };
  }

  /** monitor 接口鉴权：已确认用已授权项目令牌（vision-report-bigmodel-quota.md）。 */
  function bigmodelAuthorization(credential) {
    return `Bearer ${credential.access}`;
  }

  async function fetchBigmodel({ signal }) {
    try {
      // 项目令牌过期时在凭据锁内刷新；失败消息本身已受控（GLM 编程套餐…）。
      await runtime.models.getAuth('bigmodel', { signal });
    } catch (error) {
      if (/^GLM 编程套餐/.test(error?.message)) return unavailable('bigmodel', error.message);
      log?.warn?.(`GLM 登录状态刷新失败：${redactText(error?.message)}`);
      return unavailable('bigmodel', 'GLM 编程套餐登录状态无法确认，请重新登录后再试。');
    }
    const credential = await credentials.read('bigmodel');
    if (!credential) return signedOut('bigmodel', '登录已失效，请重新登录。');
    const response = await fetchImpl(BIGMODEL_QUOTA_URL, {
      headers: { authorization: bigmodelAuthorization(credential), accept: 'application/json' },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)]) : AbortSignal.timeout(limits.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return httpFailure('bigmodel', response.status, 'GLM 编程套餐');
    }
    const windows = glmWindows(await readJson(response));
    if (!windows.length) return unavailable('bigmodel', 'GLM 编程套餐没有返回可识别的额度窗口。');
    return { ...baseOf('bigmodel'), status: 'ok', windows };
  }

  const fetchers = { openai: fetchOpenai, bigmodel: fetchBigmodel };
  const vendorOf = provider => provider === 'openai' ? 'ChatGPT' : 'GLM 编程套餐';

  /** 当前账号指纹；未登录＝null，凭据损坏/存储不可用＝{ error }。 */
  async function currentKey(provider) {
    let credential;
    try { credential = await credentials.read(provider); } catch (error) {
      return { error: redactText(error?.message) || '账号凭据不可用，请重新登录。' };
    }
    if (!credential) return null;
    const key = accountKey(provider, credential);
    return key ? { key } : { error: '账号凭据不完整，请重新登录。' };
  }

  async function fetchView(provider, signal) {
    try { return await fetchers[provider]({ signal }); } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      return failure(provider, error, provider === 'openai' ? 'ChatGPT' : 'GLM 编程套餐');
    }
  }

  return {
    /** 永不 reject（调用方 signal 已取消时除外——彼时 invoke 结果已无人接收）。 */
    async view(provider, { force = false, signal } = {}) {
      if (!isOAuthProvider(provider)) return { ...baseOf(String(provider)), status: 'unsupported', message: '这个账号服务商不支持订阅余额查询。' };
      if (!SUPPORTED.has(provider)) return { ...baseOf(provider), status: 'unsupported', message: `${OAUTH_PROVIDERS[provider]} 暂不支持订阅余额查询。` };
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await currentKey(provider);
        if (current === null) {
          cache.delete(provider);
          return signedOut(provider);
        }
        if (current.error) {
          cache.delete(provider);
          return unavailable(provider, current.error);
        }
        const key = current.key;
        const cached = cache.get(provider);
        if (cached?.key === key) {
          const at = now();
          if (!force && at < cached.expiresAt) return cloneView(cached.view);
          // force 限频：距上次完成（无论成败）不足间隔时仍回缓存，防连点狂请求。
          if (force && at - cached.completedAt < limits.forceMinIntervalMs) return cloneView(cached.view);
        }
        const pending = inflight.get(provider);
        if (pending) {
          const result = await pending;
          if (result.key === key) return cloneView(result.view);
          continue; // 在途期间账号变化：丢弃重查，绝不返回旧账号结果
        }
        const op = fetchView(provider, signal).then(
          view => ({ key, view }),
          error => {
            // 意外异常（含调用方 abort 后的网络报错）也收敛为受控视图；细节只进脱敏日志。
            log?.warn?.(`${vendorOf(provider)}额度查询异常：${redactText(error?.message)}`);
            return { key, view: unavailable(provider, `${vendorOf(provider)}额度查询失败，请检查网络后重试。`) };
          },
        );
        inflight.set(provider, op);
        try {
          const result = await op;
          signal?.throwIfAborted(); // 结果回来时调用方已取消：不落缓存、不返回
          if (result.key !== key) continue;
          // 完成时复核账号指纹：查询期间登出/重登录 → 丢弃本次结果，重按当前账号查。
          const latest = await currentKey(provider);
          if (latest?.key !== key) continue;
          cache.set(provider, {
            key, view: result.view,
            expiresAt: now() + (result.view.status === 'ok' ? limits.ttlMs : limits.failureTtlMs),
            completedAt: now(),
          });
          return cloneView(result.view);
        } finally {
          if (inflight.get(provider) === op) inflight.delete(provider);
        }
      }
      return unavailable(provider, '账号状态在查询期间发生变化，请重试。');
    },
    /** 登出后清缓存；在途请求靠指纹复核自然失效。 */
    invalidate(provider) {
      if (provider) cache.delete(provider); else cache.clear();
    },
  };
}
