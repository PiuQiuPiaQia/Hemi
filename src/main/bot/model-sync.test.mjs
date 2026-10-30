import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProfileStore } from '../lib/model-profiles.mjs';
import { createBotHost } from './host.mjs';
import { createBotDesktopService } from './desktop-service.mjs';

const wait = async (read) => {
  const end = Date.now() + 5000;
  while (!await read()) {
    if (Date.now() > end) throw new Error('Model operation timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
async function fixture(t, { routing = false, count = 2, configureBotRouting = routing, modelPreviewTimeoutMs } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-model-sync-'));
  const profiles = createProfileStore({ filePath: path.join(root, 'profiles.json'), env: {}, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
  } });
  const provider = { name: 'Local', baseUrl: 'https://fixture.invalid/v1', apiKey: 'FIXTURE-ONE', models: Array.from({ length: count }, (_, index) => ({ model: ['first', 'second'][index] ?? 'model-' + index })) };
  const saved = await profiles.saveProvider(provider);
  const keys = saved.modelKeys;
  if (routing) {
    await profiles.saveRoleModel({ main: keys[0] });
    await profiles.saveRoleModel({ explorer: keys[1] });
    await profiles.saveRoleModel({ fallback: keys[1] });
  }
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
  let drop = false, network = true, legacy = false, refreshBeforeReply = false;
  const changes = [];
  const transport = {
    probe: async () => ({ home: root, existing: true, bot: await host.request('handshake') }),
    rpc: async (_host, method, params) => {
      if (!network) throw Object.assign(new Error('Offline'), { code: 'offline' });
      requests.push({ method, params: structuredClone(params) });
      if (legacy && method === 'model.configure') throw Object.assign(new Error('Unsupported method'), { code: 'unsupported' });
      // 客户端与 Host 同机运行：initialize.verify 的驻留探针在 host.mjs 内已有
      // Windows 原生分支（process.execPath），必须真实执行才能持久化 state.initialized；
      // 短路成 {ok:true} 会让重连绑定（existing:true）的守卫永远失败。
      const reply = await host.request(method, params);
      if (refreshBeforeReply && method === 'model.configure') await client.refresh();
      if (drop && method === 'model.configure') { drop = false; throw Object.assign(new Error('Lost receipt'), { code: 'needs-review' }); }
      return reply;
    },
  };
  const options = { userDataDir: path.join(root, 'desktop'), runner: {}, profiles, transport, modelPreviewTimeoutMs, onChanged: state => changes.push(state) };
  let client = createBotDesktopService(options);
  const candidate = await client.connect({ host: 'fixture' });
  await client.initialize({ candidateId: candidate.candidate.id });
  const initialized = client.getState().cache;
  if (configureBotRouting) {
    await host.request('model.configure', { instanceId: initialized.instanceId, requestId: 'bot-routing-setup', models: [],
      roleModels: { main: keys[0], explorer: keys[1], fallback: keys[1] }, expectedModelRevision: initialized.modelConfigRevision });
    await client.refresh();
  }
  const { id } = await client.command('session.create');
  await client.command('session.open', { id });
  const edit = async patch => {
    const directory = await profiles.list();
    const current = directory.providers[0];
    await profiles.saveProvider({ ...provider, ...current, apiKey: '', ...patch });
  };
  t.after(async () => { await client.close(); await host.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, profiles, keys, id, requests, runs, host, edit, changes, initialized, refreshBeforeReply: () => { refreshBeforeReply = true; }, get client() { return client; },
    dropNext: () => { drop = true; }, setNetwork: value => { network = value; }, setLegacy: () => { legacy = true; },
    async restart(patch = {}) { await client.close(); Object.assign(options, patch); client = createBotDesktopService(options); await client.refresh(); },
  };
}
const syncCount = f => f.requests.filter(item => ['model.sync', 'model.sync-local', 'model.configure'].includes(item.method)).length;
const privateState = f => JSON.parse(readFileSync(path.join(f.root, 'host/state.json'), 'utf8'));
const syncAll = async f => {
  const preview = await f.client.command('models.diff');
  const selected = preview.changes.filter(change => change.canSync && !(change.action === 'remove' && f.client.getState().cache.models.find(model => model.key === change.modelKey)?.source === 'cloud')).map(change => change.id);
  return f.client.command('models.sync', { previewId: preview.id, selected });
};


test('first initialization copies available models without importing local automatic routing', async t => {
  const f = await fixture(t, { routing: true, configureBotRouting: false });
  assert.equal(f.client.getState().cache.models.length, 2);
  assert.deepEqual(f.client.getState().cache.roleModels, {});
  assert.equal(f.client.getState().cache.details[f.id].modelKey, f.keys[0]);
  assert.equal(f.requests.find(item => item.method === 'model.sync-local').params.roleModels, undefined);
  await Promise.all([f.client.command('session.update', { id: f.id, modelKey: f.keys[1] }), f.client.command('session.update', { id: f.id, modelKey: f.keys[1] })]);
  assert.equal(syncCount(f), 1);
  assert.ok(!f.requests.some(item => item.method === 'model.local-config'));
  assert.ok(!JSON.stringify(f.client.getState()).includes('FIXTURE-ONE'));
});

test('Host local snapshot imports ignore legacy route payloads and preserve independently configured Bot routing', async t => {
  const f = await fixture(t, { routing: true });
  const before = f.client.getState().cache;
  const configs = await Promise.all(f.keys.map(async key => (await f.profiles.resolveStrict(key)).config));
  await f.host.request('model.sync-local', { instanceId: before.instanceId, requestId: 'legacy-route-copy',
    models: configs, roleModels: { main: f.keys[1] } });
  await f.client.refresh();
  assert.deepEqual(f.client.getState().cache.roleModels, before.roleModels);
});

test('saving, refreshing, selecting and sending use the saved Bot model until manual synchronization', async t => {
  const f = await fixture(t);
  await f.edit({ apiKey: 'FIXTURE-TWO' });
  await f.client.refresh();
  await f.client.command('session.update', { id: f.id, modelKey: f.keys[1] });
  await f.client.command('flow.command', { id: f.id, command: { type: 'send', input: { inputId: 'first-input', text: 'Run' } } });
  await wait(() => f.runs.has(f.id));
  assert.equal(syncCount(f), 1);
  assert.equal(f.runs.get(f.id).config.apiKey, 'FIXTURE-ONE');
  const result = await syncAll(f);
  assert.ok(result.results.every(model => model.ok));
  assert.equal(syncCount(f), 2);
  assert.equal(f.runs.get(f.id).config.apiKey, 'FIXTURE-ONE', 'running input keeps its frozen version');
  const state = privateState(f);
  for (const key of f.keys) assert.equal(state.versions[state.models[key]].apiKey, 'FIXTURE-TWO');
  for (const name of await fs.readdir(path.join(f.root, 'desktop/bot'))) assert.ok(!readFileSync(path.join(f.root, 'desktop/bot', name), 'utf8').includes('FIXTURE-TWO'), name);
});

test('reconnect, restart and binding to an existing Bot never overwrite its catalog or routing', async t => {
  const f = await fixture(t, { routing: true });
  await f.client.command('connection.disconnect'); f.setNetwork(false);
  await f.edit({ apiKey: 'FIXTURE-OFFLINE' });
  await f.profiles.saveRoleModel({ main: f.keys[1] });
  f.setNetwork(true); await f.client.command('connection.reconnect');
  await f.restart();
  const candidate = await f.client.connect({ host: 'fixture' });
  await f.client.initialize({ candidateId: candidate.candidate.id, existing: true });
  assert.equal(syncCount(f), 1);
  assert.equal(f.client.getState().cache.roleModels.main, f.keys[0]);
  const state = privateState(f);
  assert.equal(state.versions[state.models[f.keys[0]]].apiKey, 'FIXTURE-ONE');
  await syncAll(f);
  assert.equal(f.client.getState().cache.roleModels.main, f.keys[0]);
});

test('failed manual synchronization preserves the complete catalog and routing, and correction needs another click', async t => {
  const f = await fixture(t, { routing: true }), before = f.client.getState().cache;
  const directory = await f.profiles.list();
  await f.edit({ apiKey: 'FIXTURE-TWO', models: directory.providers[0].models.map((model, index) => index ? model : { ...model, model: 'rejected' }) });
  await f.profiles.saveRoleModel({ main: f.keys[1] });
  const result = await syncAll(f);
  assert.ok(result.results.every(model => !model.ok));
  assert.deepEqual(f.client.getState().cache.models, before.models);
  assert.deepEqual(f.client.getState().cache.roleModels, before.roleModels);
  await f.client.command('session.update', { id: f.id, modelKey: f.keys[0] });
  await f.edit({ models: directory.providers[0].models });
  await f.client.refresh();
  assert.equal(syncCount(f), 2);
  assert.deepEqual(f.client.getState().cache.models, before.models);
  await syncAll(f);
  assert.equal(f.client.getState().cache.roleModels.main, f.keys[0]);
  assert.notEqual(f.client.getState().cache.models[0].revision, before.models[0].revision);
});

test('lost manual sync replies reconcile the model and routing together without resending credentials', async t => {
  const f = await fixture(t, { routing: true });
  await f.edit({ apiKey: 'FIXTURE-LOST-REPLY' });
  await f.profiles.saveRoleModel({ main: f.keys[1] });
  f.dropNext();
  await assert.rejects(syncAll(f), /Lost receipt/);
  assert.equal(f.client.getState().syncStatus.phase, 'unknown');
  await assert.rejects(f.client.command('models.sync'), /正在确认/);
  await f.restart();
  assert.equal(syncCount(f), 2);
  assert.equal(f.client.getState().syncStatus.phase, 'confirmed');
  assert.equal(f.client.getState().cache.roleModels.main, f.keys[0]);
  const state = privateState(f);
  assert.equal(state.versions[state.models[f.keys[0]]].apiKey, 'FIXTURE-LOST-REPLY');
});

test('adding and deleting local models propagates only on manual sync and preserves independent cloud models', async t => {
  const f = await fixture(t, { routing: true });
  await f.client.command('models.add', { provider: { name: 'Cloud', baseUrl: 'https://cloud.invalid/v1', apiKey: 'CLOUD-ONLY', models: [{ model: 'cloud-only' }] } });
  const cloud = f.client.getState().cache.models.find(model => model.source === 'cloud');
  const directory = await f.profiles.list();
  await f.edit({ models: [...directory.providers[0].models, { model: 'third' }] });
  await f.client.refresh();
  const newModel = (await f.client.modelCandidates()).find(model => model.name === 'third');
  await assert.rejects(f.client.command('session.update', { id: f.id, modelKey: newModel.key }));
  assert.equal(syncCount(f), 2, 'selecting an unsynced model never uploads it');
  await syncAll(f);
  assert.equal(f.client.getState().cache.models.length, 4);
  await f.profiles.saveRoleModel({ main: f.keys[1] });
  await f.profiles.saveRoleModel({ explorer: null });
  await f.edit({ models: [directory.providers[0].models[1]] });
  await f.client.refresh();
  assert.equal(f.client.getState().cache.models.length, 4);
  await f.client.command('models.routing', { roleModels: { main: f.keys[1], explorer: null }, expectedModelRevision: f.client.getState().cache.modelConfigRevision });
  await syncAll(f);
  assert.deepEqual(f.client.getState().cache.models.map(model => model.key).sort(), [f.keys[1], cloud.key].sort());
  assert.deepEqual(f.client.getState().cache.roleModels, { main: f.keys[1], fallback: f.keys[1] });

});

test('local endpoints stay unavailable while subscription accounts offer independent Bot authorization', async t => {
  const f = await fixture(t);
  await f.edit({ baseUrl: 'http://127.0.0.1:11434/v1' });
  await f.profiles.saveOAuthProvider('openai', [{ id: 'account-model', baseUrl: 'https://account.invalid', api: 'openai-responses', input: ['text'] }]);
  const candidates = await f.client.modelCandidates();
  assert.match(candidates.find(model => model.key === f.keys[0]).reason, /本机地址/);
  assert.match(candidates.find(model => model.auth === '账号登录').reason, /单独登录账号/);
  const preview = await f.client.command('models.diff');
  const accounts = preview.changes.filter(change => change.kind === 'account');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].oauthProvider, 'openai');
  assert.equal(accounts[0].canSync, false, 'authorization uses its own login flow, never a copied local credential');
  await assert.rejects(f.client.command('models.sync', { previewId: preview.id, selected: [accounts[0].id] }), /不可用/);
  await f.client.command('session.update', { id: f.id, modelKey: f.keys[1] });
  await f.client.refresh();
  assert.equal(syncCount(f), 1);
});

test('unreadable local profiles do not affect existing conversations or permit overwriting the Bot snapshot', async t => {
  const f = await fixture(t), before = f.client.getState().cache.models;
  f.profiles.list = async () => ({ corrupt: true, providers: [] });
  await f.client.refresh();
  await f.client.command('session.update', { id: f.id, modelKey: f.keys[1] });
  await assert.rejects(syncAll(f), /无法读取/);
  assert.deepEqual(f.client.getState().cache.models, before);
  assert.equal(syncCount(f), 1);
});

test('a single initial sync handles more than fifty models without importing routing', async t => {
  const f = await fixture(t, { routing: true, count: 55 });
  assert.equal(syncCount(f), 1);
  assert.equal(f.client.getState().cache.models.length, 55);
  assert.deepEqual(f.initialized.roleModels, {});
});

test('older components reject the new sync operation without falling back to a partial model-only update', async t => {
  const f = await fixture(t, { routing: true }), before = privateState(f);
  await f.edit({ apiKey: 'FIXTURE-TWO' });
  f.setLegacy();
  await assert.rejects(syncAll(f), /维护云端组件/);
  assert.deepEqual(privateState(f).models, before.models);
  assert.deepEqual(privateState(f).roleModels, before.roleModels);
  assert.ok(!f.requests.some(item => item.method === 'model.sync'));
});

test('preview shows models without routes or secrets; local route edits do not invalidate it', async t => {
  const f = await fixture(t, { routing: true }), before = f.client.getState().cache;
  await f.edit({ apiKey: 'FIXTURE-SELECTIVE', models: (await f.profiles.list()).providers[0].models.map((model, index) => index ? { ...model, model: 'second-new' } : model) });
  await f.profiles.saveRoleModel({ main: f.keys[1] });
  const preview = await f.client.command('models.diff');
  assert.equal(syncCount(f), 1);
  assert.equal(preview.changes.length, 2);
  assert.ok(preview.changes.every(change => change.kind === 'model'));
  await f.profiles.saveRoleModel({ explorer: f.keys[0] });
  assert.ok(!JSON.stringify(preview).includes('FIXTURE-SELECTIVE'));
  await f.client.command('models.sync', { previewId: preview.id, selected: ['model:' + f.keys[0]] });
  const state = f.client.getState().cache;
  assert.notEqual(state.models[0].revision, before.models[0].revision);
  assert.equal(state.models[1].revision, before.models[1].revision);
  assert.deepEqual(state.roleModels, before.roleModels);
});

test('Bot models imported from local profiles and all routing slots can be edited without changing local profiles', async t => {
  const f = await fixture(t, { routing: true }), localBefore = await f.profiles.list();
  const first = f.client.getState().cache.models[0];
  await f.client.command('models.save', { expectedModelRevision: f.client.getState().cache.modelConfigRevision,
    provider: { id: first.providerId, name: 'Bot edited', baseUrl: first.baseUrl, api: first.api,
      models: f.client.getState().cache.models.map(model => ({ id: model.key.split('/')[1], model: model.key === first.key ? 'bot-edited' : model.model })) } });
  assert.deepEqual(await f.profiles.list(), localBefore);
  const privateBot = privateState(f);
  assert.equal(privateBot.versions[privateBot.models[first.key]].apiKey, 'FIXTURE-ONE');
  await f.client.command('models.routing', { expectedModelRevision: f.client.getState().cache.modelConfigRevision, roleModels: { main: f.keys[1], designer: f.keys[0], fallback: null } });
  assert.deepEqual(await f.profiles.list(), localBefore);
  assert.equal(f.client.getState().cache.roleModels.main, f.keys[1]);
  assert.equal(f.client.getState().cache.roleModels.designer, f.keys[0]);
  const preview = await f.client.command('models.diff');
  assert.ok(preview.changes.some(change => change.modelKey === first.key && change.action === 'update'));
});

test('changed local or Bot configuration invalidates a preview instead of overwriting unseen changes', async t => {
  const f = await fixture(t, { routing: true });
  await f.edit({ apiKey: 'FIXTURE-PREVIEW' });
  let preview = await f.client.command('models.diff');
  await f.edit({ apiKey: 'FIXTURE-AFTER-PREVIEW' });
  await assert.rejects(f.client.command('models.sync', { previewId: preview.id, selected: ['model:' + f.keys[0]] }), /本机配置已变化/);
  preview = await f.client.command('models.diff');
  await f.client.command('models.routing', { expectedModelRevision: f.client.getState().cache.modelConfigRevision, roleModels: { main: f.keys[1] } });
  await assert.rejects(f.client.command('models.sync', { previewId: preview.id, selected: ['model:' + f.keys[0]] }), /Bot 模型或路由已变化/);
});

test('new models never import their local route, and removing models used by Bot routes is rejected', async t => {
  const f = await fixture(t, { routing: true });
  const directory = await f.profiles.list();
  const saved = await f.profiles.saveProvider({ ...directory.providers[0], apiKey: '', models: [...directory.providers[0].models, { model: 'third' }] });
  const third = saved.modelKeys[2];
  await f.profiles.saveRoleModel({ main: third });
  let preview = await f.client.command('models.diff');
  assert.ok(!preview.changes.some(change => change.id === 'role:main'));
  await assert.rejects(f.client.command('models.sync', { previewId: preview.id, selected: ['role:main'] }), /不可用/);
  await f.client.command('models.sync', { previewId: preview.id, selected: ['model:' + third] });
  assert.equal(f.client.getState().cache.roleModels.main, f.keys[0]);
  await f.client.command('models.routing', { roleModels: { main: third }, expectedModelRevision: f.client.getState().cache.modelConfigRevision });
  await f.edit({ models: directory.providers[0].models });
  // The profile store retains the invalid route reference until the user changes it.
  preview = await f.client.command('models.diff');
  const before = f.client.getState().cache.models;
  await assert.rejects(f.client.command('models.sync', { previewId: preview.id, selected: ['model:' + third] }), /原路由保留/);
  assert.deepEqual(f.client.getState().cache.models, before);
});

test('a model receipt publishes its final phase even when realtime already refreshed the new catalog', async t => {
  const f = await fixture(t);
  await f.edit({ apiKey: 'FIXTURE-REALTIME-RACE' });
  f.refreshBeforeReply();
  await syncAll(f);
  assert.equal(f.changes.at(-1).syncStatus.phase, 'confirmed');
  assert.ok(f.changes.some(state => state.syncStatus?.phase === 'sending'));
});

test('concurrent preview reads keep each returned selection usable', async t => {
  const f = await fixture(t);
  await f.edit({ apiKey: 'FIXTURE-CONCURRENT-PREVIEWS' });
  const [first, second] = await Promise.all([f.client.command('models.diff'), f.client.command('models.diff')]);
  assert.notEqual(first.id, second.id);
  const result = await f.client.command('models.sync', { previewId: first.id, selected: ['model:' + f.keys[0]] });
  assert.ok(result.results.every(model => model.ok));
});

test('preview uses the already received Bot model version without another SSH snapshot', async t => {
  const f = await fixture(t);
  await f.edit({ apiKey: 'FIXTURE-PREVIEW-NO-SSH' });
  const reads = f.requests.filter(item => item.method === 'snapshot').length;
  const before = privateState(f);
  f.setNetwork(false);
  const preview = await f.client.command('models.diff');
  assert.ok(preview.changes.some(change => change.modelKey === f.keys[0]));
  assert.equal(f.requests.filter(item => item.method === 'snapshot').length, reads);
  await assert.rejects(f.client.command('models.sync', { previewId: preview.id, selected: ['model:' + f.keys[0]] }), /Offline/);
  assert.deepEqual(privateState(f).models, before.models);
});

test('blocked local profile reads time out and a retry succeeds without applying a late preview', async t => {
  const f = await fixture(t, { modelPreviewTimeoutMs: 30 });
  const list = f.profiles.list.bind(f.profiles);
  let release;
  f.profiles.list = () => new Promise(resolve => { release = resolve; });
  const before = privateState(f);
  await assert.rejects(f.client.command('models.diff'), error => error.code === 'timeout' && /读取超时/.test(error.message));
  f.profiles.list = list;
  release(await list());
  await f.edit({ apiKey: 'FIXTURE-AFTER-PREVIEW-TIMEOUT' });
  const retry = await f.client.command('models.diff');
  assert.ok(retry.changes.some(change => change.modelKey === f.keys[0]));
  assert.deepEqual(privateState(f).models, before.models);
});
