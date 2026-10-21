import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ipcMain, safeStorage, app } from 'electron';

import { createOnboardingStore } from '../lib/onboarding-state.mjs';
import { createLogger } from '../lib/logger.mjs';
import { parseModelKey } from '../lib/model-profiles.mjs';
import { getProfiles } from './llm.ipc.mjs';
import { IPC } from '../../shared/ipc-channels.mjs';

/**
 * 032 冷启动引导 IPC：主进程是引导进度的唯一权威，渲染层只拿快照与
 * 提交前进/完成意图。模型完整性按真实存储判定；语音配置只报告状态：
 * - 可选语音：doubao-asr.json 有可解密的密文 Key（环境变量/内存态不算）；
 * - 必需模型：目录默认组的接口地址、型号、加密保存的 Key 完整。
 */

const onboardingLog = createLogger('onboarding');

/** 完成后的恢复钩子（index.mjs 注入：重启语音入口/悬浮球）。 */
let onCompletedHook = null;

function onboardingFilePath() {
  return path.join(app.getPath('userData'), 'onboarding.json');
}

/** 语音服务密钥是否已**持久**保存（可解密的密文）。 */
async function hasPersistedAsrKey() {
  try {
    const raw = JSON.parse(
      await readFile(path.join(app.getPath('userData'), 'doubao-asr.json'), 'utf8'),
    );
    if (typeof raw?.encryptedApiKey !== 'string' || !raw.encryptedApiKey) return false;
    if (!safeStorage.isEncryptionAvailable()) return false;
    try {
      return safeStorage.decryptString(Buffer.from(raw.encryptedApiKey, 'base64')).length > 0;
    } catch {
      return false; // 密文解不开（换机/钥匙串变化）：不算已保存
    }
  } catch {
    return false;
  }
}

/** 默认模型组是否字段完整且 Key 已加密保存（环境覆盖不参与判定）。 */
async function defaultModelComplete() {
  const directory = await getProfiles().list();
  if (!directory?.defaultModelId || directory.corrupt) return false;
  const parsed = parseModelKey(directory.defaultModelId);
  if (!parsed) return false;
  const provider = directory.providers.find((item) => item.id === parsed.providerId);
  if (!provider) return false;
  const model = provider.models.find((item) => item.id === parsed.modelId);
  if (!model) return false;
  return Boolean(provider.baseUrl.trim() && model.model.trim() && provider.keyStoredSecurely);
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

  ipcMain.handle(IPC.onboarding.complete, async () => {
    const before = store.isInProgress();
    const result = await store.complete();
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
