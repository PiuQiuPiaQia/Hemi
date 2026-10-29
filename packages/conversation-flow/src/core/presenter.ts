import type { FlowActionHandler, MessageView } from '../types/api.js';
import type { TranscriptItem } from '../types/presentation.js';
import type { FlowSnapshotView } from './protocol.js';
import type { ConversationClient, ConversationClientState } from './conversation.js';
import { createFlowTimelineProjector } from './flow-timeline-view.js';
import { retryInput } from './turn-retry.js';

export function messageViewFromTranscript(item: TranscriptItem): MessageView {
  return {
    ...item, author: item.author === 'hemi' ? 'assistant' : 'user', task: item.taskSnap,
    runId: item.flow?.runId, inputId: item.flow?.inputId, itemId: item.flow?.itemId, partIds: item.flow?.partIds,
    revision: String(item.editedAt ?? item.createdAt),
    actions: { edit: item.author === 'user' && item.kind !== 'task', retry: item.kind === 'error', stop: true, preview: true },
  };
}

/** Messages and history cuts come only from the Host, just like the local PC timeline. */
export function createConversationTranscriptPresenter() {
  const project = createFlowTimelineProjector();
  return (snapshot: FlowSnapshotView | null, archive: TranscriptItem[] = [], delivery?: Pick<ConversationClientState, 'operations' | 'connection'>): TranscriptItem[] => {
    if (!snapshot) return [];
    let messages = project(snapshot, archive).transcripts;
    for (const operation of delivery?.operations ?? []) {
      if (operation.command.type !== 'rewind' || operation.state !== 'rejected'
        || operation.generation !== snapshot.generation) continue;
      const input = operation.command.input as {text?: string} | undefined;
      // Recover an unsuccessful edit without changing delivered history.
      messages = messages.map(item => item.id === operation.command.targetInputId
        ? {...item, editDraft: {revision: operation.id, text: input?.text ?? ''}} : item);
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
    else if (action.type === 'background.command') command = {type:'backgroundCommand',targetRunId:action.targetId,action:action.action,jobId:action.jobId,from:action.from};
    else if (action.type === 'run.stop') command = { type: 'stop', targetRunId: action.targetId || snapshot?.activeRunId };
    else if (action.type === 'message.edit') {
      const source = snapshot?.timeline.find(item => item.kind === 'user' && item.id === action.targetId);
      if (!source || source.kind !== 'user') return { ok: false, error: { code: 'not-found', message: '消息已不存在' } };
      command = { type: 'rewind', targetInputId: source.id,
        input: { text: action.nextText, inputSource: source.inputSource, attachmentIds: source.attachmentIds, references: source.references, skills: source.skills } };
    } else if (action.type === 'message.retry') {
      const input = snapshot ? retryInput(createFlowTimelineProjector()(snapshot).transcripts, snapshot) : null;
      if (!input) return { ok: false, error: { code: 'not-found', message: '没有可继续的失败回合' } };
      command = { type: 'send', input };
    } else return fallback ? fallback(action, context) : { ok: false, error: { code: 'unsupported', message: '宿主尚未提供此操作' } };
    const result = await client.sendCommand(command);
    if (!result.ok) return { ok: false, error: { code: result.code === 'unknown' ? 'unknown' : result.code === 'offline' ? 'offline' : 'failed', message: result.message ?? '操作未完成' } };
    return { ok: true, value: { receipt: result.disposition === 'local-queued' ? 'accepted' : 'completed',data:result.data } };
  };
}
