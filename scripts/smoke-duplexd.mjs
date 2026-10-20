/**
 * 019 duplexd 冒烟：从 Node 侧验证 stdio 协议端到端。
 * 流程：spawn duplexd → start → 等 ready → 连续入队 1s 正弦（24k，40ms/块，含一次
 * volume 0.5 切换）→ 等 drained → 数 cap 帧 → shutdown → 等 bye。
 * 必须在已授权麦克风的上下文运行（TCC 跟启动上下文走）。
 *
 * 用法：node scripts/smoke-duplexd.mjs [duplexd 路径，默认 dist/duplexd]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const binary = process.argv[2] ?? 'dist/duplexd';
if (!existsSync(binary)) {
  console.error(`duplexd 不存在：${binary}（先跑 scripts/build-duplexd.sh）`);
  process.exit(1);
}

const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const events = [];
let capChunks = 0;
let captureBytes = 0;
const pending = [];

child.stdout.on('data', (data) => {
  pending.push(data);
  while (true) {
    const joined = Buffer.concat(pending);
    const newline = joined.indexOf(0x0a);
    if (newline < 0) {
      pending.splice(0, pending.length, joined);
      break;
    }
    const line = joined.subarray(0, newline);
    pending.splice(0, pending.length, joined.subarray(newline + 1));
    let event;
    try {
      event = JSON.parse(line.toString('utf8'));
    } catch {
      console.error('坏行：', line.toString('utf8').slice(0, 80));
      continue;
    }
    events.push(event);
    if (event.event === 'cap') {
      capChunks += 1;
      captureBytes += Buffer.from(event.pcm, 'base64').length;
    }
    if (event.event === 'fault') {
      console.error('fault:', event.error);
      child.kill('SIGTERM');
      process.exit(1);
    }
  }
});

const send = (object) => child.stdin.write(`${JSON.stringify(object)}\n`);
const waitFor = (name, timeoutMs) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (events.some((event) => event.event === name)) {
        clearInterval(timer);
        resolve(events.find((event) => event.event === name));
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`等待 ${name} 超时（收到 ${events.map((e) => e.event).join(',')}）`));
      }
    }, 50);
  });

// 生成 24k 单声道 int16 正弦，40ms（960 样本）一块。
const chunkMs = 40;
const chunkSamples = (24000 * chunkMs) / 1000;
const toneChunk = (index) => {
  const pcm = Buffer.alloc(chunkSamples * 2);
  for (let i = 0; i < chunkSamples; i += 1) {
    const t = (index * chunkSamples + i) / 24000;
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * t) * 0.25 * 32767), i * 2);
  }
  return pcm;
};

const fail = (error) => {
  console.error('SMOKE FAIL:', error.message);
  child.kill('SIGTERM');
  process.exit(1);
};

let t0 = 0;

try {
  send({ cmd: 'start' });
  const ready = await waitFor('ready', 8000);
  console.log('ready:', JSON.stringify(ready));
  t0 = Date.now();

  const chunks = 1000 / chunkMs; // 1 秒音频（25 块 × 40ms）
  for (let index = 0; index < chunks; index += 1) {
    send({ cmd: 'play', pcm: toneChunk(index).toString('base64') });
    if (index === Math.floor(chunks / 2)) send({ cmd: 'volume', gain: 0.5 });
  }
  await waitFor('drained', 8000);
  console.log('drained OK');

  // 停播清队也要验证：再入队然后 stopPlay。
  send({ cmd: 'play', pcm: toneChunk(0).toString('base64') });
  send({ cmd: 'stopPlay' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  // 审核回归①：stopPlay 之后在途/迟到的 completion 不得伪造 drained。
  const strayDrained = events.filter((event) => event.event === 'drained').length;
  if (strayDrained !== 1) {
    throw new Error(`stopPlay 后 drained 计数异常：期望仍为 1（仅第一次自然播完），实际 ${strayDrained}`);
  }

  // 审核回归②（P0）：stopPlay 之后必须还能出声并正常 drain——
  // stop() 重置节点，未重新 play() 时此处会无声且永不 drained（2026-09-21 实证）。
  const drainedBefore = events.filter((event) => event.event === 'drained').length;
  send({ cmd: 'play', pcm: toneChunk(0).toString('base64') });
  await waitFor('drained', 3000);
  const drainedAfter = events.filter((event) => event.event === 'drained').length;
  if (drainedAfter !== drainedBefore + 1) {
    throw new Error(`打断后复播未正常 drain（前 ${drainedBefore} 后 ${drainedAfter}）`);
  }

  send({ cmd: 'shutdown' });
  await waitFor('bye', 3000);
} catch (error) {
  fail(error);
}

const spanSec = (Date.now() - t0) / 1000;
console.log(`cap 帧：${capChunks}（${(captureBytes / 2 / 16000).toFixed(2)}s @16k，${spanSec.toFixed(1)}s 内，${(capChunks / Math.max(spanSec, 1)).toFixed(1)} 帧/s）`);
// 帧宽由引擎 IO buffer 决定（实测 ~106ms/帧，9~10 帧/s），不按帧率断言；
// 只断言音频覆盖：采集到的音频时长须达到流逝时间的 60%。
const capOk = capChunks >= 8 && captureBytes / 2 / 16000 > spanSec * 0.6;
console.log(capOk ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(capOk ? 0 : 1);
