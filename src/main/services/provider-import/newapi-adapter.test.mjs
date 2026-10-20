import assert from 'node:assert/strict';
import test from 'node:test';

import { createNewApiAdapter, QUOTA_PER_USD } from './newapi-adapter.mjs';

function clientHarness({ routes }) {
  const calls = [];
  const session = {
    fetch: async (url, init) => {
      const parsed = new URL(url);
      const key = `${init.method} ${parsed.pathname}`;
      calls.push({ key, query: parsed.searchParams, init });
      const handler = routes[key] ?? routes[parsed.pathname];
      if (!handler) return { ok: false, status: 404, text: async () => JSON.stringify({ success: false }) };
      const body = handler(parsed, init);
      return { ok: body.status ? body.status < 400 : true, status: body.status ?? 200, text: async () => JSON.stringify(body.json) };
    },
  };
  const witness = { get: () => ({ authorization: 'Bearer j', newApiUser: '7', at: 1 }) };
  return { calls, adapter: createNewApiAdapter({ session, siteOrigin: 'https://vvcode.top', witness, now: () => 1700000000000 }) };
}

test('身份/分组/pricing 解析：self→userId；groups map；pricing 按组过滤＋协议映射＋排除声明', async () => {
  const { adapter } = clientHarness({
    routes: {
      'GET /api/user/self': () => ({ json: { success: true, data: { id: 7, username: 'demo' } } }),
      'GET /api/user/self/groups': () => ({ json: { success: true, data: { default: { ratio: 1, desc: '默认' }, vip: { ratio: 0.8 } } } }),
      'GET /api/pricing': () => ({ json: { success: true, data: [
        { model_name: 'gpt-5.2', enable_groups: ['default'], supported_endpoint_types: ['openai'] },
        { model_name: 'claude-opus-4.6', enable_groups: ['default', 'vip'], supported_endpoint_types: ['anthropic', 'openai'] },
        { model_name: 'gemini-3-pro', enable_groups: ['default'], supported_endpoint_types: ['gemini'] },
        { model_name: 'vip-only', enable_groups: ['vip'], supported_endpoint_types: ['openai'] },
      ] } }),
    },
  });
  assert.deepEqual(await adapter.verifyIdentity(), { userId: '7', username: 'demo' });
  const groups = await adapter.readAuthorizedGroups();
  assert.deepEqual(groups.map((group) => group.name), ['default', 'vip']);

  const candidates = await adapter.readModelCandidates('default');
  assert.deepEqual(candidates.map((item) => item.modelName), ['claude-opus-4.6', 'gemini-3-pro', 'gpt-5.2']);
  assert.deepEqual(candidates[0].apis, ['anthropic-messages', 'openai-completions']);
  assert.deepEqual(candidates[1].apis, []);
  assert.deepEqual(candidates[1].unsupported, ['gemini'], '未支持协议如实列出');
});

test('创建 body：额度/期限换算沿用户确认值；成功不返回 id 也不报错', async () => {
  const { calls, adapter } = clientHarness({
    routes: { 'POST /api/token/': () => ({ json: { success: true, message: '' } }) },
  });
  await adapter.createToken({ tokenName: 'Hemi-1', group: 'vip', budgetMode: 'usd', budgetUsd: 10, expiryMode: 'days', expiryDays: 30 });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.name, 'Hemi-1');
  assert.equal(body.group, 'vip');
  assert.equal(body.unlimited_quota, false);
  assert.equal(body.remain_quota, 10 * QUOTA_PER_USD);
  assert.equal(body.expired_time, Math.floor(1700000000000 / 1000) + 30 * 86400);
  assert.equal(body.model_limits_enabled, false);

  await adapter.createToken({ tokenName: 'Hemi-2', group: 'default' });
  const body2 = JSON.parse(calls[1].init.body);
  assert.equal(body2.unlimited_quota, true, '缺省沿站点默认（不限）');
  assert.equal(body2.expired_time, -1);
});

test('站点拒绝创建 → CREATE_REJECTED；401 → LOGIN_REQUIRED', async () => {
  const rejected = clientHarness({ routes: { 'POST /api/token/': () => ({ json: { success: false, message: '额度不足' } }) } });
  await assert.rejects(() => rejected.adapter.createToken({ tokenName: 'x', group: 'default' }), (error) => error.code === 'CREATE_REJECTED');

  const unauth = clientHarness({ routes: { 'POST /api/token/': () => ({ status: 401, json: {} }) } });
  await assert.rejects(() => unauth.adapter.createToken({ tokenName: 'x', group: 'default' }), (error) => error.code === 'LOGIN_REQUIRED');
});

test('查证：唯一名命中过（组/账号/窗口核验）；多条同名 → ambiguous；search 缺席兜底列表翻页', async () => {
  const base = {
    id: 11, name: 'Hemi-20261008-a1b2', group: 'default', user_id: 7,
    created_time: Math.floor(1700000000000 / 1000),
  };
  const one = clientHarness({
    routes: {
      'GET /api/token/search': (parsed) => ({ json: { success: true, data: { items: [base, { id: 12, name: '别的' }] } } }),
    },
  });
  const found = await one.adapter.reconcileCreatedToken({ tokenName: 'Hemi-20261008-a1b2', group: 'default', userId: '7', createdAfterMs: 1700000000000 - 5000 });
  assert.equal(found.status, 'one-owned-token');
  assert.equal(found.token.id, 11);

  const two = clientHarness({
    routes: { 'GET /api/token/search': () => ({ json: { success: true, data: { items: [base, { ...base, id: 12 }] } } }) },
  });
  const ambiguous = await two.adapter.reconcileCreatedToken({ tokenName: 'Hemi-20261008-a1b2', group: 'default', userId: '7', createdAfterMs: null });
  assert.equal(ambiguous.status, 'ambiguous');

  // search 空结果 → 列表翻页兜底仍能找到
  const paged = clientHarness({
    routes: {
      'GET /api/token/search': () => ({ json: { success: true, data: { items: [] } } }),
      'GET /api/token/': (parsed) => ({ json: { success: true, data: { items: [base], total: 1 } } }),
    },
  });
  const foundViaList = await paged.adapter.reconcileCreatedToken({ tokenName: 'Hemi-20261008-a1b2', group: 'default', userId: '7', createdAfterMs: null });
  assert.equal(foundViaList.status, 'one-owned-token');

  // 归属不符（他人令牌）→ unknown
  const foreign = clientHarness({
    routes: { 'GET /api/token/search': () => ({ json: { success: true, data: { items: [{ ...base, user_id: 99 }] } } }) },
  });
  const notMine = await foreign.adapter.reconcileCreatedToken({ tokenName: 'Hemi-20261008-a1b2', group: 'default', userId: '7', createdAfterMs: null });
  assert.equal(notMine.status, 'unknown');
});

test('读 Key：补/不补 sk- 前缀；坏格式拒绝；撤销 404/401/失败区分', async () => {
  const { adapter } = clientHarness({
    routes: {
      'POST /api/token/11/key': () => ({ json: { success: true, data: { key: 'raw123' } } }),
      'POST /api/token/12/key': () => ({ json: { success: true, data: { key: 'sk-full456' } } }),
      'POST /api/token/13/key': () => ({ json: { success: true, data: { key: 'has space' } } }),
      'DELETE /api/token/21': () => ({ json: { success: true } }),
      'DELETE /api/token/22': () => ({ status: 404, json: {} }),
      'DELETE /api/token/23': () => ({ status: 401, json: {} }),
    },
  });
  assert.equal(await adapter.readCreatedKey(11), 'sk-raw123', 'vvcode 口径：无前缀补 sk-');
  assert.equal(await adapter.readCreatedKey(12), 'sk-full456');
  await assert.rejects(() => adapter.readCreatedKey(13), (error) => error.code === 'KEY_INVALID');

  assert.equal((await adapter.revokeToken(21)).status, 'revoked-proven');
  assert.equal((await adapter.revokeToken(22)).status, 'not-found', '404 不混作删除成功状态名');
  assert.equal((await adapter.revokeToken(23)).status, 'login-required');
});
