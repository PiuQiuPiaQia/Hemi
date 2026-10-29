export type ConversationListEntry = {id: string; updatedAt?: number; pinned?: boolean};

/** Explicit navigation refreshes recency; viewing a conversation never changes its timestamp. */
export function sortConversationsByUpdatedAt<T extends ConversationListEntry>(items: readonly T[]): T[] {
  return [
    ...items.filter(item => item.pinned),
    ...items.filter(item => !item.pinned).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
  ];
}

/** Live metadata updates keep existing rows and date groups stable; new rows appear first. */
export function reconcileConversationList<T extends ConversationListEntry>(previous: readonly T[], incoming: readonly T[], refreshOrder = false): T[] {
  if (refreshOrder) return [...incoming];
  const previousIds = new Set(previous.map(item => item.id));
  const incomingById = new Map(incoming.map(item => [item.id, item]));
  return [
    ...incoming.filter(item => !previousIds.has(item.id)),
    ...previous.flatMap(previousItem => {
      const item = incomingById.get(previousItem.id);
      return item ? [{...item, updatedAt: previousItem.updatedAt}] : [];
    }),
  ];
}
