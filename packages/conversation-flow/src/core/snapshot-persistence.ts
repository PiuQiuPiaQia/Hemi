import type {ConversationIdentity} from './draft-persistence.js';
import type {FlowSnapshotView} from './protocol.js';

/** Checkpoints are optional presentation caches; the operation journal is durable separately. */
export function createSnapshotPersistence({scope, save, onSaved, onError, intervalMs = 1000}: {
  scope: ConversationIdentity;
  save(scope: ConversationIdentity, value: FlowSnapshotView): Promise<void>;
  onSaved?(): void;
  onError?(): void;
  intervalMs?: number;
}) {
  let latest: FlowSnapshotView | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> | null = null;
  let closed = false;
  const cancelTimer = () => {if (timer) clearTimeout(timer); timer = null;};
  const schedule = () => {
    if (closed || timer || writing || !latest) return;
    timer = setTimeout(() => {timer = null; void write();}, intervalMs);
    (timer as unknown as {unref?: () => void}).unref?.();
  };
  function write(): Promise<void> {
    if (writing) return writing;
    if (!latest) return Promise.resolve();
    const value = latest; latest = null;
    const work = Promise.resolve().then(() => save(scope, value)).then(() => onSaved?.(), () => onError?.()).finally(() => {
      if (writing === work) writing = null;
      schedule();
    });
    writing = work;
    return work;
  }
  async function flush() {
    cancelTimer();
    if (writing) await writing;
    cancelTimer();
    if (latest) await write();
  }
  return {
    // Published flow views use structural sharing and are immutable. Keep one
    // reference instead of cloning N full histories during a replay burst.
    update(value: FlowSnapshotView) {if (!closed) {latest = value; schedule();}},
    flush,
    async close() {closed = true; await flush();},
  };
}
