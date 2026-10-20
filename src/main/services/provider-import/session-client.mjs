// 047 New API 同会话面板客户端：Electron session 上的白名单管理请求。
//
// 站点新旧认证差异（JWT Authorization / 旧 Cookie＋New-Api-User）封装在这里：
// 凭据来自 auth witness——只见证「当前站点、已知管理路由」页面请求里的
// 两个认证头，不导出通用网络事件、不抓登录 body、不持久化 JWT/Cookie。
// 路径白名单是代码事实（self/groups/pricing/token 限定动作），不能做通用代理；
// 禁跟随重定向（Electron 文档提醒事后无法可靠核对凭据去向）。

const PANEL_ROUTES = [
  { match: /^\/api\/user\/self$/, methods: ['GET'] },
  { match: /^\/api\/status$/, methods: ['GET'] },
  { match: /^\/api\/user\/self\/groups$/, methods: ['GET'] },
  { match: /^\/api\/pricing$/, methods: ['GET'] },
  { match: /^\/api\/token\/$/, methods: ['GET', 'POST'] },
  { match: /^\/api\/token\/search$/, methods: ['GET'] },
  { match: /^\/api\/token\/(\d+)$/, methods: ['GET', 'DELETE'] },
  { match: /^\/api\/token\/(\d+)\/key$/, methods: ['POST'] },
];

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function panelPathAllowed(pathname, method) {
  return PANEL_ROUTES.some((route) => route.match.test(pathname) && route.methods.includes(method));
}

/**
 * 认证见证：webRequest 只过滤本站点 /api/*，取 Authorization / New-Api-User 头。
 * 头值只在主进程内存短期保存（panelAuth），不落日志/journal。
 */
export function createAuthWitness({ webRequest, siteOrigin }) {
  let witnessed = { authorization: null, newApiUser: null, at: 0 };
  const filter = { urls: [`${siteOrigin}/api/*`] };
  webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    try {
      const headers = details.requestHeaders ?? {};
      const authorization = typeof headers.Authorization === 'string' && headers.Authorization.startsWith('Bearer ')
        ? headers.Authorization
        : null;
      const newApiUser = typeof headers['New-Api-User'] === 'string' && headers['New-Api-User'].trim()
        ? headers['New-Api-User'].trim()
        : null;
      if (authorization || newApiUser) {
        witnessed = {
          authorization: authorization ?? witnessed.authorization,
          newApiUser: newApiUser ?? witnessed.newApiUser,
          at: Date.now(),
        };
      }
    } catch {
      /* 见证失败不影响页面请求 */
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  return {
    get() {
      return { ...witnessed };
    },
    /** 页面重载/续期后等新一轮认证头（登录核验用）。 */
    async waitForUpdate(timeoutMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), baselineAt = witnessed.at) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (witnessed.at > baselineAt) return this.get();
        await sleep(120);
      }
      return null;
    },
    dispose() {
      try {
        webRequest.onBeforeSendHeaders(null);
      } catch {
        /* session 可能已销毁 */
      }
    },
  };
}

/**
 * @param {{ session: { fetch: Function }, siteOrigin: string, witness: { get: () => {authorization: string|null, newApiUser: string|null, at: number}} }} deps
 */
export function createSessionClient({ session, siteOrigin, witness }) {
  let epoch = 0;
  const bumpEpoch = () => { epoch += 1; return epoch; };

  async function request(pathname, { method = 'GET', body = null, query = null } = {}) {
    const myEpoch = bumpEpoch();
    if (typeof pathname !== 'string' || pathname.startsWith('/api/') === false || pathname.includes('..')) {
      throw Object.assign(new Error('面板路径不在白名单'), { code: 'PATH_NOT_ALLOWED' });
    }
    if (!panelPathAllowed(pathname, method)) {
      throw Object.assign(new Error(`面板动作不被允许：${method} ${pathname}`), { code: 'PATH_NOT_ALLOWED' });
    }
    const auth = witness?.get?.() ?? {};
    const headers = {
      Accept: 'application/json',
      ...(auth.authorization ? { Authorization: auth.authorization } : {}),
      ...(auth.newApiUser ? { 'New-Api-User': auth.newApiUser } : {}),
      ...(body != null ? { 'Content-Type': 'application/json' } : {}),
    };
    const url = new URL(pathname, siteOrigin);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value != null) url.searchParams.set(key, String(value));
      }
    }
    let response;
    try {
      response = await session.fetch(url.toString(), {
        method,
        headers,
        ...(body != null ? { body: JSON.stringify(body) } : {}),
        credentials: 'include',
        redirect: 'error',
      });
    } catch (error) {
      if (myEpoch !== epoch) throw Object.assign(new Error('请求被后续操作取代'), { code: 'STALE' });
      throw Object.assign(new Error(`面板请求失败（${method} ${pathname}）`), { code: 'NETWORK', cause: error });
    }
    if (myEpoch !== epoch) throw Object.assign(new Error('请求被后续操作取代'), { code: 'STALE' });
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw Object.assign(new Error('面板响应过大'), { code: 'PROTOCOL' });
    let value = null;
    if (text.trim()) {
      try {
        value = JSON.parse(text);
      } catch {
        throw Object.assign(new Error('面板响应不是 JSON'), { code: 'PROTOCOL' });
      }
    }
    return { status: response.status, ok: response.ok, data: value };
  }

  return {
    request,
    bumpEpoch,
    dispose() {
      epoch += 1;
    },
  };
}
