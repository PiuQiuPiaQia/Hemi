import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ConversationClient } from './core/conversation.js';

/** The caller owns a stable client per environment/conversation; StrictMode cleanup is retained. */
export function useConversation(client: ConversationClient, { enabled = true }: { enabled?: boolean } = {}) {
  useEffect(() => enabled ? client.retain() : undefined, [client, enabled]);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const draft = useSyncExternalStore(client.draft.subscribe, client.draft.getSnapshot, client.draft.getSnapshot);
  return { ...state, draft, client };
}

/** Brief startup/resume interruptions recover silently; warn after sustained foreground failure. */
export function useConnectionWarning(offline: boolean, scope: string, delayMs = 10000) {
  const [warningScope, setWarningScope] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restart = () => {
      clearTimeout(timer);
      setWarningScope(null);
      if (offline && (typeof document === 'undefined' || !document.hidden))
        timer = setTimeout(() => setWarningScope(scope), delayMs);
    };
    restart();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', restart);
    return () => {
      clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', restart);
    };
  }, [offline, scope, delayMs]);
  return offline && warningScope === scope;
}
