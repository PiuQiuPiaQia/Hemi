import path from 'node:path';

import { ipcMain, app } from 'electron';

import { createOnboardingStore } from '../lib/onboarding-state.mjs';
import { readStoredConfig } from '../lib/config-store.mjs';
import { createLogger } from '../lib/logger.mjs';
import { getProfiles } from './llm.ipc.mjs';
import { IPC } from '../../shared/ipc-channels.mjs';

/**
 * 032 冷启动引导 IPC：主进程是引导进度的唯一权威，渲染层只拿快照与
 * 提交前进/完成意图。模型完整性按真实存储判定；语音配置只报告状态：
 * - 可选语音：doubao-asr.json 有已保存的密文 Key（环境变量/内存态不算）；
 * - 必需模型：存在有 Key 的供应商且角色路由主槽位指向有效模型（2026-11）。
 */

const onboardingLog = createLogger('onboarding');

/** 完成后的恢复钩子（index.mjs 注入：重启语音入口/悬浮球）。 */
let onCompletedHook = null;

function onboardingFilePath() {
  return path.join(app.getPath('userData'), 'onboarding.json');
}

/** 状态查询只看已持久保存的密文；实际连接时再验证解密与服务凭据。 */
async function hasPersistedAsrKey() {
  return (await readStoredConfig()).keyStoredSecurely;
}

/**
 * 就绪判定（2026-11 用户裁决）：存在有 Key 的供应商 且 角色路由主槽位（main）
 * 指向有效模型——引导完成后写 roleModels.main，首启门槛随之从「默认组完整」
 * 改为「主槽位可用」（环境覆盖不参与判定）。
 */
async function defaultModelComplete() {
  const directory = await getProfiles().list();
  if (!directory || directory.corrupt) return false;
  if (!directory.providers.some((provider) => provider.keyStoredSecurely)) return false;
  const main = directory.roleModels?.main;
  if (!main) return false;
  return directory.providers.some((provider) =>
    provider.models.some((model) => model.modelKey === main && model.model.trim()));
}

const store = createOnboardingStore({
  // 惰性取路径：本模块在 app.setPath('userData') 之前就被 import，
  // 提前固化会写到错误的默认目录（真机走查 2026-09-30 实录）。
  filePath: onboardingFilePath,
  hasPersistedAsrKey,
  defaultModelComplete,
  log: onboardingLog,
});

async function afterCompletion() {
  try {
    await onCompletedHook?.();
  } catch (error) {
    onboardingLog.warn(`引导完成后的恢复钩子失败：${error?.message ?? error}`);
  }
}

export function registerOnboardingIpc() {
  ipcMain.handle(IPC.onboarding.getState, () => store.getState());

  ipcMain.handle(IPC.onboarding.advance, async (_event, payload) => {
    const result = await store.advance({
      to: typeof payload?.to === 'string' ? payload.to : '',
      permissionChoice: typeof payload?.permissionChoice === 'string' ? payload.permissionChoice : undefined,
    });
    return result;
  });

  ipcMain.handle(IPC.onboarding.complete, async (_event, payload) => {
    const before = store.isInProgress();
    const result = await store.complete({ force: payload?.force === true });
    if (result.ok && before) await afterCompletion();
    return result;
  });
}

/** index.mjs 启动时先初始化一次：完成迁移判定后再建窗口（渲染层首帧即知首启/主界面）。 */
export function ensureOnboardingInitialized() {
  return store.ensureInitialized();
}

/** 悬浮球/全局快捷键的门控：进行中抑制；未初始化按进行中保守处理。 */
export function isOnboardingInProgress() {
  return store.isInProgress();
}

/** 注入完成钩子（index.mjs：恢复全局 Option 与悬浮球可见性）。 */
export function setOnboardingCompletedHook(fn) {
  onCompletedHook = typeof fn === 'function' ? fn : null;
}
