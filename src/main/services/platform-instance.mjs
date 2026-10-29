/**
 * 043 B1 · 平台能力服务单例：主进程唯一实例，注册期惰性初始化。
 * electron（systemPreferences）、config-store、全局钩子运行态在这里接入
 * 平台工厂——保持 factory 可离线单测。渲染层快照订阅与旧 permissions IPC
 * 都从本实例投影（不留第二套状态判断）。
 */
import { shell, systemPreferences } from 'electron';

import { createPlatformService } from '../platform/index.mjs';
import { readStoredConfig } from '../lib/config-store.mjs';
import {
  getGlobalPushToTalkStartError,
  isGlobalPushToTalkListening,
  isGlobalPushToTalkRunning,
} from '../lib/global-push-to-talk.mjs';

import { createLogger } from '../lib/logger.mjs';
import { cua } from '../agent/gate/cua-client.mjs';
import { windowsDesktopApps } from './installed-apps.mjs';
import { createWindowsDesktopProbes } from '../platform/windows-desktop-probe.mjs';

const windowsProbes = process.platform === 'win32'
  ? createWindowsDesktopProbes({ apps: windowsDesktopApps, cua, report: (message) => createLogger('platform-desktop').info(message) }) : null;
let instance = null;
/** 能力变化广播（platform.ipc 注册时挂上；未挂时变化只进状态不广播）。 */
let notifyTarget = null;

export function getPlatformService() {
  if (instance) return instance;
  instance = createPlatformService({
    platform: process.platform,
    notify: (snapshot) => notifyTarget?.(snapshot),
    deps: {
      ...(windowsProbes ? { probeDesktop: windowsProbes.desktop, probeAppCatalog: windowsProbes.appCatalog } : {}),
      getMediaAccessStatus: (mediaType) => systemPreferences.getMediaAccessStatus(mediaType),
      askForMediaAccess: (mediaType) => systemPreferences.askForMediaAccess(mediaType),
      // 024 冒烟约定（permissions.ipc 同款）：dev 二进制没有麦克风用途声明，
      // TCC 弹窗出不来；HEMI_TEST_MIC_GRANT=1 只影响状态查询，不碰采集链路。
      micTestOverride: () =>
        process.platform === 'darwin' && process.env.HEMI_TEST_MIC_GRANT === '1',
      pushToTalkRunning: isGlobalPushToTalkRunning,
      pushToTalkListening: isGlobalPushToTalkListening,
      pushToTalkStartError: getGlobalPushToTalkStartError,
    },
    enabledIntents: {},
  });
  return instance;
}

/** 快照的 enabled 投影存储意图：注册后异步刷一次（读配置不阻塞启动）。 */
export async function refreshPlatformEnabledIntents() {
  if (!instance) return;
  try {
    const stored = await readStoredConfig();
    instance.setEnabled('pushToTalk', stored.globalPushToTalkEnabled === true);
  } catch {
    // 读不到配置保持现状（收紧语义），不阻塞快照。
  }
}

/** platform.ipc 注册时挂广播回调（对全部 Hemi 窗口 send）。 */
export function setPlatformNotify(fn) {
  notifyTarget = typeof fn === 'function' ? fn : null;
}

/** 固定动作映射：主进程执行，renderer 不传 URI/命令（contracts §能力状态）。 */export async function performPlatformAction(action, capability) {
  switch (action) {
    case 'open-microphone-settings': {
      const url = process.platform === 'win32'
        ? 'ms-settings:privacy-microphone'
        : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
      await shell.openExternal(url);
      // 打开系统设置≠已授权：返回后由 recheck / 返回页重探测确认。
      await instance?.recheck(capability);
      return { ok: true };
    }
    case 'recheck': {
      if (!instance) return { ok: false, error: '平台服务未就绪' };
      await instance.recheck(capability);
      return { ok: true };
    }
    default:
      return { ok: false, error: `不支持的动作：${String(action)}` };
  }
}

/** 测试隔离。 */
export function resetPlatformServiceForTests() {
  instance = null;
}
