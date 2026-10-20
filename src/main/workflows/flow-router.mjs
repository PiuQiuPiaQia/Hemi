/**
 * 059 对话流 workflow 分派器（S3a，运行接线 §4「ConversationRuntimeRouter」）：
 * 057 controller 的 runtime 效果按输入类型分派——envelope.workflow 存在时不再进
 * executeChatTurn（不嵌套调用 llm:chat、不靠文字让模型猜），改由宿主注入的
 * workflowRunner 推进；卡片事实（workflow-card part 的状态）经 applyFact 以
 * part-updated 更新在受理时建立的同一 partId 上（card-<invocationId>）。
 *
 * 自闭合语义与 executeChatTurn 一致：终态时由调用方（llm.ipc 的 runtime）apply
 * run-settled／run-closed。runner 的真实模型执行（S2 后半已验）与本路由之间的
 * 接线在 llm.ipc 的 setWorkflowRouter 注入；本模块只做纯流程与卡片事实，可单测。
 */

const CARD_PART_ID = (invocationId) => `card-${invocationId}`;

/** 卡片状态事实（part-updated 按 partId 原位合并；runId/generation 由调用方注入）。 */
export function workflowCardFact({ invocationId, status, patch = {}, at }) {
  return {
    type: "part-updated",
    runId: null, // 由调用方填（归约层只接受活跃 run 的事实）
    generation: null, // 由调用方填
    partId: CARD_PART_ID(invocationId),
    patch: {
      kind: "workflow-card",
      invocationId,
      status,
      updatedAt: at ?? Date.now(),
      ...patch,
    },
    at,
  };
}

/**
 * @param {object} params
 * @param {({ invocationId, workflowRunId, onProgress }) => Promise<{status: string, issues?: Array, outputs?: object}>} params.runInvocation
 *   宿主注入：推进一次已受理的调用到终态（生产＝WorkflowRunner.run；测试＝stub）。
 * @param {{info?: Function, warn?: Function}} [params.log]
 */
export function createWorkflowFlowRouter({
  runInvocation,
  stopInvocation = null,
  withdrawInvocation = null,
  log = null,
} = {}) {
  if (typeof runInvocation !== "function")
    throw new Error("workflow flow-router 缺少 runInvocation");

  /**
   * 057 runtime.start 的 workflow 分支。自闭合：返回前完成卡片终态事实；
   * run-settled／run-closed 由 llm.ipc 的调用方补（与 chat 分支同一收口点）。
   * @returns {Promise<{ok: boolean, status?: string, issues?: Array}>}
   */
  const active = new Map();
  async function start({ runId, envelope, generation, applyFact }) {
    const workflow = envelope?.workflow;
    if (!workflow?.invocationId) {
      throw new Error("workflow 输入缺少 invocationId");
    }
    active.set(runId, workflow);
    const fact = (status, patch) => {
      const f = workflowCardFact({
        invocationId: workflow.invocationId,
        status,
        patch,
        at: Date.now(),
      });
      applyFact({ ...f, runId, generation });
    };
    try {
      fact("running", { startedAt: Date.now() });
      const outcome = await runInvocation({
        invocationId: workflow.invocationId,
        workflowRunId: workflow.workflowRunId ?? null,
        onProgress: (progress) => {
          if (progress?.status) fact(progress.status, progress.patch ?? {});
        },
      });
      if (outcome.status === "waiting") {
        // 人工输入挂起（HI 通用节点）：卡片停在 waiting 并携带 interaction 投影；
        // flow 运行按约定闭合（llm.ipc 侧映射 outcome completed），队列槽释放。
        fact("waiting", {
          waitingReason: outcome.reason ?? "等待人工输入",
          ...(outcome.interaction ? { interaction: outcome.interaction } : {}),
        });
        return { ok: true, status: "waiting", interaction: outcome.interaction ?? null };
      }
      fact(
        outcome.status === "completed"
          ? "completed"
          : outcome.status === "stopped"
            ? "stopped"
            : "failed",
        {
          finishedAt: Date.now(),
          fileOutputs: outcome.fileOutputs ?? [],
          needsReview: false,
          resourceWaiting: false,
          waitingReason: null,
          error: null,
          issues: outcome.issues ?? [],
          ...(outcome.issues?.length ? { issues: outcome.issues } : {}),
          ...(outcome.outputs
            ? {
                outputs: Object.fromEntries(
                  Object.entries(outcome.outputs).filter(
                    ([key]) => !key.startsWith("__"),
                  ),
                ),
                summary: outcome.outputs.__summary ?? "",
              }
            : {}),
        },
      );
      for (const artifact of outcome.artifacts ?? [])
        applyFact({
          type: "artifact-updated",
          artifact: {
            ...artifact,
            producerRunId: runId,
            registeredAt: Date.now(),
            contentVersion: 1,
          },
          generation,
        });
      return { ok: true, status: outcome.status, issues: outcome.issues ?? [] };
    } catch (error) {
      log?.warn?.(
        `[workflow-router] 调用 ${workflow.invocationId} 失败：${error?.message ?? error}`,
      );
      fact("failed", {
        finishedAt: Date.now(),
        error: String(error?.message ?? error),
      });
      return {
        ok: false,
        status: "failed",
        issues: [
          { code: "runner-error", message: String(error?.message ?? error) },
        ],
      };
    } finally {
      active.delete(runId);
    }
  }

  return {
    start,
    owns: (runId) => active.has(runId),
    withdraw: (workflow) => withdrawInvocation?.(workflow),
    stop: ({ runId, reason }) =>
      stopInvocation?.({ ...active.get(runId), reason }),
  };
}
