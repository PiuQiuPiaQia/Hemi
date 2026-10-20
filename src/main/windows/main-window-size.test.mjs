import assert from 'node:assert/strict';
import test from 'node:test';

import { MAIN_WINDOW_MIN, mainWindowSizeFor } from './main-window-size.mjs';

// 024 主窗口初始尺寸：主屏工作区等比例，下限 980×680，小屏贴工作区。

test('常规笔记本工作区（约 1470×957）：88% 宽 / 94% 高，近全幅薄边', () => {
  const size = mainWindowSizeFor({ x: 0, y: 25, width: 1470, height: 957 });
  assert.equal(size.width, 1294); // round(1470 * 0.88)
  assert.equal(size.height, 900); // round(957 * 0.94)
  assert.ok(size.width > MAIN_WINDOW_MIN.width);
  assert.ok(size.height > MAIN_WINDOW_MIN.height);
});

test('大外接屏（2560×1417）：随屏放大，不封顶', () => {
  const size = mainWindowSizeFor({ x: 0, y: 0, width: 2560, height: 1417 });
  assert.equal(size.width, 2253); // round(2560 * 0.88)
  assert.equal(size.height, 1332); // round(1417 * 0.94)
});

test('小屏（1280×832）：88% 宽仍超下限，全按比例', () => {
  const size = mainWindowSizeFor({ x: 0, y: 25, width: 1280, height: 832 });
  assert.equal(size.width, 1126); // round(1280*0.88)=1126 > 980
  assert.equal(size.height, 782); // round(832*0.94)=782
});

test('迷你屏（工作区比下限还小）：贴工作区不越界', () => {
  const size = mainWindowSizeFor({ x: 0, y: 0, width: 800, height: 600 });
  assert.equal(size.width, 800);
  assert.equal(size.height, 600);
});
