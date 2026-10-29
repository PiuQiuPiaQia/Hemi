export type ConversationControl = {ownerId: string; epoch: string; expiresAt: number; leaving?: boolean};
export type ConversationControlReceipt = {ok?: boolean; control?: ConversationControl | null; released?: boolean};

/** Apply only authority acknowledged upstream; an active owner's deferred release is not a release. */
export function applyConversationControl<T extends {id: string; control?: ConversationControl | null}>(
  items: T[], id: string, receipt: ConversationControlReceipt,
): T[] {
  if (receipt.ok !== true && !receipt.control) return items;
  if (!Object.hasOwn(receipt, 'control') && receipt.released !== true) return items;
  const control = receipt.released === true ? null : receipt.control ?? null;
  if (control && (typeof control.ownerId !== 'string' || typeof control.epoch !== 'string' || !Number.isFinite(control.expiresAt))) return items;
  return items.map(item => item.id === id ? {...item, control} : item);
}
