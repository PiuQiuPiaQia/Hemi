import {isFlowSnapshot} from './flow-replica.js';
import {retainFlowRows} from './flow-window.mjs';
import type {FlowChangeView, FlowHistoryPage, FlowSnapshotView} from './protocol.js';

type Segment = {start: number; items: FlowSnapshotView['timeline']; continuation?: {questionId:string|null}};
const itemId = (item: FlowSnapshotView['timeline'][number]) => item.kind === 'user' ? item.id : item.itemId;
const end = (segment: Segment) => segment.start + segment.items.length;

/** Presentation history only. The replica owns the authoritative live head.
 * Retain the reading segment across reconnects, with at most one explicit gap.
 */
export function createHistoryView({maxRows=256,maxBytes=2*1024*1024}={}) {
  let current: FlowSnapshotView | null = null;
  let segments: Segment[] = [];
  let reading = false;
  let following = true;
  let liveHead: FlowSnapshotView | null = null;
  const updates = new Map<string, FlowSnapshotView['timeline'][number]>();
  const sizes=new WeakMap<object,number>();
  const size=(item:object)=>{let bytes=sizes.get(item);if(bytes===undefined){bytes=new TextEncoder().encode(JSON.stringify(item)).byteLength;sizes.set(item,bytes);}return bytes;};
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
    if (source.history) current = retainFlowRows(current, current.timeline, current.history);
    return current;
  }
  function trimOlder(minimum:number) {
    if(!current?.history||!liveHead?.history||!segments.length)return;
    const totalRows=segments.reduce((n,s)=>n+s.items.length,0),totalBytes=segments.reduce((n,s)=>n+s.items.reduce((b,item)=>b+size(item),0),0);
    if(totalRows<=maxRows&&totalBytes<=maxBytes)return;
    const first=segments[0],tail={start:liveHead.history.start,items:liveHead.timeline,continuation:liveHead.history.continuation};
    const rowBudget=Math.max(minimum,maxRows-tail.items.length),byteBudget=maxBytes-tail.items.reduce((n,item)=>n+size(item),0);
    let count=0,bytes=0;
    for(const item of first.items){if(count>=minimum&&(count>=rowBudget||bytes+size(item)>byteBudget))break;count++;bytes+=size(item);}
    if(count>=first.items.length&&segments.length===1)return;
    compose(current,[{...first,items:first.items.slice(0,count)},tail]);
  }
  return {
    get snapshot() { return current; },
    reset() { current = null; liveHead = null; segments = []; following = true; updates.clear(); },
    follow(value: boolean) {
      if (following === value) return false;
      following = value;
      if (value && liveHead && !reading) {current = null; segments = []; compose(liveHead, [{start:liveHead.history?.start ?? 0, items:liveHead.timeline, continuation:liveHead.history?.continuation}]); return true;}
      return false;
    },
    beginRead() {reading = true; following = false; updates.clear();},
    endRead() {reading = false; updates.clear();},
    head(head: FlowSnapshotView) {
      liveHead = head;
      const start = head.history?.start ?? 0;
      if (following || !current || !head.history || current.generation !== head.generation) {current = null; segments = [];}
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
      // A backwards reader keeps the new page and nearby QA plus the live head.
      // Explicit gap reads preserve the reader's requested material until return.
      if(target==='older')trimOlder(fetched.items.length);
      return true;
    },
  };
}
