import { WORKFLOW_NODE_ICONS } from "./workflow-node-icon";
import {
  Check,
  Clock3,
  CircleAlert,
  LoaderCircle,
  SlidersHorizontal,
  Sparkles,
  Globe,
  Monitor,
  GitBranch,
  Package,
  MousePointer2,
} from "lucide-react";
import { workflowLevels } from "./lib/workflow-graph-view";
import {
  WORKFLOW_NODE_TYPES,
  type WorkflowNode,
  type WorkflowEdge,
} from "@shared/workflow.mjs";

export function WorkflowSteps({
  nodes,
  edges = [],
  facts,
  current,
  onSelect,
}: {
  nodes: WorkflowNode[];
  edges?: WorkflowEdge[];
  facts?: Record<string, { status: string }>;
  current?: string;
  onSelect: (id: string) => void;
}) {
  const statusLabels: Record<string, string> = {
    succeeded: "已完成",
    running: "执行中",
    waiting: "等待操作",
    failed: "失败",
    stopped: "已停止",
    interrupted: "执行中断",
    skipped: "已跳过",
  };
  return (
    <ol className="h59-steps" aria-label="流程步骤">
      {workflowLevels({ nodes, edges })
        .flat()
        .map((node) => {
          const status = facts?.[node.id]?.status;
          const TypeIcon = WORKFLOW_NODE_ICONS[node.type];
          const Icon = facts
            ? status === "succeeded"
              ? Check
              : status === "running"
                ? LoaderCircle
                : status === "failed"
                  ? CircleAlert
                  : Clock3
            : TypeIcon;
          return (
            <li key={node.id}>
              <button
                data-status={status ?? "pending"}
                aria-pressed={current === node.id}
                onClick={() => onSelect(node.id)}
              >
                <Icon aria-hidden="true" />
                <span>{node.data.title || node.id}</span>
                <small>
                  {facts
                    ? (statusLabels[status ?? ""] ?? "未开始")
                    : WORKFLOW_NODE_TYPES[node.type]?.label}
                </small>
              </button>
            </li>
          );
        })}
    </ol>
  );
}
