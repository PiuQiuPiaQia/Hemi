import { useSyncExternalStore } from 'react';
import type { UpdaterActionResult, UpdaterState } from '@shared/protocol';

export type UpdaterAction = 'check' | 'download' | 'install';
type Snapshot = { state: UpdaterState | null; operation: UpdaterAction | null; error: string | null };
let snapshot: Snapshot = { state: null, operation: null, error: null };
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | undefined;
let generation = 0;

function publish(patch: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const ticket = ++generation;
    const bridge = window.hemiVoice;
    let receivedEvent = false;
    // A late initial read must not undo download progress or a completed download.
    unsubscribe = bridge?.onUpdaterChanged?.(state => {
      if (ticket !== generation) return;
      receivedEvent = true;
      publish({ state, error: null });
    });
    void bridge?.updaterGetState?.().then(state => {
      if (ticket === generation && !receivedEvent) publish({ state, error: null });
    }).catch(() => {
      if (ticket === generation && !receivedEvent) publish({ error: '无法读取更新状态，请稍后重试。' });
    });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { generation++; unsubscribe?.(); unsubscribe = undefined; }
  };
}

/** One operation across the rail, settings and page changes; state stays in the main process. */
export async function runUpdaterAction(action: UpdaterAction) {
  if (snapshot.operation) return;
  publish({ operation: action, error: null });
  let succeeded = false;
  try {
    const bridge = window.hemiVoice;
    const result: UpdaterActionResult | undefined = action === 'check' ? await bridge?.updaterCheck()
      : action === 'download' ? await bridge?.updaterDownload() : await bridge?.updaterInstall();
    succeeded = result?.ok === true;
    if (!succeeded) publish({ error: result?.message || '更新操作未完成，请稍后重试。' });
  } catch {
    publish({ error: '暂时无法更新，请稍后重试。' });
  } finally {
    // Normal quit cleanup may take time. Keep restart disabled until the app exits.
    if (action !== 'install' || !succeeded) publish({ operation: null });
  }
}

const getSnapshot = () => snapshot;
export function useUpdater() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
