import test from 'node:test';
import assert from 'node:assert/strict';
import { createTagUndoStack } from './composer-tag-undo.ts';

const skill = (name) => ({ token: name, name, source: 'library', skillId: `lib:${name}` });
const state = (text, skills = [], references = [], caret = 0) => ({ text, skills, references, caret });

test('063 R-05：撤销/重做同时恢复正文与标签身份；新编辑清 redo', () => {
  let now = 1000;
  const stack = createTagUndoStack({ now: () => now, coalesceMs: 700 });
  // 状态 A（带技能标签）→ 变更到 B 前，先压 A。
  const a = state('任务', [skill('pdf')], [], 3);
  stack.pushCheckpoint(a);
  const b = state('任务 B', [], [], 5);
  // 又一次变更前压 B；随后撤销应先回 B、再回 A。
  stack.pushCheckpoint(b);
  const undoneOnce = stack.undo(state('任务 B2', [], [], 6));
  assert.equal(undoneOnce.text, '任务 B');
  const undoneTwice = stack.undo(undoneOnce);
  assert.equal(undoneTwice.text, '任务');
  assert.equal(undoneTwice.skills.length, 1, '撤销恢复标签身份');
  const redone = stack.redo(undoneTwice);
  assert.equal(redone.text, '任务 B');
  // 撤销后再次编辑：redo 清空。
  stack.undo(redone);
  stack.pushCheckpoint(redone);
  assert.equal(stack.canRedo(), false);
});

test('063：连续击键在合批窗口内并为一条快照；程序化变化必压栈', () => {
  let now = 1000;
  const stack = createTagUndoStack({ now: () => now, coalesceMs: 700 });
  stack.push(state('a', [], [], 1));
  now += 100;
  stack.push(state('ab', [], [], 2));
  now += 100;
  stack.push(state('abc', [], [], 3));
  now += 2000; // 超出合批窗口
  stack.push(state('abcd', [], [], 4));
  assert.equal(stack.canUndo(), true);
  const undone = stack.undo(state('abcde', [], [], 5));
  assert.equal(undone.text, 'abcd', '窗口外的第一次击键单独成栈');
  const second = stack.undo(undone);
  assert.equal(second.text, 'a', '合批窗口内的连续击键一次撤回到起点');
  const third = stack.undo(second);
  assert.equal(third, null);
});

test('063：越界（无可撤销）返回 null；reset 整栈作废', () => {
  const stack = createTagUndoStack();
  assert.equal(stack.undo(state('x')), null);
  stack.pushCheckpoint(state('x'));
  stack.reset();
  assert.equal(stack.canUndo(), false);
  assert.equal(stack.undo(state('x')), null);
});
