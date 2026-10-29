import type { FlowSnapshotView } from './protocol.js';
import type { TranscriptItem } from '../types/presentation.js';

/** Continue a failed conversation without replaying its original input or attachments. */
export function retryInput(transcripts: TranscriptItem[], _snapshot: FlowSnapshotView | null) {
  const failure = transcripts.at(-1);
  if (failure?.kind !== 'error') return null;
  const runId = failure.flow?.runId;
  const users = runId
    ? transcripts.filter(item => item.author === 'user' && item.flow?.runId === runId)
    : [[...transcripts].reverse().find(item => item.author === 'user' && !item.withdrawn)].filter((item): item is TranscriptItem => Boolean(item));
  if (!users.length) return null;
  return {
    text: '继续',
    inputSource: 'text' as const,
    attachmentIds: [],
    attachmentViews: [],
    references: [],
    skills: [],
  };
}
