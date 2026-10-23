import type { FlowSnapshotView, TurnQueueState } from './protocol.js';
import type { ConversationOperation } from './conversation.js';

export function projectConversationQueue(snapshot: FlowSnapshotView | null, operations: readonly ConversationOperation[] = []): TurnQueueState {
  return {
    paused: snapshot?.queuePaused ?? false,
    items: [...(snapshot?.pending ?? []).filter(input => ['pending', 'needs-review', 'editing'].includes(input.state)).map<TurnQueueState['items'][number]>(input => ({
      queueItemId: input.inputId, readOnly: Boolean(input.workflow), conversationId: snapshot!.conversationId,
      text: input.text, revision: (input.editRevision ?? 0) + 1,
      dispatchState: input.state === 'editing' ? 'editing' : input.promoteAt != null ? 'promoting' : 'pending',
      error: input.state === 'needs-review' ? '投递结果不明，待核对' : '',
      attachmentIds: input.attachmentIds ?? [], references: input.references ?? [], skills: input.skills ?? [],
      inputSource: input.inputSource ?? 'text', createdAt: input.createdAt ?? 0,
    })), ...operations.flatMap(operation => {
      if (operation.command.type !== 'send' || !['waiting', 'unknown'].includes(operation.state)) return [];
      const input = operation.command.input as { inputId?: string; text?: string } | undefined;
      if (snapshot?.pending.some(item => item.inputId === input?.inputId) || snapshot?.timeline.some(item => item.kind === 'user' && item.id === input?.inputId)) return [];
      return [{ operationId: operation.id, queueItemId: `operation:${operation.id}`, conversationId: snapshot?.conversationId ?? '',
        text: input?.text ?? '', revision: 1, dispatchState: 'pending' as const, error: operation.state === 'unknown' ? '投递结果不明，待核对' : '',
        attachmentIds: [], references: [], createdAt: 0, inputSource: 'text' as const }];
    })],
  };
}

export const queueStoppedIdle = (snapshot: FlowSnapshotView | null) => snapshot?.phase === 'idle' && snapshot.queuePaused && snapshot.pending.length === 0
  && !['expired', 'failed'].includes(Object.values(snapshot.runs).at(-1)?.recovery?.phase ?? '');
