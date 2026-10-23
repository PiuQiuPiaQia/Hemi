import { useFlowClock } from "../host/context.js";
export function useRunningClock(_running = true) {
  return useFlowClock();
}
