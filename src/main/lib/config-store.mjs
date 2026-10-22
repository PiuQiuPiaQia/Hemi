import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { app } from 'electron';
import { secretStorage } from './secret-storage.mjs';
import { hasSupportedSecret } from './local-secrets.mjs';

import { normalizeThinkingFormat, normalizeThinkingLevel } from '../services/thinking-level.mjs';
import { normalizeOpenTarget as normalizeWorkspaceOpenTarget, WORKSPACE_OPEN_TARGETS } from '../services/workspace-open.mjs';
import { getProfiles } from './profiles-holder.mjs';
import { noteActivity } from './perf.mjs';

const DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration';
const DEFAULT_ENDPOINT =
  'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
// TTS 与 ASR 同一把豆包 Key,但 Resource ID 是另一个资源、独立计费(按字符)。
// 实测(2026-09-19):本机 Key 开通的是 2.0 档,默认资源与音色须同档;
// 默认音色为知性灿灿 2.0(豆包 App 同款女声),探针实测可合成。
const DEFAULT_TTS_RESOURCE_ID = 'seed-tts-2.0';
const DEFAULT_TTS_VOICE = 'zh_female_cancan_uranus_bigtts';
const DEFAULT_TTS_ENDPOINT =
  'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
const DEFAULT_TEXT_MODEL_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_TEXT_MODEL_NAME = '';
// 视觉目标裁决（含跨供应商解析）在 services/vision-model.mjs；这里只做
// 存储读取与凭据解析（2026-10-07 起视觉配置以模型目录为唯一来源）。

// 密钥只保留在本进程内存里：未完成本地加密前，绝不清空重读成空串。
let inMemoryApiKey = '';
let inMemoryTextModelApiKey = '';
// 020：browser_act 的 Jev 决策端配置。2026-09-29 用户裁决：供应商改官方
// api.typesafe.ai（D-4「先走 Vercel 网关」被取代）；已存配置不受默认值影响。
// 模型 ID 默认保持全名 typesafe-ai/jev——网关不认短名（020 实测 401）。
const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai';
const DEFAULT_JEV_MODEL = 'typesafe-ai/jev';
let inMemoryJevApiKey = '';

function configFilePath() {
  return path.join(app.getPath('userData'), 'doubao-asr.json');
}

function textModelConfigFilePath() {
  return path.join(app.getPath('userData'), 'text-model.json');
}

async function readTextModelStore() {
  try {
    const raw = await readFile(textModelConfigFilePath(), 'utf8');
    const stored = JSON.parse(raw);
    if (!hasSupportedSecret(secretStorage, stored.encryptedApiKey)) stored.encryptedApiKey = '';
    let apiKey = '';

    if (stored.encryptedApiKey && secretStorage.isEncryptionAvailable()) {
      apiKey = secretStorage.decryptString(
        Buffer.from(stored.encryptedApiKey, 'base64'),
      );
    }

    return {
      apiKey: apiKey || inMemoryTextModelApiKey,
      baseUrl:
        typeof stored.baseUrl === 'string' && stored.baseUrl.trim()
          ? stored.baseUrl.trim()
          : DEFAULT_TEXT_MODEL_BASE_URL,
      model:
        typeof stored.model === 'string' && stored.model.trim()
          ? stored.model.trim()
          : DEFAULT_TEXT_MODEL_NAME,
      // 033：思考强度档位（default＝厂商中档，映射见 services/thinking-level.mjs）
      // 与可选的厂商格式显式覆盖（null＝按 baseUrl 自动探测）。
      thinkingLevel: normalizeThinkingLevel(stored.thinkingLevel),
      thinkingFormat: normalizeThinkingFormat(stored.thinkingFormat),
    };
  } catch {
    return {
      apiKey: inMemoryTextModelApiKey,
      baseUrl: DEFAULT_TEXT_MODEL_BASE_URL,
      model: DEFAULT_TEXT_MODEL_NAME,
      thinkingLevel: 'default',
      thinkingFormat: null,
    };
  }
}

export async function resolveTextModelConfig() {
  const stored = await readTextModelStore();
  // env 直通只认合法档位：写错时不吞掉存储值（回落 default 语义由 stored 承担）。
  const envLevel = normalizeThinkingLevel(process.env.HEMI_LLM_THINKING_LEVEL);
  return {
    apiKey: process.env.HEMI_LLM_API_KEY || stored.apiKey,
    baseUrl: process.env.HEMI_LLM_BASE_URL || stored.baseUrl,
    model: process.env.HEMI_LLM_MODEL || stored.model,
    thinkingLevel:
      process.env.HEMI_LLM_THINKING_LEVEL && envLevel !== 'default'
        ? envLevel
        : stored.thinkingLevel,
    thinkingFormat: stored.thinkingFormat,
  };
}

/**
 * 视觉模型统一出口（任务侧执行会话与看图问答共用）：以模型目录为唯一来源
 * （2026-10-07 起取代旧 doubao-asr.json 视觉字段——那份只有首启引导在写，
 * 模型页的设置到不了这里，两份配置早已分叉）。
 * 056 起读目录的 visionModelKey（设置页「看图模型」单独配置）；返回该模型
 * 所在供应商的端点与 Key 供看图请求直连。
 */
export async function resolveVisionModelConfig() {
  const store = getProfiles();
  const directory = await store.list();
  const none = { supportsVision: false, hasModel: false, model: '', baseUrl: '', apiKey: '', providerId: null, providerName: null };
  // 056（2026-10-14 用户裁决）：看图模型单独配置（目录的 visionModelKey），不再挂在默认模型条目上。
  const key = directory?.visionModelKey ?? null;
  if (!key) return none;
  const full = await store.get(key);
  if (!full?.model) return none;
  return {
    supportsVision: true,
    hasModel: true,
    model: full.model,
    baseUrl: full.baseUrl ?? '',
    api: full.api ?? 'openai-completions',
    ...(full.oauthProvider ? { oauthProvider: full.oauthProvider } : {}),
    apiKey: full.apiKey ?? '',
    providerId: full.providerId ?? null,
    providerName: full.name ?? null,
  };
}

export async function saveTextModelStore(nextConfig) {
  const previous = await readTextModelStore();
  const apiKey =
    typeof nextConfig?.apiKey === 'string' && nextConfig.apiKey.trim()
      ? nextConfig.apiKey.trim()
      : previous.apiKey;

  inMemoryTextModelApiKey = apiKey;

  const stored = {
    baseUrl:
      typeof nextConfig?.baseUrl === 'string' && nextConfig.baseUrl.trim()
        ? nextConfig.baseUrl.trim()
        : previous.baseUrl,
    model:
      typeof nextConfig?.model === 'string' && nextConfig.model.trim()
        ? nextConfig.model.trim()
        : previous.model,
    // 思考强度：快捷拨盘只带这一个字段落库，「非空才覆盖」语义对它同样成立。
    thinkingLevel:
      typeof nextConfig?.thinkingLevel === 'string'
        ? normalizeThinkingLevel(nextConfig.thinkingLevel)
        : previous.thinkingLevel,
    thinkingFormat: normalizeThinkingFormat(nextConfig?.thinkingFormat) ?? previous.thinkingFormat,
    encryptedApiKey:
      apiKey && secretStorage.isEncryptionAvailable()
        ? secretStorage.encryptString(apiKey).toString('base64')
        : '',
  };

  await mkdir(path.dirname(textModelConfigFilePath()), { recursive: true });
  await writeFile(
    textModelConfigFilePath(),
    `${JSON.stringify(stored, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );

  return {
    baseUrl: stored.baseUrl,
    model: stored.model,
    thinkingLevel: stored.thinkingLevel,
    thinkingFormat: stored.thinkingFormat,
    hasApiKey: Boolean(apiKey),
    keyStoredSecurely: Boolean(apiKey && secretStorage.isEncryptionAvailable()),
  };
}

// web 检索 provider 配置（独立小文件，key 存储模式与 text-model 完全一致：
// 应用本地加密落盘 + 进程内存兜底 + 环境变量直通，重装系统/换机不丢明文）。
let inMemoryWebSearchApiKey = '';

function webSearchConfigFilePath() {
  return path.join(app.getPath('userData'), 'web-search.json');
}

async function readWebSearchStore({ decryptSecrets = true } = {}) {
  try {
    const raw = await readFile(webSearchConfigFilePath(), 'utf8');
    const stored = JSON.parse(raw);
    if (!hasSupportedSecret(secretStorage, stored.encryptedApiKey)) stored.encryptedApiKey = '';
    let apiKey = '';
    if (decryptSecrets && stored.encryptedApiKey && secretStorage.isEncryptionAvailable()) {
      apiKey = secretStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64'));
    }
    return {
      apiKey: apiKey || inMemoryWebSearchApiKey,
      encryptedApiKey: stored.encryptedApiKey || '',
      hasApiKey: Boolean(apiKey || inMemoryWebSearchApiKey || (!decryptSecrets && stored.encryptedApiKey)),
      provider:
        typeof stored.provider === 'string' && stored.provider.trim()
          ? stored.provider.trim()
          : 'tavily',
    };
  } catch {
    return { apiKey: inMemoryWebSearchApiKey, encryptedApiKey: '', hasApiKey: Boolean(inMemoryWebSearchApiKey), provider: 'tavily' };
  }
}

/** web 检索统一出口：任务链挂扩展与设置页读写都走它。 */
export async function resolveWebSearchConfig(options) {
  const stored = await readWebSearchStore(options);
  return {
    provider: stored.provider,
    apiKey: stored.apiKey,
    hasApiKey: stored.hasApiKey,
  };
}

/**
 * 020：browser_act 的 Jev 决策端配置（023 起 env 直通移除，配置只来自存储）。
 * enabled 双条件：开关开（D-1 默认开）**且** key 已配置——免 key 不上场
 * （OpenClaw 哲学，同 web 检索），browser_* 兜底不受影响。
 */
export async function resolveJevConfig({ decryptSecrets = true } = {}) {
  const stored = await readStoredConfig({ decryptSecrets });
  const apiKey = stored.jevApiKey || '';
  const hasApiKey = decryptSecrets ? Boolean(apiKey) : stored.hasJevApiKey;
  return {
    enabled: stored.browserActEnabled === true && hasApiKey,
    baseUrl: stored.jevBaseUrl,
    model: stored.jevModel,
    apiKey,
    hasApiKey,
  };
}

export async function saveWebSearchStore(nextConfig) {
  const previous = await readWebSearchStore({ decryptSecrets: false });
  const newApiKey = typeof nextConfig?.apiKey === 'string' ? nextConfig.apiKey.trim() : '';
  // web Key 的空串是显式清除；未传 Key 时原样保留密文，无需先解密。
  const keyProvided = typeof nextConfig?.apiKey === 'string';
  const encryptedApiKey = keyProvided
    ? (newApiKey ? encryptNewApiKey(newApiKey) : '')
    : previous.encryptedApiKey;

  const stored = {
    provider:
      typeof nextConfig?.provider === 'string' && nextConfig.provider.trim()
        ? nextConfig.provider.trim()
        : previous.provider,
    encryptedApiKey,
  };
  await mkdir(path.dirname(webSearchConfigFilePath()), { recursive: true });
  await writeFile(
    webSearchConfigFilePath(),
    `${JSON.stringify(stored, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  if (keyProvided) inMemoryWebSearchApiKey = newApiKey;
  return {
    provider: stored.provider,
    hasApiKey: Boolean(inMemoryWebSearchApiKey || encryptedApiKey),
    keyStoredSecurely: Boolean(encryptedApiKey),
  };
}

function encryptNewApiKey(apiKey) {
  if (!secretStorage.isEncryptionAvailable()) {
    throw new Error('本机暂时无法加密保存密钥（本机存储不可用），请稍后重试。');
  }
  return secretStorage.encryptString(apiKey).toString('base64');
}

// 开发验证脚本使用的应用名称入口；不执行加密或访问任何凭据存储。
export function initializeStableSafeStorageIdentity() {
  app.setName('hemi');
}

function normalizeFloatingPosition(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

// 普通偏好/状态读取不解密。旧格式视为未配置，保留其余设置供用户重新填写；
// 保存非密钥设置直接沿用有效的本地密文。
export async function readStoredConfig({ decryptSecrets = false } = {}) {
  try {
    const raw = await readFile(configFilePath(), 'utf8');
    const stored = JSON.parse(raw);
    for (const field of ['encryptedApiKey', 'jevEncryptedApiKey']) {
      if (!hasSupportedSecret(secretStorage, stored[field])) stored[field] = '';
    }
    let apiKey = '';

    if (decryptSecrets && stored.encryptedApiKey && secretStorage.isEncryptionAvailable()) {
      try {
        apiKey = secretStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64'));
      } catch { /* 密文不可用时保留其余设置。 */ }
    }

    return {
      apiKey: apiKey || inMemoryApiKey,
      encryptedApiKey: stored.encryptedApiKey || '',
      keyStoredSecurely: Boolean(stored.encryptedApiKey),
      hasApiKey: Boolean(apiKey || inMemoryApiKey || (!decryptSecrets && stored.encryptedApiKey)),
      jevEncryptedApiKey: stored.jevEncryptedApiKey || '',
      hasJevApiKey: Boolean(inMemoryJevApiKey || stored.jevEncryptedApiKey),
      resourceId:
        typeof stored.resourceId === 'string' && stored.resourceId
          ? stored.resourceId
          : DEFAULT_RESOURCE_ID,
      endpoint:
        typeof stored.endpoint === 'string' && stored.endpoint
          ? stored.endpoint
          : DEFAULT_ENDPOINT,
      ttsEnabled:
        typeof stored.ttsEnabled === 'boolean' ? stored.ttsEnabled : true,
      ttsVoice:
        typeof stored.ttsVoice === 'string' && stored.ttsVoice
          ? stored.ttsVoice
          : DEFAULT_TTS_VOICE,
      ttsResourceId:
        typeof stored.ttsResourceId === 'string' && stored.ttsResourceId
          ? stored.ttsResourceId
          : DEFAULT_TTS_RESOURCE_ID,
      ttsEndpoint:
        typeof stored.ttsEndpoint === 'string' && stored.ttsEndpoint
          ? stored.ttsEndpoint
          : DEFAULT_TTS_ENDPOINT,
      floatingOrbEnabled:
        typeof stored.floatingOrbEnabled === 'boolean'
          ? stored.floatingOrbEnabled
          : true,
      floatingOrbPosition: normalizeFloatingPosition(
        stored.floatingOrbPosition,
      ),
      // 006：computer use 总开关（R-11 裁决默认开）。看图模型 2026-10-07 起
      // 以模型目录（text-model-profiles.json）为唯一来源，这份配置不再存
      // 视觉字段（旧键残留在文件里不影响读取）。
      computerUseEnabled:
        typeof stored.computerUseEnabled === 'boolean' ? stored.computerUseEnabled : true,
      // 013：仅响应首位说话人（原 D-2 默认关；2026-09-20 用户裁决改默认开，
      // 显式存过 false 的保持关）。
      primarySpeakerEnabled:
        typeof stored.primarySpeakerEnabled === 'boolean' ? stored.primarySpeakerEnabled : true,
      // 014：浏览器操控总开关（D-7：默认关，装好扩展并确认后才开）。
      browserControlEnabled:
        typeof stored.browserControlEnabled === 'boolean' ? stored.browserControlEnabled : false,
      // web 检索总开关（默认关：配了 key 并显式打开，工具面才挂上）。
      webSearchEnabled:
        typeof stored.webSearchEnabled === 'boolean' ? stored.webSearchEnabled : false,
      // 020：browser_act（Jev 步进）。D-1 裁决隐私姿态默认开——开关默认 true，
      // 但免 key 不上场（resolveJevConfig 双条件）；首用明示在设置页文案。
      browserActEnabled:
        typeof stored.browserActEnabled === 'boolean' ? stored.browserActEnabled : true,
      // 022：全局长按 Option 对话（仅 macOS 生效；默认开，未授权时钩子不起）。
      globalPushToTalkEnabled:
        typeof stored.globalPushToTalkEnabled === 'boolean'
          ? stored.globalPushToTalkEnabled
          : true,
      // 043：长按键规范标识（mac 默认 option；Windows 候选键待 WP-04 定案）。
      globalPushToTalkKey:
        typeof stored.globalPushToTalkKey === 'string' && /^[a-z0-9-]{1,32}$/.test(stored.globalPushToTalkKey)
          ? stored.globalPushToTalkKey
          : process.platform === 'darwin'
            ? 'option'
            : '',
      // 2026-09-26：执行器终端命令走系统代理（默认关——直连正常就不用开；
      // 下载慢时用户在输入工具行勾选，git/curl 等子进程读 env 生效）。
      executorProxyEnabled:
        typeof stored.executorProxyEnabled === 'boolean'
          ? stored.executorProxyEnabled
          : false,
      // 032：任务收尾记忆摘要开关（pi-memory 退出摘要；默认开）。
      memoryExitSummaryEnabled:
        typeof stored.memoryExitSummaryEnabled === 'boolean'
          ? stored.memoryExitSummaryEnabled
          : true,
      jevBaseUrl:
        typeof stored.jevBaseUrl === 'string' && stored.jevBaseUrl.trim()
          ? stored.jevBaseUrl.trim()
          : DEFAULT_JEV_BASE_URL,
      jevModel:
        typeof stored.jevModel === 'string' && stored.jevModel.trim()
          ? stored.jevModel.trim()
          : DEFAULT_JEV_MODEL,
      jevApiKey: (() => {
        if (decryptSecrets && stored.jevEncryptedApiKey && secretStorage.isEncryptionAvailable()) {
          try {
            return secretStorage.decryptString(
              Buffer.from(stored.jevEncryptedApiKey, 'base64'),
            );
          } catch {
            /* 解密失败当未配置 */
          }
        }
        return inMemoryJevApiKey;
      })(),
      // 066：顶栏打开方式的默认 target（finder/terminal/vscode；坏值回落 finder）。
      workspaceOpenTarget: normalizeWorkspaceOpenTarget(stored.workspaceOpenTarget),
    };
  } catch {
    return {
      apiKey: inMemoryApiKey,
      encryptedApiKey: '',
      keyStoredSecurely: false,
      hasApiKey: Boolean(inMemoryApiKey),
      jevEncryptedApiKey: '',
      hasJevApiKey: Boolean(inMemoryJevApiKey),
      resourceId: DEFAULT_RESOURCE_ID,
      endpoint: DEFAULT_ENDPOINT,
      ttsEnabled: true,
      ttsVoice: DEFAULT_TTS_VOICE,
      ttsResourceId: DEFAULT_TTS_RESOURCE_ID,
      ttsEndpoint: DEFAULT_TTS_ENDPOINT,
      floatingOrbEnabled: true,
      floatingOrbPosition: null,
      computerUseEnabled: true,
      primarySpeakerEnabled: true,
      browserControlEnabled: false,
      webSearchEnabled: false,
      browserActEnabled: true,
      globalPushToTalkEnabled: true,
      globalPushToTalkKey: process.platform === 'darwin' ? 'option' : '',
      executorProxyEnabled: false,
      memoryExitSummaryEnabled: true,
      jevBaseUrl: DEFAULT_JEV_BASE_URL,
      jevModel: DEFAULT_JEV_MODEL,
      jevApiKey: inMemoryJevApiKey,
      workspaceOpenTarget: 'finder',
    };
  }
}

export async function resolveConfig({ decryptSecrets = true } = {}) {
  const stored = await readStoredConfig({ decryptSecrets });

  return {
    apiKey: process.env.DOUBAO_API_KEY || stored.apiKey,
    hasApiKey: Boolean(process.env.DOUBAO_API_KEY || stored.hasApiKey),
    keyStoredSecurely: stored.keyStoredSecurely,
    resourceId: process.env.DOUBAO_RESOURCE_ID || stored.resourceId,
    endpoint: process.env.DOUBAO_ASR_ENDPOINT || stored.endpoint,
    ttsEnabled: stored.ttsEnabled,
    ttsVoice: stored.ttsVoice,
    ttsResourceId:
      process.env.DOUBAO_TTS_RESOURCE_ID || stored.ttsResourceId,
    ttsEndpoint: process.env.DOUBAO_TTS_ENDPOINT || stored.ttsEndpoint,
  };
}

export async function saveStoredConfig(nextConfig) {
  noteActivity('stored-config-save');
  const previous = await readStoredConfig();
  const newApiKey = typeof nextConfig.apiKey === 'string' ? nextConfig.apiKey.trim() : '';
  const newJevApiKey = typeof nextConfig.jevApiKey === 'string' ? nextConfig.jevApiKey.trim() : '';
  const encryptedApiKey = newApiKey ? encryptNewApiKey(newApiKey) : previous.encryptedApiKey;
  const jevEncryptedApiKey = newJevApiKey ? encryptNewApiKey(newJevApiKey) : previous.jevEncryptedApiKey;

  const stored = {
    resourceId:
      typeof nextConfig.resourceId === 'string' && nextConfig.resourceId.trim()
        ? nextConfig.resourceId.trim()
        : previous.resourceId,
    endpoint:
      typeof nextConfig.endpoint === 'string' && nextConfig.endpoint.trim()
        ? nextConfig.endpoint.trim()
        : previous.endpoint,
    ttsEnabled:
      typeof nextConfig.ttsEnabled === 'boolean'
        ? nextConfig.ttsEnabled
        : previous.ttsEnabled,
    ttsVoice:
      typeof nextConfig.ttsVoice === 'string' && nextConfig.ttsVoice.trim()
        ? nextConfig.ttsVoice.trim()
        : previous.ttsVoice,
    ttsResourceId:
      typeof nextConfig.ttsResourceId === 'string' && nextConfig.ttsResourceId.trim()
        ? nextConfig.ttsResourceId.trim()
        : previous.ttsResourceId,
    ttsEndpoint:
      typeof nextConfig.ttsEndpoint === 'string' && nextConfig.ttsEndpoint.trim()
        ? nextConfig.ttsEndpoint.trim()
        : previous.ttsEndpoint,
    floatingOrbEnabled:
      typeof nextConfig.floatingOrbEnabled === 'boolean'
        ? nextConfig.floatingOrbEnabled
        : previous.floatingOrbEnabled,
    floatingOrbPosition:
      normalizeFloatingPosition(nextConfig.floatingOrbPosition) ??
      previous.floatingOrbPosition,
    // 005：白名单走「合并 + 删指定 id」两值约定——数组为整体替换（已去重），
    // removeAllowEntryIds 指明本轮要剔除的条目；两者都缺省时保持原值。
    // 006：computer use 开关。看图模型配置不在本份存储（2026-10-07 起以
    // 模型目录为唯一来源，见 resolveVisionModelConfig）。
    computerUseEnabled:
      typeof nextConfig.computerUseEnabled === 'boolean'
        ? nextConfig.computerUseEnabled
        : previous.computerUseEnabled,
    // 013：仅响应首位说话人开关。
    primarySpeakerEnabled:
      typeof nextConfig.primarySpeakerEnabled === 'boolean'
        ? nextConfig.primarySpeakerEnabled
        : previous.primarySpeakerEnabled,
    // 014：浏览器操控开关。
    browserControlEnabled:
      typeof nextConfig.browserControlEnabled === 'boolean'
        ? nextConfig.browserControlEnabled
        : previous.browserControlEnabled,
    // web 检索开关。
    webSearchEnabled:
      typeof nextConfig.webSearchEnabled === 'boolean'
        ? nextConfig.webSearchEnabled
        : previous.webSearchEnabled,
    // 020：browser_act 开关与 Jev 端点（key 未给时保留旧值，同 text-model 约定）。
    browserActEnabled:
      typeof nextConfig.browserActEnabled === 'boolean'
        ? nextConfig.browserActEnabled
        : previous.browserActEnabled,
    // 022：全局长按 Option 对话开关。
    globalPushToTalkEnabled:
      typeof nextConfig.globalPushToTalkEnabled === 'boolean'
        ? nextConfig.globalPushToTalkEnabled
        : previous.globalPushToTalkEnabled,
    // 043：长按键规范标识（写入前经 global-push-to-talk 校验，这里兜底格式）。
    globalPushToTalkKey:
      typeof nextConfig.globalPushToTalkKey === 'string' && /^[a-z0-9-]{1,32}$/.test(nextConfig.globalPushToTalkKey)
        ? nextConfig.globalPushToTalkKey
        : previous.globalPushToTalkKey,
    // 执行器终端命令代理开关（见 shell-proxy.mjs）。
    executorProxyEnabled:
      typeof nextConfig.executorProxyEnabled === 'boolean'
        ? nextConfig.executorProxyEnabled
        : previous.executorProxyEnabled,
    // 032：任务收尾记忆摘要开关（见 memory.ipc）。
    memoryExitSummaryEnabled:
      typeof nextConfig.memoryExitSummaryEnabled === 'boolean'
        ? nextConfig.memoryExitSummaryEnabled
        : previous.memoryExitSummaryEnabled,
    jevBaseUrl:
      typeof nextConfig.jevBaseUrl === 'string' && nextConfig.jevBaseUrl.trim()
        ? nextConfig.jevBaseUrl.trim()
        : previous.jevBaseUrl,
    jevModel:
      typeof nextConfig.jevModel === 'string' && nextConfig.jevModel.trim()
        ? nextConfig.jevModel.trim()
        : previous.jevModel,
    jevEncryptedApiKey,
    encryptedApiKey,
    // 066：顶栏打开方式默认 target（未知值不写，保持旧值）。
    workspaceOpenTarget: WORKSPACE_OPEN_TARGETS.includes(nextConfig.workspaceOpenTarget)
      ? nextConfig.workspaceOpenTarget
      : previous.workspaceOpenTarget,
  };

  await mkdir(path.dirname(configFilePath()), { recursive: true });
  await writeFile(configFilePath(), `${JSON.stringify(stored, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (newApiKey) inMemoryApiKey = newApiKey;
  if (newJevApiKey) inMemoryJevApiKey = newJevApiKey;

  return {
    resourceId: stored.resourceId,
    endpoint: stored.endpoint,
    ttsEnabled: stored.ttsEnabled,
    ttsVoice: stored.ttsVoice,
    ttsResourceId: stored.ttsResourceId,
    ttsEndpoint: stored.ttsEndpoint,
    hasApiKey: Boolean(encryptedApiKey || inMemoryApiKey),
    keyStoredSecurely: Boolean(encryptedApiKey),
    floatingOrbEnabled: stored.floatingOrbEnabled,
    computerUseEnabled: stored.computerUseEnabled,
    primarySpeakerEnabled: stored.primarySpeakerEnabled,
    browserControlEnabled: stored.browserControlEnabled,
    webSearchEnabled: stored.webSearchEnabled,
    executorProxyEnabled: stored.executorProxyEnabled,
    memoryExitSummaryEnabled: stored.memoryExitSummaryEnabled,
  };
}
