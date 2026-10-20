// 047 New API 站点适配：身份核验、本人分组、协议候选、创建、精确查证、读 Key、撤销。
//
// 依据上游 v1.0.0-rc.41 源码与 vvcode 公开前端（research_newapi_import）：
// - POST /api/token/ 成功不返回 id/Key → 用全局唯一名称精确回查；
// - POST /api/token/:id/key 返回完整 Key（vvcode 前端补 sk- 前缀 → 归一化兼容）；
// - 协议元数据是跨分组聚合的声明 → 只做候选，可导入项由新 Key 的
//   /v1/models ＋实际协议探活共同决定（coordinator 负责）。
// 所有方法只接受封闭的 session client，不接 renderer 传入的 Cookie/header。

import { createSessionClient } from './session-client.mjs';

/** 上游默认每美元 quota 数（new-api QuotaPerUnit=500000）；站点可二改，仅用于预算换算。 */
export const QUOTA_PER_USD = 500000;

export const ENDPOINT_TYPE_TO_API = {
  openai: 'openai-completions',
  anthropic: 'anthropic-messages',
};

function apiError(code, message) {
  return Object.assign(new Error(message), { code });
}

function extractData(response) {
  const body = response.data;
  if (body && typeof body === 'object' && body.success === false) {
    const message = typeof body.message === 'string' ? body.message.slice(0, 200) : '';
    if (response.status === 401) throw apiError('LOGIN_REQUIRED', '站点要求重新登录');
    throw apiError('API_ERROR', `站点拒绝了请求${message ? `：${message}` : ''}`);
  }
  if (response.status === 401) throw apiError('LOGIN_REQUIRED', '站点要求重新登录');
  if (!response.ok) throw apiError('API_ERROR', `站点返回 ${response.status}`);
  return body?.data ?? body;
}

export function createNewApiAdapter({ session, siteOrigin, witness, now = Date.now }) {
  const client = createSessionClient({ session, siteOrigin, witness });

  /** 站点识别：/api/status 可用即 New API 家族；名称/版本只作展示。 */
  async function detectSite() {
    const response = await client.request('/api/status');
    const data = response.data?.data ?? response.data;
    const name = typeof data?.system_name === 'string' && data.system_name.trim() ? data.system_name.trim() : null;
    const version = typeof data?.version === 'string' && data.version.trim() ? data.version.trim() : null;
    return { systemName: name, version };
  }

  /** 服务端身份核验（不能拿「页面写着已登录」当成功）。 */
  async function verifyIdentity() {
    const data = extractData(await client.request('/api/user/self'));
    const id = data?.id;
    if (id == null || String(id).trim() === '') throw apiError('LOGIN_REQUIRED', '站点还没有认到登录态');
    return {
      userId: String(id), username: typeof data?.username === 'string' ? data.username : null,
      ...(typeof data?.email === 'string' ? { email: data.email } : {}),
    };
  }

  /** 本人授权分组（/api/user/self/groups；公开组/价格页不能代替）。 */
  async function readAuthorizedGroups() {
    const data = extractData(await client.request('/api/user/self/groups'));
    const entries = Array.isArray(data)
      ? data.map((name) => [String(name), {}])
      : Object.entries(data ?? {});
    return entries
      .filter(([name]) => name && name.trim())
      .map(([name, info]) => ({
        name,
        desc: typeof info?.desc === 'string' ? info.desc : '',
        ratio: Number.isFinite(Number(info?.ratio)) ? Number(info.ratio) : null,
      }));
  }

  /**
   * 指定分组的模型候选（/api/pricing 声明，未验证）。
   * 返回每个型号的可用协议与被排除的声明端点（含原因）。
   */
  async function readModelCandidates(group) {
    const data = extractData(await client.request('/api/pricing'));
    const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    const candidates = [];
    for (const item of list) {
      const modelName = typeof item?.model_name === 'string' ? item.model_name : typeof item?.model === 'string' ? item.model : null;
      if (!modelName) continue;
      const groups = Array.isArray(item?.enable_groups) ? item.enable_groups.map(String) : [];
      if (group && !groups.includes(group)) continue;
      const endpointTypes = Array.isArray(item?.supported_endpoint_types) ? item.supported_endpoint_types.map(String) : [];
      const apis = [];
      const unsupported = [];
      for (const type of endpointTypes) {
        const api = ENDPOINT_TYPE_TO_API[type];
        if (api) {
          if (!apis.includes(api)) apis.push(api);
        } else if (!unsupported.includes(type)) {
          unsupported.push(type);
        }
      }
      candidates.push({ modelName, apis, unsupported, declaredOnly: true });
    }
    candidates.sort((a, b) => a.modelName.localeCompare(b.modelName));
    return candidates;
  }

  /**
   * 创建令牌（一次派发）。body 与站点原表单一致；额度/期限沿用户确认值。
   * unlimited 额度/永久期限是站点默认口径，不默默放宽。
   */
  async function createToken({ tokenName, group, budgetMode = 'unlimited', budgetUsd = null, expiryMode = 'never', expiryDays = null }) {
    const unlimited = budgetMode !== 'usd';
    const body = {
      name: tokenName,
      group,
      expired_time: expiryMode === 'days' && Number(expiryDays) > 0
        ? Math.floor(now() / 1000) + Math.floor(Number(expiryDays) * 86400)
        : -1,
      unlimited_quota: unlimited,
      remain_quota: unlimited ? 0 : Math.max(1, Math.round(Number(budgetUsd) * QUOTA_PER_USD)),
      model_limits_enabled: false,
      model_limits: '',
    };
    const response = await client.request('/api/token/', { method: 'POST', body });
    // 上游：成功只回 success/message，不回 id。只有「服务端明确说不」（success:false
    // 且非 5xx）才算 CREATE_REJECTED；5xx/网络断按结果不明交查证，不重发。
    if (response.status === 401) throw apiError('LOGIN_REQUIRED', '站点要求重新登录');
    const payload = response.data;
    if (payload && typeof payload === 'object' && payload.success === false && response.status < 500) {
      throw apiError('CREATE_REJECTED', `站点拒绝创建令牌${typeof payload.message === 'string' ? `：${payload.message.slice(0, 200)}` : ''}`);
    }
    if (!response.ok) throw apiError('CREATE_OUTCOME_UNKNOWN', `站点返回 ${response.status}`);
    return { dispatched: true };
  }

  function normalizeTokenList(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.records)) return data.records;
    return [];
  }

  /** 精确回查：唯一名全等匹配；查 search，再兜底翻列表页。 */
  async function findTokensByExactName(tokenName) {
    const out = [];
    try {
      const search = await client.request('/api/token/search', { query: { keyword: tokenName } });
      if (search.ok) {
        for (const item of normalizeTokenList(search.data?.data ?? search.data)) {
          if (item?.name === tokenName) out.push(item);
        }
        if (out.length) return out;
      }
    } catch (error) {
      if (error?.code === 'PATH_NOT_ALLOWED' || error?.code === 'STALE') throw error;
      // search 不可用/其他失败 → 落到列表翻页，不据此判 absent
    }
    for (let page = 1; page <= 5; page += 1) {
      const list = await client.request('/api/token/', { query: { p: page, size: 100 } });
      if (!list.ok) break;
      const items = normalizeTokenList(list.data?.data ?? list.data);
      for (const item of items) {
        if (item?.name === tokenName) out.push(item);
      }
      const total = Number(list.data?.data?.total ?? items.length);
      if (page * 100 >= total || items.length === 0) break;
    }
    return out;
  }

  /**
   * 查证本次创建：one-owned-token | absent-proven | unknown | ambiguous。
   * 归属核验＝名称全等＋组一致＋账号一致＋创建窗口。
   */
  async function reconcileCreatedToken({ tokenName, group, userId, createdAfterMs }) {
    const matches = await findTokensByExactName(tokenName);
    if (matches.length === 0) return { status: 'absent-proven' };
    if (matches.length > 1) return { status: 'ambiguous', matches: matches.length };
    const token = matches[0];
    const id = Number(token.id);
    if (!Number.isInteger(id) || id <= 0) return { status: 'unknown' };
    if (group && token.group && token.group !== group) return { status: 'unknown' };
    if (userId != null && token.user_id != null && String(token.user_id) !== String(userId)) {
      return { status: 'unknown' };
    }
    const createdMs = Number(token.created_time);
    if (Number.isFinite(createdMs) && createdAfterMs != null) {
      const createdSec = createdMs > 1e12 ? Math.floor(createdMs / 1000) : createdMs; // 站点可能存秒或毫秒
      if (createdSec * 1000 + 60000 < createdAfterMs) return { status: 'unknown' };
    }
    return { status: 'one-owned-token', token: { id, name: token.name, group: token.group ?? null } };
  }

  /** 专用读 Key：只请求本次精确 id；完整 Key 只回主进程内存。 */
  async function readCreatedKey(tokenId) {
    const data = extractData(await client.request(`/api/token/${tokenId}/key`, { method: 'POST' }));
    const raw = typeof data?.key === 'string' ? data.key.trim() : '';
    if (!raw || raw.length > 512 || /[\s\u0000-\u001f]/.test(raw)) {
      throw apiError('KEY_INVALID', '站点返回的 Key 格式不对');
    }
    const key = raw.startsWith('sk-') ? raw : `sk-${raw}`; // vvcode 前端行为：无前缀时补 sk-
    return key;
  }

  /** 撤销本次令牌：404/登录失效不能混作删除成功。 */
  async function revokeToken(tokenId) {
    const response = await client.request(`/api/token/${tokenId}`, { method: 'DELETE' });
    const payload = response.data;
    if (response.status === 404) return { status: 'not-found' };
    if (response.status === 401) return { status: 'login-required' };
    if (payload?.success === false) return { status: 'unknown' };
    if (!response.ok) return { status: 'unknown' };
    return { status: 'revoked-proven' };
  }

  return {
    detectSite,
    verifyIdentity,
    readAuthorizedGroups,
    readModelCandidates,
    createToken,
    reconcileCreatedToken,
    readCreatedKey,
    revokeToken,
    dispose: () => client.dispose(),
  };
}
