import type { BotBridge, BotMethod, BotState } from '@shared/bot';
import {removeConversationOperations} from '../voice/lib/conversation-operation-storage.ts';
import type {
  HemiVoiceBridge,
  ModelProfilesDirectory,
  ModelProviderView,
  FlowCommandResult,
} from '@shared/protocol';

export async function callBot<T>(api: BotBridge, method: BotMethod, params: Record<string, unknown> = {}): Promise<T> {
  if (!api.commandResult) return api.command<T>(method, params);
  const reply = await api.commandResult<T>(method, params);
  if (!reply.ok) throw Object.assign(new Error(reply.message), { code: reply.code });
  return reply.result;
}

export function botModelDirectory(state: BotState): ModelProfilesDirectory {
  const providers = new Map<string, ModelProviderView>();
  for (const model of state.cache?.models ?? []) {
    let p = providers.get(model.providerId);
    if (!p) {
      p = {
        source: model.source ?? 'local',
        id: model.providerId, name: model.name, baseUrl: model.baseUrl,
        api: model.api as ModelProviderView['api'], hasApiKey: model.oauthConnected !== false,
        ...(model.oauthProvider ? { oauthProvider: model.oauthProvider } : {}),
        ...(model.configuration ? { configuration: model.configuration } : {}),
        keyStoredSecurely: model.keyStoredSecurely === true, updatedAt: 0, models: [],
      };
      providers.set(p.id, p);
    }
    p.models.push({
      id: model.key.slice(model.key.indexOf('/') + 1), modelKey: model.key,
      model: model.model, thinkingLevel: model.thinkingLevel ?? 'default',
      supportsVision: model.supportsVision, visionModel: '',
    });
  }
  return {
    version: 3,
    defaultModelId: state.cache?.defaultModel ?? null,
    lastConversationModelKey: state.cache?.lastConversationModelKey ?? null,
    providers: [...providers.values()],
    roleModels: state.cache?.roleModels ?? {},
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
  const command: BotBridge['command'] = async (method, params = {}) => {
    const request = {...params, expectedInstanceId: identity};
    if (!api.commandResult) return api.command(method, request);
    const reply = await api.commandResult(method, request);
    if (!reply.ok) throw Object.assign(new Error(reply.message), {code: reply.code});
    return reply.result as never;
  };
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
            s.waitingPermission ? 'waiting' : s.status,
          unreadAt: null,
        })) ?? [],
      storageError: null,
    }),
    onConversationsChanged: (callback: () => void) =>
      api.onChanged(() => callback()),
    renameConversation: (id: string, title: string) =>
      command('session.rename', { id, title }),
    setConversationPinned: (id: string, pinned: boolean) => command('session.pin', { id, pinned }),
    removeConversation: async (id: string) => {
      const result = await command('session.remove', {id});
      removeConversationOperations({environmentId: `bot:${identity}`, conversationId: id});
      return result;
    },
    reorderConversations: (ids: string[]) => command('session.order', { ids }),
    markConversationRead: async () => ({ ok: true, unreadAt: null }),
    flowGetHistory:(id:string,cursor:{before:number;generation:number})=>command('flow.history',{id,...cursor}),
    flowGetSnapshot: (id: string) => command('flow.snapshot', { id }),
    flowCommand: async (id: string, flowCommand: Record<string, unknown>, operation?: {requestId: string; generation: number | null}) => {
      const snapshot=getState().cache?.details[id]?.flow;
      const {controlEpoch, ...next}=flowCommand;
      if(['beginEditInput','finishEditInput','updateInput'].includes(String(next.type)) && next.expectedEditRevision===undefined)next.expectedEditRevision=snapshot?.pending.find(item=>item.inputId===next.inputId)?.editRevision;
      if(next.type==='stop' && next.targetRunId===undefined)next.targetRunId=snapshot?.activeRunId;
      try {
        const result = await command<FlowCommandResult>('flow.command', {id, command: next,
          generation: operation?.generation ?? snapshot?.generation, ...(controlEpoch ? {controlEpoch} : {}),
          ...(operation ? {requestId: operation.requestId} : {})});
        return next.type === 'stop' && result.code === 'run-changed' ? {ok: true, disposition: 'already-stopped'} : result;
      } catch (error) {
        const code = (error as {code?: string}).code;
        if (!code) throw error;
        return {ok: false, code, message: error instanceof Error ? error.message : String(error)};
      }
    },
    flowLookupOperation: async (_id: string, requestId: string) => {
      const receipt=await command('operation.get',{operationId:requestId}) as {status:string;result?:{ok:boolean}};
      if (receipt.status === 'done') return receipt.result ?? null;
      return receipt.status === 'interrupted'
        ? {ok: false, code: 'rejected', message: '云端上次提交已中断，内容已保留，可以重新发送。'} : null;
    },
    onFlowDisconnected: (receive: () => void) => api.onChanged(state=>{if(!state.online)receive();}),
    onFlowChanged: (callback: (value: unknown) => void) => {
      const seen = new Map<string, string>();
      return api.onChanged((state) => {
        for (const detail of Object.values(state.cache?.details ?? {})) {
          const version=`${state.cache?.bootId??''}:${detail.flow.revision}`;
          if (seen.get(detail.id) === version) continue;
          seen.set(detail.id, version);
          callback({
            conversationId: detail.id,
            change: { kind: 'snapshot', snapshot: detail.flow, epoch: state.cache?.bootId },
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
