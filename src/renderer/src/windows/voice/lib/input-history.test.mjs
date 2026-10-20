import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browseNewer,
  browseOlder,
  browseText,
  buildInputHistory,
  HISTORY_BROWSE_IDLE,
  shouldTakeOverArrow,
} from './input-history.ts';

const turn = (text, author = 'user') => ({ id: text, text, author, createdAt: 0 });

test('buildInputHistory：只收用户消息、最新在前、相邻去重', () => {
  const history = buildInputHistory([
    turn('第一条', 'user'),
    turn('好的收到', 'hemi'),
    { ...turn('任务卡', 'user'), kind: 'task' },
    turn('第二条', 'user'),
    turn('第二条', 'user'), // 相邻重复
    turn('回复', 'hemi'),
    turn('  第三条  ', 'user'),
  ]);
  assert.deepEqual(history, ['第三条', '第二条', '第一条']);
});

test('浏览状态机：↑ 进缓存原稿、到底不动；↓ 回新、越过最新恢复原稿', () => {
  const history = ['甲', '乙', '丙'];
  let state = browseOlder(HISTORY_BROWSE_IDLE, history, '正在写的');
  assert.deepEqual(state, { index: 0, cachedDraft: '正在写的' });
  assert.equal(browseText(state, history), '甲');

  state = browseOlder(state, history, '甲');
  assert.equal(state.index, 1);
  state = browseOlder(state, history, '乙');
  state = browseOlder(state, history, '丙');
  assert.equal(state.index, 2, '最旧不再前进');

  const back = browseNewer(state, history);
  assert.equal(back.text, '乙');
  const exit = browseNewer({ index: 0, cachedDraft: '正在写的' }, history);
  assert.equal(exit.text, '正在写的', '越过最新恢复缓存原稿');
  assert.equal(exit.index, null);
});

test('shouldTakeOverArrow：IME 不接管；多行只认首行/末行光标', () => {
  assert.equal(shouldTakeOverArrow('ArrowUp', '', 0, false), true);
  assert.equal(shouldTakeOverArrow('ArrowUp', 'abc', 1, true), false, 'IME 合成中');
  // 多行：↑ 只在首行接管；↓ 只在末行接管。
  const multi = '第一行\n第二行\n第三行';
  assert.equal(shouldTakeOverArrow('ArrowUp', multi, 2, false), true, '首行内');
  assert.equal(shouldTakeOverArrow('ArrowUp', multi, 5, false), false, '第二行（跨过换行）');
  assert.equal(shouldTakeOverArrow('ArrowDown', multi, multi.length - 1, false), true, '末行内');
  assert.equal(shouldTakeOverArrow('ArrowDown', multi, 3, false), false, '第二行');
  // 单行文本：↑/↓ 都接管。
  assert.equal(shouldTakeOverArrow('ArrowDown', '单行', 1, false), true);
});
