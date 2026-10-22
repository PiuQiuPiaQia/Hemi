import { ipcMain, app, dialog, shell } from 'electron';
import path from 'node:path';

import { IPC } from '../../shared/ipc-channels.mjs';
import {
  browserBridgeStatePathFor,
  exportBrowserExtensionFiles,
} from '../agent/permission-state.mjs';
import {
  detectVisionPermissions,
  openPermissionPane,
} from '../agent/vision-permissions.mjs';
import {
  readStoredConfig,
  resolveJevConfig,
  saveStoredConfig,
  resolveWebSearchConfig,
  saveWebSearchStore,
} from '../lib/config-store.mjs';
import { syncExecutorProxy } from '../lib/shell-proxy.mjs';
import { pingJev } from '../agent/gate/jev-client.mjs';
import { createLogger } from '../lib/logger.mjs';

const log = createLogger('executor');

/**
 * 023 · 执行能力设置 IPC。Pi 已随包内置：这里不再有「检测/安装/取消安装/安装
 * 状态」的任何处理（R-16），只剩仍有用户价值的能力开关、权限引导、浏览器桥
 * 运行态与扩展导出。
 */
export function registerExecutorIpc() {
  // 006：computer use 开关与 macOS 权限检测/引导（设置页电脑控制区块）。
  // 视觉模型 2026-09-20 起归 设置 → 模型（llm.ipc 读写），这里只管开关。
  ipcMain.handle(IPC.executor.getComputerUse, async () => {
    const stored = await readStoredConfig();
    return { enabled: stored.computerUseEnabled !== false };
  });
  ipcMain.handle(IPC.executor.setComputerUse, async (_event, payload) => {
    const next = {};
    if (payload && typeof payload.enabled === 'boolean') next.computerUseEnabled = payload.enabled;
    const saved = await saveStoredConfig(next);
    return { enabled: saved.computerUseEnabled !== false };
  });
  ipcMain.handle(IPC.executor.getVisionPermissions, () => detectVisionPermissions());
  ipcMain.handle(IPC.executor.openPermissionPane, (_event, kind) =>
    openPermissionPane(kind === 'screenRecording' ? 'screenRecording' : 'accessibility'));

  // 014：浏览器操控（扩展桥）——开关、桥运行态、扩展目录定位。
  ipcMain.handle(IPC.executor.getBrowserControl, async () => {
    const stored = await readStoredConfig();
    return { enabled: stored.browserControlEnabled === true };
  });
  ipcMain.handle(IPC.executor.setBrowserControl, async (_event, payload) => {
    const next = {};
    if (payload && typeof payload.enabled === 'boolean') next.browserControlEnabled = payload.enabled;
    const saved = await saveStoredConfig(next);
    log.info(`浏览器操控开关：${saved.browserControlEnabled ? '开' : '关'}`);
    return { enabled: saved.browserControlEnabled === true };
  });
  // web 检索：开关与 provider key。key 只进不出的单向通道——回执永远只带
  // hasApiKey，明文不出主进程（与 LLM key 同一纪律）。
  ipcMain.handle(IPC.executor.getWebSearch, async () => {
    const stored = await readStoredConfig();
    const web = await resolveWebSearchConfig({ decryptSecrets: false });
    return {
      enabled: stored.webSearchEnabled === true,
      hasApiKey: web.hasApiKey,
      provider: web.provider,
    };
  });
  ipcMain.handle(IPC.executor.setWebSearch, async (_event, payload) => {
    const next = {};
    if (payload && typeof payload.enabled === 'boolean') next.webSearchEnabled = payload.enabled;
    const saved = await saveStoredConfig(next);
    let key = await resolveWebSearchConfig({ decryptSecrets: false });
    if (payload && typeof payload.apiKey === 'string') {
      const stored = await saveWebSearchStore({ apiKey: payload.apiKey });
      key = { provider: stored.provider, hasApiKey: stored.hasApiKey };
      log.info(`web 检索 key：${stored.hasApiKey ? `已更新（${stored.keyStoredSecurely ? '加密落盘' : '内存暂存'}）` : '已清除'}`);
    }
    return {
      enabled: saved.webSearchEnabled === true,
      hasApiKey: key.hasApiKey,
      provider: key.provider,
    };
  });

  // 020：browser_act（Jev 步进）——开关、端点与 key（key 只写不读，同 web 检索纪律）。
  ipcMain.handle(IPC.executor.getBrowserAct, async () => {
    const stored = await readStoredConfig();
    const jev = await resolveJevConfig({ decryptSecrets: false });
    return {
      enabled: stored.browserActEnabled !== false,
      baseUrl: stored.jevBaseUrl,
      model: stored.jevModel,
      hasApiKey: jev.hasApiKey,
    };
  });
  ipcMain.handle(IPC.executor.setBrowserAct, async (_event, payload) => {
    const next = {};
    if (payload && typeof payload.enabled === 'boolean') next.browserActEnabled = payload.enabled;
    if (payload && typeof payload.baseUrl === 'string' && payload.baseUrl.trim()) next.jevBaseUrl = payload.baseUrl.trim();
    if (payload && typeof payload.model === 'string' && payload.model.trim()) next.jevModel = payload.model.trim();
    const saved = await saveStoredConfig(next);
    if (payload && typeof payload.apiKey === 'string') {
      await saveStoredConfig({ jevApiKey: payload.apiKey });
      log.info(`Jev key：${payload.apiKey ? '已更新（加密落盘）' : '已清除'}`);
    }
    const jev = await resolveJevConfig({ decryptSecrets: false });
    return {
      enabled: saved.browserActEnabled !== false,
      baseUrl: saved.jevBaseUrl,
      model: saved.jevModel,
      hasApiKey: jev.hasApiKey,
    };
  });
  // 设置页「测试连通性」：用输入框当前值（含未保存的 key）探活 Jev 决策端，
  // 缺省字段回落存储值。永不抛错——结果结构化返回。
  ipcMain.handle(IPC.executor.testBrowserAct, async (_event, payload) => {
    const overrides = payload && typeof payload === 'object' ? payload : {};
    const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
    const stored = await readStoredConfig();
    const jev = await resolveJevConfig();
    try {
      return await pingJev({
        baseUrl: pick(overrides.baseUrl) || stored.jevBaseUrl,
        model: pick(overrides.model) || stored.jevModel,
        apiKey: pick(overrides.apiKey) || jev.apiKey,
      });
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });

  // 2026-09-26：执行器终端命令代理开关（输入工具行快捷拨杆）。开＝把系统
  // 代理写进主进程 env（bash 子进程继承），关＝清掉恢复直连；立即生效。
  ipcMain.handle(IPC.executor.getShellProxy, async () => {
    const stored = await readStoredConfig();
    return { enabled: stored.executorProxyEnabled === true };
  });
  ipcMain.handle(IPC.executor.setShellProxy, async (_event, enabled) => {
    const next = typeof enabled === 'boolean' ? enabled : true;
    const saved = await saveStoredConfig({ executorProxyEnabled: next });
    const applied = await syncExecutorProxy(saved.executorProxyEnabled === true, { log });
    return {
      enabled: saved.executorProxyEnabled === true,
      applied: applied.enabled,
      proxy: applied.proxy,
    };
  });

  ipcMain.handle(IPC.executor.getBrowserBridge, async () => {
    const statePath = browserBridgeStatePathFor(app.getPath('userData'));
    try {
      const { readFile } = await import('node:fs/promises');
      const parsed = JSON.parse(await readFile(statePath, 'utf8'));
      return {
        state: ['connecting', 'ready', 'error', 'off'].includes(parsed?.state) ? parsed.state : 'off',
        detail: typeof parsed?.detail === 'string' ? parsed.detail : null,
        port: Number.isInteger(parsed?.port) ? parsed.port : null,
        updatedAt: Number.isFinite(parsed?.updatedAt) ? parsed.updatedAt : null,
        // 021：扩展自报版本（hello 携带）——null＝旧扩展没报，指引重载。
        extVersion: typeof parsed?.extVersion === 'string' ? parsed.extVersion : null,
        backend: ['extension', 'headless'].includes(parsed?.backend) ? parsed.backend : null,
        extensionConnected: parsed?.extensionConnected === true,
        headlessTasks: Number.isInteger(parsed?.headlessTasks) ? parsed.headlessTasks : 0,
      };
    } catch {
      return { state: 'off', detail: null, port: null, updatedAt: null, extVersion: null, backend: null, extensionConnected: false, headlessTasks: 0 };
    }
  });
  // 2026-09-20 二次裁决：导出去哪由用户在系统目录选择窗里定（比如桌面），
  // 之后 Chrome 从那里加载；应用不替用户决定位置。选过的目录在本次会话内
  // 记住，再次导出默认落在同一处。
  let lastExtensionExportDir = null;
  ipcMain.handle(IPC.executor.exportBrowserExtension, async () => {
    // 扩展源码目录：dev＝仓库目录；打包后随 extraResources 落在 resources/chrome-extension。
    const sourceDir = app.isPackaged
      ? path.join(process.resourcesPath, 'chrome-extension')
      : path.join(app.getAppPath(), 'extensions', 'chrome-extension');
    const chosen = await dialog.showOpenDialog({
      title: '选择扩展导出位置',
      message: '选一个好找的位置，Chrome 将从这里加载扩展',
      defaultPath: lastExtensionExportDir ?? app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (chosen.canceled || !chosen.filePaths?.length) {
      return { canceled: true };
    }
    const targetRoot = chosen.filePaths[0];
    const exportDir = exportBrowserExtensionFiles({ sourceDir, targetRoot });
    lastExtensionExportDir = targetRoot;
    shell.showItemInFolder(path.join(exportDir, 'manifest.json'));
    return { path: exportDir };
  });
}
