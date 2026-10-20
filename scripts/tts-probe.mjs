/**
 * R-07 实测探针:用真实配置连一次 TTS 握手,区分 403 是 Resource ID 档位问题
 * 还是 Key 未开通 TTS 权益。握手失败/成功即返回,不实际合成。
 * 用法: npx electron electron/tts-probe.mjs <resource-id>
 * 资源 ID 也可用 DOUBAO_TTS_RESOURCE_ID 环境变量传入。
 */
import { app, safeStorage } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DoubaoTtsSession } from './doubao-tts.mjs';

// 与 main.mjs 一致的稳定存储身份,才能解出同一份加密 Key。
const STABLE_STORAGE_NAME = 'hemi';
app.setName(STABLE_STORAGE_NAME);
app.setPath('userData', path.join(app.getPath('appData'), STABLE_STORAGE_NAME));

const resourceArg = process.argv[2] || process.env.DOUBAO_TTS_RESOURCE_ID || 'seed-tts-1.0';

async function loadApiKey() {
  if (process.env.DOUBAO_API_KEY) return process.env.DOUBAO_API_KEY;
  const raw = await readFile(
    path.join(app.getPath('userData'), 'doubao-asr.json'),
    'utf8',
  );
  const stored = JSON.parse(raw);
  if (stored.encryptedApiKey && safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(
      Buffer.from(stored.encryptedApiKey, 'base64'),
    );
  }
  throw new Error('存储中没有可用的豆包 API Key。');
}

app.whenReady().then(async () => {
  try {
    const apiKey = await loadApiKey();
    let audioBytes = 0;
    let audioChunks = 0;
    const session = new DoubaoTtsSession(
      {
        apiKey,
        resourceId: resourceArg,
        endpoint: 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
        voice: process.env.DOUBAO_TTS_VOICE || 'zh_female_cancan_mars_bigtts',
      },
      (event) => {
        if (event.type === 'audio') {
          audioBytes += event.data.length;
          audioChunks += 1;
          return;
        }
        console.log(`[${resourceArg}] ${event.type}${event.message ? ` ${event.message}` : ''}`);
        if (event.type === 'finished') {
          console.log(
            `[${resourceArg}] ✓ 合成成功：${audioChunks} 个音频分片，${audioBytes} 字节 PCM（${(audioBytes / 2 / 24000).toFixed(2)} 秒）`,
          );
        }
        // started 只是握手里程碑：等合成收尾再退，顺便统计音频量。
        if (event.type === 'finished' || event.type === 'failed' || event.type === 'error') {
          session.close();
          setTimeout(() => app.exit(0), 200);
        }
      },
    );

    console.log(
      `[${resourceArg}] 连接 bidirection（voice=${process.env.DOUBAO_TTS_VOICE || 'zh_female_cancan_mars_bigtts'}）…`,
    );
    await session.start();
    session.speak('你好，我是 Hemi。');
    setTimeout(() => {
      console.log(
        `[${resourceArg}] 15 秒无收尾（已收 ${audioChunks} 片 / ${audioBytes} 字节，视为超时）`,
      );
      session.close();
      app.exit(0);
    }, 15000).unref?.();
  } catch (error) {
    console.log(`[${resourceArg}] 握手失败:`, error instanceof Error ? error.message : error);
    app.exit(0);
  }
});
