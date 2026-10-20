import type { WorkflowDocument, WorkflowNode } from "@shared/workflow.mjs";

/** SDK serialization order may change after selection; dirty state is semantic. */
export function workflowEditFingerprint(
  document: WorkflowDocument,
  title: string,
) {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, stable(item)]),
          )
        : value;
  return JSON.stringify(
    stable({
      title,
      nodes: [...document.nodes].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...document.edges].sort((a, b) =>
        JSON.stringify(stable(a)).localeCompare(JSON.stringify(stable(b))),
      ),
    }),
  );
}

// 展示顺序来自依赖图；节点数组的保存顺序不能冒充执行顺序。
export function workflowLevels(document: WorkflowDocument): WorkflowNode[][] {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const incoming = new Map(document.nodes.map((node) => [node.id, 0]));
  const depth = new Map<string, number>();
  for (const edge of document.edges)
    if (nodes.has(edge.sourceNodeID) && nodes.has(edge.targetNodeID))
      incoming.set(
        edge.targetNodeID,
        (incoming.get(edge.targetNodeID) ?? 0) + 1,
      );
  const queue = document.nodes
    .filter((node) => incoming.get(node.id) === 0)
    .map((node) => node.id);
  const ordered: WorkflowNode[][] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const level = depth.get(id) ?? 0;
    (ordered[level] ??= []).push(nodes.get(id)!);
    for (const edge of document.edges.filter(
      (edge) => edge.sourceNodeID === id,
    )) {
      if (!nodes.has(edge.targetNodeID)) continue;
      depth.set(
        edge.targetNodeID,
        Math.max(depth.get(edge.targetNodeID) ?? 0, level + 1),
      );
      incoming.set(
        edge.targetNodeID,
        (incoming.get(edge.targetNodeID) ?? 0) - 1,
      );
      if (incoming.get(edge.targetNodeID) === 0) queue.push(edge.targetNodeID);
    }
  }
  const unresolved = document.nodes.filter((node) => !seen.has(node.id));
  if (unresolved.length) ordered.push(unresolved);
  return ordered;
}
