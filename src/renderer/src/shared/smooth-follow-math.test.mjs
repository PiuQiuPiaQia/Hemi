import assert from 'node:assert/strict';
import test from 'node:test';
import { followAfterScroll, followStep } from './smooth-follow-math.ts';

test('逼近必然收敛：剩 1px 时直接落到目标结束，不再每帧写 +0.22（真机死循环实录）', () => {
  assert.deepEqual(followStep(3633, 3634, 0.22), { next: 3634, done: true });
  assert.deepEqual(followStep(3633.5, 3634, 0.22), { next: 3634, done: true });
  // 距离 3px：22% 不足 1px，按 1px 走。
  assert.deepEqual(followStep(100, 103, 0.22), { next: 101, done: false });
  // 远距离照常按比例走。
  assert.deepEqual(followStep(0, 1000, 0.22), { next: 220, done: false });
  // 模拟浏览器取整（DPR 2 只能落半像素）：任意起点都在有限帧内结束。
  let top = 3000;
  let frames = 0;
  for (;;) {
    const { next, done } = followStep(top, 3634, 0.22);
    top = Math.round(next * 2) / 2;
    frames += 1;
    if (done) break;
    assert.ok(frames < 200, '逼近没有收敛');
  }
  assert.equal(top, 3634);
});

test('轻轻上滑停在阈值内不恢复跟随；往下靠近或贴底才恢复', () => {
  assert.equal(followAfterScroll(20, -16, 36), 'unpin');
  assert.equal(followAfterScroll(20, 12, 36), 'pin');
  assert.equal(followAfterScroll(0, -3, 36), 'pin'); // 内容收起被夹到底：仍算贴底
  assert.equal(followAfterScroll(300, -40, 36), 'unpin'); // 拖滚动条往上
  assert.equal(followAfterScroll(300, 40, 36), 'keep'); // 往下但离底还远：保持
  assert.equal(followAfterScroll(300, 0, 36), 'keep');
});
