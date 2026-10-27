import { createModels } from '@earendil-works/pi-ai';
import { getApiProvider, registerApiProvider } from '@earendil-works/pi-ai/compat';
import { AsyncLocalStorage } from 'node:async_hooks';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
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

/** Only these providers, only this app's encrypted credentials, no ambient API-key fallback. */
export function createOAuthModels(credentials, providers = [openaiProvider(), anthropicProvider(), githubCopilotProvider(), bigModelCodingProvider(credentials)]) {
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
      if (provider === 'openai' && refresh) {
        const auth = await models.getAuth(provider, { signal });
        const response = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${auth.auth.apiKey}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
        if (!response.ok) {
          const detail = await response.json().catch(() => null);
          throw Object.assign(new Error(`ChatGPT 模型目录读取失败（HTTP ${response.status}），请检查账号权限或重新登录。`),
            { status: response.status, providerCode: detail?.error?.code });
        }
        const data = await response.json();
        if (!Array.isArray(data.models)) throw new Error('ChatGPT 模型目录格式无效');
        const availableModelIds = data.models.filter(item => item.visibility === 'list' && typeof item.slug === 'string').map(item => item.slug);
        await credentials.modify(provider, async current => current ? { ...current, availableModelIds } : undefined, { signal });
      }
      const credential = provider === 'openai' ? await credentials.read(provider) : null;
      let available = await models.getAvailable(provider);
      if (Array.isArray(credential?.availableModelIds)) {
        const catalog = new Map(available.map(model => [model.id, model]));
        available = credential.availableModelIds.map(id => catalog.get(id)).filter(Boolean);
      }
      return available.map(model => ({
        id: model.id, name: model.name, api: model.api, baseUrl: model.baseUrl,
        supportsVision: model.input.includes('image'),
      }));
    },
  };
}
