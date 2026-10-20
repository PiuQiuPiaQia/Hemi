import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOptionHoldDetector,
  isOptionKeycode,
} from './option-hold-detector.mjs';

const OPTION = 56;
const OPTION_RIGHT = 3640;
const TAB = 15;
const SPACE = 44;

/** 按顺序喂 keydown/keyup，收集 start/end/cancel 决策序列。 */
function feed(decisions, steps) {
  const detector = steps.detector ?? makeDetector(decisions);
  for (const [type, keycode] of steps.events) detector[type](keycode);
  return detector;
}

function makeDetector(decisions, nowImpl) {
  let clock = 1_000_000;
  return createOptionHoldDetector({
    start: () => decisions.push('start'),
    end: () => decisions.push('end'),
    cancel: () => decisions.push('cancel'),
    now: nowImpl ?? (() => clock),
  });
}

test('键码识别：56 与 3640 都是 Option', () => {
  assert.equal(isOptionKeycode(OPTION), true);
  assert.equal(isOptionKeycode(OPTION_RIGHT), true);
  assert.equal(isOptionKeycode(TAB), false);
});

test('AC-01 主路径：干净按下触发 start，松开触发 end', () => {
  const decisions = [];
  feed(decisions, {
    events: [
      ['keydown', SPACE],
      ['keyup', SPACE],
      ['keydown', OPTION],
      ['keyup', OPTION],
      ['keydown', OPTION],
      ['keyup', OPTION],
    ],
  });
  assert.deepEqual(decisions, ['start', 'end', 'start', 'end']);
});

test('AC-02 组合键：按住中出现其他键＝作废，Option 松开不再 end', () => {
  const decisions = [];
  feed(decisions, {
    events: [
      ['keydown', OPTION],
      ['keydown', TAB],
      ['keyup', TAB],
      ['keyup', OPTION],
    ],
  });
  assert.deepEqual(decisions, ['start', 'cancel']);
});

test('AC-02 组合键收尾：先按其他键再按 Option 不触发', () => {
  const decisions = [];
  feed(decisions, {
    events: [
      ['keydown', SPACE],
      ['keydown', OPTION],
      ['keyup', OPTION],
      ['keyup', SPACE],
    ],
  });
  assert.deepEqual(decisions, []);
});

test('双 Option：一起按住时先松一个不结束，全松才结束', () => {
  const decisions = [];
  feed(decisions, {
    events: [
      ['keydown', OPTION],
      ['keydown', OPTION_RIGHT],
      ['keyup', OPTION],
      ['keyup', OPTION_RIGHT],
    ],
  });
  assert.deepEqual(decisions, ['start', 'end']);
});

test('重复 keydown（自动重复）不重复触发', () => {
  const decisions = [];
  feed(decisions, {
    events: [
      ['keydown', OPTION],
      ['keydown', OPTION],
      ['keyup', OPTION],
    ],
  });
  assert.deepEqual(decisions, ['start', 'end']);
});

test('漏 keyup 后重按：60 秒内的旧条目合并进新按住，松开仍正常 end', () => {
  const decisions = [];
  let clock = 1_000_000;
  const detector = makeDetector(decisions, () => clock);
  detector.keydown(OPTION);
  // keyup 丢了。用户稍后重新按下并松开。
  clock += 3_000;
  detector.keydown(OPTION);
  clock += 1_000;
  detector.keyup(OPTION);
  assert.deepEqual(decisions, ['start', 'end']);
  assert.equal(detector.isHolding(), false);
});

test('漏 keyup 超过单次按住上限：下一次按键兜底作废，之后可正常触发', () => {
  const decisions = [];
  let clock = 1_000_000;
  const detector = makeDetector(decisions, () => clock);
  detector.keydown(OPTION);
  clock += 121_000;
  detector.keydown(TAB); // 任意后续按键触发兜底检查
  assert.deepEqual(decisions, ['start', 'cancel']);
  clock += 100;
  detector.keyup(TAB);
  detector.keydown(OPTION);
  detector.keyup(OPTION);
  assert.deepEqual(decisions, ['start', 'cancel', 'start', 'end']);
});

test('按键泄漏条目超过 TTL 后不再阻塞触发', () => {
  const decisions = [];
  let clock = 1_000_000;
  const detector = makeDetector(decisions, () => clock);
  detector.keydown(SPACE);
  detector.keyup(SPACE); // 正常路径，SPACE 不留残余
  // 模拟一个漏了 keyup 的键把 Option 卡住的场景。
  detector.keydown(SPACE);
  clock += 61_000;
  detector.keydown(OPTION);
  detector.keyup(OPTION);
  assert.deepEqual(decisions, ['start', 'end']);
});

test('通话免打扰由上层保证：状态机只对按键流负责', () => {
  // R-05（通话中不触发）由主进程在 hook 运行/开关层面与渲染层
  // handleHoldStart 的通话守卫共同保证；此处锁定状态机本身不吞 start。
  const decisions = [];
  feed(decisions, { events: [['keydown', OPTION]] });
  assert.deepEqual(decisions, ['start']);
});
