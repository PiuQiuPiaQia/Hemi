import { createComposerDraft } from './composer-draft.js';
import { createDraftPersistence, type ConversationDraftStorage, type ConversationIdentity } from './draft-persistence.js';
import { createFlowReplica, type ReplicaConnection } from './flow-replica.js';
import {createSnapshotPersistence} from './snapshot-persistence.js';
import {projectFlowWindow} from './flow-window.mjs';
import type { FlowChangeView, FlowCommandResult, FlowSnapshotView, FlowHistoryPage } from './protocol.js';

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
  fetchHistory?(scope: ConversationIdentity, cursor:{before:number;generation:number}, context:{signal:AbortSignal}):Promise<FlowHistoryPage>;
  /** Subscribe before publishing one baseline (or continuous replay), then ready. */
  subscribe?(scope: ConversationIdentity, receive: (change: FlowChangeView) => void, disconnected?: () => void, connected?: () => void): () => void;
  /** The shared transport owner coalesces recovery for all its conversations. */
  reconnect?(): Promise<void>;
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
  synchronization: 'syncing' | 'current' | 'stale';
  operations: readonly ConversationOperation[];
  error: string;
  /** Offline history is optional; cache failures never block conversation operations. */
  cacheNotice?: string;
  history?: {hasMore:boolean;loading:boolean;error:string};
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
  let state: ConversationClientState = { snapshot: null, connection: 'connecting', synchronization: 'syncing', operations: [], error: '' };
  let disposed = false, started = false, suspended = false, retains = 0;
  let hydrated = false;
  let journalReady = !storage?.operations;
  let initializing: Promise<void> | null = null;
  let writes = Promise.resolve();
  let subscriptionLive = false, releaseSubscription: (() => void) | undefined;
  let recovery: Promise<void> | null = null;
  const cancelRecoveries = new Set<(error:Error)=>void>();
  let catchup: ReturnType<typeof setTimeout> | null = null, expectedRevision = 0;
  let draining: Promise<void> | null = null;
  let reconcile: Promise<void> | null = null;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let reconcileAttempts = 0;
  let poll: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  const controllers = new Set<AbortController>();
  const inFlight = new Map<string, Promise<FlowCommandResult>>();
  const recording = new Set<string>();
  const tokenSubmissions=new Map<string,Promise<FlowCommandResult>>();
  const draftSubmissions = new Map<number, Promise<FlowCommandResult>>();
  let visible:FlowSnapshotView|null=null, authorityEpoch:string|undefined;
  let historyRead:AbortController|null=null;
  function show(head:FlowSnapshotView) {
    const previous=visible;
    if(previous&&previous.generation!==head.generation){historyRead?.abort();historyRead=null;}
    const start=head.history?.start??0, previousStart=previous?.history?.start??0;
    if(previous && head.history && previous.generation===head.generation && start>=previousStart && start<=previousStart+previous.timeline.length) {
      const prefix=previous.timeline.slice(0,start-previousStart);
      visible={...head,timeline:[...prefix,...head.timeline],history:{start:previousStart,total:head.history.total},
        runs:{...previous.runs,...head.runs},tasks:{...previous.tasks,...head.tasks},artifacts:{...previous.artifacts,...head.artifacts},permissions:head.permissions};
    } else visible=head;
    update({snapshot:visible,history:{hasMore:Boolean(transport.fetchHistory&&(visible.history?.start??0)>0),loading:Boolean(historyRead),error:''}});
  }
  const subscriptions: Array<() => void> = [];
  function update(next: Partial<ConversationClientState>) {
    if (disposed) return;
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }
  const persistence = storage?.drafts ? createDraftPersistence({ draft, storage: storage.drafts, environmentId: identity.environmentId,
    onError: message => update({ error: message }) }) : null;
  const checkpoints = storage?.snapshots ? createSnapshotPersistence({scope: identity, save: storage.snapshots.save,
    onSaved: () => {if (state.cacheNotice) update({cacheNotice: ''});},
    onError: () => update({cacheNotice: '暂时无法保存离线聊天记录，当前对话仍可正常使用。'}),
  }) : null;
  const setOperation = (id: string, next: Partial<ConversationOperation>) => update({ operations: state.operations.map(item => item.id === id ? { ...item, ...next } : item) });
  function persistOperations() {
    const value = structuredClone(state.operations);
    const write = writes.then(() => storage?.operations?.save(identity, value));
    writes = write.catch(() => { update({ error: '待发送记录未能保存，请重试' }); });
    return write;
  }
  const request = <T>(call: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> => {
    const controller = new AbortController();
    controllers.add(controller);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const forward = () => controller.abort();
      const finish = (error: unknown, value?: T) => {
        if (settled) return; settled = true;
        clearTimeout(timer); controller.signal.removeEventListener('abort', abort);
        parent?.removeEventListener('abort', forward); controllers.delete(controller);
        if (error) reject(error); else resolve(value as T);
      };
      const abort = () => finish(new DOMException('Request interrupted; outcome may be unknown', 'AbortError'));
      const timer = setTimeout(forward, requestTimeoutMs);
      controller.signal.addEventListener('abort', abort, {once: true});
      parent?.addEventListener('abort', forward, {once: true});
      if (parent?.aborted) controller.abort();
      Promise.resolve().then(() => {controller.signal.throwIfAborted(); return call(controller.signal);}).then(value => finish(null, value), error => finish(error));
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
        return { ...rest, state: item.state === 'sending' ? 'unknown' as const : item.state,
          ...(item.state==='waiting'?{result:{ok:false,code:'needs-review',message:'上次未发送的内容已保留，请确认后发送。'}}:{}) };
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
    if (result.ok && transport.subscribe && Number.isSafeInteger(result.revision) && result.revision! > (state.snapshot?.revision ?? -1)) {
      expectedRevision = Math.max(expectedRevision, result.revision!);
      if (!catchup) catchup = setTimeout(() => {
        catchup = null;
        if (!disposed && !suspended && subscriptionLive && (state.snapshot?.revision ?? -1) < expectedRevision) void replica.refresh();
      }, 2000);
    }
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
    fetchSnapshot: parent => request(signal => transport.fetchSnapshot(identity, { signal }), parent),
    publish: snapshot => {
      show(snapshot);
      if(checkpoints)checkpoints.update(projectFlowWindow(snapshot));
      if (catchup && snapshot.revision >= expectedRevision) {clearTimeout(catchup); catchup = null;}
    },
    onConnection: connection => {
      update({synchronization: connection === 'online' ? 'current' : connection === 'offline' ? 'stale' : 'syncing',
        ...(!transport.subscribe ? {connection} : {})});
      if (hydrated && state.connection === 'online') void reconcileUnknown().then(flushQueue);
    },
  });
  async function dispatch(operation: ConversationOperation): Promise<FlowCommandResult> {
    if (inFlight.has(operation.id)) return inFlight.get(operation.id)!;
    const pending = (async () => {
      const live = state.operations.find(item => item.id === operation.id);
      if (live?.state !== 'waiting') return live?.result ?? { ok: false, code: 'conflict' };
      if (disposed || suspended || !hydrated || !state.snapshot || state.connection !== 'online') return { ok: true, disposition: 'local-queued' };
      if (operation.generation === null) {
        const result={ok:false,code:'needs-review',message:'待发送内容缺少原会话版本，请核对后重新发送。'};
        await confirm(operation,result);return result;
      }
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
        if (!transport.subscribe) void replica.refresh();
        return result;
      } catch {
        const observed = observedResult(operation);
        if (observed) {await confirm(operation, observed); return observed;}
        setOperation(operation.id, { state: 'unknown', result: undefined });
        try { await persistOperations(); } catch { /* Journal already says sending. */ }
        void reconcileUnknown().then(flushQueue);
        if (!transport.subscribe) void replica.refresh();
        return { ok: false, code: 'unknown', message: '正在确认是否发送成功，请勿重复发送' };
      }
    })().finally(() => { inFlight.delete(operation.id); });
    inFlight.set(operation.id, pending);
    return pending;
  }
  async function flushQueue(): Promise<void> {
    if (disposed || suspended || !hydrated || !state.snapshot || state.connection !== 'online') return;
    const eligible = () => state.operations.some(item => item.state === 'waiting' && !recording.has(item.id)
      && !['storage-failed','needs-review'].includes(item.result?.code??'') && (item.command.type === 'stop' || !state.operations.some(other => other.state === 'unknown')));
    if (!eligible()) return draining ?? Promise.resolve();
    if (draining) {await draining;if(eligible())await flushQueue();return;}
    draining = (async () => {
      await initialize();
      if (!journalReady) return;
      // Cancellation has its frozen target and must not hold the input lane
      // while its network receipt is delayed. It still uses the same journal.
      for (const operation of state.operations.filter(item => item.state === 'waiting' && !recording.has(item.id) && !['storage-failed','needs-review'].includes(item.result?.code??'') && item.command.type === 'stop'))
        void dispatch(operation);
      while (true) {
        if (disposed || suspended || state.connection !== 'online') break;
        if (state.operations.some(item => item.state === 'unknown')) break;
        const operation = state.operations.find(item => item.state === 'waiting' && !recording.has(item.id) && !['storage-failed','needs-review'].includes(item.result?.code??'') && item.command.type !== 'stop');
        if (!operation) break;
        const result = await dispatch(operation);
        if (result.code === 'unknown' || result.code === 'storage-failed') break;
      }
    })().finally(() => { draining = null; });
    return draining;
  }
  async function submit(command: Record<string, unknown>, draftRevision?: number, draftToken?: string): Promise<FlowCommandResult> {
    if (disposed) return { ok: false, code: 'cancelled' };
    historyRead?.abort();historyRead=null;
    if(state.history?.loading)update({history:{...state.history,loading:false}});
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
    if (!current) return {ok:false,code:'syncing',message:'正在同步对话状态，草稿已保留，请稍后发送。'};
    if (command.type !== 'send' && (suspended || state.connection !== 'online')) {
      const message = '连接已断开，请恢复连接后重试此操作';
      update({ error: message }); return { ok: false, code: 'offline', message };
    }
    const operation: ConversationOperation = { id: makeId(), command: frozen, generation: current?.generation ?? null, state: 'waiting', draftRevision, draftToken, createdAt: Date.now() };
    recording.add(operation.id);
    update({ operations: [...state.operations.filter(item => !['accepted', 'rejected'].includes(item.state)).concat(state.operations.filter(item => ['accepted', 'rejected'].includes(item.state)).slice(-32)), operation], error: '' });
    try { await persistOperations(); }
    catch {
      const result = { ok: false, code: 'storage-failed', message: '记录未保存，消息尚未发送' };
      setOperation(operation.id, { result }); return result;
    } finally {recording.delete(operation.id);}
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
    if (transport.subscribe) subscribe();
    if (lifecycle) subscriptions.push(lifecycle.subscribe(event => {
      suspended = event === 'suspend' || event === 'offline';
      if (suspended) { replica.suspend(); update({ connection: 'offline' }); void persistence?.flush(); void checkpoints?.flush(); }
      else if (hydrated) void recover().catch(() => {});
    }));
    const restoreCache = storage?.snapshots ? storage.snapshots.load(identity).then(cached => {
      if (disposed || state.snapshot || !cached) return;
      if (!replica.restore(cached)) update({ cacheNotice: '正在更新本机聊天记录，已有消息不会丢失。' });
    }).catch(() => { update({ cacheNotice: '本机聊天记录暂时无法读取，连接后会自动重新加载。' }); }) : Promise.resolve();
    await Promise.all([initialize(), persistence?.activate(identity.conversationId), restoreCache]);
    hydrated = true;
    if (!disposed && !suspended && !transport.subscribe) await replica.refresh();
    if (state.connection === 'online') void reconcileUnknown().then(flushQueue);
    if (!disposed && !transport.subscribe && pollIntervalMs > 0) poll = setInterval(() => { if (!suspended) void replica.refresh(); }, pollIntervalMs);
    } catch { update({ connection: 'offline', error: '会话通信初始化失败，请检查宿主适配器' }); }
  };
  function subscribe() {
    releaseSubscription?.();
    releaseSubscription = transport.subscribe!(identity, change => {
      if (suspended || disposed) return;
      const source = change.kind === 'snapshot' ? change.snapshot?.conversationId : change.conversationId;
      if (source !== identity.conversationId) return;
      if(change.kind==='snapshot'&&change.epoch&&change.epoch!==authorityEpoch){authorityEpoch=change.epoch;visible=null;historyRead?.abort();historyRead=null;}
      if(change.kind==='patch'&&visible&&change.generation===visible.generation&&change.baseRevision===visible.revision){
        const changed=new Map<string,FlowSnapshotView['timeline'][number]>();
        for(const group of change.changes)for(const patch of group.kind==='multi'?group.changes as Array<Record<string,unknown>>:[group])
          if(patch.kind==='item-updated'){const item=patch.item as FlowSnapshotView['timeline'][number];changed.set(item.kind==='user'?item.id:item.itemId,item);}
        if(changed.size)visible={...visible,timeline:visible.timeline.map(item=>changed.get(item.kind==='user'?item.id:item.itemId)??item)};
      }
      subscriptionLive = true; void replica.resume(false); replica.receive(change);
      update({connection: 'online'});
      if (hydrated) void reconcileUnknown().then(flushQueue);
    }, () => {
      if (disposed || suspended) return;
      subscriptionLive = false; replica.suspend(); update({connection: 'offline', synchronization: 'stale'});
    }, () => {
      if (disposed || suspended) return;
      subscriptionLive = true; void replica.resume(false); replica.connected(); update({connection: 'online'});
      if (hydrated) void reconcileUnknown().then(flushQueue);
    });
  }
  async function performRecovery() {
    suspended = false; await initialize();
    if (!transport.subscribe) {await replica.resume(); await reconcileUnknown(); await flushQueue(); return;}
    replica.suspend(); void replica.resume(false);
    update({connection: 'connecting', synchronization: 'syncing'});
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {release(); reject(new Error('Connection recovery timed out'));}, requestTimeoutMs);
      const cancel = (error:Error) => {release();reject(error);};
      const release = () => {clearTimeout(timer); listeners.delete(changed);cancelRecoveries.delete(cancel);};
      const changed = () => {if (state.connection === 'online') {release(); resolve();}else if(state.connection==='offline')cancel(new Error('Connection is offline'));};
      cancelRecoveries.add(cancel);
      listeners.add(changed);
    });
    if (transport.reconnect) void transport.reconnect().catch(() => {}); else subscribe();
    await ready; await reconcileUnknown(); await flushQueue();
  }
  function recover() {
    if (!transport.subscribe) return performRecovery();
    if (recovery) return recovery;
    const work=performRecovery().finally(()=>{if(recovery===work)recovery=null;});
    recovery=work;return work;
  }
  const dispose = () => {
    if (disposed) return;
    for(const cancel of [...cancelRecoveries])cancel(new Error('Conversation disposed'));
    void persistence?.dispose(); void checkpoints?.close(); disposed = true;
    replica.dispose(); releaseSubscription?.(); releaseSubscription = undefined; subscriptions.splice(0).forEach(unsubscribe => unsubscribe());
    if (poll) clearInterval(poll); poll = null;
    if (reconcileTimer) clearTimeout(reconcileTimer); reconcileTimer = null;
    if (catchup) clearTimeout(catchup); catchup = null;
    controllers.forEach(controller => controller.abort()); listeners.clear();
  };
  return {
    scope: identity, draft, start, dispose,
    isDisposed:()=>disposed,
    async ready() {
      await start();if(state.snapshot&&state.connection==='online')return;
      await new Promise<void>((resolve,reject)=>{
        const done=(error?:Error)=>{clearTimeout(timer);listeners.delete(changed);cancelRecoveries.delete(cancel);error?reject(error):resolve();};
        const cancel=(error:Error)=>done(error);
        const changed=()=>{if(state.snapshot&&state.connection==='online')done();};
        const timer=setTimeout(()=>done(new Error('Conversation synchronization timed out')),requestTimeoutMs);
        cancelRecoveries.add(cancel);listeners.add(changed);changed();
      });
    },
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retain() { retains += 1; void start(); let released = false; return () => { if (released) return; released = true; retains -= 1; queueMicrotask(() => { if (!retains) dispose(); }); }; },
    refresh: recover,
    async loadHistory() {
      const current=state.snapshot,before=current?.history?.start;
      if(!transport.fetchHistory||!current||!before||historyRead||state.connection!=='online')return;
      const controller=new AbortController();historyRead=controller;
      const epoch=authorityEpoch;
      update({history:{hasMore:true,loading:true,error:''}});
      try {
        const page=await request(signal=>transport.fetchHistory!(identity,{before,generation:current.generation},{signal}),controller.signal);
        const latest=state.snapshot;
        if(controller.signal.aborted||disposed||epoch!==authorityEpoch||!latest||latest.generation!==page.generation)return;
        if(page.conversationId!==identity.conversationId||page.end!==before||page.start<0||page.start>=page.end||page.snapshot.timeline.length!==page.end-page.start||latest.history?.start!==before)throw new Error('Invalid history page');
        visible={...latest,timeline:[...page.snapshot.timeline,...latest.timeline],history:{start:page.start,total:latest.history.total},
          runs:{...page.snapshot.runs,...latest.runs},tasks:{...page.snapshot.tasks,...latest.tasks},artifacts:{...page.snapshot.artifacts,...latest.artifacts},permissions:latest.permissions};
        update({snapshot:visible,history:{hasMore:page.start>0,loading:false,error:''}});
      } catch {
        if(!controller.signal.aborted&&!disposed)update({history:{hasMore:true,loading:false,error:'历史消息暂时未能加载，请重试。'}});
      } finally {
        if(historyRead===controller){historyRead=null;if(state.history?.loading)update({history:{...state.history,loading:false}});}
      }
    },
    flushQueue, flushDraft: () => persistence?.flush() ?? Promise.resolve(), flushSnapshot: () => checkpoints?.flush() ?? Promise.resolve(),
    restoreQueuedInput(input: Parameters<typeof draft.restoreQueuedInput>[0]) {
      return persistence ? persistence.restoreQueuedInput(identity.conversationId, input) : Promise.resolve(draft.restoreQueuedInput(input));
    },
    resolveDraftConflict: (choice: 'keep-local' | 'reload') => persistence?.activate(identity.conversationId, choice === 'keep-local' ? 'preserve' : 'restore') ?? Promise.resolve(),
    sendCommand(command:Record<string,unknown>,submissionToken?:string) {
      if(!submissionToken)return submit(command);
      const pending=tokenSubmissions.get(submissionToken);if(pending)return pending;
      const previous=state.operations.find(item=>item.draftToken===submissionToken&&['waiting','sending','unknown','accepted'].includes(item.state));
      if(previous?.state==='waiting'&&['storage-failed','needs-review'].includes(previous.result?.code??'')){setOperation(previous.id,{result:undefined});return flushQueue().then(()=>state.operations.find(item=>item.id===previous.id)?.result??{ok:true,disposition:'local-queued'});}
      if(previous)return Promise.resolve(previous.result??(previous.state==='unknown'?{ok:false,code:'unknown',message:'正在确认是否发送成功，请勿重复发送'}:{ok:true,disposition:'local-queued'}));
      const work=submit(command,undefined,submissionToken).finally(()=>tokenSubmissions.delete(submissionToken));tokenSubmissions.set(submissionToken,work);return work;
    },
    sendDraft() {
      const current = draft.getSnapshot();
      if (draftSubmissions.has(current.revision)) return draftSubmissions.get(current.revision)!;
      if (!current.text.trim() && !current.attachments.length) return Promise.resolve({ ok: false, code: 'invalid', message: '请输入消息' });
      if (current.attachments.some(item => item.status !== 'ready')) return Promise.resolve({ ok: false, code: 'invalid', message: '请先完成附件上传' });
      const existing = state.operations.find(item => (item.draftRevision === current.revision || (item.draftToken && item.draftToken === current.token)) && ['waiting', 'sending', 'unknown', 'accepted'].includes(item.state));
      if (existing) {
        if (inFlight.has(existing.id)) return inFlight.get(existing.id)!;
        if (existing.state === 'waiting' && state.connection === 'online') {
          setOperation(existing.id, {result: undefined});
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
