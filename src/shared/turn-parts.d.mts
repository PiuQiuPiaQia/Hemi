export type TurnToolCall = {
  id: string;
  tool: string;
  args: Record<string, string | number | boolean>;
  state: 'running' | 'done' | 'error';
};
export type WorkflowInteractionField = {
  fieldId: string;
  key: string;
  label: string;
  type: 'text' | 'choice' | 'file' | 'files';
  required: boolean;
  options?: string[];
  optionsError?: string;
  prefill?: string;
};
export type WorkflowInteractionProjection = {
  interactionId: string;
  nodeId: string;
  title: string;
  status: 'open' | 'responded' | 'expired' | 'cancelled';
  content: string;
  contentIssues: string[];
  fields: WorkflowInteractionField[];
  actions: Array<{ actionId: string; label: string; primary: boolean; requiredKeys: string[]; nextTitle?: string | null }>;
  timeoutNextTitle?: string | null;
  hasTimeout: boolean;
  expiresAt: number | null;
  revision: number;
  draft: { values: Record<string, unknown>; savedAt: number } | null;
  response: {
    actionId: string;
    actionLabel: string;
    values: Record<string, unknown>;
    submittedAt: number;
    source: 'user' | 'timeout';
  } | null;
};
export type WorkflowCardView = {
  invocationId: string;
  title: string;
  status: string;
  currentNodeId?: string;
  values?: Record<string, unknown>;
  issues?: Array<{ code: string; message: string; field?: string }>;
  ready?: boolean;
  outputs?: Record<string, unknown>;
  error?: string;
  /** 人工输入挂起时的表单／已提交只读记录（与 protocol.ts 同形）。 */
  interaction?: WorkflowInteractionProjection;
};
export type TurnPart =
  | { type: 'thinking'; text: string; startedAt: number; endedAt: number | null; interrupted?: boolean }
  | { type: 'text'; text: string }
  | { type: 'tools'; calls: TurnToolCall[] }
  /** 059 执行卡：流式归约不产出（卡片只来自 flow 投影），类型层与 protocol 同形。 */
  | { type: 'workflow-card'; card: WorkflowCardView };
export function reduceTurnParts(parts: TurnPart[] | null | undefined, event: { kind: string; [key: string]: unknown }, now?: number): TurnPart[];
export function finalizeTurnParts(parts: TurnPart[] | null | undefined, now?: number, options?: { interrupted?: boolean }): TurnPart[];
export function hasNonTextParts(parts: TurnPart[] | null | undefined): boolean;
