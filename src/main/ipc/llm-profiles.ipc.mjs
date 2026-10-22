/**
 * 055 R-12 · 对话配置面 IPC（从 llm.ipc 抽出，产品行为不变）。
 *
 * 覆盖：031 多组模型目录（列表/保存/删除/默认/上次选择）、041 拉取模型列表、
 * 032 逐组探活、056 角色模型保存、033 思考档拨盘、
 * 032 首启引导 saveConfig/getConfig、设置页「测试连通性」。
 * llm.ipc 只留耳／口适配、主 agent 回合与 029 队列。
 */

import { ipcMain } from 'electron';

import { parseModelKey } from '../lib/model-profiles.mjs';
import { AUTO_SELECTION_ID } from '../lib/model-routing.mjs';
import {
  classifyModelError,
  listRemoteModels,
  normalizeBaseUrl,
  pingTextModel,
} from '../services/text-model.mjs';
import { normalizeThinkingLevel } from '../services/thinking-level.mjs';
import { resolveTextModelConfig } from '../lib/config-store.mjs';
import { createLogger } from '../lib/logger.mjs';
import { IPC } from '../../shared/ipc-channels.mjs';
import { getProfiles, getOAuthRuntime } from '../lib/profiles-holder.mjs';
import { roleModelsView } from '../lib/role-models.mjs';
import { loadRoles } from '../agent/agent-roles.mjs';

/** 角色路由的设置页载荷：角色清单（名称/说明/是否要看图）＋各槽位视图＋能否选「自动」。 */
async function roleModelsPayload() {
  const roles = loadRoles();
  const directory = await getProfiles().list();
  return {
    roles: [...roles.values()].map((role) => ({ name: role.name, title: role.title, description: role.description, needsVision: false })),
    ...roleModelsView(directory, roles),
  };
}

const llmLog = createLogger('llm');

export function registerLlmProfilesIpc() {
  ipcMain.handle(IPC.llm.listModelProfiles, () => getProfiles().list());

  // 056：角色路由（038 修订）——视图带角色说明与就绪；逐项即时保存。
  ipcMain.handle(IPC.llm.getRoleModels, async () => roleModelsPayload());
  ipcMain.handle(IPC.llm.saveRoleModel, async (_event, payload) => {
    await getProfiles().saveRoleModel(payload?.patch ?? payload);
    return { ok: true, ...(await roleModelsPayload()) };
  });

  // 供应商级保存：端点/Key/名称＋模型列表整体提交（模型含思考与视觉字段）。
  ipcMain.handle(IPC.llm.saveModelProfile, async (_event, payload) =>
    getProfiles().saveProvider(payload ?? {}),
  );
  ipcMain.handle(IPC.llm.removeModelProfile, async (_event, payload) =>
    getProfiles().removeProvider({
      providerId: payload?.providerId,
      replacementModelId: payload?.replacementModelId,
    }),
  );
  ipcMain.handle(IPC.llm.setDefaultModelProfile, async (_event, payload) =>
    // 041：兼容旧 preload 的 { profileId } 包法（dev 热更新窗口内新主进程可能配旧渲染层）。
    getProfiles().setDefault(payload?.modelKey ?? payload?.profileId),
  );
  // 2026-10-08：记上次主脑模型选择（纯缓存：失效值主进程清空，不抛错）。
  // 056：全局看图模型（单独配置，不再挂在默认模型条目上）。
  ipcMain.handle(IPC.llm.setVisionModel, async (_event, payload) =>
    getProfiles().setVisionModel(payload?.modelKey ?? null),
  );
  ipcMain.handle(IPC.llm.setLastConversationModel, async (_event, payload) =>
    getProfiles().setLastConversationModel(payload?.modelKey ?? payload?.profileId),
  );
  /**
   * 逐组探活（032 扩展）：
   * - 带模型键：空字段只回落到该组已存值（不借别组的 Key）；
   * - 不带模型键（首启引导还没建组）：三项必须显式传入，不回落任何已存配置；
   * - 测试不保存、不设默认；失败返回结构化类别（missing/invalid/auth/model/
   *   network/timeout）与安全文案，渲染层就地反馈。
   */
  ipcMain.handle(IPC.llm.testModelProfile, async (_event, payload) => {
    const hasKey = typeof payload?.modelKey === 'string' && payload.modelKey.trim();
    const model = hasKey ? await getProfiles().get(payload.modelKey) : null;
    if (hasKey && !model) return { ok: false, error: '没有这个模型。', errorKind: 'missing' };
    if (model?.oauthProvider) {
      try {
        return await pingTextModel({ ...model, ...(typeof payload?.model === 'string' ? { model: payload.model } : {}), requireTools: payload?.requireTools === true });
      } catch { return { ok: false, error: '账号模型连接失败，请检查账号权限、额度和网络，或重新登录。', errorKind: 'auth' }; }
    }
    const pick = (value, fallback) =>
      (typeof value === 'string' && value.trim() ? value.trim() : fallback);
    const base = {
      baseUrl: pick(payload?.baseUrl, hasKey ? model.baseUrl : ''),
      apiKey: pick(payload?.apiKey, hasKey ? model.apiKey : ''),
      model: pick(payload?.model, hasKey ? model.model : ''),
      // 051：协议显式传入优先（首启引导草稿），否则回退该组已存协议。
      api: pick(payload?.api, hasKey ? model.api ?? 'openai-completions' : 'openai-completions'),
      requireTools: payload?.requireTools === true,
    };
    if (!base.baseUrl || !base.apiKey || !base.model) {
      return { ok: false, error: '请先填完接口地址、模型名称和 API Key。', errorKind: 'missing' };
    }
    // URL 形态先本地校验（normalizeBaseUrl 同款归一），不把明显错的地址发出去。
    try {
      new URL(normalizeBaseUrl(base.baseUrl));
    } catch {
      return { ok: false, error: '接口地址不是有效的 URL，请检查后重试。', errorKind: 'invalid' };
    }
    try {
      return await pingTextModel(base);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, errorKind: classifyModelError(message) };
    }
  });

  /**
   * 041 拉取模型列表：GET {baseUrl}/models，返回该供应商可用的型号 ID 列表。
   */
  ipcMain.handle(IPC.llm.listRemoteModels, async (_event, payload) => {
    const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
    let baseUrl = pick(payload?.baseUrl);
    let apiKey = pick(payload?.apiKey);
    if (payload?.providerId) {
      const provider = (await getProfiles().list()).providers.find(item => item.id === payload.providerId);
      if (provider?.oauthProvider) {
        try { return { ok: true, models: (await getOAuthRuntime().catalog(provider.oauthProvider)).map(model => model.id) }; }
        catch { return { ok: false, error: '账号模型目录不可用，请重新登录。' }; }
      }
      const creds = await getProfiles().providerCredentials(String(payload.providerId));
      if (!creds) return { ok: false, error: '没有这个供应商。' };
      baseUrl = baseUrl || creds.baseUrl;
      apiKey = apiKey || creds.apiKey;
    }
    if (!baseUrl) return { ok: false, error: '请先填写接口地址。' };
    let parsed;
    try {
      parsed = new URL(normalizeBaseUrl(baseUrl));
    } catch {
      return { ok: false, error: '接口地址不是有效的 URL，请检查后重试。', errorKind: 'invalid' };
    }
    const localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
    if (!apiKey && !localHost) {
      return { ok: false, error: '拉取模型列表需要 API Key，请先填写并保存。' };
    }
    try {
      const { models } = await listRemoteModels({ baseUrl, apiKey });
      return { ok: true, models };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC.llm.getConfig, async () => {
    // 031：模型就绪判定与首启引导读默认组（环境覆盖仍生效并如实返回有效值）。
    const resolved = await getProfiles().resolve({ decryptSecrets: false });
    return {
      baseUrl: resolved.baseUrl,
      model: resolved.model,
      hasApiKey: resolved.hasApiKey,
      keyStoredSecurely: resolved.keyStoredSecurely,
      // 033：思考强度档位（default＝厂商中档）。
      thinkingLevel: resolved.thinkingLevel,
      supportsVision: resolved.supportsVision,
      visionModel: resolved.visionModel,
    };
  });

  // 首启引导只配一组：写进默认模型所在的供应商（默认模型字段被表单覆盖，
  // 同供应商其余模型保留）；目录为空时新建单模型供应商——按目录判定，
  // 不依赖 resolve 的占位 providerId。看图字段随模型条目落目录。
  ipcMain.handle(IPC.llm.saveConfig, async (_event, config) => {
    const directory = await getProfiles().list();
    const defaultKey = directory.defaultModelId ? parseModelKey(directory.defaultModelId) : null;
    const defaultProvider = defaultKey
      ? directory.providers.find((item) => item.id === defaultKey.providerId) ?? null
      : null;
    let providerId = null;
    if (defaultProvider) {
      providerId = (
        await getProfiles().saveProvider({
          id: defaultProvider.id,
          name: defaultProvider.name,
          baseUrl: config?.baseUrl ?? defaultProvider.baseUrl,
          apiKey: config?.apiKey,
          models: defaultProvider.models.map((model) =>
            model.modelKey === directory.defaultModelId
              ? {
                  ...model,
                  model: typeof config?.model === 'string' && config.model.trim() ? config.model.trim() : model.model,
                  thinkingLevel: config?.thinkingLevel ?? model.thinkingLevel,
                  thinkingFormat: config?.thinkingFormat ?? model.thinkingFormat,
                  supportsVision: typeof config?.supportsVision === 'boolean' ? config.supportsVision : model.supportsVision,
                  visionModel: typeof config?.visionModel === 'string' && config.visionModel.trim() ? config.visionModel.trim() : model.visionModel,
                }
              : model,
          ),
        })
      ).providerId;
    } else {
      providerId = (
        await getProfiles().saveProvider({
          name: '默认供应商',
          baseUrl: config?.baseUrl,
          apiKey: config?.apiKey,
          makeDefault: true,
          models: [
            {
              model: typeof config?.model === 'string' ? config.model.trim() : '',
              thinkingLevel: config?.thinkingLevel,
              thinkingFormat: config?.thinkingFormat,
              supportsVision: config?.supportsVision === true,
              visionModel: config?.visionModel,
            },
          ],
        })
      ).providerId;
    }
    const resolved = await getProfiles().resolve({ decryptSecrets: false });
    return {
      baseUrl: resolved.baseUrl,
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel,
      thinkingFormat: resolved.thinkingFormat,
      hasApiKey: resolved.hasApiKey,
      keyStoredSecurely: resolved.keyStoredSecurely,
      supportsVision: resolved.supportsVision,
      visionModel: resolved.visionModel,
      ...(providerId ? { providerId } : {}),
    };
  });

  // 033/031：思考强度快捷拨盘——带模型键只改该模型；缺省改默认模型。
  ipcMain.handle(IPC.llm.setThinkingLevel, async (_event, payload) => {
    // 自动（角色路由）模式的思考档随各模型自己的设置，拨盘改的是默认模型。
    const modelKey =
      typeof payload === 'object' && payload && typeof payload.profileId === 'string' && payload.profileId !== AUTO_SELECTION_ID
        ? payload.profileId
        : (await getProfiles().list()).defaultModelId;
    const target = await getProfiles().get(modelKey, { decryptSecrets: false });
    if (!target) return { thinkingLevel: 'default' };
    const provider = (await getProfiles().list()).providers.find((item) => item.id === target.providerId);
    if (!provider) return { thinkingLevel: 'default' };
    const level = normalizeThinkingLevel(typeof payload === 'object' && payload ? payload.level : payload);
    if (target.thinkingLevel === level) return { thinkingLevel: target.thinkingLevel };
    await getProfiles().saveProvider({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      models: provider.models.map((model) => ({
        ...model,
        thinkingLevel: model.modelKey === modelKey ? level : model.thinkingLevel,
      })),
    });
    const after = await getProfiles().get(modelKey, { decryptSecrets: false });
    return { thinkingLevel: after?.thinkingLevel ?? 'default' };
  });

  // 设置页「测试连通性」：用表单当前值（含未保存的 key）探活。
  ipcMain.handle(IPC.llm.testModel, async (_event, payload) => {
    const overrides = payload && typeof payload === 'object' ? payload : {};
    const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
    const stored = await resolveTextModelConfig();
    try {
      return await pingTextModel({
        baseUrl: pick(overrides.baseUrl) || stored.baseUrl,
        apiKey: pick(overrides.apiKey) || stored.apiKey,
        model: pick(overrides.model) || stored.model,
      });
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });

  return llmLog;
}
