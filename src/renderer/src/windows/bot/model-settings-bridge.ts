import type { BotBridge, BotState } from '@shared/bot';
import type { HemiVoiceBridge, RoleModelsView } from '@shared/protocol';
import { botModelDirectory, callBot } from './bridge';

/** Model settings use the same UI with explicit Bot commands; never local model APIs. */
export function createBotModelSettingsBridge(api: BotBridge, getState: () => BotState): HemiVoiceBridge {
  const identity = getState().binding?.instanceId;
  const modelRevision = getState().cache?.modelConfigRevision;
  const command = <T,>(method: Parameters<BotBridge['command']>[0], params: Record<string, unknown> = {}) =>
    callBot<T>(api, method, { ...params, expectedInstanceId: identity });
  const methods: Partial<HemiVoiceBridge> = {
    listModelProfiles: async () => botModelDirectory(getState()),
    getRoleModels: () => command('models.roles'),
    saveRoleModel: async patch => {
      await command('models.routing', { roleModels: patch, expectedModelRevision: modelRevision, requestId: crypto.randomUUID() });
      return { ok: true, ...await command<RoleModelsView>('models.roles') };
    },
    saveModelProfile: async provider => {
      const result = await command<{ ok?: boolean; results?: Array<{ok: boolean; message?: string}>; providerId?: string; modelKeys?: string[] }>(provider.id ? 'models.save' : 'models.add', {
        provider, expectedModelRevision: modelRevision, requestId: crypto.randomUUID(),
      });
      const failed = result.results?.find(item => !item.ok); if (failed) throw new Error(failed.message ?? 'Bot 未能验证模型。');
      return { ok: true, providerId: result.providerId ?? provider.id ?? '', modelKeys: result.modelKeys ?? [] };
    },
    removeModelProfile: async params => {
      await command('models.remove', { ...params, expectedModelRevision: modelRevision, requestId: crypto.randomUUID() });
      return { ok: true };
    },
    testModelProfile: config => command('models.test', config.modelKey ? { modelKey: config.modelKey } : { config }),
    listRemoteModels: async config => {
      const first = getState().cache?.models.find(model => model.providerId === config.providerId);
      const result = await command<{ ok: boolean; models?: string[]; error?: string }>('models.list', first ? { modelKey: first.key } : { config });
      if (!result.ok) throw new Error(result.error ?? 'Bot 无法获取型号。');
      return { ok: true, models: result.models ?? [] };
    },
    getOAuthLoginState: () => command('oauth.state'),
    startOAuthLogin: provider => command('oauth.start', { provider }),
    answerOAuthLogin: payload => command('oauth.answer', payload),
    cancelOAuthLogin: id => command('oauth.cancel', { id }),
    logoutOAuth: provider => command('oauth.logout', { provider }),
  };
  return new Proxy(methods, { get(target, key) {
    if (key in target) return target[key as keyof HemiVoiceBridge];
    return async () => { throw new Error('此模型设置能力尚未由 Bot 提供。'); };
  } }) as HemiVoiceBridge;
}
