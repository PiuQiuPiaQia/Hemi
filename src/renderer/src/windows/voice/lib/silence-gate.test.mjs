import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { DoubaoAsrSession, createRecognitionPayload } from '../../../../../main/services/doubao-asr.mjs';
import { BargeInController } from './barge-in.ts';

import { DEFAULT_SILENCE_GATE_CONFIG, SilenceGate } from './silence-gate.ts';

/** 造一帧指定 RMS 的音频（恒定电平即可，门只看能量）。 */
function loudFrame(level = 0.2) {
  const floats = new Float32Array(1024).fill(level);
  return { buffer: floats.buffer, rms: level };
}

function quietFrame() {
  return loudFrame(0.0001);
}

/** 走完校准窗口（全安静），门进入正常工作态。 */
function calibratedGate() {
  const gate = new SilenceGate({ ...DEFAULT_SILENCE_GATE_CONFIG, calibrationMs: 50 });
  let now = 0;
  const feed = (frame) => {
    now += 40;
    return gate.process(frame.buffer, frame.rms, 40, now);
  };
  while (gate.calibrating) feed(quietFrame());
  return { gate, feed };
}

/** 使用接近实际采集的 85ms 帧，并保留 buffer 身份检查话头是否完整。 */
function dbHarness(config = {}) {
  const gate = new SilenceGate(config);
  let now = 0;
  const feed = (db, frameMs = 85) => {
    now += frameMs;
    const frame = loudFrame(10 ** (db / 20));
    return { input: frame.buffer, output: gate.process(frame.buffer, frame.rms, frameMs, now) };
  };
  const calibrate = (db) => {
    while (gate.calibrating) feed(db);
  };
  return { gate, feed, calibrate };
}

test('calibration finishes at the boundary and seeds its configured percentile', () => {
  const { gate, feed } = dbHarness({ calibrationMs: 160 });
  for (const db of [-60, -60, -45, -45, -80]) {
    const frame = feed(db, 40);
    assert.equal(frame.output.length, 1);
    assert.ok(frame.output[0] === frame.input, '校准窗口包含边界帧，全部送出');
  }
  assert.equal(gate.calibrating, false);
  assert.equal(gate.status.noiseFloorDb, -45);
  assert.equal(gate.status.thresholdDb, -39);
});

test('a 13-second quiet utterance stays open and delivers every speech frame once', () => {
  const { gate, feed, calibrate } = dbHarness();
  calibrate(-44);
  const speech = [], delivered = [];
  for (let index = 0; index < 153; index += 1) {
    const frame = feed(-22);
    speech.push(frame.input);
    delivered.push(...frame.output);
    if (index >= 1) assert.equal(gate.status.open, true, `语音第 ${index} 帧不应关门`);
  }
  const speechBuffers = new Set(speech);
  const deliveredSpeech = delivered.filter((frame) => speechBuffers.has(frame));
  assert.equal(deliveredSpeech.length, speech.length);
  assert.ok(deliveredSpeech.every((frame, index) => frame === speech[index]));
  assert.equal(gate.status.opens, 1);
  assert.ok(Math.abs(gate.status.smoothedDb - -22) < 0.1);
  assert.equal(gate.status.thresholdDb, -38);
});

test('speech only 1dB above threshold survives pauses and a later noise-floor drop', () => {
  const { gate, feed, calibrate } = dbHarness({ maxOpenThresholdDb: -18 });
  calibrate(-29); // 门限 -23，语音 -22 仅高 1dB。
  for (let index = 0; index < 30; index += 1) feed(-22);
  assert.equal(gate.status.open, true);
  for (let index = 0; index < 4; index += 1) feed(-44); // 340ms 句内停顿。
  assert.equal(gate.status.open, true);
  for (let index = 0; index < 30; index += 1) feed(-22);
  assert.equal(gate.status.opens, 1);
  assert.equal(gate.status.thresholdDb, -23);

  for (let index = 0; index < 25; index += 1) feed(-44);
  assert.equal(gate.status.open, false, '说完以后仍应正常关门');
  assert.equal(gate.status.thresholdDb, -38, '安静后仍能适应降低的底噪');
  feed(-22);
  const resumed = feed(-22);
  assert.equal(gate.status.open, true);
  assert.ok(resumed.output.length >= 2);
});

test('closed-gate levels near the threshold cannot ratchet the floor upward', () => {
  const { gate, feed, calibrate } = dbHarness();
  calibrate(-44);
  for (let index = 0; index < 300; index += 1) feed(-40); // 未过开门限，但不是可靠底噪。
  assert.equal(gate.status.open, false);
  assert.equal(gate.status.thresholdDb, -38);
  feed(-37);
  feed(-37);
  assert.equal(gate.status.open, true, '较轻的人声仍能正常触发');
});

test('candidate speech is judged before noise adaptation, even on a floor refresh', () => {
  const { gate, feed, calibrate } = dbHarness();
  calibrate(-44);
  // 无静音历史且距上次更新已过 250ms；第一帧人声不能先变成新底噪。
  feed(-22, 300);
  assert.equal(gate.status.pendingOpenFrames, 1);
  assert.equal(gate.status.thresholdDb, -38);
  feed(-22);
  assert.equal(gate.status.open, true);
});

test('isolated peaks stay gated while sustained background noise can still adapt', () => {
  const { gate, feed, calibrate } = dbHarness();
  calibrate(-44);
  for (let cycle = 0; cycle < 10; cycle += 1) {
    feed(-22);
    for (let index = 0; index < 12; index += 1) feed(-44);
  }
  assert.equal(gate.status.opens, 0);
  assert.equal(gate.status.thresholdDb, -38);
  for (let index = 0; index < 260; index += 1) feed(-42);
  assert.equal(gate.status.open, false);
  assert.equal(gate.status.thresholdDb, -36);
});

test('long silence sends zero-filled keepalives, and muting suppresses them', () => {
  const { gate, feed, calibrate } = dbHarness();
  calibrate(-44);
  // First drain the endpoint tail; it is separate from idle keepalives.
  for (let index = 0; index < 20; index += 1) feed(-44);
  let keepalives = 0;
  for (let index = 0; index < 110; index += 1) {
    for (const frame of feed(-44).output) {
      keepalives += 1;
      assert.ok(new Uint8Array(frame).every((byte) => byte === 0));
    }
  }
  assert.ok(keepalives >= 1 && keepalives <= 2);
  assert.equal(gate.status.open, false);
  gate.muted = true;
  for (let index = 0; index < 110; index += 1) assert.equal(feed(-44).output.length, 0);
});

test('muted mode drops closed-gate frames while keeping pre-roll alive', () => {
  const { gate, feed } = calibratedGate();
  gate.muted = true;

  // 闭门期间：零输出（压制），但预缓冲在累积、地板在观测。
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(feed(quietFrame()), []);
  }
  const status = gate.status;
  assert.equal(status.droppedFrames >= 5, true);
  assert.equal(gate.open, false);
});

test('muted mode waits for interruption confirmation before returning buffered speech', () => {
  const { gate, feed } = calibratedGate();
  gate.muted = true;

  for (let index = 0; index < 5; index += 1) feed(quietFrame());
  // 开门只是候选；必须等确认打断才能上送，不能把播报回声泄露给 ASR。
  const openFrames = feed(loudFrame());
  assert.deepEqual(openFrames, []);
  const flushed = feed(loudFrame());
  assert.deepEqual(flushed, []);
  assert.equal(gate.open, true);
  assert.ok(gate.releaseInterruption().length >= 2);
  assert.deepEqual(gate.releaseInterruption(), [], '已补发的音频不能重复发送');
});

test('talking immediately at connection time cannot calibrate away the first utterance', () => {
  const { gate, feed } = dbHarness();
  const input = [], output = [];
  for (let i = 0; i < 35; i += 1) {
    const frame = feed(i < 12 ? -21 : -32);
    input.push(frame.input);
    output.push(...frame.output);
  }
  assert.deepEqual(output, input, '校准前后与声音变轻时，整句仍须逐帧上送');
  assert.ok(gate.thresholdDb <= -36);
});

test('a closed gate supplies the ASR endpoint window through its real 200ms packet queue', () => {
  const gate = new SilenceGate();
  const wire = [];
  const asr = new DoubaoAsrSession({}, () => {}, { nonstream: false });
  asr.socket = { readyState: 1, send: (frame) => wire.push(gunzipSync(frame.subarray(12))) };
  let now = 0;
  const feed = (db) => {
    const pcm = new Int16Array(1360).fill(Math.round(32767 * 10 ** (db / 20)));
    now += 85;
    for (const frame of gate.process(pcm.buffer, 10 ** (db / 20), 85, now)) asr.sendAudio(Buffer.from(frame));
  };
  for (let i = 0; i < 30; i += 1) feed(-48);
  for (let i = 0; i < 30; i += 1) feed(-22);
  for (let i = 0; i < 30; i += 1) feed(-48);
  // Inspect the actual wire bytes (Buffer pools may have a nonzero offset).
  const pcm = Buffer.concat(wire);
  let trailingSamples = 0;
  for (let offset = pcm.length - 2; offset >= 0 && pcm.readInt16LE(offset) === 0; offset -= 2) trailingSamples++;
  assert.ok(trailingSamples / 16 >= createRecognitionPayload({ nonstream: false }).request.end_window_size,
    `实际发送的句末静音只有 ${trailingSamples / 16}ms，不能等结束通话才定稿`);
  assert.equal(gate.status.open, false);
  const packets = wire.length;
  for (let i = 0; i < 40; i += 1) feed(-48);
  assert.equal(wire.length, packets, '句末静音送够后仍应节省长期静音上传');
});

test('duck confirmation preserves every speech frame without first leaking echo', () => {
  const { gate, feed, calibrate } = dbHarness();
  const controller = new BargeInController();
  calibrate(-48);
  gate.muted = true;
  controller.feed({ ...gate.status, gateOpen: false, hasAudio: true, frameMs: 85 });
  const speech = [];
  let interrupted = false;
  for (let i = 0; i < 10; i += 1) {
    const frame = feed(-22);
    speech.push(frame.input);
    assert.deepEqual(frame.output, []);
    const decision = controller.feed({ ...gate.status, gateOpen: gate.status.open, hasAudio: true, frameMs: 85 });
    if (decision.action === 'interrupt') {
      assert.deepEqual(gate.releaseInterruption(), speech);
      interrupted = true;
      break;
    }
  }
  assert.equal(interrupted, true);
  assert.equal(feed(-22).output.length, 1, '确认后恢复连续上送');
});

test('unmuted gate behaves exactly as before', () => {
  const { gate, feed } = calibratedGate();
  assert.equal(gate.muted, false);

  const quiet = feed(quietFrame());
  // 未压制时闭门帧被预缓冲逻辑吞掉是既有行为（校准刚结束、门未开）。
  assert.ok(Array.isArray(quiet));
  feed(loudFrame());
  const flushed = feed(loudFrame());
  assert.ok(flushed.length >= 2);
  const duringOpen = feed(loudFrame());
  assert.equal(duringOpen.length, 1);
});
test('019: muted playback frames never move the noise floor', () => {
  const { gate, feed, calibrate } = dbHarness();
  calibrate(-60);
  const floorBefore = gate.status.noiseFloorDb;

  // 播报压制期间：门下回声低谷帧不进地板样本——地板保持不动。
  gate.muted = true;
  for (let index = 0; index < 12; index += 1) feed(-70);
  assert.equal(gate.status.noiseFloorDb, floorBefore);

  // 解除压制后同样电平参与估计：地板随之更新（回归确认守卫只在压制期生效）。
  gate.muted = false;
  for (let index = 0; index < 12; index += 1) feed(-70);
  assert.ok(gate.status.noiseFloorDb < floorBefore, '解除压制后地板应能下探');
});
