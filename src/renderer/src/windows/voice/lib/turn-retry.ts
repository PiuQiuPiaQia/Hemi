import type { FlowSnapshotView } from '@shared/protocol';
import type { TranscriptItem } from '@/shared/types';

/** Recover the failed input from conversation facts, including after navigation/restart. */
export function retryInput(transcripts: TranscriptItem[], snapshot: FlowSnapshotView | null) {
  const failure = transcripts.at(-1);
  if (failure?.kind !== 'error') return null;
  const runId = failure.flow?.runId;
  const users = runId
    ? transcripts.filter(item => item.author === 'user' && item.flow?.runId === runId)
    : [[...transcripts].reverse().find(item => item.author === 'user' && !item.withdrawn)].filter((item): item is TranscriptItem => Boolean(item));
  if (!users.length) return null;
  const inputs = users.map(item => {
    const source = snapshot?.timeline.find(input => input.kind === 'user' && input.id === item.id);
    return { ...item, attachmentIds: source?.kind === 'user' ? source.attachmentIds : (item.attachments ?? []).map(view => view.attachmentId) };
  });
  const unique = <T,>(items: T[], key: (item: T) => string) => [...new Map(items.map(item => [key(item), item])).values()];
  const input = {
    text: inputs.map(item => item.text).filter(Boolean).join('\n\n'),
    inputSource: inputs.at(-1)?.inputSource ?? 'text',
    attachmentIds: [...new Set(inputs.flatMap(item => item.attachmentIds))],
    attachmentViews: unique(inputs.flatMap(item => item.attachments ?? []), item => item.attachmentId),
    references: unique(inputs.flatMap(item => item.references ?? []), item => item.key),
    skills: unique(inputs.flatMap(item => item.skills ?? []), item => item.skillId || item.token),
  };
  return input.text.trim() || input.attachmentIds.length ? input : null;
}
