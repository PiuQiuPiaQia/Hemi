import type { WorkflowInputParameter } from "./workflow.mjs";
export type DateContext = { now?: number; timeZone?: string };
export function resolveRelativeDate(
  value: string,
  context?: DateContext,
): string | null;
export function resolveParameterDefaults(
  parameters: WorkflowInputParameter[],
  context?: DateContext,
): {
  values: Record<string, unknown>;
  sources: Record<string, unknown>;
  issues: Array<{ code: string; field: string; message: string }>;
};
