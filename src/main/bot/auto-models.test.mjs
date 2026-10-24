import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProfileStore } from '../lib/model-profiles.mjs';
import { createBotHost } from './host.mjs';
import { createBotDesktopService } from './desktop-service.mjs';

const wait = async (read) => {
  const end = Date.now() + 5000;
  while (!await read()) {
    if (Date.now() > end) throw new Error('Automatic configuration timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-auto-models-'));
  const profiles = createProfileStore({ filePath: path.join(root, 'profiles.json'), env: {}, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
  } });
  const provider = { name: 'Local', baseUrl: 'https://fixture.invalid/v1', apiKey: 'FIXTURE-ONE', models: [{ model: 'first' }, { model: 'second' }] };
  const saved = await profiles.saveProvider(provider);
  const keys = saved.modelKeys;
  const requests = [], runs = new Map();
  const host = await createBotHost({ dataDir: path.join(root, 'host'), defaultDir: path.join(root, 'workspace'),
    validateModel: async config => { if (config.model === 'rejected') throw new Error('No access'); },
    executorFactory: ({ getModel }) => ({
      run(spec) { return new Promise(resolve => runs.set(spec.conversationId, {
        config: getModel(spec.envelope.modelPolicySnapshot.modelKey, spec.envelope.modelPolicySnapshot.revision), resolve,
      })); },
      async stop(id) { runs.get(id)?.resolve({ stopped: true }); }, decide: () => true,
      async close() { for (const run of runs.values()) run.resolve({ stopped: true }); },
    }),
  });
  let drop = false, network = true;
  const hello = await host.request('handshake');
  const transport = {
    probe: async () => ({ home: root, existing: true, bot: hello }),
    rpc: async (_host, method, params) => {
      if (!network) throw Object.assign(new Error('Offline'), { code: 'offline' });
      requests.push({ method, params: structuredClone(params) });
      // The client runs on Windows; the Host's /bin/sh residency probe runs on
      // Linux. Keep the real model/receipt store and replace only that OS boundary.
      const reply = process.platform === 'win32' && method === 'initialize.verify'
        ? {ok: true} : await host.request(method, params);
      if (process.platform === 'win32' && method === 'handshake') reply.configured = true;
      if (drop && method === 'model.sync') { drop = false; throw Object.assign(new Error('Lost receipt'), { code: 'needs-review' }); }
      return reply;
    },
  };
  const options = { userDataDir: path.join(root, 'desktop'), runner: {}, profiles, transport };
  let client = createBotDesktopService(options);
  const candidate = await client.connect({ host: 'fixture' });
  await client.initialize({ candidateId: candidate.candidate.id, modelKeys: [keys[0]] });
  const { id } = await client.command('session.create');
  await client.command('session.open', { id });
  const edit = async patch => {
    const directory = await profiles.list();
    const current = directory.providers[0];
    await profiles.saveProvider({ ...provider, ...current, apiKey: '', ...patch });
  };
  t.after(async () => { await client.close(); await host.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, profiles, keys, id, requests, runs, host, edit, get client() { return client; },
    dropNext: () => { drop = true; }, setNetwork: value => { network = value; },
    async restart() { await client.close(); client = createBotDesktopService(options); await client.refresh(); },
  };
}
test('initialization automatically configures local models and selecting an existing model never duplicates verification', async t => {
  const f = await fixture(t);
  assert.equal(f.client.getState().localModels.length, 2);
  assert.equal(f.client.getState().cache.models.length, 2);
  await Promise.all([f.client.command('session.update', { id: f.id, modelKey: f.keys[1] }), f.client.command('session.update', { id: f.id, modelKey: f.keys[1] })]);
  assert.equal(f.requests.filter(item => item.method === 'model.sync').length, 1);
  assert.equal(f.client.getState().cache.details[f.id].modelKey, f.keys[1]);

  assert.ok(!JSON.stringify(f.client.getState()).includes('FIXTURE-ONE'));
});
test('saving local credentials automatically rotates all initialized models while preserving frozen running versions', async t => {
  const f = await fixture(t);
  await f.client.command('flow.command', { id: f.id, command: { type: 'send', input: { inputId: 'first-input', text: 'Run' } } });
  await wait(() => f.runs.has(f.id));
  assert.equal(f.runs.get(f.id).config.apiKey, 'FIXTURE-ONE');
  await f.edit({ apiKey: 'FIXTURE-TWO' });
  await wait(() => f.requests.some(item => item.method === 'model.sync' && item.params.models[0].apiKey === 'FIXTURE-TWO'));
  await wait(() => f.client.getState().syncStatus?.phase === 'confirmed');
  assert.equal(f.client.getState().cache.models.length, 2);
  assert.equal(f.runs.get(f.id).config.apiKey, 'FIXTURE-ONE');
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'host/state.json'), 'utf8'));
  assert.equal(state.versions[state.models[f.keys[0]]].apiKey, 'FIXTURE-TWO');
  for (const name of await fs.readdir(path.join(f.root, 'desktop/bot'))) assert.ok(!(await fs.readFile(path.join(f.root, 'desktop/bot', name), 'utf8')).includes('FIXTURE-TWO'), name);
});
test('invalid updates keep the previous Host revision and block selecting the failed model until corrected', async t => {
  const f = await fixture(t), revision = f.client.getState().cache.models[0].revision;
  const directory = await f.profiles.list();
  await f.edit({ models: directory.providers[0].models.map((model, index) => index ? model : { ...model, model: 'rejected' }) });
  await wait(() => !!f.client.getState().modelConfigError);
  assert.equal(f.client.getState().cache.models[0].revision, revision);
  await assert.rejects(f.client.command('session.update', { id: f.id, modelKey: f.keys[0] }), /未能验证/);
  await f.edit({ models: directory.providers[0].models });
  await wait(() => !f.client.getState().modelConfigError && f.client.getState().syncStatus === null);
});
test('offline local changes reconcile automatically after reconnect; lost first-use replies are reconciled without resending secrets', async t => {
  const f = await fixture(t);
  await f.client.command('connection.disconnect'); f.setNetwork(false);
  await f.edit({ apiKey: 'FIXTURE-OFFLINE' });
  assert.equal(f.requests.filter(item => item.method === 'model.sync').length, 1);
  f.setNetwork(true); await f.client.command('connection.reconnect');
  await wait(() => f.requests.some(item => item.method === 'model.sync' && item.params.models[0].apiKey === 'FIXTURE-OFFLINE'));
  await wait(() => f.client.getState().syncStatus.phase === 'confirmed');
  await wait(() => f.client.getState().localModels.every(model => model.status === 'synced'));
  f.dropNext();
  const directory = await f.profiles.list();
  await f.edit({ models: directory.providers[0].models.map((model, index) => index === 1 ? { ...model, model: 'second-updated' } : model) });
  await wait(() => f.client.getState().syncStatus?.phase === 'unknown');
  const count = f.requests.filter(item => item.method === 'model.sync').length;
  await f.restart();
  await f.client.command('session.update', { id: f.id, modelKey: f.keys[1] });
  assert.equal(f.requests.filter(item => item.method === 'model.sync').length, count);
});
test('loopback and OAuth local models remain visible with reasons and never upload credentials', async t => {
  const f = await fixture(t);
  await f.edit({ baseUrl: 'http://127.0.0.1:11434/v1' });
  await wait(() => f.client.getState().localModels[0]?.reason === '本机地址不可用');
  await assert.rejects(f.client.command('session.update', { id: f.id, modelKey: f.keys[1] }), /本机地址/);
  assert.equal(f.requests.filter(item => item.method === 'model.sync').length, 1);
  await f.profiles.saveOAuthProvider('openai', [{ id: 'account-model', baseUrl: 'https://account.invalid', api: 'openai-responses', input: ['text'] }]);
  await wait(() => f.client.getState().localModels.some(model => model.auth === '账号登录'));
  const account = f.client.getState().localModels.find(model => model.auth === '账号登录');
  assert.match(account.reason, /账号授权/);
  await assert.rejects(f.client.command('session.update', { id: f.id, modelKey: account.key }), /账号授权/);
});

test('a rejected first-use model never changes the conversation; configuration saved while closed updates automatically on restart', async t => {
  const f = await fixture(t), directory = await f.profiles.list();
  await f.edit({ models: directory.providers[0].models.map((model, index) => index === 1 ? { ...model, model: 'rejected' } : model) });
  await assert.rejects(f.client.command('session.update', { id: f.id, modelKey: f.keys[1] }), /未能验证/);
  assert.equal(f.client.getState().cache.details[f.id].modelKey, f.keys[0]);
  assert.equal(f.client.getState().cache.models.length, 2);
  await f.client.close();
  await f.edit({ apiKey: 'FIXTURE-RESTARTED' });
  await f.restart();
  await wait(async () => {
    const state = JSON.parse(await fs.readFile(path.join(f.root, 'host/state.json'), 'utf8'));
    return state.versions[state.models[f.keys[0]]].apiKey === 'FIXTURE-RESTARTED';
  });
});


test('local main, role and fallback edits automatically update the Host policy; new models are provisioned and removed local entries disappear', async t => {
  const f = await fixture(t);
  await f.profiles.saveRoleModel({ main: f.keys[0] });
  await f.profiles.saveRoleModel({ explorer: f.keys[1] });
  await f.profiles.saveRoleModel({ fallback: f.keys[1] });
  await wait(() => f.client.getState().cache.roleModels?.fallback === f.keys[1]);
  await f.client.command('session.update', { id: f.id, modelKey: 'auto' });
  assert.equal(f.client.getState().cache.details[f.id].modelKey, 'auto');
  await f.profiles.saveRoleModel({ main: f.keys[1] });
  await wait(() => f.client.getState().cache.roleModels?.main === f.keys[1]);
  const beforeFailure = await f.profiles.list();
  await f.edit({ models: beforeFailure.providers[0].models.map((model, index) => index === 1 ? { ...model, model: 'rejected' } : model) });
  await wait(() => f.client.getState().modelConfigError.includes('自动路由'));
  await f.edit({ models: beforeFailure.providers[0].models });
  await wait(() => !f.client.getState().modelConfigError && f.client.getState().syncStatus === null);

  const directory = await f.profiles.list();
  await f.edit({ models: [...directory.providers[0].models, { model: 'third' }] });
  await wait(() => f.client.getState().cache.models.some(model => model.model === 'third'));
  await f.profiles.saveRoleModel({ explorer: null });
  await f.edit({ models: [directory.providers[0].models[1]] });
  await wait(() => f.client.getState().cache.models.length === 1);
  assert.equal(f.client.getState().cache.models[0].key, f.keys[1]);
  assert.equal(f.client.getState().cache.models[0].source, 'local');
});
