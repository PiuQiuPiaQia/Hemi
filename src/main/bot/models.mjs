import { createHash } from 'node:crypto';
import { normalizeProvider } from '../lib/model-profiles.mjs';
import { fail, validId } from './storage.mjs';

// Manual Bot providers use the local provider schema, without writing a local
// profile. Stable operation-derived IDs make lost-reply retries idempotent.
export function manualProviderModels(input, requestId) {
  if (!validId(requestId)) fail('无效的模型添加操作。');
  if (!input || typeof input.name !== 'string' || !input.name.trim()) fail('请填写供应商名称。');
  if (!Array.isArray(input.models) || !input.models.length || input.models.length > 50)
    fail('每次请添加 1 至 50 个模型。');
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const editing = typeof input.id === 'string' && /^bot-[a-f0-9]{24}$/.test(input.id);
  if (!apiKey && !editing) fail('请填写 API Key。');
  if (input.models.some(model => typeof model?.model !== 'string' || !model.model.trim())) fail('请填写模型型号。');
  const id = editing ? input.id : 'bot-' + createHash('sha256').update(requestId).digest('hex').slice(0, 24);
  const provider = normalizeProvider({ ...input, id, models: input.models.map((model, index) => ({ ...model, id: editing && validId(model.id) ? model.id : 'm-' + index })) });
  // The Host validates reachability and its loopback policy from the server.
  modelEndpoint(provider, { allowLoopback: true });
  return provider.models.map(model => ({
    modelKey: `${id}/${model.id}`, providerId: id, name: provider.name,
    baseUrl: provider.baseUrl, api: provider.api, apiKey,
    model: model.model, thinkingLevel: model.thinkingLevel,
    thinkingFormat: model.thinkingFormat, supportsVision: model.supportsVision,
  }));
}

export function modelEndpoint(config, { allowLoopback = false } = {}) {
  let endpoint;
  try { endpoint = new URL(config?.baseUrl); } catch { fail('模型接口地址无效。'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    fail('模型接口地址无效。');
  if (!allowLoopback && /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/i.test(endpoint.hostname))
    fail('本机地址不可用，请配置云端可访问的模型地址。');
  return endpoint;
}
