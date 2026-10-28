import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createBotHost } from './host.mjs';
import { createBotDesktopService } from './desktop-service.mjs';
async function fixture(t, extra = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-desktop-')),
  );
  const config = {
    modelKey: 'p/m',
    providerId: 'p',
    name: 'Fixture',
    model: 'fixture',
    api: 'openai-completions',
    baseUrl: 'https://model.example.test/v1',
    apiKey: 'NOT_A_REAL_KEY',
    thinkingLevel: 'off',
    supportsVision: false,
  };
  const host = await createBotHost({
    dataDir: path.join(root, 'cloud/data'),
    defaultDir: path.join(root, 'cloud/workspace'),
    validateModel: async () => {},
    executorFactory: extra.executorFactory ?? (() => ({async run() {return {};}, async stop() {}, async close() {}})),
  });
  const hello = await host.request('handshake');
  let network = true,
    dropReply = null;
  let networkCode = 'offline';
  const rpcMethods = [];
  let snapshotGate = null;
  const transport = {
    probe: async () => ({
      home: path.join(root, 'cloud'),
      existing: true,
      bot: { ...hello, configured: true },
    }),
    rpc: async (_target, method, p, options) => {
      rpcMethods.push(method);
      if (!network)
        throw Object.assign(new Error('test disconnected'), {
          code: networkCode,
        });
      // Windows exercises the actual desktop service and Host state. The remote
      // Linux /bin/sh initialization probe is the only substituted OS boundary.
      await extra.beforeRpc?.(host, method, p, options);
      const result = process.platform === 'win32' && method === 'initialize.verify'
        ? {ok: true} : await host.request(method, p, extra.authenticated ? {clientId: options?.clientId} : undefined);
      if (process.platform === 'win32' && method === 'handshake') result.configured = true;
      if (method === 'snapshot' && snapshotGate) {
        const gate = snapshotGate; snapshotGate = null;
        gate.started(); await gate.wait;
      }
      if (dropReply === method) {
        dropReply = null;
        throw Object.assign(new Error('lost receipt'), {
          code: 'needs-review',
        });
      }
      return result;
    },
    control: async () => ({ ok: true }),
  };
  if(extra.realtime)transport.watch=async(_target,params,{signal,onEvent,clientId})=>{
    const stop=host.watch(params,onEvent,undefined,{clientId});
    try{await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve();});}finally{stop();}
  };
  const profiles = {
    list: async () => ({
      providers: [
        {
          id: 'p',
          name: 'Fixture',
          models: [{ modelKey: 'p/m', model: 'fixture' }],
        },
      ],
    }),
    resolveStrict: async () => ({ ok: true, config }),
  };
  const options = {
    userDataDir: path.join(root, 'desktop'),
    runner: {},
    profiles,
    transport,
    onConversationResult:extra.onConversationResult,
  };
  let client = createBotDesktopService(options);
  const selected = await client.connect({ host: 'fixture-cloud' });
  await host.request('model.sync', {
    instanceId: hello.instanceId,
    requestId: 'seed-model',
    models: [config],
  });
  if (process.platform !== 'win32') await host.request('initialize.verify', {
    instanceId: hello.instanceId,
    requestId: 'seed-verify',
  });
  await client.initialize({
    candidateId: selected.candidate.id,
    existing: true,
  });
  t.after(async () => {
    await client.close();
    await host.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    host,
    hello,
    config,
    get client() {
      return client;
    },
    dropReply: (method) => {
      dropReply = method;
    },
    rpcMethods,
    transport,
    setNetwork: (value, code = 'offline') => {
      network = value;
      networkCode = code;
    },
    holdNextSnapshot() {
      let started, release;
      const reached = new Promise(resolve => { started = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      snapshotGate = { started, wait };
      return { started: reached, release };
    },
    async restart() {
      await client.close();
      client = createBotDesktopService(options);
      await client.refresh();
    },
  };
}
test('transient connection failures keep retrying after four attempts and clear the stale error on recovery', async t => {
  t.mock.timers.enable({apis: ['Date', 'setInterval'], now: Date.now()});
  const f = await fixture(t);
  f.setNetwork(false);
  for (let i = 0; i < 5; i++) await f.client.refresh();
  assert.equal(f.client.getState().online, false);
  f.setNetwork(true);
  const before = f.rpcMethods.length;
  t.mock.timers.tick(61000);
  assert.ok(f.rpcMethods.length > before, 'background timer must retry without a user wake-up');
  await f.client.refresh(); // Join the refresh already started by the timer.
  assert.equal(f.client.getState().online, true);
  assert.equal(f.client.getState().error, '');
  assert.equal((await f.host.request('handshake')).bootId, f.hello.bootId);
  assert.ok(!f.rpcMethods.includes('service.start'));
});

test('device sharing reuses the actual configured gateway address and certificate when restarted without an address', async t => {
  const f = await fixture(t);
  const port = net.createServer();
  await new Promise(resolve => port.listen(0, '127.0.0.1', resolve));
  const endpoint = `https://127.0.0.1:${port.address().port}`;
  await new Promise(resolve => port.close(resolve));
  const first = await f.client.command('pairing.configure', {endpoint});
  assert.equal(first.enabled, true);
  assert.equal((await f.client.command('pairing.configure')).fingerprint, first.fingerprint);
  await f.client.command('pairing.disable');
  const restored = await f.client.command('pairing.configure');
  assert.equal(restored.enabled, true);
  assert.equal(restored.endpoint, endpoint);
  assert.equal(restored.fingerprint, first.fingerprint);
  const invitation = await f.client.command('pairing.create');
  assert.equal(JSON.parse(invitation.qr).endpoint, endpoint);
});

test('credential failures wait for an explicit retry; page refresh respects deliberate disconnect and stop', async t => {
  t.mock.timers.enable({apis: ['Date', 'setInterval'], now: Date.now()});
  const f = await fixture(t);
  f.setNetwork(false, 'permission');
  await f.client.refresh();
  f.setNetwork(true);
  let before = f.rpcMethods.length;
  t.mock.timers.tick(61000);
  assert.equal(f.rpcMethods.length, before, 'do not repeatedly attempt rejected credentials');
  await f.client.command('connection.reconnect');
  assert.equal(f.client.getState().online, true);
  await f.client.command('connection.disconnect');
  before = f.rpcMethods.length;
  t.mock.timers.tick(61000);
  await f.client.refresh();
  assert.equal(f.rpcMethods.length, before);
  assert.equal(f.client.getState().online, false);
  await f.client.command('connection.reconnect');
  await f.client.command('service.stop');
  before = f.rpcMethods.length;
  t.mock.timers.tick(61000);
  await f.client.refresh();
  assert.equal(f.rpcMethods.length, before);
  assert.equal(f.client.getState().stoppedConfirmed, true);
  assert.equal((await f.host.request('handshake')).enabled, false);
});
test('manual sync uses local credentials only in main/Host, model status is stable and no key reaches renderer', async (t) => {
  const f = await fixture(t);
  const models = await f.client.modelCandidates();
  assert.equal(models[0].status, 'synced');
  assert.equal(
    JSON.stringify(f.client.getState()).includes('NOT_A_REAL_KEY'),
    false,
  );
  assert.equal(JSON.stringify(models).includes('NOT_A_REAL_KEY'), false);
});

test('a delayed toast acknowledgement cannot dismiss a newer model result', async t => {
  const f = await fixture(t);
  await f.client.command('models.routing', { roleModels: { main: 'p/m' }, expectedModelRevision: f.client.getState().cache.modelConfigRevision, requestId: 'toast-first' });
  await f.client.command('models.routing', { roleModels: { main: 'p/m' }, expectedModelRevision: f.client.getState().cache.modelConfigRevision, requestId: 'toast-second' });
  await f.client.command('models.dismiss', { requestId: 'toast-first' });
  assert.equal(f.client.getState().syncStatus.requestId, 'toast-second');
  await f.client.command('models.dismiss', { requestId: 'toast-second' });
  assert.equal(f.client.getState().syncStatus, null);
});
test('manual providers are added only on the Host, retries reuse model IDs and local receipts contain no credentials', async t => {
  const f = await fixture(t);
  const provider = { name: 'Bot 专用接口', baseUrl: 'https://bot.example.test/v1', api: 'anthropic-messages', apiKey: 'BOT-MANUAL-SECRET', models: [{ model: 'cloud-only', supportsVision: true }, { model: 'cloud-second' }] };
  const result = await f.client.command('models.add', { provider, requestId: 'manual-add-fixture' });
  assert.ok(result.providerId.startsWith('bot-'));
  assert.equal(result.modelKeys.length, 2);
  const again = await f.client.command('models.add', { provider, requestId: 'manual-add-fixture' });
  assert.deepEqual(again, result);
  const models = f.client.getState().cache.models;
  assert.equal(models.length, 3);
  assert.equal(models.find(model => model.model === 'cloud-only').api, 'anthropic-messages');
  assert.equal(models.find(model => model.model === 'cloud-only').supportsVision, true);
  assert.equal((await f.client.modelCandidates()).length, 1);
  for (const name of await fs.readdir(path.join(f.root, 'desktop/bot'))) {
    assert.ok(!(await fs.readFile(path.join(f.root, 'desktop/bot', name), 'utf8')).includes(provider.apiKey), name);
  }
  assert.ok(!JSON.stringify(f.client.getState()).includes(provider.apiKey));
  assert.ok((await fs.readFile(path.join(f.root, 'cloud/data/state.json'), 'utf8')).includes(provider.apiKey));
});

test('manual model initialization needs no matching local model; malformed providers do not change cloud models', async t => {
  const f = await fixture(t);
  const candidate = await f.client.connect({ host: 'fixture-cloud' });
  const provider = { name: '独立 Bot 配置', baseUrl: 'https://manual.example.test/v1', apiKey: 'SETUP-SECRET', models: [{ model: 'setup-only' }] };
  await f.client.initialize({ candidateId: candidate.candidate.id, provider, requestId: 'manual-initialize' });
  assert.ok(f.client.getState().cache.models.some(model => model.model === 'setup-only'));
  assert.equal((await f.client.modelCandidates()).length, 1);
  const count = f.client.getState().cache.models.length;
  for (const patch of [{ apiKey: '' }, { models: [] }, { baseUrl: 'file:///private/key' }, { models: [{ model: '' }] }]) {
    await assert.rejects(f.client.command('models.add', { provider: { ...provider, ...patch }, requestId: 'invalid-manual' }));
  }
  assert.equal(f.client.getState().cache.models.length, count);
});

test('a lost manual-add receipt reconciles after restart without persisting or resending the API Key', async t => {
  const f = await fixture(t);
  const provider = { name: 'Pending', baseUrl: 'https://pending.example.test/v1', apiKey: 'PENDING-MANUAL-SECRET', models: [{ model: 'pending-model' }] };
  f.dropReply('model.sync');
  await assert.rejects(f.client.command('models.add', { provider, requestId: 'pending-manual-add' }), /lost receipt/);
  assert.equal(f.client.getState().syncStatus.phase, 'unknown');
  assert.ok(!(await fs.readFile(path.join(f.root, 'desktop/bot/model-sync.json'), 'utf8')).includes(provider.apiKey));
  await f.restart();
  await f.client.command('models.reconcile');
  assert.equal(f.client.getState().syncStatus.phase, 'confirmed');
  assert.equal(f.client.getState().cache.models.filter(model => model.model === 'pending-model').length, 1);
});
test('offline drafts survive restart without acquiring a session merely to upload them', async (t) => {
  const f = await fixture(t),
    session = await f.client.command('session.create');
  await f.client.command('session.open', { id: session.id });
  await f.client.command('connection.disconnect');
  f.setNetwork(false);
  await f.client.command('session.draft', {
    id: session.id,
    revision: 1,
    text: 'offline work',
    references: [],
    skills: [],
    attachmentIds: [],
  });
  assert.equal(
    f.client.getState().cache.details[session.id].draft.text,
    'offline work',
  );
  await f.client.close();
  f.setNetwork(true);
  await f.restart();
  await f.client.command('session.open', { id: session.id });
  assert.equal(
    f.client.getState().cache.details[session.id].draft.text,
    'offline work',
  );
  const remote = await f.host.request('session.open', {
    instanceId: f.hello.instanceId,
    id: session.id,
  });
  assert.equal(remote.draft.text, '');
  assert.equal(f.client.getState().online, true);
  assert.equal(f.client.getState().cache.sessions.find(item => item.id === session.id).control, null);
});
test('reconnect uploads an offline draft only under its original authenticated writer lease', async t => {
  const f = await fixture(t, {authenticated: true});
  const {id} = await f.client.command('session.create');
  await f.client.command('session.open', {id});
  const {control} = await f.client.command('session.control', {id, action: 'acquire'});
  f.setNetwork(false); await f.client.refresh();
  await f.client.command('session.draft', {id, revision: 1, text: 'same lease'});
  f.setNetwork(true); await f.client.refresh();
  assert.equal(f.client.getState().online, true);
  const remote = await f.host.request('session.open', {instanceId: f.hello.instanceId, id});
  assert.equal(remote.draft.text, 'same lease');
  assert.equal(remote.control.epoch, control.epoch);
});
test('same-lease draft version conflicts preserve local edits without repeating rejected uploads', async t => {
  const f = await fixture(t, {authenticated: true});
  const {id} = await f.client.command('session.create');
  await f.client.command('session.open', {id});
  await f.client.command('session.control', {id, action: 'acquire'});
  f.setNetwork(false); await f.client.refresh();
  await f.client.command('session.draft', {id, revision: 1, text: 'offline edit'});
  await f.host.request('session.draft', {instanceId: f.hello.instanceId, requestId: 'newer-same-writer', id, revision: 3, text: 'newer saved edit'},
    {clientId: f.client.getState().clientId});
  f.setNetwork(true); await f.client.refresh();
  const before = f.rpcMethods.filter(method => method === 'session.draft').length;
  await f.client.refresh();
  const state = f.client.getState();
  assert.equal(state.online, true);
  assert.equal(state.cache.details[id].draft.text, 'offline edit');
  assert.equal(state.cache.details[id].draft.revision, 3);
  assert.equal(f.rpcMethods.filter(method => method === 'session.draft').length, before);
  await f.client.command('session.draft', {id, revision: 4, text: 'resolved edit'});
  assert.equal((await f.host.request('session.open', {instanceId: f.hello.instanceId, id})).draft.text, 'resolved edit');
});
for (const ownership of ['peer', 'released', 'reacquired']) test(`reconnect preserves a draft after its writer lease is ${ownership} without a stale upload`, async t => {
  const f = await fixture(t, {authenticated: true});
  const {id} = await f.client.command('session.create');
  await f.client.command('session.open', {id});
  const {control} = await f.client.command('session.control', {id, action: 'acquire'});
  f.setNetwork(false); await f.client.refresh();
  await f.client.command('session.draft', {id, revision: 1, text: 'local work'});
  const request = (method, params, clientId = 'phone') => f.host.request(method, {instanceId: f.hello.instanceId, id, ...params}, {clientId});
  if (ownership === 'released') await request('session.control', {action: 'release', controlEpoch: control.epoch}, f.client.getState().clientId);
  else {
    await request('session.control', {action: 'takeover'});
    await request('session.draft', {requestId: 'peer-draft', text: 'phone work', revision: 4});
    if (ownership === 'reacquired') await request('session.control', {action: 'takeover'}, f.client.getState().clientId);
  }
  const before = f.rpcMethods.filter(method => method === 'session.draft').length;
  f.setNetwork(true); await f.client.refresh(); await f.client.refresh();
  const state = f.client.getState();
  assert.equal(state.online, true);
  assert.equal(state.cache.details[id].draft.text, 'local work');
  assert.equal(state.cache.details[id].draft.controlEpoch, undefined, 'local lease metadata is not an editable draft field');
  assert.equal(f.rpcMethods.filter(method => method === 'session.draft').length, before);
  assert.equal(state.cache.sessions.find(item => item.id === id).control?.ownerId,
    ownership === 'released' ? undefined : ownership === 'peer' ? 'phone' : state.clientId);
  const remote = await request('session.open', {});
  assert.equal(remote.draft.text, ownership === 'released' ? '' : 'phone work');
  if (ownership === 'peer') {
    await f.client.command('session.control', {id, action: 'takeover'});
    assert.equal((await request('session.open', {})).draft.text, 'phone work', 'takeover alone does not replay old content');
    const revision = f.client.getState().cache.details[id].draft.revision + 1;
    assert.equal(revision, 5, 'the next local edit starts after the current Host draft version');
    await f.client.command('session.draft', {id, revision, text: 'explicit new edit'});
    assert.equal((await request('session.open', {})).draft.text, 'explicit new edit');
  }
});
test('a takeover racing reconnect draft upload adopts the new owner and keeps the Bot online', async t => {
  let takeover = false;
  const f = await fixture(t, {authenticated: true, async beforeRpc(host, method, params) {
    if (!takeover || method !== 'session.draft') return;
    takeover = false;
    await host.request('session.control', {instanceId: params.instanceId, id: params.id, action: 'takeover'}, {clientId: 'phone'});
    await host.request('session.draft', {instanceId: params.instanceId, requestId: 'race-peer-draft', id: params.id, revision: 5, text: 'peer draft'}, {clientId: 'phone'});
  }});
  const {id} = await f.client.command('session.create');
  await f.client.command('session.open', {id});
  await f.client.command('session.control', {id, action: 'acquire'});
  f.setNetwork(false); await f.client.refresh();
  await f.client.command('session.draft', {id, revision: 1, text: 'keep local'});
  f.setNetwork(true); takeover = true;
  await f.client.refresh();
  let state = f.client.getState();
  assert.equal(state.online, true);
  assert.equal(state.cache.sessions.find(item => item.id === id).control.ownerId, 'phone');
  assert.equal(state.cache.details[id].draft.text, 'keep local');
  assert.equal(state.cache.details[id].draft.revision, 5);
  const before = f.rpcMethods.filter(method => method === 'session.draft').length;
  await f.client.refresh();
  state = f.client.getState();
  assert.equal(state.online, true);
  assert.equal(f.rpcMethods.filter(method => method === 'session.draft').length, before);
});
test('manual disconnect does not auto-reconnect, stale instance and unknown sessions cannot save drafts', async (t) => {
  const f = await fixture(t);
  await f.client.command('connection.disconnect');
  await new Promise((r) => setTimeout(r, 1400));
  assert.equal(f.client.getState().online, false);
  await assert.rejects(
    () =>
      f.client.command('session.draft', {
        id: 'not-owned',
        revision: 1,
        text: 'no',
      }),
    /不属于/,
  );
  await assert.rejects(
    () =>
      f.client.command('session.create', {
        expectedInstanceId: 'old-instance',
      }),
    /已更换/,
  );
});
for (const changed of [false, true]) test(`manual disconnect ignores a late ${changed ? 'changed' : 'not-modified'} snapshot until explicit reconnect`, async t => {
  const f = await fixture(t);
  if (changed) await f.host.request('session.create', { instanceId: f.hello.instanceId, requestId: 'changed-snapshot' });
  const held = f.holdNextSnapshot(), refresh = f.client.refresh();
  await held.started;
  await f.client.command('connection.disconnect');
  held.release(); await refresh;
  assert.equal(f.client.getState().online, false);
  assert.match(f.client.getState().error, /连接已断开/);
  await f.client.refresh();
  assert.equal(f.client.getState().online, false);
  await f.client.command('connection.reconnect');
  assert.equal(f.client.getState().online, true);
});
test('confirmed stop permits removing binding while service is down, without deleting cloud records', async (t) => {
  const f = await fixture(t),
    session = await f.client.command('session.create');
  await f.client.command('service.stop');
  assert.equal(f.client.getState().online, false);
  await f.client.command('connection.remove');
  assert.equal(f.client.getState().binding, null);
  assert.equal(
    (
      await f.host.request('session.open', {
        instanceId: f.hello.instanceId,
        id: session.id,
      })
    ).id,
    session.id,
  );
});
test('corrupt local Bot cache is backed up without preventing normal application service creation', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-corrupt-'));
  await fs.mkdir(path.join(dir, 'bot'));
  await fs.writeFile(path.join(dir, 'bot/connection.json'), 'broken');
  const service = createBotDesktopService({
    userDataDir: dir,
    runner: {},
    profiles: {},
    transport: {},
  });
  t.after(async () => {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal(service.getState().binding, null);
  assert.match(service.getState().error, /缓存损坏/);
  assert.ok(
    (await fs.readdir(path.join(dir, 'bot'))).some((name) =>
      name.includes('.corrupt-'),
    ),
  );
});

test('deleting the active session does not poison polling or reconnect', async (t) => {
  const f = await fixture(t),
    a = await f.client.command('session.create');
  await f.client.command('session.open', { id: a.id });
  await f.client.command('session.remove', { id: a.id });
  assert.equal(f.client.getState().online, true);
  await f.client.refresh();
  assert.equal(f.client.getState().online, true);
  await f.client.command('connection.reconnect');
});

test('session receipts update create/model/delete immediately while an older poll is blocked', async t => {
  const f = await fixture(t);
  const gate = f.holdNextSnapshot(), polling = f.client.refresh();
  await gate.started;
  t.after(() => gate.release());
  const before = f.rpcMethods.length;
  const created = await f.client.command('session.create');
  assert.deepEqual(f.rpcMethods.slice(before), ['session.create']);
  assert.equal(f.client.getState().cache.details[created.id].modelKey, 'p/m');
  assert.equal(f.client.getState().cache.selectedId, created.id);
  await f.client.command('session.open', {id: created.id});
  assert.deepEqual(f.rpcMethods.slice(before), ['session.create'], 'cached open needs no remote process');
  await f.host.request('model.sync', {instanceId: f.hello.instanceId, requestId: 'second-model', models: [f.config, {...f.config, modelKey: 'p/other', model: 'other'}]});
  await f.client.command('session.update', {id: created.id, modelKey: 'p/other'});
  assert.equal(f.client.getState().cache.details[created.id].modelKey, 'p/other');
  assert.equal(f.client.getState().cache.lastConversationModelKey, 'p/other');
  const other = await f.client.command('session.create');
  await f.client.command('session.remove', {id: created.id});
  assert.equal(f.client.getState().cache.details[created.id], undefined);
  gate.release(); await polling;
  assert.deepEqual(f.client.getState().cache.sessions.map(item => item.id), [other.id], 'old poll cannot undo acknowledged mutations');
  await f.client.refresh();
  assert.equal(f.client.getState().cache.details[other.id].modelKey, 'p/other');
});

test('a failed delete preserves selection, and legacy Hosts retain authoritative refresh', async t => {
  const f = await fixture(t), created = await f.client.command('session.create');
  const rpc = f.transport.rpc;
  f.transport.rpc = async (host, method, params) => {
    if (method === 'session.remove') throw Object.assign(new Error('删除失败'), {code: 'permission'});
    const result = await rpc(host, method, params);
    if (method === 'session.update') delete result.snapshot;
    return result;
  };
  await assert.rejects(f.client.command('session.remove', {id: created.id}), {code: 'permission'});
  assert.equal(f.client.getState().cache.selectedId, created.id);
  const before = f.rpcMethods.length;
  await f.client.command('session.update', {id: created.id, thinking: 'high'});
  assert.ok(f.rpcMethods.slice(before).includes('snapshot'));
  assert.equal(f.client.getState().cache.details[created.id].thinking, 'high');
});

test('a late session receipt cannot update cache after an explicit disconnect', async t => {
  const f = await fixture(t), created = await f.client.command('session.create');
  const rpc = f.transport.rpc, started = Promise.withResolvers(), gate = Promise.withResolvers();
  f.transport.rpc = async (...args) => {
    const result = await rpc(...args);
    if (args[1] === 'session.update') {started.resolve(); await gate.promise;}
    return result;
  };
  const update = f.client.command('session.update', {id: created.id, thinking: 'high'});
  await started.promise;
  await f.client.command('connection.disconnect');
  gate.resolve();
  await assert.rejects(update, {code: 'conflict'});
  assert.equal(f.client.getState().online, false);
  assert.equal(f.client.getState().cache.details[created.id].thinking, 'default');
  await f.client.command('connection.reconnect');
  assert.equal(f.client.getState().cache.details[created.id].thinking, 'high');
});
test('lost model sync receipt remains visible across restart and reconciles without resending keys', async (t) => {
  const f = await fixture(t);
  f.config.name = 'Updated local config';
  const preview = await f.client.command('models.diff');
  f.dropReply('model.configure');
  await assert.rejects(
    () =>
      f.client.command('models.sync', {
        previewId: preview.id, selected: ['model:p/m'],
        requestId: 'lost-model-sync',
      }),
    /lost receipt/,
  );
  assert.equal(f.client.getState().syncStatus.phase, 'unknown');
  await f.restart();
  assert.equal(f.client.getState().syncStatus.phase, 'confirmed');
  assert.equal(
    JSON.stringify(f.client.getState()).includes('NOT_A_REAL_KEY'),
    false,
  );
});

test('conflicting offline drafts are retained without repeated cloud writes; an explicit edit resolves them', async (t) => {
  const f = await fixture(t, {authenticated: true}),
    a = await f.client.command('session.create');
  await f.client.command('session.open', { id: a.id });
  await f.client.command('session.control', {id: a.id, action: 'acquire'});
  await f.client.command('connection.disconnect');
  await f.client.command('session.draft', {
    id: a.id,
    text: 'local draft',
    revision: 1,
  });
  await f.host.request('session.control', {instanceId: f.hello.instanceId, id: a.id, action: 'takeover'}, {clientId: 'phone'});
  await f.host.request('session.draft', {
    instanceId: f.hello.instanceId,
    requestId: 'remote-draft',
    id: a.id,
    text: 'other client',
    revision: 2,
  }, {clientId: 'phone'});
  await f.client.command('connection.reconnect');
  assert.match(f.client.getState().error, /草稿/);
  assert.equal(
    f.client.getState().cache.details[a.id].draft.text,
    'local draft',
  );
  const before = (
    await f.host.request('snapshot', { instanceId: f.hello.instanceId })
  ).revision;
  await f.client.refresh();
  await f.client.refresh();
  assert.equal(
    (await f.host.request('snapshot', { instanceId: f.hello.instanceId }))
      .revision,
    before,
  );
  await f.client.command('session.control', {id: a.id, action: 'takeover'});
  await f.client.command('session.draft', {
    id: a.id,
    text: 'resolved draft',
    revision: 3,
  });
  assert.equal(
    (
      await f.host.request('session.open', {
        instanceId: f.hello.instanceId,
        id: a.id,
      })
    ).draft.text,
    'resolved draft',
  );
  const stale = await f.client.command('session.draft', {
    id: a.id,
    text: 'old timer',
    revision: 1,
  });
  assert.equal(stale.ok, false);
  assert.equal(
    f.client.getState().cache.details[a.id].draft.text,
    'resolved draft',
  );
});

test('selecting already cached conversations persists the last selection even when the cloud snapshot is unchanged', async (t) => {
  const f = await fixture(t),
    a = await f.client.command('session.create'),
    b = await f.client.command('session.create');
  await f.client.command('session.open', { id: a.id });
  await f.client.command('session.open', { id: b.id });
  await f.client.command('session.open', { id: a.id });
  await f.restart();
  assert.equal(f.client.getState().cache.selectedId, a.id);
});

test('initialization automatically configures available local models and lets Host own its built-in workspace', async t => {
  const f = await fixture(t);
  const candidate = await f.client.connect({ host: 'fixture-cloud' });
  const ignoredPath = path.join(f.root, 'not-a-setup-setting');
  await f.client.initialize({
    candidateId: candidate.candidate.id,
    modelKeys: ['p/m'],
    // Old desktop payloads must not reintroduce the removed global settings.
    defaultModel: 'missing/model',
    defaultDir: ignoredPath,
  });
  assert.equal(f.client.getState().cache.defaultDir, path.join(f.root, 'cloud/workspace'));
  assert.equal(await fs.stat(ignoredPath).then(() => true, () => false), false);
  await assert.rejects(f.client.command('bot.configure', { defaultDir: ignoredPath }), /不支持|无效|操作/);
});


test('a send receipt returns without waiting for a second catalog SSH round trip', async t => {
  const f = await fixture(t), session = await f.client.command('session.create');
  await f.client.command('session.open', { id: session.id });
  const gate = f.holdNextSnapshot();
  try {
    const result = await Promise.race([
      f.client.command('flow.command', { id: session.id, command: { type: 'send', input: { inputId: 'fast-ack', text: 'accepted' } } }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('receipt waited for catalog refresh')), 1500); timer.unref(); }),
    ]);
    assert.equal(result.ok, true);
    await gate.started;
  } finally { gate.release(); }
});


test('真实 Host 事件流保留后台等待状态，等待用户只提醒一次，重连不重播旧提醒',async t=>{
 let finish;const notifications=[];
 const f=await fixture(t,{realtime:true,onConversationResult:info=>notifications.push(info),executorFactory:()=>({
  async run(spec,emit){emit({type:'run-activity',runId:spec.runId,generation:spec.generation,activity:{runId:spec.runId,phase:'waiting-background',since:Date.now(),jobs:[{id:'job',command:'work',status:'running',startedAt:Date.now(),endedAt:null,output:''}],resources:[]}});await new Promise(r=>{finish=r;});return {waitingForUser:{question:'请提供所需信息',reason:'等待用户'}};},
  async stop(){finish?.();},async close(){finish?.();}
 })});
 const {id}=await f.client.command('session.create');await f.client.command('session.open',{id});
 const wait=async(fn)=>{for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('stream did not settle');};
 await f.client.command('flow.command',{id,command:{type:'send',input:{inputId:'waiting-input',text:'执行任务'}}});
 await wait(()=>f.client.getState().cache.sessions.find(x=>x.id===id)?.status==='waiting');
 finish();await wait(()=>notifications.length===1);assert.equal(notifications[0].outcome,'awaiting-user');
 await f.client.refresh();await f.restart();await new Promise(r=>setTimeout(r,50));assert.equal(notifications.length,1);
});
