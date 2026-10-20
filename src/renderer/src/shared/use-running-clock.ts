import { useSyncExternalStore } from 'react';

let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (!timer) { now = Date.now(); timer = setInterval(() => { now = Date.now(); for (const notify of listeners) notify(); }, 1000); }
  return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
};
const idle = () => () => {};
const snapshot = () => now;
/** Only visible running labels subscribe; a tick never re-renders the transcript owner. */
export function useRunningClock(running: boolean) {
  return useSyncExternalStore(running ? subscribe : idle, snapshot);
}
