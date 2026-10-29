import {ErrorState, LoadingState} from '@hemi/ui';
import type {FlowSurfaceState} from '../types/api.js';

/** Presentation only: viewport intent and SDK request state have separate owners. */
export function HistoryLoader({history, gap = false}: {history: NonNullable<FlowSurfaceState['history']>; gap?: boolean}) {
  const loading = history.loading && (history.target === 'gap') === gap;
  const error = (history.target === 'gap') === gap ? history.error : '';
  const hasMore = gap ? Boolean(history.gap) : history.hasMore;
  return <div className="h24-history-load" aria-busy={loading} data-state={loading ? 'loading' : error ? 'error' : hasMore ? 'ready' : 'complete'}>
    {loading ? <LoadingState className="h24-history-progress" aria-live="polite" aria-atomic="true">
      <i className="h37-spinner" aria-hidden="true"/><span>正在加载历史消息…</span>
    </LoadingState> : !hasMore ? <span role="status">已到会话开头</span> : <>
      {error ? <ErrorState className="h24-history-error" description={error}/> : null}
      <button type="button" className="h24-history-button" disabled={history.loading} onClick={() => gap ? history.gap?.load() : history.load()}>
        {error ? '重试加载' : gap ? '加载中间消息' : history.continuation ? '加载本轮更早内容' : '加载更早消息'}
      </button>
    </>}
  </div>;
}
