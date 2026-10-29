/** Shared client protocol. Runtime transport and server execution are supplied by the host. */
import type {MessageAttachmentView, MessageReferenceView, SkillSelectionView, RunActivityView, ModelRecoveryView} from '../types/presentation.js';
export type FlowPhase = 'idle' | 'preparing' | 'running' | 'stopping';
export type TurnQueueItemView = {
  /** Present only for a client outbox item that upstream has not accepted. */
  operationId?: string;
  readOnly?: boolean;
  queueItemId: string;
  conversationId: string;
  text: string;
  revision: number;
  /** 托盘只收 pending（submitting＝已转正上屏，行即刻消失——2026-10-16 用户裁决）。 */
  dispatchState: 'pending' | 'editing' | 'promoting' | 'sending';
  error: string;
  attachmentIds: string[];
  references: Array<{ kind: string; [key: string]: unknown }>;
  /** 063：随条目冻结的显式技能标签（待发送区与正式消息同一标签语义）。 */
  skills?: SkillSelectionView[];
  inputSource?: 'text' | 'voice';
  createdAt: number;
};

export type TurnQueueState = { paused: boolean; items: TurnQueueItemView[] };

export type FlowSnapshotView = {
  schemaVersion: number;
  conversationId: string;
  revision: number;
  generation: number;
  phase: FlowPhase;
  activeRunId: string | null;
  awaitingUser?: {runId:string;question:string;reason:string} | null;
  queuePaused: boolean;
  pending: FlowInputView[];
  timeline: FlowItemView[];
  runs: Record<string, Record<string, unknown> & { activity?: RunActivityView | null; recovery?: ModelRecoveryView }>;
  tasks: Record<string, Record<string, unknown>>;
  artifacts: Record<string, Record<string, unknown>>;
  permissions: Record<string, Record<string, unknown>>;
  pendingReports: Array<{ taskId: string; resultVersion: number }>;
  /** Negotiated active window; older items remain available through history paging. */
  history?: {start:number;total:number};
};
export type FlowHistoryPage = {conversationId:string;generation:number;revision:number;start:number;end:number;total:number;snapshot:FlowSnapshotView};

export type FlowInputView = {
  workflow?: {invocationId:string;workflowId?:string;workflowRunId?:string};
  inputId: string;
  editRevision: number;
  text: string;
  inputSource: 'text' | 'voice';
  attachmentIds: string[];
  attachmentViews?: MessageAttachmentView[];
  state: 'pending' | 'submitting' | 'needs-review' | 'editing';
  promoteAt?: number | null;
  references?: MessageReferenceView[];
  /** 063：随输入提交的显式技能选择（行内标签身份）。 */
  skills?: SkillSelectionView[];
  editDraft?: { text: string; attachmentIds: string[]; attachmentViews: MessageAttachmentView[]; references: MessageReferenceView[]; skills?: SkillSelectionView[] };
  editDraftRevision?: number;
  targetRunId?: string | null;
  createdAt?: number;
};

export type FlowItemView =
  | {
      id: string;
      kind: 'user';
      runId: string;
      text: string;
      inputSource: 'text' | 'voice';
      attachmentIds: string[];
      attachments?: MessageAttachmentView[];
      /** 063：随消息冻结的引用与技能标签（正式流用户项回显用）。 */
      references?: MessageReferenceView[];
      skills?: SkillSelectionView[];
      acceptedAt: number | null;
      deliveredAt: number | null;
      /** 060 R-11：显式并入投递的输入（挂在目标运行上）；渲染层据此放行转正上屏。 */
      mergedInto?: string;
    }
  | {
      itemId: string;
      kind: 'assistant';
      runId: string;
      afterInputId: string | null;
      parts: Array<{ partId: string; kind: string } & Record<string, unknown>>;
    };

export type FlowChangeView = { conversationStatus?: unknown } & (
  | { kind: 'snapshot'; snapshot: FlowSnapshotView; epoch?: string }
  | {
      kind: 'patch';
      conversationId: string;
      generation: number;
      baseRevision: number;
      revision: number;
      changes: Array<{ kind: string } & Record<string, unknown>>;
    });

export type ConversationDeliverableView = {
  artifactId: string;
  kind: 'file';
  name: string;
  path: string;
  host?: string | null;
  description?: string;
  previewKind?: 'text' | 'image' | 'video' | 'unsupported';
  size?: number | null;
  producerRunId?: string | null;
  taskId?: string | null;
  producers?: Array<{ runId: string | null; taskId: string | null; generation: number | null; at: number }>;
  contentVersion?: number;
  registeredAt?: number;
};

export type FlowCommandResult = {
  data?: {text?:string;next?:number;total?:number;lossy?:boolean;accepted?:boolean};
  ok: boolean;
  code?: string;
  disposition?: string;
  inputId?: string;
  runId?: string | null;
  revision?: number;
  message?: string;
  input?: FlowInputView;
};
