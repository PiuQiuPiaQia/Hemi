import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createBotHost } from './host.mjs';
import { createBotDesktopService } from './desktop-service.mjs';
async function fixture(t) {
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
  });
  const hello = await host.request('handshake');
  let network = true,
    dropReply = null;
  const transport = {
    probe: async () => ({
      home: path.join(root, 'cloud'),
      existing: true,
      bot: { ...hello, configured: true },
    }),
    rpc: async (_target, method, p) => {
      if (!network)
        throw Object.assign(new Error('test disconnected'), {
          code: 'offline',
        });
      const result = await host.request(method, p);
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
  };
  let client = createBotDesktopService(options);
  const selected = await client.connect({ host: 'fixture-cloud' });
  await host.request('model.sync', {
    instanceId: hello.instanceId,
    requestId: 'seed-model',
    models: [config],
  });
  await host.request('initialize.verify', {
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
    setNetwork: (value) => {
      network = value;
    },
    async restart() {
      await client.close();
      client = createBotDesktopService(options);
      await client.refresh();
    },
  };
}
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
test('offline drafts persist separately and reconcile into their original cloud conversation after restart', async (t) => {
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
  assert.equal(remote.draft.text, 'offline work');
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
test('lost model sync receipt remains visible across restart and reconciles without resending keys', async (t) => {
  const f = await fixture(t);
  f.dropReply('model.sync');
  await assert.rejects(
    () =>
      f.client.command('models.sync', {
        keys: ['p/m'],
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
  const f = await fixture(t),
    a = await f.client.command('session.create');
  await f.client.command('session.open', { id: a.id });
  await f.client.command('connection.disconnect');
  await f.client.command('session.draft', {
    id: a.id,
    text: 'local draft',
    revision: 1,
  });
  await f.host.request('session.draft', {
    instanceId: f.hello.instanceId,
    requestId: 'remote-draft',
    id: a.id,
    text: 'other client',
    revision: 2,
  });
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

test('initialization only syncs chosen models and lets Host own its built-in workspace', async t => {
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
