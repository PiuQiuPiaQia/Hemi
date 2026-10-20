/**
 * 043 B1 · platform IPC：能力快照的读面 / 重查 / 固定动作。
 * contracts 约束：
 * - action 必须属于当前快照里该能力登记的 actions（不接受任意 URI/命令）；
 * - 调用方必须是 Hemi 顶层窗口（access.ipc 同款 isTrustedSender）；
 * - 状态变化统一广播（renderer 先订阅再取初始快照，按 {sessionId,revision} 去重）。
 */
import { ipcMain, BrowserWindow } from 'electron';

import { IPC } from '../../shared/ipc-channels.mjs';
import {
  getPlatformService,
  performPlatformAction,
  refreshPlatformEnabledIntents,
  setPlatformNotify,
} from '../services/platform-instance.mjs';
import { CAPABILITY_IDS } from '../platform/capabilities.mjs';
import { createLogger } from '../lib/logger.mjs';

const log = createLogger('platform');

const CAPABILITY_SET = new Set(CAPABILITY_IDS);

function isTrustedSender(event) {
  const sender = event?.sender;
  if (!sender || !BrowserWindow.fromWebContents(sender)) return false;
  if (event.senderFrame && sender.mainFrame && event.senderFrame !== sender.mainFrame) return false;
  return true;
}

export function registerPlatformIpc() {
  const service = getPlatformService();

  const broadcast = (snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send(IPC.platform.stateChanged, snapshot);
      } catch {
        /* 窗口可能正在关闭 */
      }
    }
  };

  ipcMain.handle(IPC.platform.getState, async (event) => {
    if (!isTrustedSender(event)) return null;
    // 首次读取触发全量探测（幂等）；enabled 意图随后从配置刷新。
    await service.probeAll();
    void refreshPlatformEnabledIntents();
    return service.snapshot();
  });

  ipcMain.handle(IPC.platform.recheck, async (event, payload) => {
    if (!isTrustedSender(event)) return null;
    const capability = payload && typeof payload === 'object' ? payload.capability : payload;
    if (!CAPABILITY_SET.has(capability)) {
      log.warn(`platform.recheck 拒绝：未知能力 ${String(capability)}`);
      return null;
    }
    return service.recheck(capability);
  });

  ipcMain.handle(IPC.platform.performAction, async (event, payload) => {
    if (!isTrustedSender(event)) return { ok: false, error: 'FORBIDDEN' };
    const { capability, action } = payload && typeof payload === 'object' ? payload : {};
    if (!CAPABILITY_SET.has(capability)) return { ok: false, error: 'INVALID_INPUT' };
    const cap = service.snapshot().capabilities[capability];
    // 动作白名单来自当前快照：不在 actions 里的动作一律拒绝。
    if (!cap || !Array.isArray(cap.actions) || !cap.actions.includes(action)) {
      log.warn(`platform.performAction 拒绝：${String(capability)} 无动作 ${String(action)}`);
      return { ok: false, error: 'UNSUPPORTED_ACTION' };
    }
    return performPlatformAction(action, capability);
  });

  // 能力变化即广播（快照同源；运行态事件经 service.apply 也会走到这里）。
  setPlatformNotify(broadcast);
}
