import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowDown } from "lucide-react";
import type {
  ConversationFlowHandle,
  ConversationFlowProps,
  FlowAction,
  MessageView,
  PermissionView,
} from "../types/api.js";
import type { TaskStateSnapshot, TurnPart } from "../types/presentation.js";
import {
  FlowProvider,
  useFlow,
  useFlowClock,
  useFlowAction,
} from "../host/context.js";
import { scopeKey, ok } from "../host/runtime.js";
import { taskSnapshot, transcript } from "../presentation/view.js";
import { groupStageBriefs } from "../presentation/stage-briefs.js";
import { replyCopyTargets } from "../presentation/reply-copy.js";
import { markdownPlainText } from "../shared/markdown-plain-text.js";
import {
  VirtualTranscript,
  type VirtualTranscriptHandle,
} from "./virtual-transcript.js";
import {
  ChatTurnItem,
  TaskTranscriptItem,
  StageBriefsItem,
  ReplyCopyActions,
  renderReplyText,
} from "./message-row.js";
import { CompactDelegation } from "./compact-delegation.js";
import { DeliverableContext } from "./deliverable-card.js";
import { PermissionCard } from "./permission-card.js";
import { RunActivity } from "./run-activity.js";
import { TranscriptBoundary } from "./transcript-boundary.js";
import { ScrollArea } from "../ui/scroll-area.js";

export function ConversationFlow(props: ConversationFlowProps) {
  return (
    <FlowProvider key={scopeKey(props.scope)} {...props}>
      <TranscriptBoundary>
        <ConversationFlowBody {...props} />
      </TranscriptBoundary>
    </FlowProvider>
  );
}
function ConversationFlowBody({
  messages,
  state,
  ref,
  schemaVersion = 1,
}: ConversationFlowProps) {
  const { runtime } = useFlow();
  const { perform, busy, error } = useFlowAction();
  const [editingId, setEditingId] = useState<string | null>(
    state?.editingMessageId ?? null,
  );
  useEffect(() => {
    if (state?.editingMessageId !== undefined)
      setEditingId(state.editingMessageId);
  }, [state?.editingMessageId]);
  const [pinned, setPinned] = useState(true);
  const virtual = useRef<VirtualTranscriptHandle>(null);
  const items = useMemo(
    () =>
      messages.map((message) =>
        transcript({
          ...message,
          parts: message.parts?.map((part) =>
            [
              "text",
              "thinking",
              "tools",
              "file-delivery",
              "workflow-card",
            ].includes(part.type)
              ? part
              : {
                  type: "text",
                  partId: (part as { partId?: string }).partId,
                  text: "此内容类型暂不支持，请更新对话组件。",
                },
          ),
        }),
      ),
    [messages],
  );
  const taskSnaps = useMemo(() => {
    const tasks: Record<string, TaskStateSnapshot> = {};
    for (const item of items)
      if (item.taskSnap) {
        const key = item.taskSnap.taskId ?? item.taskSnap.key;
        if (key) tasks[key] = item.taskSnap;
      }
    for (const view of state?.tasks ?? []) {
      const snap = taskSnapshot(view),
        key = snap.taskId ?? snap.key;
      if (key) tasks[key] = snap;
    }
    return tasks;
  }, [items, state?.tasks]);
  const byCall = useMemo(() => {
    const map = new Map<string, TaskStateSnapshot>();
    for (const task of Object.values(taskSnaps))
      if (task.toolCallId) map.set(task.toolCallId, task);
    return map;
  }, [taskSnaps]);
  const entries = useMemo(() => groupStageBriefs(items), [items]);
  const copies = useMemo(() => replyCopyTargets(items), [items]);
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const latestError = items.at(-1)?.kind === "error" ? items.at(-1) : null;
  const rowIds = useMemo(
    () => [
      ...entries.map((entry) =>
        entry.type === "stages" ? entry.key : entry.item.id,
      ),
      ...(state?.interimText ? ["__interim"] : []),
    ],
    [entries, Boolean(state?.interimText)],
  );
  const lastUser = items.findLast((item) => item.author === "user")?.id ?? null;
  const oldScrollIntent = useRef(state?.scrollIntent?.id);
  useEffect(() => {
    const next = state?.scrollIntent?.id;
    if (next && next !== oldScrollIntent.current)
      virtual.current?.scrollToBottom();
    oldScrollIntent.current = next;
  }, [state?.scrollIntent?.id]);
  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: (options) => virtual.current?.scrollToBottom(options),
      scrollToMessage: async (id, options) => {
        const row = entries.findIndex((entry) =>
          entry.type === "stages"
            ? entry.items.some((item) => item.id === id)
            : entry.item.id === id,
        );
        if (row < 0) return ok({ found: false });
        await virtual.current?.scrollToMessage(rowIds[row], options);
        return ok({ found: true });
      },
    }),
    [entries, rowIds],
  );
  const open = useCallback(
    (action: FlowAction) => {
      void perform(action);
    },
    [perform],
  );
  const resourcesByArtifact = useMemo(
    () =>
      new Map(
        messages.flatMap(
          (message) =>
            message.parts?.flatMap((part) =>
              part.type === "file-delivery" && part.resource
                ? [[part.artifactId, part.resource] as const]
                : [],
            ) ?? [],
        ),
      ),
    [messages],
  );
  const previewResource = useCallback(
    (id: string, name?: string) =>
      open({
        type: "preview.open",
        target: "resource",
        targetId: id,
        resource: resourcesByArtifact.get(id) ?? {
          id: `deliverable:${id}`,
          version: "0",
        },
        name,
      }),
    [open, resourcesByArtifact],
  );
  const previewTask = (task: TaskStateSnapshot) =>
    open({
      type: "preview.open",
      target: "task",
      targetId: task.taskId ?? task.key ?? "",
      taskId: task.taskId ?? task.key ?? "",
    });
  const taskAction = (
    type: string,
    payload?: { taskId?: string; taskKey?: string },
  ) => {
    if (type === "stop")
      open({
        type: "task.stop",
        targetId: payload?.taskId ?? payload?.taskKey ?? "",
      });
  };
  const renderTask = (view: MessageView) => (call: { id: string }) => {
    const snap = byCall.get(call.id);
    return snap ? (
      <CompactDelegation
        snap={snap}
        onAction={
          runtime.actionable && view.actions?.stop === true && !view.taskFrozen
            ? taskAction
            : undefined
        }
        onOpenProcess={
          runtime.actionable && view.actions?.preview === true
            ? () => previewTask(snap)
            : undefined
        }
      />
    ) : null;
  };
  const onLocalLink = useCallback(
    (href: string) =>
      open({ type: "preview.open", target: "resource", targetId: href, href }),
    [open],
  );
  const renderText = useCallback(
    (text: string) =>
      renderReplyText(text, {
        onLocalLink: runtime.actionable ? onLocalLink : undefined,
      }),
    [runtime, onLocalLink],
  );
  const context = useMemo(
    () =>
      runtime.actionable
        ? {
            conversationId: runtime.scope.conversationId,
            onOpen: (id: string) => previewResource(id),
            onOpenLink: onLocalLink,
          }
        : null,
    [runtime, previewResource, onLocalLink],
  );
  const renderRow = (index: number) => {
    const entry = entries[index];
    if (!entry)
      return (
        <article className="h24-user-message" aria-live="polite">
          <p className="h24-user-bubble is-interim">
            {state?.interimText}
            <span className="thinking-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </p>
        </article>
      );
    const item = entry.type === "stages" ? entry.items[0] : entry.item;
    const previous = entries[index - 1];
    const prev = previous
      ? previous.type === "stages"
        ? previous.items[0]
        : previous.item
      : null;
    const continuation =
      item.author === "hemi" &&
      item.kind !== "task" &&
      Boolean(prev && prev.author === "hemi" && prev.kind !== "task");
    const lead =
      (item.author === "hemi" || item.kind === "task") &&
      !(prev && (prev.author === "hemi" || prev.kind === "task"));
    const copy = copies.get(
      entry.type === "stages" ? entry.items.at(-1)!.id : item.id,
    );
    if (entry.type === "stages")
      return (
        <div className="contents" data-reply-end={copy ? "true" : undefined}>
          <StageBriefsItem
            items={entry.items}
            showRelation={entry.showRelation}
            current={
              entry.latest &&
              Boolean(taskSnaps[entry.taskId]) &&
              taskSnaps[entry.taskId].phase !== "terminal"
            }
            afterCard={prev?.kind === "task"}
            continuation={continuation}
            lead={lead}
            taskTitle={taskSnaps[entry.taskId]?.taskText}
          />
          {copy ? <ReplyCopyActions text={copy} /> : null}
        </div>
      );
    const view = messageById.get(item.id)!;
    const editAllowed = view.actions?.edit === true;
    return (
      <div
        className="contents"
        data-flow-row={item.id}
        data-flow-kind={item.kind ?? item.author}
        data-run-id={item.flow?.runId}
        data-input-id={item.flow?.inputId}
        data-item-id={item.flow?.itemId}
        data-part-ids={JSON.stringify(item.flow?.partIds ?? [])}
        data-task-id={item.taskId}
        data-task-run={item.taskSnap?.runs}
        data-reply-end={copy ? "true" : undefined}
      >
        {item.kind === "task" ? (
          <TaskTranscriptItem
            item={item}
            taskSnaps={taskSnaps}
            onTaskAction={
              runtime.actionable &&
              view.actions?.stop === true &&
              !view.taskFrozen
                ? taskAction
                : undefined
            }
            onOpenProcess={
              runtime.actionable && view.actions?.preview === true
                ? previewTask
                : undefined
            }
            onOpenArtifact={(_taskId, id, intent) =>
              open({
                type: "preview.open",
                target: "resource",
                targetId: id,
                resource: {
                  id: `task-artifact:${_taskId}:${id}`,
                  version: "0",
                },
                intent,
              })
            }
            onOpenPreview={(taskId, id) =>
              open({
                type: "preview.open",
                target: "resource",
                targetId: id,
                resource: { id: `task-artifact:${taskId}:${id}`, version: "0" },
              })
            }
            onOpenReportPreview={
              runtime.actionable
                ? (task) =>
                    open({
                      type: "preview.open",
                      target: "resource",
                      targetId: task.taskId ?? "",
                      resource: {
                        id: `task-body:${task.taskId}`,
                        version: String(task.resultVersion ?? 0),
                      },
                    })
                : undefined
            }
          />
        ) : (
          <ChatTurnItem
            item={item}
            continuation={continuation}
            lead={lead}
            showRelation={entry.showRelation}
            taskTitleOf={(id) => taskSnaps[id]?.taskText}
            editing={editingId === item.id}
            busy={Boolean(state?.busy) || busy}
            readOnly={state?.readOnly}
            canEdit={editAllowed && runtime.actionable}
            onStartEdit={(id) => {
              setEditingId(id);
              if (state?.editingMessageId !== undefined)
                open({
                  type: "message.edit-state",
                  targetId: id,
                  state: "begin",
                });
            }}
            onCancelEdit={() => {
              setEditingId(null);
              if (state?.editingMessageId !== undefined)
                open({
                  type: "message.edit-state",
                  targetId: item.id,
                  state: "cancel",
                });
            }}
            onEditResend={(id, nextText) => {
              void perform({
                type: "message.edit",
                targetId: id,
                expectedRevision: view.revision,
                nextText,
              }).then((result) => {
                if (result.ok && !runtime.disposed) setEditingId(null);
              });
            }}
            onPreviewAttachment={
              runtime.actionable
                ? (_conversationId, id) =>
                    open({
                      type: "preview.open",
                      target: "resource",
                      targetId: id,
                      resource: { id: `attachment:${id}`, version: "0" },
                    })
                : undefined
            }
            renderText={renderText}
            renderTask={renderTask(view)}
            onOpenDeliverable={runtime.actionable ? previewResource : undefined}
            onRetry={
              item.id === latestError?.id &&
              view.actions?.retry === true &&
              runtime.actionable
                ? () =>
                    open({
                      type: "message.retry",
                      targetId: item.id,
                      runId: view.runId,
                    })
                : undefined
            }
            onRecoveryAction={runtime.actionable ? (action, recoveryId) => open(action === 'stop'
              ? { type: 'run.stop', targetId: view.runId ?? '' }
              : { type: 'recovery.retry', targetId: item.id, runId: view.runId ?? '', recoveryId }) : undefined}
            retryBusy={state?.retryBusy || state?.busy || busy}
            retryBlocked={state?.retryBlocked}
          />
        )}
        {copy ? <ReplyCopyActions text={copy} /> : null}
      </div>
    );
  };
  if (schemaVersion !== 1)
    return <div role="alert">不支持的对话展示数据版本</div>;
  return (
    <DeliverableContext.Provider value={context}>
      {state?.permissionRequests?.length ? (
        <PermissionStack requests={state.permissionRequests} />
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col h24-stream-wrap">
        <ScrollArea
          className="transcript-scroll min-h-0 flex-1"
          data-transcript-scroll
        >
          {state?.notice ? (
            <p className="h24-reply-status" role="status">
              {state.notice}
            </p>
          ) : null}
          <div className="conversation-list h24-reading">
            <VirtualTranscript
              ref={virtual}
              rowIds={rowIds}
              editingId={editingId}
              onPinnedChange={setPinned}
              lastUserId={lastUser}
              loading={Boolean(state?.loading)}
              getRowText={(index, saved) => {
                const entry = entries[index];
                if (!entry) return state?.interimText ?? "";
                if (entry.type === "stages")
                  return entry.items
                    .map((item) => markdownPlainText(item.text))
                    .join("\n\n");
                const item = entry.item;
                if (item.author === "user" || item.kind === "task")
                  return item.text;
                if (!item.parts?.length) return markdownPlainText(item.text);
                return item.parts
                  .flatMap((part, index) => {
                    if (part.type === "text")
                      return [markdownPlainText(part.text)];
                    const key =
                      (part as { partId?: string }).partId ??
                      `${part.type}-${index}`;
                    if (
                      part.type === "thinking" &&
                      saved?.get(`${key}/thinking-expanded`)
                    )
                      return [part.text];
                    if (part.type === "file-delivery") return [part.name];
                    return [];
                  })
                  .join("\n\n");
              }}
              renderRow={renderRow}
            />
          </div>
        </ScrollArea>
        <button
          type="button"
          className="jump-btn panel-jump"
          data-visible={pinned ? "false" : "true"}
          onClick={() => virtual.current?.scrollToBottom()}
          tabIndex={pinned ? -1 : 0}
        >
          <ArrowDown className="size-3.5" />
          回到底部
        </button>
        {state?.permissionRequests?.length ? (
          <div className="h37-perm-frost" aria-hidden="true" />
        ) : null}
      </div>
      {error ? (
        <p role="status" className="h62-deliverable-error">
          {error}
        </p>
      ) : null}
      {state?.runActivity ? <RunActivity activity={state.runActivity} /> : null}
    </DeliverableContext.Provider>
  );
}
export function PermissionStack({
  requests,
}: {
  requests: readonly PermissionView[];
}) {
  const { runtime } = useFlow();
  const now = useFlowClock();
  const { perform, busy, error } = useFlowAction();
  const first = requests[0];
  const baseline = useRef({
    permissionId: first?.task.permission?.id,
    remaining: first?.task.permission?.remainingMs,
    at: now,
  });
  if (
    baseline.current.permissionId !== first?.task.permission?.id ||
    baseline.current.remaining !== first?.task.permission?.remainingMs
  )
    baseline.current = {
      permissionId: first?.task.permission?.id,
      remaining: first?.task.permission?.remainingMs,
      at: now,
    };
  if (!first) return null;
  const snap = taskSnapshot(first.task);
  if (snap.permission)
    snap.permission = {
      ...snap.permission,
      remainingMs: Math.max(
        0,
        snap.permission.remainingMs - (now - baseline.current.at),
      ),
    };
  return (
    <>
      <PermissionCard
        snap={snap}
        queuedTitles={requests.slice(1).map((item) => item.task.taskText)}
        disabled={busy || first.readOnly || !runtime.actionable}
        onStop={() =>
          void perform({
            type: "task.stop",
            targetId: snap.taskId ?? snap.key ?? "",
          })
        }
        onDecide={(choice) =>
          void perform({
            type: "permission.decide",
            targetId: snap.permission!.id,
            expectedRevision: first.revision,
            choice,
          })
        }
      />
      {error ? (
        <p role="status" className="h62-deliverable-error">
          {error}
        </p>
      ) : null}
    </>
  );
}
