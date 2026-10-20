// 013 说话人字段探针：应用内跑一次真实流式识别（开 enable_speaker_info），
// 把响应里 utterance 的原始 JSON 落盘——确认说话人编号的真实字段名与位置。
//
// 运行：node_modules/.bin/electron src/main/speaker-probe.mjs
// 产物：/tmp/hemi-speaker-probe.json（全部原始 payload）+ stdout 摘要。
// 不开窗口、不加任务面；Key 走应用的 userData（safeStorage 在本二进制内可解）。
import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DoubaoAsrSession } from './services/doubao-asr.mjs';
import { resolveConfig } from './lib/config-store.mjs';

app.setName('hemi');

const SPEECH_TEXT = '你好，我是Hemi，正在测试说话人聚类功能，请把说话人编号返回给我。';

function synthSpeech(dir) {
  const aiff = path.join(dir, 'probe.aiff');
  const wav = path.join(dir, 'probe.wav');
  try {
    execFileSync('say', ['-v', 'Tingting', '-o', aiff, SPEECH_TEXT], { timeout: 30_000 });
  } catch {
    execFileSync('say', ['-o', aiff, SPEECH_TEXT], { timeout: 30_000 });
  }
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav], { timeout: 30_000 });
  const raw = readFileSync(wav);
  const dataStart = raw.indexOf('data', 12) + 8; // 跳过 RIFF/fmt 头，定位 data 块内容
  return raw.subarray(dataStart);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  const config = await resolveConfig();
  if (!config.apiKey) {
    console.error('PROBE-FAIL: 没有 ASR Key（解密失败或未配置）');
    app.exit(2);
    return;
  }
  console.log(`PROBE: endpoint=${config.endpoint} resource=${config.resourceId} keyLen=${config.apiKey.length}`);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-probe-'));
  const pcm = synthSpeech(dir);
  console.log(`PROBE: audio ${(pcm.length / 32000).toFixed(1)}s (${pcm.length} bytes)`);

  const rawPayloads = [];
  const events = [];
  const session = new DoubaoAsrSession(
    config,
    (event) => {
      events.push({ ...event, text: (event.text ?? '').slice(0, 40) });
      if (event.type === 'transcript.final') console.log(`EVENT final: speaker=${JSON.stringify(event.speaker ?? null)} text=${event.text.slice(0, 24)}`);
    },
    { nonstream: false, speakerInfo: true, rawSink: (payload) => rawPayloads.push(JSON.parse(JSON.stringify(payload))) },
  );

  const startedAt = Date.now();
  await session.start();
  const CHUNK = 6400; // 200ms @16k16bit
  for (let offset = 0; offset < pcm.length; offset += CHUNK) {
    session.sendAudio(pcm.subarray(offset, Math.min(offset + CHUNK, pcm.length)));
    await sleep(60);
  }
  await session.stop();
  const waitTimer = setInterval(() => {
    if (Date.now() - startedAt > 45_000) {
      console.log('PROBE: 等待超时，强制收尾');
      session.finish?.();
    }
  }, 1000);
  await sleep(6000);
  clearInterval(waitTimer);
  session.stop().catch(() => {});

  const outFile = '/tmp/hemi-speaker-probe.json';
  writeFileSync(outFile, JSON.stringify({ events, rawPayloads }, null, 2));
  console.log(`PROBE: ${rawPayloads.length} 个原始负载 → ${outFile}`);
  // 打印首个带 utterances 的负载的完整第一条分句（所有键，含 additions）。
  for (const payload of rawPayloads) {
    const result = Array.isArray(payload.result) ? payload.result[0] : payload.result;
    const utterance = result?.utterances?.[0];
    if (utterance) {
      console.log('PROBE utterance[0] keys:', Object.keys(utterance).join(','));
      console.log('PROBE utterance[0]:', JSON.stringify(utterance).slice(0, 600));
      if (utterance.additions) {
        console.log('PROBE additions keys:', Object.keys(utterance.additions).join(','));
        console.log('PROBE additions:', JSON.stringify(utterance.additions).slice(0, 400));
      }
      break;
    }
  }
  console.log('PROBE events:', JSON.stringify(events.slice(0, 6)));
  rmSync(dir, { recursive: true, force: true });
  app.exit(0);
}

main().catch((error) => {
  console.error('PROBE-FAIL:', error.message);
  app.exit(1);
});
