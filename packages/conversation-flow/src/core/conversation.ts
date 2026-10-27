import { createComposerDraft } from './composer-draft.js';
import { createDraftPersistence, type ConversationDraftStorage, type ConversationIdentity } from './draft-persistence.js';
import { createFlowReplica, type ReplicaConnection } from './flow-replica.js';
import type { FlowChangeView, FlowCommandResult, FlowSnapshotView } from './protocol.js';

export interface ConversationOperation {
  id: string;
  command: Record<string, unknown>;
  generation: number | null;
  state: 'waiting' | 'sending' | 'unknown' | 'accepted' | 'rejected';
  draftRevision?: number;
  draftToken?: string;
  createdAt?: number;
  result?: FlowCommandResult;
}
export interface ConversationTransport {
  /** Capture host authority at the click boundary, before any asynchronous work. */
  prepareCommand?(command: Record<string, unknown>): Record<string, unknown>;
  fetchSnapshot(scope: ConversationIdentity, context: { signal: AbortSignal }): Promise<FlowSnapshotView | null>;
  subscribe?(scope: ConversationIdentity, receive: (change: FlowChangeView) => void, disconnected?: () => void, connected?: () => void): () => void;
  command(request: { scope: ConversationIdentity; requestId: string; generation: number | null; command: Record<string, unknown> }, context: { signal: AbortSignal }): Promise<FlowCommandResult>;
  /** Lookup is read-only. Missing/unknown receipts never authorize automatic replay. */
  lookupOperation?(scope: ConversationIdentity, requestId: string, context: { signal: AbortSignal }): Promise<FlowCommandResult | null>;
}
export interface ConversationOperationStorage {
  load(scope: ConversationIdentity): Promise<readonly ConversationOperation[] | null>;
  save(scope: ConversationIdentity, operations: readonly ConversationOperation[]): Promise<void>;
}
export interface ConversationSnapshotStorage {
  load(scope: ConversationIdentity): Promise<FlowSnapshotView | null>;
  save(scope: ConversationIdentity, snapshot: FlowSnapshotView): Promise<void>;
}
export interface ConversationLifecycle {
  subscribe(receive: (event: 'resume' | 'suspend' | 'online' | 'offline') => void): () => void;
}
export interface ConversationClientState {
  snapshot: FlowSnapshotView | null;
  connection: ReplicaConnection;
  operations: readonly ConversationOperation[];
  error: string;
}

export function createConversation({ scope, transport, storage, lifecycle, makeId = () => crypto.randomUUID(), requestTimeoutMs = 15000, pollIntervalMs = transport.subscribe ? 0 : 2000 }: {
  scope: ConversationIdentity;
  transport: ConversationTransport;
  storage?: { drafts?: ConversationDraftStorage; operations?: ConversationOperationStorage; snapshots?: ConversationSnapshotStorage };
  lifecycle?: ConversationLifecycle;
  makeId?: () => string;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
}) {
  const identity = Object.freeze({ ...scope });
  const draft = createComposerDraft();
  let state: ConversationClientState = { snapshot: null, connection: 'connecting', operations: [], error: '' };
  let disposed = false, started = false, suspended = false, retains = 0;
  let hydrated = false;
  let journalReady = !storage?.operations;
  let initializing: Promise<void> | null = null;
  let writes = Promise.resolve();
  let snapshotWrites = Promise.resolve();
  let draining: Promise<void> | null = null;
  let reconcile: Promise<void> | null = null;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let reconcileAttempts = 0;
  let poll: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  const controllers = new Set<AbortController>();
  const inFlight = new Map<string, Promise<FlowCommandResult>>();
  const draftSubmissions = new Map<number, Promise<FlowCommandResult>>();
  const subscriptions: Array<() => void> = [];
  function update(next: Partial<ConversationClientState>) {
    if (disposed) return;
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }
  const persistence = storage?.drafts ? createDraftPersistence({ draft, storage: storage.drafts, environmentId: identity.environmentId,
    onError: message => update({ error: message }) }) : null;
  const setOperation = (id: string, next: Partial<ConversationOperation>) => update({ operations: state.operations.map(item => item.id === id ? { ...item, ...next } : item) });
  function persistOperations() {
    const value = structuredClone(state.operations);
    const write = writes.then(() => storage?.operations?.save(identity, value));
    writes = write.catch(() => { update({ error: '待发送记录未能保存，请重试' }); });
    return write;
  }
  const request = <T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    controllers.add(controller);
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error('Request interrupted; outcome may be unknown'));
      controller.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      Promise.resolve().then(() => { if (controller.signal.aborted) throw new Error('Cancelled'); return call(controller.signal); }).then(resolve, reject).finally(() => {
        clearTimeout(timer); controller.signal.removeEventListener('abort', abort); controllers.delete(controller);
      });
      // Also clear deadlines when an uncooperative port never settles.
      controller.signal.addEventListener('abort', () => { clearTimeout(timer); controllers.delete(controller); }, { once: true });
    });
  };
  const initialize = () => {
    if (initializing) return initializing;
    if (journalReady) return Promise.resolve();
    initializing = Promise.resolve().then(() => storage!.operations!.load(identity)).then(saved => {
      if (disposed) return;
      const ids = new Set<string>();
      const operations = (saved ?? []).map(item => {
        if (!item || typeof item.id !== 'string' || ids.has(item.id) || !item.command || typeof item.command !== 'object'
          || !['waiting', 'sending', 'unknown', 'accepted', 'rejected'].includes(item.state)) throw new Error('Invalid operation journal');
        ids.add(item.id);
        // Persisted draft revision belongs to a previous model instance.
        const { draftRevision: _revision, ...rest } = item;
        return { ...rest, state: item.state === 'sending' ? 'unknown' as const : item.state };
      });
      journalReady = true; update({ operations });
    }).catch(() => update({ error: '待发送记录读取失败，发送已暂停，请重试' })).finally(() => { initializing = null; });
    return initializing;
  };
  const confirm = async (operation: ConversationOperation, result: FlowCommandResult) => {
    if (disposed) return;
    setOperation(operation.id, { state: result.ok ? 'accepted' : 'rejected', result });
    if (!state.operations.some(item => item.state === 'unknown')) {
      if (reconcileTimer) clearTimeout(reconcileTimer);
      reconcileTimer = null; reconcileAttempts = 0;
    }
    if (!result.ok && result.code !== 'superseded') update({ error: result.message ?? `操作未完成（${result.code ?? 'failed'}）` });
    if (result.ok && (operation.generation === null || operation.generation === state.snapshot?.generation)) {
      const current = draft.getSnapshot();
      if (operation.draftToken && operation.draftToken === current.token) draft.accept(current.revision, operation.draftToken);
      else if (!operation.draftToken && operation.draftRevision !== undefined) draft.accept(operation.draftRevision);
    }
    try { await persistOperations(); } catch { /* Already transmitted; preserve the receipt in memory. */ }
  };
  const validReceipt = (value: unknown): value is FlowCommandResult => Boolean(value && typeof (value as FlowCommandResult).ok === 'boolean');
  function observedResult(operation: ConversationOperation): FlowCommandResult | null {
    const snapshot = state.snapshot;
    const input = ['send', 'rewind'].includes(String(operation.command.type)) ? operation.command.input as {inputId?: string} | undefined : undefined;
    if (input?.inputId && snapshot && (snapshot.pending.some(item => item.inputId === input.inputId)
      || snapshot.timeline.some(item => item.kind === 'user' && item.id === input.inputId)
      || Object.values(snapshot.runs).some(run => (run.inputIds as string[] | undefined)?.includes(input.inputId!))))
      return {ok: true, disposition: 'already-accepted', inputId: input.inputId};
    const target = operation.command.targetRunId;
    if (operation.command.type === 'stop' && typeof target === 'string' && snapshot?.activeRunId !== target
      && ['completed', 'failed', 'stopped', 'interrupted'].includes(String(snapshot?.runs[target]?.outcome)))
      return {ok: true, disposition: 'already-stopped'};
    // Sends cannot cross the Host's rewind fence. An older uncertain send can
    // release its local gate without replaying it or claiming it was accepted.
    if (operation.command.type === 'send' && operation.generation !== null && snapshot && operation.generation < snapshot.generation)
      return {ok: false, code: 'superseded', message: '对话已被编辑，旧消息不会再自动发送。'};
    return null;
  }
  function reconcileUnknown(): Promise<unknown> {
    if (disposed || suspended) return Promise.resolve();
    // Live facts settle submissions even while an older receipt query waits.
    // Its eventual reply must not undo authoritative acceptance.
    const observed = state.operations.filter(item => item.state === 'unknown').flatMap(operation => {
      const result = observedResult(operation);
      return result ? [confirm(operation, result)] : [];
    });
    const settled = Promise.all(observed);
    if (observed.length) void settled.then(flushQueue);
    if (reconcile) return observed.length ? settled : reconcile;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = null;
    reconcile = (async () => {
      await settled;
      for (const operation of state.operations.filter(item => item.state === 'unknown')) {
        if (!transport.lookupOperation) continue;
        try {
          const receipt = await request(signal => transport.lookupOperation!(identity, operation.id, { signal }));
          if (state.operations.find(item => item.id === operation.id)?.state !== 'unknown') continue;
          const result = observedResult(operation) ?? receipt;
          if (validReceipt(result)) await confirm(operation, result);
        } catch { /* Keep unknown; a query failure is not permission to replay. */ }
      }
    })().finally(() => {
      reconcile = null;
      if (!disposed && !suspended && state.connection === 'online' && state.operations.some(item => item.state === 'unknown')) {
        reconcileTimer = setTimeout(() => {reconcileTimer = null; void reconcileUnknown().then(flushQueue);}, Math.min(10000, 1000 * 2 ** Math.min(reconcileAttempts++, 4)));
        (reconcileTimer as unknown as {unref?: () => void}).unref?.();
      }
    });
    return reconcile;
  }
  const replica = createFlowReplica({
    conversationId: identity.conversationId,
    fetchSnapshot: () => request(signal => transport.fetchSnapshot(identity, { signal })),
    publish: snapshot => {
      update({ snapshot });
      if (storage?.snapshots) {
        const captured = structuredClone(snapshot);
        snapshotWrites = snapshotWrites.then(() => storage.snapshots!.save(identity, captured))
          .catch(() => { update({ error: '历史缓存未能保存，当前对话仍保留在内存' }); });
      }
    },
    onConnection: connection => { update({ connection }); if (connection === 'online') void reconcileUnknown().then(flushQueue); },
  });
  async function dispatch(operation: ConversationOperation): Promise<FlowCommandResult> {
    if (inFlight.has(operation.id)) return inFlight.get(operation.id)!;
    const pending = (async () => {
      const live = state.operations.find(item => item.id === operation.id);
      if (live?.state !== 'waiting') return live?.result ?? { ok: false, code: 'conflict' };
      if (disposed || suspended || state.connection !== 'online') return { ok: true, disposition: 'local-queued' };
      if (operation.generation !== null && operation.generation !== state.snapshot?.generation) {
        const result = { ok: false, code: 'conflict', message: '会话已回卷，请核对待发送内容后重新提交' };
        await confirm(operation, result); return result;
      }
      setOperation(operation.id, { state: 'sending', result: undefined });
      try { await persistOperations(); }
      catch {
        const result = { ok: false, code: 'storage-failed', message: '记录未保存，消息尚未发送' };
        setOperation(operation.id, { state: 'waiting', result }); return result;
      }
      if (disposed || suspended) { setOperation(operation.id, { state: 'waiting' }); return { ok: false, code: 'cancelled' }; }
      try {
        const result = await request(signal => transport.command({ scope: identity, requestId: operation.id, generation: operation.generation, command: operation.command }, { signal }));
        if (!validReceipt(result)) throw new Error('Missing receipt');
        if (['unknown', 'needs-review'].includes(result.code ?? '') || result.disposition === 'needs-review') throw new Error('Outcome unknown');
        await confirm(operation, result);
        void replica.refresh();
        return result;
      } catch {
        const observed = observedResult(operation);
        if (observed) {await confirm(operation, observed); return observed;}
        setOperation(operation.id, { state: 'unknown', result: undefined });
        try { await persistOperations(); } catch { /* Journal already says sending. */ }
        void replica.refresh().then(reconcileUnknown);
        return { ok: false, code: 'unknown', message: '正在确认是否发送成功，请勿重复发送' };
      }
    })().finally(() => { inFlight.delete(operation.id); });
    inFlight.set(operation.id, pending);
    return pending;
  }
  async function flushQueue(): Promise<void> {
    if (draining || disposed || suspended || state.connection !== 'online') return draining ?? Promise.resolve();
    draining = (async () => {
      await initialize();
      if (!journalReady) return;
      // Cancellation has its frozen target and must not hold the input lane
      // while its network receipt is delayed. It still uses the same journal.
      for (const operation of state.operations.filter(item => item.state === 'waiting' && item.command.type === 'stop'))
        void dispatch(operation);
      while (true) {
        if (disposed || suspended || state.connection !== 'online') break;
        if (state.operations.some(item => item.state === 'unknown')) break;
        const operation = state.operations.find(item => item.state === 'waiting' && item.command.type !== 'stop');
        if (!operation) break;
        const result = await dispatch(operation);
        if (result.code === 'unknown' || result.code === 'storage-failed') break;
      }
    })().finally(() => { draining = null; });
    return draining;
  }
  async function submit(command: Record<string, unknown>, draftRevision?: number, draftToken?: string): Promise<FlowCommandResult> {
    if (disposed) return { ok: false, code: 'cancelled' };
    const frozen = structuredClone(transport.prepareCommand?.(command) ?? command);
    const current = state.snapshot;
    if(frozen.type==='stop' && frozen.targetRunId===undefined)frozen.targetRunId=current?.activeRunId??null;
    if(['beginEditInput','finishEditInput','updateInput'].includes(String(frozen.type)) && frozen.expectedEditRevision===undefined)
      frozen.expectedEditRevision=current?.pending.find(item=>item.inputId===frozen.inputId)?.editRevision;
    if(frozen.type==='reorderInput' && frozen.expectedInputIds===undefined)frozen.expectedInputIds=current?.pending.map(item=>item.inputId);
    if (['send', 'rewind'].includes(String(frozen.type))) {
      const input = frozen.input as Record<string, unknown> | undefined;
      frozen.input = { ...input, inputId: input?.inputId ?? makeId() };
    }
    await initialize();
    if (disposed) return { ok: false, code: 'cancelled' };
    if (!journalReady) return { ok: false, code: 'storage-failed', message: state.error };
    if (command.type !== 'send' && (suspended || state.connection !== 'online')) {
      const message = '连接已断开，请恢复连接后重试此操作';
      update({ error: message }); return { ok: false, code: 'offline', message };
    }
    const operation: ConversationOperation = { id: makeId(), command: frozen, generation: current?.generation ?? null, state: 'waiting', draftRevision, draftToken, createdAt: Date.now() };
    update({ operations: [...state.operations.filter(item => !['accepted', 'rejected'].includes(item.state)).concat(state.operations.filter(item => ['accepted', 'rejected'].includes(item.state)).slice(-32)), operation], error: '' });
    try { await persistOperations(); }
    catch {
      const result = { ok: false, code: 'storage-failed', message: '记录未保存，消息尚未发送' };
      setOperation(operation.id, { result }); return result;
    }
    if (frozen.type === 'stop') await dispatch(operation);
    else await flushQueue();
    const live = state.operations.find(item => item.id === operation.id);
    if (live?.state === 'unknown') return { ok: false, code: 'unknown', message: '正在确认是否发送成功，请勿重复发送' };
    return live?.result ?? { ok: true, disposition: 'local-queued' };
  }
  const start = async () => {
    if (started || disposed) return;
    started = true;
    try {
    if (transport.subscribe) subscriptions.push(transport.subscribe(identity, change => {
      if(suspended||disposed)return;
      replica.receive(change);
    }, () => {
      update({ connection: 'offline' }); if (!suspended) void replica.refresh();
    }, () => { if(!suspended&&!disposed&&hydrated){replica.connected();void replica.refresh().then(reconcileUnknown);} }));
    if (lifecycle) subscriptions.push(lifecycle.subscribe(event => {
      suspended = event === 'suspend' || event === 'offline';
      if (suspended) { replica.suspend(); update({ connection: 'offline' }); void persistence?.flush(); }
      else if (hydrated) void replica.resume().then(reconcileUnknown);
    }));
    const restoreCache = storage?.snapshots ? storage.snapshots.load(identity).then(cached => {
      if (disposed || !cached) return;
      if (!replica.restore(cached)) update({ error: '历史缓存版本或身份不匹配，已忽略' });
    }).catch(() => { update({ error: '历史缓存读取失败，将重新同步' }); }) : Promise.resolve();
    await Promise.all([initialize(), persistence?.activate(identity.conversationId), restoreCache]);
    hydrated = true;
    if (!disposed && !suspended) await replica.refresh();
    if (!disposed && pollIntervalMs > 0) poll = setInterval(() => { if (!suspended) void replica.refresh(); }, pollIntervalMs);
    } catch { update({ connection: 'offline', error: '会话通信初始化失败，请检查宿主适配器' }); }
  };
  const dispose = () => {
    if (disposed) return;
    void persistence?.dispose(); disposed = true;
    replica.dispose(); subscriptions.splice(0).forEach(unsubscribe => unsubscribe());
    if (poll) clearInterval(poll); poll = null;
    if (reconcileTimer) clearTimeout(reconcileTimer); reconcileTimer = null;
    controllers.forEach(controller => controller.abort()); listeners.clear();
  };
  return {
    scope: identity, draft, start, dispose,
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retain() { retains += 1; void start(); let released = false; return () => { if (released) return; released = true; retains -= 1; queueMicrotask(() => { if (!retains) dispose(); }); }; },
    refresh: async () => { suspended = false; await initialize(); await replica.resume(); await reconcileUnknown(); await flushQueue(); },
    flushQueue, flushDraft: () => persistence?.flush() ?? Promise.resolve(),
    restoreQueuedInput(input: Parameters<typeof draft.restoreQueuedInput>[0]) {
      return persistence ? persistence.restoreQueuedInput(identity.conversationId, input) : Promise.resolve(draft.restoreQueuedInput(input));
    },
    resolveDraftConflict: (choice: 'keep-local' | 'reload') => persistence?.activate(identity.conversationId, choice === 'keep-local' ? 'preserve' : 'restore') ?? Promise.resolve(),
    sendCommand: (command: Record<string, unknown>) => submit(command),
    sendDraft() {
      const current = draft.getSnapshot();
      if (draftSubmissions.has(current.revision)) return draftSubmissions.get(current.revision)!;
      if (!current.text.trim() && !current.attachments.length) return Promise.resolve({ ok: false, code: 'invalid', message: '请输入消息' });
      if (current.attachments.some(item => item.status !== 'ready')) return Promise.resolve({ ok: false, code: 'invalid', message: '请先完成附件上传' });
      const existing = state.operations.find(item => (item.draftRevision === current.revision || (item.draftToken && item.draftToken === current.token)) && ['waiting', 'sending', 'unknown', 'accepted'].includes(item.state));
      if (existing) {
        if (inFlight.has(existing.id)) return inFlight.get(existing.id)!;
        if (existing.state === 'waiting' && state.connection === 'online') {
          const retry = flushQueue().then(() => state.operations.find(item => item.id === existing.id)?.result ?? { ok: true, disposition: 'local-queued' })
            .finally(() => { draftSubmissions.delete(current.revision); });
          draftSubmissions.set(current.revision, retry);
          return retry;
        }
        return Promise.resolve(existing.result ?? { ok: true, disposition: 'local-queued' });
      }
      const promise = submit({ type: 'send', input: { inputId: makeId(), text: current.text, inputSource: 'text', attachmentIds: current.attachments.map(item => item.attachmentId), attachmentViews: current.attachments, references: current.references, skills: current.skills } }, current.revision, current.token)
        .finally(() => { draftSubmissions.delete(current.revision); });
      draftSubmissions.set(current.revision, promise);
      return promise;
    },
    cancelWaiting(id: string) {
      const operation = state.operations.find(item => item.id === id);
      if (!operation || operation.state !== 'waiting') return Promise.resolve(false);
      setOperation(id, { state: 'rejected', result: { ok: false, code: 'cancelled' } });
      return persistOperations().then(() => true, () => { setOperation(id, operation); return false; });
    },
  };
}
export type ConversationClient = ReturnType<typeof createConversation>;
