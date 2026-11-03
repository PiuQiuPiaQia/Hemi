import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoalResumeEcho, mergeGoalResumeEchoes } from './goal-resume-echo.ts';

const scope = { conversationId: 'conv-test', generation: 1 };
const snapshot = (...ids) => ({ ...scope, runs: Object.fromEntries(ids.map(id => [id, {}])) });
const row = (id, runId, extra = {}) => ({ id, text: id, createdAt: 0, author: 'hemi',
  flow: { runId, itemId: id, partIds: [] }, ...extra });
const message = (id, inputSource = 'text') => ({ id, text: '继续', createdAt: 50, author: 'user', inputSource });
const ids = rows => rows.map(item => item.id);

for (const inputSource of ['text', 'voice']) {
  test(`${inputSource}：回显先于新运行占位，不依赖 createdAt 或命令回执先后`, () => {
    const before = snapshot('old');
    const echo = createGoalResumeEcho(before, message('continue', inputSource));
    before.runs.resumed = {}; // 快照后续变化不能改变已冻结的边界。
    const rows = [row('old-reply', 'old'), row('waiting', 'resumed', { live: true, text: '' })];
    const result = mergeGoalResumeEchoes(rows, [echo], scope);
    assert.deepEqual(ids(result), ['old-reply', 'continue', 'waiting']);
    assert.strictEqual(result[1], echo.transcript);
    assert.deepEqual(ids(rows), ['old-reply', 'waiting']);
  });
}

test('占位换成流式分段、完成回复及下一条用户消息时，回显留在原边界', () => {
  const echo = createGoalResumeEcho(snapshot('old'), message('continue'));
  for (const live of [true, false]) {
    const rows = [row('old-reply', 'old'), row('part-1', 'resumed', { live }), row('part-2', 'resumed', { live }),
      row('next-user', 'next', { author: 'user' }), row('next-reply', 'next')];
    assert.deepEqual(ids(mergeGoalResumeEchoes(rows, [echo], scope)),
      ['old-reply', 'continue', 'part-1', 'part-2', 'next-user', 'next-reply']);
  }
});

test('多个恢复回显各守边界，同一边界保持提交顺序', () => {
  const first = createGoalResumeEcho(snapshot('old'), message('first'));
  const second = createGoalResumeEcho(snapshot('old', 'resumed'), message('second', 'voice'));
  const third = createGoalResumeEcho(snapshot('old', 'resumed'), message('third'));
  const rows = [row('old-reply', 'old'), row('resumed-reply', 'resumed'), row('waiting', 'again')];
  assert.deepEqual(ids(mergeGoalResumeEchoes(rows, [first, second, third], scope)),
    ['old-reply', 'first', 'resumed-reply', 'second', 'third', 'waiting']);
});

test('新运行未投影时先显示原话；分页补载旧运行不推移回显', () => {
  const echo = createGoalResumeEcho(snapshot('earlier', 'old'), message('continue'));
  assert.deepEqual(ids(mergeGoalResumeEchoes([row('old-reply', 'old')], [echo], scope)), ['old-reply', 'continue']);
  assert.deepEqual(ids(mergeGoalResumeEchoes([row('earlier-reply', 'earlier'), row('old-reply', 'old'), row('waiting', 'resumed')], [echo], scope)),
    ['earlier-reply', 'old-reply', 'continue', 'waiting']);
});

test('会话切换、历史回卷与未就绪快照不泄漏本地原话；无回显保留投影引用', () => {
  const rows = [row('reply', 'old')];
  const echo = createGoalResumeEcho(snapshot('old'), message('continue'));
  for (const other of [null, { ...scope, conversationId: 'conv-other' }, { ...scope, generation: 2 }])
    assert.strictEqual(mergeGoalResumeEchoes(rows, [echo], other), rows);
  assert.strictEqual(mergeGoalResumeEchoes(rows, [], scope), rows);
});
