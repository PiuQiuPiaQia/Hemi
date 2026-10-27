import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOAuthCredentials } from './oauth-credentials.mjs';
import { createOAuthModels, setOAuthRuntime } from './oauth-models.mjs';
import { createOAuthLogin } from './oauth-login.mjs';
import { createProfileStore } from '../lib/model-profiles.mjs';
import { chatTurn, pingTextModel } from './text-model.mjs';
import { answerAboutImage } from './vision-model.mjs';
import { createHemiSession } from '../agent/hemi-session.mjs';
import { freezeModelPolicy, hydrateModelPlan, resolveModelPlan } from '../agent-runtime/model-policy.mjs';
import { startOAuthTestServer, waitForOAuth } from '../../../scripts/oauth-test-fixture.mjs';

function encryption() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    decryptString(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(-16)); return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString('utf8'); },
  };
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hemi-oauth-test-'));
  const transport = await startOAuthTestServer();
  globalThis.fetch = transport.fetch;
  const safeStorage = encryption(), filePath = path.join(dir, 'oauth.json');
  const credentials = createOAuthCredentials({ filePath, safeStorage });
  const runtime = createOAuthModels(credentials);
  setOAuthRuntime(runtime);
  const profiles = createProfileStore({ filePath: path.join(dir, 'models.json'), safeStorage, oauth: runtime, env: {} });
  const urls = [];
  const login = createOAuthLogin({ runtime, credentials, profiles, openExternal: async raw => {
    const url = new URL(raw); urls.push(url);
    if (url.hostname === 'auth.openai.com') {
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.search = new URLSearchParams({ code: 'test-auth-code', state: url.searchParams.get('state'), client_id: 'test-issued-client' });
      await transport.originalFetch(callback);
    }
  } });
  t.after(async () => { login.dispose(); globalThis.fetch = transport.originalFetch; setOAuthRuntime(null); await transport.close(); await rm(dir, { recursive: true, force: true }); });
  const state = predicate => waitForOAuth(() => login.getState(), predicate);
  async function connect(provider) {
    const start = await login.start(provider);
    if (provider === 'anthropic') {
      const select = await state(s => s?.prompt?.type === 'select');
      login.answer({ id: start.id, promptId: select.prompt.id, value: 'copy_code' });
      const manual = await state(s => s?.prompt?.type === 'manual_code');
      login.answer({ id: start.id, promptId: manual.prompt.id, value: `test-claude-code#${urls.at(-1).searchParams.get('state')}` });
    } else if (provider === 'github-copilot') {
      const domain = await state(s => s?.prompt?.type === 'text');
      login.answer({ id: start.id, promptId: domain.prompt.id, value: '' });
    }
    const finished = await state(s => s?.phase !== 'login');
    assert.equal(finished.phase, 'success', `${provider}: ${finished.message}`);
    return finished;
  }
  return { dir, filePath, safeStorage, transport, credentials, runtime, profiles, login, urls, state, connect };
}

test('四家真实 SDK OAuth → 加密存储 → 账号目录 → 主对话与轻量/看图请求', async t => {
  const f = await fixture(t);
  for (const provider of ['openai', 'anthropic', 'github-copilot', 'bigmodel']) {
    await f.connect(provider);
    const directory = await f.profiles.list();
    const account = directory.providers.find(item => item.oauthProvider === provider);
    assert.equal(account.hasApiKey, true);
    if (provider === 'openai') assert.deepEqual(account.models.map(model => model.model), ['gpt-4.1']);
    if (provider === 'github-copilot') assert.deepEqual(new Set(account.models.map(model => model.model)), new Set(['gpt-5-mini', 'claude-sonnet-5.5']));
    const config = await f.profiles.get(account.models[0].modelKey);
    assert.equal(config.apiKey, 'oauth');
    for (const entry of account.models) {
      const resolved = await f.profiles.get(entry.modelKey);
      assert.equal(resolved.api, f.runtime.models.getModel(provider, entry.model).api);
    }
    const result = await chatTurn({ ...config, messages: [{ role: 'user', content: 'hello' }], thinkingLevel: 'off', maxPreStreamRetries: 0 });
    assert.equal(result.content, 'OAuth OK');
    const session = createHemiSession({ cwd: f.dir, agentDir: path.join(f.dir, 'agent'), model: config, tools: [], features: {}, settings: { retry: { enabled: false } } });
    try { const reply = await session.prompt('Hello OAuth'); assert.equal(reply.modelError, null); assert.ok(reply.texts.join('').includes('OAuth OK')); }
    finally { session.dispose(); }
    if (config.supportsVision) assert.equal(await answerAboutImage({ ...config, imageData: 'QQ==', mimeType: 'image/png', question: 'what' }), 'OAuth OK');
    assert.equal((await pingTextModel(config)).ok, true);
    assert.equal((await pingTextModel({ ...config, requireTools: true })).ok, true);
    const request = f.transport.requests.findLast(request => /\/(responses|messages|chat\/completions)/.test(request.url));
    assert.ok(request.headers.authorization?.startsWith('Bearer '));
    assert.notEqual(request.headers.authorization, 'Bearer oauth');
    if (provider === 'openai') { assert.equal(JSON.parse(request.body).store, false); assert.equal(JSON.parse(request.body).stream, true); }
    const publicData = JSON.stringify({ directory, snapshot: await freezeModelPolicy({ store: f.profiles, modelKey: config.modelKey }) });
    assert.doesNotMatch(publicData, /test-access|test-refresh|test-github-token/);
  }
  const disk = await readFile(f.filePath, 'utf8');
  assert.doesNotMatch(disk, /test-access|test-refresh|test-github-token/);
  // Windows does not honor POSIX permission bits, so the 0600 mode is best-effort there.
  if (process.platform !== 'win32') assert.equal((await stat(f.filePath)).mode & 0o777, 0o600);
  const restarted = createOAuthCredentials({ filePath: f.filePath, safeStorage: f.safeStorage });
  assert.equal((await restarted.read('openai')).clientId, 'test-issued-client');
  assert.equal(await restarted.deviceId(), await f.credentials.deviceId());
});

test('刷新并发互斥；退出使既有冻结计划失效；重登保留模型键与路由', async t => {
  const f = await fixture(t); await f.connect('openai');
  const initial = await f.profiles.list(), key = initial.defaultModelId;
  await f.profiles.saveRoleModel({ main: key });
  const snapshot = await freezeModelPolicy({ store: f.profiles, modelKey: 'auto' });
  const plan = await hydrateModelPlan(resolveModelPlan(snapshot), f.profiles);
  const routed = createHemiSession({ cwd: f.dir, agentDir: path.join(f.dir, 'routed'), routing: { execution: plan.primary, fallbacks: [] }, tools: [], features: {} });
  try { assert.ok((await routed.prompt('OAuth routed')).texts.join('').includes('OAuth OK')); }
  finally { routed.dispose(); }
  await f.credentials.modify('openai', async current => ({ ...current, expires: 0 }));
  const before = f.transport.requests.filter(request => request.url.endsWith('/oauth/token')).length;
  await Promise.all(Array.from({ length: 4 }, () => f.runtime.models.getAuth('openai')));
  assert.equal(f.transport.requests.filter(request => request.url.endsWith('/oauth/token')).length, before + 1);
  assert.deepEqual((await f.runtime.catalog('openai')).map(model => model.id), ['gpt-4.1']);
  await f.login.logout('openai');
  assert.equal((await f.profiles.list()).providers[0].hasApiKey, false);
  await assert.rejects(hydrateModelPlan(resolveModelPlan(snapshot), f.profiles), /重新登录/);
  await f.connect('openai');
  const next = await f.profiles.list(); assert.equal(next.defaultModelId, key); assert.equal(next.roleModels.main, key);
  assert.equal((await f.profiles.resolve({ decryptSecrets: false })).hasApiKey, true);
  await assert.rejects(f.profiles.saveProvider({ ...next.providers[0], apiKey: 'malicious', models: next.providers[0].models }), /重新登录/);
});

test('取消/过期 prompt/超时与原始认证错误不会暴露 token', async t => {
  const f = await fixture(t);
  const op = await f.login.start('anthropic');
  const step = await f.state(s => s?.prompt);
  await assert.rejects(f.login.start('openai'), /取消/);
  await f.login.cancel(op.id);
  assert.equal(f.login.getState().phase, 'cancelled');
  assert.throws(() => f.login.answer({ id: op.id, promptId: step.prompt.id, value: 'browser' }), /结束/);
  assert.equal((await f.credentials.list()).length, 0);
  const callbackLogin = createOAuthLogin({ runtime: f.runtime, credentials: f.credentials, profiles: f.profiles, openExternal: async () => {} });
  const callbackOp = await callbackLogin.start('openai');
  await waitForOAuth(() => callbackLogin.getState(), state => state?.prompt?.type === 'manual_code');
  await callbackLogin.cancel(callbackOp.id);
  await f.connect('openai'); // the real SDK callback port must have been released
  const errorLogin = createOAuthLogin({ runtime: { models: { login: async () => { throw new Error('secret=test-refresh raw provider response'); } } }, credentials: f.credentials, profiles: f.profiles, openExternal: async () => {} });
  await errorLogin.start('openai');
  const failed = await waitForOAuth(() => errorLogin.getState(), s => s?.phase === 'failed');
  assert.doesNotMatch(JSON.stringify(failed), /test-refresh|raw provider/);
  const short = createOAuthLogin({ runtime: f.runtime, credentials: f.credentials, profiles: f.profiles, openExternal: async () => {}, timeoutMs: 30 });
  await short.start('anthropic');
  assert.match((await waitForOAuth(() => short.getState(), s => s?.phase === 'cancelled')).message, /超时/);
});

test('无法加密时拒绝保存；现有密文不被覆盖', async t => {
  const f = await fixture(t); await f.connect('openai');
  const before = await readFile(f.filePath, 'utf8');
  const locked = createOAuthCredentials({ filePath: f.filePath, safeStorage: { isEncryptionAvailable: () => false } });
  await assert.rejects(locked.modify('openai', async () => ({ type: 'oauth', access: 'new', refresh: 'new', expires: 0 })), /本机存储不可用/);
  assert.equal(await readFile(f.filePath, 'utf8'), before);
});

test('账号状态与偏好保存不访问加密 API；删除供应商同时退出账号', async t => {
  const f = await fixture(t); await f.connect('openai'); await f.connect('github-copilot');
  const before = await f.profiles.list();
  const account = before.providers.find(provider => provider.oauthProvider === 'openai');
  let accesses = 0;
  for (const name of ['isEncryptionAvailable', 'encryptString', 'decryptString']) {
    const original = f.safeStorage[name]; f.safeStorage[name] = (...args) => { accesses++; return original(...args); };
  }
  await f.profiles.list(); await f.profiles.resolve({ decryptSecrets: false });
  await f.profiles.saveProvider({ ...account, name: 'ChatGPT renamed', models: account.models });
  assert.equal(accesses, 0);
  const replacement = before.providers.find(provider => provider.oauthProvider === 'github-copilot').models[0].modelKey;
  await f.profiles.removeProvider({ providerId: account.id, replacementModelId: replacement });
  assert.equal(await f.runtime.connected('openai'), false);
});

test('original pi-memory exit hook uses all four SDK OAuth credential paths without alias-key fallback', {timeout:60000}, async t => {
  const f = await fixture(t);
  const fs = await import('node:fs/promises');
  const values = {PI_MEMORY_DIR:path.join(f.dir,'pi-memory'),PI_MEMORY_QMD_UPDATE:'off',PI_MEMORY_EXIT_SUMMARY:'1',PI_MEMORY_NO_SEARCH:'1',PI_MEMORY_SNAPSHOT:'per-turn'};
  const previous = Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]])); Object.assign(process.env,values);
  t.after(()=>{for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  for(const provider of ['openai','anthropic','github-copilot','bigmodel']) {
    await f.connect(provider);
    const account=(await f.profiles.list()).providers.find(item=>item.oauthProvider===provider);
    const config=await f.profiles.get(account.models[0].modelKey);
    for (const mode of ['fixed', 'routed']) {
    const selection=mode==='fixed'?{model:config}:{routing:{execution:config,fallbacks:[]}};
    const session=createHemiSession({cwd:f.dir,agentDir:path.join(f.dir,'memory-agent'),...selection,nativeMemory:true,tools:[],features:{},settings:{retry:{enabled:false}}});
    try {
      for(const text of ['First decision','Second decision'])assert.equal((await session.prompt(text)).modelError,null);
      const normal=f.transport.requests.at(-1);
      const before=f.transport.requests.length; await session.close();
      const summaries=f.transport.requests.slice(before).filter(request=>request.body.includes('Review the conversation and extract'));
      assert.equal(summaries.length,1,provider+' must issue the original plugin summary request');
      assert.equal(summaries[0].headers.authorization,normal.headers.authorization,provider+' '+mode+' native summary must preserve OAuth authorization');
      assert.equal(summaries[0].headers['x-api-key'],normal.headers['x-api-key'],provider+' native summary must preserve the SDK auth header');
      assert.notEqual(summaries[0].headers.authorization,'Bearer oauth');
      const files=await fs.readdir(path.join(values.PI_MEMORY_DIR,'daily'));
      const daily=await fs.readFile(path.join(values.PI_MEMORY_DIR,'daily',files[0]),'utf8');
      assert.match(daily,/OAuth OK|BigModel/);
    } finally { await session.close('reload'); }
    }
  }
});
