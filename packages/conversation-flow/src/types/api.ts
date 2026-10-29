export type {ModelRecoveryView} from "./presentation.js";
import type { CSSProperties, Ref } from "react";
import type {
  TranscriptItem,
  TaskStateSnapshot,
  TurnPart,
  ModelProfilesDirectory,
  WorkflowInputParameter,
  WorkflowInteractionProjection,
  RunActivityView,
  TaskPermissionChoice,
} from "./presentation.js";

export interface FlowScope {
  environmentId: string;
  conversationId: string;
  generation: string;
}
export type FlowErrorCode =
  | "unsupported"
  | "denied"
  | "cancelled"
  | "not-found"
  | "offline"
  | "expired"
  | "conflict"
  | "failed"
  | "unknown";
export type FlowResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: { code: FlowErrorCode; message: string; retryable?: boolean };
    };
export interface HostContext {
  scope: FlowScope;
  requestId: string;
  signal: AbortSignal;
}
export interface ResourceRef {
  id: string;
  version: string;
}
export interface ResourceLease {
  ref: ResourceRef;
  metadata?: { name?: string; size?: number };
  content:
    | { kind: "text"; text: string; mimeType: string }
    | { kind: "url"; url: string; mimeType: string }
    | { kind: 'document'; source: ResourceDocument };
  release(): void;
}
export type ResourceDocument = {
  format: 'pdf' | 'docx' | 'xlsx' | 'pptx';
  bytes?: Uint8Array;
  sheets?: Array<{name: string; rows: Array<Array<{address: string; value: string; formula?: string}>>; truncated: boolean}>;
  text?: string;
  textError?: string;
};
export interface ResourceActionView {
  id: string;
  kind: "save" | "share" | "reveal" | "open-with";
  label: string;
  disabledReason?: string;
  isDefault?: boolean;
  iconUrl?: string;
}
export interface ConversationFlowHost {
  version: 1;
  capabilities: Readonly<{
    copyText: boolean;
    openLink: boolean;
    resolveResource: boolean;
    readResource: boolean;
    resourceActions: boolean;
  }>;
  copyText?(
    input: { text: string },
    context: HostContext,
  ): Promise<FlowResult<void>>;
  openLink?(
    input: { url: string },
    context: HostContext,
  ): Promise<FlowResult<void>>;
  resources?: {
    resolve?(
      input: { href: string },
      context: HostContext,
    ): Promise<FlowResult<ResourceRef>>;
    read?(
      input: { ref: ResourceRef; purpose: "thumbnail" | "preview" },
      context: HostContext,
    ): Promise<FlowResult<ResourceLease>>;
    listActions?(
      input: { ref: ResourceRef },
      context: HostContext,
    ): Promise<FlowResult<readonly ResourceActionView[]>>;
    perform?(
      input: { ref: ResourceRef; actionId: string },
      context: HostContext,
    ): Promise<FlowResult<void>>;
  };
}

export type TaskView = Pick<
  TaskStateSnapshot,
  "phase" | "outcome" | "taskText"
> &
  Partial<
    Pick<
      TaskStateSnapshot,
      | "seq"
      | "key"
      | "taskId"
      | "conversationId"
      | "agent"
      | "agentTitle"
      | "toolCallId"
      | "background"
      | "startedAt"
      | "endedAt"
      | "progressText"
      | "conversation"
      | "activity"
      | "readOnly"
      | "verifying"
      | "verified"
      | "permission"
      | "log"
      | "resultText"
      | "outcomeReason"
      | "verification"
      | "artifacts"
      | "lastAction"
      | "runs"
      | "notices"
      | "fileChanges"
      | "sources"
      | "resultVersion"
      | "bodySource"
      | "delivery"
      | "approvals"
    >
  >;
export interface WorkflowPresentationView {
  revision?: number;
  outline: string;
  labels: Record<string, string>;
  nodeTitle: string;
  resumeFields: Record<string, { type: string }>;
  parameters: WorkflowInputParameter[];
  models: ModelProfilesDirectory | null;
  loading?: boolean;
  error?: string;
}
export type WorkflowCardView = Extract<
  TurnPart,
  { type: "workflow-card" }
>["card"] & { presentation?: WorkflowPresentationView; readOnly?: boolean };
export type MessagePart =
  | (Exclude<TurnPart, { type: "workflow-card" | "file-delivery" }> & {
      partId?: string;
    })
  | { type: "workflow-card"; partId?: string; card: WorkflowCardView }
  | (Extract<TurnPart, { type: "file-delivery" }> & {
      partId?: string;
      resource?: ResourceRef;
    });
export interface MessageView {
  id: string;
  revision?: string;
  author: "user" | "assistant";
  text: string;
  createdAt?: number;
  runId?: string;
  inputId?: string;
  itemId?: string;
  partIds?: string[];
  live?: boolean;
  recovery?: TranscriptItem["recovery"];
  streaming?: boolean;
  kind?: "task" | "error";
  task?: TaskView;
  taskId?: string;
  taskFrozen?: boolean;
  inputSource?: "voice" | "text";
  editedAt?: number;
  editDraft?: TranscriptItem['editDraft'];
  attachments?: TranscriptItem["attachments"];
  references?: TranscriptItem["references"];
  skills?: TranscriptItem["skills"];
  queuedForSend?: boolean;
  withdrawn?: boolean;
  replyStatus?: "stopped" | "awaiting-user";
  thinking?: TranscriptItem["thinking"];
  usage?: TranscriptItem["usage"];
  parts?: MessagePart[];
  actions?: Partial<
    Record<
      "edit" | "retry" | "stop" | "preview",
      boolean | { disabledReason: string }
    >
  >;
}
export interface PermissionView {
  task: TaskView;
  revision?: string;
  readOnly?: boolean;
}
export interface FlowSurfaceState {
  history?: {hasMore:boolean;loading:boolean;error:string;load():void};
  /** Mobile hosts can show action failures as a short-lived toast. */
  transientActionErrors?: boolean;
  readOnly?: boolean;
  loading?: boolean;
  notice?: string;
  busy?: boolean;
  retryBusy?: boolean;
  retryBlocked?: string;
  permissionRequests?: readonly PermissionView[];
  runActivity?: RunActivityView;
  scrollIntent?: { id: string; kind: "follow-latest" };
  /** Transient speech text is display data; this package never starts recording. */
  interimText?: string;
  tasks?: readonly TaskView[];
  editingMessageId?: string | null;
}
type BaseAction = { targetId: string; expectedRevision?: string };
export type FlowAction = BaseAction &
  (
    | { type: "message.edit"; nextText: string }
    | { type: "message.edit-state"; state: "begin" | "cancel" }
    | { type: "message.retry"; runId?: string }
    | { type: "recovery.retry"; runId: string; recoveryId: string }
    | { type: "run.stop" | "task.stop" }
    | { type: "background.command"; action: "read" | "stop" | "review"; jobId?: string; from?: number }
    | { type: "permission.decide"; choice: TaskPermissionChoice }
    | {
        type: "workflow.configure";
        invocationId: string;
        values?: Record<string, unknown>;
        executionModel?: { mode: "auto" } | { mode: "fixed"; modelKey: string };
      }
    | {
        type: "workflow.save-draft";
        invocationId: string;
        interactionId: string;
        values: Record<string, unknown>;
      }
    | {
        type:
          | "workflow.start"
          | "workflow.stop"
          | "workflow.continue"
          | "workflow.abandon";
        invocationId: string;
        workflowRunId?: string;
        values?: Record<string, unknown>;
        resolution?: string;
        resolutionFields?: Record<string, unknown>;
        message?: string;
        confirmed?: boolean;
        verifiedOutputs?: Record<string, unknown>;
      }
    | {
        type: "workflow.submit-interaction";
        invocationId: string;
        interactionId: string;
        actionId: string;
        values: Record<string, unknown>;
      }
    | { type: "workflow.load-presentation"; invocationId: string }
    | {
        type: "preview.open";
        target: "resource" | "task" | "workflow";
        intent?: "preview" | "open" | "reveal";
        resource?: ResourceRef;
        taskId?: string;
        invocationId?: string;
        href?: string;
        name?: string;
      }
    | { type: "model.configure-routing" }
  );
export type FlowActionRequest = FlowAction & {
  scope: FlowScope;
  requestId: string;
};
export type FlowActionReceipt = {
  data?: {text?:string;next?:number;total?:number;lossy?:boolean;accepted?:boolean};
  receipt: "accepted" | "completed" | "needs-review";
  revision?: string;
};
export type FlowActionHandler = (
  request: FlowActionRequest,
  context: { signal: AbortSignal },
) => Promise<FlowResult<FlowActionReceipt>>;
export interface FlowAppearance {
  tokens?: Readonly<Record<`--hcf-${string}`, string>>;
  className?: string;
  style?: CSSProperties;
  portalContainer?: HTMLElement | null;
}
export interface FlowDiagnostic {
  code: string;
  scope: FlowScope;
  targetId?: string;
  message: string;
}
export interface ConversationFlowHandle {
  scrollToBottom(options?: { behavior?: "instant" | "smooth" }): void;
  scrollToMessage(
    messageId: string,
    options?: { align?: "start" | "center" | "end" },
  ): Promise<FlowResult<{ found: boolean }>>;
}
export interface ConversationFlowProps {
  schemaVersion?: 1;
  scope: FlowScope;
  messages: readonly MessageView[];
  state?: FlowSurfaceState;
  host?: ConversationFlowHost;
  onAction?: FlowActionHandler;
  active?: boolean;
  appearance?: FlowAppearance;
  onDiagnostic?: (diagnostic: FlowDiagnostic) => void;
  ref?: Ref<ConversationFlowHandle>;
}
export type {
  RunActivityView,
  WorkflowInputParameter,
  WorkflowInteractionProjection,
};
