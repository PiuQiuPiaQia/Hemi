import type { MessageAttachmentView, MessageReferenceView, SkillSelectionView } from '../types/presentation.js';

export type ComposerDraftSnapshot = { revision: number; token?: string; text: string; attachments: MessageAttachmentView[]; references: MessageReferenceView[]; skills: SkillSelectionView[] };
type Update<T> = T | ((current: T) => T);

/** 受理回执只能清其提交版本。编辑→撤销为同文也算新版本，不能用正文相等猜身份。 */
export function createComposerDraft() {
  const token = () => crypto.randomUUID();
  let value: ComposerDraftSnapshot = { revision: 0, token: token(), text: '', attachments: [], references: [], skills: [] };
  let previous: ComposerDraftSnapshot | null = null;
  let textRevision = 0;
  let contentRevision = 0;
  const listeners = new Set<() => void>();
  const update = <K extends 'text' | 'attachments' | 'references' | 'skills'>(key: K, next: Update<ComposerDraftSnapshot[K]>) => {
    const item = typeof next === 'function' ? (next as (current: ComposerDraftSnapshot[K]) => ComposerDraftSnapshot[K])(value[key]) : next;
    value = { ...value, [key]: item, revision: value.revision + 1, token: token() };
    if (key === 'text') textRevision += 1;
    if (key !== 'attachments') contentRevision += 1;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => value,
    getTextRevision: () => textRevision,
    getContentRevision: () => contentRevision,
    getPersistentSnapshot: () => previous ?? value,
    restore(input: Partial<ComposerDraftSnapshot>) {
      previous = null;
      value = { revision: Math.max(value.revision, input.revision ?? 0) + 1,
        token: typeof input.token === 'string' ? input.token : token(),
        text: input.text ?? '', attachments: input.attachments ?? [], references: input.references ?? [], skills: input.skills ?? [] };
      textRevision += 1;
      contentRevision += 1;
      for (const listener of listeners) listener();
    },
    beginQueueEdit(input: Omit<ComposerDraftSnapshot, 'revision'>, minRevision = 0) {
      if (previous) return false;
      previous = value;
      value = { ...input, revision: Math.max(value.revision, minRevision) + 1, token: token() };
      textRevision += 1;
      contentRevision += 1;
      for (const listener of listeners) listener();
      return true;
    },
    endQueueEdit() {
      if (!previous) return;
      value = { ...previous, revision: value.revision + 1, token: token() };
      previous = null;
      textRevision += 1;
      contentRevision += 1;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setText: (next: Update<string>) => update('text', next),
    setAttachments: (next: Update<MessageAttachmentView[]>) => update('attachments', next),
    setReferences: (next: Update<MessageReferenceView[]>) => update('references', next),
    setSkills: (next: Update<SkillSelectionView[]>) => update('skills', next),
    accept(revision: number, expectedToken?: string) {
      if (value.revision !== revision || (expectedToken !== undefined && value.token !== expectedToken)) return false;
      value = { revision: value.revision + 1, token: token(), text: '', attachments: [], references: [], skills: [] };
      textRevision += 1;
      contentRevision += 1;
      for (const listener of listeners) listener();
      return true;
    },
  };
}

export type ComposerDraft = ReturnType<typeof createComposerDraft>;
