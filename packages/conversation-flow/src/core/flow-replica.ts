import type { FlowChangeView, FlowSnapshotView } from './protocol.js';

export function isFlowSnapshot(value: unknown): value is FlowSnapshotView {
  const view = value as FlowSnapshotView | null;
  return Boolean(view && view.schemaVersion === 1 && typeof view.conversationId === 'string'
    && Number.isSafeInteger(view.revision) && view.revision >= 0
    && Number.isSafeInteger(view.generation) && view.generation >= 1
    && ['idle', 'preparing', 'running', 'stopping'].includes(view.phase)
    && Array.isArray(view.pending) && Array.isArray(view.timeline)
    && view.runs && view.tasks && view.artifacts && view.permissions);
}

/**
 * A patch normally belongs to the replica's generation. The one exception is the
 * rewind patch itself: it moves generation forward by exactly one and declares the
 * new value in its meta. Without this, every rewind forced an async refetch and an
 * immediate resend still carried the old generation (host rejects it as conflict).
 */
function acceptsGeneration(snapshot: FlowSnapshotView, change: Extract<FlowChangeView, { kind: 'patch' }>): boolean {
  if (change.generation === snapshot.generation) return true;
  if (change.generation !== snapshot.generation + 1 || !Array.isArray(change.changes)) return false;
  return change.changes.some(group => (group.kind === 'multi' ? (group.changes as Array<Record<string, unknown>>) ?? [] : [group as Record<string, unknown>])
    .some(patch => patch.kind === 'meta' && (patch.meta as { generation?: number } | undefined)?.generation === change.generation));
}

/** Apply published facts only; execution and scheduling remain authoritative upstream. */
export function applyFlowChange(snapshot: FlowSnapshotView, change: FlowChangeView): { ok: boolean; snapshot?: FlowSnapshotView; code?: string } {
  if (change.kind === 'snapshot') {
    const incoming = change.snapshot;
    if (!isFlowSnapshot(incoming) || incoming.conversationId !== snapshot.conversationId
      || incoming.revision < snapshot.revision || incoming.generation < snapshot.generation) return { ok: false, code: 'stale' };
    return { ok: true, snapshot: incoming };
  }
  if (change.conversationId !== snapshot.conversationId || !acceptsGeneration(snapshot, change)
    || change.baseRevision !== snapshot.revision || !Number.isSafeInteger(change.revision)
    || change.revision <= snapshot.revision || !Array.isArray(change.changes)) return { ok: false, code: 'stale' };
  let next = snapshot;
  const entryId = (item: FlowSnapshotView['timeline'][number]) => item.kind === 'user' ? item.id : item.itemId;
  try {
    for (const group of change.changes) {
      const patches = group.kind === 'multi' ? group.changes : [group];
      if (!Array.isArray(patches)) return { ok: false, code: 'invalid' };
      for (const patch of patches as Array<Record<string, unknown>>) {
        switch (patch.kind) {
          case 'meta': next = { ...next, ...patch.meta as Partial<FlowSnapshotView> }; break;
          case 'queue': next = { ...next, pending: patch.pending as FlowSnapshotView['pending'] }; break;
          case 'timeline': next = { ...next, timeline: patch.timeline as FlowSnapshotView['timeline'] }; break;
          case 'item-appended': {
            const item = patch.item as FlowSnapshotView['timeline'][number];
            if (!next.timeline.some(entry => entryId(entry) === entryId(item))) next = { ...next, timeline: [...next.timeline, item] };
            break;
          }
          case 'item-updated': {
            const item = patch.item as FlowSnapshotView['timeline'][number];
            next = { ...next, timeline: next.timeline.map(entry => entryId(entry) === entryId(item) ? item : entry) };
            break;
          }
          case 'runs': next = { ...next, runs: patch.runs as FlowSnapshotView['runs'] }; break;
          case 'tasks': next = { ...next, tasks: patch.tasks as FlowSnapshotView['tasks'] }; break;
          case 'artifacts': next = { ...next, artifacts: patch.artifacts as FlowSnapshotView['artifacts'] }; break;
          case 'permissions': next = { ...next, permissions: patch.permissions as FlowSnapshotView['permissions'] }; break;
          case 'reports': next = { ...next, pendingReports: patch.pendingReports as FlowSnapshotView['pendingReports'] }; break;
          default: return { ok: false, code: 'unsupported' };
        }
      }
    }
    next = { ...next, revision: change.revision };
    if (!isFlowSnapshot(next) || next.conversationId !== snapshot.conversationId || next.generation < snapshot.generation) return { ok: false, code: 'invalid' };
    return { ok: true, snapshot: next };
  } catch { return { ok: false, code: 'invalid' }; }
}

export type ReplicaConnection = 'connecting' | 'online' | 'offline';
export function createFlowReplica({ fetchSnapshot, publish, conversationId, onConnection, retryMs = 100, maxRetryMs = 10000 }: {
  fetchSnapshot(signal?: AbortSignal): Promise<FlowSnapshotView | null>;
  publish(snapshot: FlowSnapshotView): void;
  conversationId?: string;
  onConnection?(state: ReplicaConnection): void;
  retryMs?: number;
  maxRetryMs?: number;
}) {
  let current: FlowSnapshotView | null = null;
  let disposed = false, suspended = false, failures = 0;
  let fetching: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let buffered: FlowChangeView[] = [];
  let connectionEpoch = 0;
  let authorityEpoch: string | undefined;
  const connected = () => {
    if (disposed || suspended) return;
    connectionEpoch++; failures = 0;
    if (current && !buffered.length) onConnection?.('online');
  };
  const commit = (next: FlowSnapshotView) => {
    if (disposed || !isFlowSnapshot(next) || (conversationId && next.conversationId !== conversationId)
      || (current && (next.conversationId !== current.conversationId || next.revision < current.revision || next.generation < current.generation))) return false;
    current = next; publish(next); return true;
  };
  const drain = () => {
    buffered.sort((a, b) => (a.kind === 'patch' ? a.revision : a.snapshot.revision) - (b.kind === 'patch' ? b.revision : b.snapshot.revision));
    while (buffered.length) {
      const change = buffered[0];
      if (change.kind === 'snapshot') { buffered.shift(); commit(change.snapshot); continue; }
      if (current && (change.revision <= current.revision || change.generation < current.generation)) { buffered.shift(); continue; }
      if (!current) return;
      const applied = applyFlowChange(current, change);
      if (!applied.ok || !applied.snapshot) return;
      buffered.shift(); commit(applied.snapshot);
    }
  };
  const refresh = (): Promise<void> => {
    if (disposed || suspended) return Promise.resolve();
    if (fetching) return fetching;
    if (retry) { clearTimeout(retry); retry = null; }
    controller = new AbortController();
    const signal = controller.signal;
    const epoch = connectionEpoch;
    onConnection?.('connecting');
    const work = Promise.resolve().then(() => fetchSnapshot(signal)).then(fresh => {
      if (disposed || signal.aborted) return;
      if (!isFlowSnapshot(fresh) || (conversationId && fresh.conversationId !== conversationId)) throw new Error('Invalid conversation snapshot');
      commit(fresh);
      failures = 0; onConnection?.('online'); drain();
    }).catch(() => {
      // A live subscription may recover while an older snapshot request is still pending.
      if (!disposed && !signal.aborted && (epoch === connectionEpoch || !current || buffered.length)) {
        failures += 1; onConnection?.('offline');
      }
    }).finally(() => {
      if (fetching !== work) return;
      fetching = null;
      if (!disposed && !suspended && (!current || failures || buffered.length) && !retry) {
        retry = setTimeout(() => { retry = null; void refresh(); }, Math.min(maxRetryMs, retryMs * 2 ** Math.min(failures, 8)));
      }
    });
    fetching = work;
    return work;
  };
  return {
    refresh,
    connected,
    restore: commit,
    receive(change: FlowChangeView) {
      if (disposed || suspended) return;
      if (!change || typeof change !== 'object' || !['snapshot', 'patch'].includes(change.kind)) { void refresh(); return; }
      const source = change.kind === 'snapshot' ? change.snapshot?.conversationId : change.conversationId;
      if (source !== (conversationId ?? current?.conversationId ?? source)) return;
      if (change.kind === 'snapshot' && change.epoch && change.epoch !== authorityEpoch) {
        controller?.abort();fetching=null;if(retry)clearTimeout(retry);retry=null;
        authorityEpoch = change.epoch; current = null; buffered = [];
      }
      if (buffered.length >= 512) buffered = [];
      const before = current;
      buffered.push(change); drain();
      if (current !== before) connected();
      if (!current || buffered.length) void refresh();
    },
    suspend() { suspended = true; controller?.abort(); if (retry) clearTimeout(retry); retry = null; },
    resume(refreshSnapshot = true) {
      suspended = false;
      if (!refreshSnapshot) return Promise.resolve();
      // Recovery must not queue behind a request from the previous connection.
      controller?.abort(); fetching = null;
      return refresh();
    },
    dispose() { disposed = true; buffered = []; controller?.abort(); if (retry) clearTimeout(retry); retry = null; },
  };
}
