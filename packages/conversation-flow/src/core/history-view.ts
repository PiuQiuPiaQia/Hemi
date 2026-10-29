import {isFlowSnapshot} from './flow-replica.js';
import type {FlowChangeView, FlowHistoryPage, FlowSnapshotView} from './protocol.js';

type Segment = {start: number; items: FlowSnapshotView['timeline']; continuation?: {questionId:string|null}};
const itemId = (item: FlowSnapshotView['timeline'][number]) => item.kind === 'user' ? item.id : item.itemId;
const end = (segment: Segment) => segment.start + segment.items.length;

/** Presentation history only. The replica owns the authoritative live head.
 * Retain the reading segment across reconnects, with at most one explicit gap.
 */
export function createHistoryView() {
  let current: FlowSnapshotView | null = null;
  let segments: Segment[] = [];
  let reading = false;
  const updates = new Map<string, FlowSnapshotView['timeline'][number]>();
  function compose(source: FlowSnapshotView, next: Segment[]) {
    const joined: Segment[] = [];
    for (const segment of next) {
      const previous = joined.at(-1);
      if (previous && segment.start <= end(previous))
        joined[joined.length - 1] = {start: previous.start, continuation: previous.continuation, items: [...previous.items.slice(0, segment.start - previous.start), ...segment.items]};
      else joined.push(segment);
    }
    // A newer disconnected head replaces the old tail, never the reading segment.
    segments = joined.length > 2 ? [joined[0], joined.at(-1)!] : joined;
    const first = segments[0], last = segments.at(-1)!;
    const gap = segments.length > 1 ? {start: end(first), end: last.start, beforeId: itemId(last.items[0])} : undefined;
    current = {...source, timeline: segments.flatMap(segment => segment.items),
      ...(source.history ? {history: {...source.history, start: first.start, gap, continuation: first.continuation}} : {}),
      runs: {...current?.runs, ...source.runs}, tasks: {...current?.tasks, ...source.tasks}, artifacts: {...current?.artifacts, ...source.artifacts}};
    return current;
  }
  return {
    get snapshot() { return current; },
    reset() { current = null; segments = []; updates.clear(); },
    beginRead() {reading = true; updates.clear();},
    endRead() {reading = false; updates.clear();},
    head(head: FlowSnapshotView) {
      const start = head.history?.start ?? 0;
      if (!current || !head.history || current.generation !== head.generation) {current = null; segments = [];}
      const earlier = segments.filter(segment => segment.start < start).map(segment => ({...segment, items: segment.items.slice(0, start - segment.start)}));
      return compose(head, [...earlier, {start, items: head.timeline, continuation: head.history?.continuation}]);
    },
    update(change: FlowChangeView) {
      if (change.kind !== 'patch' || !current || change.generation !== current.generation || change.baseRevision !== current.revision) return;
      const changed = new Map<string, FlowSnapshotView['timeline'][number]>();
      for (const group of change.changes) for (const patch of group.kind === 'multi' ? group.changes as Array<Record<string, unknown>> : [group])
        if (patch.kind === 'item-updated') {const item = patch.item as FlowSnapshotView['timeline'][number]; changed.set(itemId(item), item);}
      if (reading) for (const [id, item] of changed) updates.set(id, item);
      if (changed.size) segments = segments.map(segment => ({...segment, items: segment.items.map(item => changed.get(itemId(item)) ?? item)}));
    },
    prepend(page: FlowHistoryPage, before: number, target: 'older' | 'gap') {
      if (!current || page.generation !== current.generation) return false;
      const index = target === 'gap' ? 1 : 0, segment = segments[index];
      if (!segment || segment.start !== before) return false; // Superseded, not a read failure.
      if (page.conversationId !== current.conversationId || !isFlowSnapshot(page.snapshot) || page.snapshot.conversationId !== current.conversationId
        || page.snapshot.generation !== page.generation || page.end !== before || !Number.isSafeInteger(page.start) || page.start < 0 || page.start >= page.end
        || page.snapshot.timeline.length !== page.end - page.start) throw new Error('Invalid history page');
      const previous = segments[index - 1], start = Math.max(page.start, previous ? end(previous) : 0);
      const fetched = {start, continuation: start === page.start ? page.snapshot.history?.continuation : undefined, items: page.snapshot.timeline.slice(start - page.start).map(item => updates.get(itemId(item)) ?? item)};
      compose({...current, runs: {...page.snapshot.runs, ...current.runs}, tasks: {...page.snapshot.tasks, ...current.tasks}, artifacts: {...page.snapshot.artifacts, ...current.artifacts}},
        [...segments.slice(0, index), fetched, ...segments.slice(index)]);
      return true;
    },
  };
}
