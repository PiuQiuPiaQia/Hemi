import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesktopFlowHost, deliverableResource } from './conversation-flow-host.ts';
import { createBotConversationBridge } from '../../bot/bridge.ts';

function fixture(online = true) {
  const calls = [];
  const api = {
    async command(method, params) {
      calls.push({method, params});
      if (method === 'file.resolve') return {ok: true, artifactId: 'link-remote-report', path: '/project/report.md'};
      if (method === 'file.read') return {ok: true, text: 'REMOTE_CONTENT', name: 'report.md', path: '/project/report.md'};
      throw new Error(`Unexpected command: ${method}`);
    },
    async download(conversationId, artifactId) {
      calls.push({download: {conversationId, artifactId}});
      return {ok: true};
    },
  };
  const bridge = createBotConversationBridge(api, () => ({binding: {instanceId: 'instance-b', host: 'cloud'}}), {});
  const host = createDesktopFlowHost(bridge, 'same-conversation-id', {remote: true, online});
  const context = {scope: {environmentId: 'bot:instance-b', conversationId: 'same-conversation-id', generation: '1'},
    requestId: 'request-1', signal: new AbortController().signal};
  return {calls, host, context};
}

test('shared SDK resource host uses the injected Bot bridge and pins remote instance identity', async () => {
  const {calls, host, context} = fixture();
  const resolved = await host.resources.resolve({href: 'report.md'}, context);
  assert.equal(resolved.ok, true);
  const read = await host.resources.read({ref: resolved.value}, context);
  assert.equal(read.ok, true);
  assert.equal(read.value.content.text, 'REMOTE_CONTENT');
  assert.deepEqual(calls.map(call => call.method), ['file.resolve', 'file.read']);
  assert.ok(calls.every(call => call.params.id === 'same-conversation-id' && call.params.expectedInstanceId === 'instance-b'));
  assert.equal(calls[1].params.path, '/project/report.md');
  read.value.release();
});

test('Bot 正文路径解析失败保留宿主原因供界面展示', async () => {
  const bridge = createBotConversationBridge({ command: async () => { throw new Error('链接指向的位置不能打开。'); } },
    () => ({ binding: { instanceId: 'instance-b' } }), {});
  assert.deepEqual(await bridge.resolveConversationLink('chat', '~/.ssh/id_ed25519'),
    { ok: false, message: '链接指向的位置不能打开。' });
});

test('Bot SDK menus preserve remote download and reject local file actions or offline downloads', async () => {
  const {calls, host, context} = fixture();
  const ref = deliverableResource('remote-report');
  const actions = await host.resources.listActions({ref}, context);
  assert.deepEqual(actions.value.map(action => action.id), ['download']);
  assert.equal((await host.resources.perform({ref, actionId: 'reveal'}, context)).ok, false);
  assert.equal((await host.resources.perform({ref, actionId: 'download'}, context)).ok, true);
  assert.deepEqual(calls, [{download: {conversationId: 'same-conversation-id', artifactId: 'remote-report'}}]);
  const offline = fixture(false);
  assert.ok((await offline.host.resources.listActions({ref}, offline.context)).value[0].disabledReason);
  assert.equal((await offline.host.resources.perform({ref, actionId: 'download'}, offline.context)).ok, false);
  assert.deepEqual(offline.calls, []);
});
