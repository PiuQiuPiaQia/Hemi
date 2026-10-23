import type { ComposerDraft, ComposerDraftSnapshot } from './composer-draft.js';

export interface ConversationIdentity { environmentId: string; conversationId: string }
export type StoredConversationDraft = Partial<Omit<ComposerDraftSnapshot, 'revision'>> & { revision: number; text: string };
export interface ConversationDraftStorage {
  load(scope: ConversationIdentity): Promise<StoredConversationDraft | null>;
  save(scope: ConversationIdentity, value: StoredConversationDraft): Promise<{ ok: boolean; stale?: boolean; revision?: number }>;
}

/** Debounced persistence, load races and navigation share one implementation across hosts. */
export function createDraftPersistence({ draft, storage, environmentId, debounceMs = 400, persistAttachments = true, onError }: {
  draft: ComposerDraft;
  storage: ConversationDraftStorage;
  environmentId: string;
  debounceMs?: number;
  persistAttachments?: boolean;
  onError?(message: string): void;
}) {
  let scope: ConversationIdentity | null = null;
  let version = 0, token = 0, restoring = false, disposed = false, dirty = false;
  let blocked = false;
  let loadStatus = { ok: true };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let loading: Promise<void> = Promise.resolve();
  let writes: Promise<void> = Promise.resolve();
  const unsaved = new Map<string, { value: ComposerDraftSnapshot; blocked: boolean }>();
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; };
  const error = (message: string) => { if (!disposed) onError?.(message); };
  const preserveFailure = (identity: ConversationIdentity, captured: ComposerDraftSnapshot) => {
    const latest = unsaved.get(identity.conversationId)?.value ?? captured;
    unsaved.set(identity.conversationId, { value: latest, blocked: true });
    if (scope?.conversationId === identity.conversationId) { dirty = true; blocked = true; }
  };
  const flush = (): Promise<void> => {
    clearTimer();
    if (!scope || disposed || !dirty || blocked) return writes;
    const identity = { ...scope };
    const captured = draft.getPersistentSnapshot();
    const ready = loading;
    const status = loadStatus;
    dirty = false;
    writes = writes.then(async () => {
      await ready;
      if (!status.ok) {
        preserveFailure(identity, captured);
        return;
      }
      const revision = ++version;
      const value: StoredConversationDraft = { revision, token: captured.token, text: captured.text, references: captured.references, skills: captured.skills,
        ...(persistAttachments ? { attachments: captured.attachments } : {}) };
      try {
        const result = await storage.save(identity, value);
        version = Math.max(version, result.revision ?? 0);
        if (!result.ok) throw new Error('Storage rejected draft');
        if (result.stale) {
          preserveFailure(identity, captured);
          error('草稿保存冲突，请选择保留本机内容或重新载入'); return;
        }
        if (unsaved.get(identity.conversationId)?.value.token === captured.token) unsaved.delete(identity.conversationId);
      } catch {
        preserveFailure(identity, captured);
        error('草稿未能保存，请保留当前输入并重试');
      }
    }).catch(() => error('草稿未能保存，请保留当前输入并重试'));
    return writes;
  };
  const unsubscribe = draft.subscribe(() => {
    if (restoring || disposed || !scope) return;
    unsaved.set(scope.conversationId, { value: draft.getPersistentSnapshot(), blocked });
    dirty = true; clearTimer(); timer = setTimeout(() => { void flush(); }, debounceMs);
  });
  return {
    flush,
    activate(conversationId: string, mode: 'restore' | 'clear' | 'preserve' = 'restore', { discardPrevious = false }: { discardPrevious?: boolean } = {}) {
      if (discardPrevious) { clearTimer(); dirty = false; if (scope) unsaved.delete(scope.conversationId); }
      else void flush();
      const identity = { environmentId, conversationId };
      scope = identity;
      const local = mode === 'restore' ? unsaved.get(conversationId) : undefined;
      if (mode !== 'restore') unsaved.delete(conversationId);
      blocked = local?.blocked ?? false;
      const status = { ok: false };
      loadStatus = status;
      const mine = ++token;
      if (mode !== 'preserve') {
        restoring = true;
        draft.restore({ ...local?.value, attachments: persistAttachments ? local?.value.attachments ?? [] : draft.getSnapshot().attachments });
        restoring = false;
      }
      dirty = mode !== 'restore' || Boolean(local);
      const expected = draft.getContentRevision();
      // Capture the active load, rather than a mutable global promise, in each write.
      loading = Promise.resolve().then(() => storage.load(identity)).then(stored => {
        if (stored && (!Number.isSafeInteger(stored.revision) || stored.revision < 0 || typeof stored.text !== 'string'
          || ['attachments', 'references', 'skills'].some(key => {
            const value = stored[key as 'attachments' | 'references' | 'skills'];
            return value !== undefined && (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object'));
          }))) throw new Error('Invalid draft');
        status.ok = true;
        version = Math.max(version, stored?.revision ?? 0);
        if (disposed || mine !== token) return;
        if (mode === 'restore' && !local && draft.getContentRevision() === expected) {
          restoring = true;
          draft.restore({ ...stored, attachments: persistAttachments ? stored?.attachments ?? [] : draft.getSnapshot().attachments });
          restoring = false;
          dirty = false;
        }
        if (local?.blocked) error('此会话有未保存的本机草稿，请核对后选择保留或重新载入');
      }).catch(() => { if (!disposed && mine === token) { blocked = true; error('草稿读取失败，当前输入已保留'); } });
      const ready = loading;
      return ready.then(() => { if (mode !== 'restore' && mine === token) return flush(); });
    },
    /** Flush is initiated before detaching; callers can await it during controlled shutdown. */
    dispose() { const pending = flush(); disposed = true; token += 1; clearTimer(); unsubscribe(); return pending; },
  };
}
