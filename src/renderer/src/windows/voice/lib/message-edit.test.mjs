import assert from 'node:assert/strict';
import test from 'node:test';

import {
  historyFromTurns,
  isEditableMessage,
  resolveEditingId,
  rewindToMessage,
  supersedeTrailingErrors,
} from './message-edit.ts';

/** 构造器缩写：用户文字消息。 */
const u = (id, text, extra = {}) => ({ id, text, createdAt: 1, author: 'user', inputSource: 'text', ...extra });
/** 构造器缩写：Hemi 回复。 */
const h = (id, text, extra = {}) => ({ id, text, createdAt: 2, author: 'hemi', ...extra });
/** 语音用户消息。 */
const v = (id, text, extra = {}) => ({ id, text, createdAt: 3, author: 'user', inputSource: 'voice', ...extra });
/** 任务卡。 */
const t = (id, taskId) => ({ id, text: '', createdAt: 4, author: 'hemi', kind: 'task', taskSeq: 1, ...(taskId ? { taskId } : {}) });
/** 2026-10-07 会话审计：回合失败留痕（正文＝失败原因）。 */
const err = (id, text) => ({ id, text, createdAt: 5, author: 'hemi', kind: 'error' });

// ---- isEditableMessage ----

test('用户消息均可编辑（语音/文字/已编辑过的），其余不可', () => {
  assert.equal(isEditableMessage(u('a', '你好')), true);
  assert.equal(isEditableMessage(v('b', '语音说的')), true);
  assert.equal(isEditableMessage(u('c', '改过一次', { editedAt: 9 })), true);
  assert.equal(isEditableMessage(h('d', '回复')), false);
  assert.equal(isEditableMessage(t('e')), false);
});

// ---- rewindToMessage ----

test('回卷撤下编辑点之后的全部内容（含任务卡），编辑条原位替换文本', () => {
  const before = [u('1', '第一句'), h('2', '第一答'), u('3', '原话'), h('4', '原回复'), t('5', 'task-a'), u('6', '追问')];
  const rewind = rewindToMessage(before, '3', '改后的话', 99);
  assert.deepEqual(rewind.turns.map((item) => item.id), ['1', '2', '3']);
  assert.equal(rewind.turns[2].text, '改后的话');
  assert.equal(rewind.turns[2].editedAt, 99);
  assert.equal(rewind.cutCount, 3);
  // 剪除键：条目 id＋任务卡的 taskId 并集。
  assert.deepEqual([...rewind.cutKeys].sort(), ['4', '5', '6', 'task-a']);
  // 原数组不被改写（React 状态习惯）。
  assert.equal(before[2].text, '原话');
  assert.equal(before.length, 6);
});

test('编辑最后一条时没有撤下项（cutKeys 为空）', () => {
  const before = [u('1', '第一句'), h('2', '第一答'), u('3', '最后一句')];
  const rewind = rewindToMessage(before, '3', '最后一句改', 9);
  assert.deepEqual(rewind.turns.map((item) => item.id), ['1', '2', '3']);
  assert.equal(rewind.cutCount, 0);
  assert.deepEqual(rewind.cutKeys, []);
});

test('已编辑过的消息可再编辑（editedAt 覆盖打点）', () => {
  const before = [u('1', '一次修改', { editedAt: 9 })];
  const rewind = rewindToMessage(before, '1', '二次修改', 99);
  assert.equal(rewind.turns[0].text, '二次修改');
  assert.equal(rewind.turns[0].editedAt, 99);
});

test('重发重锚 createdAt＝editedAt（2026-10-14 用户裁决：重发的消息按「现在」摆位）', () => {
  const before = [u('1', '旧话', { createdAt: 1000 }), h('2', '旧答', { createdAt: 2000 })];
  const rewind = rewindToMessage(before, '1', '新话', 5000);
  assert.equal(rewind.turns[0].createdAt, 5000);
  assert.equal(rewind.turns[0].editedAt, 5000);
  // id 保持稳定（剪除键与宿主合并按 id 对账，不随时间锚变）。
  assert.equal(rewind.turns[0].id, '1');
});

test('编辑不存在的消息返回 null（竞态防御）', () => {
  const before = [u('1', '原话')];
  assert.equal(rewindToMessage(before, 'missing', 'x', 1), null);
});

// ---- historyFromTurns（回卷后即重跑上下文） ----

test('historyFromTurns：任务卡、失败留痕、空文本不进模型上下文', () => {
  const transcripts = [
    u('1', '你是谁'),
    err('2', '文本模型请求失败（HTTP 400）'),
    u('3', '1'),
    h('4', '我是 Hemi'),
    t('5'),
    { id: '6', text: '', createdAt: 6, author: 'user' },
  ];
  assert.deepEqual(historyFromTurns(transcripts), [
    { author: 'user', text: '你是谁' },
    { author: 'user', text: '1' },
    { author: 'hemi', text: '我是 Hemi' },
  ]);
});

test('回卷产物直接经 historyFromTurns 得重跑上下文（含替换后文本）', () => {
  const before = [u('1', '第一句'), h('2', '第一答'), u('3', '原话'), h('4', '旧回复'), t('5')];
  const rewind = rewindToMessage(before, '3', '改后的话', 99);
  assert.deepEqual(historyFromTurns(rewind.turns), [
    { author: 'user', text: '第一句' },
    { author: 'hemi', text: '第一答' },
    { author: 'user', text: '改后的话' },
  ]);
});

// ---- 编辑态与会话切换 ----

test('resolveEditingId：消息被清场后编辑态失效', () => {
  assert.equal(resolveEditingId([u('1', 'x')], '1'), '1');
  assert.equal(resolveEditingId([u('1', 'x')], 'missing'), null);
  assert.equal(resolveEditingId([], null), null);
});

// ---- supersedeTrailingErrors（重试收走旧失败留痕，2026-10-14 会话审计） ----

test('重试收走结尾连续的全部 error 回合（连败连点只保最新一条）', () => {
  const before = [u('1', '拉一下最新代码'), err('e1', '注册失败'), err('e2', '注册失败'), err('e3', '注册失败')];
  const out = supersedeTrailingErrors(before);
  assert.deepEqual(out.turns.map((item) => item.id), ['1']);
  assert.deepEqual(out.cutKeys, ['e1', 'e2', 'e3']);
  assert.equal(out.cutCount, 3);
  // 原数组不被改写（React 状态习惯）。
  assert.equal(before.length, 4);
});

test('结尾无 error 回合时返回 null（调用方免剪）', () => {
  assert.equal(supersedeTrailingErrors([u('1', '问'), h('2', '答')]), null);
  assert.equal(supersedeTrailingErrors([]), null);
});

test('中部历史 error 不动，只收结尾连续段', () => {
  const before = [u('1', '问'), err('e1', '旧失败'), h('2', '答过'), u('3', '再问'), err('e2', '新失败')];
  const out = supersedeTrailingErrors(before);
  assert.deepEqual(out.turns.map((item) => item.id), ['1', 'e1', '2', '3']);
  assert.deepEqual(out.cutKeys, ['e2']);
});
