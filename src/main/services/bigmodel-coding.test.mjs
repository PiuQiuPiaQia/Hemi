import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLocalSecretStorage } from '../lib/local-secrets.mjs';
import { createOAuthCredentials } from './oauth-credentials.mjs';
import { createOAuthModels, setOAuthRuntime } from './oauth-models.mjs';
import { createOAuthLogin } from './oauth-login.mjs';
import { createProfileStore } from '../lib/model-profiles.mjs';
import { chatTurn, pingTextModel } from './text-model.mjs';
import { answerAboutImage } from './vision-model.mjs';
import { createCodingTransport } from './bigmodel-coding-transport.mjs';
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
  const token = (await f.credentials.read('bigmodel')).access;
  const transport = createCodingTransport(f.credentials);
  let release, arrived;
  const blocked = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { arrived = resolve; });
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/v2/client')) { arrived(); await blocked; }
    return f.transport.fetch(url, init);
  };
  const send = (signal, nativeTransport = transport) => nativeTransport.forRequest({ fetchImpl, token })('https://open.bigmodel.cn/api/anthropic/v1/messages', {
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
  const pending = createCodingTransport(f.credentials).forRequest({ fetchImpl: logoutFetch, token })('https://open.bigmodel.cn/api/anthropic/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'glm-5.3', messages: [] }) });
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
