import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBotHost} from './host.mjs';
import {createBotDesktopService} from './desktop-service.mjs';

const wait = async fn => {const end = performance.now() + 6000; while (!await fn()) {assert.ok(performance.now() < end, 'timed out'); await new Promise(setImmediate);}};
async function fixture(t, remote = {version: '0.2.14', build: 'b'.repeat(64)}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-component-update-'));
  const local = {version: '0.2.15.1', build: 'a'.repeat(64)}, live = new Map();
  const host = await createBotHost({dataDir: path.join(root, 'cloud'), defaultDir: path.join(root, 'workspace'), validateModel: async () => {}, executorFactory: () => ({
    run(spec) {return new Promise(resolve => live.set(spec.conversationId, resolve));},
    async stop(id) {live.get(id)?.({stopped: true});}, async close() {for (const resolve of live.values()) resolve({stopped: true});},
  })});
  const hello = await host.request('handshake'), profile = path.join(root, 'desktop');
  await fs.mkdir(path.join(profile, 'bot'), {recursive: true});
  await fs.writeFile(path.join(profile, 'bot/connection.json'), JSON.stringify({host: 'fixture', instanceId: hello.instanceId}));
  const archivePath = path.join(root, 'runtime.tgz');
  await fs.writeFile(archivePath + '.manifest.json', JSON.stringify(local));
  let installs = 0, probes = 0, preparations = 0, failInstall = false;
  const request = (method, params = {}, clientId = 'fixture') => host.request(method, {instanceId: hello.instanceId, requestId: randomUUID(), ...params}, {clientId});
  const transport = {
    async rpc(_host, method, params, options) {const value = await host.request(method, params, {clientId: options.clientId}); return method === 'handshake' ? {...value, componentVersion: remote} : value;},
    async probe() {probes++; return {existing: true, bot: {...await host.request('handshake'), componentVersion: remote}};},
    async install() {installs++; if (failInstall) throw new Error('test install failed'); remote = {...local}; return {...await host.request('handshake'), componentVersion: remote};},
  };
  const desktop = createBotDesktopService({userDataDir: profile, archivePath, ensureArchive: async () => {preparations++;}, runner: {}, profiles: {list: async () => ({providers: []})}, transport});
  t.after(async () => {await desktop.close(); await host.close(); await fs.rm(root, {recursive: true, force: true});});
  await desktop.refresh();
  return {desktop, request, live, local, hello, get installs() {return installs;}, get probes() {return probes;}, get preparations() {return preparations;}, fail(value) {failInstall = value;}};
}
test('background checks run without a Bot page, at startup and then every six hours', async t => {
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  const f = await fixture(t);
  t.mock.timers.tick(29999);
  assert.equal(f.probes, 0);
  t.mock.timers.tick(1);
  await wait(() => f.desktop.getState().componentStatus?.phase === 'current');
  assert.equal(f.installs, 1);
  assert.equal(f.probes, 1);
  assert.equal(f.preparations, 1);
  assert.equal(typeof f.desktop.getState().componentStatus.checkedAt, 'number');
  await f.desktop.command('component.ensure-current', {active: false});
  for (let i = 0; i < 4; i++) await f.desktop.command('component.ensure-current', {automatic: true});
  assert.equal(f.probes, 1, 'page changes must not recheck the component');
  t.mock.timers.tick(6 * 60 * 60 * 1000 - 1);
  assert.equal(f.probes, 1);
  t.mock.timers.tick(1);
  await wait(() => f.probes === 2);
  await f.desktop.command('component.ensure-current', {automatic: true});
  assert.equal(f.preparations, 2, 'each scheduled check reads the current local package');
  assert.equal(f.installs, 1);
  await f.desktop.command('component.ensure-current');
  assert.equal(f.probes, 3, 'manual checks bypass the six-hour interval');
});
test('deliberate disconnect cancels pending background component checks', async t => {
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  const f = await fixture(t);
  await f.desktop.command('connection.disconnect');
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  await new Promise(setImmediate);
  assert.equal(f.probes, 0);
  assert.equal(f.installs, 0);
});
test('a failed background update retries after six hours instead of on page changes', async t => {
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  const f = await fixture(t); f.fail(true);
  await f.desktop.command('component.ensure-current');
  f.fail(false);
  await f.desktop.command('component.ensure-current', {automatic: true});
  assert.equal(f.installs, 1);
  t.mock.timers.tick(6 * 60 * 60 * 1000 - 1);
  assert.equal(f.installs, 1);
  t.mock.timers.tick(1);
  await wait(() => f.desktop.getState().componentStatus?.phase === 'current');
  assert.equal(f.installs, 2);
});
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
test('component revision advances under the same application version', async t => {
  const f=await fixture(t,{version:'0.2.15.0',build:'b'.repeat(64)});
  await f.desktop.command('component.ensure-current');
  assert.equal(f.installs,1);
  assert.equal(f.desktop.getState().binding.componentVersion.version,'0.2.15.1');
});
test('automatic update waits for real Host work, then updates without changing the conversation', async t => {
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  const f = await fixture(t);
  await f.request('model.sync', {models: [{modelKey: 'f/m', providerId: 'f', name: 'fixture', model: 'fixture', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'TEST_ONLY'}]});
  const {id} = await f.request('session.create');
  await f.request('flow.command', {id, command: {type: 'send', input: {inputId: 'keep-input', text: 'keep conversation'}}});
  await wait(() => f.live.has(id));
  await f.desktop.command('component.ensure-current');
  assert.equal(f.desktop.getState().componentStatus.phase, 'waiting');
  assert.equal(f.installs, 0);
  f.live.get(id)({});
  await wait(async () => (await f.request('handshake')).activeJobs === 0);
  t.mock.timers.tick(59999);
  assert.equal(f.installs, 0, 'idle checks no longer repeat every two seconds');
  t.mock.timers.tick(1);
  await wait(() => f.installs === 1);
  await f.desktop.command('component.ensure-current', {automatic: true});
  assert.equal((await f.request('flow.snapshot', {id})).timeline[0].text, 'keep conversation');
});
test('failed auto updates expose retry and do not loop or change identity', async t => {
  const f = await fixture(t); f.fail(true);
  await f.desktop.command('component.ensure-current');
  assert.equal(f.desktop.getState().componentStatus.phase, 'failed');
  assert.match(f.desktop.getState().componentStatus.message, /test install failed/);
  assert.equal(f.desktop.getState().binding.instanceId, f.hello.instanceId);
  await f.desktop.command('component.ensure-current', {active: false});
  await f.desktop.command('component.ensure-current', {automatic: true});
  await f.desktop.command('component.ensure-current', {active: false});
  await f.desktop.command('component.ensure-current', {automatic: true});
  assert.equal(f.installs, 1, 'returning to Bot must not retry a failed dependency installation');
  assert.equal(f.desktop.getState().componentStatus.phase, 'failed');
  f.fail(false); await f.desktop.command('component.ensure-current');
  assert.equal(f.desktop.getState().componentStatus.phase, 'current');
  assert.equal(f.installs, 2);
});
test('an old page cannot start an update against a replacement Bot identity', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.desktop.command('component.ensure-current', {expectedInstanceId: 'different'}), /连接已更换/);
  assert.equal(f.installs, 0);
});
