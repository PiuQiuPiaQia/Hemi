import { ipcMain } from 'electron';

import { DoubaoTtsSession } from '../services/doubao-tts.mjs';
import { TtsPlayback } from '../services/tts-playback.mjs';
import { resolveConfig, saveStoredConfig } from '../lib/config-store.mjs';
import { createLogger } from '../lib/logger.mjs';
import { state } from '../state.mjs';
import { IPC } from '../../shared/ipc-channels.mjs';
import { getDuplexHost } from './audio.ipc.mjs';

const ttsLog = createLogger('tts');
const playback = new TtsPlayback({
  resolveConfig,
  createSession: (config, emit) => new DoubaoTtsSession({
    apiKey: config.apiKey,
    resourceId: config.ttsResourceId,
    endpoint: config.ttsEndpoint,
    voice: config.ttsVoice,
    sampleRate: 24000,
    speechRate: 0,
  }, emit),
  emit: (turnId, event) => sendTtsEvent(turnId, event),
  log: (message) => ttsLog.info(message),
});

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
}

/**
 * 播报事件 → 渲染层：音频帧即到即推，收尾/失败后清掉单飞占位。
 * 019 duplex 模式：音频分片主进程直推 duplexd（不过渲染层），渲染层只收
 * bytes 元数据事件（计 receivedBytes）；drained 由 duplex 事件通路回报。
 */
function sendTtsEvent(turnId, event) {
  const mainWindow = state.mainWindow;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (event.type === 'audio') {
    const duplex = getDuplexHost();
    if (duplex?.isActive) {
      duplex.play(event.data);
      mainWindow.webContents.send(IPC.tts.audio, {
        turnId,
        seq: event.seq,
        bytes: event.data.byteLength,
      });
      return;
    }
    mainWindow.webContents.send(IPC.tts.audio, {
      turnId,
      seq: event.seq,
      audio: toArrayBuffer(event.data),
    });
    return;
  }

  if (event.type === 'finished') {
    mainWindow.webContents.send(IPC.tts.state, { turnId, phase: 'finished' });
    ttsLog.info(`speak ${turnId} ✓ 合成完成`);
    return;
  }
  if (event.type === 'error') {
    mainWindow.webContents.send(IPC.tts.state, {
      turnId,
      phase: 'failed',
      message: event.message,
    });
    ttsLog.error(`speak ${turnId} ✗ ${event.message}`);
  }
}

export function registerTtsIpc() {
  ipcMain.handle(IPC.tts.getConfig, async () => {
    const config = await resolveConfig({ decryptSecrets: false });
    return {
      ttsEnabled: config.ttsEnabled,
      ttsVoice: config.ttsVoice,
      ttsResourceId: config.ttsResourceId,
      hasApiKey: config.hasApiKey,
      keyStoredSecurely: config.keyStoredSecurely,
    };
  });

  ipcMain.handle(IPC.tts.saveConfig, async (_event, config) => {
    return saveStoredConfig(config ?? {});
  });

  // 单飞：新播报让位旧播报（关旧会话）；音频/状态经事件推给渲染层。
  ipcMain.handle(IPC.tts.speak, async (_event, payload) => {
    if (state.conversationEnvironment === 'bot') return {ok:false,message:'Bot 不启动语音播报。'};
    const turnId = Number(payload?.turnId) || 0;
    const text =
      typeof payload?.text === 'string' ? payload.text.trim() : '';
    return playback.speak(turnId, text);
  });

  ipcMain.on(IPC.tts.cancel, (_event, turnId) => {
    playback.cancel(turnId);
  });
}

/** before-quit 收尾用：关掉在途播报会话。 */
export function closeActiveTtsPlayback() {
  playback.cancel();
}
