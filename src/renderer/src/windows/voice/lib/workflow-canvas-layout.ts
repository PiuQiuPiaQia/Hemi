import {
  WorkflowLineRenderData,
  type WorkflowLineEntity,
  type FreeLayoutPluginContext,
  type DragNodeOperationValue,
} from "@flowgram.ai/free-layout-editor";
import type { CSSProperties } from "react";

/** A pointer click may settle an SDK drag session without moving a node.
 * Use its public operation metadata policy to keep clicks out of Undo. */
export function configureWorkflowHistory(ctx: FreeLayoutPluginContext) {
  const drag = ctx.history.operationRegistry.getOperationMeta("dragNodes");
  if (drag)
    drag.shouldSave = (operation) => {
      const { value, oldValue } = operation.value as DragNodeOperationValue;
      return value.some(
        (point, index) =>
          point.x !== oldValue[index]?.x || point.y !== oldValue[index]?.y,
      );
    };
}

export const workflowLineClass = (line: WorkflowLineEntity) =>
  line.from?.flowNodeType === "hemi-condition" ||
  line.from?.flowNodeType === "hemi-human-input"
    ? `h59-edge-branch h59-edge-${line.fromPort?.portID ?? ""}`
    : "";

/** FlowGram 1.0.16 can cache an empty first path with React 19. Sync in a
 * layout frame after mount/edits, using its ports, renderer and hit testing. */
export function updateWorkflowLines(ctx: FreeLayoutPluginContext) {
  const manager = ctx.document.linesManager;
  manager.setDefaultUIState({ shrink: 0, strokeWidth: 1.5 });
  for (const line of manager.getAllLines()) {
    if (!line.fromPort || !line.toPort) continue;
    line.updateUIState({ shrink: 0, strokeWidth: 1.5 });
    const data = line.getData(WorkflowLineRenderData);
    data.update();
    if (
      line.from?.flowNodeType === "hemi-condition" ||
      line.from?.flowNodeType === "hemi-human-input"
    )
      line.updateUIState({
        style: {
          "--h59-edge-label-x": `${line.toPort.point.x - data.bounds.x + 12}px`,
          "--h59-edge-label-y": `${(line.fromPort.point.y + line.toPort.point.y) / 2 - data.bounds.y + 12}px`,
        } as CSSProperties,
      });
  }
  manager.forceUpdate();
}
