import { runtimeDataDir } from '../agent-runtime/storage-migration.mjs';
// 031 模型配置目录的唯一实例。
//
// 原先 profiles 实例只在 llm.ipc 里创建（目录读写都走它）；2026-10-07 起
// 视觉裁决（config-store.resolveVisionModelConfig）也要读目录——跨供应商
// 看图模型要解析目标供应商的端点与 Key。实例提到这里共享，保证全进程
// 同一份目录、同一条串行写队列，不会出现第二份各读各的。
import path from 'node:path';
import { app } from 'electron';
import { secretStorage } from './secret-storage.mjs';

import { createLogger } from './logger.mjs';
import { createProfileStore } from './model-profiles.mjs';
import { createOAuthCredentials } from '../services/oauth-credentials.mjs';
import { createOAuthModels, setOAuthRuntime } from '../services/oauth-models.mjs';

let profiles = null;
let oauth = null;

export function getOAuthRuntime() {
  if (!oauth) {
    const credentials = createOAuthCredentials({ filePath: path.join(runtimeDataDir(app.getPath('userData')), 'oauth-credentials.json'), safeStorage: secretStorage });
    oauth = { ...createOAuthModels(credentials), credentials };
    setOAuthRuntime(oauth);
  }
  return oauth;
}

export function getProfiles() {
  if (!profiles) {
    profiles = createProfileStore({
      filePath: path.join(runtimeDataDir(app.getPath('userData')), 'text-model-profiles.json'),
      safeStorage: secretStorage,
      oauth: getOAuthRuntime(),
      log: createLogger('llm'),
    });
  }
  return profiles;
}
