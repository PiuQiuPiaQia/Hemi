import type {MobileResourceTransfers} from './bot/resource-host';
import type {MobileUpload} from './bot/attachment-uploads';
import type {ConversationClient} from '@hemi/conversation-flow/core';
import type {ConversationFlowHost, FlowActionHandler} from '@hemi/conversation-flow';

export type MobileThinking = 'default' | 'off' | 'low' | 'medium' | 'high';
export type MobileConversation = {id: string; title: string; pinned: boolean; model: string; thinking: MobileThinking; directory: string; running: boolean};
export type MobileModel = {id: string; name: string; description?: string};
export type MobileDirectory = {path: string; parent: string; home: string; folders: Array<{name: string; path: string}>; truncated?: boolean};
export type MobileSessionPatch = Partial<Pick<MobileConversation, 'model' | 'thinking' | 'directory'>>;
export type MobileWorkspaceSnapshot = {
  uploads?: MobileUpload[];
  permissions?: Array<{id: string; conversationId: string; title: string; options: string[]}>;
  items: MobileConversation[];
  activeId: string | null;
  models: MobileModel[];
  defaultDirectory?: string;
  recentDirectories?: string[];
  botName: string;
  offline: boolean;
  error: string;
};

/** An authenticated Bot supplies navigation metadata and stable SDK clients. */
export interface MobileWorkspace {
  environmentId: string;
  host?: ConversationFlowHost;
  resources?: ConversationFlowHost['resources'];
  resourceTransfers?: MobileResourceTransfers;
  onAction?: FlowActionHandler;
  getSnapshot(): MobileWorkspaceSnapshot;
  subscribe(listener: () => void): () => void;
  retain(): () => void;
  getClient(conversationId: string): ConversationClient;
  select(conversationId: string): void;
  create(): Promise<string>;
  update(conversationId: string, patch: MobileSessionPatch): Promise<void>;
  listDirectories(path: string, signal?: AbortSignal): Promise<MobileDirectory>;
  attachmentsAvailable?: boolean;
  pickAttachments?(id: string, kind: 'photos'|'files'): Promise<void>;
  retryUpload?(id: string): void;
  cancelUpload?(id: string): Promise<void>;
  reconnect?(): Promise<void>;
  decidePermission?(permissionId: string, value: string): Promise<void>;
  dispose?(): void;
}
