import {useEffect, useRef} from 'react';
import type {FlowSurfaceState} from '../types/api.js';

type History = FlowSurfaceState['history'];
/** Each upward input can read another page; programmatic positioning cannot. */
export function useTranscriptViewport(viewport: HTMLElement | null, options: {
  history: History;
  nearStart(): boolean;
  read(): void;
  towardEnd(): void;
  interact(): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const reset = useRef(() => {});
  useEffect(() => {
    if (!viewport) return;
    let previous = viewport.scrollTop, eligible = false, requested = false, touchY = 0;
    const load = () => {
      const history = latest.current.history;
      if (!eligible || requested || !history || history.loading) return;
      const gap = viewport.querySelector('[data-history-gap]')?.getBoundingClientRect();
      const top = viewport.getBoundingClientRect().top;
      const target = latest.current.nearStart() && history.hasMore ? 'older'
        : history.gap && gap && gap.bottom >= top && gap.top <= top + viewport.clientHeight / 2 ? 'gap' : null;
      if (!target || (history.error && (history.target ?? 'older') === target)) return;
      requested = true;
      if (target === 'gap') history.gap?.load(); else history.load();
    };
    const begin = () => {eligible = true; requested = false; latest.current.interact();};
    reset.current = () => {eligible = false; requested = true;};
    const scroll = () => {
      const top = viewport.scrollTop;
      if (eligible && top < previous) {latest.current.read(); load();}
      previous = top;
    };
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {begin(); latest.current.read(); load();}
      else if (event.deltaY > 0) {begin(); latest.current.towardEnd();}
    };
    const touchStart = (event: TouchEvent) => {touchY = event.touches[0]?.clientY ?? 0; begin();};
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? touchY;
      if (y > touchY) {begin(); latest.current.read(); load();}
      else if (y < touchY) {begin(); latest.current.towardEnd();}
      touchY = y;
    };
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]')) return;
      if (['Home', 'PageUp', 'ArrowUp', 'End', 'PageDown', 'ArrowDown', ' '].includes(event.key)) {
        begin();
        if (['Home', 'PageUp', 'ArrowUp'].includes(event.key)) {latest.current.read(); load();}
        else latest.current.towardEnd();
      }
    };
    const pointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.buttons === 1 && event.movementY > 0) latest.current.towardEnd();
    };
    const finish = () => {eligible = false;};
    viewport.addEventListener('scroll', scroll, {passive: true});
    viewport.addEventListener('scrollend', finish, {passive: true});
    viewport.addEventListener('wheel', wheel, {passive: true});
    viewport.addEventListener('touchstart', touchStart, {passive: true});
    viewport.addEventListener('touchmove', touchMove, {passive: true});
    viewport.addEventListener('pointerdown', begin, {passive: true});
    viewport.addEventListener('pointermove', pointerMove, {passive: true});
    viewport.addEventListener('keydown', key);
    return () => {
      reset.current = () => {};
      viewport.removeEventListener('scroll', scroll);
      viewport.removeEventListener('scrollend', finish);
      viewport.removeEventListener('wheel', wheel);
      viewport.removeEventListener('touchstart', touchStart);
      viewport.removeEventListener('touchmove', touchMove);
      viewport.removeEventListener('pointerdown', begin);
      viewport.removeEventListener('pointermove', pointerMove);
      viewport.removeEventListener('keydown', key);
    };
  }, [viewport]);
  return reset;
}
