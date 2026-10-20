import { useEffect, useState } from "react";
import type { WorkflowDocument } from "@shared/workflow.mjs";
import { WorkflowSteps } from "./workflow-steps";

/**
 * 059 工作流定义预览（S4d）：右侧预览 Tab 的只读正文（契约 §8）——保存版本的
 * 节点结构列表（类型/标题/参数/绑定）＋边连线，不启动、不改参数；编辑入口在
 * 工作流页画布。
 */
type DefinitionDocument = WorkflowDocument;

const TYPE_LABEL: Record<string, string> = {
  "hemi-input": "输入",
  "hemi-agent": "普通执行",
  "hemi-skill": "Skill",
  "hemi-browser": "浏览器操作",
  "hemi-desktop": "桌面操作",
  "hemi-condition": "条件",
  "hemi-deliver": "交付",
};

function nodeLines(node: {
  id: string;
  type: string;
  data?: Record<string, unknown>;
}): string[] {
  const data = node.data ?? {};
  const out: string[] = [];
  if (typeof data.goal === "string" && data.goal.trim())
    out.push(`目标：${data.goal}`);
  if (Array.isArray(data.parameters)) {
    const params = (
      data.parameters as Array<{
        key: string;
        label?: string;
        type: string;
        required?: boolean;
      }>
    )
      .map((p) => p.label || p.key)
      .join("、");
    if (params) out.push(params);
  }
  if (Array.isArray(data.skillRefs)) {
    const skills = (data.skillRefs as Array<{ name?: string }>)
      .map((s) => s.name)
      .filter(Boolean)
      .join("、");
    if (skills) out.push(`Skill：${skills}`);
  }
  if (typeof data.targetUrl === "string" && data.targetUrl)
    out.push(`目标：${data.targetUrl}`);
  if (typeof data.applicationRef === "string" && data.applicationRef)
    out.push(`应用：${data.applicationRef}`);
  if (Array.isArray(data.inputBindings)) {
    const bindings = (
      data.inputBindings as Array<{
        kind: string;
        key?: string;
        nodeId?: string;
      }>
    )
      .map((b) =>
        b.kind === "parameter" ? `参数 ${b.key}` : `「${b.nodeId}」的 ${b.key}`,
      )
      .join("、");
    if (bindings) out.push(`输入绑定：${bindings}`);
  }
  return out;
}

export function WorkflowDefinitionPreview({
  workflowId,
  revision,
}: {
  workflowId: string;
  revision: number;
}) {
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "ready"; name: string; document: DefinitionDocument }
  >({ phase: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ phase: "loading" });
    window.hemiVoice
      .workflowGetRevision(workflowId, revision)
      .then((record) => {
        if (!alive) return;
        if (!record?.document) {
          setState({
            phase: "error",
            message: `版本 ${revision} 读不到（可能已被删除）`,
          });
          return;
        }
        setState({
          phase: "ready",
          name: record.name,
          document: record.document as DefinitionDocument,
        });
      })
      .catch((error) => {
        if (alive)
          setState({
            phase: "error",
            message: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      alive = false;
    };
  }, [workflowId, revision]);

  const [selected, setSelected] = useState<string | null>(null);
  const selectedNode =
    state.phase === "ready"
      ? (state.document.nodes.find((node) => node.id === selected) ??
        state.document.nodes[0])
      : null;
  return (
    <div
      className="h59-run-preview h59-definition-preview selectable"
      data-testid="workflow-definition-preview"
    >
      {state.phase === "loading" ? (
        <p role="status">读取中…</p>
      ) : state.phase === "error" ? (
        <p role="alert">{state.message}</p>
      ) : (
        <>
          <header className="h59-definition-meta">
            <span>流程预览 · v{revision}</span>
            <span>尚未运行</span>
          </header>
          <div className="h59-definition-body">
            <h3>
              {[
                state.document.nodes.some((n) => n.type === "hemi-input")
                  ? "输入"
                  : null,
                state.document.nodes.some((n) =>
                  [
                    "hemi-agent",
                    "hemi-skill",
                    "hemi-browser",
                    "hemi-desktop",
                  ].includes(n.type),
                )
                  ? state.document.nodes.some(
                      (n) => n.type === "hemi-condition",
                    )
                    ? "执行与分支"
                    : "执行步骤"
                  : null,
                state.document.nodes.some((n) => n.type === "hemi-deliver")
                  ? "交付"
                  : null,
              ]
                .filter(Boolean)
                .join(" → ")}
            </h3>
            <p className="h59-hint">
              点击步骤查看说明，开始运行后在这里查看进展。
            </p>
            <WorkflowSteps
              nodes={state.document.nodes}
              edges={state.document.edges}
              current={selectedNode?.id}
              onSelect={setSelected}
            />
            {selectedNode ? (
              <section aria-label="步骤详情">
                <header>
                  <h3>{selectedNode.data.title || selectedNode.id}</h3>
                  <small className="h59-hint">
                    {TYPE_LABEL[selectedNode.type]}
                  </small>
                </header>
                {nodeLines(selectedNode).map((line, index) => (
                  <p key={index}>{line}</p>
                ))}
              </section>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
