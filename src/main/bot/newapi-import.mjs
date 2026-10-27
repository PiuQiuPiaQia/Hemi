import { createHash } from 'node:crypto';
import { manualProviderModels } from './models.mjs';
import { fail, publicModel, validId } from './storage.mjs';

/** Validate all protocols, then persist models and their import receipt together. */
export async function importBotNewApi({ input, state, validateModel, secretStorage, save }) {
  const { operationId, planHash, providers } = input;
  if (!validId(operationId) || typeof planHash !== 'string' || !/^[a-f0-9]{64}$/.test(planHash)) fail('导入操作身份无效。');
  const known = state.newapiReceipts?.[operationId];
  if (known) {
    if (known.receipt.planHash !== planHash) fail('导入计划已变化，不能覆盖已保存配置。', 'conflict');
    return known;
  }
  if (!Array.isArray(providers) || !providers.length || providers.length > 3) fail('导入的供应商配置无效。');
  const configs = providers.flatMap((provider, index) => manualProviderModels(provider, `${operationId}-${index}`)
    .map(model => ({ ...model, configuration: 'newapi' })));
  if (configs.some(config => state.models[config.modelKey])) fail('导入的供应商已存在，请核对原操作回执。', 'conflict');
  let cursor = 0;
  const validation = await Promise.allSettled(Array.from({ length: Math.min(4, configs.length) }, async () => {
    for (;;) { const index = cursor++; if (index >= configs.length) return; await validateModel(configs[index]); }
  }));
  if (validation.some(item => item.status === 'rejected')) fail('Bot 未能验证 New API 模型，原配置已保留。');
  const providerIds = [...new Set(configs.map(config => config.providerId))];
  const result = {
    receipt: { operationId, planHash, providerIds, modelKeys: configs.map(config => config.modelKey), committedAt: Date.now() },
    providers: providerIds.map(id => {
      const entries = configs.filter(config => config.providerId === id), first = entries[0];
      return { id, name: first.name, baseUrl: first.baseUrl, api: first.api, configuration: 'newapi', hasApiKey: true,
        models: entries.map(config => ({ modelKey: config.modelKey, model: config.model })) };
    }),
  };
  const before = structuredClone({ models: state.models, modelSources: state.modelSources, versions: state.versions,
    defaultModel: state.defaultModel, newapiReceipts: state.newapiReceipts ?? {} });
  try {
    for (const config of configs) {
      const revision = createHash('sha256').update(JSON.stringify(config)).digest('hex');
      const { apiKey, ...publicConfig } = config;
      state.versions[revision] = { ...publicConfig, encryptedApiKey: secretStorage.encryptString(apiKey).toString('base64') };
      state.models[config.modelKey] = revision; state.modelSources[config.modelKey] = 'cloud';
      state.defaultModel ??= config.modelKey;
      publicModel(config, revision, 'cloud'); // enforce the same public endpoint contract
    }
    state.newapiReceipts ??= {};
    state.newapiReceipts[operationId] = result;
    save(); return structuredClone(result);
  } catch (error) { Object.assign(state, before); throw error; }
}
