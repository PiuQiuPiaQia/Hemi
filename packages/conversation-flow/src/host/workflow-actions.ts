import { useMemo } from "react";
import { useFlow } from "./context.js";
import type { FlowAction, WorkflowCardView } from "../types/api.js";

type Mutation = {
  invocationId: string;
  interactionId?: string;
  actionId?: string;
  expectedRevision?: number;
  expectedDraftRevision?: number;
  values?: Record<string, unknown>;
  executionModel?: { mode: "auto" } | { mode: "fixed"; modelKey: string };
  confirmed?: boolean;
  resumeMessage?: string;
  verifiedOutputs?: Record<string, unknown>;
  requestId?: string;
  cardId?: string;
  conversationId?: string;
};
export function useWorkflowActions(card: WorkflowCardView) {
  const { runtime } = useFlow();
  return useMemo(() => {
    const call = async (action: FlowAction) => {
      if (card.readOnly && !action.type.startsWith("preview."))
        throw new Error("这张卡片为只读记录");
      const result = await runtime.action(action);
      if (!result.ok) throw new Error(result.error.message);
      if (result.value.receipt === "needs-review")
        throw new Error("操作结果待核对，请等待状态更新");
      if (
        action.type === "workflow.save-draft" &&
        (result.value.receipt !== "completed" ||
          result.value.revision == null ||
          !Number.isFinite(Number(result.value.revision)))
      )
        throw new Error("草稿保存结果待核对，请等待宿主更新状态");
      return {
        ok: true as boolean,
        message: undefined as string | undefined,
        code: undefined as string | undefined,
        revision:
          result.value.revision == null
            ? undefined
            : Number(result.value.revision),
      };
    };
    const base = (input: Mutation) => ({
      targetId: card.invocationId,
      invocationId: card.invocationId,
      expectedRevision: String(
        input.expectedRevision ??
          input.expectedDraftRevision ??
          card.draftRevision ??
          card.interaction?.revision ??
          0,
      ),
    });
    return {
      workflowUpdatePreparation: (input: Mutation) =>
        call({
          ...base(input),
          type: "workflow.configure",
          values: input.values,
          executionModel: input.executionModel,
        }),
      workflowSaveInteractionDraft: (input: Mutation) =>
        call({
          ...base(input),
          type: "workflow.save-draft",
          interactionId: input.interactionId!,
          values: input.values ?? {},
        }),
      workflowSubmitInteraction: (input: Mutation) =>
        call({
          ...base(input),
          type: "workflow.submit-interaction",
          interactionId: input.interactionId!,
          actionId: input.actionId!,
          values: input.values ?? {},
        }),
      workflowStartPrepared: (input: Mutation) =>
        call({
          ...base(input),
          type: "workflow.start",
          workflowRunId: card.workflowRunId,
        }),
      workflowContinue: (input: Mutation) =>
        call({
          ...base(input),
          type: "workflow.continue",
          workflowRunId: card.workflowRunId,
          message: input.resumeMessage,
          confirmed: input.confirmed,
          verifiedOutputs: input.verifiedOutputs,
        }),
      workflowStop: (runId: string) =>
        call({
          ...base({ invocationId: card.invocationId }),
          type: "workflow.stop",
          workflowRunId: runId,
        }),
      workflowAbandon: (input: Mutation) =>
        call({ ...base(input), type: "workflow.abandon" }),
      workflowOpenArtifact: (_invocationId: string, href: string) =>
        call({
          targetId: card.invocationId,
          type: "preview.open",
          target: "resource",
          invocationId: card.invocationId,
          href,
        }),
    };
  }, [runtime, card]);
}
