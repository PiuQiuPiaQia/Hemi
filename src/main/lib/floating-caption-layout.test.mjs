import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FLOATING_CAPTION_MAX_WIDTH,
  FLOATING_CAPTION_MIN_WIDTH,
  FLOATING_CAPTION_PADDING,
  FLOATING_CAPTION_SIZE,
  computeFloatingCaptionLayout,
} from './floating-caption-layout.mjs';

const ORB_SIZE = 92;
/** 主屏工作区（顶部留出菜单栏）。 */
const WORK_AREA = { x: 0, y: 25, width: 1512, height: 895 };
/**
 * 悬浮球的默认落点：右下角。横向边距 120 = main.mjs 的
 * FLOATING_ORB_RIGHT_MARGIN（字幕卡在这个位置才能正中球心）；
 * 纵向仍是 24（与居中没有关系）。这里的数值必须与 main.mjs 同步。
 */
const DEFAULT_ORB = {
  x: WORK_AREA.x + WORK_AREA.width - ORB_SIZE - 120,
  y: WORK_AREA.y + WORK_AREA.height - ORB_SIZE - 24,
};
/** 球被拖到屏幕右缘附近（FLOATING_ORB_EDGE_MARGIN = 76）：接受最小让位。 */
const EDGE_ORB = {
  x: WORK_AREA.x + WORK_AREA.width - ORB_SIZE - 76,
  y: DEFAULT_ORB.y,
};

function layoutFor(orbX, orbY, workArea = WORK_AREA) {
  return computeFloatingCaptionLayout({
    orbX,
    orbY,
    orbSize: ORB_SIZE,
    workArea,
  });
}

function copyBounds(result) {
  return {
    left: result.anchorX - result.maxWidth / 2,
    right: result.anchorX + result.maxWidth / 2,
  };
}

/** 窗口与文字都必须留在工作区/窗口内，否则会被裁切。 */
function assertNothingClipped(result, workArea = WORK_AREA) {
  const context = JSON.stringify(result);
  assert.ok(result.x >= workArea.x, `字幕窗口越出工作区左侧: ${context}`);
  assert.ok(
    result.x + FLOATING_CAPTION_SIZE.width <= workArea.x + workArea.width,
    `字幕窗口越出工作区右侧: ${context}`,
  );
  assert.ok(result.y >= workArea.y, `字幕窗口越出工作区顶部: ${context}`);
  assert.ok(
    result.y + FLOATING_CAPTION_SIZE.height <=
      workArea.y + workArea.height,
    `字幕窗口越出工作区底部: ${context}`,
  );

  const bounds = copyBounds(result);
  assert.ok(
    bounds.left >= FLOATING_CAPTION_PADDING - 1,
    `文字越出窗口左侧内边距: ${context}`,
  );
  assert.ok(
    bounds.right <= FLOATING_CAPTION_SIZE.width - FLOATING_CAPTION_PADDING + 1,
    `文字越出窗口右侧内边距: ${context}`,
  );
}

test('球在工作区中间：字幕用最大宽度并正对球心', () => {
  const orbX = 700;
  const result = layoutFor(orbX, DEFAULT_ORB.y);

  assert.equal(result.maxWidth, FLOATING_CAPTION_MAX_WIDTH);
  assert.equal(result.anchorX, FLOATING_CAPTION_SIZE.width / 2);
  assert.equal(result.placement, 'above');
  assert.equal(result.x + result.anchorX, orbX + ORB_SIZE / 2);
  assert.ok(
    result.y + FLOATING_CAPTION_SIZE.height <= DEFAULT_ORB.y,
    '字幕应完全在球上方',
  );
  assertNothingClipped(result);
});

test('球停在默认落点：卡片正中球心（用户要求，2026-09-19）', () => {
  const result = layoutFor(DEFAULT_ORB.x, DEFAULT_ORB.y);

  assert.equal(result.maxWidth, FLOATING_CAPTION_MAX_WIDTH);
  assert.equal(result.placement, 'above');
  assertNothingClipped(result);
  assert.equal(
    result.x + result.anchorX,
    DEFAULT_ORB.x + ORB_SIZE / 2,
    '默认落点下卡片中心必须与球心重合',
  );
});

test('球被拖到屏幕右缘附近：卡片保持最大宽度，最小让位不越界', () => {
  const result = layoutFor(EDGE_ORB.x, EDGE_ORB.y);

  assert.equal(result.maxWidth, FLOATING_CAPTION_MAX_WIDTH);
  assertNothingClipped(result);

  const bounds = copyBounds(result);
  const orbCenterInWindowX = EDGE_ORB.x + ORB_SIZE / 2 - result.x;
  assert.ok(
    orbCenterInWindowX >= bounds.left && orbCenterInWindowX <= bounds.right,
    '球心仍应落在卡片横向范围内',
  );
  // 让位量受「物理边界」约束：卡片完整可见的前提下不可能更居中。
  const shift = Math.abs(EDGE_ORB.x + ORB_SIZE / 2 - (result.x + result.anchorX));
  assert.ok(shift <= 60, `贴边让位应保持克制，实际 ${shift}px`);
});

test('球贴左边界：同样保持宽度并留在工作区内', () => {
  const orbX = WORK_AREA.x + 76;
  const result = layoutFor(orbX, DEFAULT_ORB.y);

  assert.equal(result.x, WORK_AREA.x);
  assert.equal(result.maxWidth, FLOATING_CAPTION_MAX_WIDTH);
  assertNothingClipped(result);

  const bounds = copyBounds(result);
  const orbCenterInWindowX = orbX + ORB_SIZE / 2 - result.x;
  assert.ok(
    orbCenterInWindowX >= bounds.left && orbCenterInWindowX <= bounds.right,
    '球心应落在卡片横向范围内',
  );
});

test('球贴工作区顶部：字幕改放到球下方', () => {
  const orbY = WORK_AREA.y;
  const result = layoutFor(700, orbY);

  assert.equal(result.placement, 'below');
  assert.equal(result.y, orbY + ORB_SIZE + 6);
  assert.ok(result.y >= orbY + ORB_SIZE, '字幕应在球下方');
  assertNothingClipped(result);
});

test('副屏（workArea 带偏移）同样居中且不越界', () => {
  const workArea = { x: 1512, y: 0, width: 1920, height: 1080 };
  const orbX = workArea.x + workArea.width / 2;
  const result = layoutFor(orbX, workArea.y + workArea.height - ORB_SIZE - 24, workArea);

  assert.equal(result.anchorX, FLOATING_CAPTION_SIZE.width / 2);
  assert.equal(result.x + result.anchorX, orbX + ORB_SIZE / 2);
  assert.equal(result.maxWidth, FLOATING_CAPTION_MAX_WIDTH);
  assertNothingClipped(result, workArea);
});

test('工作区比字幕窗口还窄时也返回可用布局', () => {
  const workArea = { x: 0, y: 0, width: 300, height: 600 };
  const result = layoutFor(120, 400, workArea);

  for (const value of [result.x, result.y, result.anchorX, result.maxWidth]) {
    assert.ok(Number.isFinite(value), `布局结果必须是有限数: ${JSON.stringify(result)}`);
  }
  assert.ok(result.maxWidth >= FLOATING_CAPTION_MIN_WIDTH);

  const bounds = copyBounds(result);
  assert.ok(bounds.left >= FLOATING_CAPTION_PADDING - 1);
  assert.ok(
    bounds.right <= FLOATING_CAPTION_SIZE.width - FLOATING_CAPTION_PADDING + 1,
  );
});
