import { createModels, createProvider } from '@earendil-works/pi-ai';
import { getApiProvider, registerApiProvider } from '@earendil-works/pi-ai/compat';
import { AsyncLocalStorage } from 'node:async_hooks';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy';
import { bigModelCodingProvider } from './bigmodel-coding.mjs';

export const OAUTH_PROVIDERS = Object.freeze({ openai: 'ChatGPT', anthropic: 'Claude', 'github-copilot': 'GitHub Copilot', bigmodel: 'GLM Coding Plan（BigModel）' });
export const isOAuthProvider = id => Object.hasOwn(OAUTH_PROVIDERS, id ?? '');
let activeRuntime = null;
const runtimeScope = new AsyncLocalStorage();
export const withOAuthRuntime = (runtime, run) => runtimeScope.run(runtime, run);
const currentRuntime = () => runtimeScope.getStore() ?? activeRuntime;
export function setOAuthRuntime(runtime) { activeRuntime = runtime; }
export function oauthCatalogModel(provider, id) { return currentRuntime()?.models.getModel(provider, id); }
export function streamOAuthModel(candidate, context, options = {}) {
  return oauthModelRequest(candidate, context, options, true);
}
function oauthModelRequest(candidate, context, options, simple) {
  const runtime = currentRuntime();
  if (!runtime) throw new Error('账号登录服务尚未初始化');
  const native = runtime.models.getModel(candidate.oauthProvider, candidate.model);
  if (!native) throw new Error('账号模型已不在服务商目录中，请重新登录并刷新模型。');
  // Never forward the alias provider's placeholder key/base URL into native auth resolution.
  const { apiKey, headers, baseUrl, ...request } = options;
  return runtime.models[simple ? 'streamSimple' : 'stream']({ ...native, maxTokens: Math.min(native.maxTokens, 32768), input: candidate.supportsVision ? ['text', 'image'] : ['text'] }, context, request);
}

/** Register both SDK streaming contracts for the app's OAuth providers. */
export function oauthModelApi(providerId) {
  if (!isOAuthProvider(providerId)) throw new Error('不支持这个账号服务商');
  const api = `hemi-oauth-${providerId}`;
  if (!getApiProvider(api)) {
    const candidate = model => ({ oauthProvider: providerId, model: model.id, supportsVision: model.input.includes('image') });
    registerApiProvider({ api,
      stream: (model, context, options = {}) => oauthModelRequest(candidate(model), context, options, false),
      streamSimple: (model, context, options = {}) => oauthModelRequest(candidate(model), context, options, true),
    });
  }
  return api;
}

/**
 * ChatGPT 账号走 pi-ai 的 Codex OAuth 通道（凭据槽位仍是 'openai'，provider id/名称不变）：
 * 推理经 Codex Responses API 打 chatgpt.com/backend-api，模型目录是 pi-ai 的静态 Codex 目录。
 * 旧的「Sign in with ChatGPT 直连」（aud=api.openai.com/v1）令牌受众与 Codex 端点、
 * wham/usage 都不匹配，已整体弃用——切换后需要重新登录一次。
 */
function openaiCodexAliasProvider() {
  const native = openaiCodexProvider();
  const models = native.getModels().map(model => ({ ...model, provider: 'openai' }));
  // createProvider 的返回对象不透出 api 实现，重建时直接挂同一个 lazy Codex Responses 工厂。
  const provider = createProvider({ id: 'openai', name: 'ChatGPT', baseUrl: 'https://chatgpt.com/backend-api', auth: native.auth, models, api: openAICodexResponsesApi() });
  // 默认 auto 传输会先连实验性 WebSocket（独立 socket，不经应用的 fetch 代理与日志）；钉在 SSE。
  const withSse = options => ({ ...options, transport: 'sse' });
  return { ...provider,
    stream: (model, context, options = {}) => provider.stream(model, context, withSse(options)),
    streamSimple: (model, context, options = {}) => provider.streamSimple(model, context, withSse(options)),
  };
}

/** Only these providers, only this app's encrypted credentials, no ambient API-key fallback. */
export function createOAuthModels(credentials, providers = [openaiCodexAliasProvider(), anthropicProvider(), githubCopilotProvider(), bigModelCodingProvider(credentials)]) {
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  for (const provider of providers) models.setProvider(provider);
  return {
    models,
    async connected(provider) {
      try { return (await credentials.list()).some(item => item.providerId === provider && item.type === 'oauth'); } catch { return false; }
    },
    async catalog(provider, { refresh = false, signal } = {}) {
      if (!isOAuthProvider(provider)) throw new Error('不支持这个账号服务商');
      if (!await this.connected(provider)) throw new Error('请先登录这个账号');
      // 目录一律取 provider 注册表。openai 现在是静态 Codex 目录：api.openai.com/v1/models
      // 与 Codex 令牌受众不符（401），不再做 live 刷新，也不再写 availableModelIds；
      // refresh 参数仅为兼容登录流程的旧调用形态而保留。
      void refresh;
      const available = await models.getAvailable(provider, { signal });
      return available.map(model => ({
        id: model.id, name: model.name, api: model.api, baseUrl: model.baseUrl,
        supportsVision: model.input.includes('image'),
      }));
    },
  };
}
