import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleUnderTest} from './compile.mjs';

const {createConversation} = await moduleUnderTest('../src/core.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = {schemaVersion: 1, conversationId: 'same', revision: 0, generation: 1, phase: 'idle', activeRunId: null,
  queuePaused: false, pending: [], timeline: [], runs: {}, tasks: {}, artifacts: {}, permissions: {}, pendingReports: []};

test('explicit recovery reads a fresh snapshot while an old request remains pending', async t => {
  let hold = false, finishOld, reads = 0;
  const client = createConversation({scope: {environmentId: 'test-bot', conversationId: 'same'}, pollIntervalMs: 0, transport: {
    fetchSnapshot() {
      reads++;
      if (hold) return new Promise(resolve => {finishOld = resolve;});
      return Promise.resolve(snapshot);
    },
    async command() {throw new Error('Recovery must not send commands');},
  }});
  t.after(() => {finishOld?.(snapshot); client.dispose();});
  await client.start();
  client.draft.setText('保留重连草稿');
  hold = true;
  const old = client.refresh();
  await tick();
  hold = false;
  const recovered = client.refresh();
  await tick();
  assert.equal(reads, 3, 'recovery must not wait for the previous snapshot request');
  await recovered;
  finishOld({...snapshot, revision: 99});
  await old;
  assert.equal(client.getSnapshot().snapshot.revision, 0, 'superseded responses cannot publish');
  assert.equal(client.getSnapshot().connection, 'online');
  assert.equal(client.draft.getSnapshot().text, '保留重连草稿');
});

for (const recovery of ['ready', 'snapshot']) test(`a late failed poll cannot undo a newer live ${recovery}`, async t => {
  let receive, connected, disconnected, rejectPoll, hold = false;
  const client = createConversation({scope: {environmentId: 'test-bot', conversationId: 'same'}, transport: {
    fetchSnapshot() {return hold ? new Promise((_resolve, reject) => {rejectPoll = reject;}) : Promise.resolve(snapshot);},
    subscribe(_scope, onChange, offline, online) {receive = onChange; connected = online; disconnected = offline;onChange({kind:'snapshot',snapshot});online();return () => {};},
    async command() {return {ok: true};},
  }});
  t.after(() => client.dispose());
  await client.start();
  hold = true;
  receive({kind:'patch',conversationId:'same',generation:1,baseRevision:1,revision:2,changes:[]});
  await tick();
  if (recovery === 'ready') connected();
  else receive({kind: 'snapshot', snapshot: {...snapshot, revision: 2}});
  assert.equal(client.getSnapshot().connection, 'online');
  rejectPoll(new Error('Request from the previous network finally failed'));
  await tick();
  assert.equal(client.getSnapshot().connection, 'online');

  // The transport, rather than a slow data read, owns liveness.
  disconnected();
  assert.equal(client.getSnapshot().connection, 'offline');
});
