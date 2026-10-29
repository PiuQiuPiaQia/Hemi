/**
 * 042 · access IPC：应用级授权的管理面（contracts §4）。
 * 读面（get-state、list-applications）与写面（添加应用、界面开关、
 * remove、revoke）都只在主进程权限服务上操作；expectedRevision 乐观并发由服务校验。
 * 旧三档通道（permission:set-mode 等）已退役——handler 不再注册，调用方全部
 * 迁到本文件通道；permission-state.json 留盘仅作诊断。
 */
import { app, ipcMain, BrowserWindow } from 'electron';

import { IPC } from '../../shared/ipc-channels.mjs';
import { getPermissionService } from '../services/permission-instance.mjs';
import { createAppCatalog, decodeBundleAppRef } from '../services/app-catalog.mjs';
import { cua } from '../agent/gate/cua-client.mjs';
import { createLogger } from '../lib/logger.mjs';
import { listInstalledApplications, mapLimit } from '../services/installed-apps.mjs';

const log = createLogger('access');

/** 应用图标（系统图标，dataURL；失败无图标、退首字 tile）。 */
async function iconOf(appPath) {
  try {
    const image = await app.getFileIcon(appPath, { size: 'normal' });
    return image.isEmpty() ? null : image.toDataURL();
  } catch {
    return null;
  }
}

/** 调用者校验（contracts §4）：必须来自 Hemi 自己的 BrowserWindow 顶层 frame。 */
function isTrustedSender(event) {
  const sender = event?.sender;
  if (!sender || !BrowserWindow.fromWebContents(sender)) return false;
  if (event.senderFrame && sender.mainFrame && event.senderFrame !== sender.mainFrame) return false;
  return true;
}

export function registerAccessIpc() {
  const service = () => getPermissionService({ userDataDir: app.getPath('userData'), log });
  // 043 B2a：应用目录包装器——appRef 由这里签发与复核，渲染层只持引用。
  const catalog = createAppCatalog({
    listInstalled: listInstalledApplications,
    platform: process.platform,
    locale: () => app.getLocale(),
  });
  /** 最近一次应用清单（addApplication 据此回填展示名）。 */
  let lastApplications = [];

  const handle = (channel, fn) => ipcMain.handle(channel, async (event, payload) => {
    if (!isTrustedSender(event)) {
      log.warn(`${channel} 拒绝：调用方不是 Hemi 窗口顶层页面`);
      return { ok: false, errorCode: 'FORBIDDEN' };
    }
    try {
      return await fn(payload && typeof payload === 'object' ? payload : {}, payload, event);
    } catch (error) {
      log.warn(`${channel} 失败：${error?.message ?? error}`);
      return { ok: false, errorCode: 'STORE_UNAVAILABLE', error: String(error?.message ?? error).slice(0, 120) };
    }
  });

  const revisionOf = (value) => (Number.isInteger(value) ? value : undefined);
  const idOf = (value) => (typeof value === 'string' && value.length <= 4200 ? value : '');

  // 读面：payload { taskId }（兼容旧调用直接传字符串）。
  handle(IPC.access.getState, async ({ taskId }, raw) => {
    const id = typeof raw === 'string' ? raw : taskId;
    return service().getState(typeof id === 'string' && id ? id : null);
  });
  // 043 B2a：应用清单 → ApplicationChoice DTO（rowId 选择、appRef 复核、
  // 名称/位置仅展示）。运行中的名字来自驱动，优先于包内读取的名字。
  handle(IPC.access.listApplications, async () => {
    const running = await cua.listAppWindows().catch(() => []);
    const runningNames = new Map(running.filter((a) => a.bundleId).map((a) => [a.bundleId, a]));
    const rows = await catalog.listApplications({ runningNames });
    // 图标按安装位置异步补齐（locationLabel 在 darwin 分支即安装路径）。
    await mapLimit(rows, 8, async (row) => {
      const location = row.source?.locationLabel;
      row.icon = location && location.startsWith('/') ? await iconOf(location) : null;
    });
    lastApplications = rows;
    return rows;
  });
  // 043 B2a：添加应用只认宿主签发的 appRef——主进程复核目录代次与真实
  // OS 身份（bundleId 仍在已安装清单里），过期/伪造引用回专用错误码。
  handle(IPC.access.addApplication, async ({ ref, expectedRevision }) => {
    const appRef = typeof ref?.appRef === 'string' ? ref.appRef : '';
    if (!appRef) return { ok: false, errorCode: 'INVALID_INPUT' };
    const resolved = await catalog.resolveAppRef(appRef, ref?.catalogRevision);
    if (!resolved.ok) {
      log.warn(`access.addApplication 拒绝：${resolved.errorCode}`);
      return { ok: false, errorCode: resolved.errorCode };
    }
    const displayName
      = lastApplications.find((row) => row.ref.appRef === appRef)?.name || resolved.bundleId;
    return service().addApplication({ identityKey: resolved.bundleId, displayName, expectedRevision: revisionOf(expectedRevision) });
  });
  handle(IPC.access.setUiEnabled, async ({ resourceId, enabled, expectedRevision }) => service().setUiEnabled({
    resourceId: idOf(resourceId), enabled: enabled === true, expectedRevision: revisionOf(expectedRevision),
  }));
  handle(IPC.access.removeGrant, async ({ grantId, expectedRevision }) => service().removeGrant({
    grantId: idOf(grantId), expectedRevision: revisionOf(expectedRevision),
  }));
  handle(IPC.access.revokeResource, async ({ resourceId, expectedRevision }) => service().revokeResource({
    resourceId: idOf(resourceId), expectedRevision: revisionOf(expectedRevision),
  }));
  // 保存重试：内存现状（含已生效的失败撤销）整体重新落盘，成功即解锁资源。
  handle(IPC.access.retrySave, async () => service().retrySave());

  // 变更广播：服务状态变化即推给 Hemi 窗口（渲染层收到即重新 get-state）。
  service().onChange((evt) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send(IPC.access.changed, { revision: evt.revision, health: evt.health });
      } catch { /* 窗口可能正在关闭 */ }
    }
  });
}
