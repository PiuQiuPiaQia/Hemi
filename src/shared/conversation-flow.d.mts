/**
 * 057 对话流纯归约模块的类型声明（.mjs 实现见 conversation-flow.mjs；
 * 声明跟实现的口径以实现文件头注为准——渲染层 import 需要）。
 */
export type FlowPhase = 'idle' | 'preparing' | 'running' | 'stopping';

export type FlowInputState = 'pending' | 'submitting' | 'needs-review';

export type FlowInput = {
  inputId: string;
  editRevision: number;
  text: string;
  inputSource: 'text' | 'voice';
  attachmentIds: string[];
  modelPolicySnapshot?: Record<string, unknown>;
  attachmentViews?: Array<{ attachmentId: string; name: string; kind: string; [key: string]: unknown }>;
  workflow?: {invocationId:string;workflowId?:string;workflowRunId?:string};
  references: unknown;
  state?: FlowInputState;
  targetRunId?: string | null;
  createdAt?: number;
};

export type FlowRunSummary = {
  runId: string;
  recovery?: import('@hemi/conversation-flow').ModelRecoveryView;
  generation: number;
  source: 'user' | 'queue' | 'event';
  inputIds: string[];
  startedAt: number | null;
  endedAt: number | null;
  closedAt: number | null;
  outcome: 'completed' | 'partial' | 'stopped' | 'failed' | 'interrupted' | 'unknown' | null;
  modelUsed?: string | null;
  [key: string]: unknown;
};

export type FlowPart =
  | { partId: string; kind: 'text' | 'thinking'; content: string }
  | { partId: string; kind: 'tool'; toolCallId: string; status: string; [key: string]: unknown }
  | { partId: string; kind: 'delegation' | 'artifact' | 'notice'; [key: string]: unknown }
  | {
      partId: string;
      kind: 'workflow-card';
      invocationId: string;
      workflowId?: string | null;
      workflowRunId?: string | null;
      title?: string;
      status: string;
      [key: string]: unknown;
    };

export type FlowItem =
  | {
      id: string;
      kind: 'user';
      runId: string;
      text: string;
      inputSource: 'text' | 'voice';
      attachmentIds: string[];
      attachments?: Array<{ attachmentId: string; name: string; kind: string; [key: string]: unknown }>;
      acceptedAt: number | null;
      deliveredAt: number | null;
    }
  | {
      itemId: string;
      kind: 'assistant';
      runId: string;
      afterInputId: string | null;
      parts: FlowPart[];
    };

export type FlowSnapshot = {
  schemaVersion: number;
  conversationId: string;
  revision: number;
  generation: number;
  phase: FlowPhase;
  activeRunId: string | null;
  queuePaused: boolean;
  pending: Array<FlowInput & { state: FlowInputState }>;
  timeline: FlowItem[];
  runs: Record<string, FlowRunSummary>;
  tasks: Record<string, Record<string, unknown>>;
  artifacts: Record<string, Record<string, unknown>>;
  permissions: Record<string, Record<string, unknown>>;
  pendingReports: Array<{ taskId: string; resultVersion: number }>;
};

export type FlowPatch =
  | { kind: 'meta'; meta: { phase: FlowPhase; activeRunId: string | null; queuePaused: boolean; generation: number } }
  | { kind: 'queue'; pending: FlowSnapshot['pending'] }
  | { kind: 'timeline'; timeline: FlowItem[] }
  | { kind: 'item-appended'; item: FlowItem }
  | { kind: 'item-updated'; item: FlowItem }
  | { kind: 'runs' | 'tasks' | 'artifacts' | 'permissions'; [key: string]: unknown }
  | { kind: 'reports'; pendingReports: FlowSnapshot['pendingReports'] }
  | { kind: 'multi'; changes: FlowPatch[] };

export type FlowChange =
  | { kind: 'snapshot'; snapshot: FlowSnapshot }
  | {
      kind: 'patch';
      conversationId: string;
      generation: number;
      baseRevision: number;
      revision: number;
      changes: FlowPatch[];
    };

export type FlowFactResult = {
  snapshot: FlowSnapshot;
  patch: FlowPatch | null;
  applied: boolean;
  dropped?: string;
};

export const FLOW_SCHEMA_VERSION: number;
export const PENDING_CAPACITY: number;
export const FLOW_PHASES: FlowPhase[];

export function createFlowSnapshot(options: { conversationId: string; revision?: number; generation?: number }): FlowSnapshot;
export function applyFlowFact(snapshot: FlowSnapshot, fact: Record<string, unknown>): FlowFactResult;
export function applyFlowChange(snapshot: FlowSnapshot, change: FlowChange): { ok: boolean; snapshot?: FlowSnapshot; code?: string };
export function coalesceFlowChanges(first: FlowChange | null, second: FlowChange): FlowChange;
