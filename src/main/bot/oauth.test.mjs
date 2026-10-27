import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBotHost } from './host.mjs';
import { createBotDesktopService } from './desktop-service.mjs';
import { createOAuthCredentials } from '../services/oauth-credentials.mjs';
import { createLocalSecretStorage } from '../lib/local-secrets.mjs';
import { setOAuthRuntime } from '../services/oauth-models.mjs';
import { startOAuthTestServer, waitForOAuth } from '../../../scripts/oauth-test-fixture.mjs';

const until = (read, predicate = Boolean) => waitForOAuth(read, predicate, 30000);
const privateToken = /openai-test-access|sk-ant-oat-test-access|test-refresh-rotated|test-github-token|test-copilot;/;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-oauth-'));
  const provider = await startOAuthTestServer(), originalFetch = globalThis.fetch;
  globalThis.fetch = provider.fetch;
  const dataDir = path.join(root, 'server'), desktopDir = path.join(root, 'desktop');
  let host = await createBotHost({ dataDir, defaultDir: path.join(root, 'workspace') });
  const hello = await host.request('handshake');
  const call = (method, params = {}) => host.request(method, { instanceId: hello.instanceId, requestId: randomUUID(), ...params });
  const urls = [];
  const desktop = createBotDesktopService({
    userDataDir: desktopDir, profiles: { list: async () => ({ providers: [], roleModels: {} }) }, runner: {},
    autoComponentUpdates: false,
    transport: { rpc: (_host, method, params) => host.request(method, params),
      probe: async () => ({ bot: await host.request('handshake'), existing: true, home: root }), disconnect: async () => {} },
    openExternal: async raw => {
      const url = new URL(raw); urls.push(url);
      if (url.hostname === 'auth.openai.com') {
        const callback = new URL(url.searchParams.get('redirect_uri'));
        callback.search = new URLSearchParams({ code: 'test-local-browser-code', state: url.searchParams.get('state'), client_id: 'bot-independent-client' });
        await provider.originalFetch(callback);
      }
    },
  });
  t.after(async () => { setOAuthRuntime(null); await desktop.close(); await host.close(); globalThis.fetch = originalFetch; await provider.close(); await fs.rm(root, { recursive: true, force: true }); });
  const probe = await desktop.connect({ host: 'fixture-bot' });
  await desktop.initialize({ candidateId: probe.candidate.id, accountSetup: true });
  async function login(account) {
    // The fixed OpenAI callback port is exercised separately in Electron. Keep
    // npm test independent of the desktop OAuth test file using that same port.
    if (account === 'openai') {
      const result = await call('oauth.import', { provider: account, credential: {
        type: 'oauth', access: 'openai-test-access', refresh: 'test-refresh-rotated',
        expires: Date.now() + 7200000, clientId: 'bot-independent-client',
      } });
      await desktop.refresh(); return result;
    }
    const started = await desktop.command('oauth.start', { provider: account });
    const state = predicate => until(() => desktop.command('oauth.state'), predicate);
    if (account === 'anthropic') {
      const choice = await state(value => value?.prompt?.type === 'select');
      await desktop.command('oauth.answer', { id: started.id, promptId: choice.prompt.id, value: 'copy_code' });
      const manual = await state(value => value?.prompt?.type === 'manual_code');
      await desktop.command('oauth.answer', { id: started.id, promptId: manual.prompt.id, value: `test-code#${urls.at(-1).searchParams.get('state')}` });
    } else if (account === 'github-copilot') {
      const domain = await state(value => value?.prompt?.type === 'text');
      await desktop.command('oauth.answer', { id: started.id, promptId: domain.prompt.id, value: '' });
    }
    const finished = await state(value => value?.phase !== 'login');
    assert.equal(finished.phase, 'success', `${account}: ${finished.message}`);
    return finished;
  }
  async function run(modelKey, text = 'Hello from the Bot') {
    const session = await call('session.create');
    await call('session.update', { id: session.id, modelKey });
    await call('flow.command', { id: session.id, command: { type: 'send', input: { inputId: randomUUID(), text } } });
    return until(() => call('session.open', { id: session.id }), detail =>
      !detail.flow.activeRunId && detail.flow.timeline.some(item => item.kind === 'assistant'));
  }
  return { root, dataDir, desktopDir, provider, desktop, call, login, run, urls,
    async restart() { await host.close(); host = await createBotHost({ dataDir, defaultDir: path.join(root, 'workspace') }); } };
}

test('Bot-only first setup and four native account transports: desktop authorization → cloud validation → actual Bot inference', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.call('handshake')).configured, true);
  assert.equal((await f.call('snapshot')).models.length, 0, 'no API Key required to bootstrap');
  // A desktop runtime in the same process cannot supply the Bot's credentials.
  setOAuthRuntime({ models: { getModel() { throw new Error('desktop runtime must not be used by the Bot'); } } });
  for (const account of ['openai', 'anthropic', 'github-copilot', 'bigmodel']) {
    await f.login(account);
    const snapshot = await f.call('snapshot');
    const models = snapshot.models.filter(model => model.oauthProvider === account);
    assert.ok(models.length);
    assert.ok(models.every(model => model.source === 'cloud' && model.oauthConnected));
    assert.equal(snapshot.oauthAccounts.find(item => item.provider === account).connected, true);
    for (const model of account === 'github-copilot' ? models : models.slice(0, 1)) {
      const detail = await f.run(model.key);
      const content = JSON.stringify(detail.flow.timeline);
      assert.match(content, /OAuth OK/);
      assert.doesNotMatch(content, privateToken);
    }
  }
  const account = (await f.call('snapshot')).models.find(model => model.oauthProvider === 'openai');
  const revision = (await f.call('snapshot')).modelConfigRevision;
  await f.desktop.command('models.save', { provider: { id: account.providerId, models: [{ id: account.key.split('/')[1], model: account.model, supportsVision: false, thinkingLevel: 'low' }] }, expectedModelRevision: revision });
  const updated = (await f.call('snapshot')).models.find(model => model.key === account.key);
  assert.equal(updated.thinkingLevel, 'low'); assert.equal(updated.supportsVision, false);
  assert.equal((await f.desktop.command('models.test', { modelKey: account.key })).ok, true);
  assert.ok((await f.desktop.command('models.roles')).roles.some(role => role.name === 'oracle'));
  const publicData = JSON.stringify({ state: f.desktop.getState(), diagnostics: f.desktop.diagnostics(), snapshot: await f.call('snapshot'), server: await f.call('diagnostics') });
  assert.doesNotMatch(publicData, privateToken);
  assert.doesNotMatch(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), privateToken);
  assert.doesNotMatch(await fs.readFile(path.join(f.dataDir, 'oauth-credentials.json'), 'utf8'), privateToken);
  assert.doesNotMatch(await fs.readFile(path.join(f.desktopDir, 'bot/cache.json'), 'utf8'), privateToken);
  assert.equal(await fs.access(path.join(f.desktopDir, 'runtime-v2/oauth-credentials.json')).then(() => true, () => false), false);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.dataDir, 'oauth-credentials.json'))).mode & 0o777, 0o600);
  assert.ok(f.provider.requests.filter(request => /\/(responses|messages|chat\/completions)/.test(request.url)).every(request => request.headers.authorization !== 'Bearer oauth'));
});

test('Bot survives desktop disconnect and Host restart; refreshes once under concurrency; logout and reauthorization preserve keys and routing', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await f.login('openai');
  const model = (await f.call('snapshot')).models[0];
  const beforeId = (await f.call('oauth.prepare')).deviceId;
  await f.call('model.configure', { models: [], roleModels: { main: model.key }, expectedModelRevision: (await f.call('snapshot')).modelConfigRevision });
  await f.desktop.command('connection.disconnect');
  await f.restart();
  assert.equal((await f.call('oauth.prepare')).deviceId, beforeId);
  const credentials = createOAuthCredentials({ filePath: path.join(f.dataDir, 'oauth-credentials.json'), safeStorage: createLocalSecretStorage({ directory: path.join(f.dataDir, 'secrets') }) });
  const expires = (await credentials.read('openai')).expires;
  const now = Date.now;
  const count = () => f.provider.requests.filter(request => request.url.endsWith('/oauth/token') && request.body.includes('grant_type=refresh_token')).length;
  const before = count();
  Date.now = () => Math.max(expires + 1, now());
  try { await Promise.all([f.run(model.key, 'one'), f.run(model.key, 'two')]); }
  finally { Date.now = now; }
  assert.equal(count(), before + 1);
  await f.call('oauth.logout', { provider: 'openai' });
  assert.equal((await f.call('snapshot')).models[0].oauthConnected, false);
  const session = await f.call('session.create');
  await assert.rejects(f.call('flow.command', { id: session.id, command: { type: 'send', input: { inputId: 'logged-out', text: 'should fail' } } }), /账号已退出/);
  await f.desktop.command('connection.reconnect');
  await f.login('openai');
  assert.equal((await f.call('snapshot')).models[0].key, model.key);
  assert.equal((await f.call('snapshot')).roleModels.main, model.key);
  const result = await f.call('model.configure', { models: [{ ...(await f.call('snapshot')).models[0], modelKey: model.key, apiKey: 'overwrite' }], expectedModelRevision: (await f.call('snapshot')).modelConfigRevision, preserveCredentials: true });
  assert.equal(result.results[0].ok, false, 'account cannot be overwritten as a normal API Key');
});

test('cancel, wrong Bot identity and failed credential import preserve existing accounts', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.login('openai');
  const before = await fs.readFile(path.join(f.dataDir, 'oauth-credentials.json'), 'utf8');
  await assert.rejects(f.call('oauth.import', { provider: 'openai', credential: { access: 'invalid' } }), /授权凭据无效/);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'oauth-credentials.json'), 'utf8'), before);
  const fetch = globalThis.fetch;
  globalThis.fetch = (url, options) => new URL(String(url)).pathname === '/v1/models' ? Promise.resolve(new Response('test-refresh-rotated', { status: 401 })) : fetch(url, options);
  try {
    await assert.rejects(f.call('oauth.import', { provider: 'openai', credential: { type: 'oauth', access: 'rejected-access', refresh: 'rejected-refresh', expires: Date.now() + 600000, clientId: 'rejected-client' } }), error => /读取账号模型目录/.test(error.message) && /服务商拒绝了登录凭据/.test(error.message) && !error.message.includes('test-refresh-rotated'));
  } finally { globalThis.fetch = fetch; }
  assert.equal(await fs.readFile(path.join(f.dataDir, 'oauth-credentials.json'), 'utf8'), before);
  const rejected = { type: 'oauth', access: 'rejected-access', refresh: 'rejected-refresh', expires: Date.now() + 600000, clientId: 'rejected-client' };
  globalThis.fetch = (url, options) => new URL(String(url)).pathname === '/v1/models'
    ? Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('test-refresh-rotated'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) })) : fetch(url, options);
  try {
    await assert.rejects(f.call('oauth.import', { provider: 'openai', credential: rejected }), /读取账号模型目录.*服务器连接服务商超时/);
  } finally { globalThis.fetch = fetch; }
  globalThis.fetch = (url, options) => new URL(String(url)).pathname.endsWith('/responses')
    ? Promise.resolve(Response.json({ error: { code: 'unsupported_country_region_territory', message: 'test-refresh-rotated' } }, { status: 403 })) : fetch(url, options);
  try {
    await assert.rejects(f.call('oauth.import', { provider: 'openai', credential: rejected }), error => /验证模型连接.*出网地区/.test(error.message) && !error.message.includes('test-refresh-rotated'));
  } finally { globalThis.fetch = fetch; }
  assert.equal(await fs.readFile(path.join(f.dataDir, 'oauth-credentials.json'), 'utf8'), before);
  await assert.rejects(f.desktop.command('oauth.start', { provider: 'openai', expectedInstanceId: 'wrong-bot' }), /连接已更换/);
  const start = await f.desktop.command('oauth.start', { provider: 'anthropic' });
  const pending = await until(() => f.desktop.command('oauth.state'), value => value?.prompt);
  await f.desktop.command('oauth.cancel', { id: start.id });
  await assert.rejects(f.desktop.command('oauth.answer', { id: start.id, promptId: pending.prompt.id, value: 'copy_code' }), /结束/);
  assert.equal((await f.call('snapshot')).oauthAccounts.find(item => item.provider === 'anthropic').connected, false);
});
