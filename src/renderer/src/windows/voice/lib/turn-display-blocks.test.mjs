import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTurnDisplayBlocks } from './turn-display-blocks.ts';
import { flowPartsToTranscriptParts } from './transcript-parts-view.ts';

const thinking = (id, text = '内部思考') => ({ partId: id, type: 'thinking', text, startedAt: 100, endedAt: 200 });
const text = (id, value) => ({ partId: id, type: 'text', text: value });
const call = (id, tool = 'read', state = 'done') => ({ id, tool, args: { path: `${id}.md` }, state });
const tools = (id, ...calls) => ({ partId: id, type: 'tools', calls });

test('text 划分阶段，跨思考段归组，正文和组内事实保持原序', () => {
  const parts = [thinking('prelude'), text('intro', '我先核对文件。'),
    tools('read', call('r')), thinking('analysis'), tools('command', call('b', 'bash')),
    text('finding', '已确认原因，继续验证。'), thinking('check'), tools('verify', call('v', 'bash', 'error')),
    text('answer', '验证未通过。')];
  const before = structuredClone(parts);
  const blocks = buildTurnDisplayBlocks(parts);
  assert.deepEqual(blocks.map(b => b.kind), ['activity', 'content', 'activity', 'content', 'activity', 'content']);
  assert.deepEqual(blocks[2].entries.map(e => e.kind === 'tool' ? e.call.id : e.id), ['r', 'analysis', 'b']);
  assert.deepEqual(blocks.filter(b => b.kind === 'content').map(b => [b.part.text, b.index]),
    [['我先核对文件。', 1], ['已确认原因，继续验证。', 5], ['验证未通过。', 8]]);
  assert.equal(blocks[4].entries[1].call.state, 'error');
  assert.deepEqual(parts, before, '仅展示投影，不改持久化事实');
});

test('同组流式追加思考和工具保持组身份，收到正文后保留已有分组', () => {
  const parts = [text('intro', '先查资料。'), thinking('k')];
  const initial = buildTurnDisplayBlocks(parts)[1];
  parts.push(tools('t', call('one', 'read', 'running')), thinking('k2'));
  const extended = buildTurnDisplayBlocks(parts)[1];
  assert.equal(extended.id, initial.id);
  assert.equal(extended.lastIndex, 3);
  parts.push(text('finding', '找到结果。'));
  assert.equal(buildTurnDisplayBlocks(parts)[1].id, initial.id);
  assert.equal(buildTurnDisplayBlocks(parts)[2].part.text, '找到结果。');
});

test('子任务在混合工具组中保留独立入口，前后普通工具不跨任务合并', () => {
  const parts = [thinking('before'), tools('mixed', call('a'), call('task', 'task'), call('b', 'bash')),
    thinking('after')];
  const blocks = buildTurnDisplayBlocks(parts);
  assert.deepEqual(blocks.map(b => b.kind), ['activity', 'task', 'activity']);
  assert.equal(blocks[1].call.id, 'task');
  assert.deepEqual(blocks[0].entries.map(e => e.kind), ['thinking', 'tool']);
  assert.deepEqual(blocks[2].entries.map(e => e.kind), ['tool', 'thinking']);
  assert.notEqual(blocks[0].id, blocks[2].id);
});

test('文件交付、工作流和相邻正文保留各自位置，过程不跨越这些边界', () => {
  const file = { partId: 'file', type: 'file-delivery', artifactId: 'artifact', name: '结果.md' };
  const workflow = { partId: 'workflow', type: 'workflow-card', card: { invocationId: 'flow', title: '检查', status: 'completed' } };
  const parts = [thinking('k'), file, tools('t', call('a')), workflow, thinking('k2'),
    text('a', '第一段'), text('b', '第二段')];
  const blocks = buildTurnDisplayBlocks(parts);
  assert.deepEqual(blocks.map(b => b.kind), ['activity', 'content', 'activity', 'content', 'activity', 'content', 'content']);
  assert.strictEqual(blocks[1].part, file);
  assert.strictEqual(blocks[3].part, workflow);
});

test('生产 flow 投影得到的思考/工具可直接分组，失败和停止状态完整保留', () => {
  const mapped = flowPartsToTranscriptParts([
    { partId: 'text', kind: 'text', content: '先检查。' },
    { partId: 'tool1', kind: 'tool', toolCallId: 'a', tool: 'read', status: 'error' },
    { partId: 'thinking', kind: 'thinking', content: '核对原因。', startedAt: 100, endedAt: 200 },
    { partId: 'tool2', kind: 'tool', toolCallId: 'b', tool: 'bash', status: 'stopped' },
  ]);
  const blocks = buildTurnDisplayBlocks(mapped);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[1].entries.map(e => e.kind === 'tool' ? e.call.state : e.kind), ['error', 'thinking', 'stopped']);
});

test('纯思考、纯文本、空工具组和无 partId 的旧档均可展示', () => {
  assert.deepEqual(buildTurnDisplayBlocks([]), []);
  assert.deepEqual(buildTurnDisplayBlocks([tools('empty')]), []);
  assert.equal(buildTurnDisplayBlocks([thinking('only')])[0].entries.length, 1);
  assert.equal(buildTurnDisplayBlocks([{ type: 'text', text: '简短回答' }])[0].id, 'text-0');
  const legacy = buildTurnDisplayBlocks([{ type: 'thinking', text: '想', startedAt: 1, endedAt: 2 },
    { type: 'tools', calls: [call('a')] }]);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].entries.length, 2);
});
