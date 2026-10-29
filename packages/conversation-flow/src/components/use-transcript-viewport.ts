import {useEffect, useRef} from 'react';
import type {FlowSurfaceState} from '../types/api.js';

type History = FlowSurfaceState['history'];
/** One reader/gesture source. Programmatic positioning never grants another page read. */
export function useTranscriptViewport(viewport: HTMLElement | null, options: {
  history: History;
  historyHeight(): number;
  read(): void;
  interact(): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const reset = useRef(() => {});
  useEffect(() => {
    if (!viewport) return;
    let previous = viewport.scrollTop, eligible = false, requested = false, touchY = 0, wheelAt = -Infinity;
    const nearTop = () => viewport.scrollTop <= latest.current.historyHeight();
    const load = () => {
      const history = latest.current.history;
      if (!eligible || requested || !history?.hasMore || history.loading || (history.error && history.target !== 'gap') || !nearTop()) return;
      requested = true;
      history.load();
    };
    const begin = () => {eligible = true; requested = false; latest.current.interact();};
    reset.current = () => {eligible = false; requested = true;};
    const scroll = () => {
      const top = viewport.scrollTop;
      if (eligible && top < previous) {latest.current.read(); load();}
      previous = top;
    };
    const wheel = (event: WheelEvent) => {
      const now = performance.now();
      if (now - wheelAt > 160) begin();
      wheelAt = now;
      if (event.deltaY < 0) {latest.current.read(); load();}
    };
    const touchStart = (event: TouchEvent) => {touchY = event.touches[0]?.clientY ?? 0; begin();};
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? touchY;
      if (y > touchY) {eligible = true; latest.current.read(); load();}
      touchY = y;
    };
    const key = (event: KeyboardEvent) => {
      if (['Home', 'PageUp', 'ArrowUp', 'End', 'PageDown', 'ArrowDown', ' '].includes(event.key)) {
        if (!event.repeat) begin();
        if (['Home', 'PageUp', 'ArrowUp'].includes(event.key)) latest.current.read();
      }
    };
    const finish = () => {eligible = false;};
    viewport.addEventListener('scroll', scroll, {passive: true});
    viewport.addEventListener('scrollend', finish, {passive: true});
    viewport.addEventListener('wheel', wheel, {passive: true});
    viewport.addEventListener('touchstart', touchStart, {passive: true});
    viewport.addEventListener('touchmove', touchMove, {passive: true});
    viewport.addEventListener('pointerdown', begin, {passive: true});
    viewport.addEventListener('keydown', key);
    return () => {
      reset.current = () => {};
      viewport.removeEventListener('scroll', scroll);
      viewport.removeEventListener('scrollend', finish);
      viewport.removeEventListener('wheel', wheel);
      viewport.removeEventListener('touchstart', touchStart);
      viewport.removeEventListener('touchmove', touchMove);
      viewport.removeEventListener('pointerdown', begin);
      viewport.removeEventListener('keydown', key);
    };
  }, [viewport]);
  return reset;
}
