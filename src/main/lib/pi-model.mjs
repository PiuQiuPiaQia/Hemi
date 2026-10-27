/** Hemi 模型配置 → Pi 原生模型定义；agent 和轻量请求共用。协议字段由 pi-ai 翻译。 */
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models';
import { ZAI_CODING_CN_MODELS } from '@earendil-works/pi-ai/providers/zai-coding-cn.models';
import { ZAI_MODELS } from '@earendil-works/pi-ai/providers/zai.models';
import { DEFAULT_LEVEL_TIER, normalizeThinkingFormat, normalizeThinkingLevel } from '../services/thinking-level.mjs';
import { oauthCatalogModel, oauthModelApi, streamOAuthModel } from '../services/oauth-models.mjs';

// 只查原厂目录；伙伴／订阅计划目录存在同名型号，不能按名字拿其专用端点能力。
const OPENAI_CATALOGS = [OPENAI_MODELS, DEEPSEEK_MODELS, ZAI_CODING_CN_MODELS, ZAI_MODELS];
export const MODEL_OUTPUT_LIMIT = 32768;
export const piApiOf = (api) => ['anthropic-messages', 'openai-responses'].includes(api) ? api : 'openai-completions';

/** 配置容忍完整接口 URL，SDK 接收基址并自行拼协议路径。 */
export function modelBaseUrl(baseUrl, api = 'openai-completions') {
  const url = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  return piApiOf(api) === 'anthropic-messages'
    ? url.replace(/\/messages$/, '').replace(/\/v1$/, '')
    : url.replace(/\/chat\/completions$/, '');
}

/** 产品三档保持不变；不支持的厂商档位由 Pi 自己夹取。 */
export function sdkThinkingLevelOf(value) {
  const level = normalizeThinkingLevel(value);
  return level === 'default' ? DEFAULT_LEVEL_TIER : level;
}

/** streamSimple 用 undefined 表达关闭；强制 adaptive 的模型沿用 SDK 的最低思考档。 */
export function reasoningLevelOf(value, model) {
  const level = sdkThinkingLevelOf(value);
  return level === 'off' ? (model?.compat?.forceAdaptiveThinking ? 'low' : undefined) : level;
}

/** ProviderConfig.models 的原生定义；预算与工具 schema 策略由宿主统一覆写。 */
export function candidateModelDef(candidate) {
  if (candidate.oauthProvider) {
    const native = oauthCatalogModel(candidate.oauthProvider, candidate.model);
    if (!native) throw new Error('账号模型目录不可用，请重新登录');
    const { provider, baseUrl, ...definition } = native;
    return { ...definition, name: candidate.name || native.name, maxTokens: Math.min(native.maxTokens, MODEL_OUTPUT_LIMIT), input: candidate.supportsVision ? ['text', 'image'] : ['text'] };
  }
  const api = piApiOf(candidate.api);
  const catalog = api === 'anthropic-messages'
    ? ANTHROPIC_MODELS[candidate.model]
    : OPENAI_CATALOGS.map((models) => models[candidate.model]).find(Boolean);
  const { api: _api, provider: _provider, baseUrl: _baseUrl, ...metadata } = catalog ?? {};
  const model = {
    ...metadata,
    id: candidate.model,
    name: candidate.name || candidate.model,
    reasoning: catalog?.reasoning ?? true,
    // 宿主的能力上限：缺 image 声明会让 SDK 丢掉工具截图（006 探针）。
    input: candidate.supportsVision === true ? ['text', 'image'] : ['text'],
    cost: catalog?.cost ? { ...catalog.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: catalog?.contextWindow || 128000,
    maxTokens: Math.min(catalog?.maxTokens || MODEL_OUTPUT_LIMIT, MODEL_OUTPUT_LIMIT),
    ...(catalog?.thinkingLevelMap ? { thinkingLevelMap: { ...catalog.thinkingLevelMap } } : {}),
  };
  if (api === 'anthropic-messages') {
    // 型号目录描述模型能力，不能据此宣称配置的兼容端点支持原生会话控制。
    // 保留标准 Anthropic 消息与顶部 thinking；不发私有 effort system／tool-change 块。
    model.compat = { ...(catalog?.compat ?? {}), supportsMidConvoEffort: false, supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: false };
    return model;
  }
  // 保留 SDK 的 reasoning_content／格式／档位等全部兼容元数据，只覆盖产品约束。
  model.compat = {
    maxTokensField: 'max_tokens',
    ...catalog?.compat,
    supportsDeveloperRole: false,
    supportsStore: false,
    supportsStrictMode: false, // Hemi 工具 schema 不要求 additionalProperties:false。
  };
  const format = normalizeThinkingFormat(candidate.thinkingFormat);
  if (format) {
    model.compat.thinkingFormat = format;
    model.compat.supportsReasoningEffort = format === 'openai';
  }
  return model;
}

export function piModelOf(candidate, provider = 'hemi-chat') {
  const definition = candidateModelDef(candidate);
  return {
    ...definition,
    api: candidate.oauthProvider ? definition.api : piApiOf(candidate.api), provider,
    baseUrl: modelBaseUrl(candidate.baseUrl, candidate.api),
  };
}

export function providerRegistrationOf(candidate) {
  if (candidate.oauthProvider) {
    const definition = candidateModelDef(candidate);
    const api = oauthModelApi(candidate.oauthProvider);
    return { baseUrl: candidate.baseUrl, api, apiKey: 'oauth', models: [{ ...definition, api }], streamSimple: (_model, context, options) => streamOAuthModel(candidate, context, options) };
  }
  return {
    baseUrl: modelBaseUrl(candidate.baseUrl, candidate.api),
    api: piApiOf(candidate.api),
    apiKey: candidate.apiKey || 'unused',
    models: [candidateModelDef(candidate)],
  };
}
