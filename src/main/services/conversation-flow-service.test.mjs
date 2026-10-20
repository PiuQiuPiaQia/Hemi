// 057 conversation-flow-service 单测：单注册表、runtime 工厂注入、懒建与 drop。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initConversationFlowService, getConversationFlowService, __resetConversationFlowServiceForTests } from './conversation-flow-service.mjs';
import { createFlowSnapshot } from '../../shared/conversation-flow.mjs';

test('单注册表：同会话复用控制器；runtime 工厂注入；drop 收口', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-flow-svc-'));
  const createdConversations = [];
  const service = initConversationFlowService({
    dir,
    broadcast: () => {},
    runtimeFactory: (conversationId) => {
      createdConversations.push(conversationId);
      return {
        async start() { return { aborted: false }; },
        async merge() { return 'queued'; },
        async stop() { return { ok: true }; },
      };
    },
  });
  assert.equal(getConversationFlowService(), service, '重复 init 返回同一实例');
  const a = service.controllerFor('conv-x');
  const b = service.controllerFor('conv-x');
  assert.equal(a, b, '同会话同一控制器');
  assert.equal(service.has('conv-x'), true);
  assert.equal(service.has('conv-absent'), false);
  assert.deepEqual(createdConversations, ['conv-x'], '控制器懒建，runtime 工厂首次访问才调');
  await service.drop('conv-x');
  assert.equal(service.has('conv-x'), false);
  const c = service.controllerFor('conv-x');
  assert.notEqual(c, a, 'drop 后重建新控制器');
  assert.deepEqual(createdConversations, ['conv-x', 'conv-x']);
  await service.dropAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('列表状态只读且实时广播；恢复的后台快照不冒充本进程运行', async () => {
  __resetConversationFlowServiceForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-flow-status-'));
  const flow = { ...createFlowSnapshot({ conversationId: 'conv-status' }), tasks: {
    child: { taskId: 'child', phase: 'executing' },
  }, runs: { previous: { startedAt: 1, closedAt: 2, outcome: 'completed' } } };
  fs.writeFileSync(path.join(dir, 'conv-status.json'), JSON.stringify({ id: 'conv-status', flow }));
  const changes = [];
  const service = initConversationFlowService({ dir, broadcast: (id, change) => changes.push({ id, status: change.conversationStatus }) });
  try {
    assert.equal(service.getStatus('conv-status'), undefined);
    assert.equal(service.has('conv-status'), false, '列表读取不创建控制器');
    const controller = service.controllerFor('conv-status');
    assert.equal(service.getStatus('conv-status'), null, '旧后台快照不是在途事实');
    controller.applyFact({ type: 'task-updated', task: { taskId: 'child', phase: 'executing', permission: {} } });
    assert.equal(service.getStatus('conv-status'), 'running');
    assert.equal(changes.at(-1).status, 'running');
    controller.applyFact({ type: 'task-updated', task: { taskId: 'child', phase: 'terminal', outcome: 'complete' } });
    assert.equal(service.getStatus('conv-status'), null);
    assert.equal(changes.at(-1).status, null);
  } finally {
    await service.dropAll(); __resetConversationFlowServiceForTests(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('收口快照与未读原子提交后才通知；重复保存不重新标未读', async () => {
  __resetConversationFlowServiceForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-flow-unread-'));
  const notices = [];
  const file = path.join(dir, 'conv-unread.json');
  const service = initConversationFlowService({ dir, onUnreadChanged: id => {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    notices.push({ id, unreadAt: record.unreadAt, outcome: record.flow.runs.r1.outcome });
  } });
  try {
    const controller = service.controllerFor('conv-unread');
    controller.applyFact({ type: 'run-preparing', runId: 'r1', source: 'user', at: 1 });
    controller.applyFact({ type: 'run-started', runId: 'r1', at: 2 });
    assert.equal(notices.length, 0, '输入和运行不产生未读');
    controller.applyFact({ type: 'run-closed', runId: 'r1', outcome: 'completed', at: 3 });
    await service.store.flush('conv-unread');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].outcome, 'completed');
    assert.ok(notices[0].unreadAt > 0);
    assert.equal(service.getStatus('conv-unread'), null);
    await service.store.saveFlow('conv-unread', controller.getSnapshot());
    assert.equal(notices.length, 1);
  } finally {
    await service.dropAll(); __resetConversationFlowServiceForTests(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('控制器首次发布即有完整历史；迁移不启动运行、不标未读，重建后不再迁移', async () => {
  __resetConversationFlowServiceForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-flow-history-'));
  const id = 'conv-history', file = path.join(dir, `${id}.json`);
  const turns = [{ id: 'u1', author: 'user', text: '同文' }, { id: 'a1', author: 'hemi', text: '回答' }, { id: 'u2', author: 'user', text: '同文' }];
  const record = { id, turns, updatedAt: 10, unreadAt: 5, flow: createFlowSnapshot({ conversationId: id }) };
  fs.writeFileSync(file, JSON.stringify(record));
  let starts = 0, broadcasts = 0, unread = 0;
  const service = initConversationFlowService({ dir,
    broadcast: () => broadcasts++, onUnreadChanged: () => unread++,
    runtimeFactory: () => ({ start: async () => { starts++; }, stop: async () => {} }),
  });
  try {
    const controller = service.controllerFor(id);
    const baseline = controller.getSnapshot();
    assert.deepEqual(baseline.timeline.map(item => item.id ?? item.itemId), ['u1', 'a1', 'u2']);
    assert.equal(starts, 0); assert.equal(broadcasts, 0); assert.equal(unread, 0);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.flow, baseline);
    assert.equal(saved.updatedAt, 10); assert.equal(saved.unreadAt, 5);
    await service.drop(id);
    assert.deepEqual(service.controllerFor(id).getSnapshot().timeline, baseline.timeline);
    assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.bak')).length, 1);
  } finally {
    await service.dropAll(); __resetConversationFlowServiceForTests(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('派发即持久化正式用户项，无须等长运行收口；队列派发不留下 submitting 副本', async () => {
  __resetConversationFlowServiceForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-flow-delivery-'));
  const service = initConversationFlowService({ dir, runtimeFactory: () => ({ start: async () => ({}), stop: async () => {} }) });
  try {
    const controller = service.controllerFor('conv-live');
    const result = await controller.command({ type: 'send', input: { inputId: 'durable', text: '运行中也可恢复' } });
    assert.equal(result.ok, true);
    assert.notEqual(controller.getSnapshot().phase, 'idle', '先证明运行尚未结束');
    await service.store.flush('conv-live');
    const saved = service.store.readRecord('conv-live').flow;
    assert.deepEqual(saved.timeline.filter(item => item.kind === 'user').map(item => item.id), ['durable']);
    assert.equal(saved.pending.some(item => item.inputId === 'durable'), false);
    const queued = await controller.command({ type: 'send', input: { inputId: 'queued', text: '排队后派发也保存' } });
    assert.equal(queued.disposition, 'queued');
    controller.applyFact({ type: 'run-closed', runId: controller.getSnapshot().activeRunId, outcome: 'completed', at: 20 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.getSnapshot().runs[controller.getSnapshot().activeRunId].inputIds[0], 'queued');
    await service.store.flush('conv-live');
    const dispatched = service.store.readRecord('conv-live').flow;
    assert.deepEqual(dispatched.timeline.filter(item => item.kind === 'user').map(item => item.id), ['durable', 'queued']);
    assert.equal(dispatched.pending.length, 0);
  } finally {
    await service.dropAll(); __resetConversationFlowServiceForTests(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
