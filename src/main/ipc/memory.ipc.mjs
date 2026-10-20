import { ipcMain, app, shell, BrowserWindow } from 'electron';
import path from 'node:path';

import { IPC } from '../../shared/ipc-channels.mjs';
import { createLogger } from '../lib/logger.mjs';
import { readStoredConfig, saveStoredConfig } from '../lib/config-store.mjs';
import { CODEPOINT_LIMITS, createMemoryService } from '../services/memory.mjs';

/**
 * 016 记忆 IPC：状态读取（文档 + 容量）、整文件保存（冲突保护）、打开目录。
 * 记忆始终启用，无开关（2026-09-21 裁决）。服务实例在这里创建，llm.ipc / task.ipc 通过
 * getMemoryService() 取用（注入模式与 context.ipc 的 getWorkContext 一致）。
 * 032：新增记忆运行状态与「任务收尾记忆摘要」开关（stored config，执行器
 * 建会话时应用）。pi-memory 的便签/日志由执行器自管，不在设置页暴露。
 */

let memoryService = null;

export function getMemoryService() {
  return memoryService;
}

async function memoryStatus() {
  const stored = await readStoredConfig();
  return {
    exitSummaryEnabled: stored.memoryExitSummaryEnabled !== false,
    memoryDir: memoryService.memoryDir,
  };
}

export function registerMemoryIpc() {
  const log = createLogger('memory');
  memoryService = createMemoryService({
    memoryDir: path.join(app.getPath('userData'), 'memory'),
    log,
  });
  memoryService.ensureReady();

  // 037：持久提交成功后向所有窗口广播变更摘要（不含原文正文；renderer 有
  // 草稿时只标记外部更新，由 UI 决定刷新策略）。
  memoryService.subscribeChanges((info) => {
    for (const win of [... BrowserWindow.getAllWindows()]) {
      if (!win || win.isDestroyed()) continue;
      win.webContents.send(IPC.memory.changed, info);
    }
  });

  ipcMain.handle(IPC.memory.getState, () => {
    return {
      documents: memoryService.readDocuments(),
      limits: CODEPOINT_LIMITS,
    };
  });

  ipcMain.handle(IPC.memory.saveDocument, (_event, payload) => {
    return memoryService.saveDocument({
      target: String(payload?.target ?? ''),
      text: String(payload?.text ?? ''),
      expectedText:
        payload?.expectedText === null || payload?.expectedText === undefined
          ? null
          : String(payload.expectedText),
    });
  });

  ipcMain.handle(IPC.memory.openDirectory, async () => {
    const result = await shell.openPath(memoryService.memoryDir);
    return { ok: !result, error: result || null };
  });

  ipcMain.handle(IPC.memory.getStatus, () => {
    return memoryStatus();
  });

  ipcMain.handle(IPC.memory.setExitSummary, async (_event, payload) => {
    const enabled = payload?.enabled !== false;
    await saveStoredConfig({ memoryExitSummaryEnabled: enabled });
    log.info(`任务收尾记忆摘要：${enabled ? '开' : '关'}`);
    return memoryStatus();
  });

  // ---- 037 分域条目管理（IPC 只净化参数与分发，业务校验在服务层） ----

  ipcMain.handle(IPC.memory.listEntries, (_event, payload) => {
    return memoryService.listEntries({
      scope: payload?.scope ?? null,
      query: typeof payload?.query === 'string' ? payload.query : '',
      cursor: Number.isInteger(payload?.cursor) ? payload.cursor : 0,
      limit: Number.isInteger(payload?.limit) ? payload.limit : 50,
    });
  });

  ipcMain.handle(IPC.memory.mutateEntry, (_event, payload) => {
    return memoryService.mutateEntry({
      scope: payload?.scope ?? null,
      action: payload?.action === 'replace' ? 'replace' : 'add',
      entryId: typeof payload?.entryId === 'string' ? payload.entryId : undefined,
      expectedVersion: Number.isInteger(payload?.expectedVersion) ? payload.expectedVersion : undefined,
      title: payload?.title,
      body: payload?.body,
      kind: payload?.kind,
      sourceRefs: Array.isArray(payload?.sourceRefs) ? payload.sourceRefs : [],
      relatedEntryIds: Array.isArray(payload?.relatedEntryIds) ? payload.relatedEntryIds : [],
    });
  });

  ipcMain.handle(IPC.memory.moveEntry, (_event, payload) => {
    return memoryService.moveEntry({
      fromScope: payload?.fromScope ?? null,
      entryId: typeof payload?.entryId === 'string' ? payload.entryId : '',
      expectedVersion: Number.isInteger(payload?.expectedVersion) ? payload.expectedVersion : undefined,
      toScope: payload?.toScope ?? null,
    });
  });

  ipcMain.handle(IPC.memory.forgetEntry, (_event, payload) => {
    return memoryService.forgetEntry({
      scope: payload?.scope ?? null,
      entryId: typeof payload?.entryId === 'string' ? payload.entryId : '',
      expectedVersion: Number.isInteger(payload?.expectedVersion) ? payload.expectedVersion : undefined,
    });
  });

  ipcMain.handle(IPC.memory.clearScope, (_event, payload) => {
    return memoryService.clearScope({
      scope: payload?.scope ?? null,
      expectedRevision: Number.isInteger(payload?.expectedRevision) ? payload.expectedRevision : undefined,
    });
  });

  ipcMain.handle(IPC.memory.undo, (_event, payload) => {
    return memoryService.undoMutation({
      operationId: typeof payload?.operationId === 'string' ? payload.operationId : '',
      expectedAfterVersion: Number.isInteger(payload?.expectedAfterVersion) ? payload.expectedAfterVersion : undefined,
    });
  });
}
