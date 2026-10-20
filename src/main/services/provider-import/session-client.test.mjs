import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuthWitness, createSessionClient, panelPathAllowed } from './session-client.mjs';

function fakeSession({ respond }) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return respond({ url: String(url), init });
    },
  };
}

const okJson = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test('路径白名单：面板限定动作可过，越界一律拒绝', () => {
  assert.equal(panelPathAllowed('/api/user/self', 'GET'), true);
  assert.equal(panelPathAllowed('/api/user/self/groups', 'GET'), true);
  assert.equal(panelPathAllowed('/api/pricing', 'GET'), true);
  assert.equal(panelPathAllowed('/api/token/', 'POST'), true);
  assert.equal(panelPathAllowed('/api/token/123', 'DELETE'), true);
  assert.equal(panelPathAllowed('/api/token/123/key', 'POST'), true);
  assert.equal(panelPathAllowed('/api/token/search', 'GET'), true);
  assert.equal(panelPathAllowed('/api/token/123', 'POST'), false, '不允许改令牌');
  assert.equal(panelPathAllowed('/api/user/login', 'POST'), false, '不代发登录');
  assert.equal(panelPathAllowed('/api/channel/', 'GET'), false, '管理上游越界');
  assert.equal(panelPathAllowed('/v1/chat/completions', 'POST'), false, '推理不经面板通道');
});

test('client：白名单外的请求直接抛错（不发网络）；见证头被带上；禁重定向', async () => {
  const session = fakeSession({ respond: () => okJson({ success: true, data: {} }) });
  const witness = { get: () => ({ authorization: 'Bearer jwt-x', newApiUser: '42', at: 1 }) };
  const client = createSessionClient({ session, siteOrigin: 'https://vvcode.top', witness });

  await client.request('/api/user/self');
  const call = session.calls[0];
  assert.equal(call.url, 'https://vvcode.top/api/user/self');
  assert.equal(call.init.headers.Authorization, 'Bearer jwt-x');
  assert.equal(call.init.headers['New-Api-User'], '42');
  assert.equal(call.init.redirect, 'error');

  await assert.rejects(() => client.request('/api/other/thing'), (error) => error.code === 'PATH_NOT_ALLOWED');
  assert.equal(session.calls.length, 1, '越界请求没有发出去');

  const withQuery = await client.request('/api/token/search', { query: { keyword: 'Hemi-1' } });
  assert.equal(session.calls[1].url.includes('keyword=Hemi-1'), true);
  assert.equal(withQuery.ok, true);
});

test('非 JSON/超大响应 → PROTOCOL；网络失败 → NETWORK', async () => {
  const witness = { get: () => ({ authorization: null, newApiUser: null, at: 0 }) };
  const html = createSessionClient({
    session: fakeSession({ respond: () => ({ ok: true, status: 200, text: async () => '<html />' }) }),
    siteOrigin: 'https://s', witness,
  });
  await assert.rejects(() => html.request('/api/user/self'), (error) => error.code === 'PROTOCOL');

  const net = createSessionClient({
    session: fakeSession({ respond: async () => { throw new Error('econnreset'); } }),
    siteOrigin: 'https://s', witness,
  });
  await assert.rejects(() => net.request('/api/user/self'), (error) => error.code === 'NETWORK');
});

test('auth witness：捕获本站点管理请求的 Authorization/New-Api-User，不改写请求头', async () => {
  const listeners = {};
  const webRequest = {
    onBeforeSendHeaders(filter, listener) {
      if (filter === null) {
        listeners.main = null;
        return;
      }
      listeners.filter = filter;
      listeners.main = listener;
    },
  };
  const witness = createAuthWitness({ webRequest, siteOrigin: 'https://vvcode.top' });
  assert.deepEqual(listeners.filter.urls, ['https://vvcode.top/api/*']);

  const emit = (headers) => new Promise((resolve) => {
    listeners.main({ requestHeaders: headers, resourceType: 'xhr' }, (response) => resolve(response));
  });
  let response = await emit({ Authorization: 'Bearer jwt-1' });
  assert.deepEqual(response.requestHeaders, { Authorization: 'Bearer jwt-1' }, '不改写');
  await emit({ 'New-Api-User': '42' });
  const captured = witness.get();
  assert.equal(captured.authorization, 'Bearer jwt-1');
  assert.equal(captured.newApiUser, '42');

  const updated = await witness.waitForUpdate(500, async () => {
    await emit({ Authorization: 'Bearer jwt-2' });
  });
  assert.equal(updated.authorization, 'Bearer jwt-2');

  witness.dispose();
});
