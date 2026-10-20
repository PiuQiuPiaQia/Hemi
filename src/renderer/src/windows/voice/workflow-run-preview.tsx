import { lazy, Suspense, useEffect, useState } from "react";
const RunGraph = lazy(() =>
  import("./workflow-canvas").then((module) => ({
    default: module.WorkflowRunGraph,
  })),
);
import { Check, Clock3, CircleAlert, LoaderCircle } from "lucide-react";
import { WorkflowSteps } from "./workflow-steps";
import type { WorkflowDocument } from "@shared/workflow.mjs";
const STATUS: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  waiting: "等待操作",
  completed: "已完成",
  succeeded: "已完成",
  skipped: "已跳过",
  failed: "失败",
  stopped: "已停止",
  stopping: "正在停止",
  interrupted: "执行中断",
};
type Call = {
  id: string;
  stage: string;
  role?: string;
  model: string;
  nodeId?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  missing?: number;
};
type NodeFact = {
  status: string;
  error?: string;
  outputs?: Record<string, unknown>;
  attemptId?: string;
  startedAt?: number;
  finishedAt?: number;
  log?: Array<{ at: number; tool: string; kind: string; isError?: boolean }>;
  attempts?: Array<{ attemptId: string; status: string }>;
};
type Invocation = {
  name?: string;
  definitionRevision: number;
  documentSnapshot: WorkflowDocument;
  usageCalls?: Call[];
  preparation: { values: Record<string, unknown> };
  run: null | {
    status: string;
    currentNodeId?: string;
    frozenValues?: Record<string, unknown>;
    modelPlan?: { config: { model: string }; routed: boolean };
    nodes: Record<string, NodeFact>;
    issues?: Array<{ message: string }>;
  };
};
const renderValue = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);
export function WorkflowRunPreview({ invocationId }: { invocationId: string }) {
  const [showGraph, setShowGraph] = useState(false);
  const [invocation, setInvocation] = useState<Invocation | null>(null),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const record =
          await window.hemiVoice.workflowGetInvocation(invocationId);
        if (alive) {
          setInvocation(record as Invocation | null);
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
      if (timer) clearTimeout(timer);
    };
  }, [invocationId]);
  const current =
    selected ??
    invocation?.run?.currentNodeId ??
    invocation?.documentSnapshot.nodes[0]?.id;
  const node = invocation?.documentSnapshot.nodes.find((n) => n.id === current),
    fact = current ? invocation?.run?.nodes[current] : undefined;
  return (
    <div
      className="h59-run-preview selectable"
      data-testid="workflow-run-preview"
    >
      <h2>{invocation?.name || "本次流程"}</h2>
      {error ? <p role="alert">{error}</p> : null}
      {!invocation ? (
        <p>读取中…</p>
      ) : (
        <>
          <p>
            v{invocation.definitionRevision} ·{" "}
            {STATUS[invocation.run?.status ?? ""] ?? "准备参数"}
          </p>
          {invocation.run?.modelPlan ? (
            <p>
              执行模型：{invocation.run.modelPlan.routed ? "自动路由 · " : ""}
              {invocation.run.modelPlan.config.model}
            </p>
          ) : null}
          <details open>
            <summary>本次输入</summary>
            <dl>
              {Object.entries(
                invocation.run?.frozenValues ?? invocation.preparation.values,
              ).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{renderValue(value)}</dd>
                </div>
              ))}
            </dl>
          </details>
          <button onClick={() => setShowGraph((show) => !show)}>
            {showGraph ? "收起运行画布" : "查看运行画布"}
          </button>
          {showGraph ? (
            <Suspense fallback={<p>加载运行画布…</p>}>
              <RunGraph
                key={invocationId}
                document={invocation.documentSnapshot}
                nodes={invocation.run?.nodes ?? {}}
                onSelect={setSelected}
              />
            </Suspense>
          ) : null}
          <p className="h59-preview-progress">
            {
              Object.values(invocation.run?.nodes ?? {}).filter(
                (node) => node.status === "succeeded",
              ).length
            }{" "}
            / {invocation.documentSnapshot.nodes.length} 个步骤完成
          </p>
          <WorkflowSteps
            nodes={invocation.documentSnapshot.nodes}
            edges={invocation.documentSnapshot.edges}
            facts={invocation.run?.nodes ?? {}}
            current={current}
            onSelect={setSelected}
          />
          {node ? (
            <section aria-label="步骤详情">
              <h3>{node.data.title || node.id}</h3>
              <p>{node.data.goal || node.data.summary || "输入参数"}</p>
              {fact?.attemptId ? (
                <small>
                  本步骤第 {(fact.attempts?.length ?? 0) + 1} 次尝试
                </small>
              ) : null}
              {fact?.error ? <p className="h59-error">{fact.error}</p> : null}
              {node.data.inputBindings?.length ? (
                <details>
                  <summary>输入来源</summary>
                  {node.data.inputBindings.map((b, i) => (
                    <p key={i}>
                      {String(("as" in b ? b.as : undefined) ?? b.key)}：
                      {b.kind === "parameter" ? "本次参数" : b.nodeId} / {b.key}
                    </p>
                  ))}
                </details>
              ) : null}
              <dl>
                {Object.entries(fact?.outputs ?? {})
                  .filter(([key]) => !key.startsWith("__"))
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{renderValue(value)}</dd>
                    </div>
                  ))}
              </dl>
              {fact?.log?.length ? (
                <details open>
                  <summary>执行过程</summary>
                  <ul>
                    {fact.log.map((event, i) => (
                      <li key={i}>
                        {new Date(event.at).toLocaleTimeString()} · {event.tool}{" "}
                        ·{" "}
                        {event.kind === "tool-start"
                          ? "开始"
                          : event.isError
                            ? "失败"
                            : "结束"}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {fact?.attempts?.length ? (
                <details>
                  <summary>之前的尝试</summary>
                  {fact.attempts.map((a, index) => (
                    <p key={a.attemptId}>
                      第 {index + 1} 次 · {STATUS[a.status] ?? a.status}
                    </p>
                  ))}
                </details>
              ) : null}
            </section>
          ) : null}
          {invocation.usageCalls?.length ? (
            <details>
              <summary>
                实际模型与用量（{invocation.usageCalls.length} 次请求）
              </summary>
              {invocation.usageCalls.map((call) => (
                <p key={call.id}>
                  {call.stage === "preparation" ? "准备参数" : "节点执行"} ·{" "}
                  {call.role ?? "main"} · {call.model}：
                  {call.missing
                    ? "上游未返回用量"
                    : `输入 ${call.input ?? 0} / 缓存读 ${call.cacheRead ?? 0} / 缓存写 ${call.cacheWrite ?? 0} / 输出 ${call.output ?? 0}`}
                </p>
              ))}
            </details>
          ) : null}
          {invocation.run?.issues
            ?.filter((issue) => issue.message !== fact?.error)
            .map((issue, i) => (
              <p key={i} className="h59-error">
                {issue.message}
              </p>
            ))}
        </>
      )}
    </div>
  );
}
