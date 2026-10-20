import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HEAL_RESTART_DELAYS_MS,
  nextHealRestartDelayMs,
} from './heal-backoff.mjs';

// 2026-09-30 晚间会话审计：自愈看门狗原为 10s 固定 interval 无限重建，
// 纯语音用户会永久空转。退避梯次是收敛的关键——这里锁住梯次形态与取值。

test('梯次形态：正数、非降、总时长有界', () => {
  assert.ok(HEAL_RESTART_DELAYS_MS.length >= 4, '梯次至少覆盖快慢两段');
  for (const delay of HEAL_RESTART_DELAYS_MS) {
    assert.ok(Number.isFinite(delay) && delay > 0, `间隔必须为正数：${delay}`);
  }
  for (let i = 1; i < HEAL_RESTART_DELAYS_MS.length; i += 1) {
    assert.ok(
      HEAL_RESTART_DELAYS_MS[i] >= HEAL_RESTART_DELAYS_MS[i - 1],
      `梯次必须非降：第 ${i} 档比前一档短`,
    );
  }
  const total = HEAL_RESTART_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
  // 封顶存在的意义：上限后必须停手（nextHealRestartDelayMs 返回 null），
  // 所以总时长本身就是重建行为的硬上界。
  assert.ok(total < 60 * 60 * 1000, '全部梯次总时长应在一小时内');
});

test('首次重建前等待 10s（保留原快档：授权迟到最常见于刚开启后）', () => {
  assert.equal(nextHealRestartDelayMs(1), 10_000);
});

test('越界 attempt 返回 null＝不再重建（封顶停手）', () => {
  const len = HEAL_RESTART_DELAYS_MS.length;
  assert.equal(nextHealRestartDelayMs(len + 1), null);
  assert.equal(nextHealRestartDelayMs(len + 100), null);
});

test('末档取值：超界前的最后一次仍返回有限间隔', () => {
  const len = HEAL_RESTART_DELAYS_MS.length;
  assert.equal(nextHealRestartDelayMs(len), HEAL_RESTART_DELAYS_MS[len - 1]);
});

test('非法 attempt 收敛：≤0 按第 1 次、小数截断', () => {
  assert.equal(nextHealRestartDelayMs(0), HEAL_RESTART_DELAYS_MS[0]);
  assert.equal(nextHealRestartDelayMs(-3), HEAL_RESTART_DELAYS_MS[0]);
  assert.equal(nextHealRestartDelayMs(2.7), HEAL_RESTART_DELAYS_MS[1]);
});
