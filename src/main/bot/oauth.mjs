import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalSecretStorage } from '../lib/local-secrets.mjs';
import { createOAuthCredentials } from '../services/oauth-credentials.mjs';
import { createOAuthModels, isOAuthProvider, OAUTH_PROVIDERS, withOAuthRuntime } from '../services/oauth-models.mjs';
import { fail } from './storage.mjs';
import { botOAuthFailure } from './oauth-errors.mjs';

// A new authorization is staged in memory. Never copy a desktop's live refresh
// token: the Bot owns this independent session and every subsequent refresh.
export function transientOAuthCredentials(deviceId) {
  const entries = new Map();
  let tail = Promise.resolve();
  return {
    deviceId: async () => deviceId,
    read: async provider => structuredClone(entries.get(provider)),
    list: async () => [...entries.keys()].map(providerId => ({ providerId, type: 'oauth' })),
    modify(provider, update, options) {
      const work = tail.then(async () => {
        options?.signal?.throwIfAborted();
        const next = await update(structuredClone(entries.get(provider)));
        options?.signal?.throwIfAborted();
        if (next) entries.set(provider, structuredClone(next));
        return structuredClone(next ?? entries.get(provider));
      });
      tail = work.catch(() => {});
      return work;
    },
    delete: async provider => { entries.delete(provider); },
    clear: () => entries.clear(),
  };
}

export async function createBotOAuth({ dataDir, validateModel, saveModels }) {
  const credentials = createOAuthCredentials({
    filePath: path.join(dataDir, 'oauth-credentials.json'),
    safeStorage: createLocalSecretStorage({ directory: path.join(dataDir, 'secrets') }),
  });
  const runtime = createOAuthModels(credentials);
  const connected = new Set((await credentials.list()).map(entry => entry.providerId));
  let changing = false;
  return {
    runtime,
    connected: provider => connected.has(provider),
    accounts: () => Object.keys(OAUTH_PROVIDERS).map(provider => ({ provider, connected: connected.has(provider) })),
    prepare: async () => ({ deviceId: await credentials.deviceId() }),
    async import(provider, credential) {
      if (!isOAuthProvider(provider)) fail('不支持这个账号服务商。');
      if (changing) fail('正在更新 Bot 账号，请稍后重试。', 'busy');
      if (!credential || credential.type !== 'oauth' || typeof credential.access !== 'string' || !credential.access || credential.access.length > 32768 || typeof credential.refresh !== 'string' || !credential.refresh || credential.refresh.length > 32768 || !Number.isFinite(credential.expires) || JSON.stringify(credential).length > 131072)
        fail('账号授权凭据无效，请重新登录。');
      changing = true;
      let staged, stage = 'storage';
      try {
        staged = transientOAuthCredentials(await credentials.deviceId());
        await staged.modify(provider, async () => credential);
        const preview = createOAuthModels(staged);
        stage = 'catalog';
        const catalog = await preview.catalog(provider, { refresh: true, signal: AbortSignal.timeout(45000) });
        if (!catalog.length || catalog.length > 1000) fail('账号没有返回 Bot 支持的模型，请检查套餐权限。');
        const providerId = `bot-oauth-${provider}`;
        const configs = catalog.map(model => ({
          providerId, modelKey: `${providerId}/m-${createHash('sha256').update(model.id).digest('hex').slice(0, 24)}`,
          name: OAUTH_PROVIDERS[provider], oauthProvider: provider, apiKey: 'oauth',
          model: model.id, api: model.api, baseUrl: model.baseUrl, supportsVision: model.supportsVision,
          thinkingLevel: 'default',
        }));
        // The actual SDK and native account transport run on the server before
        // installation; catalog presence alone does not prove inference works.
        stage = 'inference';
        const signal = AbortSignal.timeout(45000);
        await withOAuthRuntime(preview, async () => {
          let unavailable;
          for (const config of configs) {
            signal.throwIfAborted();
            try { await validateModel(config, {signal}); return; }
            catch (error) {
              // A static catalog can include models unavailable to this plan.
              // Only an explicit model rejection permits another candidate;
              // auth, quota, networking and service failures stop immediately.
              if (botOAuthFailure(error, stage).reason !== 'model') throw error;
              unavailable = error;
            }
          }
          throw unavailable;
        });
        stage = 'storage';
        const previous = await credentials.read(provider);
        await credentials.modify(provider, async () => await staged.read(provider));
        connected.add(provider);
        stage = 'save';
        try { await saveModels(providerId, configs); }
        catch (error) {
          if (previous) await credentials.modify(provider, async () => previous);
          else { await credentials.delete(provider); connected.delete(provider); }
          throw error;
        }
        return { ok: true, providerId };
      } catch (error) {
        fail(botOAuthFailure(error, stage).message);
      } finally { staged?.clear(); changing = false; }
    },
    async logout(provider) {
      if (!isOAuthProvider(provider)) fail('不支持这个账号服务商。');
      if (changing) fail('正在更新 Bot 账号，请稍后重试。', 'busy');
      changing = true;
      try { await runtime.models.logout(provider); connected.delete(provider); return { ok: true }; }
      finally { changing = false; }
    },
  };
}
