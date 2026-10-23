import type { FlowRuntime } from "./runtime.js";
import { failure } from "./runtime.js";
import type { ResourceRef, ResourceActionView } from "../types/api.js";
export async function performResourceKind(
  runtime: FlowRuntime,
  ref: ResourceRef,
  kind: ResourceActionView["kind"],
) {
  if (!runtime.can("resourceActions"))
    return failure("unsupported", "当前环境未提供文件操作");
  const actions = await runtime.invoke((context) =>
    runtime.host!.resources!.listActions!({ ref }, context),
  );
  if (!actions.ok) return actions;
  const action = actions.value.find(
    (item) => item.kind === kind && !item.disabledReason,
  );
  if (!action) return failure("unsupported", "当前环境不支持此文件操作");
  return runtime.invoke((context) =>
    runtime.host!.resources!.perform!({ ref, actionId: action.id }, context),
  );
}
