import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleUnderTest} from './compile.mjs';

const {createConversation} = await moduleUnderTest('../src/core.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = {schemaVersion: 1, conversationId: 'same', revision: 0, generation: 1, phase: 'idle', activeRunId: null,
  queuePaused: false, pending: [], timeline: [], runs: {}, tasks: {}, artifacts: {}, permissions: {}, pendingReports: []};

for (const recovery of ['ready', 'snapshot']) test(`a late failed poll cannot undo a newer live ${recovery}`, async t => {
  let receive, connected, rejectPoll, hold = false;
  const client = createConversation({scope: {environmentId: 'test-bot', conversationId: 'same'}, transport: {
    fetchSnapshot() {return hold ? new Promise((_resolve, reject) => {rejectPoll = reject;}) : Promise.resolve(snapshot);},
    subscribe(_scope, onChange, _offline, online) {receive = onChange; connected = online; return () => {};},
    async command() {return {ok: true};},
  }});
  t.after(() => client.dispose());
  await client.start();
  hold = true;
  const pending = client.refresh();
  await tick();
  if (recovery === 'ready') connected();
  else receive({kind: 'snapshot', snapshot: {...snapshot, revision: 1}});
  assert.equal(client.getSnapshot().connection, 'online');
  rejectPoll(new Error('Request from the previous network finally failed'));
  await pending;
  assert.equal(client.getSnapshot().connection, 'online');

  // A later failure without newer live evidence still indicates a real outage.
  const next = client.refresh();
  await tick();
  rejectPoll(new Error('Current network is unavailable'));
  await next;
  assert.equal(client.getSnapshot().connection, 'offline');
});
