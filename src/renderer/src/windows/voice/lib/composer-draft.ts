import type { MessageAttachmentView, MessageReferenceView, SkillSelectionView } from '@/shared/types';

type Draft = { revision: number; text: string; attachments: MessageAttachmentView[]; references: MessageReferenceView[]; skills: SkillSelectionView[] };
type Update<T> = T | ((current: T) => T);

/** 受理回执只能清其提交版本。编辑→撤销为同文也算新版本，不能用正文相等猜身份。 */
export function createComposerDraft() {
  let value: Draft = { revision: 0, text: '', attachments: [], references: [], skills: [] };
  let previous: Draft | null = null;
  let textRevision = 0;
  const listeners = new Set<() => void>();
  const update = <K extends 'text' | 'attachments' | 'references' | 'skills'>(key: K, next: Update<Draft[K]>) => {
    const item = typeof next === 'function' ? (next as (current: Draft[K]) => Draft[K])(value[key]) : next;
    value = { ...value, [key]: item, revision: value.revision + 1 };
    if (key === 'text') textRevision += 1;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => value,
    getTextRevision: () => textRevision,
    getPersistentSnapshot: () => previous ?? value,
    beginQueueEdit(input: Omit<Draft, 'revision'>, minRevision = 0) {
      if (previous) return false;
      previous = value;
      value = { ...input, revision: Math.max(value.revision, minRevision) + 1 };
      textRevision += 1;
      for (const listener of listeners) listener();
      return true;
    },
    endQueueEdit() {
      if (!previous) return;
      value = { ...previous, revision: value.revision + 1 };
      previous = null;
      textRevision += 1;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setText: (next: Update<string>) => update('text', next),
    setAttachments: (next: Update<MessageAttachmentView[]>) => update('attachments', next),
    setReferences: (next: Update<MessageReferenceView[]>) => update('references', next),
    setSkills: (next: Update<SkillSelectionView[]>) => update('skills', next),
    accept(revision: number) {
      if (value.revision !== revision) return false;
      value = { revision: value.revision + 1, text: '', attachments: [], references: [], skills: [] };
      textRevision += 1;
      for (const listener of listeners) listener();
      return true;
    },
  };
}
