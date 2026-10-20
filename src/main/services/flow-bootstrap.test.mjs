// 057 flow-bootstrap 单测：旧 turns → flow 快照投影（顺序/身份/task/error/parts 映射）、
// 恢复口径（遗留运行标中断、submitting→needs-review、有 pending 即暂停）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapFlowFromTurns, normalizeFlowHistory, restoreFlowSnapshot } from './flow-bootstrap.mjs';

const TURNS = [
  { id: 'u1', createdAt: 10, author: 'user', text: '第一问', inputSource: 'text' },
  {
    id: 'h1', createdAt: 11, author: 'hemi', text: '先派侦察再回答',
    parts: [
      { type: 'thinking', text: '想一想', startedAt: 11, endedAt: 12 },
      { type: 'tools', calls: [{ id: 'tc1', tool: 'bash', args: { command: 'ls' }, state: 'done' }] },
      { type: 'text', text: '正文' },
    ],
    thinking: { text: '想一想', durationMs: 100 },
    usage: { modelKey: 'p/m' },
  },
  { id: 't1', createdAt: 12, author: 'hemi', kind: 'task', text: '核对文件', taskId: 'task-9', taskSnap: { taskId: 'task-9', key: 'task-9', agent: 'explorer', phase: 'terminal', outcome: 'complete', taskText: '核对文件', toolCallId: 'tc7', resultText: '报告正文'.repeat(100) } },
  { id: 'u2', createdAt: 13, author: 'user', text: '撤回的旧排队项', withdrawn: true },
  { id: 'e1', createdAt: 14, author: 'hemi', kind: 'error', text: '模型超时' },
  { id: 'h2', createdAt: 15, author: 'hemi', text: '纯文本回执' },
];

test('bootstrap：按原顺序投影、身份沿用/位置确定、withdrawn 不复活、task 进 tasks', () => {
  const snapshot = bootstrapFlowFromTurns(TURNS, { conversationId: 'c-old' });
  assert.equal(snapshot.timeline.length, 5, '六条 turns 里 withdrawn 不算');
  assert.deepEqual(snapshot.timeline.map((e) => e.kind), ['user', 'assistant', 'assistant', 'assistant', 'assistant']);
  assert.equal(snapshot.timeline[0].id, 'u1');
  assert.equal(snapshot.timeline[0].text, '第一问');
  const [firstAssistant, delegation, errorItem, plain] = snapshot.timeline.slice(1);
  assert.deepEqual(firstAssistant.parts.map((p) => p.kind), ['thinking', 'tool', 'text']);
  assert.equal(firstAssistant.parts[1].toolCallId, 'tc1');
  assert.equal(firstAssistant.parts[1].status, 'done');
  assert.equal(firstAssistant.legacyUsage.modelKey, 'p/m', '用量随段保留');
  assert.equal(delegation.parts[0].kind, 'delegation');
  assert.equal(delegation.parts[0].taskId, 'task-9');
  assert.equal(snapshot.tasks['task-9'].agent, 'explorer');
  assert.equal(snapshot.tasks['task-9'].resultPreview.length, 200, '正文只留预览');
  assert.equal(errorItem.parts[0].kind, 'notice');
  assert.equal(plain.parts[0].content, '纯文本回执');
  assert.equal(snapshot.runs.legacy.legacy, true);
  assert.equal(snapshot.phase, 'idle');
  assert.equal(bootstrapFlowFromTurns([], { conversationId: 'x' }), null);
  assert.equal(bootstrapFlowFromTurns(null, { conversationId: 'x' }), null);
});

test('restore：遗留运行标中断回 idle；submitting→needs-review；有 pending 即暂停', () => {
  const flow = {
    schemaVersion: 1,
    conversationId: 'c',
    revision: 42,
    generation: 1,
    phase: 'running',
    activeRunId: 'run-x',
    queuePaused: false,
    pending: [
      { inputId: 'a', editRevision: 0, text: '排队', inputSource: 'text', attachmentIds: [], state: 'pending' },
      { inputId: 'b', editRevision: 0, text: '悬置', inputSource: 'text', attachmentIds: [], state: 'submitting' },
    ],
    timeline: [],
    runs: { 'run-x': { runId: 'run-x', generation: 1, source: 'user', inputIds: [], startedAt: 1, endedAt: null, closedAt: null, outcome: null } },
    tasks: {}, artifacts: {}, permissions: {}, pendingReports: [],
  };
  const restored = restoreFlowSnapshot(flow);
  assert.equal(restored.phase, 'idle');
  assert.equal(restored.activeRunId, null);
  assert.equal(restored.runs['run-x'].outcome, 'interrupted');
  assert.equal(restored.queuePaused, true, '有待发送项即暂停');
  assert.equal(restored.pending[0].state, 'pending', 'pending 保留');
  assert.equal(restored.pending[1].state, 'needs-review');
  assert.equal(restored.revision, 42, 'revision 沿用');
  assert.equal(flow.phase, 'running', '原对象不被修改');
  assert.equal(restoreFlowSnapshot(null), null);
});

test('局部历史统一迁移：保序保身份、同文不去重、队列与交付不丢、幂等、不改原对象', () => {
  const turns = [...TURNS, { id: 'u3', author: 'user', text: '第一问' }, { id: 'report', author: 'hemi', taskId: 'task-9', text: '独立子报告' }];
  const original = bootstrapFlowFromTurns(TURNS, { conversationId: 'c' });
  original.revision = 50; original.generation = 6;
  original.runs.live = { runId: 'live', generation: 6, inputIds: ['u3'], source: 'user' };
  original.activeRunId = 'live'; original.phase = 'running';
  original.pending = [{ inputId: 'q', state: 'submitting', text: '队列' }];
  original.artifacts.file = { artifactId: 'file', path: '/tmp/existing.txt' };
  const before = structuredClone(original);
  const result = normalizeFlowHistory(original, turns);
  assert.equal(result.changed, true);
  assert.deepEqual(result.missingInputIds, ['u3']);
  assert.equal(result.snapshot.revision, 51); assert.equal(result.snapshot.generation, 7);
  assert.equal(result.snapshot.phase, 'idle'); assert.equal(result.snapshot.activeRunId, null);
  assert.equal(result.snapshot.runs.live.outcome, 'interrupted');
  assert.equal(result.snapshot.pending[0].state, 'needs-review'); assert.equal(result.snapshot.queuePaused, true);
  assert.deepEqual(result.snapshot.artifacts, original.artifacts);
  assert.deepEqual(result.snapshot.timeline.map(item => item.id ?? item.itemId), ['u1', 'h1', 't1', 'e1', 'h2', 'u3', 'report']);
  assert.deepEqual(original, before);
  const again = normalizeFlowHistory(result.snapshot, turns);
  assert.equal(again.changed, false); assert.equal(again.snapshot, result.snapshot);
});

test('无 ID 的旧输入使用确定位置身份，迁移后不会每次重建历史', () => {
  const turns = [{ author: 'user', text: '无身份' }, { author: 'hemi', text: '回答' }];
  const flow = { ...bootstrapFlowFromTurns(TURNS, { conversationId: 'c' }), timeline: [] };
  const repaired = normalizeFlowHistory(flow, turns);
  assert.equal(repaired.changed, true);
  assert.equal(repaired.snapshot.timeline[0].id, 'legacy:u0');
  assert.equal(normalizeFlowHistory(repaired.snapshot, turns).changed, false);
});

test('旧纯历史按版本统一迁移，覆盖用户身份齐全但助手骨架缺项的存量档案', () => {
  const flow = bootstrapFlowFromTurns(TURNS, { conversationId: 'c' });
  delete flow.historyVersion;
  flow.timeline = flow.timeline.filter(item => item.kind === 'user');
  const result = normalizeFlowHistory(flow, TURNS);
  assert.equal(result.changed, true);
  assert.equal(result.snapshot.timeline.length, TURNS.filter(turn => !turn.withdrawn).length);
  assert.equal(result.snapshot.historyVersion, 1);
  assert.equal(normalizeFlowHistory(result.snapshot, TURNS).changed, false);
});
