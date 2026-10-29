import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleUnderTest } from './compile.mjs';
const { buildTurnDisplayBlocks } = await moduleUnderTest('../src/presentation/turn-display-blocks.ts');
const { estimateTurnDurationMs } = await moduleUnderTest('../src/presentation/turn-display-blocks.ts');


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

test('065 完成态：回答之前的全部过程（含过程文本）折入首个整轮组，仅尾段文本外显', () => {
  const parts = [text('intro', '我先核对文件。'), thinking('analysis'), tools('read', call('r')),
    text('finding', '已确认原因，继续验证。'), tools('verify', call('v', 'bash', 'error')),
    text('answer', '验证未通过。'), text('ps', '以上。')];
  const before = structuredClone(parts);
  const blocks = buildTurnDisplayBlocks(parts, { complete: true });
  assert.deepEqual(blocks.map(b => b.kind), ['activity', 'content', 'content']);
  const group = blocks[0];
  assert.equal(group.turnSummary, true, '首组是整轮过程组');
  assert.deepEqual(group.entries.map(e => e.kind === 'tool' ? e.call.id : e.id),
    ['intro', 'analysis', 'r', 'finding', 'v'], '过程文本按原序入组');
  assert.equal(group.entries[0].kind, 'say');
  assert.deepEqual(blocks.filter(b => b.kind === 'content').map(b => b.part.text),
    ['验证未通过。', '以上。'], '尾段连续文本都算回答');
  assert.deepEqual(parts, before, '仅展示投影，不改持久化事实');
  // 同样的 parts 不传 complete 时保持执行态分组（已有用例口径）。
  assert.deepEqual(buildTurnDisplayBlocks(parts).map(b => b.kind),
    ['content', 'activity', 'content', 'activity', 'content', 'content']);
});

test('065 完成态：无尾段文本（以动作收尾、无回答）退回执行态分组，过程保持可见', () => {
  const parts = [text('intro', '我先核对文件。'), thinking('analysis'), tools('read', call('r'))];
  const blocks = buildTurnDisplayBlocks(parts, { complete: true });
  assert.deepEqual(blocks.map(b => b.kind), ['content', 'activity']);
  assert.equal(blocks[1].turnSummary, undefined);
  assert.ok(!blocks.some(b => b.kind === 'activity' && b.entries.some(e => e.kind === 'say')));
});

test('065 完成态：task 与交互块仍是边界，被分隔的后续活动组沿用执行态头部', () => {
  const file = { partId: 'file', type: 'file-delivery', artifactId: 'artifact', name: '结果.md' };
  const parts = [text('intro', '先看文件。'), tools('t', call('a')), file,
    text('mid', '交付后继续验证。'), tools('verify', call('v')), text('answer', '完成。')];
  const blocks = buildTurnDisplayBlocks(parts, { complete: true });
  assert.deepEqual(blocks.map(b => b.kind), ['activity', 'content', 'activity', 'content']);
  assert.equal(blocks[0].turnSummary, true, '仅首组为整轮过程组');
  assert.equal(blocks[2].turnSummary, undefined, '被交付块分隔的组沿用执行态头部');
  assert.equal(blocks[0].entries[0].kind, 'say');
  assert.equal(blocks[2].entries[0].kind, 'say');
  assert.equal(blocks[3].part.text, '完成。');
});

test('065 时长兜底：取思考段最早开始到最晚结束，无有效区间返回 0', () => {
  assert.equal(estimateTurnDurationMs([text('a', '正文')]), 0);
  assert.equal(estimateTurnDurationMs([{ type: 'thinking', text: '流式中', startedAt: 100, endedAt: null }]), 0);
  assert.equal(estimateTurnDurationMs([
    { type: 'thinking', text: '一', startedAt: 1_000, endedAt: 4_000 },
    { type: 'tools', calls: [call('r')] },
    { type: 'thinking', text: '二', startedAt: 5_000, endedAt: 633_000 },
  ]), 632_000);
});

