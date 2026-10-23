import { ipcMain } from 'electron';

import { createRecognitionOptions, DoubaoAsrSession } from '../services/doubao-asr.mjs';
import { readStoredConfig, resolveConfig, saveStoredConfig } from '../lib/config-store.mjs';
import { createLogger } from '../lib/logger.mjs';
import { state } from '../state.mjs';
import { IPC } from '../../shared/ipc-channels.mjs';

let activeAsrSession = null;
const asrLog = createLogger('asr');

/** stop() 的硬上限：会话收尾挂死时强断（新 asr:start 排在它后面会被拖死）。 */
const STOP_CAP_MS = 8000;

function sendAsrEvent(payload) {
  const mainWindow = state.mainWindow;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC.asr.event, payload);
}

async function stopActiveSession() {
  const current = activeAsrSession;
  if (!current) return;

  try {
    await Promise.race([
      current.stop(),
      new Promise((resolve) => setTimeout(resolve, STOP_CAP_MS)),
    ]);
  } catch (error) {
    sendAsrEvent({
      type: 'error',
      message: error instanceof Error ? error.message : '关闭识别会话失败。',
    });
  }

  // 020 实录修复：身份守卫必须在收尾 flush 之后才解除。松手后尾句的 definite
  // 定稿恰好在 current.stop() 期间回包（last 包触发的最终响应），先置空会让
  // 转发回调的身份守卫把最后一批定稿拦在渲染层外——用户看到的就是
  // 「hold 松手 → 没有新定稿」。显式 startAsr 顶掉旧会话的场景同样安全：
  // flush 的都是用户刚说的话，归入提交它的会话才对。
  if (activeAsrSession === current) activeAsrSession = null;
}

export const stopAsrForBot = stopActiveSession;

export function registerAsrIpc() {
  ipcMain.handle(IPC.asr.getConfig, async () => {
    const config = await resolveConfig({ decryptSecrets: false });
    return {
      resourceId: config.resourceId,
      endpoint: config.endpoint,
      hasApiKey: config.hasApiKey,
      keyStoredSecurely: config.keyStoredSecurely,
    };
  });

  ipcMain.handle(IPC.asr.saveConfig, async (_event, config) => {
    return saveStoredConfig(config ?? {});
  });

  ipcMain.handle(IPC.asr.start, async (_event, mode) => {
    if (state.conversationEnvironment === 'bot') return {ok:false,code:'BOT_VOICE_DISABLED',message:'Bot 使用文字对话。'};
    await stopActiveSession();
    const config = await resolveConfig();
    // 2026-10-07：hold 断句静音延长至 1.5s，并开启 bigmodel_async 的句末
    // 二遍识别（临时字幕仍实时返回）。松手 flush 后再提交完整回合。

    if (!config.apiKey || !config.resourceId) {
      asrLog.warn('start ✗ 缺少 API Key / Resource ID');
      return {
        ok: false,
        code: 'CONFIG_REQUIRED',
        message: '请先填写豆包 API Key 和 Resource ID。',
      };
    }

    // 013 D-2：说话人区分仅在通话模式 + 用户开关时开启（payload 加三参数）。
    const stored = await readStoredConfig();
    const options = createRecognitionOptions(mode, { primarySpeakerEnabled: stored.primarySpeakerEnabled });
    asrLog.info(`start → 连接豆包…（${mode}/双向流式${options.nonstream || options.speakerInfo ? '+二遍' : ''}/断句静音 ${options.endWindowSize}ms）`);
    // 身份守卫（019 重连风暴修复）：每个会话只转发「自己仍是当前会话时」的事件。
    // startAsr 先顶掉旧会话，旧会话停止时也会发 session.ended——不过滤的话，
    // 渲染层把「被顶掉」当「真断线」再排重连，新会话又顶掉旧会话……自持循环
    // 且成功即归零计数、退避永不增长（2026-09-21 真机日志实证）。
    const nextSession = new DoubaoAsrSession(
      config,
      (payload) => {
        if (activeAsrSession === nextSession) sendAsrEvent(payload);
      },
      options,
    );
    activeAsrSession = nextSession;

    try {
      await nextSession.start();
      asrLog.info('start ✓ 会话已建立');
      return { ok: true };
    } catch (error) {
      if (activeAsrSession === nextSession) activeAsrSession = null;
      asrLog.error(
        `start ✗ ${error instanceof Error ? error.message : '连接失败'}`,
      );
      return {
        ok: false,
        code: 'CONNECTION_FAILED',
        message:
          error instanceof Error ? error.message : '无法连接豆包语音识别服务。',
      };
    }
  });

  ipcMain.on(IPC.asr.audio, (_event, audio) => {
    if (!activeAsrSession || !audio) return;
    activeAsrSession.sendAudio(Buffer.from(audio));
  });

  ipcMain.handle(IPC.asr.stop, async () => {
    asrLog.info('stop → 收尾（等尾句定稿）');
    await stopActiveSession();
    asrLog.info('stop ✓ 收尾完成');
    return { ok: true };
  });
}

/** before-quit 收尾用：关掉在途识别会话。 */
export function stopActiveAsrSession() {
  return stopActiveSession();
}
