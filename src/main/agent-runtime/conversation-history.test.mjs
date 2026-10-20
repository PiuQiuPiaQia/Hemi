import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContextStore } from './context-store.mjs';
import { createConversationHistoryReader } from './conversation-history.mjs';
import { createAgentTools } from '../agent/agent-tools.mjs';
import { judgeAccess } from '../agent/gate/access-policy.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hemi-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessions = { 'conv-old': { id: 'conv-old', title: '完整历史', turns: Array.from({ length: 20 }, (_, i) => ({
    id: `turn-${i}`, author: i % 2 ? 'hemi' : 'user', createdAt: i + 1,
    text: `BEGIN_${i}\n${'长消息🧭'.repeat(450)}\nEND_${i}`,
  })), agentSession: { entries: [{ message: { role: 'system', content: 'PRIVATE_SECRET' } }] } } };
  sessions['conv-old'].turns.push({ id: 'removed', author: 'user', text: 'WITHDRAWN_SECRET', withdrawn: true });
  const store = createContextStore({ dir });
  const reader = createConversationHistoryReader({ loadSession: id => sessions[id], contextStore: store });
  const context = { owner: { conversationId: 'conv-current', rootRunId: 'run-test' } };
  return { sessions, store, reader, context };
}

test('所有消息完整分段返回，跨单条消息边界与 emoji 无丢失；不返回撤回或私有内容', async t => {
  const { reader, sessions, context } = await fixture(t);
  const first = await reader.read({ conversationId: 'conv-old', limit: 997 }, context);
  let page = first, joined = '', pages = 0;
  while (true) {
    assert.equal(page.offset, joined.length);
    assert.ok(page.text.length <= 997);
    joined += page.text; pages++;
    if (page.nextOffset === null) break;
    page = await reader.read({ conversationId: 'conv-old', snapshotRef: first.snapshotRef, offset: page.nextOffset, limit: 997 }, context);
  }
  assert.ok(pages > 20);
  assert.equal(first.turnCount, 20);
  assert.equal(joined.length, first.totalChars);
  let previous = -1;
  for (const turn of sessions['conv-old'].turns.slice(0, 20)) {
    const at = joined.indexOf(turn.text);
    assert.ok(at > previous, `缺少完整消息 ${turn.id}`); previous = at;
    assert.equal(joined.split(turn.text).length - 1, 1);
  }
  assert.doesNotMatch(joined, /PRIVATE_SECRET|WITHDRAWN_SECRET/);
  const replay = await reader.read({ conversationId: 'conv-old', snapshotRef: first.snapshotRef, offset: 0, limit: 997 }, context);
  assert.equal(replay.text, first.text);
});

test('快照跨 reader 重建及新根可续读，追加不漂移，编辑／撤回／删除不能继续读旧快照', async t => {
  const { reader, sessions, store, context } = await fixture(t);
  const first = await reader.read({ conversationId: 'conv-old', limit: 100 }, context);
  const args = { conversationId: 'conv-old', snapshotRef: first.snapshotRef, offset: first.nextOffset };
  sessions['conv-old'].turns.push({ id: 'new', author: 'user', text: 'APPENDED' });
  const restored = createConversationHistoryReader({ loadSession: id => sessions[id], contextStore: store });
  const next = await restored.read(args, { owner: { ...context.owner, rootRunId: 'another-root' } });
  assert.equal(next.totalChars, first.totalChars);
  assert.equal(next.turnCount, 20);
  sessions['conv-old'].turns[0].text += 'EDITED';
  await assert.rejects(reader.read(args, context), /重新读取/);
  const refreshed = await reader.read({ conversationId: 'conv-old' }, context);
  sessions['conv-old'].turns[0].withdrawn = true;
  await assert.rejects(reader.read({ ...args, snapshotRef: refreshed.snapshotRef }, context), /重新读取/);
  delete sessions['conv-old'];
  await assert.rejects(reader.read(args, context), /重新读取/);
});

test('校验目标身份、快照归属、偏移和长度；停止前后都不返回正文', async t => {
  const { reader, sessions, store, context } = await fixture(t);
  const first = await reader.read({ conversationId: 'conv-old' }, context);
  const args = { conversationId: 'conv-old', snapshotRef: first.snapshotRef };
  for (const conversationId of ['../private', 'missing', '']) await assert.rejects(reader.read({ conversationId }, context), /无效|找不到/);
  for (const extra of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 16001 }]) await assert.rejects(reader.read({ ...args, ...extra }, context), /offset|limit/);
  await assert.rejects(reader.read({ conversationId: 'conv-old', offset: 1 }, context), /snapshotRef/);
  await assert.rejects(reader.read({ ...args, offset: first.totalChars + 1 }, context), /超出/);
  await assert.rejects(reader.read(args, { owner: { conversationId: 'conv-foreign' } }), /当前对话/);
  await assert.rejects(reader.read({ ...args, conversationId: 'conv-other' }, context), /不一致/);
  await assert.rejects(reader.read({ ...args, snapshotRef: '../private' }, context), /无效/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reader.read(args, { ...context, signal: controller.signal }), /abort/i);
  let loads = 0;
  const cancelledReader = createConversationHistoryReader({ loadSession: () => { loads++; return sessions['conv-old']; }, contextStore: store });
  await assert.rejects(cancelledReader.read(args, { ...context, cancelled: () => true }), /停止/);
  assert.equal(loads, 0);
  const active = new AbortController();
  const afterRead = createConversationHistoryReader({ loadSession: id => sessions[id], contextStore: { ...store, read: async options => { const page = await store.read(options); active.abort(); return page; } } });
  await assert.rejects(afterRead.read(args, { ...context, signal: active.signal }), /abort/i);
});

test('空会话、附件和引用有明确结果；工具传递身份、分页和取消信号，门控允许只读查询', async t => {
  const { reader, sessions, context } = await fixture(t);
  sessions['conv-empty'] = { id: 'conv-empty', title: '空会话', turns: [] };
  const empty = await reader.read({ conversationId: 'conv-empty' }, context);
  assert.equal(empty.text, ''); assert.equal(empty.turnCount, 0); assert.equal(empty.nextOffset, null);
  sessions['conv-empty'].turns.push({ id: 'file', author: 'user', text: '', attachments: [{ name: '照片.png' }], references: [{ kind: 'conversation', targetConversationId: 'conv-old' }] });
  const withFile = await reader.read({ conversationId: 'conv-empty' }, context);
  assert.match(withFile.text, /照片.png/); assert.match(withFile.text, /conv-old/);
  const controller = new AbortController();
  const tool = createAgentTools({ conversationRead: (args, signal) => {
    assert.equal(signal, controller.signal); return reader.read(args, { ...context, signal });
  } }).find(tool => tool.name === 'conversation_read');
  const result = JSON.parse((await tool.execute('call', { conversationId: 'conv-empty' }, controller.signal)).content[0].text);
  assert.equal(result.conversationId, 'conv-empty'); assert.equal(result.nextOffset, null);
  for (const scope of [{}, { phase: 'verify' }, { boundary: 'readonly' }]) assert.equal(judgeAccess({ tool: 'conversation_read', input: {}, q: {}, ...scope }).verdict, 'allow');
});
