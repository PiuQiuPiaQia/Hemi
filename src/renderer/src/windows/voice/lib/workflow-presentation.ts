import type { WorkflowDocument } from "@shared/workflow.mjs";
import { workflowLevels } from "./workflow-graph-view";

export function workflowPresentation(
  document: WorkflowDocument | null,
  skillTitles: Map<string, string> = new Map(),
) {
  const delivery = document?.nodes.find((node) => node.type === "hemi-deliver");
  const artifacts = delivery?.data.artifacts ?? [];
  const sourceIds = new Set(
    artifacts.flatMap((artifact) =>
      artifact.binding.kind === "node-output" ? [artifact.binding.nodeId] : [],
    ),
  );
  const sources =
    document?.nodes.filter((node) => sourceIds.has(node.id)) ?? [];
  const descriptions = artifacts.map((artifact) => {
    const binding = artifact.binding;
    return binding.kind === "node-output"
      ? (document?.nodes.find((node) => node.id === binding.nodeId)?.data
          .outputSchema?.properties[binding.key]?.description ??
          artifact.label ??
          "")
      : (artifact.label ?? "");
  });
  const format =
    descriptions.length === 1 && /\.pptx?$/i.test(descriptions[0])
      ? "presentation"
      : descriptions.length === 1
        ? "file"
        : "folder";
  const levels = document ? workflowLevels(document) : [];
  const capabilities = [
    ...new Set(
      levels
        .flat()
        .flatMap((node) =>
          node.type === "hemi-browser"
            ? ["浏览器"]
            : node.type === "hemi-skill"
              ? [
                  `${skillTitles.get(node.data.skillRefs?.[0]?.name ?? "") || node.data.skillRefs?.[0]?.name || ""} Skill`,
                ]
              : node.type === "hemi-desktop"
                ? ["桌面应用"]
                : node.type === "hemi-agent"
                  ? ["普通执行"]
                  : [],
        ) ?? [],
    ),
  ];
  return {
    format,
    title: delivery?.data.summary || "流程定义的结果与文件",
    description: sources
      .map((node) => node.data.acceptance)
      .filter(Boolean)
      .join("；"),
    capabilities,
    outline: document
      ? levels
          .map((level) =>
            level
              .filter(
                (node) =>
                  node.type !== "hemi-input" && node.type !== "hemi-condition",
              )
              .map((node) => node.data.title || node.id)
              .join(" / "),
          )
          .filter(Boolean)
      : [],
  };
}
