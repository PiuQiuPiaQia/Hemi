import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createLocalSecretStorage } from '../lib/local-secrets.mjs';
import { createOAuthCredentials } from './oauth-credentials.mjs';
import { createOAuthModels, setOAuthRuntime } from './oauth-models.mjs';
import { createOAuthLogin } from './oauth-login.mjs';
import { createProfileStore } from '../lib/model-profiles.mjs';
import { chatTurn, pingTextModel } from './text-model.mjs';
import { answerAboutImage } from './vision-model.mjs';
import { createCodingTransport } from './bigmodel-coding-transport.mjs';
import { createHemiSession } from '../agent/hemi-session.mjs';
import { createRunJournal } from '../agent-runtime/run-journal.mjs';
import { freezeModelPolicy, resolveModelPlan } from '../agent-runtime/model-policy.mjs';
import { driveGoal, goalPolicy, goalRunOutcome, verifyGoalCompletion } from '../agent-runtime/goal-driver.mjs';
import { summarizeBudget } from '../agent-runtime/budget-summary.mjs';
import { startOAuthTestServer, waitForOAuth } from '../../../scripts/oauth-test-fixture.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hemi-bigmodel-test-'));
  const transport = await startOAuthTestServer();
  const previous = globalThis.fetch;
  globalThis.fetch = transport.fetch;
  const safeStorage = createLocalSecretStorage({ directory: path.join(dir, 'secrets') });
  const filePath = path.join(dir, 'oauth.json');
  const credentials = createOAuthCredentials({ filePath, safeStorage });
  const runtime = createOAuthModels(credentials);
  setOAuthRuntime(runtime);
  const profiles = createProfileStore({ filePath: path.join(dir, 'models.json'), safeStorage, oauth: runtime, env: {} });
  const urls = [];
  const login = createOAuthLogin({ credentials, runtime, profiles, openExternal: async url => { urls.push(url); } });
  t.after(async () => { login.dispose(); setOAuthRuntime(null); globalThis.fetch = previous; await transport.close(); await rm(dir, { recursive: true, force: true }); });
  async function connect() {
    await login.start('bigmodel');
    return waitForOAuth(() => login.getState(), state => state?.phase !== 'login');
  }
  return { dir, filePath, transport, credentials, runtime, profiles, login, urls, connect };
}

test('BigModel 实际 Provider：授权→项目令牌→加密目录→路由/签名/流式/工具/图片', async t => {
  const f = await fixture(t);
  f.transport.bigmodel.state.keys = [];
  assert.equal((await f.connect()).phase, 'success');
  assert.equal(new URL(f.urls[0]).hostname, 'bigmodel.cn');
  assert.equal(new URL(new URL(f.urls[0]).searchParams.get('redirect')).origin, 'https://zcode.z.ai');
  const directory = await f.profiles.list();
  const account = directory.providers.find(provider => provider.oauthProvider === 'bigmodel');
  assert.equal(account.hasApiKey, true);
  assert.deepEqual(account.models.map(model => model.model), ['glm-5.3', 'glm-5.3-flash']);
  const config = await f.profiles.get(account.models[0].modelKey);
  const probe = await f.runtime.models.completeSimple(f.runtime.models.getModel('bigmodel', 'glm-5.3'), { messages: [{ role: 'user', content: 'direct SDK probe', timestamp: Date.now() }] });
  assert.equal(probe.stopReason, 'stop', probe.errorMessage);
  const result = await chatTurn({ ...config, messages: [{ role: 'user', content: 'hello' }], thinkingLevel: 'off' });
  assert.equal(result.content, 'OAuth OK');
  for (const [level, effort] of [['low', 'low'], ['medium', 'high'], ['high', 'max']]) {
    await chatTurn({ ...config, messages: [{ role: 'user', content: `thinking ${level}` }], thinkingLevel: level });
    const body = JSON.parse(f.transport.requests.findLast(item => item.url.endsWith('/messages')).body);
    assert.equal(body.output_config.effort, effort);
    assert.ok(body.thinking.budget_tokens < body.max_tokens);
    assert.equal(body.thinking.display, undefined);
  }
  assert.equal((await pingTextModel({ ...config, requireTools: true })).ok, true);
  const vision = await f.profiles.get(account.models[1].modelKey);
  assert.equal(await answerAboutImage({ ...vision, imageData: 'QQ==', mimeType: 'image/png', question: 'what' }), 'OAuth OK');
  assert.equal(f.transport.bigmodel.state.handshakes, 1, 'one cached signing key per token');
  const handshake = f.transport.requests.find(item => item.url.endsWith('/api/paas/c1f3a7e2/v2/client'));
  assert.equal(new URL(handshake.url).origin, 'https://open.bigmodel.cn');
  const request = f.transport.requests.findLast(item => item.url.endsWith('/messages'));
  assert.match(request.url, /^https:\/\/zcode\.z\.ai\/api\/v1\/ultra\//);
  assert.ok(JSON.parse(request.body).messages.some(message => message.content.some?.(part => part.type === 'image')));
  const disk = await readFile(f.filePath, 'utf8');
  assert.doesNotMatch(disk + JSON.stringify(directory) + JSON.stringify(f.login.getState()), /synthetic-bigmodel-login|synthetic-project|synthetic-zcode/);
});

test('项目令牌并发刷新只签发一次；重登保留选择；退出阻止旧请求', async t => {
  const f = await fixture(t); await f.connect();
  const key = (await f.profiles.list()).defaultModelId;
  const config = await f.profiles.get(key);
  await f.credentials.modify('bigmodel', async current => ({ ...current, expires: 0 }));
  await Promise.all(Array.from({ length: 4 }, () => f.runtime.models.getAuth('bigmodel')));
  assert.equal(f.transport.bigmodel.state.issued, 2);
  assert.equal((await chatTurn({ ...config, messages: [{ role: 'user', content: 'refreshed' }] })).content, 'OAuth OK');
  await f.login.logout('bigmodel');
  assert.equal((await f.profiles.list()).providers.find(item => item.oauthProvider === 'bigmodel').hasApiKey, false);
  await assert.rejects(pingTextModel(config));
  assert.equal((await f.connect()).phase, 'success');
  assert.equal((await f.profiles.list()).defaultModelId, key);
});

test('复用的主会话在项目令牌过期后继续执行，重试不持有旧令牌', async t => {
  const f = await fixture(t); await f.connect();
  const config = await f.profiles.get((await f.profiles.list()).defaultModelId);
  const session = createHemiSession({ cwd: f.dir, agentDir: path.join(f.dir, 'agent'), routing: { execution: config, fallbacks: [] },
    tools: [], features: {}, settings: { retry: { enabled: false } } });
  t.after(() => session.dispose());
  assert.equal((await session.prompt('before refresh')).modelError, null);
  await f.credentials.modify('bigmodel', async current => ({ ...current, expires: 0 }));
  const after = await session.prompt('after refresh');
  assert.equal(after.modelError, null);
  assert.match(after.texts.join(''), /OAuth OK/);
  assert.equal(f.transport.bigmodel.state.issued, 2);
});

test('SDK 已完成认证后项目令牌到期，原请求续签后继续且只提交一次推理', async t => {
  const f = await fixture(t); await f.connect();
  let payloads = 0;
  const reply = await f.runtime.models.completeSimple(f.runtime.models.getModel('bigmodel', 'glm-5.3-flash'), {
    messages: [{ role: 'user', content: 'late expiry', timestamp: Date.now() }],
  }, { onPayload: async () => {
    payloads++;
    await f.credentials.modify('bigmodel', async current => ({ ...current, expires: 0 }));
  } });
  assert.equal(reply.stopReason, 'stop', reply.errorMessage);
  assert.equal(payloads, 1, 'continue this request rather than replaying the agent turn');
  assert.equal(f.transport.bigmodel.state.issued, 2);
  assert.equal(f.transport.bigmodel.state.modelCalls, 1);
});

test('签名预检期间项目令牌到期，当前请求自行续签并重建签名', async t => {
  const f = await fixture(t); await f.connect();
  const authKey = (await f.runtime.models.getAuth('bigmodel')).auth.apiKey;
  let expire = true;
  const fetchImpl = async (url, init) => {
    const response = await f.transport.fetch(url, init);
    if (expire && String(url).endsWith('/v2/client')) {
      expire = false;
      await f.credentials.modify('bigmodel', async current => ({ ...current, expires: 0 }));
    }
    return response;
  };
  const response = await createCodingTransport(f.credentials).forRequest({ fetchImpl, authKey })(
    'https://open.bigmodel.cn/api/anthropic/v1/messages', {
      method: 'POST', body: JSON.stringify({ model: 'glm-5.3', messages: [] }),
    });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json().catch(() => null)));
  assert.equal(f.transport.bigmodel.state.issued, 2);
  assert.equal(f.transport.bigmodel.state.handshakes, 2);
  assert.equal(f.transport.bigmodel.state.modelCalls, 1);
});

test('上游明确拒绝项目令牌时续签一次，重试使用新令牌和新签名', async t => {
  const f = await fixture(t); await f.connect();
  const authKey = (await f.runtime.models.getAuth('bigmodel')).auth.apiKey;
  let reject = true;
  const fetchImpl = async (url, init) => {
    const response = await f.transport.fetch(url, init);
    if (reject && String(url).endsWith('/ultra/anthropic/v1/messages')) {
      reject = false;
      await response.body?.cancel();
      return Response.json({ error: { reason: 'VERIFY_APIKEY_EXPIRED' } }, { status: 401 });
    }
    return response;
  };
  const response = await createCodingTransport(f.credentials).forRequest({ fetchImpl, authKey })(
    'https://open.bigmodel.cn/api/anthropic/v1/messages', {
      method: 'POST', body: JSON.stringify({ model: 'glm-5.3', messages: [] }),
    });
  assert.equal(response.status, 200);
  assert.equal(f.transport.bigmodel.state.issued, 2);
  assert.equal(f.transport.bigmodel.state.handshakes, 2);
  assert.equal(f.transport.bigmodel.state.modelCalls, 2);
});

test('复用 Hemi 会话处理追加指令时，SDK 认证后到期不会中断或重放回合', async t => {
  const f = await fixture(t); await f.connect();
  const config = await f.profiles.get((await f.profiles.list()).defaultModelId);
  const native = f.runtime.models.getProvider('bigmodel');
  const derive = native.auth.oauth.toAuth;
  let expire = false;
  native.auth.oauth.toAuth = async credential => {
    const auth = await derive(credential);
    if (expire) {
      expire = false;
      await f.credentials.modify('bigmodel', async current => ({ ...current, expires: 0 }));
    }
    return auth;
  };
  const session = createHemiSession({ cwd: f.dir, agentDir: path.join(f.dir, 'agent'), routing: { execution: config, fallbacks: [] },
    tools: [], features: {}, settings: { retry: { enabled: false } } });
  t.after(() => session.dispose());
  assert.equal((await session.prompt('先调研')).modelError, null);
  expire = true;
  const reply = await session.prompt('请收敛范围并形成报告');
  assert.equal(reply.modelError, null);
  assert.match(reply.texts.join(''), /OAuth OK/);
  assert.equal(f.transport.bigmodel.state.issued, 2);
  assert.equal(f.transport.bigmodel.state.modelCalls, 2);
});

test('传输层与 SDK 并发续签只签发一次；取消发起者和排队者不影响其他请求', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.connect();
  const authKey = (await f.runtime.models.getAuth('bigmodel')).auth.apiKey;
  await f.credentials.modify('bigmodel', async current => ({ ...current, expires: Date.now() + 240000 }));
  const arrived = Promise.withResolvers(), blocked = Promise.withResolvers();
  t.after(() => blocked.resolve());
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/access_tokens')) { arrived.resolve(); await blocked.promise; }
    return f.transport.fetch(url, init);
  };
  const transport = createCodingTransport(f.credentials);
  const send = signal => transport.forRequest({ fetchImpl, authKey })(
    'https://open.bigmodel.cn/api/anthropic/v1/messages', {
      method: 'POST', signal, body: JSON.stringify({ model: 'glm-5.3', messages: [] }),
    });
  const active = new AbortController(), queued = new AbortController();
  const first = send(active.signal);
  await arrived.promise;
  const second = send(queued.signal);
  const survivor = send();
  const sdk = f.runtime.models.getAuth('bigmodel');
  active.abort(); queued.abort();
  await Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]);
  blocked.resolve();
  assert.equal((await survivor).status, 200);
  await sdk;
  assert.equal(f.transport.bigmodel.state.issued, 2);
  assert.equal(f.transport.bigmodel.state.handshakes, 1);
  assert.equal(f.transport.bigmodel.state.modelCalls, 1);
});

test('续签期间排队的退出或重登阻止旧请求，续签结果不会覆盖新登录', async t => {
  for (const change of ['logout', 'reconnect']) await t.test(change, async t => {
    const f = await fixture(t); await f.connect();
    const authKey = (await f.runtime.models.getAuth('bigmodel')).auth.apiKey;
    await f.credentials.modify('bigmodel', async current => ({ ...current, expires: 0 }));
    const arrived = Promise.withResolvers(), blocked = Promise.withResolvers();
    t.after(() => blocked.resolve());
    const fetchImpl = async (url, init) => {
      if (String(url).endsWith('/access_tokens')) { arrived.resolve(); await blocked.promise; }
      return f.transport.fetch(url, init);
    };
    const pending = createCodingTransport(f.credentials).forRequest({ fetchImpl, authKey })(
      'https://open.bigmodel.cn/api/anthropic/v1/messages', {
        method: 'POST', body: JSON.stringify({ model: 'glm-5.3', messages: [] }),
      });
    await arrived.promise;
    const mutation = change === 'logout' ? f.credentials.delete('bigmodel')
      : f.credentials.modify('bigmodel', async current => ({ ...current, authSessionId: 'synthetic-new-login' }));
    blocked.resolve();
    await mutation;
    assert.equal((await pending).status, 401);
    assert.equal(f.transport.bigmodel.state.modelCalls, 0);
    const credential = await f.credentials.read('bigmodel');
    if (change === 'logout') assert.equal(credential, undefined);
    else {
      assert.equal(credential.authSessionId, 'synthetic-new-login');
      const reply = await f.runtime.models.completeSimple(f.runtime.models.getModel('bigmodel', 'glm-5.3'), {
        messages: [{ role: 'user', content: 'new login', timestamp: Date.now() }],
      });
      assert.equal(reply.stopReason, 'stop', reply.errorMessage);
    }
  });
});

test('续签失败保留登录失效与连接错误的区别，不发送推理或泄露上游内容', async t => {
  for (const failure of [401, 503, 'ECONNREFUSED', 'invalid-token', 'short-lived-token']) await t.test(String(failure), async t => {
    const f = await fixture(t); await f.connect();
    const authKey = (await f.runtime.models.getAuth('bigmodel')).auth.apiKey;
    await f.credentials.modify('bigmodel', async current => ({ ...current, expires: 0 }));
    let renewals = 0;
    const fetchImpl = async (url, init) => {
      if (String(url).endsWith('/access_tokens')) {
        renewals++;
        if (failure === 'ECONNREFUSED') throw new TypeError('PRIVATE UPSTREAM', { cause: Object.assign(new Error('synthetic-bigmodel-login'), { code: failure }) });
        if (failure === 'invalid-token') return Response.json({ code: 200, data: { accessToken: 'PRIVATE UPSTREAM synthetic-bigmodel-login' } });
        if (failure === 'short-lived-token') {
          const response = await f.transport.fetch(url, init), body = await response.json();
          body.data.expiresIn = 60;
          return Response.json(body);
        }
        return new Response('PRIVATE UPSTREAM synthetic-bigmodel-login', { status: failure });
      }
      return f.transport.fetch(url, init);
    };
    const pending = createCodingTransport(f.credentials).forRequest({ fetchImpl, authKey })(
      'https://open.bigmodel.cn/api/anthropic/v1/messages', {
        method: 'POST', body: JSON.stringify({ model: 'glm-5.3', messages: [] }),
      });
    if (failure === 'ECONNREFUSED') await assert.rejects(pending,
      error => error.code === failure && !/PRIVATE|synthetic-bigmodel-login/.test(error.message));
    else {
      const response = await pending;
      assert.equal(response.status, typeof failure === 'number' ? failure : 503);
      const body = await response.text();
      assert.doesNotMatch(body, /PRIVATE|synthetic-bigmodel-login/);
      if (failure === 401) assert.match(body, /请重新登录/);
      else assert.doesNotMatch(body, /请重新登录/);
    }
    assert.equal(renewals, 1);
    assert.equal(f.transport.bigmodel.state.modelCalls, 0);
  });
});

test('明确令牌拒绝最多重发一次，普通 401 不续签；并发已换发的令牌直接复用', async t => {
  for (const mode of ['expired-twice', 'ordinary-401', 'already-renewed']) await t.test(mode, async t => {
    const f = await fixture(t); await f.connect();
    const authKey = (await f.runtime.models.getAuth('bigmodel')).auth.apiKey;
    let calls = 0;
    const fetchImpl = async (url, init) => {
      const response = await f.transport.fetch(url, init);
      if (String(url).endsWith('/ultra/anthropic/v1/messages')) {
        calls++;
        if (mode === 'already-renewed' && calls > 1) return response;
        await response.body?.cancel();
        if (mode === 'already-renewed') {
          await f.credentials.modify('bigmodel', async current => ({ ...current, expires: 0 }));
          await f.runtime.models.getAuth('bigmodel');
        }
        return Response.json({ reason: mode === 'ordinary-401' ? 'UNAUTHORIZED' : 'VERIFY_APIKEY_EXPIRED' }, { status: 401 });
      }
      return response;
    };
    const response = await createCodingTransport(f.credentials).forRequest({ fetchImpl, authKey })(
      'https://open.bigmodel.cn/api/anthropic/v1/messages', {
        method: 'POST', body: JSON.stringify({ model: 'glm-5.3', messages: [] }),
      });
    assert.equal(response.status, mode === 'already-renewed' ? 200 : 401);
    assert.equal(f.transport.bigmodel.state.issued, mode === 'ordinary-401' ? 1 : 2);
    assert.equal(calls, mode === 'ordinary-401' ? 1 : 2);
  });
});

test('推理已返回 HTTP 200 后流中断，不续签或自动重放生成', async t => {
  const f = await fixture(t); await f.connect();
  globalThis.fetch = async (url, init) => {
    const response = await f.transport.fetch(url, init);
    if (!String(url).endsWith('/ultra/anthropic/v1/messages')) return response;
    await response.body?.cancel();
    return new Response(new ReadableStream({ start(controller) {
      controller.error(new Error('stream terminated'));
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const reply = await f.runtime.models.completeSimple(f.runtime.models.getModel('bigmodel', 'glm-5.3'), {
    messages: [{ role: 'user', content: 'stream interruption', timestamp: Date.now() }],
  });
  assert.equal(reply.stopReason, 'error');
  assert.equal(f.transport.bigmodel.state.issued, 1);
  assert.equal(f.transport.bigmodel.state.modelCalls, 1);
});

test('旧格式登录的既有请求跟随令牌刷新，重新登录使旧请求失效', async t => {
  const f = await fixture(t); await f.connect();
  await f.credentials.modify('bigmodel', async ({ authSessionId, ...current }) => current);
  const authKey = (await f.runtime.models.getAuth('bigmodel')).auth.apiKey;
  const send = createCodingTransport(f.credentials).forRequest({ fetchImpl: f.transport.fetch, authKey });
  const request = () => send('https://open.bigmodel.cn/api/anthropic/v1/messages', {
    method: 'POST', body: JSON.stringify({ model: 'glm-5.3', messages: [] }),
  });
  assert.equal((await request()).status, 200);
  await f.credentials.modify('bigmodel', async current => ({ ...current, expires: 0 }));
  await f.runtime.models.getAuth('bigmodel');
  assert.equal((await request()).status, 200, 'a project-token rotation does not replace the login');
  assert.equal(f.transport.bigmodel.state.handshakes, 2, 'the new project token needs its own signing key');
  await f.connect();
  const before = f.transport.bigmodel.state.modelCalls;
  assert.equal((await request()).status, 401, 'an explicit reconnect invalidates the old request even for the same account');
  assert.equal(f.transport.bigmodel.state.modelCalls, before);
});

test('签名预检期间项目令牌刷新会重建预检，推理只发送一次', async t => {
  const f = await fixture(t); await f.connect();
  const authKey = (await f.runtime.models.getAuth('bigmodel')).auth.apiKey;
  let release, arrived;
  const blocked = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { arrived = resolve; });
  let hold = true;
  const fetchImpl = async (url, init) => {
    const response = await f.transport.fetch(url, init);
    if (hold && String(url).endsWith('/v2/client')) { hold = false; arrived(); await blocked; }
    return response;
  };
  const pending = createCodingTransport(f.credentials).forRequest({ fetchImpl, authKey })('https://open.bigmodel.cn/api/anthropic/v1/messages', {
    method: 'POST', body: JSON.stringify({ model: 'glm-5.3', messages: [] }),
  });
  await waiting;
  await f.credentials.modify('bigmodel', async current => ({ ...current, expires: 0 }));
  await f.runtime.models.getAuth('bigmodel');
  release();
  assert.equal((await pending).status, 200);
  assert.equal(f.transport.bigmodel.state.handshakes, 2);
  assert.equal(f.transport.bigmodel.state.modelCalls, 1);
});

test('只在明确签名拒绝时重新握手一次；上游响应不会泄露凭据', async t => {
  const f = await fixture(t); await f.connect();
  const config = await f.profiles.get((await f.profiles.list()).defaultModelId);
  f.transport.bigmodel.state.rejectSignatures = 1;
  assert.equal((await chatTurn({ ...config, messages: [{ role: 'user', content: 'retry signature' }] })).content, 'OAuth OK');
  assert.equal(f.transport.bigmodel.state.modelCalls, 2);
  assert.equal(f.transport.bigmodel.state.handshakes, 2);
  f.transport.bigmodel.state.rawFailure = true;
  await assert.rejects(pingTextModel(config), error => !/synthetic-bigmodel-login|PRIVATE UPSTREAM/.test(error.message));
  f.transport.bigmodel.state.rawFailure = false;
  f.transport.bigmodel.state.rejectSignatures = 4;
  const before = f.transport.bigmodel.state.modelCalls;
  await assert.rejects(pingTextModel(config));
  assert.equal(f.transport.bigmodel.state.modelCalls - before, 2, 'never retry unsigned or replay a failed generation');
});

test('拒绝恶意授权/路由；取消 polling 不落盘也不创建账号密钥', async t => {
  const f = await fixture(t);
  f.transport.bigmodel.state.authorizeUrl = 'https://attacker.invalid/login?token=secret';
  assert.equal((await f.connect()).phase, 'failed'); assert.equal(f.urls.length, 0);
  f.transport.bigmodel.state.authorizeUrl = 'https://bigmodel.cn/login?appId=zcode';
  f.transport.bigmodel.state.pending = 10;
  const started = await f.login.start('bigmodel');
  await waitForOAuth(() => f.urls.length, Boolean);
  await f.login.cancel(started.id);
  assert.deepEqual(await f.credentials.list(), []);
  assert.equal(f.transport.bigmodel.state.issued, 0);
  f.transport.bigmodel.state.pending = 0;
  assert.equal((await f.connect()).phase, 'success');
  f.transport.bigmodel.state.mapping = [{ from: 'https://open.bigmodel.cn/api/anthropic/v1/messages', to: 'https://attacker.invalid/steal' }];
  const config = await f.profiles.get((await f.profiles.list()).defaultModelId);
  await assert.rejects(pingTextModel(config));
  assert.equal(f.transport.bigmodel.state.modelCalls, 0);
  assert.ok(f.transport.requests.every(item => !item.url.includes('attacker.invalid')));
});

test('共享签名握手中取消一个请求不影响另一个；退出后不发送待发的模型请求', async t => {
  const f = await fixture(t); await f.connect();
  const authKey = (await f.runtime.models.getAuth('bigmodel')).auth.apiKey;
  const transport = createCodingTransport(f.credentials);
  let release, arrived;
  const blocked = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { arrived = resolve; });
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/v2/client')) { arrived(); await blocked; }
    return f.transport.fetch(url, init);
  };
  const send = (signal, nativeTransport = transport) => nativeTransport.forRequest({ fetchImpl, authKey })('https://open.bigmodel.cn/api/anthropic/v1/messages', {
    method: 'POST', signal, body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'concurrent' }] }),
  });
  const controller = new AbortController();
  const first = send(controller.signal);
  await waiting;
  const second = send();
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  release();
  assert.equal((await second).status, 200);
  assert.equal(f.transport.bigmodel.state.handshakes, 1);
  // A second, independently held handshake models logout while preflight waits.
  let releaseLogout, arrivedLogout;
  const blockedLogout = new Promise(resolve => { releaseLogout = resolve; });
  const waitingLogout = new Promise(resolve => { arrivedLogout = resolve; });
  const logoutFetch = async (url, init) => {
    if (String(url).endsWith('/v2/client')) { arrivedLogout(); await blockedLogout; }
    return f.transport.fetch(url, init);
  };
  const before = f.transport.bigmodel.state.modelCalls;
  const pending = createCodingTransport(f.credentials).forRequest({ fetchImpl: logoutFetch, authKey })('https://open.bigmodel.cn/api/anthropic/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'glm-5.3', messages: [] }) });
  await waitingLogout; await f.login.logout('bigmodel'); releaseLogout();
  assert.equal((await pending).status, 401);
  assert.equal(f.transport.bigmodel.state.modelCalls, before);
});

test('签名握手 HTTP 失败保留阶段与状态，不发送模型请求或暴露上游正文', async t => {
  const f = await fixture(t); await f.connect();
  f.transport.bigmodel.state.handshakeStatus = 404;
  const config = await f.profiles.get((await f.profiles.list()).defaultModelId);
  await assert.rejects(pingTextModel(config), error => /签名握手失败（HTTP 404）/.test(error.message) && !/PRIVATE UPSTREAM/.test(error.message));
  assert.equal(f.transport.bigmodel.state.modelCalls, 0);
});

test('GLM 目标校验：冷启动预检和单次推理分别记账，校验故障不重放已执行工作', async t => {
  for (const mode of ['complete', 'malformed', 'http-failure', 'preflight-failure']) await t.test(mode, async t => {
    const f = await fixture(t); await f.connect();
    const config = await f.profiles.get((await f.profiles.list()).defaultModelId);
    const owner = { conversationId: 'verification-test', rootRunId: 'run', generation: 1 };
    const journal = createRunJournal({ dir: path.join(f.dir, 'journal') });
    await journal.beginRoot(owner);
    const policy = await freezeModelPolicy({ store: f.profiles, modelKey: config.modelKey });
    const execution = { journal, owner, plan: resolveModelPlan(policy), store: f.profiles, budgets: policy.budgets };
    const complete = { status: 'complete', reason: '实际文件已核对', evidence: ['文件只写入一次'], remaining: [], nextAction: '' };
    globalThis.fetch = async (url, init) => {
      if (mode === 'preflight-failure' && String(url).endsWith('/v2/client'))
        throw new TypeError('SYNTHETIC_PRIVATE', { cause: Object.assign(new Error('SYNTHETIC_PRIVATE'), { code: 'EPIPE' }) });
      const response = await f.transport.fetch(url, init);
      if (!String(url).endsWith('/ultra/anthropic/v1/messages')) return response;
      if (mode === 'http-failure') { await response.body.cancel(); return Response.json({ error: { message: 'Synthetic outage' } }, { status: 503 }); }
      if (mode !== 'complete') return response;
      return new Response((await response.text()).replaceAll('OAuth OK', JSON.stringify(JSON.stringify(complete)).slice(1, -1)), { headers: response.headers });
    };
    let runs = 0;
    const proof = path.join(f.dir, 'proof.txt');
    const result = await driveGoal({ journal, owner, objective: '写入并核对文件', policy: goalPolicy(), signal: AbortSignal.timeout(10000),
      run: async () => { runs++; await writeFile(proof, 'EXECUTED_ONCE'); return { texts: ['文件已写入'] }; },
      verify: (objective, evidence) => verifyGoalCompletion({ execution, objective, evidence, signal: AbortSignal.timeout(5000) }),
      evidence: () => readFile(proof, 'utf8'), persist: async () => {} });
    assert.equal(runs, 1); assert.equal(await readFile(proof, 'utf8'), 'EXECUTED_ONCE');
    assert.equal(goalRunOutcome(result), 'completed'); await journal.finishRoot(owner, 'completed');
    const state = await journal.snapshot(), goal = state.roots[owner.rootRunId].goal, rows = Object.values(state.requests);
    assert.equal(goal.verificationAttempts.length, 1); assert.equal(goal.verifications.length, 1);
    assert.equal(Boolean(goal.verifications[0].verificationBypassed), mode !== 'complete');
    assert.ok(rows.every(row => row.endedAt)); assert.equal(new Set(rows.map(row => row.logicalCallId)).size, 1);
    assert.equal(rows.filter(row => !row.preflight).length, mode === 'preflight-failure' ? 0 : 1);
    assert.equal(rows.filter(row => row.preflight).length, 2);
    assert.equal(f.transport.bigmodel.state.modelCalls, mode === 'preflight-failure' ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(state), /SYNTHETIC_PRIVATE|synthetic-project|synthetic-bigmodel-login/);
  });
});

test('GLM 预检不消耗执行额度，触顶总结仍只允许一次实际推理', async t => {
  for (const kind of ['execution', 'summary']) await t.test(kind, async t => {
    const f = await fixture(t); await f.connect();
    const config = await f.profiles.get((await f.profiles.list()).defaultModelId);
    const owner = { conversationId: 'budget-test', rootRunId: 'run', generation: 1 };
    const journal = createRunJournal({ dir: path.join(f.dir, 'journal') }); await journal.beginRoot(owner);
    const policy = await freezeModelPolicy({ store: f.profiles, modelKey: config.modelKey });
    const execution = { journal, owner, purpose: 'main', plan: resolveModelPlan(policy), store: f.profiles, budgets: { ...policy.budgets, maxRequestsPerRun: 1 } };
    if (kind === 'execution') {
      const result = await chatTurn({ ...config, runtimeExecution: execution, messages: [{ role: 'user', content: '只回复 OK' }] });
      assert.equal(result.content, 'OAuth OK');
    } else await journal.requestStart(owner, { requestId: 'used', purpose: 'main' }, 1);
    await assert.rejects(journal.requestStart(owner, { requestId: 'over', purpose: 'main' }, 1), { code: 'request-limit' });
    if (kind === 'summary') {
      const result = await summarizeBudget({ execution, brief: '已有文件，尚未验证', fallbackText: 'FALLBACK', signal: AbortSignal.timeout(5000) });
      assert.equal(result.fallback, false); assert.match(result.text, /OAuth OK/);
      const again = await summarizeBudget({ execution, brief: '', fallbackText: 'FALLBACK', signal: AbortSignal.timeout(5000) });
      assert.equal(again.text, result.text);
    }
    const rows = Object.values((await journal.snapshot()).requests);
    assert.equal(rows.filter(row => row.preflight).length, 2);
    assert.equal(f.transport.bigmodel.state.modelCalls, 1);
    assert.equal((await journal.root(owner)).requestLimitReached.limit, 1);
  });
});

test('GLM 真实 SDK 与恢复器：连接拒绝可恢复，EPIPE 不伪装 503 或重复提交推理', async t => {
  for (const code of ['ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET', 'preflight EPIPE']) await t.test(code, async t => {
    const f = await fixture(t); await f.connect();
    const config = await f.profiles.get((await f.profiles.list()).defaultModelId);
    const owner = { conversationId: 'transport-test', rootRunId: 'run', generation: 1 };
    const journal = createRunJournal({ dir: path.join(f.dir, 'journal') });
    await journal.beginRoot(owner);
    let inferenceAttempts = 0, handshakeAttempts = 0, received = 0;
    let dropUrl;
    if (code === 'UND_ERR_SOCKET') {
      const server = http.createServer(async (req) => {
        for await (const _ of req) { /* Receive generation, then drop without a response. */ }
        received++;
        req.socket.destroy();
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      dropUrl = `http://127.0.0.1:${server.address().port}/messages`;
      t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    }
    globalThis.fetch = async (url, init) => {
      if (code === 'preflight EPIPE' && String(url).endsWith('/v2/client') && ++handshakeAttempts === 1) {
        await f.transport.fetch(url, init);
        throw new TypeError('PRIVATE_UPSTREAM SYNTHETIC_SECRET', { cause: Object.assign(new Error('PRIVATE_ADDRESS'), { code: 'EPIPE' }) });
      }
      if (String(url).endsWith('/ultra/anthropic/v1/messages') && ++inferenceAttempts === 1) {
        if (dropUrl) return f.transport.originalFetch(dropUrl, init);
        if (code !== 'preflight EPIPE')
          throw new TypeError('PRIVATE_UPSTREAM SYNTHETIC_SECRET', { cause: Object.assign(new Error('PRIVATE_ADDRESS'), { code }) });
      }
      return f.transport.fetch(url, init);
    };
    const policy = await freezeModelPolicy({ store: f.profiles, modelKey: config.modelKey });
    const execution = { journal, owner, purpose: 'main', plan: resolveModelPlan(policy),
      store: f.profiles, budgets: { ...policy.budgets, maxRequestsPerRun: 10 }, cancelled: () => false };
    const session = createHemiSession({ cwd: f.dir, agentDir: path.join(f.dir, 'agent'), routing: { execution: config, fallbacks: [] },
      tools: [], features: {}, executionContext: execution, initTimeoutMs: 2000, stallTimeoutMs: 5000 });
    t.after(() => session.dispose());
    const result = await session.prompt('只回复 OK');
    const records = Object.values((await journal.snapshot()).requests);
    const failed = records.find(row => row.failure?.transportCode === (code === 'preflight EPIPE' ? 'EPIPE' : code));
    assert.ok(failed, JSON.stringify({ records, modelError: result.modelError, inferenceAttempts }));
    assert.equal(failed.httpStatus, undefined, 'local connection failure is not an upstream HTTP status');
    assert.equal(failed.failure.kind, 'transport');
    assert.equal(failed.failure.phase, 'connection', 'preflight responses do not start the inference output deadline');
    assert.doesNotMatch(JSON.stringify(records) + String(result.modelError), /PRIVATE_|SYNTHETIC_SECRET|503/);
    if (code === 'ECONNREFUSED' || code === 'preflight EPIPE') {
      assert.equal(result.modelError, null);
      assert.equal(inferenceAttempts, code === 'preflight EPIPE' ? 1 : 2);
      assert.equal(failed.failure.retryable, true);
      assert.ok(failed.recovery);
      assert.equal(records.at(-1).httpStatus, 200);
      if (code === 'preflight EPIPE') {
        assert.equal(failed.failure.preflight, true);
        assert.equal(failed.failure.delivery, 'sent');
        assert.equal(handshakeAttempts, 2);
        assert.equal(f.transport.bigmodel.state.modelCalls, 1);
      }
    } else {
      assert.match(result.modelError, /(?:EPIPE|UND_ERR_SOCKET).*请求可能已发送/);
      assert.equal(inferenceAttempts, 1);
      assert.equal(failed.failure.retryable, false);
      assert.equal(failed.recovery, undefined);
      assert.equal(f.transport.bigmodel.state.modelCalls, 0);
      if (dropUrl) { assert.equal(received, 1); assert.equal(failed.failure.delivery, 'sent'); }
      assert.ok(records.some(row => row.httpStatus === 200), 'successful preflight status cannot hide an inference disconnect');
    }
  });
});
