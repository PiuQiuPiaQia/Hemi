import type {
  FlowSnapshotView,
  MessageAttachmentView,
  MessageReferenceView,
  SkillSelectionView,
  ModelProviderSaveInput,
} from './protocol';
import type {BotDeviceAccess} from './bot-pairing';
export type BotModel = {
  key: string;
  providerId: string;
  name: string;
  model: string;
  baseUrl: string;
  api: string;
  supportsVision: boolean;
  revision: string;
};
export type BotDraft = {
  text: string;
  revision: number;
  references: MessageReferenceView[];
  skills: SkillSelectionView[];
  attachmentIds: string[];
};
export type BotSession = {
  id: string;
  title: string;
  dir: string;
  modelKey: string;
  thinking: 'default' | 'off' | 'low' | 'medium' | 'high';
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  status: 'queued' | 'running' | null;
  waitingPermission: boolean;
};
export type BotPermission = {
  kind?: 'grant' | 'action';
  tool?: string;
  args?: Record<string, unknown>;
  note?: string;
  id: string;
  title: string;
  options: string[];
  runId: string;
  generation: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
};
export type BotDetail = BotSession & {
  draft: BotDraft;
  flow: FlowSnapshotView;
  attachments: MessageAttachmentView[];
  permissions: Record<string, BotPermission>;
  usage: Array<{
    modelKey: string;
    modelName: string;
    at: number;
    usageDetail: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      genMs: number;
    } | null;
  }>;
};
export type BotBinding = {
  host: string;
  instanceId: string;
  protocol: number;
  version: string;
  home: string;
  dataDir: string;
  boundAt: number;
};
export type BotCache = {
  deviceAccess?: BotDeviceAccess;
  selectedId?: string | null;
  instanceId: string;
  revision: number;
  enabled: boolean;
  defaultDir: string;
  defaultModel: string;
  lastConversationModelKey?: string | null;
  recentDirs: string[];
  models: BotModel[];
  sessions: BotSession[];
  details: Record<string, BotDetail>;
};
export type BotProbe = {
  home: string;
  root: string;
  node: string;
  arch: string;
  runtimeNeeded?: boolean;
  existing: boolean;
  serviceError?: string;
  bot?: {
    instanceId: string;
    bootId?: string;
    protocol: number;
    version: string;
    configured: boolean;
    enabled: boolean;
  };
};
export type BotSyncStatus = {
  instanceId: string;
  requestId: string;
  keys: string[];
  phase: 'sending' | 'unknown' | 'confirmed' | 'not-received' | 'interrupted';
  at: number;
  results?: Array<{ key: string; ok: boolean; message?: string }>;
};
export type BotState = {
  binding: BotBinding | null;
  online: boolean;
  error: string;
  busy: string;
  lastConnectedAt: number | null;
  stoppedConfirmed?: boolean;
  syncStatus?: BotSyncStatus | null;
  cache: BotCache | null;
  candidate: { id: string; host: string; info: BotProbe } | null;
};
export type BotModelCandidate = {
  key: string;
  name: string;
  provider: string;
  auth: string;
  canSync: boolean;
  reason: string;
  revision: string | null;
  status: 'new' | 'update' | 'synced';
};
export type BotDirectory = {
  path: string;
  parent: string;
  home: string;
  folders: Array<{ name: string; path: string }>;
  truncated?: boolean;
};
export type BotMethod =
  | 'pairing.status'
  | 'pairing.operation'
  | 'pairing.configure'
  | 'pairing.disable'
  | 'pairing.create'
  | 'pairing.approve'
  | 'pairing.reject'
  | 'pairing.cancel'
  | 'devices.list'
  | 'devices.revoke'
  | 'snapshot'
  | 'session.open'
  | 'session.create'
  | 'session.update'
  | 'session.rename'
  | 'session.remove'
  | 'session.order'
  | 'session.draft'
  | 'flow.command'
  | 'flow.snapshot'
  | 'permission.decide'
  | 'directory.list'
  | 'attachment.read'
  | 'attachment.document'
  | 'file.read'
  | 'file.resolve'
  | 'references'
  | 'skills'
  | 'models.sync'
  | 'models.add'
  | 'models.test'
  | 'models.list'
  | 'connection.reconnect'
  | 'connection.disconnect'
  | 'connection.remove'
  | 'service.start'
  | 'service.stop'
  | 'candidate.start'
  | 'initialization.cancel'
  | 'attachment.cancel'
  | 'attachment.retry'
  | 'connection.forget'
  | 'connection.address'
  | 'operation.get'
  | 'models.reconcile'
  | 'models.dismiss'
  | 'component.update'
  | 'diagnostics'
  | 'diagnostics.export';
export type BotBridge = {
  getState: () => Promise<BotState>;
  connect: (p: {
    host: string;
    password?: string;
    rememberPassword?: boolean;
  }) => Promise<BotState>;
  initialize: (p: {
    candidateId: string;
    modelKeys?: string[];
    provider?: ModelProviderSaveInput;
    existing?: boolean;
    requestId?: string;
  }) => Promise<BotState>;
  models: () => Promise<BotModelCandidate[]>;
  directory: (candidateId: string, path: string) => Promise<BotDirectory>;
  command: <T = unknown>(
    method: BotMethod,
    params?: Record<string, unknown>,
  ) => Promise<T>;
  commandResult?: <T = unknown>(
    method: BotMethod,
    params?: Record<string, unknown>,
  ) => Promise<{ok: true; result: T} | {ok: false; code: string; message: string}>;
  upload: (p: {
    id: string;
    filePath?: string;
    dataUrl?: string;
    requestId?: string;
  }) => Promise<{ cancelled?: boolean; attachments?: MessageAttachmentView[] }>;
  download: (
    id: string,
    artifactId: string,
  ) => Promise<{ ok: boolean; cancelled?: boolean; path?: string }>;
  environment: (
    environment: 'bot' | 'local',
  ) => Promise<{ environment: 'bot' | 'local' }>;
  onChanged: (callback: (state: BotState) => void) => () => void;
};
