import assert from 'node:assert/strict';
import test from 'node:test';
import { groupStageBriefs, isStageBrief, visibleStageCount } from './stage-briefs.ts';

const user = (id, text = '问') => ({ id, text, createdAt: 0, author: 'user' });
const hemi = (id, extra = {}) => ({ id, text: id, createdAt: 0, author: 'hemi', ...extra });
const card = (taskId) => hemi(`task-card:${taskId}`, { kind: 'task', taskSeq: 1, taskId });

const shape = (entries) =>
  entries.map((entry) =>
    entry.type === 'stages'
      ? `[${entry.items.map((item) => item.id).join(',')}]${entry.showRelation ? '@' : ''}${entry.latest ? '*' : ''}`
      : `${entry.item.id}${entry.showRelation ? '@' : ''}`,
  );

test('紧跟任务卡的连续简报收成一组，不挂任务标识；终态交代不进组', () => {
  const entries = groupStageBriefs([
    user('q'),
    hemi('ack'),
    card('t1'),
    hemi('s1', { taskId: 't1' }),
    hemi('s2', { taskId: 't1' }),
    hemi('s3', { taskId: 't1' }),
    hemi('task-result:t1:complete', { taskId: 't1' }),
  ]);
  assert.deepEqual(shape(entries), ['q', 'ack', 'task-card:t1', '[s1,s2,s3]*', 'task-result:t1:complete']);
  assert.equal(entries[3].key, 'stages:s1');
});

test('插话打断后另起一组并挂标识；只有最后一组算最新', () => {
  const entries = groupStageBriefs([
    card('t1'),
    hemi('s1', { taskId: 't1' }),
    user('chat'),
    hemi('reply'),
    hemi('s2', { taskId: 't1' }),
    hemi('task-verify-fail:t1:9', { taskId: 't1' }),
  ]);
  assert.deepEqual(shape(entries), ['task-card:t1', '[s1]', 'chat', 'reply', '[s2]@*', 'task-verify-fail:t1:9']);
});

test('并发两任务交错：按 taskId 分组，换任务即挂标识', () => {
  const entries = groupStageBriefs([
    card('a'),
    card('b'),
    hemi('a1', { taskId: 'a' }),
    hemi('b1', { taskId: 'b' }),
    hemi('b2', { taskId: 'b' }),
    hemi('task-result:a:complete', { taskId: 'a' }),
  ]);
  assert.deepEqual(shape(entries), ['task-card:a', 'task-card:b', '[a1]@*', '[b1,b2]@*', 'task-result:a:complete@']);
});

test('旧档缺身份、失败留痕都不进组；冻结卡按快照身份认任务', () => {
  assert.equal(isStageBrief(hemi('x')), false);
  // 2026-10-10 回卷语义改版：stale 标记已删（被撤下内容整段移除，不再带标记落档）。
  assert.equal(isStageBrief(hemi('x', { taskId: 't', kind: 'error' })), false);
  const frozen = hemi('old-card', { kind: 'task', taskSeq: 1, taskSnap: { taskId: 't9' } });
  assert.deepEqual(shape(groupStageBriefs([frozen, hemi('s', { taskId: 't9' })])), ['old-card', '[s]*']);
});

test('超过 4 条折叠成最近 3 条，展开后全显', () => {
  assert.equal(visibleStageCount(4, false), 4);
  assert.equal(visibleStageCount(6, false), 3);
  assert.equal(visibleStageCount(6, true), 6);
});
