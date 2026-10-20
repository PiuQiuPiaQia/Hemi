import assert from 'node:assert/strict';
import test from 'node:test';

import { BargeInController, DEFAULT_BARGE_IN_CONFIG } from './barge-in.ts';

/** 造一帧输入；电平默认远低于判定门限（-60 < -40+6）。 */
function frame(over = {}) {
  return { gateOpen: false, levelDb: -60, thresholdDb: -40, hasAudio: true, frameMs: 85, ...over };
}

const loud = (over = {}) => frame({ levelDb: -30, ...over });

test('speech beginning during a quiet handshake can interrupt once audio arrives', () => {
  const bargeIn = new BargeInController();
  bargeIn.feed(frame({ hasAudio: false }));
  bargeIn.feed(loud({ hasAudio: false, gateOpen: true }));
  const actions = Array.from({ length: 5 }, () => bargeIn.feed(loud({ gateOpen: true })).action);
  assert.equal(actions.at(-1), 'interrupt');
});

test('audio not yet playing: never interrupts, even with the gate wide open', () => {
  const bargeIn = new BargeInController();
  bargeIn.reset();

  // 回应刚落、合成握手中：门开着且电平过阈也不能打断（turn 4 的实测故障）。
  for (let index = 0; index < 10; index += 1) {
    const decision = bargeIn.feed(loud({ hasAudio: false, gateOpen: true }));
    assert.equal(decision.action, 'none');
  }
});

test('gate left open from the previous utterance: no interrupt until it closes once', () => {
  const bargeIn = new BargeInController();
  bargeIn.reset();

  // 播报开始时门还开着（hangover）：见过关门之前全是 none。
  for (let index = 0; index < 8; index += 1) {
    assert.equal(bargeIn.feed(loud({ gateOpen: true })).action, 'none');
  }
  // 门关过一次 → 再开：第一帧过阈压低，压低态攒满 340ms → 打断。
  assert.equal(bargeIn.feed(frame()).action, 'none');
  let actions = [];
  for (let index = 0; index < 5; index += 1) {
    actions.push(bargeIn.feed(loud({ gateOpen: true })).action);
  }
  assert.deepEqual(actions, ['duck', 'none', 'none', 'none', 'interrupt']);
});

test('short burst (knock, cough, one grunt): duck fires but no interrupt', () => {
  const bargeIn = new BargeInController();
  bargeIn.reset();
  for (let index = 0; index < 3; index += 1) bargeIn.feed(frame());

  assert.equal(bargeIn.feed(loud({ gateOpen: true })).action, 'duck');
  assert.equal(bargeIn.feed(loud({ gateOpen: true })).action, 'none');
  // 340ms 没攒满就安静了：确认清零，不打断。
  assert.equal(bargeIn.feed(frame()).action, 'none');
  assert.equal(bargeIn.feed(frame({ gateOpen: true })).action, 'none');
});

test('sustained speech above threshold: interrupt exactly when 340ms accumulates under duck', () => {
  const bargeIn = new BargeInController();
  bargeIn.reset();
  assert.equal(bargeIn.feed(frame()).action, 'none'); // 先见关门

  const actions = [];
  for (let index = 0; index < 5; index += 1) {
    actions.push(bargeIn.feed(loud({ gateOpen: true })).action);
  }
  // 85ms/帧：duck + 4 帧压低态过阈（4×85=340ms）= 与旧版满 5 帧同延迟。
  assert.deepEqual(actions, ['duck', 'none', 'none', 'none', 'interrupt']);
});

test('confirmation is duration based: a shorter confirm window confirms proportionally earlier', () => {
  // 200ms 窗口、93ms 帧（44.1kHz 一档）：3 帧压低态过阈（279ms）即确认——
  // 若按帧数计（固定 5 帧）要等到第 5 帧。
  const bargeIn = new BargeInController({ confirmMs: 200 });
  bargeIn.reset();
  bargeIn.feed(frame({ frameMs: 93 })); // 见关门

  const actions = [];
  for (let index = 0; index < 4; index += 1) {
    actions.push(bargeIn.feed(loud({ gateOpen: true, frameMs: 93 })).action);
  }
  assert.deepEqual(actions, ['duck', 'none', 'none', 'interrupt']);
});

test('a below-threshold gap resets confirmation; resumed voice confirms on its own merit', () => {
  const bargeIn = new BargeInController();
  bargeIn.reset();
  bargeIn.feed(frame());

  // 2 帧 + 空 + 2 帧：每段都不足 340ms，永不打断。
  for (let index = 0; index < 2; index += 1) bargeIn.feed(loud({ gateOpen: true }));
  bargeIn.feed(frame({ gateOpen: true })); // 中断一帧
  for (let index = 0; index < 2; index += 1) bargeIn.feed(loud({ gateOpen: true }));
  assert.equal(bargeIn.isDucked, true);

  // 断掉之后重新连续攒满 340ms（4 帧）→ 打断。
  let interrupted = false;
  for (let index = 0; index < 4; index += 1) {
    if (bargeIn.feed(loud({ gateOpen: true })).action === 'interrupt') interrupted = true;
  }
  assert.equal(interrupted, true);
});

test('019 echo accident: full-volume echo ducks, releases, re-ducks — never interrupts', () => {
  const bargeIn = new BargeInController();
  bargeIn.reset();
  bargeIn.feed(frame()); // 见关门（安静房间，门限被钳在低位）

  // 2026-09-20 事故签名：句首回声满音量过阈 → 压低；压低后回声落回阈下 →
  // 页面滞回复原；下一句回声再过阈 → 再压低……整个播报期间循环。
  for (let cycle = 0; cycle < 10; cycle += 1) {
    assert.equal(bargeIn.feed(loud({ gateOpen: true })).action, 'duck');
    // 压低态下回声低于判定门限（0.25 倍音量 −12dB）：确认时长始终是 0。
    for (let index = 0; index < 4; index += 1) {
      const decision = bargeIn.feed(frame({ gateOpen: true }));
      assert.equal(decision.action, 'none');
      assert.equal(decision.quiet, true);
    }
    assert.equal(bargeIn.releaseDuck(), 'duck-release');
  }
});

test('019 playback margin: level above the gate threshold but under the raised judge floor never ducks', () => {
  const bargeIn = new BargeInController();
  bargeIn.reset();
  bargeIn.feed(frame()); // 见关门

  // 门限 -40，播报余量 +6 → 判定线 -34：回声残余 -36 开门但不算打断候选。
  const decision = bargeIn.feed(frame({ levelDb: -36, gateOpen: true }));
  assert.equal(decision.action, 'none');
  assert.equal(decision.quiet, true);
  assert.equal(bargeIn.isDucked, false);
});

test('releaseDuck restores only after a duck, wipes confirmation, and is idempotent', () => {
  const bargeIn = new BargeInController();
  bargeIn.reset();
  bargeIn.feed(frame());
  bargeIn.feed(loud({ gateOpen: true }));
  assert.equal(bargeIn.isDucked, true);

  assert.equal(bargeIn.releaseDuck(), 'duck-release');
  assert.equal(bargeIn.isDucked, false);
  assert.equal(bargeIn.releaseDuck(), 'none');

  // 恢复后再次过阈会重新压低。
  assert.equal(bargeIn.feed(loud({ gateOpen: true })).action, 'duck');
});

test('release/re-duck churn cannot carry partial confirmation across cycles', () => {
  const bargeIn = new BargeInController();
  bargeIn.reset();
  bargeIn.feed(frame()); // 见关门

  // 每轮压低态只攒 3 帧（255ms < 340ms）就安静、解除；下一轮必须重新攒。
  for (let cycle = 0; cycle < 6; cycle += 1) {
    bargeIn.feed(loud({ gateOpen: true })); // duck（确认清零）
    for (let index = 0; index < 3; index += 1) {
      assert.equal(bargeIn.feed(loud({ gateOpen: true })).action, 'none');
    }
    bargeIn.feed(frame({ gateOpen: true })); // 安静帧
    assert.equal(bargeIn.releaseDuck(), 'duck-release');
  }
});

test('config overrides: a larger margin and confirm window both take effect', () => {
  const bargeIn = new BargeInController({ confirmMs: 400, playbackMarginDb: 12 });
  bargeIn.reset();
  bargeIn.feed(frame({ thresholdDb: -52 })); // 见关门

  // 余量 12 → 判定线 -40：-42 过门限但不过判定线，不压低。
  assert.equal(bargeIn.feed(frame({ levelDb: -42, thresholdDb: -52, gateOpen: true })).quiet, true);
  // 85ms 帧：400ms 需要 5 帧压低态过阈。
  assert.equal(bargeIn.feed(loud({ thresholdDb: -52, gateOpen: true })).action, 'duck');
  const actions = Array.from({ length: 5 }, () => bargeIn.feed(loud({ thresholdDb: -52, gateOpen: true })).action);
  assert.deepEqual(actions, ['none', 'none', 'none', 'none', 'interrupt']);
});

test('reset clears everything for the next playback', () => {
  const bargeIn = new BargeInController();
  bargeIn.reset();
  bargeIn.feed(frame());
  for (let index = 0; index < 4; index += 1) bargeIn.feed(loud({ gateOpen: true }));
  bargeIn.reset();

  // 复位后又是「没见过关门」的状态：开门不算打断。
  assert.equal(bargeIn.feed(loud({ gateOpen: true })).action, 'none');
  assert.equal(bargeIn.isDucked, false);
});

test('defaults keep the documented duck volume and release hysteresis', () => {
  const bargeIn = new BargeInController();
  assert.equal(bargeIn.duckVolume, 0.25);
  assert.equal(bargeIn.duckReleaseMs, 500);
  assert.equal(DEFAULT_BARGE_IN_CONFIG.confirmMs, 340);
  assert.equal(DEFAULT_BARGE_IN_CONFIG.playbackMarginDb, 6);
});
