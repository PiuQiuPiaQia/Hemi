import assert from 'node:assert/strict';
import test from 'node:test';

import { TtsPlayer } from './tts-player.ts';

const SAMPLE_RATE = 24000;

/**
 * 假 AudioContext：记录排程顺序与时间，onended 由测试手动触发。
 * 结构与 tts-player.ts 注入的 TtsPlayerContext 对齐。
 */
function createFakeContext() {
  const sources = [];
  const buffers = [];
  let now = 0;
  const gainNode = {
    gain: {
      value: 1,
      events: [],
      cancelAndHoldAtTime(time) { this.events.push(['hold', time]); },
      setValueAtTime(value, time) { this.events.push(['anchor', value, time]); },
      linearRampToValueAtTime(value, time) { this.events.push(['ramp', value, time]); },
    },
    connect() {},
  };

  const context = {
    get currentTime() {
      return now;
    },
    destination: { kind: 'destination' },
    createGain() {
      return gainNode;
    },
    createBuffer(_channels, length, rate) {
      const data = new Float32Array(length);
      const buffer = {
        length,
        rate,
        getChannelData() {
          return data;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createBufferSource() {
      const source = {
        buffer: null,
        startAt: null,
        started: false,
        stopped: false,
        onended: null,
        connect() {},
        start(when) {
          this.started = true;
          this.startAt = when;
        },
        stop() {
          this.stopped = true;
        },
      };
      sources.push(source);
      return source;
    },
  };
  return {
    context,
    sources,
    buffers,
    gain: gainNode.gain,
    advance(seconds) {
      now += seconds;
    },
    finishLast() {
      const source = sources.at(-1);
      now = source.startAt + 0.001;
      source.onended?.();
    },
  };
}

function pcmSamples(values) {
  const buffer = new ArrayBuffer(values.length * 2);
  const view = new DataView(buffer);
  values.forEach((value, index) => view.setInt16(index * 2, value, true));
  return buffer;
}

test('schedules chunks back to back on the audio timeline', () => {
  const fake = createFakeContext();
  const player = new TtsPlayer(fake.context, { sampleRate: SAMPLE_RATE });

  player.enqueue(pcmSamples([0, 0])); // 2 samples ≈ 0.083 ms
  player.enqueue(pcmSamples([0, 0, 0, 0]));

  assert.equal(fake.sources.length, 2);
  const [first, second] = fake.sources;
  assert.ok(first.started);
  assert.ok(second.started);
  assert.ok(second.startAt >= first.startAt);
  const firstDuration = 2 / SAMPLE_RATE;
  assert.ok(
    Math.abs(second.startAt - (first.startAt + firstDuration)) < 1e-9,
    `第二片应首尾相接：${second.startAt} vs ${first.startAt + firstDuration}`,
  );
});

test('converts 16-bit pcm to normalized float samples', () => {
  const fake = createFakeContext();
  const player = new TtsPlayer(fake.context, { sampleRate: SAMPLE_RATE });
  player.enqueue(pcmSamples([0, 16384, -16384, 32767, -32768]));

  const channel = fake.buffers[0].getChannelData(0);
  assert.equal(channel.length, 5);
  assert.equal(channel[0], 0);
  assert.ok(Math.abs(channel[1] - 0.5) < 1e-4);
  assert.ok(Math.abs(channel[2] + 0.5) < 1e-4);
  assert.ok(Math.abs(channel[3] - 1) < 1e-4);
  assert.equal(channel[4], -1);
});

test('fires onDrained once when the last chunk finishes playing', () => {
  const fake = createFakeContext();
  let drained = 0;
  const player = new TtsPlayer(fake.context, {
    sampleRate: SAMPLE_RATE,
    onDrained: () => {
      drained += 1;
    },
  });

  player.enqueue(pcmSamples([0, 0]));
  player.enqueue(pcmSamples([0, 0]));
  assert.equal(drained, 0);
  assert.equal(player.isEmpty, false);

  // 中间那片播完不算排空。
  fake.sources[0].startAt = fake.context.currentTime;
  fake.advance(1);
  fake.sources[0].onended();
  assert.equal(drained, 0);

  fake.finishLast();
  assert.equal(drained, 1);
  assert.equal(player.isEmpty, true);

  // 再排空一次的episode：enqueue → 播完 → 再回调一次（每次播放周期一次）。
  player.enqueue(pcmSamples([0, 0]));
  fake.finishLast();
  assert.equal(drained, 2);
});

test('stopAll silences every source and skips the drained callback', () => {
  const fake = createFakeContext();
  let drained = 0;
  const player = new TtsPlayer(fake.context, {
    sampleRate: SAMPLE_RATE,
    onDrained: () => {
      drained += 1;
    },
  });

  player.enqueue(pcmSamples([0, 0]));
  player.enqueue(pcmSamples([0, 0]));
  player.stopAll();

  assert.equal(player.isEmpty, true);
  assert.ok(fake.sources.every((source) => source.stopped));
  fake.finishLast();
  assert.equal(drained, 0);
});

test('setVolume clamps into 0..1 for the duck path', () => {
  const fake = createFakeContext();
  const player = new TtsPlayer(fake.context, { sampleRate: SAMPLE_RATE });

  player.setVolume(0.25);
  player.setVolume(5);
  player.setVolume(-1);
  assert.deepEqual(fake.gain.events, [
    ['hold', 0], ['anchor', 1, 0], ['ramp', 0.25, 0.015],
    ['hold', 0], ['anchor', 1, 0], ['ramp', 1, 0.015],
    ['hold', 0], ['anchor', 1, 0], ['ramp', 0, 0.015],
  ]);
  assert.equal(fake.gain.value, 1, '音量不能直接跳变，否则会产生爆音');
});

test('short delivery jitter does not introduce gaps between PCM chunks', () => {
  const fake = createFakeContext();
  const gaps = [];
  const player = new TtsPlayer(fake.context, { onUnderrun: (gap) => gaps.push(gap) });
  const chunk = pcmSamples(new Array(960).fill(123)); // 40ms
  player.enqueue(chunk);
  fake.advance(0.1); // 100ms 网络/渲染调度延迟仍在起播缓冲内
  player.enqueue(chunk);
  assert.ok(Math.abs(fake.sources[1].startAt - fake.sources[0].startAt - 0.04) < 1e-9);
  assert.deepEqual(gaps, []);
  fake.advance(0.5);
  player.enqueue(chunk);
  assert.equal(gaps.length, 1, '更长的断流须有诊断记录');
});

test('arbitrary byte boundaries preserve the PCM and cancellation clears a partial sample', () => {
  const fake = createFakeContext();
  const player = new TtsPlayer(fake.context);
  const input = pcmSamples([1000, -2000, 3000]);
  player.enqueue(input.slice(0, 1));
  player.enqueue(input.slice(1, 5));
  player.enqueue(input.slice(5));
  const actual = fake.buffers.flatMap((buffer) => [...buffer.getChannelData(0)]);
  assert.equal(actual.length, 3);
  assert.ok(Math.abs(actual[0] - 1000 / 32767) < 1e-6);
  assert.ok(Math.abs(actual[1] + 2000 / 32768) < 1e-6);
  assert.ok(Math.abs(actual[2] - 3000 / 32767) < 1e-6);
  player.enqueue(input.slice(0, 1));
  player.stopAll();
  player.enqueue(pcmSamples([0]));
  assert.equal(fake.buffers.at(-1).getChannelData(0)[0], 0);
});

test('ignores empty chunks', () => {
  const fake = createFakeContext();
  const player = new TtsPlayer(fake.context, { sampleRate: SAMPLE_RATE });
  player.enqueue(new ArrayBuffer(0));
  player.enqueue(pcmSamples([]));
  assert.equal(fake.sources.length, 0);
  assert.equal(player.isEmpty, true);
});
test('019: isAudible tracks the scheduled start, not byte arrival', () => {
  const fake = createFakeContext();
  const player = new TtsPlayer(fake.context, { sampleRate: SAMPLE_RATE });

  // 没排程过任何音频：不可能出声。
  assert.equal(player.isAudible, false);

  // 首片排程带 120ms 提前量：收到字节 ≠ 出声。
  player.enqueue(pcmSamples([1000]));
  assert.equal(player.isAudible, false);
  fake.advance(0.11);
  assert.equal(player.isAudible, false);
  fake.advance(0.02);
  assert.equal(player.isAudible, true);

  // 中途断流（underrun）不算「没在播」：打断语义只关心是否处于出声期。
  fake.advance(5);
  player.enqueue(pcmSamples([500]));
  assert.equal(player.isAudible, true);
});

test('019: stopAll ends audibility immediately (interrupt path)', () => {
  const fake = createFakeContext();
  const player = new TtsPlayer(fake.context, { sampleRate: SAMPLE_RATE });
  player.enqueue(pcmSamples([1000]));
  fake.advance(0.2);
  assert.equal(player.isAudible, true);
  player.stopAll();
  assert.equal(player.isAudible, false);
});
