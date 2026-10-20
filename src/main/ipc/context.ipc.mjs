import { ipcMain, dialog } from 'electron';

import { IPC } from '../../shared/ipc-channels.mjs';
import { createWorkContext } from '../context/work-context.mjs';
import { readStoredConfig, resolveVisionModelConfig } from '../lib/config-store.mjs';
import { createLogger } from '../lib/logger.mjs';
import { answerAboutImage } from '../services/vision-model.mjs';
import { state } from '../state.mjs';

const log = createLogger('context');
let workContext = null;

/** llm.ipc 回合注入用（008 D-6）。 */
export function getWorkContext() {
  return workContext;
}

function broadcast() {
  const window = state.mainWindow;
  if (window && !window.isDestroyed()) {
    window.webContents.send(IPC.context.state, workContext.state());
  }
}

export function registerContextIpc() {
  workContext = createWorkContext({
    // R-04：截图附加前置校验「桌面操控」总开关（与 006 同一开关）。
    isComputerUseEnabled: async () => {
      const stored = await readStoredConfig();
      return stored.computerUseEnabled !== false;
    },
    // D-3：图片解读在回合时按用户问题进行；模型走模型页的视觉裁决
    // （主脑模型能看图即随主模型；否则用挑的看图模型，端点/Key 取
    // 目标所在供应商——2026-10-07 起可跨供应商）。
    resolveImageAnswer: async ({ question, imageData, mimeType, header }) => {
      const vision = await resolveVisionModelConfig();
      return answerAboutImage({
        baseUrl: vision.baseUrl,
        apiKey: vision.apiKey,
        model: vision.model,
        question,
        imageData,
        mimeType,
        header,
      });
    },
    showOpenDialog: (options) => dialog.showOpenDialog(state.mainWindow, options),
    log,
  });
  workContext.onChange(broadcast);

  ipcMain.handle(IPC.context.getState, () => workContext.state());

  ipcMain.handle(IPC.context.attach, async (_event, payload) => {
    try {
      const result = await workContext.attach(String(payload?.kind ?? ''));
      return { ...result, state: workContext.state() };
    } catch (error) {
      log.warn(`附加失败：${error.message}`);
      throw error; // 可读错误透传渲染层（来源条内联展示）
    }
  });

  ipcMain.handle(IPC.context.refresh, async (_event, payload) => {
    try {
      const object = await workContext.refresh(String(payload?.id ?? ''));
      return { ok: true, cancelled: object === null, state: workContext.state() };
    } catch (error) {
      log.warn(`刷新失败：${error.message}`);
      throw error;
    }
  });

  ipcMain.handle(IPC.context.remove, (_event, payload) => {
    workContext.remove(String(payload?.id ?? ''));
    return { ok: true, state: workContext.state() };
  });
}
