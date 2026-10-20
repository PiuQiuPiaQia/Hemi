// 对话历史窗口：起点按步长整块前移，窗口内前缀跨回合稳定（提示词缓存）。
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTEXT_TURNS, CONTEXT_WINDOW_STEP, contextWindow, contextWindowStart } from './context-window.ts';

test('不足下限时整段送出', () => {
  assert.equal(contextWindowStart(0), 0);
  assert.equal(contextWindowStart(CONTEXT_TURNS), 0);
  const entries = Array.from({ length: 10 }, (_, index) => index);
  assert.deepEqual(contextWindow(entries), entries);
});

test('窗口条数恒在 [下限, 下限+步长-1] 之间，最新一条始终在内', () => {
  for (let length = CONTEXT_TURNS + 1; length < CONTEXT_TURNS + CONTEXT_WINDOW_STEP * 5; length += 1) {
    const entries = Array.from({ length }, (_, index) => index);
    const window = contextWindow(entries);
    assert.ok(window.length >= CONTEXT_TURNS, `length=${length} 窗口 ${window.length} 低于下限`);
    assert.ok(window.length <= CONTEXT_TURNS + CONTEXT_WINDOW_STEP - 1, `length=${length} 窗口 ${window.length} 超出上限`);
    assert.equal(window.at(-1), length - 1);
  }
});

test('起点在连续一个步长的新消息内不动（历史前缀可命中缓存），之后整块前移', () => {
  const first = CONTEXT_TURNS + CONTEXT_WINDOW_STEP; // 恰好前移一步的长度
  const starts = new Set();
  for (let length = first; length < first + CONTEXT_WINDOW_STEP; length += 1) {
    starts.add(contextWindowStart(length));
  }
  assert.deepEqual([...starts], [CONTEXT_WINDOW_STEP]);
  assert.equal(contextWindowStart(first + CONTEXT_WINDOW_STEP), CONTEXT_WINDOW_STEP * 2);
});
