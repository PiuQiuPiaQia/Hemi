// 047 真机验证用假 New API 站点（vvcode 口径）：Cookie＋New-Api-User 认证、
// 创建不回 id、/api/token/:id/key 返回无前缀 Key。可注入故障验证恢复路径。
// 只绑 127.0.0.1，只服务离线验证（http 站点已对自建场景放行，无需测试开关）。
import http from 'node:http';

export const TEST_USER = { username: 'demo', password: 'hemi-test-pass', id: 7 };

export function startMockSite({ port = 0, host = '127.0.0.1' } = {}) {
  const state = {
    tokens: [],
    nextId: 100,
    createCalls: 0,
    keyReads: 0,
    deletes: [],
    loginCalls: 0,
    password: TEST_USER.password,
    pages: new Map(), // 登录记忆验收用站点页面变体；不改变生产装配。
    fault: null, // 'create-network' | 'key-read' | 'probe-anthropic' | 'login-reject'
    sessions: new Set(),
  };

  const json = (res, body, status = 200, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const authed = (req, headers) => {
    const cookie = String(req.headers.cookie ?? '');
    const match = cookie.match(/(?:^|;\s*)session=([\w-]+)/);
    const sid = match?.[1] ?? '';
    const newApiUser = String(req.headers['new-api-user'] ?? '');
    return state.sessions.has(sid) && newApiUser === sid.replace(/^s/, '');
  };
  /** 页面路由只看 cookie（真实站点 HTML shell 不做 API 头校验；API 数据由页面 JS 带 New-Api-User 拉）。 */
  const hasCookieSession = (req) => {
    const cookie = String(req.headers.cookie ?? '');
    const sid = cookie.match(/(?:^|;\s*)session=([\w-]+)/)?.[1] ?? '';
    return state.sessions.has(sid);
  };

  const page = (title, script) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>${script ? `<script>${script}</script>` : ''}</body></html>`;

  const LOGIN_PAGE = page('MockAPI 登录', `
    const form = document.createElement('form');
    form.id = 'login-form';
    form.innerHTML = '<input id="username" name="username" autocomplete="username">'
      + '<input id="password" name="password" type="password" autocomplete="current-password">'
      + '<button id="submit-btn" type="submit">登录</button>';
    document.body.appendChild(form);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      document.body.dataset.loginStage = 'clicked';
      try {
        const reply = await fetch('/api/user/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.value, password: password.value }),
        });
        document.body.dataset.loginStage = 'fetched:' + reply.status;
        const payload = await reply.json();
        if (payload.success) {
          localStorage.setItem('uid', String(payload.data.id));
          document.body.dataset.loginStage = 'navigating';
          location.href = '/console/token';
        } else {
          document.body.dataset.loginError = payload.message ?? 'failed';
        }
      } catch (error) {
        document.body.dataset.loginError = 'fetch-threw:' + (error && error.message);
      }
    });
  `);

  const CONSOLE_PAGE = page('MockAPI 令牌', `
    const uid = localStorage.getItem('uid') || '';
    window.__panelCalls = [];
    async function call(path, init) {
      const reply = await fetch(path, { credentials: 'same-origin', headers: { 'New-Api-User': uid }, ...init });
      return reply.json();
    }
    (async () => {
      const self = await call('/api/user/self');
      document.body.dataset.self = JSON.stringify(self);
      if (self.success) {
        const groups = await call('/api/user/self/groups');
        document.body.dataset.groups = JSON.stringify(groups);
        const tokens = await call('/api/token/?p=1&size=100');
        document.body.dataset.tokens = JSON.stringify(tokens);
        document.body.dataset.booted = '1';
      }
    })();
  `);

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    try {
      if (req.method === 'GET' && state.pages.has(path)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(state.pages.get(path));
        return;
      }
      if (req.method === 'GET' && (path === '/' || path === '/console/token' || path === '/console')) {
        const needsLogin = !hasCookieSession(req);
        // 未登录的 console 访问跳登录页；登录后 console/token 页自发管理请求（喂认证见证）。
        if (needsLogin && path !== '/') {
          res.writeHead(302, { Location: '/sign-in' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(needsLogin ? LOGIN_PAGE : CONSOLE_PAGE);
        return;
      }
      if (req.method === 'GET' && path === '/sign-in') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(LOGIN_PAGE);
        return;
      }
      if (req.method === 'POST' && path === '/api/user/login') {
        state.loginCalls += 1;
        if (state.fault === 'login-reject') return json(res, { success: false, message: '站点维护中' }, 503);
        const body = JSON.parse(await readBody(req) || '{}');
        if (body.username !== TEST_USER.username || body.password !== state.password) {
          return json(res, { success: false, message: '用户名或密码错误' });
        }
        const sid = `s${TEST_USER.id}`;
        state.sessions.add(sid);
        return json(res, { success: true, message: '', data: { id: TEST_USER.id, username: TEST_USER.username } }, 200, {
          'Set-Cookie': `session=${sid}; Path=/; HttpOnly; SameSite=Lax`,
        });
      }
      if (req.method === 'GET' && path === '/api/status') {
        return json(res, { success: true, data: { system_name: 'MockAPI', version: '', server_address: `http://${req.headers.host}` } });
      }
      if (!path.startsWith('/api/') && !path.startsWith('/v1/')) return json(res, { success: false }, 404);
      if (path.startsWith('/api/') && !authed(req, req.headers)) {
        return json(res, { success: false, message: '无权访问，请先登录' }, 401);
      }
      if (req.method === 'GET' && path === '/api/user/self') {
        return json(res, { success: true, data: { id: TEST_USER.id, username: TEST_USER.username } });
      }
      if (req.method === 'GET' && path === '/api/user/self/groups') {
        return json(res, { success: true, data: {
          default: { ratio: 1, desc: '默认分组' },
          vip: { ratio: 0.8, desc: '' },
        } });
      }
      if (req.method === 'GET' && path === '/api/pricing') {
        return json(res, { success: true, data: [
          { model_name: 'mock-gpt-5.2', enable_groups: ['default'], supported_endpoint_types: ['openai'] },
          { model_name: 'mock-claude-opus-4.6', enable_groups: ['default'], supported_endpoint_types: ['anthropic', 'openai'] },
          { model_name: 'mock-gemini-3-pro', enable_groups: ['default'], supported_endpoint_types: ['gemini'] },
          { model_name: 'mock-vip-only', enable_groups: ['vip'], supported_endpoint_types: ['openai'] },
        ] });
      }
      if (req.method === 'POST' && path === '/api/token/') {
        state.createCalls += 1;
        const body = JSON.parse(await readBody(req) || '{}');
        state.nextId += 1;
        state.tokens.push({
          id: state.nextId, name: String(body.name ?? ''), group: String(body.group ?? ''),
          user_id: TEST_USER.id, created_time: Math.floor(Date.now() / 1000),
          key: `mock-${state.nextId}secret`, revoked: false,
        });
        if (state.fault === 'create-network') {
          // 服务端已受理，但响应在回程丢失（RST）：客户端不知道结果。
          res.socket?.destroy();
          return;
        }
        return json(res, { success: true, message: '' });
      }
      if (req.method === 'GET' && path === '/api/token/search') {
        const keyword = url.searchParams.get('keyword') ?? '';
        return json(res, { success: true, data: { items: state.tokens.filter((token) => token.name === keyword && !token.revoked), total: 0 } });
      }
      if (req.method === 'GET' && path === '/api/token/') {
        return json(res, { success: true, data: { items: state.tokens.filter((token) => !token.revoked), total: state.tokens.filter((token) => !token.revoked).length } });
      }
      const keyMatch = path.match(/^\/api\/token\/(\d+)\/key$/);
      if (req.method === 'POST' && keyMatch) {
        const token = state.tokens.find((item) => item.id === Number(keyMatch[1]) && !item.revoked);
        if (!token) return json(res, { success: false }, 404);
        state.keyReads += 1;
        if (state.fault === 'key-read') return json(res, { success: false, message: '站点内部错误' }, 500);
        return json(res, { success: true, data: { key: token.key } });
      }
      const delMatch = path.match(/^\/api\/token\/(\d+)$/);
      if (req.method === 'DELETE' && delMatch) {
        const token = state.tokens.find((item) => item.id === Number(delMatch[1]));
        if (!token) return json(res, { success: false }, 404);
        token.revoked = true;
        state.deletes.push(token.id);
        return json(res, { success: true });
      }
      // 推理端（仅模型 Key；与面板 Cookie 分离）
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const apiKey = bearer || String(req.headers['x-api-key'] ?? '');
      const token = state.tokens.find((item) => !item.revoked && `sk-${item.key}` === apiKey);
      if (!token) return json(res, { error: { message: '无效的令牌' } }, 401);
      // vip 组专属型号对有效 Key 也可推理（组→型号映射真实验证用）。
      const visible = ['mock-gpt-5.2', 'mock-claude-opus-4.6', 'mock-vip-only'];
      if (req.method === 'GET' && path === '/v1/models') {
        return json(res, { data: visible.map((id) => ({ id, supported_endpoint_types: ['openai', 'anthropic'] })) });
      }
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        if (state.fault === 'probe-hang') await new Promise(() => {}); // 强杀演练：验证挂住，进程被杀
        const body = JSON.parse(await readBody(req) || '{}');
        if (!visible.includes(body.model)) return json(res, { error: { message: '无可用渠道' } }, 404);
        return json(res, { object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] });
      }
      if (req.method === 'POST' && path === '/v1/messages') {
        if (state.fault === 'probe-anthropic') return json(res, { type: 'error', error: { message: 'overloaded' } }, 500);
        const body = JSON.parse(await readBody(req) || '{}');
        if (!visible.includes(body.model)) return json(res, { type: 'error', error: { message: '无可用渠道' } }, 404);
        return json(res, { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn' });
      }
      return json(res, { success: false }, 404);
    } catch (error) {
      json(res, { success: false, message: error?.message ?? 'error' }, 500);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        origin: `http://${host}:${address.port}`,
        server,
        state,
        async close() {
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const site = await startMockSite({ port: Number(process.env.PORT ?? 8788) });
  console.log(`[mock-newapi] ${site.origin} （账号 ${TEST_USER.username} / ${TEST_USER.password}）`);
}
