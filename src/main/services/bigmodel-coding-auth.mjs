import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Protocol references: Z.ai's published CLI OAuth and project access token APIs.
// Hemi owns this implementation; no ZCode runtime or proxy is bundled.
export const ZCODE_ORIGIN = 'https://zcode.z.ai';
export const ZCODE_VERSION = '3.16.3';
export const BIGMODEL_ORIGIN = 'https://bigmodel.cn';
const KEY_NAME = 'hemi-coding-plan';
const loginRequired = () => new Error('GLM 编程套餐登录已失效，请重新登录。');
const validText = value => typeof value === 'string' && value.trim().length > 0;

/** Pi holds a login reference; the signed transport owns short-lived tokens.
 * Legacy logins derive the same reference across project-token refreshes. */
export function codingAuthKey(credential) {
  return `hemi-bigmodel-${createHash('sha256').update(JSON.stringify([
    credential.authSessionId, credential.refresh, credential.zcodeToken, credential.deviceId,
    credential.organizationId, credential.projectId, credential.apiKeyId,
  ])).digest('hex')}`;
}

export function tokenClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}

/** Responses may carry credentials: only controlled messages leave this module. */
export async function codingJson(fetchImpl, url, { signal, stage = '服务请求', ...init } = {}) {
  signal?.throwIfAborted();
  try {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    if (response.status === 401 || response.status === 403) throw loginRequired();
    if (!response.ok) throw new Error(`GLM 编程套餐${stage}失败（HTTP ${response.status}），请稍后重试。`);
    const body = await response.json();
    if (![0, 200, '0', '200'].includes(body?.code)) throw new Error('GLM 编程套餐返回了无效结果，请稍后重试。');
    return body.data;
  } catch (error) {
    signal?.throwIfAborted();
    if (/^GLM 编程套餐/.test(error?.message)) throw error;
    throw new Error('GLM 编程套餐连接失败，请检查网络后重试。');
  }
}

async function projectCredential(fetchImpl, credential, signal) {
  const path = `${BIGMODEL_ORIGIN}/api/biz/v1/organization/${encodeURIComponent(credential.organizationId)}/projects/${encodeURIComponent(credential.projectId)}/api_keys/${encodeURIComponent(credential.apiKeyId)}/access_tokens`;
  const data = await codingJson(fetchImpl, path, {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${credential.refresh}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientType: 'zcode', clientVersion: ZCODE_VERSION }),
  });
  const claims = tokenClaims(data?.accessToken ?? '');
  const expires = Math.min(Number(data?.expiresAt) * 1000, Date.now() + Number(data?.expiresIn) * 1000, Number(claims.exp) * 1000);
  if (data?.enable === false || data?.enabled === false) throw new Error('GLM 编程套餐暂未开放项目令牌，请稍后重试。');
  if (!validText(data?.accessToken) || claims.token_use !== 'project_access' || claims.api_key !== credential.apiKeyId || !Number.isFinite(expires) || expires <= Date.now()) {
    throw new Error('GLM 编程套餐项目令牌无效，请重新登录。');
  }
  return { ...credential, access: data.accessToken, expires: expires - 120000 };
}

async function locateProject(fetchImpl, loginToken, signal) {
  const headers = { Authorization: loginToken, 'Content-Type': 'application/json' };
  const data = await codingJson(fetchImpl, `${BIGMODEL_ORIGIN}/api/biz/customer/getCustomerInfo`, { headers, signal });
  const organizations = (Array.isArray(data?.organizations) ? data.organizations : []).map(org => ({ ...org,
    projects: (Array.isArray(org.projects) ? org.projects : []).filter(project => validText(project.projectId) && String(project.projectType) !== '2'),
  })).filter(org => validText(org.organizationId) && org.projects.length);
  const org = organizations.find(item => item.organizationName?.includes('默认机构')) ?? organizations[0];
  const project = org?.projects.find(item => item.projectName?.includes('默认项目')) ?? org?.projects[0];
  if (!project) throw new Error('GLM 编程套餐没有可用的个人项目，请检查账号。');
  const listUrl = `${BIGMODEL_ORIGIN}/api/biz/v1/organization/${encodeURIComponent(org.organizationId)}/projects/${encodeURIComponent(project.projectId)}/api_keys`;
  const keys = await codingJson(fetchImpl, listUrl, { headers, signal });
  if (!Array.isArray(keys)) throw new Error('GLM 编程套餐项目目录无效，请稍后重试。');
  // A dedicated account key identifies Hemi; its secret is never requested.
  const key = keys.find(item => item?.name === KEY_NAME) ?? await codingJson(fetchImpl, listUrl, {
    method: 'POST', headers, signal, body: JSON.stringify({ name: KEY_NAME, usageScene: 1 }),
  });
  if (!validText(key?.apiKey)) throw new Error('GLM 编程套餐项目标识无效，请重新登录。');
  return { organizationId: org.organizationId, projectId: project.projectId, apiKeyId: key.apiKey };
}

export function bigModelCodingAuth({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  return {
    name: 'GLM Coding Plan（BigModel）', isSubscription: true,
    async login(interaction, options) {
      const signal = interaction.signal;
      const pollToken = randomBytes(32).toString('hex');
      const headers = { Authorization: `Bearer ${pollToken}`, 'Content-Type': 'application/json' };
      const flow = await codingJson(fetchImpl, `${ZCODE_ORIGIN}/api/v1/oauth/cli/init`, { method: 'POST', headers, signal, body: JSON.stringify({ provider: 'bigmodel' }) });
      if (!validText(flow?.flow_id) || !validText(flow?.authorize_url) || !Number.isFinite(flow?.expires_at) || !Number.isFinite(flow?.poll_interval_sec) || flow.poll_interval_sec < 1) throw new Error('GLM 编程套餐授权信息无效，请重新登录。');
      const url = new URL(flow.authorize_url);
      if (url.protocol !== 'https:' || url.username || url.password || !['bigmodel.cn', 'www.bigmodel.cn'].includes(url.hostname)) throw new Error('GLM 编程套餐授权地址无效。');
      const redirect = new URL('/app/oauth/login', ZCODE_ORIGIN);
      redirect.search = new URLSearchParams({ redirect: 'zcode://oauth/callback', app_version: ZCODE_VERSION });
      url.searchParams.set('redirect', redirect.href);
      interaction.notify({ type: 'auth_url', url: url.href });
      const deadline = Math.min(flow.expires_at * 1000, Date.now() + 300000);
      for (;;) {
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw new Error('GLM 编程套餐授权已超时，请重新登录。');
        let result;
        try {
          const response = await fetchImpl(`${ZCODE_ORIGIN}/api/v1/oauth/cli/poll/${encodeURIComponent(flow.flow_id)}`, { headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
          if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) throw loginRequired();
          if (response.ok) {
            const envelope = await response.json().catch(() => null);
            if (envelope && typeof envelope.code === 'number') {
              if (envelope.code !== 0) throw loginRequired();
              result = envelope.data;
              if (!['pending', 'ready'].includes(result?.status)) throw loginRequired();
            }
          }
        } catch (error) {
          signal.throwIfAborted();
          if (/^GLM 编程套餐/.test(error?.message)) throw error;
        }
        if (result?.status === 'ready') {
          const loginToken = result.bigmodel?.access_token;
          if (!validText(loginToken) || !validText(result.token)) throw new Error('GLM 编程套餐授权凭据无效，请重新登录。');
          interaction.notify({ type: 'progress', message: '正在获取编程套餐模型' });
          const location = await locateProject(fetchImpl, loginToken, signal);
          // Pi's refresh field holds the account authorization used to renew the
          // short-lived project token, rather than an invented OAuth refresh token.
          return projectCredential(fetchImpl, { type: 'oauth', authSessionId: randomUUID(), refresh: loginToken, zcodeToken: result.token,
            deviceId: await options.getDeviceId(), ...location }, signal);
        }
        await delay(Math.min(flow.poll_interval_sec * 1000, Math.max(1, deadline - Date.now())), undefined, { signal });
      }
    },
    async refresh(credential, signal) { return projectCredential(fetchImpl, credential, signal); },
    async toAuth(credential) { return { apiKey: codingAuthKey(credential) }; },
  };
}
