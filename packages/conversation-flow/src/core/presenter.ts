import type { FlowActionHandler, MessageView } from '../types/api.js';
import type { TranscriptItem } from '../types/presentation.js';
import type { FlowInputView, FlowSnapshotView } from './protocol.js';
import type { ConversationClient, ConversationClientState } from './conversation.js';
import { createFlowTimelineProjector } from './flow-timeline-view.js';
import { retryInput } from './turn-retry.js';

export function messageViewFromTranscript(item: TranscriptItem): MessageView {
  return {
    ...item, author: item.author === 'hemi' ? 'assistant' : 'user', task: item.taskSnap,
    runId: item.flow?.runId, inputId: item.flow?.inputId, itemId: item.flow?.itemId, partIds: item.flow?.partIds,
    revision: String(item.editedAt ?? item.createdAt),
    actions: { edit: item.author === 'user' && item.kind !== 'task' && !item.pendingDelivery, retry: item.kind === 'error', stop: true, preview: true },
  };
}

/** One optimistic projection for every host; the authoritative queue is never changed locally. */
export function createConversationTranscriptPresenter() {
  const project = createFlowTimelineProjector();
  const observed = new Set<string>();
  return (snapshot: FlowSnapshotView | null, archive: TranscriptItem[] = [], delivery?: Pick<ConversationClientState, 'operations' | 'connection'>): TranscriptItem[] => {
    if (!snapshot) return [];
    let messages = project(snapshot, archive).transcripts;
    const known = new Set([...snapshot.timeline.filter(item => item.kind === 'user').map(item => item.id), ...snapshot.pending.map(input => input.inputId)]);
    const blocked = delivery?.operations.some(operation => operation.state === 'unknown');
    const operationIds = new Set(delivery?.operations.map(operation => operation.id));
    for (const id of observed) if (!operationIds.has(id)) observed.delete(id);
    for (const operation of delivery?.operations ?? []) {
      const rewind = operation.command.type === 'rewind';
      if (!rewind && operation.command.type !== 'send') continue;
      const input = operation.command.input as Partial<FlowInputView> | undefined;
      if (!input?.inputId) continue;
      const ownRewind = rewind && operation.generation !== null && snapshot.generation === operation.generation + 1
        && Object.values(snapshot.runs).some(run => (run.inputIds as string[] | undefined)?.includes(input.inputId!));
      if (operation.generation !== null && operation.generation !== snapshot.generation && !ownRewind) continue;
      if (known.has(input.inputId)) {observed.add(operation.id); continue;}
      if (observed.has(operation.id)) continue;
      if (rewind && operation.state === 'rejected') {
        messages = messages.map(item => item.id === operation.command.targetInputId
          ? {...item, editDraft: {revision: operation.id, text: input.text ?? ''}} : item);
        continue;
      }
      // Bridge the journal/receipt/snapshot gap without inventing a Host queue entry.
      // Uncertain or rejected deliveries keep their existing recovery UI and draft.
      if (operation.state !== 'accepted' && (delivery?.connection !== 'online' || blocked
        || !['waiting', 'sending'].includes(operation.state) || operation.result?.ok === false)) continue;
      if (operation.state === 'accepted' && operation.result?.revision !== undefined && snapshot.revision >= operation.result.revision) continue;
      if (rewind && !ownRewind) {
        const cut = messages.findIndex(item => item.author === 'user' && item.id === operation.command.targetInputId);
        if (cut < 0) continue;
        messages = messages.slice(0, cut);
      }
      known.add(input.inputId);
      const message: TranscriptItem = {id: input.inputId, author: 'user', text: input.text ?? '',
        createdAt: operation.createdAt ?? 0, inputSource: input.inputSource ?? 'text', pendingDelivery: true,
        attachments: input.attachmentViews, references: input.references, skills: input.skills};
      // A preparing run is published before its input is durably delivered. Its waiting
      // row already exists, so place that input before its own reply, not after it.
      const replyIndex = messages.findIndex(row => {
        const inputIds = row.flow?.runId && snapshot.runs[row.flow.runId]?.inputIds;
        return row.author === 'hemi' && Array.isArray(inputIds) && inputIds.includes(input.inputId);
      });
      if (replyIndex < 0) messages.push(message);
      else messages.splice(replyIndex, 0, message);
    }
    return messages;
  };
}

export function createConversationPresenter() {
  const present = createConversationTranscriptPresenter();
  return (...args: Parameters<typeof present>): MessageView[] => present(...args).map(messageViewFromTranscript);
}

/** Shared ordinary conversation actions. Hosts can supply task/workflow/preview-specific commands. */
export function createConversationActionHandler(client: ConversationClient, fallback?: FlowActionHandler): FlowActionHandler {
  return async (action, context) => {
    if (context.signal.aborted || action.scope.environmentId !== client.scope.environmentId
      || action.scope.conversationId !== client.scope.conversationId
      || action.scope.generation !== String(client.getSnapshot().snapshot?.generation ?? 1)) {
      return { ok: false, error: { code: 'cancelled', message: '会话已切换' } };
    }
    let command: Record<string, unknown>;
    const snapshot = client.getSnapshot().snapshot;
    if (action.type === 'message.edit-state') return { ok: true, value: { receipt: 'completed' } };
    if (action.type === 'recovery.retry') command = { type: 'retryRecovery', targetRunId: action.runId, recoveryId: action.recoveryId };
    else if (action.type === 'run.stop') command = { type: 'stop', targetRunId: action.targetId || snapshot?.activeRunId };
    else if (action.type === 'message.edit') {
      const source = snapshot?.timeline.find(item => item.kind === 'user' && item.id === action.targetId);
      if (!source || source.kind !== 'user') return { ok: false, error: { code: 'not-found', message: '消息已不存在' } };
      command = { type: 'rewind', targetInputId: source.id,
        input: { text: action.nextText, inputSource: source.inputSource, attachmentIds: source.attachmentIds, references: source.references, skills: source.skills } };
    } else if (action.type === 'message.retry') {
      const input = snapshot ? retryInput(createFlowTimelineProjector()(snapshot).transcripts, snapshot) : null;
      if (!input) return { ok: false, error: { code: 'not-found', message: '没有可重试的输入' } };
      command = { type: 'send', input };
    } else return fallback ? fallback(action, context) : { ok: false, error: { code: 'unsupported', message: '宿主尚未提供此操作' } };
    const result = await client.sendCommand(command);
    if (!result.ok) return { ok: false, error: { code: result.code === 'unknown' ? 'unknown' : result.code === 'offline' ? 'offline' : 'failed', message: result.message ?? '操作未完成' } };
    return { ok: true, value: { receipt: result.disposition === 'local-queued' ? 'accepted' : 'completed' } };
  };
}
