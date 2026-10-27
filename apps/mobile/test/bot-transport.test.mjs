import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBotHost} from '../../../src/main/bot/host.mjs';
import {createConversation} from '@hemi/conversation-flow/core';
import {moduleUnderTest} from '../../../packages/conversation-flow/test/compile.mjs';

const {createBotConversationTransport, BotCommandRejected} = await moduleUnderTest('../../../apps/mobile/src/bot/conversation-transport.ts');
const context = () => ({signal: new AbortController().signal});
async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-mobile-bot-'));
  const executions = [], waiting = new Map(), calls = [];
  const host = await createBotHost({dataDir: path.join(folder, 'data'), defaultDir: path.join(folder, 'workspace'),
    validateModel: async () => {}, executorFactory: () => ({
      run(spec) {executions.push(spec); return new Promise(resolve => waiting.set(spec.conversationId, resolve));},
      async stop(id) {waiting.get(id)?.({stopped: true});},
      decide: () => true,
      async close() {for (const resolve of waiting.values()) resolve({stopped: true});},
    }),
  });
  t.after(async () => {await host.close(); await fs.rm(folder, {recursive: true, force: true});});
  const {instanceId} = await host.request('handshake');
  const request = (method, params = {}) => host.request(method, {instanceId, requestId: 'setup-' + randomUUID(), ...params});
  await request('model.sync', {models: [{modelKey: 'fixture/model', providerId: 'fixture', name: 'Synthetic', model: 'fake', api: 'openai-completions', baseUrl: 'https://fixture.invalid/v1', apiKey: 'SYNTHETIC_ONLY'}]});
  const {id} = await request('session.create');
  let drop = false, offline = false;
  const rpc = {async request(method, params, {signal}) {
    signal.throwIfAborted(); if(offline)throw new Error('Network offline'); calls.push({method, params});
    let result;
    try {result = await host.request(method, params);}
    catch (error) {throw new BotCommandRejected(error.code ?? 'failed', error.message);}
    if (drop && method === 'flow.command') {drop = false; offline = true; throw new Error('Lost SSH reply');}
    return result;
  }};
  const scope = {environmentId: `bot:${instanceId}`, conversationId: id};
  return {host, request, scope, calls, executions, transport: createBotConversationTransport(rpc, instanceId, id), dropReply() {drop = true;}, reconnect() {offline = false;}};
}

test('mobile transport speaks the actual Host protocol; stable operation ID creates one input and run', async t => {
  const f = await fixture(t);
  const snapshot = await f.transport.fetchSnapshot(f.scope, context());
  assert.equal(snapshot.conversationId, f.scope.conversationId);
  const command = {type: 'send', input: {inputId: 'mobile-stable-input', text: '手机输入', inputSource: 'text', attachmentIds: []}};
  const request = {scope: f.scope, requestId: 'mobile-stable-operation', generation: snapshot.generation, command};
  assert.deepEqual(await f.transport.command(request, context()), await f.transport.command(request, context()));
  const deadline = Date.now() + 2000;
  while (!f.executions.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const result = await f.transport.fetchSnapshot(f.scope, context());
  assert.equal(result.timeline.filter(item => item.kind === 'user').length, 1);
  assert.equal(f.executions.length, 1);
  assert.equal((await f.transport.lookupOperation(f.scope, request.requestId, context())).ok, true);
});

test('SDK reconciles an actual accepted-but-lost Host reply without replaying or clearing a newer draft', async t => {
  const f = await fixture(t);
  const client = createConversation({scope: f.scope, transport: f.transport, pollIntervalMs: 0});
  t.after(() => client.dispose()); await client.start();
  client.draft.setText('已受理但丢失回执'); f.dropReply();
  assert.equal((await client.sendDraft()).code, 'unknown');
  assert.equal(client.getSnapshot().operations.at(-1).state, 'unknown');
  client.draft.setText('后来写下的草稿'); f.reconnect(); await client.refresh();
  assert.equal(client.getSnapshot().operations.at(-1).state, 'accepted');
  assert.equal(client.draft.getSnapshot().text, '后来写下的草稿');
  assert.equal(f.calls.filter(call => call.method === 'flow.command').length, 1);
  assert.equal((await f.request('session.open', {id: f.scope.conversationId})).flow.timeline.filter(item => item.kind === 'user').length, 1);
});

test('cross-environment, cross-conversation and aborted calls never reach the Bot', async t => {
  const f = await fixture(t), count = f.calls.length;
  await assert.rejects(f.transport.fetchSnapshot({...f.scope, environmentId: 'bot:other'}, context()), /身份/);
  await assert.rejects(f.transport.fetchSnapshot({...f.scope, conversationId: 'other'}, context()), /身份/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.transport.fetchSnapshot(f.scope, {signal: abort.signal}));
  assert.equal(f.calls.length, count);
});

test('missing receipt is read-only and permanent Host rejection is a rejected operation', async t => {
  const f = await fixture(t);
  assert.equal(await f.transport.lookupOperation(f.scope, 'not-received', context()), null);
  assert.equal(f.calls.at(-1).method, 'operation.get');
  await f.request('service.stop');
  const client = createConversation({scope: f.scope, transport: f.transport, pollIntervalMs: 0});
  t.after(() => client.dispose()); await client.start();
  client.draft.setText('服务已停时发送');
  assert.equal((await client.sendDraft()).ok, false);
  assert.equal(client.getSnapshot().operations.at(-1).state, 'rejected');
  assert.equal(client.draft.getSnapshot().text, '服务已停时发送');
});

test('interrupted Host receipt is definitive and read-only', async () => {
  const calls = [], scope = {environmentId: 'bot:instance', conversationId: 'conversation'};
  const transport = createBotConversationTransport({async request(method) {calls.push(method); return {status: 'interrupted'};}}, 'instance', 'conversation');
  assert.deepEqual(await transport.lookupOperation(scope, 'interrupted-request', context()),
    {ok: false, code: 'rejected', message: '上次发送已中断，原文已保留，可以重新发送。'});
  assert.deepEqual(calls, ['operation.get']);
});

test('an actual Host rewind fences a missing legacy send; restoring the SDK unblocks the current draft without replay', async t => {
  const f = await fixture(t);
  await f.request('flow.command', {id: f.scope.conversationId, generation: 1,
    command: {type: 'send', input: {inputId: 'original', text: 'before edit'}}});
  await f.request('flow.command', {id: f.scope.conversationId, generation: 1,
    command: {type: 'rewind', targetInputId: 'original', input: {inputId: 'replacement', text: 'after edit'}}});
  const deadline = Date.now() + 3000;
  let current;
  do {current = await f.transport.fetchSnapshot(f.scope, context()); if (current.generation === 2) break; await new Promise(resolve => setTimeout(resolve, 10));} while (Date.now() < deadline);
  assert.equal(current.generation, 2);
  const fenced = await f.transport.command({scope: f.scope, generation: 1, requestId: 'prove-old-generation-fence',
    command: {type: 'send', input: {inputId: 'never-dispatched', text: 'old generation'}}}, context());
  assert.equal(fenced.ok, false);
  assert.equal(await f.transport.lookupOperation(f.scope, 'legacy-missing-receipt', context()), null);
  let journal = [{id: 'legacy-missing-receipt', state: 'unknown', generation: 1,
    command: {type: 'send', input: {inputId: 'legacy-input', text: 'uncertain old input'}}}];
  const client = createConversation({scope: f.scope, transport: f.transport, pollIntervalMs: 0,
    storage: {operations: {async load() {return journal;}, async save(_scope, value) {journal = structuredClone(value);}}}});
  t.after(() => client.dispose());
  client.draft.setText('new draft');
  const calls = f.calls.filter(call => call.method === 'flow.command').length;
  await client.start(); await client.refresh();
  assert.equal(client.getSnapshot().operations[0].result.code, 'superseded');
  assert.equal(client.getSnapshot().error, '');
  assert.equal(client.draft.getSnapshot().text, 'new draft');
  assert.equal(f.calls.filter(call => call.method === 'flow.command').length, calls);
  assert.ok(!f.executions.some(run => ['legacy-input', 'never-dispatched'].includes(run.envelope.inputId)));
});
