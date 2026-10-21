import { useEffect, useState } from 'react';

/** Only mounted thinking indicators tick; a null start stops and cleans up the timer. */
export function useThinkingElapsed(startedAt: number | null): number | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (startedAt == null) return;
    const timer = window.setInterval(() => force(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt == null ? null : Math.max(0, Date.now() - startedAt);
}
