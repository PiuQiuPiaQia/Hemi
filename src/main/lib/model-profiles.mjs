// 031 多组模型配置：供应商（端点+Key）下挂多个模型的目录、迁移与回合解析。
//
// 2026-09-30 用户裁决（参照 ZCode／DSH ProviderEditor）：一个供应商配置多个
// 模型——endpoint 与 Key 属于供应商，型号/思考强度/视觉能力属于模型；会话
// 选择与默认值都落在「模型键」（providerId/modelId）上。
//
// 其余纪律：Key 只存注入的加密存储密文（不可用时仅进程内存）、渲染层只拿视图；
// 损坏目录只读回落；删除含默认模型的供应商必须显式给替代模型；
// HEMI_LLM_* 环境覆盖最高且如实标记。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AUTO_SELECTION_ID } from './model-routing.mjs';
import { normalizeThinkingFormat, normalizeThinkingLevel } from '../services/thinking-level.mjs';
import { noteActivity } from './perf.mjs';
import { hasSupportedSecret } from './local-secrets.mjs';
import { isOAuthProvider, OAUTH_PROVIDERS } from '../services/oauth-models.mjs';

/** 047：目录 schema 3＝2 ＋顶层 importReceipts（导入提交事实，普通读写显式保留）。 */
export const PROFILES_VERSION = 3;
/** 无目录/损坏目录时的只读占位身份。 */
const PLACEHOLDER_PROVIDER_ID = 'mp-unconfigured';
const PLACEHOLDER_PROVIDER_NAME = '未配置';

/** 047：导入回执归一化（只认我们写出的形状；坏条目丢弃）。 */
function normalizeImportReceipt(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { operationId, planHash, committedAt } = raw;
  if (typeof operationId !== 'string' || !operationId || typeof planHash !== 'string' || !planHash) return null;
  const providerIds = (Array.isArray(raw.providerIds) ? raw.providerIds : []).filter((id) => typeof id === 'string');
  const modelKeys = (Array.isArray(raw.modelKeys) ? raw.modelKeys : []).filter((key) => typeof key === 'string');
  if (!providerIds.length || !modelKeys.length) return null;
  return { operationId, planHash, providerIds, modelKeys, committedAt: Number.isFinite(committedAt) ? committedAt : Date.now() };
}

function normalizeImportReceipts(raw) {
  const list = (Array.isArray(raw) ? raw : []).map(normalizeImportReceipt).filter(Boolean);
  const seen = new Set();
  return list.filter((receipt) => {
    if (seen.has(receipt.operationId)) return false;
    seen.add(receipt.operationId);
    return true;
  });
}

const ENV_KEYS = ['HEMI_LLM_API_KEY', 'HEMI_LLM_BASE_URL', 'HEMI_LLM_MODEL', 'HEMI_LLM_THINKING_LEVEL'];

export function envOverrideActive(env = process.env) {
  return ENV_KEYS.some((key) => Boolean(env[key]));
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 模型条目归一化（型号 ID／思考档／视觉字段）。 */
function normalizeModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : '';
  if (!id && !model) return null;
  return {
    id: id ?? newId('m'),
    model,
    thinkingLevel: normalizeThinkingLevel(raw.thinkingLevel),
    thinkingFormat: normalizeThinkingFormat(raw.thinkingFormat) ?? null,
    supportsVision: raw.supportsVision === true,
    visionModel: typeof raw.visionModel === 'string' && raw.visionModel.trim() ? raw.visionModel.trim() : '',
  };
}

/** 046：供应商线协议（openai-completions＝OpenAI 兼容；anthropic-messages＝Anthropic 原生）。 */
export const PROVIDER_APIS = ['openai-completions', 'anthropic-messages', 'openai-responses'];

/** 非法/缺省回落 openai-completions（存量目录无此字段，行为不变）。 */
export function normalizeProviderApi(value) {
  return PROVIDER_APIS.includes(value) ? value : 'openai-completions';
}

/** 供应商归一化（端点＋Key＋协议＋模型列表；不收明文/密文以外的 Key 形态——存取路径处理）。 */
export function normalizeProvider(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  if (!id) return null;
  const models = (Array.isArray(raw.models) ? raw.models : [])
    .map(normalizeModel)
    .filter(Boolean);
  if (!models.length) return null;
  const seen = new Set();
  const uniqueModels = models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
  return {
    id,
    name: (typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '').slice(0, 40) || '未命名供应商',
    baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl.trim() : '',
    api: normalizeProviderApi(raw.api),
    ...(isOAuthProvider(raw.oauthProvider) ? { oauthProvider: raw.oauthProvider } : {}),
    encryptedApiKey: typeof raw.encryptedApiKey === 'string' ? raw.encryptedApiKey : '',
    models: uniqueModels,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

/** 目录归一化；defaultModelId 无效时回落首个模型键。 */
export function normalizeDirectory(raw) {
  const providers = (Array.isArray(raw?.providers) ? raw.providers : [])
    .map(normalizeProvider)
    .filter(Boolean);
  if (!providers.length) return null;
  const seen = new Set();
  const unique = [];
  for (const provider of providers) {
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    unique.push(provider);
  }
  const allKeys = unique.flatMap((provider) => provider.models.map((model) => `${provider.id}/${model.id}`));
  const defaultModelId = allKeys.includes(raw.defaultModelId) ? raw.defaultModelId : allKeys[0];
  // 056：角色模型原样保留（失效引用不改指默认；有效性在解析时判定）。
  const roleModels = normalizeRoleModels(raw.roleModels, raw.autoRouting);
  // 047：导入回执随目录归一化保留（version 2 文件缺省为空，旧模型/Key 不改）。
  const importReceipts = normalizeImportReceipts(raw.importReceipts);
  // 056：全局看图模型（模型键；2026-10-14 用户裁决单独配置）。旧档没有该字段时从默认
  // 模型条目迁：默认模型自己能看图＝看图用它；条目上挂了看图模型键＝用那个。
  const visionModelKey = normalizeVisionModelKey(raw, unique, allKeys, defaultModelId);
  // 2026-10-08：上次主脑模型选择（模型键或 'auto'）。引用失效即丢弃——新建
  // 对话回落默认模型，不静默改指别的模型。
  const lastConversationModelKey =
    raw.lastConversationModelKey === AUTO_SELECTION_ID || allKeys.includes(raw.lastConversationModelKey)
      ? raw.lastConversationModelKey
      : null;
  return {
    version: PROFILES_VERSION,
    defaultModelId,
    ...(lastConversationModelKey ? { lastConversationModelKey } : {}),
    ...(roleModels ? { roleModels } : {}),
    visionModelKey,
    ...(importReceipts.length ? { importReceipts } : {}),
    providers: unique,
  };
}

/** 056：全局看图模型归一化（含旧档迁移；引用失效即丢弃，不改指别的模型）。 */
function normalizeVisionModelKey(raw, providers, allKeys, defaultModelId) {
  if (Object.prototype.hasOwnProperty.call(raw ?? {}, 'visionModelKey')) {
    return typeof raw.visionModelKey === 'string' && allKeys.includes(raw.visionModelKey) ? raw.visionModelKey : null;
  }
  for (const provider of providers) {
    for (const model of provider.models) {
      if (`${provider.id}/${model.id}` !== defaultModelId) continue;
      if (model.supportsVision) return defaultModelId;
      if (model.visionModel && allKeys.includes(model.visionModel)) return model.visionModel;
      // 旧口径的同供应商裸型号名：按型号名找回模型键。
      const sameName = provider.models.find((entry) => entry.model === model.visionModel);
      return sameName ? `${provider.id}/${sameName.id}` : null;
    }
  }
  return null;
}

/** 模型键解析：`providerId/modelId` → { provider, model } | null。 */
export function parseModelKey(modelKey) {
  const text = String(modelKey ?? '');
  const separator = text.indexOf('/');
  if (separator <= 0) return null;
  return { providerId: text.slice(0, separator), modelId: text.slice(separator + 1) };
}

/** 038/055：自动路由角色键归一；055 R-11 起另收执行档位映射（fast/standard/deep）。
 *  角色与档位字段只能是 modelKey 字符串或 null；其余丢弃（旧文件缺字段＝未配置）。 */
/**
 * 056：角色路由槽位——main（自动模式下主 agent 用的模型，必填才能选「自动」）、四个子 agent
 * 角色（null＝跟随 main）、fallback（备用，两种模式都生效）。值＝modelKey 或 null。
 */
export const ROLE_MODEL_SLOTS = ['main', 'explorer', 'oracle', 'fixer', 'designer', 'fallback'];

/**
 * 056：角色路由归一化（取代 038 的 autoRouting {chat, execution, fallback}）。
 * 旧档迁移：chatModelKey（主脑模型）→ main，fallbackModelKey → fallback；executionModelKey
 * 随「手」一起退役（子 agent 角色没配时跟随 main）。
 */
export function normalizeRoleModels(raw, legacyAutoRouting = null) {
  const pick = (value) => {
    if (value == null) return null;
    return parseModelKey(value) ? String(value) : null;
  };
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const slot of ROLE_MODEL_SLOTS) {
    const value = pick(source[slot]);
    if (value) out[slot] = value;
  }
  if (legacyAutoRouting && typeof legacyAutoRouting === 'object') {
    const legacyMain = pick(legacyAutoRouting.chatModelKey);
    const legacyFallback = pick(legacyAutoRouting.fallbackModelKey);
    if (!out.main && legacyMain) out.main = legacyMain;
    if (!out.fallback && legacyFallback) out.fallback = legacyFallback;
  }
  return Object.keys(out).length ? out : null;
}

/** 供应商 → 渲染层视图（无 Key 材料；模型条目带 modelKey）。 */
export function providerView(provider) {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: provider.api ?? 'openai-completions',
    ...(provider.oauthProvider ? { oauthProvider: provider.oauthProvider } : {}),
    hasApiKey: Boolean(provider.encryptedApiKey),
    keyStoredSecurely: Boolean(provider.encryptedApiKey),
    updatedAt: provider.updatedAt,
    models: provider.models.map((model) => ({
      id: model.id,
      modelKey: `${provider.id}/${model.id}`,
      model: model.model,
      thinkingLevel: model.thinkingLevel,
      supportsVision: model.supportsVision,
      visionModel: model.visionModel,
    })),
  };
}

/**
 * 目录工厂（依赖全注入，离线可测）。
 * @param {object} deps（filePath、fs、safeStorage、env、log）
 */
export function createProfileStore({
  filePath,
  readFile: readFileImpl = readFile,
  writeFile: writeFileImpl = writeFile,
  rename: renameImpl = rename,
  mkdir: mkdirImpl = mkdir,
  safeStorage = null,
  env = process.env,
  log = null,
  oauth = null,
} = {}) {
  let directory = null;
  let corrupt = false;

  const canEncrypt = () => Boolean(safeStorage?.isEncryptionAvailable?.());

  async function providerHasStoredKey(provider) {
    if (!provider.oauthProvider) return Boolean(provider.encryptedApiKey);
    // 账号连接也只读取存档索引；设置/启动状态查询不解密 token。
    if (oauth?.credentials?.list) {
      const entries = await oauth.credentials.list();
      return entries.some(entry => entry.providerId === provider.oauthProvider);
    }
    return Boolean(await oauth?.connected(provider.oauthProvider));
  }

  function apiFor(provider, model) {
    return (provider.oauthProvider ? oauth?.models?.getModel?.(provider.oauthProvider, model.model)?.api : null) ?? provider.api ?? 'openai-completions';
  }

  async function providerApiKey(provider) {
    if (provider.oauthProvider) return await oauth?.connected(provider.oauthProvider) ? 'oauth' : '';
    if (provider.encryptedApiKey && canEncrypt()) {
      try {
        return safeStorage.decryptString(Buffer.from(provider.encryptedApiKey, 'base64'));
      } catch {
        return '';
      }
    }
    return '';
  }

  function findModel(modelKey) {
    const parsed = parseModelKey(modelKey);
    if (!parsed || !directory) return null;
    const provider = directory.providers.find((item) => item.id === parsed.providerId) ?? null;
    const model = provider?.models.find((item) => item.id === parsed.modelId) ?? null;
    return provider && model ? { provider, model } : null;
  }

  async function persist(next) {
    noteActivity('model-profiles-save');
    const temp = `${filePath}.tmp`;
    await mkdirImpl(path.dirname(filePath), { recursive: true });
    await writeFileImpl(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await renameImpl(temp, filePath);
    directory = next;
  }

  // 038：同一 store 的串行写入队列。角色保存、供应商编辑与拨盘修改都是
  // 「读当前目录 → 合并 → 原子落盘」的读改写，并发 IPC 交错会互相覆盖；
  // 队列保证每次写基于上一次写完成后的目录，持久写入成功后才更新内存权威。
  let writeChain = Promise.resolve();
  function queueWrite(operation) {
    const run = writeChain.then(operation, operation);
    writeChain = run.then(() => {}, () => {});
    return run;
  }

  /** 056：角色路由槽位的存储视图（手动值；就绪由 role-models.mjs 结合角色定义计算）。 */
  function roleModelsImpl() {
    const stored = directory?.roleModels ?? {};
    return Object.fromEntries(ROLE_MODEL_SLOTS.map((slot) => [slot, stored[slot] ?? null]));
  }

  async function ensureLoaded() {
    if (directory || corrupt) return directory;
    try {
      const raw = JSON.parse(await readFileImpl(filePath, 'utf8'));
      // 070：文件在但供应商列表是空数组＝未配置（与文件不存在同义），不是损坏；
      // 只有解析失败或结构对不上才进只读回落。
      if (Array.isArray(raw?.providers) && raw.providers.length === 0) return null;
      const next = normalizeDirectory(raw);
      if (!next) throw new Error('目录结构无效');
      for (const provider of next.providers) {
        if (!hasSupportedSecret(safeStorage, provider.encryptedApiKey)) provider.encryptedApiKey = '';
      }
      directory = next;
      return directory;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      corrupt = true;
      log?.warn(`模型配置目录损坏（${error.message}），只读回落`);
      return null;
    }
  }

  return {
    /** 渲染层目录视图。空目录（未迁移/未建组）返回空列表，损坏仍给只读占位。 */
    async list() {
      await ensureLoaded();
      if (!directory) {
        if (!corrupt) {
          return {
            version: PROFILES_VERSION,
            defaultModelId: null,
            corrupt: false,
            envOverride: envOverrideActive(env),
            providers: [],
          };
        }
        return {
          version: PROFILES_VERSION,
          defaultModelId: null,
          corrupt,
          envOverride: envOverrideActive(env),
          providers: [
            providerView(
              normalizeProvider({
                id: PLACEHOLDER_PROVIDER_ID,
                name: `${PLACEHOLDER_PROVIDER_NAME}（目录损坏，只读）`,
                models: [{ id: 'm1', model: '' }],
              }),
            ),
          ],
        };
      }
      return {
        version: directory.version,
        defaultModelId: directory.defaultModelId,
        // 2026-10-08：上次主脑模型选择（新建对话恢复用；null＝未记录/已失效）。
        lastConversationModelKey: directory.lastConversationModelKey ?? null,
        // 056：角色路由槽位（null＝未配；角色未配＝跟随 main）。
        roleModels: roleModelsImpl(),
        // 056：全局看图模型（null＝未单独配置：会话模型能看图就自己看，否则不收图）。
        visionModelKey: directory.visionModelKey ?? null,
        corrupt: false,
        envOverride: envOverrideActive(env),
        providers: await Promise.all(directory.providers.map(async provider => {
          const hasApiKey = await providerHasStoredKey(provider);
          return { ...providerView(provider), hasApiKey, keyStoredSecurely: hasApiKey };
        })),
      };
    },

    /** 单个模型的完整配置（主进程：逐模型测试 / 探活回显）。 */
    async get(modelKey, { decryptSecrets = true } = {}) {
      await ensureLoaded();
      const found = findModel(modelKey);
      if (!found) return null;
      const apiKey = decryptSecrets ? await providerApiKey(found.provider) : '';
      return {
        modelKey,
        providerId: found.provider.id,
        modelId: found.model.id,
        name: found.provider.name,
        baseUrl: found.provider.baseUrl,
        api: apiFor(found.provider, found.model),
        ...(found.provider.oauthProvider ? { oauthProvider: found.provider.oauthProvider } : {}),
        model: found.model.model,
        apiKey,
        thinkingLevel: found.model.thinkingLevel,
        thinkingFormat: found.model.thinkingFormat,
        supportsVision: found.model.supportsVision,
        visionModel: found.model.visionModel,
        hasApiKey: decryptSecrets ? Boolean(apiKey) : await providerHasStoredKey(found.provider),
      };
    },

    /** 供应商级凭据（041 拉取模型列表）：Key 解密只发生在主进程，渲染层拿不到原文。 */
    async providerCredentials(providerId) {
      await ensureLoaded();
      const provider = directory?.providers.find((item) => item.id === providerId) ?? null;
      if (!provider) return null;
      const apiKey = await providerApiKey(provider);
      return {
        providerId: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey,
        hasApiKey: Boolean(apiKey),
      };
    },

    /**
     * 保存供应商（新建或更新）：端点/名称/Key 与模型列表整体提交；
     * id 缺省＝新建；Key 非空才覆盖（空＝保留已存）；模型条目按 id 稳定身份。
     *
     * 032：目录为空（未建组）时允许首次创建——首组即默认组；
     * `makeDefault: true`（首启引导用，2026-09-30 用户裁决）把保存的分组
     * 立即设为默认，即使目录里已有别的默认候选。safeStorage 不可用时
     * 不把新 Key 落成明文——直接拒绝保存。
     */
    async saveProvider(input) {
      // 038：写路径进串行队列，与角色保存/拨盘修改互不覆盖。
      return queueWrite(async () => {
      await ensureLoaded();
      if (!directory && corrupt) throw new Error('配置目录损坏，修复后才能保存');
      const providerId = typeof input?.id === 'string' && input.id.trim() ? input.id.trim() : null;
      const previous = providerId && directory
        ? directory.providers.find((item) => item.id === providerId) ?? null
        : null;
      if (previous?.oauthProvider && (input?.apiKey || input?.baseUrl && input.baseUrl !== previous.baseUrl || input?.api && input.api !== previous.api)) throw new Error('账号连接由服务商管理，请通过重新登录更新。');
      if (previous?.oauthProvider) {
        if (input.models?.some(model => !oauth.models.getModel(previous.oauthProvider, model.model))) throw new Error('请选择账号目录中的模型');
      }
      const keep = (next, prev) => (typeof next === 'string' && next.trim() ? next : prev);
      const models = (Array.isArray(input?.models) ? input.models : [])
        .map((raw, index) => normalizeModel({
          id: typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : `m-new-${Date.now().toString(36)}-${index}`,
          model: raw?.model,
          thinkingLevel: raw?.thinkingLevel,
          thinkingFormat: raw?.thinkingFormat,
          supportsVision: raw?.supportsVision === true && (!previous?.oauthProvider || oauth.models.getModel(previous.oauthProvider, raw.model)?.input.includes('image')),
          visionModel: raw?.visionModel,
        }))
        .filter(Boolean);
      if (!models.length) throw new Error('至少给这个供应商配一个模型');
      const next = normalizeProvider({
        id: providerId ?? newId('mp'),
        name: keep(input?.name, previous?.name),
        baseUrl: keep(input?.baseUrl, previous?.baseUrl),
        // 046：协议缺省沿旧值（编辑表单整单提交）；从未有过的落 openai 兜底。
        api: normalizeProviderApi(input?.api ?? previous?.api),
        ...(previous?.oauthProvider ? { oauthProvider: previous.oauthProvider } : {}),
        encryptedApiKey: previous?.encryptedApiKey ?? '',
        models,
        createdAt: previous?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      });
      const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : '';
      if (apiKey) {
        if (!canEncrypt()) {
          throw new Error('本机暂时无法加密保存密钥（本机存储不可用），请稍后重试。');
        }
        next.encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');
      }
      const providers = previous
        ? directory.providers.map((item) => (item.id === next.id ? next : item))
        : [...(directory?.providers ?? []), next];
      const allKeys = providers.flatMap((provider) => provider.models.map((model) => `${provider.id}/${model.id}`));
      const fallbackDefault = directory?.defaultModelId && allKeys.includes(directory.defaultModelId)
        ? directory.defaultModelId
        : allKeys[0];
      await persist({
        version: PROFILES_VERSION,
        defaultModelId: input?.makeDefault === true
          ? `${next.id}/${next.models[0].id}`
          : fallbackDefault,
        // 038：整体保存不得丢弃已存的角色引用；047：导入回执同文件保留；
        // 2026-10-08：上次主脑模型选择同样保留。
        ...(directory?.roleModels ? { roleModels: directory.roleModels } : {}),
        ...(directory?.importReceipts?.length ? { importReceipts: directory.importReceipts } : {}),
        ...(directory?.lastConversationModelKey ? { lastConversationModelKey: directory.lastConversationModelKey } : {}),
        // 056：全局看图模型（没设置过＝null 也要落盘，防止下次读取又从默认条目迁一遍）。
        visionModelKey: directory?.visionModelKey ?? null,
        providers,
      });
      return { ok: true, providerId: next.id, modelKeys: next.models.map((model) => `${next.id}/${model.id}`) };
      });
    },

    /** Main-process-only account catalog import. Stable IDs preserve selections on reconnect. */
    async saveOAuthProvider(oauthProvider, catalog) {
      return queueWrite(async () => {
        await ensureLoaded();
        if (corrupt) throw new Error('配置目录损坏，修复后才能保存');
        if (!isOAuthProvider(oauthProvider) || !catalog.length) throw new Error('账号模型目录为空');
        if (envOverrideActive(env)) throw new Error('环境变量正在覆盖模型配置，请先移除覆盖再登录。');
        const id = `oauth-${oauthProvider}`;
        const previous = directory?.providers.find(provider => provider.id === id);
        const models = catalog.map(item => {
          const old = previous?.models.find(model => model.model === item.id);
          return normalizeModel({ ...old, id: old?.id ?? `m-${Buffer.from(item.id).toString('base64url')}`, model: item.id, supportsVision: item.supportsVision });
        });
        const provider = normalizeProvider({ id, name: previous?.name ?? OAUTH_PROVIDERS[oauthProvider], oauthProvider, baseUrl: catalog[0].baseUrl, api: catalog[0].api, models, createdAt: previous?.createdAt, updatedAt: Date.now() });
        const providers = previous ? directory.providers.map(item => item.id === id ? provider : item) : [...(directory?.providers ?? []), provider];
        const keys = providers.flatMap(item => item.models.map(model => `${item.id}/${model.id}`));
        await persist({ ...directory, version: PROFILES_VERSION, providers, defaultModelId: keys.includes(directory?.defaultModelId) ? directory.defaultModelId : `${id}/${models[0].id}`, visionModelKey: directory?.visionModelKey ?? null });
        return { ok: true, providerId: id };
      });
    },

    /** 删除供应商（连同其模型）；含默认模型时必须显式给替代模型键。 */
    async removeProvider({ providerId, replacementModelId = '' }) {
      return queueWrite(async () => {
      await ensureLoaded();
      if (!directory) throw new Error(corrupt ? '配置目录损坏' : '配置目录不可用');
      if (directory.providers.length <= 1) throw new Error('至少保留一个供应商');
      const target = directory.providers.find((item) => item.id === providerId);
      if (!target) throw new Error('没有这个供应商');
      const hadDefault = target.models.some((model) => `${target.id}/${model.id}` === directory.defaultModelId);
      let defaultModelId = directory.defaultModelId;
      if (hadDefault) {
        const replacement = parseModelKey(replacementModelId);
        const replacementProvider = replacement
          ? directory.providers.find((item) => item.id === replacement.providerId && item.id !== providerId)
          : null;
        if (!replacementProvider || !replacementProvider.models.some((model) => model.id === replacement.modelId)) {
          throw new Error('这个供应商里有默认模型，删除前先选择替代模型');
        }
        defaultModelId = replacementModelId;
      }
      const providers = directory.providers.filter((item) => item.id !== providerId);
      const remainingKeys = providers.flatMap((provider) => provider.models.map((model) => `${provider.id}/${model.id}`));
      const lastKey = directory.lastConversationModelKey;
      if (target.oauthProvider) await oauth.models.logout(target.oauthProvider);
      await persist({
        ...directory,
        defaultModelId,
        // 2026-10-08：上次主脑模型选择指向被删供应商 → 一并丢弃（undefined 不落盘）。
        lastConversationModelKey:
          !lastKey || lastKey === AUTO_SELECTION_ID || remainingKeys.includes(lastKey)
            ? lastKey
            : undefined,
        providers,
      });
      return { ok: true, defaultModelId };
      });
    },

    /** 设默认模型（modelKey）。 */
    async setDefault(modelKey) {
      return queueWrite(async () => {
        await ensureLoaded();
        if (!directory || !findModel(modelKey)) throw new Error('没有这个模型');
        await persist({ ...directory, defaultModelId: String(modelKey) });
        return { ok: true, defaultModelId: String(modelKey) };
      });
    },

    /**
     * 2026-10-08 用户反馈：新建对话的模型选择总被重置回默认（DeepSeek）——
     * 改成「优先用上次的选择，取不到再回落默认」。上次选择（模型键或 'auto'）
     * 记在本目录文件里；这里只做记录与校验（失效值清空，不抛错——纯缓存，
     * 调用方 fire-and-forget），恢复与 UI 侧可用性校验在渲染层。
     */
    async setLastConversationModel(value) {
      return queueWrite(async () => {
        await ensureLoaded();
        if (!directory) return { ok: false, lastConversationModelKey: null };
        const next =
          value === AUTO_SELECTION_ID || findModel(value) ? String(value) : null;
        // 值没变不落盘（启动种子化每次都会记一笔，省掉无谓的目录写）。
        if ((directory.lastConversationModelKey ?? null) === next) {
          return { ok: true, lastConversationModelKey: next };
        }
        await persist({ ...directory, lastConversationModelKey: next });
        return { ok: true, lastConversationModelKey: next };
      });
    },

    /**
     * 056：保存一个角色路由槽位（一次一个字段；值＝modelKey 或 null＝清除）。
     * 新引用必须在目录里；失败抛可展示的中文原因，渲染层回滚该字段。
     */
    async saveRoleModel(patch) {
      return queueWrite(async () => {
        await ensureLoaded();
        if (!directory) throw new Error(corrupt ? '配置目录损坏，修复后才能保存' : '配置目录不可用，先完成初始设置');
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new Error('角色模型保存参数不正确');
        }
        const fields = Object.keys(patch).filter((key) => patch[key] !== undefined);
        if (fields.length !== 1 || !ROLE_MODEL_SLOTS.includes(fields[0])) {
          throw new Error('一次只能保存一个角色的模型');
        }
        const field = fields[0];
        const value = patch[field];
        if (value != null && (typeof value !== 'string' || !findModel(value))) {
          throw new Error('没有这个模型，请重新选择');
        }
        const next = normalizeRoleModels({ ...(directory.roleModels ?? {}), [field]: value ?? null });
        const { roleModels: _previous, ...rest } = directory;
        await persist({ ...rest, ...(next ? { roleModels: next } : {}) });
        return { ok: true, roleModels: roleModelsImpl() };
      });
    },

    /** 056：设置全局看图模型（模型键或 null＝不单独配置）。 */
    async setVisionModel(value) {
      return queueWrite(async () => {
        await ensureLoaded();
        if (!directory) throw new Error(corrupt ? '配置目录损坏，修复后才能保存' : '配置目录不可用，先完成初始设置');
        const next = value == null || value === '' ? null : String(value);
        if (next && !findModel(next)) throw new Error('没有这个模型，请重新选择');
        await persist({ ...directory, visionModelKey: next });
        return { ok: true, visionModelKey: next };
      });
    },

    /**
     * 047：按 operationId 查导入回执（恢复流程先读目录回执，再读 journal）。
     */
    async findImportReceipt(operationId) {
      await ensureLoaded();
      return directory?.importReceipts?.find((receipt) => receipt.operationId === operationId) ?? null;
    },

    /**
     * 047：批量原子导入供应商（仅主进程调用；一次生成全部供应商、默认与
     * 同文件回执，一次持久化）。幂等：同 operationId＋planHash 重试返回原回执；
     * hash 异或 deterministicId 撞车＝冲突，不覆盖。已有有效默认/角色保持，
     * 目录首次为空才采用 firstDefaultModelKey。回执与全部供应商同文件落盘，
     * 解决「已保存、journal 未记成功即崩溃」窗口——回执是提交事实权威。
     */
    async importProvidersAtomic({
      operationId,
      planHash,
      providers: providerInputs,
      firstDefaultModelKey = null,
    }) {
      return queueWrite(async () => {
        await ensureLoaded();
        if (!directory && corrupt) throw new Error('配置目录损坏，修复后才能导入');
        if (typeof operationId !== 'string' || !operationId) throw new Error('导入缺少操作标识');
        if (typeof planHash !== 'string' || !planHash) throw new Error('导入缺少计划指纹');
        if (!Array.isArray(providerInputs) || providerInputs.length === 0) throw new Error('导入计划为空');
        if (envOverrideActive(env)) throw new Error('环境变量（HEMI_LLM_*）正在覆盖模型配置，先清掉再导入');
        if (!canEncrypt()) throw new Error('本机暂时无法加密保存密钥（本机存储不可用）');

        const existingReceipt = directory?.importReceipts?.find((receipt) => receipt.operationId === operationId);
        if (existingReceipt) {
          if (existingReceipt.planHash === planHash) {
            return {
              receipt: existingReceipt,
              providers: existingReceipt.providerIds
                .map((id) => directory.providers.find((item) => item.id === id))
                .filter(Boolean)
                .map(providerView),
            };
          }
          throw new Error('同一导入操作的提交计划变了，不能覆盖已导入的配置');
        }

        const nextProviders = [];
        const seenIds = new Set((directory?.providers ?? []).map((item) => item.id));
        for (const input of providerInputs) {
          const models = (Array.isArray(input?.models) ? input.models : [])
            .map((raw) => normalizeModel({ id: raw?.id ?? raw?.model, model: raw?.model }))
            .filter(Boolean);
          if (!models.length) throw new Error('导入的供应商至少要有一个模型');
          if (!PROVIDER_APIS.includes(input?.api)) throw new Error(`未知线协议：${String(input?.api)}`);
          const deterministicId = typeof input?.deterministicId === 'string' && input.deterministicId.trim()
            ? input.deterministicId.trim()
            : null;
          if (!deterministicId) throw new Error('导入供应商缺少确定性 id');
          if (seenIds.has(deterministicId)) throw new Error(`供应商 id 冲突：${deterministicId}`);
          const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : '';
          if (!apiKey) throw new Error('导入的供应商缺少 Key');
          const provider = normalizeProvider({
            id: deterministicId,
            name: input?.name,
            baseUrl: input?.baseUrl,
            api: input?.api,
            encryptedApiKey: '',
            models,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          provider.encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');
          seenIds.add(provider.id);
          nextProviders.push(provider);
        }

        const providers = [...(directory?.providers ?? []), ...nextProviders];
        const allKeys = providers.flatMap((provider) => provider.models.map((model) => `${provider.id}/${model.id}`));
        const newKeys = nextProviders.flatMap((provider) => provider.models.map((model) => `${provider.id}/${model.id}`));
        // 最新目录已有有效默认就保持；首次为空才用 firstDefaultModelKey（必须在新集合中）。
        let defaultModelId = directory?.defaultModelId && allKeys.includes(directory.defaultModelId)
          ? directory.defaultModelId
          : null;
        if (!defaultModelId) {
          if (!directory || !(directory.providers ?? []).length) {
            const requested = firstDefaultModelKey && newKeys.includes(firstDefaultModelKey)
              ? firstDefaultModelKey
              : newKeys[0];
            if (!requested) throw new Error('导入计划里没有可作默认的模型');
            defaultModelId = requested;
          } else {
            defaultModelId = allKeys[0];
          }
        }

        const receipt = {
          operationId,
          planHash,
          providerIds: nextProviders.map((provider) => provider.id),
          modelKeys: newKeys,
          committedAt: Date.now(),
        };
        await persist({
          version: PROFILES_VERSION,
          defaultModelId,
          ...(directory?.roleModels ? { roleModels: directory.roleModels } : {}),
          ...(directory?.lastConversationModelKey ? { lastConversationModelKey: directory.lastConversationModelKey } : {}),
          visionModelKey: directory?.visionModelKey ?? null,
          importReceipts: [...(directory?.importReceipts ?? []), receipt],
          providers,
        });
        return {
          receipt,
          providers: nextProviders.map(providerView),
        };
      });
    },

    /**
     * 038：自动候选的严格解析——不借用 resolve 的默认回退，引用失效或缺凭据
     * 都明确报原因。返回 { ok, config } 或 { ok: false, reason, message }。
     * 070：未配置（文件不存在／空目录）与损坏分开报——前者是新装机的正常状态，
     * 引导去设置；后者才提示修复。文案不绑定自动路由，固定模型与轻量调用共用。
     */
    async resolveStrict(modelKey) {
      await ensureLoaded();
      // 未配置（文件不存在/空目录，corrupt=false）不是损坏——混报会让无配置首启的
      // 对话拒绝变成「配置目录损坏」（win 冒烟实锤；冒烟断言只认「未配置」）。
      if (!directory) {
        return corrupt
          ? { ok: false, reason: 'corrupt', message: '模型配置目录损坏，修复后才能使用（设置 → 模型与路由 里有修复说明）' }
          : { ok: false, reason: 'unconfigured', message: '未配置模型：先到 设置 → 模型与路由 添加供应商和模型。' };
      }
      const found = findModel(modelKey);
      if (!found) return { ok: false, reason: 'missing', message: '选择的模型已不在配置里，请重新选择' };
      const apiKey = await providerApiKey(found.provider);
      if (!apiKey) return { ok: false, reason: 'no-credentials', message: found.provider.oauthProvider ? `「${found.provider.name}」账号已退出或凭据不可用，请重新登录` : `「${found.provider.name}」还没有可用的 API Key` };
      return {
        ok: true,
        config: {
          modelKey: `${found.provider.id}/${found.model.id}`,
          providerId: found.provider.id,
          name: found.provider.name,
          baseUrl: found.provider.baseUrl,
          api: apiFor(found.provider, found.model),
          ...(found.provider.oauthProvider ? { oauthProvider: found.provider.oauthProvider } : {}),
          apiKey,
          model: found.model.model,
          thinkingLevel: found.model.thinkingLevel,
          thinkingFormat: found.model.thinkingFormat,
          supportsVision: found.model.supportsVision,
          visionModel: found.model.visionModel,
        },
      };
    },

    /** 回合解析：modelKey → 供应商端点/Key + 模型字段；环境覆盖最高并如实标记。 */
    async resolve({ modelKey = null, decryptSecrets = true } = {}) {
      await ensureLoaded();
      let base;
      let resolvedKey = null;
      let missing = false;
      const found = findModel(modelKey);
      if (found) {
        base = {
          modelKey: `${found.provider.id}/${found.model.id}`,
          providerId: found.provider.id,
          name: found.provider.name,
          baseUrl: found.provider.baseUrl,
          api: apiFor(found.provider, found.model),
          ...(found.provider.oauthProvider ? { oauthProvider: found.provider.oauthProvider } : {}),
          apiKey: decryptSecrets ? await providerApiKey(found.provider) : '',
          hasApiKey: await providerHasStoredKey(found.provider),
          model: found.model.model,
          thinkingLevel: found.model.thinkingLevel,
          thinkingFormat: found.model.thinkingFormat,
          supportsVision: found.model.supportsVision,
          visionModel: found.model.visionModel,
        };
        resolvedKey = base.modelKey;
      } else {
        if (modelKey) missing = true;
        const fallback = directory
          ? findModel(directory.defaultModelId) ?? (() => {
              const provider = directory.providers[0];
              return { provider, model: provider.models[0] };
            })()
          : null;
        base = fallback
          ? {
              modelKey: `${fallback.provider.id}/${fallback.model.id}`,
              providerId: fallback.provider.id,
              name: fallback.provider.name,
              baseUrl: fallback.provider.baseUrl,
              api: apiFor(fallback.provider, fallback.model),
              ...(fallback.provider.oauthProvider ? { oauthProvider: fallback.provider.oauthProvider } : {}),
              apiKey: decryptSecrets ? await providerApiKey(fallback.provider) : '',
              hasApiKey: await providerHasStoredKey(fallback.provider),
              model: fallback.model.model,
              thinkingLevel: fallback.model.thinkingLevel,
              thinkingFormat: fallback.model.thinkingFormat,
              supportsVision: fallback.model.supportsVision,
              visionModel: fallback.model.visionModel,
            }
          : { modelKey: null, providerId: PLACEHOLDER_PROVIDER_ID, name: PLACEHOLDER_PROVIDER_NAME, baseUrl: '', api: 'openai-completions', apiKey: '', model: '', thinkingLevel: 'default', thinkingFormat: null, supportsVision: false, visionModel: '' };
        resolvedKey = base.modelKey;
      }
      const envLevel = normalizeThinkingLevel(env.HEMI_LLM_THINKING_LEVEL);
      const overridden = envOverrideActive(env);
      return {
        ...base,
        profileId: overridden ? null : resolvedKey,
        requestedModelKey: modelKey ?? null,
        missingModelKey: missing,
        envOverride: overridden,
        ...(env.HEMI_LLM_API_KEY || env.HEMI_LLM_BASE_URL ? { oauthProvider: undefined } : {}),
        apiKey: env.HEMI_LLM_API_KEY || base.apiKey,
        hasApiKey: Boolean(env.HEMI_LLM_API_KEY || (decryptSecrets ? base.apiKey : base.hasApiKey)),
        keyStoredSecurely: Boolean(base.hasApiKey),
        baseUrl: env.HEMI_LLM_BASE_URL || base.baseUrl,
        model: env.HEMI_LLM_MODEL || base.model,
        thinkingLevel:
          env.HEMI_LLM_THINKING_LEVEL && envLevel !== 'default' ? envLevel : base.thinkingLevel,
      };
    },
  };
}
