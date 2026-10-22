// 047 专用登录桥：只和当前站点顶层 preload 通话，不向网站暴露任何 Hemi API。
const LOAD = 'hemi-provider-login:load';
const CAPTURE = 'hemi-provider-login:submitted';

async function hasLoginForm(contents) {
  let timer;
  try {
    return await Promise.race([
      contents.executeJavaScript(`Boolean([...document.querySelectorAll('input[type="password"]')].some(el => el.getClientRects().length > 0))`),
      new Promise((resolve) => { timer = setTimeout(() => resolve(true), 2000); }),
    ]);
  } catch { return true; }
  finally { clearTimeout(timer); }
}

export function createLoginMemory({ contents, session, siteOrigin, store, onError = () => {} }) {
  let disposed = false;
  let pending = null;
  let cookieWrites = Promise.resolve();
  const report = () => onError('账号密码或登录状态未能加密保存，请检查本机存储权限');
  function trusted(event) {
    try {
      return !disposed && event.sender === contents && event.senderFrame === contents.mainFrame
        && new URL(event.senderFrame.url).origin === siteOrigin;
    } catch { return false; }
  }
  function capture(event, value) {
    if (!trusted(event) || typeof value?.username !== 'string' || typeof value?.password !== 'string') return;
    const username = value.username.trim();
    if (!username || username.length > 512 || !value.password || value.password.length > 4096) return;
    pending = { username, password: value.password };
  }
  async function load(event) {
    if (!trusted(event)) return null;
    try {
      const payload = await store.read(siteOrigin);
      if (!trusted(event)) return null;
      const value = payload.credentials;
      if (!value || typeof value.username !== 'string' || typeof value.password !== 'string') return null;
      return { origin: siteOrigin, username: value.username, password: value.password };
    } catch { report(); return null; }
  }

  // 专用 profile 中仅备份当前站点的 session Cookie，避免无过期时间的 Cookie 在退出时丢失。
  function siteCookie(cookie) {
    const host = new URL(siteOrigin).hostname;
    const domain = String(cookie.domain ?? '').replace(/^\./, '');
    return cookie.session === true && (host === domain || host.endsWith(`.${domain}`));
  }
  function persistCookies() {
    if (!session.cookies?.get) return cookieWrites;
    cookieWrites = cookieWrites.then(async () => {
      const cookies = (await session.cookies.get({})).filter(siteCookie);
      await store.update(siteOrigin, { sessionCookies: cookies });
    }).catch(report);
    return cookieWrites;
  }
  const changed = () => { if (!disposed) void persistCookies(); };
  contents.ipc?.handle(LOAD, load);
  contents.ipc?.on(CAPTURE, capture);

  return {
    async restore() {
      try {
        const saved = await store.read(siteOrigin);
        if (session.cookies?.set) {
          const existing = await session.cookies.get({});
          for (const cookie of saved.sessionCookies ?? []) {
            if (!siteCookie(cookie) || existing.some((item) => item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path)) continue;
            const details = {
              url: `${siteOrigin}${cookie.path || '/'}`,
              name: cookie.name, value: cookie.value, path: cookie.path || '/',
              secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
              ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
            };
            await session.cookies.set(details);
          }
        }
      } catch { report(); }
      session.cookies?.on?.('changed', changed);
    },
    async confirmLogin(identity) {
      const candidate = pending;
      pending = null;
      const names = [identity.username, identity.email].filter((value) => typeof value === 'string').map((value) => value.trim().toLowerCase());
      // 身份有效仍不足以证明刚提交的密码成功（可能残留旧 Cookie）；登录表单必须已离开。
      const loginFormVisible = candidate && await hasLoginForm(contents);
      let sameOrigin = false;
      try { sameOrigin = !disposed && new URL(contents.mainFrame.url).origin === siteOrigin; } catch { /* 已关闭 */ }
      if (candidate && sameOrigin && !loginFormVisible && names.includes(candidate.username.toLowerCase())) {
        try { await store.update(siteOrigin, { credentials: { ...candidate, userId: String(identity.userId) } }); }
        catch { report(); }
      }
      await this.flush();
    },
    async flush() {
      await persistCookies();
      try {
        session.flushStorageData?.();
        await session.cookies?.flushStore?.();
      } catch { report(); }
      await store.flush();
    },
    async dispose() {
      disposed = true;
      pending = null;
      contents.ipc?.removeHandler(LOAD);
      contents.ipc?.removeListener(CAPTURE, capture);
      session.cookies?.removeListener?.('changed', changed);
      await this.flush();
    },
  };
}
