import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBotHost} from '../../../src/main/bot/host.mjs';
import {moduleUnderTest} from '../../../packages/conversation-flow/test/compile.mjs';

const {createBotWorkspace} = await moduleUnderTest('../../../apps/mobile/test/workspace-test-api.ts');
const wait = async predicate => {
  const until = Date.now() + 2000;
  while (!await predicate()) {assert.ok(Date.now() < until, 'reconnection timed out'); await new Promise(resolve => setTimeout(resolve, 10));}
};

test('live Host frames clear a catalog outage and fence a late failed catalog request', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-reconnection-'));
  const host = await createBotHost({dataDir: path.join(root, 'data'), defaultDir: path.join(root, 'work'), validateModel: async () => {},
    executorFactory: () => ({async run() {return {};}, async stop() {}, async close() {}})});
  t.after(async () => {await host.close(); await fs.rm(root, {recursive: true, force: true});});
  const {instanceId} = await host.request('handshake');
  const call = (method, params = {}) => host.request(method, {instanceId, requestId: randomUUID(), ...params});
  await call('model.sync', {models: [{modelKey: 'fixture/model', providerId: 'fixture', name: 'Fixture', model: 'fake', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'TEST_ONLY'}]});
  const {id} = await call('session.create');
  let hold = false, fail = false, rejectPoll, frames = 0;
  const rpc = {
    request(method, params) {
      if (method === 'snapshot' && hold) return new Promise((_resolve, reject) => {rejectPoll = reject;});
      if (method === 'snapshot' && fail) return Promise.reject(new Error('Catalog temporarily unreachable'));
      return host.request(method, params);
    },
    watch(options, receive, offline) {return host.watch(options, frame => {frames++; receive(frame);}, offline);},
  };
  const values = new Map();
  const workspace = createBotWorkspace({rpc, target: {endpoint: 'https://fixture.invalid', botInstanceId: instanceId, name: 'Test Bot'},
    storage: {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)}});
  t.after(() => workspace.dispose());
  await workspace.reconnect();
  const release = workspace.retain(); t.after(release);
  await new Promise(resolve => setTimeout(resolve, 100));

  fail = true;
  await workspace.reconnect();
  assert.equal(workspace.getSnapshot().offline, true);
  fail = false; hold = true;
  const pending = workspace.reconnect();
  await wait(() => !!rejectPoll);
  const previous = frames;
  await call('session.rename', {id, title: 'New live event'});
  await wait(() => frames > previous);
  assert.equal(workspace.getSnapshot().offline, false, 'an authenticated live event proves the Bot is reachable');
  hold = false;
  rejectPoll(new Error('Old catalog request failed after recovery'));
  await pending;
  assert.equal(workspace.getSnapshot().offline, false, 'late failure must not overwrite newer live evidence');
  assert.equal(workspace.getSnapshot().error, '');
});
