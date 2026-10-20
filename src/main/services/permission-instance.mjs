/**
 * 042 · 应用级权限服务单例：access-grants.json 落 userData，主进程唯一实例。
 * 首次调用即惰性初始化（异步 load 不阻塞调用方——初始化完成前授权表为空，
 * 行为＝未授权，安全侧）。任务适配器（task.ipc makePiAdapter）与 access IPC 共用。
 */
import path from 'node:path';

import { createPermissionService } from './permission-service.mjs';

let instance = null;

export function getPermissionService({ userDataDir, log = null } = {}) {
  if (instance) return instance;
  if (!userDataDir || typeof userDataDir !== 'string') {
    throw new Error('getPermissionService 需要有效的 userDataDir（首次初始化）');
  }
  instance = createPermissionService({ dir: userDataDir, nowFn: Date.now });
  void instance.load().catch((error) => {
    log?.warn?.(`权限服务初始化失败：${error?.message ?? error}`);
  });
  return instance;
}

/** 测试隔离：换目录重建。 */
export function resetPermissionServiceForTests() {
  instance = null;
}
