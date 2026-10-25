import type { FlowSnapshotView, MessageAttachmentView, MessageReferenceView, SkillSelectionView } from '../../../../shared/protocol';
import type { TranscriptItem } from '../../shared/types';

/** Local display only. Host snapshots, input identities and generations remain authoritative. */
export type PendingBotInput = {
  conversationId: string;
  instanceId: string;
  generation: number;
  requestId: string;
  kind: 'send' | 'rewind';
  targetInputId?: string;
  controlEpoch?: string;
  draftRevision?: number;
  createdAt: number;
  input: {
    inputId: string;
    text: string;
    attachmentIds: string[];
    attachmentViews: MessageAttachmentView[];
    references: MessageReferenceView[];
    skills: SkillSelectionView[];
  };
};

export function botInputObserved(flow: FlowSnapshotView, submission: PendingBotInput): boolean {
  return flow.pending.some(item => item.inputId === submission.input.inputId)
    || flow.timeline.some(item => item.kind === 'user' && item.id === submission.input.inputId);
}

export function botInputCurrent(flow: FlowSnapshotView, submission: PendingBotInput): boolean {
  if (flow.conversationId !== submission.conversationId) return false;
  if (flow.generation === submission.generation) return true;
  return submission.kind === 'rewind' && flow.generation === submission.generation + 1
    && Object.values(flow.runs).some(run => Array.isArray(run.inputIds) && run.inputIds.includes(submission.input.inputId));
}

export function projectPendingBotInputs(flow: FlowSnapshotView, transcripts: TranscriptItem[], submissions: readonly PendingBotInput[]): TranscriptItem[] {
  let rows = transcripts;
  for (const submission of submissions) {
    if (!botInputCurrent(flow, submission) || botInputObserved(flow, submission)) continue;
    if (submission.kind === 'rewind' && flow.generation === submission.generation) {
      const cut = rows.findIndex(row => row.author === 'user' && (row.flow?.inputId ?? row.id) === submission.targetInputId);
      if (cut < 0) continue;
      rows = rows.slice(0, cut);
    }
    const input = submission.input;
    const row: TranscriptItem = { id: input.inputId, author: 'user', inputSource: 'text', text: input.text,
      createdAt: submission.createdAt, attachments: input.attachmentViews, references: input.references, skills: input.skills,
      pendingDelivery: true };
    // Preparing snapshots can precede durable delivery; keep the input above its own status row.
    const reply = rows.findIndex(item => {
      const ids = item.flow?.runId && flow.runs[item.flow.runId]?.inputIds;
      return item.author === 'hemi' && Array.isArray(ids) && ids.includes(input.inputId);
    });
    rows = reply < 0 ? [...rows, row] : [...rows.slice(0, reply), row, ...rows.slice(reply)];
  }
  return rows;
}
