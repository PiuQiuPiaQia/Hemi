/**
 * 044 · 更新服务单例：主进程唯一实例（回环 HTTP 桥 + electron-updater 句柄
 * 都不能多份）。首次取用时初始化；未打包实例也建（状态面回 supported=false，
 * 桥与更新器懒启动，dev 下零开销）。
 */
import { app } from 'electron';

import { createLogger } from '../lib/logger.mjs';
import { createUpdaterService } from './updater.mjs';

let instance = null;

export function getUpdaterService() {
  if (instance) return instance;
  instance = createUpdaterService({
    app,
    log: createLogger('updater'),
    resourcesPath: process.resourcesPath,
  });
  return instance;
}

/** 退出收尾：关分发桥（幂等，未启动过为 no-op）。 */
export async function disposeUpdaterService() {
  if (!instance) return;
  await instance.dispose();
}

/** 测试隔离。 */
export function resetUpdaterServiceForTests() {
  instance = null;
}
