import { app, dialog, ipcMain, shell } from 'electron';
import os from 'node:os';
import path from 'node:path';

import { IPC } from '../../shared/ipc-channels.mjs';
import { createLogger } from '../lib/logger.mjs';
import { createLocalSkillScanner } from '../skills/local-agent-skills.mjs';
import { createSkillStore } from '../skills/skill-store.mjs';
import { createSkillsmpService } from '../skills/skillsmp-service.mjs';
import { getWorkspaceService } from './workspace.ipc.mjs';
import { state } from '../state.mjs';

const log = createLogger('skills');
let service = null;
let marketplace = null;

export function getSkillService() {
  return service;
}

function resultOf(action, label = '') {
  return Promise.resolve().then(action).catch((error) => {
    log.warn(`Skill 操作失败${label ? `（${label}）` : ''}：${error.message}`);
    return { ok: false, reason: error.message, state: service?.state() ?? null };
  });
}

/** SkillsMP 网络/安装链路：错误原样带 reason（含限流/断网/校验失败细节）。
 *  label 记下条目 id/URL——市场里存在下架/改名仓库的坏条目，没有标签的报错
 *  无法定位到具体条目（2026-10-09 实测：451 与「目录不存在」都不知道点的是谁）。 */
function mpResultOf(action, label = '') {
  return Promise.resolve().then(action).catch((error) => {
    log.warn(`SkillsMP 操作失败${label ? `（${label}）` : ''}：${error.message}`);
    return { ok: false, reason: error.message };
  });
}

/** 本机 agent 技能扫描/批量导入网关。工作区来源只取现有登记里「本机且就绪」的
 *  视图（host 为空、status ok——远端项目目录不在本机文件系统上），不含猜测路径；
 *  workspace.ipc 先于本模块注册（ipc/index.mjs），运行期读取共享实例。 */
const localSkillScanner = createLocalSkillScanner({
  home: () => os.homedir(),
  listWorkspaceDirs: () => {
    const workspaceService = getWorkspaceService();
    if (!workspaceService) return [];
    const workspaceState = workspaceService.getState();
    return [workspaceState.default, ...workspaceState.projects]
      .filter((view) => view && !view.host && view.status === 'ok' && typeof view.dir === 'string')
      .map((view) => ({ dir: view.dir, name: view.name }));
  },
  getInstalled: () => service?.state().installed ?? [],
  importOne: (dir, options) => service.importDirectory(dir, options),
  state: () => service.state(),
});

export function registerSkillsIpc() {
  const root = path.join(app.getPath('userData'), 'skills');
  service = createSkillStore({ root, log });
  marketplace = createSkillsmpService({
    store: service,
    cacheFile: path.join(root, 'skillsmp-cache.json'),
    log,
  });
  void service.prune().catch((error) => log.warn(`Skill 启动清理失败：${error.message}`));
  ipcMain.handle(IPC.skills.state, () => ({ ...service.state(), mpSearch: marketplace.searchState() }));
  ipcMain.handle(IPC.skills.refresh, () => resultOf(() => service.refreshCatalog()));
  ipcMain.handle(IPC.skills.importLocal, (_event, payload) => resultOf(async () => {
    const picked = await dialog.showOpenDialog(state.mainWindow, {
      title: '选择包含 SKILL.md 的文件夹',
      properties: ['openDirectory'],
    });
    if (picked.canceled || !picked.filePaths?.length) return { ok: false, cancelled: true, state: service.state() };
    return service.importDirectory(picked.filePaths[0], { mode: payload?.mode });
  }));
  // 本地 agent 技能扫描（只读元数据；候选集留在主进程，导入按它把关）。
  ipcMain.handle(IPC.skills.scanLocal, () => Promise.resolve().then(() => localSkillScanner.scan()).catch((error) => {
    log.warn(`本地技能扫描失败：${error.message}`);
    return { ok: false, reason: error.message, warnings: [] };
  }));
  ipcMain.handle(IPC.skills.importLocalBatch, (_event, payload) =>
    Promise.resolve().then(() => localSkillScanner.import(Array.isArray(payload?.paths) ? payload.paths.map(String) : [], { mode: payload?.mode }))
      .catch((error) => {
        log.warn(`本地技能批量导入失败：${error.message}`);
        return { ok: false, imported: 0, failed: [], reason: error.message, state: service.state() };
      }));
  ipcMain.handle(IPC.skills.install, (_event, payload) =>
    resultOf(() => service.installMarket(String(payload?.id ?? ''))));
  ipcMain.handle(IPC.skills.setEnabled, (_event, payload) =>
    resultOf(() => service.setEnabled(String(payload?.id ?? ''), payload?.enabled === true)));
  ipcMain.handle(IPC.skills.remove, (_event, payload) =>
    resultOf(() => service.remove(String(payload?.id ?? ''))));
  ipcMain.handle(IPC.skills.read, (_event, payload) =>
    resultOf(async () => ({ ok: true, text: await service.readSkill(String(payload?.id ?? '')) })));
  ipcMain.handle(IPC.skills.reveal, (_event, payload) =>
    resultOf(() => {
      shell.showItemInFolder(path.join(service.managedPath(String(payload?.id ?? '')), 'SKILL.md'));
      return { ok: true };
    }));
  ipcMain.handle(IPC.skills.mpSearch, (_event, payload) =>
    mpResultOf(() => marketplace.search({ query: payload?.query, sortBy: payload?.sortBy }), `搜索 ${payload?.query ?? ''}`));
  ipcMain.handle(IPC.skills.mpPreview, (_event, payload) =>
    mpResultOf(() => marketplace.preview({ id: payload?.id }), `预览 ${payload?.id ?? ''}`));
  ipcMain.handle(IPC.skills.mpInstall, (_event, payload) => {
    const input = payload ?? {};
    return resultOf(() => marketplace.install({
      skillsmpId: input.skillsmpId,
      commit: input.commit,
      bundleSha256: input.bundleSha256,
      githubUrl: input.githubUrl,
      author: input.author,
      skillUrl: input.skillUrl,
    }), `安装 ${input.skillsmpId ?? ''} ${input.githubUrl ?? ''}`);
  });
  ipcMain.handle(IPC.skills.mpCheckUpdate, (_event, payload) =>
    mpResultOf(() => marketplace.checkUpdate({ id: payload?.id }), `检查更新 ${payload?.id ?? ''}`));
}
