import { useEffect, useSyncExternalStore } from 'react';
import type { ConversationClient } from './core/conversation.js';

/** The caller owns a stable client per environment/conversation; StrictMode cleanup is retained. */
export function useConversation(client: ConversationClient, { enabled = true }: { enabled?: boolean } = {}) {
  useEffect(() => enabled ? client.retain() : undefined, [client, enabled]);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const draft = useSyncExternalStore(client.draft.subscribe, client.draft.getSnapshot, client.draft.getSnapshot);
  return { ...state, draft, client };
}
