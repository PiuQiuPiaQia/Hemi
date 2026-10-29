import {useEffect, useRef} from 'react';
import {ErrorState, LoadingState} from '@hemi/ui';
import type {FlowSurfaceState} from '../types/api.js';

/** A stable history boundary above the virtual messages, shared by Bot and mobile. */
export function HistoryLoader({history}: {history: NonNullable<FlowSurfaceState['history']>}) {
  const element = useRef<HTMLDivElement>(null), latest = useRef(history);
  latest.current = history;
  const trigger = useRef(() => {});
  useEffect(() => {
    const node = element.current;
    const viewport = node?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!node || !viewport) return;
    let previous = viewport.scrollTop, intent = -Infinity, requested = false, touchY = 0;
    const load = () => {
      const value = latest.current;
      if (requested || !value.hasMore || value.loading) return;
      requested = true;
      value.load();
    };
    trigger.current = () => {requested = false; load();};
    const user = () => {intent = performance.now(); requested = false;};
    const nearTop = () => viewport.scrollTop <= node.offsetHeight;
    const scroll = () => {
      const top = viewport.scrollTop, up = top < previous;
      previous = top;
      if (up && nearTop() && performance.now()-intent < 1200 && !latest.current.error) load();
    };
    const wheel = (event: WheelEvent) => {if (event.deltaY < 0) {user(); if (nearTop()) load();}};
    const touchStart = (event: TouchEvent) => {touchY = event.touches[0]?.clientY ?? 0; user();};
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? touchY;
      if (y > touchY) {intent = performance.now(); if (nearTop()) load();}
      touchY = y;
    };
    const key = (event: KeyboardEvent) => {if (['Home','PageUp','ArrowUp'].includes(event.key)) user();};
    viewport.addEventListener('scroll', scroll, {passive: true});
    viewport.addEventListener('wheel', wheel, {passive: true});
    viewport.addEventListener('touchstart', touchStart, {passive: true});
    viewport.addEventListener('touchmove', touchMove, {passive: true});
    viewport.addEventListener('pointerdown', user, {passive: true});
    viewport.addEventListener('keydown', key);
    return () => {
      viewport.removeEventListener('scroll', scroll);
      viewport.removeEventListener('wheel', wheel);
      viewport.removeEventListener('touchstart', touchStart);
      viewport.removeEventListener('touchmove', touchMove);
      viewport.removeEventListener('pointerdown', user);
      viewport.removeEventListener('keydown', key);
    };
  }, []);
  return <div ref={element} className="h24-history-load" aria-busy={history.loading} data-state={history.loading ? 'loading' : history.error ? 'error' : history.hasMore ? 'ready' : 'complete'}>
    {history.loading ? <LoadingState className="h24-history-progress" aria-live="polite" aria-atomic="true">
      <i className="h37-spinner" aria-hidden="true"/><span>正在加载历史消息…</span>
    </LoadingState> : !history.hasMore ? <span role="status">已到会话开头</span> : <>
      {history.error ? <ErrorState className="h24-history-error" description={history.error}/> : null}
      <button type="button" className="h24-history-button" onClick={() => trigger.current()}>{history.error ? '重试加载' : '加载更早消息'}</button>
    </>}
  </div>;
}
