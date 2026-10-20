/**
 * audio.ipc — 019 duplex 后端的主进程面。
 *
 * duplexd 宿主的单例家：渲染层经 IPC 启停/控制，helper 事件转发给主窗口；
 * tts.ipc 经 getDuplexHost() 直推音频分片（2026-09-21 裁决：音频数据不过
 * 渲染层）。渲染层接线未合入前，没有任何调用方会拉起 duplexd——这层处于
 * 待命状态，行为与现状零差异。
 */

import { app, ipcMain } from 'electron';

import { createDuplexHost, resolveDuplexBin } from '../audio/duplex-host.mjs';
import { createLogger } from '../lib/logger.mjs';
import { state } from '../state.mjs';
import { IPC } from '../../shared/ipc-channels.mjs';

const audioLog = createLogger('audio');

let host = null;

function ensureHost() {
  if (host) return host;
  host = createDuplexHost({ bin: resolveDuplexBin(app), log: audioLog });
  host.events.on('state', (snapshot) => {
    audioLog.info(`duplex 状态：${JSON.stringify(snapshot)}`);
    const window = state.mainWindow;
    if (!window || window.isDestroyed()) return;
    window.webContents.send(IPC.duplex.state, snapshot);
  });
  host.events.on('cap', ({ data, ms }) => {
    const window = state.mainWindow;
    if (!window || window.isDestroyed()) return;
    window.webContents.send(IPC.duplex.cap, {
      audio: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      ms,
    });
  });
  const forward = (channel) => () => {
    const window = state.mainWindow;
    if (!window || window.isDestroyed()) return;
    window.webContents.send(channel);
  };
  host.events.on('drained', forward(IPC.duplex.drained));
  host.events.on('underrun', forward(IPC.duplex.underrun));
  return host;
}

/** tts.ipc 用：活动会话存在则直推播放，否则走渲染层 Web Audio 旧路。 */
export function getDuplexHost() {
  return host;
}

export function registerAudioIpc() {
  ipcMain.handle(IPC.duplex.start, async () => {
    const result = await ensureHost().start();
    if (!result.ok) audioLog.warn(`duplex 启动失败（${result.reason}），渲染层将回退浏览器链路`);
    return result;
  });

  ipcMain.handle(IPC.duplex.stop, async () => {
    if (!host) return { ok: true, note: 'not-running' };
    await host.stop();
    return { ok: true };
  });

  ipcMain.handle(IPC.duplex.stopPlay, () => ({ ok: Boolean(host?.stopPlay()) }));

  ipcMain.handle(IPC.duplex.volume, (_event, gain) => ({ ok: Boolean(host?.setVolume(gain)) }));
}

/** before-quit 收尾：不留音频进程。 */
export async function stopDuplexHost() {
  if (host) await host.stop();
}
