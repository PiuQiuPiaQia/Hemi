/** 060：只读版本副本。缓冲初始／重取期间的补丁，旧会话异步返回不能提交。 */
import type { FlowChangeView, FlowSnapshotView } from '@shared/protocol';
import { applyFlowChange } from './flow-bridge.ts';
const applyChange = applyFlowChange as unknown as (snapshot: FlowSnapshotView, change: FlowChangeView) => { ok: boolean; snapshot?: FlowSnapshotView };

export function createFlowReplica({ fetchSnapshot, publish }: {
  fetchSnapshot: () => Promise<FlowSnapshotView | null>;
  publish: (snapshot: FlowSnapshotView) => void;
}) {
  let current: FlowSnapshotView | null = null;
  let disposed = false;
  let fetching: Promise<void> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let buffered: FlowChangeView[] = [];
  const commit = (next: FlowSnapshotView) => {
    if (disposed || (current && next.revision < current.revision)) return;
    current = next;
    publish(next);
  };
  const drain = () => {
    buffered.sort((a, b) => (a.kind === 'patch' ? a.revision : a.snapshot.revision) - (b.kind === 'patch' ? b.revision : b.snapshot.revision));
    while (buffered.length) {
      const change = buffered[0];
      if (change.kind === 'snapshot') { buffered.shift(); commit(change.snapshot); continue; }
      if (current && change.revision <= current.revision) { buffered.shift(); continue; }
      if (!current) return;
      const applied = applyChange(current, change);
      if (!applied.ok || !applied.snapshot) return;
      buffered.shift();
      commit(applied.snapshot);
    }
  };
  const refresh = () => {
    if (disposed || fetching) return fetching;
    fetching = fetchSnapshot().then((fresh) => {
      if (disposed) return;
      if (fresh) commit(fresh);
      drain();
    }).catch(() => {}).finally(() => {
      fetching = null;
      // 最后一次补丁也必须追平，不依赖未来再来一个事件触发。
      if (!disposed && (!current || buffered.length) && !retry) {
        retry = setTimeout(() => { retry = null; void refresh(); }, 100);
      }
    });
    return fetching;
  };
  return {
    refresh,
    receive(change: FlowChangeView) {
      if (disposed) return;
      buffered.push(change);
      drain();
      if (!current || buffered.length) void refresh();
    },
    dispose() { disposed = true; buffered = []; if (retry) clearTimeout(retry); },
  };
}
