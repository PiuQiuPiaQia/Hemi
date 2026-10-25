import {messageViewFromTranscript} from '@hemi/conversation-flow/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ConversationFlow,
  type FlowActionHandler,
  type FlowAppearance,
  type MessageView,
  type WorkflowPresentationView,
} from "@hemi/conversation-flow";
import type {
  ModelProfilesDirectory,
  TaskActionName,
  TaskPermissionChoice,
  TaskStateSnapshot,
  TranscriptItem,
} from "@/shared/types";
import type { WorkflowDocument } from "@shared/workflow.mjs";
import { useAppearance } from "@/appearance/use-appearance";
import { workflowPresentation } from "./lib/workflow-presentation";
import {
  createDesktopFlowHost,
  deliverableResource,
} from "./lib/conversation-flow-host";
import "@hemi/conversation-flow/styles.css";
import { ModelRoutingDialog } from "./model-routing-dialog";
import {useConversationBridge, useConversationEnvironment, useConversationOnline} from './lib/conversation-bridge';

type Props = {
  conversationId: string | null;
  generation: number;
  environmentId: string;
  messages: TranscriptItem[];
  taskSnaps?: Record<string, TaskStateSnapshot>;
  waitingTasks: TaskStateSnapshot[];
  loading?: boolean;
  notice?: string;
  interimText?: string;
  busy: boolean;
  readOnly?: boolean;
  retryBusy?: boolean;
  retryBlocked?: string;
  editingMessageId: string | null;
  models?: ModelProfilesDirectory | null;
  active: boolean;
  onTaskAction: (
    action: TaskActionName,
    payload?: {
      choice?: TaskPermissionChoice;
      taskId?: string;
      taskKey?: string;
    },
  ) => void;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onEdit: (id: string, text: string) => void;
  onRetry: () => void;
  onOpenProcess: (snap: TaskStateSnapshot) => void;
  onPreview: (target: {
    kind: "attachment" | "deliverable" | "artifact";
    id: string;
    taskId?: string;
    intent?: string;
  }) => void;
  onOpenLink: (href: string) => void;
  onModelSettings?: () => void;
};
type PresentationRecord = { key: string; view: WorkflowPresentationView };
function projectWorkflow(
  record: Record<string, unknown> | null,
): WorkflowPresentationView {
  const inv = record as {
    definitionRevision?: number;
    documentSnapshot?: WorkflowDocument;
    run?: { waiting?: { nodeId: string }; currentNodeId?: string };
  } | null;
  const document = inv?.documentSnapshot;
  const node = document?.nodes.find(
    (n) => n.id === (inv?.run?.waiting?.nodeId ?? inv?.run?.currentNodeId),
  );
  return {
    revision: inv?.definitionRevision,
    outline: workflowPresentation(document ?? null).outline.join(" → "),
    labels: Object.fromEntries(
      document?.nodes.flatMap((n) =>
        (n.data.parameters ?? []).map((p) => [p.key, p.label || p.key]),
      ) ?? [],
    ),
    parameters:
      document?.nodes.find((n) => n.type === "hemi-input")?.data.parameters ??
      [],
    nodeTitle: node?.data.title || "执行步骤",
    resumeFields: node?.data.outputSchema?.properties ?? {},
    models: null,
  };
}
export function useDesktopFlowAppearance() {
  const appearance = useAppearance();
  const [tokens, setTokens] = useState<FlowAppearance["tokens"]>({});
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const shell = container.current?.closest(".voice-shell");
    if (!shell) return;
    const computed = getComputedStyle(shell),
      next: Record<`--hcf-${string}`, string> = {};
    for (const name of Array.from(computed))
      if (
        name.startsWith("--") &&
        !name.startsWith("--tw-") &&
        !name.startsWith("--hcf-")
      )
        next[`--hcf-${name.slice(2)}`] = computed.getPropertyValue(name);
    setTokens(next);
  }, [appearance.snapshot.preference.skinId]);
  return { tokens, container };
}
export function DesktopConversationFlow(props: Props) {
  const bridge = useConversationBridge();
  const environment = useConversationEnvironment();
  const online = useConversationOnline();
  const appearance = useAppearance();
  const { tokens, container } = useDesktopFlowAppearance();
  const scope = useMemo(
    () => ({
      environmentId: props.environmentId,
      conversationId: props.conversationId ?? "new",
      generation: String(props.generation),
    }),
    [props.environmentId, props.conversationId, props.generation],
  );
  const host = useMemo(
    () => createDesktopFlowHost(bridge, scope.conversationId, {remote: environment === 'bot', online}),
    [bridge, scope, environment, online],
  );
  const latest = useRef(props);
  latest.current = props;
  const [presentations, setPresentations] = useState<
    Record<string, PresentationRecord>
  >({});
  const [reload, setReload] = useState(0);
  const [routingOpen, setRoutingOpen] = useState(false);
  const cards = props.messages.flatMap(
    (item) =>
      item.parts?.flatMap((part) =>
        part.type === "workflow-card" ? [part.card] : [],
      ) ?? [],
  );
  const queryKey = JSON.stringify(
    cards.map((card) => [
      card.invocationId,
      card.status,
      card.currentNodeId,
      card.needsReview,
      card.draftRevision,
    ]),
  );
  useEffect(() => {
    let alive = true;
    setPresentations({});
    void Promise.all(
      cards.map(async (card) => {
        try {
          const value = await bridge.workflowGetInvocation(
            card.invocationId,
          );
          return [
            card.invocationId,
            { key: queryKey, view: projectWorkflow(value) },
          ] as const;
        } catch {
          return [
            card.invocationId,
            {
              key: queryKey,
              view: {
                ...projectWorkflow(null),
                error: "工作流详情读取失败，可重试",
              },
            },
          ] as const;
        }
      }),
    ).then((entries) => {
      if (alive) setPresentations(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
  }, [bridge, scope, queryKey, reload]);
  const onAction: FlowActionHandler = useMemo(
    () =>
      async (action, { signal }) => {
        const p = latest.current;
        if (
          signal.aborted ||
          action.scope.environmentId !== p.environmentId ||
          action.scope.conversationId !== (p.conversationId ?? "new") ||
          action.scope.generation !== String(p.generation)
        )
          return {
            ok: false,
            error: { code: "cancelled", message: "会话已切换" },
          };
        let value: Record<string, unknown> | null = null;
        switch (action.type) {
          case "message.edit-state":
            action.state === "begin"
              ? p.onStartEdit(action.targetId)
              : p.onCancelEdit();
            break;
          case "message.edit":
            p.onEdit(action.targetId, action.nextText);
            break;
          case "run.stop":
          case "recovery.retry": {
            const result = await bridge.flowCommand(p.conversationId!, action.type === 'recovery.retry'
              ? { type: 'retryRecovery', targetRunId: action.runId, recoveryId: action.recoveryId }
              : { type: 'stop', targetRunId: action.targetId });
            if (!result?.ok) return { ok: false, error: { code: 'failed', message: result?.message ?? '恢复状态已变化，请稍后重试。' } };
            break;
          }
          case "message.retry":
            p.onRetry();
            break;
          case "task.stop":
            p.onTaskAction("stop", { taskId: action.targetId });
            break;
          case "permission.decide": {
            const task = p.waitingTasks.find(
              (task) => task.permission?.id === action.targetId,
            );
            if (!task)
              return {
                ok: false,
                error: { code: "expired", message: "这条授权请求已结束" },
              };
            p.onTaskAction("decide", {
              choice: action.choice,
              taskId: task.taskId ?? task.key ?? undefined,
            });
            break;
          }
          case "preview.open": {
            if (action.target === "task") {
              const snap =
                p.taskSnaps?.[action.taskId ?? ""] ??
                p.messages.find(
                  (item) => item.taskSnap?.taskId === action.taskId,
                )?.taskSnap;
              if (snap) p.onOpenProcess(snap);
              break;
            }
            if (action.target === "workflow") {
              window.dispatchEvent(
                new CustomEvent("hemi:workflow-preview", {
                  detail: { invocationId: action.invocationId },
                }),
              );
              break;
            }
            if (action.invocationId && action.href) {
              value = await bridge.workflowOpenArtifact(
                action.invocationId,
                action.href,
              );
              break;
            }
            if (action.href) {
              p.onOpenLink(action.href);
              break;
            }
            const id = action.resource?.id ?? "";
            if (id.startsWith("attachment:"))
              p.onPreview({ kind: "attachment", id: id.slice(11) });
            else if (id.startsWith("task-body:"))
              p.onPreview({ kind: "artifact", taskId: id.slice(10), id: "" });
            else if (id.startsWith("task-artifact:")) {
              const [taskId, ...artifact] = id.slice(14).split(":");
              p.onPreview({
                kind: "artifact",
                taskId,
                id: artifact.join(":"),
                intent: action.intent,
              });
            } else p.onPreview({ kind: "deliverable", id: action.targetId });
            break;
          }
          case "model.configure-routing":
            setRoutingOpen(true);
            break;
          case "workflow.load-presentation":
            setReload((n) => n + 1);
            break;
          case "workflow.configure":
            value = await bridge.workflowUpdatePreparation({
              invocationId: action.invocationId,
              expectedDraftRevision: Number(action.expectedRevision),
              values: action.values,
              executionModel: action.executionModel,
            });
            break;
          case "workflow.start":
            value = await bridge.workflowStartPrepared({
              invocationId: action.invocationId,
              expectedDraftRevision: Number(action.expectedRevision),
              requestId: action.requestId,
              conversationId: scope.conversationId,
              cardId: p.messages
                .flatMap((item) => item.parts ?? [])
                .flatMap((part) =>
                  part.type === "workflow-card" &&
                  part.card.invocationId === action.invocationId
                    ? [part.card.cardId]
                    : [],
                )[0],
            });
            break;
          case "workflow.stop": {
            const stop = await bridge.workflowStop(action.workflowRunId ?? "");
            value = { ok: stop.stopped, message: stop.reason };
            break;
          }
          case "workflow.continue":
            value = await bridge.workflowContinue({
              invocationId: action.invocationId,
              requestId: action.requestId,
              confirmed: action.confirmed,
              resumeMessage: action.message,
              verifiedOutputs: action.verifiedOutputs,
            });
            break;
          case "workflow.abandon":
            await bridge.workflowAbandon({
              invocationId: action.invocationId,
              conversationId: scope.conversationId,
            });
            break;
          case "workflow.save-draft":
            value = await bridge.workflowSaveInteractionDraft({
              invocationId: action.invocationId,
              interactionId: action.interactionId,
              values: action.values,
              expectedRevision: Number(action.expectedRevision),
            });
            break;
          case "workflow.submit-interaction":
            value = await bridge.workflowSubmitInteraction({
              invocationId: action.invocationId,
              interactionId: action.interactionId,
              actionId: action.actionId,
              requestId: action.requestId,
              values: action.values,
              expectedRevision: Number(action.expectedRevision),
            });
            break;
          default:
            return {
              ok: false,
              error: { code: "unsupported", message: "当前宿主未实现此操作" },
            };
        }
        if (value?.ok === false)
          return {
            ok: false,
            error: {
              code:
                value.code === "conflict" || value.code === "stale-revision"
                  ? "conflict"
                  : "failed",
              message: String(value.message ?? value.code ?? "操作没有完成"),
            },
          };
        return {
          ok: true,
          value: {
            receipt: value ? "completed" : "accepted",
            revision:
              value?.revision == null ? undefined : String(value.revision),
          },
        };
      },
    [bridge, scope],
  );
  const messages = useMemo<MessageView[]>(
    () =>
      props.messages.map((item) => ({
        ...messageViewFromTranscript(item),
        parts: item.parts?.map((part) =>
          part.type === "workflow-card"
            ? {
                ...part,
                card: {
                  ...part.card,
                  presentation: {
                    ...(presentations[part.card.invocationId]?.key === queryKey
                      ? presentations[part.card.invocationId].view
                      : { ...projectWorkflow(null), loading: true }),
                    models: props.models ?? null,
                  },
                },
              }
            : part.type === "file-delivery" && !part.linkPath
              ? {
                  ...part,
                  resource: deliverableResource(
                    part.artifactId,
                    undefined,
                    part.contentVersion,
                  ),
                }
              : part,
        ),
      })),
    [props.messages, props.models, presentations, queryKey],
  );
  return (
    <div ref={container} className="contents">
      <ConversationFlow
        scope={scope}
        messages={messages}
        host={host}
        onAction={onAction}
        active={props.active && appearance.activity.visible}
        appearance={{ tokens }}
        state={{
          tasks: Object.values(props.taskSnaps ?? {}),
          permissionRequests: props.waitingTasks.map((task) => ({ task })),
          loading: props.loading,
          notice: props.notice,
          interimText: props.interimText,
          busy: props.busy,
          readOnly: props.readOnly,
          retryBusy: props.retryBusy,
          retryBlocked: props.retryBlocked,
          editingMessageId: props.editingMessageId,
        }}
      />
      {routingOpen ? (
        <ModelRoutingDialog
          onClose={() => {
            setRoutingOpen(false);
            latest.current.onModelSettings?.();
          }}
        />
      ) : null}
    </div>
  );
}
