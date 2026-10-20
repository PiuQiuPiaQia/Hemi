import { WorkflowPage } from "./workflow-page";
import { useEffect, useMemo, useState } from "react";
import type {
  TaskActionName,
  TaskPermissionChoice,
  TaskStateSnapshot,
  TurnPart,
} from "@/shared/types";
import { flowPartsToTranscriptParts } from "./lib/transcript-parts-view";
import { useConversationFlow } from "./lib/use-conversation-flow";
import { WorkflowCard } from "./workflow-card";
import { ArrowLeft, Workflow, Cpu, MessageCircle, Check } from "lucide-react";
import { PermissionCard } from "./task-panel";

type Card = Extract<TurnPart, { type: "workflow-card" }>["card"];
// 结果页读取同一会话事实，不建立第二份运行状态或执行入口。
export function WorkflowResult({
  invocationId,
  conversationId,
  taskState,
  onTaskAction,
  onBack,
  onOpenConversation,
}: {
  invocationId: string;
  conversationId: string;
  taskState?: TaskStateSnapshot | null;
  onTaskAction: (
    action: TaskActionName,
    payload?: { choice?: TaskPermissionChoice; taskId?: string },
  ) => void;
  onBack: () => void;
  onOpenConversation?: (id: string) => void;
}) {
  const { snapshot } = useConversationFlow(conversationId);
  const projected = useMemo(() => {
    const part = snapshot?.timeline
      .flatMap((item) => (item.kind === "assistant" ? item.parts : []))
      .find(
        (part) =>
          part.kind === "workflow-card" && part.invocationId === invocationId,
      );
    const mapped = part ? flowPartsToTranscriptParts([part])?.[0] : null;
    return mapped?.type === "workflow-card" ? mapped.card : null;
  }, [snapshot?.timeline, invocationId]);
  const [queuedCard, setQueuedCard] = useState<Card | null>(null),
    [error, setError] = useState("");
  const hasProjection = Boolean(projected);
  const card = projected ?? queuedCard;
  useEffect(() => {
    if (hasProjection) return;
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const record =
          await window.hemiVoice.workflowGetInvocation(invocationId);
        if (!record) throw new Error("本次运行记录不存在");
        if (alive) {
          const inv = record as {
            cardId: string;
            workflowId: string;
            name: string;
            draftRevision: number;
            preparation: { values: Record<string, unknown> };
            executionModel: Card["executionModel"];
            run?: { status: string };
            startReceipt?: { workflowRunId: string };
          };
          setQueuedCard({
            invocationId,
            conversationId,
            cardId: inv.cardId,
            workflowId: inv.workflowId,
            workflowRunId: inv.startReceipt?.workflowRunId,
            status: inv.run?.status ?? "queued",
            title: inv.name,
            executionModel: inv.executionModel,
            values: inv.preparation.values,
            draftRevision: inv.draftRevision,
          });
          setError("");
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
      if (alive) timer = setTimeout(() => void load(), 1500);
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [invocationId, conversationId, hasProjection]);
  const waiting = [
    ...(taskState?.agentPermissions ?? []).map(
      (entry) =>
        ({
          ...taskState,
          ...entry,
          taskText: "",
          tasks: undefined,
        }) as TaskStateSnapshot,
    ),
    ...(taskState?.tasks ?? []).filter((task) => task.permission),
  ].filter((task) => task.conversationId === conversationId);
  return (
    <WorkflowPage className="h59-consumer" testId="workflow-result">
      <div className="h59-result-content">
        <header className="h59-result-navigation">
          <button className="h59-back" onClick={onBack}>
            <ArrowLeft />
            返回工作流
          </button>
          <button
            className="h59-text-button"
            onClick={() => onOpenConversation?.(conversationId)}
          >
            <MessageCircle />
            关联对话
          </button>
        </header>
        {card ? (
          <>
            <div className="h59-result-identity">
              <span>
                <Workflow />
                {card.title}
              </span>
              <p>
                {Object.values(card.values ?? {})
                  .map((value) =>
                    typeof value === "string" ? value : JSON.stringify(value),
                  )
                  .join(" · ")}
              </p>
            </div>
            {card.modelLabel ? (
              <p className="h59-result-model">
                <Cpu />
                执行模型：{card.modelLabel}
              </p>
            ) : null}
            <h1 className="h59-result-title">
              {card.title}
              {card.status === "completed"
                ? "已生成"
                : card.status === "running"
                  ? "正在运行"
                  : ""}
            </h1>
          </>
        ) : null}
        {waiting.length ? (
          <PermissionCard
            snap={waiting[0]}
            queuedTitles={waiting.slice(1).map((task) => task.taskText)}
            onDecide={(choice) =>
              onTaskAction("decide", {
                choice,
                taskId: waiting[0].taskId ?? waiting[0].key ?? undefined,
              })
            }
            onStop={() =>
              onTaskAction("stop", {
                taskId: waiting[0].taskId ?? waiting[0].key ?? undefined,
              })
            }
          />
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {card ? (
          <WorkflowCard card={card} presentation="result" />
        ) : (
          <p role="status">读取本次运行…</p>
        )}
        {card?.status === "completed" ? (
          <footer className="h59-completion-foot">
            <p>
              <Check />
              {card.completedCount ?? 0} 个步骤完成
            </p>
            <button onClick={() => onOpenConversation?.(conversationId)}>
              <MessageCircle />
              在对话中继续
            </button>
          </footer>
        ) : null}
      </div>
    </WorkflowPage>
  );
}
