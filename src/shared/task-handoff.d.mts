export interface TaskSubmission {
  version: 1;
  summary: string;
  completed: string[];
  remaining: string[];
  blockers: string[];
  verification: Array<{check: string; status: 'passed' | 'failed' | 'not_run'; evidence: string}>;
  nextAction: string;
}
export interface TaskHandoff {
  protocol: 'hemi.task-handoff';
  version: 1;
  owner: {conversationId: string | null; rootRunId: string | null; generation: number; taskId: string; sessionRef: string | null};
  execution: {outcome: string; reason: string | null; pendingBackground: boolean};
  submission: {status: 'submitted' | 'missing' | 'interrupted' | 'legacy'; data: TaskSubmission | null};
  evidence: {reportRef: string | null; artifacts: unknown[]; toolEvidence: unknown[]; fileChanges: string[]; usage: unknown; durationMs: number | null};
}
export const TASK_HANDOFF_PROTOCOL: 'hemi.task-handoff';
export const TASK_HANDOFF_VERSION: 1;
export const TASK_HANDOFF_TOOL: 'submit_task_result';
export const MAX_HANDOFF_BYTES: number;
export const TASK_SUBMISSION_SCHEMA: object;
export const TASK_HANDOFF_GUIDANCE: string;
export function parseTaskSubmission(value: unknown): TaskSubmission;
export function taskSubmissionText(value: TaskSubmission): string;
export type TaskOwner = Pick<TaskHandoff['owner'], 'conversationId' | 'rootRunId' | 'generation' | 'taskId'>;
export interface TaskHandoffResult {
  taskId: string;
  outcome: string;
  outcomeReason?: string | null;
  sessionRef?: string | null;
  reportRef?: string | null;
  artifacts?: unknown[];
  toolEvidence?: unknown[];
  fileChanges?: string[];
  usage?: unknown;
  durationMs?: number;
  handoff?: unknown;
}
export function createTaskHandoff(result: TaskHandoffResult, options?: {
  owner?: Partial<TaskOwner>; data?: TaskSubmission | null; status?: TaskHandoff['submission']['status']; pendingBackground?: boolean;
}): TaskHandoff;
export function readTaskHandoff(result: TaskHandoffResult, owner?: TaskOwner | null): TaskHandoff;
export function createTaskRequest(options: {
  owner: Partial<TaskHandoff['owner']> & {historyId?: string; key?: string};
  prompt: string; description?: string; contextRefs?: string[];
}): {protocol: 'hemi.task-request'; version: 1; source: 'coordinator'; owner: TaskHandoff['owner'];
  assignment: {objective: string; description: string; contextRefs: string[]}; trust: string};
