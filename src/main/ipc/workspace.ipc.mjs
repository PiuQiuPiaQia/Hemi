// 033 · 工作区通道：状态 / 目录选择器添加项目 / 移除列表项。
//
// 登记表（userData/workspaces.json）与默认工作区目录都由 workspace-store
// 持有；conversation.ipc（会话绑定落盘时 touch 最近使用）与 task.ipc（任务
// 受理时取快照）经 getWorkspaceService() 共享同一实例——读取发生在运行期，
// 注册顺序上 workspace.ipc 先于两者（ipc/index.mjs）。
import { app, dialog, ipcMain, safeStorage, shell } from 'electron';
import path from 'node:path';

import { IPC } from '../../shared/ipc-channels.mjs';
import { createWorkspaceStore } from '../workspace/workspace-store.mjs';
import { createRemoteService, setRemoteService } from '../remote/remote-service.mjs';
import { isValidSshTarget } from '../remote/ssh-runner.mjs';
import { createWorkspaceOpener, normalizeOpenTarget, workspaceViewForOpen } from '../services/workspace-open.mjs';
import { readStoredConfig, saveStoredConfig } from '../lib/config-store.mjs';
import { createLogger } from '../lib/logger.mjs';
import { state } from '../state.mjs';

const log = createLogger('workspace');

// ---- 共享实例（registerWorkspaceIpc 创建；其余模块运行期读取） ----
let service = null;

/** 同一登记实例（task.ipc / conversation.ipc 用；未注册时 null，调用方自行兼容）。 */
export function getWorkspaceService() {
  return service;
}

export function registerWorkspaceIpc() {
  const userDataDir = app.getPath('userData');
  const store = createWorkspaceStore({
    filePath: path.join(userDataDir, 'workspaces.json'),
    // 033（ZCode 口径）：默认工作区＝应用数据根下的 workspace/default，随实例隔离。
    dataRoot: userDataDir,
    log,
  });
  service = store;
  // 049：远端服务（共享 SSH 执行器；ControlPath 目录随 userData 隔离）。task.ipc /
  // llm.ipc 经 getRemoteService() 共用。应用退出时 close（index.mjs 的 will-quit）。
  const remoteService = createRemoteService({
    userDataDir,
    log,
    // 「记住密码」（2026-10-12 用户裁决）：safeStorage＝系统钥匙串加密，与模型
    // Key 同一保存方式；不可用时自动降级为仅内存（rememberPassword 内处理）。
    crypto: {
      encrypt: (text) => {
        try {
          return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text).toString('base64') : null;
        } catch {
          return null;
        }
      },
      decrypt: (blob) => {
        try {
          return safeStorage.decryptString(Buffer.from(String(blob), 'base64')) || null;
        } catch {
          return null;
        }
      },
    },
  });
  setRemoteService(remoteService);
  // R-01：默认工作区是真实目录——启动即按需创建（幂等）；创建失败不致命，
  // 状态探测会如实标 missing，界面给重新选择/修复入口，不静默改道。
  const ensured = store.ensureDefault();
  if (ensured.ok) log.info(`默认空间就绪：${store.getState().default.dir}`);
  else log.warn(`默认空间未就绪：${ensured.reason}`);

  ipcMain.handle(IPC.workspace.getState, () => store.getState());

  ipcMain.handle(IPC.workspace.addFolder, async () => {
    // 系统目录选择器（R-02）：用户主动指定本地项目目录，不扫描磁盘。
    const picked = await dialog.showOpenDialog(state.mainWindow, {
      title: '选择项目文件夹',
      properties: ['openDirectory', 'createDirectories'],
    });
    if (picked.canceled || !picked.filePaths?.length) {
      return { ok: false, cancelled: true };
    }
    const result = store.addProject(picked.filePaths[0]);
    if (!result.ok) {
      log.warn(`项目目录添加失败：${result.reason}`);
      return result;
    }
    log.info(
      `项目目录已${result.deduped ? '命中既有登记' : '登记'}：「${result.workspace.name}」${result.workspace.dir}`,
    );
    return { ...result, state: store.getState() };
  });

  // 049 R-01/R-02：添加服务器上的文件夹——probe（登录、目录、真实路径）通过才登记。
  // 失败按分类返回可操作文案（终端修复方式），不登记。
  // 密码登录（2026-10-12 用户裁决）：可选 password——SSH_ASKPASS 喂给系统 ssh，
  // 探测通过后只进会话内存（不落盘，重启后重试连接时重输）。
  ipcMain.handle(IPC.workspace.addRemote, async (_event, payload) => {
    const host = String(payload?.host ?? '').trim();
    const dir = String(payload?.dir ?? '').trim();
    const password = typeof payload?.password === 'string' && payload.password ? payload.password : null;
    const remember = payload?.remember !== false; // 默认记住（用户要的）；显式 false 才只进内存
    if (!isValidSshTarget(host)) {
      return { ok: false, kind: 'invalid-host', field: 'host', message: '服务器格式不对：填 SSH 配置里的 Host，或 user@host。' };
    }
    if (!dir || dir.startsWith('-')) {
      return { ok: false, kind: 'invalid-dir', field: 'dir', message: '文件夹路径不能为空（服务器上的路径，如 ~/projects/atlas）。' };
    }
    const probed = await remoteService.probeWorkspace({ host, dir, password });
    if (!probed.ok) {
      log.warn(`远端项目添加失败（${host} · ${probed.kind}）：${probed.message}`);
      return {
        ok: false,
        kind: probed.kind,
        field: probed.kind === 'notfound' || probed.kind === 'invalid-dir' ? 'dir' : 'host',
        message: probed.message,
        ...(probed.kind === 'auth' ? { canPassword: true } : {}),
      };
    }
    if (password) remoteService.rememberPassword(host, password, { remember });
    const result = store.addRemote({ host, dir: probed.realDir, remoteHome: probed.remoteHome });
    if (!result.ok) {
      log.warn(`远端项目登记失败：${result.reason}`);
      return { ok: false, kind: 'registry', message: result.reason };
    }
    log.info(
      `远端项目已${result.deduped ? '命中既有登记' : '登记'}：「${result.workspace.name}」${host}:${result.workspace.dir}`,
    );
    return { ...result, state: store.getState() };
  });

  // 049 R-09：重试连接（或选中时主动核对）——重新探测并更新状态缓存。
  // 认证失败可带 password 重试（密码重输）；成功即更新内存密码池。
  ipcMain.handle(IPC.workspace.probeRemote, async (_event, payload) => {
    const view = store.resolve(String(payload?.id ?? ''));
    if (!view?.host) return { ok: false, kind: 'not-remote', message: '这个项目不在服务器上' };
    const password = typeof payload?.password === 'string' && payload.password ? payload.password : null;
    const remember = payload?.remember !== false;
    const probed = await remoteService.probeWorkspace({ host: view.host, dir: view.dir, password });
    if (probed.ok) {
      if (password) remoteService.rememberPassword(view.host, password, { remember });
      store.setRemoteStatus(view.id, { status: 'ok' });
      log.info(`远端连接正常：${view.host}:${view.dir}`);
    } else {
      store.setRemoteStatus(view.id, { status: 'missing', message: probed.message });
      log.warn(`远端连接失败（${view.host} · ${probed.kind}）：${probed.message}`);
    }
    return {
      ok: probed.ok,
      ...(probed.ok ? {} : { kind: probed.kind, message: probed.message, ...(probed.kind === 'auth' ? { canPassword: true } : {}) }),
      state: store.getState(),
    };
  });

  ipcMain.handle(IPC.workspace.remove, (_event, payload) => {
    const result = store.removeProject(payload?.id);
    if (!result.ok) log.warn(`项目移除失败：${result.reason}`);
    return { ...result, state: store.getState() };
  });

  // 066：顶栏「打开工作区目录」。渲染层只给登记 id（不收裸路径）；远端项目
  // 与失效目录在此拒绝——openPath/spawn 的落点永远来自登记表 realpath。
  const opener = createWorkspaceOpener({ openPath: (dir) => shell.openPath(dir) });
  ipcMain.handle(IPC.workspace.openDir, async (_event, payload) => {
    const target = normalizeOpenTarget(payload?.target);
    if (payload?.id === 'default') {
      const ready = store.ensureDefault();
      if (!ready.ok) return { ok: false, kind: 'missing', message: ready.reason };
    }
    const view = workspaceViewForOpen(store, String(payload?.id ?? ''));
    if (!view) return { ok: false, kind: 'unknown-workspace', message: '这个工作区不在登记表里，可能刚被移除' };
    if (view.host) {
      log.warn(`066 拒绝远端工作区本地打开：${view.host}:${view.dir}`);
      return { ok: false, kind: 'remote', message: '这个项目在服务器上，本地打不开它的文件夹' };
    }
    if (view.status === 'missing') {
      return { ok: false, kind: 'missing', message: view.message ?? '目录不存在或已移走' };
    }
    const result = await opener.openDir(target, view.dir);
    if (result.ok) log.info(`066 工作区已按 ${target} 打开：「${view.name}」${view.dir}`);
    else log.warn(`066 工作区按 ${target} 打开失败（${result.kind}）：「${view.name}」${view.dir} — ${result.message}`);
    return result;
  });

  ipcMain.handle(IPC.workspace.getOpenTarget, async () => {
    const stored = await readStoredConfig();
    return { target: normalizeOpenTarget(stored.workspaceOpenTarget) };
  });

  ipcMain.handle(IPC.workspace.setOpenTarget, async (_event, payload) => {
    const target = normalizeOpenTarget(payload?.target);
    await saveStoredConfig({ workspaceOpenTarget: target });
    return { target };
  });
}
