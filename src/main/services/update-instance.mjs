/**
 * 044 · 更新服务单例：主进程唯一的 electron-updater 句柄。
 * 首次取用时初始化；未打包实例也建（状态面回 supported=false，
 * 更新器懒启动，dev 下零开销）。
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
  });
  return instance;
}

/** 测试隔离。 */
export function resetUpdaterServiceForTests() {
  instance = null;
}
