import { useEffect, useState } from "react";
import { useFlow } from "./context.js";
import type { FlowResult, ResourceLease, ResourceRef } from "../types/api.js";

export function useResource(
  ref: ResourceRef | null,
  purpose: "thumbnail" | "preview",
  enabled = true,
  attempt = 0,
) {
  const { runtime } = useFlow();
  const key = JSON.stringify([ref?.id, ref?.version, purpose, attempt]);
  const [value, setValue] = useState<{
    key: string;
    runtime: typeof runtime;
    result: FlowResult<ResourceLease>;
  } | null>(null);
  useEffect(() => {
    if (!ref || !enabled) return;
    let alive = true;
    const acquired = runtime.acquire(ref, purpose);
    void acquired.result.then((result) => {
      if (alive && !runtime.disposed) setValue({ key, runtime, result });
    });
    return () => {
      alive = false;
      acquired.release();
    };
  }, [runtime, key, enabled]);
  return value?.key === key && value.runtime === runtime ? value.result : null;
}
