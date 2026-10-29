// 订阅余额查询（subscription-quota）目标测试。
// 边界：真实的 createOAuthCredentials + createOAuthModels + getAuth 刷新链路，
// 只有 HTTP 对端是本文件内的受控伪服务器；GLM 响应形状取自脱敏生产 fixture
// （.visual/bigmodel-quota-large-before.json / vision-report-bigmodel-quota.md）。
// 不读取真实凭据、不打线上接口。
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOAuthCredentials } from './oauth-credentials.mjs';
import { createOAuthModels } from './oauth-models.mjs';
import { createSubscriptionQuota, redactText } from './subscription-quota.mjs';

function encryption() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    decryptString(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(-16)); return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString('utf8'); },
  };
}

const fakeJwt = payload => `hdr.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.synthetic-sig`;
// pi-ai 的 Codex 凭据解析用 atob（标准 base64）并要求嵌套 account claim；刷新回写走同一形状。
const codexRefreshJwt = accountId => `codex-refresh-hdr.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64')}.codex-refresh-sig`;

// CC Switch 证据＋2026-10-30 实测的 Codex wham/usage 形状：窗口身份=limit_window_seconds
// （18000=5 小时 / 604800=周 / 2592000=30 天，primary/secondary 位置不可信），重置 reset_at（绝对秒）优先。
const codexBody = (primary, secondary) => ({ rate_limit: { primary_window: primary, secondary_window: secondary } });
// 脱敏生产 fixture（.visual/bigmodel-quota-large-before.json 的 quota/limit 结果，数值未改动）。
const glmBody = {
  code: 200,
  data: {
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 195, remaining: 11804, percentage: 1, nextResetTime: 1792905382344 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 7844, remaining: 52155, percentage: 13, nextResetTime: 1793329338979 },
    ],
    level: 'pro',
  },
};

async function fixture(t, { clockStart = 1_800_000_000_000 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hemi-subscription-quota-'));
  const safeStorage = encryption();
  const credentials = createOAuthCredentials({ filePath: path.join(dir, 'oauth.json'), safeStorage });
  const runtime = createOAuthModels(credentials);
  const requests = [];
  // 配额路由：每条可排入多个应答；gate 支持「挂起直到放行」，供在途竞态用。
  const routes = new Map([['https://chatgpt.com/backend-api/wham/usage', []], ['https://bigmodel.cn/api/monitor/usage/quota/limit', []]]);
  const gates = new Map();
  let clock = clockStart;
  const dispatcher = async (rawUrl, init = {}) => {
    const url = String(rawUrl);
    requests.push({ url, headers: { ...init.headers } });
    const queue = routes.get(url);
    if (queue) {
      const respond = queue.shift();
      if (!respond) return new Response('synthetic: quota route exhausted', { status: 599 });
      const gate = gates.get(url);
      if (gate) await gate.wait;
      return typeof respond === 'function' ? respond(init) : respond;
    }
    if (url === 'https://auth.openai.com/oauth/token' && init.method === 'POST') {
      // Codex OAuth 刷新端点（pi-ai）：access 必须带嵌套 accountId，否则凭据解析会拒绝。
      return Response.json({ access_token: codexRefreshJwt('acct-123'), refresh_token: 'refresh-rotated', expires_in: 7200, scope: 'openid profile email offline_access', id_token: fakeJwt({ presence: true }) });
    }
    return new Response(`synthetic: unexpected route ${url}`, { status: 598 });
  };
  // SDK 的令牌刷新走 globalThis.fetch，测试里一并接管（oauth.test.mjs 同款做法）。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = dispatcher;
  const service = createSubscriptionQuota({ runtime, credentials, fetchImpl: dispatcher, now: () => clock });
  t.after(async () => { globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); });
  const respondJson = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return {
    dir, credentials, runtime, service, requests, routes, gates, respondJson,
    seed: (provider, credential) => credentials.modify(provider, async () => credential),
    advance: ms => { clock += ms; },
    openaiCredential: overrides => ({
      type: 'oauth',
      access: fakeJwt({ chatgpt_account_id: 'acct-123', exp: Math.floor((clockStart + 3600_000) / 1000) }),
      refresh: 'refresh-openai',
      expires: clockStart + 3600_000,
      accountId: 'acct-123',
      ...overrides,
    }),
    bigmodelCredential: overrides => ({
      type: 'oauth',
      authSessionId: 'sess-1',
      refresh: 'bigmodel-login-token',
      zcodeToken: fakeJwt({ exp: Math.floor((clockStart + 86400_000) / 1000) }),
      deviceId: 'device-1',
      organizationId: 'org-1', projectId: 'proj-1', apiKeyId: 'key-1',
      access: fakeJwt({ token_use: 'project_access', api_key: 'key-1', exp: Math.floor((clockStart + 18000_000) / 1000) }),
      expires: clockStart + 18000_000,
      ...overrides,
    }),
  };
}

test('unsupported：anthropic / github-copilot / 非法 id 都不发请求', async t => {
  const f = await fixture(t);
  for (const provider of ['anthropic', 'github-copilot', 'nope']) {
    const view = await f.service.view(provider);
    assert.equal(view.status, 'unsupported');
    assert.equal(view.provider, provider);
    assert.deepEqual(view.windows, []);
    assert.ok(view.message);
  }
  assert.deepEqual(f.requests, []);
});

test('signed-out：未登录直接返回，不碰网络', async t => {
  const f = await fixture(t);
  for (const provider of ['openai', 'bigmodel']) {
    const view = await f.service.view(provider);
    assert.equal(view.status, 'signed-out');
    assert.deepEqual(view.windows, []);
  }
  assert.deepEqual(f.requests, []);
});

test('openai ok：CC Switch 形状解析＋ChatGPT-Account-Id 来自 Codex 凭据的 accountId', async t => {
  const f = await fixture(t);
  await f.seed('openai', f.openaiCredential());
  f.routes.get('https://chatgpt.com/backend-api/wham/usage').push(f.respondJson(codexBody(
    { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 900 },
    { used_percent: 10.5, limit_window_seconds: 604800, reset_after_seconds: 86400 },
  )));
  const view = await f.service.view('openai');
  assert.equal(view.status, 'ok');
  assert.equal(view.windows.length, 2);
  assert.deepEqual(view.windows[0], { id: 'five-hour', label: '5 小时', remainingPercent: 75, resetsAt: 1_800_000_000_000 + 900_000 });
  assert.deepEqual(view.windows[1], { id: 'weekly', label: '本周（7 天）', remainingPercent: 89.5, resetsAt: 1_800_000_000_000 + 86_400_000 });
  const request = f.requests.at(-1);
  assert.equal(request.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.match(request.headers.authorization, /^Bearer hdr\./);
  assert.equal(request.headers['chatgpt-account-id'], 'acct-123');
  assert.equal(request.headers['user-agent'], 'codex-cli');
  // codex 只给百分比：不伪造 used/limit。
  assert.equal(view.windows[0].used, undefined);
  assert.equal(view.windows[0].limit, undefined);
});

test('openai 窗口身份按 limit_window_seconds 识别（实测 primary 可能是周窗口）', async t => {
  const f = await fixture(t);
  await f.seed('openai', f.openaiCredential());
  const usage = 'https://chatgpt.com/backend-api/wham/usage';
  // 2026-10-30 实测形状：primary＝周窗口（604800），secondary 为 null。
  f.routes.get(usage).push(f.respondJson(codexBody(
    { used_percent: 49, limit_window_seconds: 604800, reset_after_seconds: 480929, reset_at: 1793774445 },
    null,
  )));
  const view = await f.service.view('openai');
  assert.equal(view.status, 'ok');
  assert.equal(view.windows.length, 1);
  // reset_at（绝对秒）优先于 reset_after_seconds；标签按秒数判为周窗口，不按位置。
  assert.deepEqual(view.windows[0], { id: 'weekly', label: '本周（7 天）', remainingPercent: 51, resetsAt: 1793774445000 });
  f.advance(60_000);
  // 位置对调：secondary 是 5 小时窗口 → 展示顺序仍 5 小时在前。
  f.routes.get(usage).push(f.respondJson(codexBody(
    { used_percent: 80, limit_window_seconds: 604800, reset_at: 1793774445 },
    { used_percent: 20, limit_window_seconds: 18000, reset_after_seconds: 600 },
  )));
  const swapped = await f.service.view('openai', { force: true });
  assert.deepEqual(swapped.windows.map(w => w.id), ['five-hour', 'weekly']);
  assert.equal(swapped.windows[0].remainingPercent, 80);
  f.advance(60_000);
  // used_percent=0：reset 是占位值不展示；未识别的窗口秒数（如 12345）跳过不造标签。
  f.routes.get(usage).push(f.respondJson(codexBody(
    { used_percent: 0, limit_window_seconds: 604800, reset_after_seconds: 999 },
    { used_percent: 30, limit_window_seconds: 12345, reset_after_seconds: 999 },
  )));
  const zero = await f.service.view('openai', { force: true });
  assert.equal(zero.windows.length, 1);
  assert.deepEqual(zero.windows[0], { id: 'weekly', label: '本周（7 天）', remainingPercent: 100 });
});

test('缓存 TTL／并发合并／force 限频', async t => {
  const f = await fixture(t);
  await f.seed('openai', f.openaiCredential());
  const usage = 'https://chatgpt.com/backend-api/wham/usage';
  f.routes.get(usage).push(f.respondJson(codexBody({ used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 900 }, { used_percent: 10, limit_window_seconds: 604800, reset_after_seconds: 86400 })));
  const first = await f.service.view('openai');
  assert.equal(f.requests.length, 1);
  // TTL 内：非 force 走缓存。
  const cached = await f.service.view('openai');
  assert.equal(f.requests.length, 1);
  assert.equal(cached.fetchedAt, first.fetchedAt);
  // force 限频：距上次完成不足间隔，仍回缓存不重取。
  await f.service.view('openai', { force: true });
  assert.equal(f.requests.length, 1);
  // 过 TTL 且过限频：force 才真正重取。
  f.advance(60_000 + 10_000);
  f.routes.get(usage).push(f.respondJson(codexBody({ used_percent: 60, limit_window_seconds: 18000, reset_after_seconds: 900 }, { used_percent: 30, limit_window_seconds: 604800, reset_after_seconds: 86400 })));
  const refreshed = await f.service.view('openai', { force: true });
  assert.equal(f.requests.length, 2);
  assert.equal(refreshed.windows[0].remainingPercent, 40);
  // 非 force 未过新 TTL 仍走缓存。
  await f.service.view('openai');
  assert.equal(f.requests.length, 2);
  // TTL 过后并发调用合并成一次请求。
  f.advance(60_000);
  f.routes.get(usage).push(f.respondJson(codexBody({ used_percent: 70, limit_window_seconds: 18000, reset_after_seconds: 900 }, { used_percent: 35, limit_window_seconds: 604800, reset_after_seconds: 86400 })));
  const [a, b] = await Promise.all([f.service.view('openai'), f.service.view('openai')]);
  assert.equal(f.requests.length, 3);
  assert.equal(a.fetchedAt, b.fetchedAt);
  assert.equal(a.windows[0].remainingPercent, 30);
});

test('openai HTTP 错误 → unavailable（受控消息），失败短缓存', async t => {
  const f = await fixture(t);
  await f.seed('openai', f.openaiCredential());
  const usage = 'https://chatgpt.com/backend-api/wham/usage';
  f.routes.get(usage).push(new Response('denied', { status: 401 }));
  const view = await f.service.view('openai');
  assert.equal(view.status, 'unavailable');
  assert.deepEqual(view.windows, []);
  assert.match(view.message, /ChatGPT/);
  assert.ok(!JSON.stringify(view).includes('denied'));
  // 失败也被短缓存：非 force 不重打。
  await f.service.view('openai');
  assert.equal(f.requests.length, 1);
  // 过限频窗口后 force 会重试。
  f.advance(60_000);
  f.routes.get(usage).push(f.respondJson(codexBody({ used_percent: 5, limit_window_seconds: 18000, reset_after_seconds: 60 }, { used_percent: 5, limit_window_seconds: 604800, reset_after_seconds: 60 })));
  const retry = await f.service.view('openai', { force: true });
  assert.equal(retry.status, 'ok');
  assert.equal(f.requests.length, 2);
});

test('openai 形状/数值严格校验：未知百分比保持 null 不造 0，全未知 → unavailable', async t => {
  const f = await fixture(t);
  await f.seed('openai', f.openaiCredential());
  const usage = 'https://chatgpt.com/backend-api/wham/usage';
  // 百分比是字符串：窗口仍随 resetsAt 保留，但 remainingPercent 必须为 null。
  f.routes.get(usage).push(f.respondJson(codexBody({ used_percent: '25', limit_window_seconds: 18000, reset_after_seconds: 900 }, { used_percent: '10', limit_window_seconds: 604800, reset_after_seconds: 1800 })));
  const partial = await f.service.view('openai');
  assert.equal(partial.status, 'ok');
  assert.equal(partial.windows.length, 2);
  assert.equal(partial.windows[0].remainingPercent, null);
  assert.equal(partial.windows[1].remainingPercent, null);
  assert.equal(partial.windows[0].resetsAt, 1_800_000_000_000 + 900_000);
  f.advance(60_000);
  for (const body of [{ unexpected: true }, {}]) {
    f.routes.get(usage).push(f.respondJson(body));
    const view = await f.service.view('openai', { force: true });
    f.advance(60_000);
    assert.equal(view.status, 'unavailable');
    assert.deepEqual(view.windows, []);
  }
});

test('openai 过期令牌经 runtime.models.getAuth 在锁内刷新后再查询', async t => {
  const f = await fixture(t);
  await f.seed('openai', f.openaiCredential({ expires: Date.now() - 1000 }));
  const usage = 'https://chatgpt.com/backend-api/wham/usage';
  f.routes.get(usage).push(init => {
    assert.match(init.headers.authorization, /^Bearer codex-refresh-hdr\./);
    return f.respondJson(codexBody({ used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 600 }, { used_percent: 3, limit_window_seconds: 604800, reset_after_seconds: 3600 }));
  });
  const view = await f.service.view('openai');
  assert.equal(view.status, 'ok');
  assert.equal(view.windows[0].remainingPercent, 88);
  // 刷新结果已按 SDK 语义回写凭据存储（rotate 后的 refresh token 与含 accountId 的 access）。
  const stored = await f.credentials.read('openai');
  assert.equal(stored.refresh, 'refresh-rotated');
  assert.match(stored.access, /^codex-refresh-hdr\./);
  assert.equal(stored.accountId, 'acct-123');
});

test('旧直连凭据（clientId、无 accountId）判不完整：要求重登且不发请求', async t => {
  const f = await fixture(t);
  await f.seed('openai', f.openaiCredential({ clientId: 'client-legacy', accountId: undefined }));
  const view = await f.service.view('openai');
  assert.equal(view.status, 'unavailable');
  assert.match(view.message, /凭据不完整/);
  assert.deepEqual(f.requests, []); // 指纹不完整在本地即拦下，不碰额度接口
});

test('bigmodel ok：脱敏生产 fixture 形状，remaining 为准不重算', async t => {
  const f = await fixture(t);
  const credential = f.bigmodelCredential();
  await f.seed('bigmodel', credential);
  f.routes.get('https://bigmodel.cn/api/monitor/usage/quota/limit').push(init => {
    assert.equal(init.headers.authorization, `Bearer ${credential.access}`);
    return f.respondJson(glmBody);
  });
  const view = await f.service.view('bigmodel');
  assert.equal(view.status, 'ok');
  assert.equal(view.windows.length, 2);
  const [five, weekly] = view.windows;
  assert.equal(five.id, 'five-hour');
  assert.equal(five.remaining, 11804); // 服务端值；usage−currentValue＝11805，不覆盖
  assert.equal(five.used, 195);
  assert.equal(five.limit, 12000);
  assert.equal(five.unit, 'credits');
  assert.ok(Math.abs(five.remainingPercent - (11804 / 12000) * 100) < 1e-9);
  assert.equal(five.resetsAt, 1792905382344);
  assert.equal(weekly.id, 'weekly');
  assert.equal(weekly.remaining, 52155);
  assert.ok(Math.abs(weekly.remainingPercent - (52155 / 60000) * 100) < 1e-9);
  const request = f.requests.at(-1);
  assert.equal(request.url, 'https://bigmodel.cn/api/monitor/usage/quota/limit');
  assert.ok(/^Bearer hdr\./.test(request.headers.authorization));
});

test('bigmodel percentage 回退与严格校验：未知单位/类型跳过，未知保持 null', async t => {
  const f = await fixture(t);
  await f.seed('bigmodel', f.bigmodelCredential());
  f.routes.get('https://bigmodel.cn/api/monitor/usage/quota/limit').push(f.respondJson({
    code: 200,
    data: { limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 1000, currentValue: 250, percentage: 25 }, // 无 remaining → 回退 100−percentage
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 1000, currentValue: 100, percentage: '13' }, // 字符串百分比 → 不造数
      { type: 'CREDIT_LIMIT', unit: 9, number: 1, usage: 1000, remaining: 1 }, // 未知池单位 → 跳过
      { type: 'TOKEN_LIMIT', unit: 3, number: 5, usage: 1000, remaining: 1 }, // 非额度池 → 跳过
    ] },
  }));
  const view = await f.service.view('bigmodel');
  assert.equal(view.status, 'ok');
  assert.equal(view.windows.length, 2);
  assert.equal(view.windows[0].remainingPercent, 75);
  assert.equal(view.windows[0].remaining, undefined);
  assert.equal(view.windows[1].remainingPercent, null);
  assert.equal(view.windows[1].resetsAt, undefined);
});

test('在途换号：旧账号结果被丢弃，按新账号重查并缓存', async t => {
  const f = await fixture(t);
  await f.seed('openai', f.openaiCredential());
  const usage = 'https://chatgpt.com/backend-api/wham/usage';
  // 应答按 access JWT 里的 account id claim 区分账号（base64 需解码）：旧号 75 / 新号 50。
  const accountIdOf = init => {
    try { return JSON.parse(Buffer.from(String(init.headers.authorization ?? '').split('.')[1], 'base64url').toString('utf8')).chatgpt_account_id ?? ''; } catch { return ''; }
  };
  const respondByAccount = init => f.respondJson(codexBody(
    { used_percent: accountIdOf(init) === 'acct-123' ? 25 : 50, limit_window_seconds: 18000, reset_after_seconds: 900 },
    { used_percent: 10, limit_window_seconds: 604800, reset_after_seconds: 900 },
  ));
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  f.gates.set(usage, { wait });
  f.routes.get(usage).push(respondByAccount);
  f.routes.get(usage).push(respondByAccount);
  const pending = f.service.view('openai');
  await new Promise(resolve => setTimeout(resolve, 0)); // 让首个请求进入 gate
  await f.seed('openai', f.openaiCredential({ accountId: 'acct-b', access: fakeJwt({ chatgpt_account_id: 'acct-b' }) }));
  release();
  const view = await pending;
  // 在途结果属于旧账号：按指纹复核丢弃，最终视图来自新账号的重查。
  assert.equal(view.status, 'ok');
  assert.equal(view.windows[0].remainingPercent, 50);
  assert.equal(f.requests.length, 2);
  const accountIdAt = index => {
    try { return JSON.parse(Buffer.from(f.requests[index].headers.authorization.split('.')[1], 'base64url').toString('utf8')).chatgpt_account_id; } catch { return null; }
  };
  assert.equal(accountIdAt(0), 'acct-123');
  assert.equal(accountIdAt(1), 'acct-b');
  // 新视图缓存键是新账号：非 force 命中缓存且仍是新号数据。
  const again = await f.service.view('openai');
  assert.equal(again.windows[0].remainingPercent, 50);
  assert.equal(f.requests.length, 2);
});

test('logout：登出＋失效后查询 signed-out，不再发请求', async t => {
  const f = await fixture(t);
  await f.seed('openai', f.openaiCredential());
  f.routes.get('https://chatgpt.com/backend-api/wham/usage').push(f.respondJson(codexBody({ used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 900 }, { used_percent: 10, limit_window_seconds: 604800, reset_after_seconds: 900 })));
  await f.service.view('openai');
  await f.credentials.delete('openai');
  f.service.invalidate('openai');
  const view = await f.service.view('openai');
  assert.equal(view.status, 'signed-out');
  assert.equal(f.requests.length, 1); // 未发新请求
});

test('redactText：URL userinfo/query、JWT 与长 token 打码', () => {
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: 'acct' })).toString('base64url')}.${'A'.repeat(43)}`;
  const redacted = redactText(`POST https://user:pass@api.example.com/v1/x?token=secret failed ${jwt} sig 0123456789abcdef0123456789abcdef0123 end`);
  assert.ok(!redacted.includes('user:pass'));
  assert.ok(!redacted.includes('token=secret'));
  assert.ok(!redacted.includes('eyJ'));
  assert.ok(!redacted.includes('0123456789abcdef0123456789abcdef0123'));
  assert.ok(redacted.includes('api.example.com/v1/x'));
});
