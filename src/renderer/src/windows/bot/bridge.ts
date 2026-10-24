import type { BotBridge, BotState } from '@shared/bot';
import type {
  HemiVoiceBridge,
  ModelProfilesDirectory,
  ModelProviderView,
} from '@shared/protocol';

export function botModelDirectory(state: BotState): ModelProfilesDirectory {
  const providers = new Map<string, ModelProviderView>();
  for (const model of state.cache?.models ?? []) {
    let p = providers.get(model.providerId);
    if (!p) {
      p = {
        id: model.providerId,
        name: model.name,
        baseUrl: model.baseUrl,
        api: model.api as ModelProviderView['api'],
        hasApiKey: true,
        keyStoredSecurely: true,
        updatedAt: 0,
        models: [],
      };
      providers.set(p.id, p);
    }
    p.models.push({
      id: model.key.slice(model.key.indexOf('/') + 1),
      modelKey: model.key,
      model: model.model,
      thinkingLevel: 'default',
      supportsVision: model.supportsVision,
      visionModel: '',
    });
  }
  return {
    version: 3,
    defaultModelId: state.cache?.defaultModel ?? null,
    lastConversationModelKey: state.cache?.lastConversationModelKey ?? null,
    providers: [...providers.values()],
    roleModels: {},
    envOverride: false,
    corrupt: false,
  };
}

/** No fallback to local conversation/files/permissions. Only explicit desktop presentation actions are shared. */
export function createBotConversationBridge(
  api: BotBridge,
  getState: () => BotState,
  local: HemiVoiceBridge,
): HemiVoiceBridge {
  const identity = getState().binding?.instanceId;
  const command: BotBridge['command'] = (method, params = {}) =>
    api.command(method, { ...params, expectedInstanceId: identity });
  const methods: Record<string, unknown> = {
    bot: api,
    platform: local.platform,
    copyText: local.copyText,
    pathForFile: local.pathForFile,
    openLink: local.openLink,
    openExternal: local.openExternal,
    getKeyboardNavigation: local.getKeyboardNavigation,
    listConversations: async () => ({
      sessions:
        getState().cache?.sessions.map((s) => ({
          ...s,
          status:
            s.waitingPermission || s.status === 'queued' ? 'waiting' : s.status,
          unreadAt: null,
        })) ?? [],
      storageError: null,
    }),
    onConversationsChanged: (callback: () => void) =>
      api.onChanged(() => callback()),
    renameConversation: (id: string, title: string) =>
      command('session.rename', { id, title }),
    removeConversation: (id: string) => command('session.remove', { id }),
    reorderConversations: (ids: string[]) => command('session.order', { ids }),
    markConversationRead: async () => ({ ok: true, unreadAt: null }),
    flowGetSnapshot: (id: string) => command('flow.snapshot', { id }),
    flowCommand: (id: string, flowCommand: Record<string, unknown>) =>
      command('flow.command', { id, command: flowCommand }),
    onFlowChanged: (callback: (value: unknown) => void) => {
      const seen = new Map<string, number>();
      return api.onChanged((state) => {
        for (const detail of Object.values(state.cache?.details ?? {})) {
          if (seen.get(detail.id) === detail.flow.revision) continue;
          seen.set(detail.id, detail.flow.revision);
          callback({
            conversationId: detail.id,
            change: { kind: 'snapshot', snapshot: detail.flow },
          });
        }
      });
    },
    listModelProfiles: async () => botModelDirectory(getState()),
    listSlashCandidates: (id: string) => command('skills', { id }),
    listReferences: (id: string, query: string) =>
      command('references', { id, query }),
    resolveConversationLink: async (id: string, target: string) => {
      try { return await command('file.resolve', { id, path: target }); }
      catch (error) { return { ok: false, message: error instanceof Error ? error.message : '云端文件链接无法打开' }; }
    },
    readConversationDeliverableText: (id: string, artifactId: string, linkPath?: string | null) =>
      command('file.read', { id, artifactId, textOnly: true, ...(linkPath ? { path: linkPath } : {}) }),
    readConversationDeliverable: async (id: string, artifactId: string, linkPath?: string | null) => {
      try {
        const file = await command<Record<string, unknown>>('file.read', {
          id,
          artifactId,
          ...(linkPath ? { path: linkPath } : {}),
        });
        if (file.document) {
          const doc = file.document as { base64?: string };
          file.document = {
            ...doc,
            ...(doc.base64
              ? {
                  bytes: Uint8Array.from(atob(doc.base64), (c) =>
                    c.charCodeAt(0),
                  ),
                }
              : {}),
          };
        }
        return {
          ...file,
          host: getState().binding?.host,
          path: `${getState().binding?.host}:${file.path}`,
        };
      } catch (e) {
        return {
          ok: false,
          message: e instanceof Error ? e.message : '云端文件无法读取',
        };
      }
    },
    listConversationDeliverableApplications: async () => ({
      ok: true,
      applications: [],
      defaultApplication: null,
    }),
    openConversationDeliverable: async (id: string, artifactId: string) => {
      const result = await api.download(id, artifactId);
      return { ...result, canceled: result.cancelled };
    },
    readAttachmentPreview: (id: string, attachmentId: string) =>
      command('attachment.read', { id, attachmentId }),
    readAttachmentDocument: async (id: string, attachmentId: string) => {
      const doc = await command<{
        format: string;
        base64?: string;
        sheets?: unknown[];
      }>('attachment.document', { id, attachmentId });
      return {
        ok: true,
        ...doc,
        ...(doc.base64
          ? { bytes: Uint8Array.from(atob(doc.base64), (c) => c.charCodeAt(0)) }
          : {}),
      };
    },
    openAttachmentSource: async () => ({
      ok: false,
      message: '云端附件在 Hemi 内预览。',
    }),
    accessGetState: async () => ({
      revision: 1,
      health: 'ready',
      resources: [],
      grants: [],
    }),
    onAccessChanged: () => () => {},
  };
  return new Proxy(methods, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in target) return target[key];
      if (key.startsWith('on')) return () => () => {};
      return async () => {
        throw new Error('当前 Bot 尚未提供此云端能力。');
      };
    },
  }) as unknown as HemiVoiceBridge;
}
