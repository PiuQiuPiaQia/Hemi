import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBotHost} from './host.mjs';
import {createBotDesktopService} from './desktop-service.mjs';

const wait = async fn => {const end = Date.now() + 6000; while (!await fn()) {assert.ok(Date.now() < end, 'timed out'); await new Promise(r => setTimeout(r, 20));}};
async function fixture(t, remote = {version: '0.2.14', build: 'b'.repeat(64)}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-component-update-'));
  const local = {version: '0.2.15', build: 'a'.repeat(64)}, live = new Map();
  const host = await createBotHost({dataDir: path.join(root, 'cloud'), defaultDir: path.join(root, 'workspace'), validateModel: async () => {}, executorFactory: () => ({
    run(spec) {return new Promise(resolve => live.set(spec.conversationId, resolve));},
    async stop(id) {live.get(id)?.({stopped: true});}, async close() {for (const resolve of live.values()) resolve({stopped: true});},
  })});
  const hello = await host.request('handshake'), profile = path.join(root, 'desktop');
  await fs.mkdir(path.join(profile, 'bot'), {recursive: true});
  await fs.writeFile(path.join(profile, 'bot/connection.json'), JSON.stringify({host: 'fixture', instanceId: hello.instanceId}));
  const archivePath = path.join(root, 'runtime.tgz');
  await fs.writeFile(archivePath + '.manifest.json', JSON.stringify(local));
  let installs = 0, failInstall = false;
  const request = (method, params = {}, clientId = 'fixture') => host.request(method, {instanceId: hello.instanceId, requestId: randomUUID(), ...params}, {clientId});
  const transport = {
    async rpc(_host, method, params, options) {const value = await host.request(method, params, {clientId: options.clientId}); return method === 'handshake' ? {...value, componentVersion: remote} : value;},
    async probe() {return {existing: true, bot: {...await host.request('handshake'), componentVersion: remote}};},
    async install() {installs++; if (failInstall) throw new Error('test install failed'); remote = local; return {...await host.request('handshake'), componentVersion: remote};},
  };
  const desktop = createBotDesktopService({userDataDir: profile, archivePath, runner: {}, profiles: {list: async () => ({providers: []})}, transport});
  t.after(async () => {await desktop.close(); await host.close(); await fs.rm(root, {recursive: true, force: true});});
  await desktop.refresh();
  return {desktop, request, live, local, hello, get installs() {return installs;}, fail(value) {failInstall = value;}};
}
test('opening Bot automatically updates an older or unversioned component once', async t => {
  for (const remote of [null, {version: '0.2.14', build: 'b'.repeat(64)}]) {
    const f = await fixture(t, remote);
    await f.desktop.command('component.ensure-current');
    assert.equal(f.installs, 1);
    assert.equal(f.desktop.getState().componentStatus.phase, 'current');
    assert.deepEqual(f.desktop.getState().binding.componentVersion, f.local);
    await f.desktop.command('component.ensure-current');
    assert.equal(f.installs, 1);
    assert.equal(f.desktop.getState().binding.instanceId, f.hello.instanceId);
  }
});
test('a PC carrying an older release keeps the newer cloud component', async t => {
  const f = await fixture(t, {version: '0.3.0', build: 'b'.repeat(64)});
  await f.desktop.command('component.ensure-current');
  assert.equal(f.installs, 0);
  assert.equal(f.desktop.getState().componentStatus.remoteVersion, '0.3.0');
});
test('automatic update waits for real Host work, then updates without changing the conversation', async t => {
  const f = await fixture(t);
  await f.request('model.sync', {models: [{modelKey: 'f/m', providerId: 'f', name: 'fixture', model: 'fixture', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'TEST_ONLY'}]});
  const {id} = await f.request('session.create');
  await f.request('flow.command', {id, command: {type: 'send', input: {inputId: 'keep-input', text: 'keep conversation'}}});
  await wait(() => f.live.has(id));
  await f.desktop.command('component.ensure-current');
  assert.equal(f.desktop.getState().componentStatus.phase, 'waiting');
  assert.equal(f.installs, 0);
  f.live.get(id)({});
  await wait(() => f.installs === 1);
  assert.equal((await f.request('flow.snapshot', {id})).timeline[0].text, 'keep conversation');
});
test('failed auto updates expose retry and do not loop or change identity', async t => {
  const f = await fixture(t); f.fail(true);
  await f.desktop.command('component.ensure-current');
  assert.equal(f.desktop.getState().componentStatus.phase, 'failed');
  assert.match(f.desktop.getState().componentStatus.message, /test install failed/);
  assert.equal(f.desktop.getState().binding.instanceId, f.hello.instanceId);
  f.fail(false); await f.desktop.command('component.ensure-current');
  assert.equal(f.desktop.getState().componentStatus.phase, 'current');
  assert.equal(f.installs, 2);
});
test('an old page cannot start an update against a replacement Bot identity', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.desktop.command('component.ensure-current', {expectedInstanceId: 'different'}), /连接已更换/);
  assert.equal(f.installs, 0);
});
