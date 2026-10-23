import { useFlowClock } from "../host/context.js";
export function useThinkingElapsed(startedAt: number | null): number | null {
  const now = useFlowClock();
  return startedAt == null ? null : Math.max(0, now - startedAt);
}
