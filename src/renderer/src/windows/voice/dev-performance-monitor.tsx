import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Stats from 'stats.js';
import type { WindowActivityView } from '@shared/protocol';
import '@/styles/065-dev-performance.css';

type Sample = {
  fps: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  longFrames: number | null;
  heapMb: number | null;
  paused: boolean;
  failed: boolean;
};

const initial: Sample = {
  fps: null, p95Ms: null, maxMs: null, longFrames: null, heapMb: null, paused: false, failed: false,
};
const formatMs = (value: number | null) => value === null ? '—' : value.toFixed(1);

/** 仅由 DEV 条件加载。每帧采样留在闭包，每秒只刷新这个独立组件。 */
export default function DevPerformanceMonitor() {
  const graphRef = useRef<HTMLDivElement>(null);
  const [sample, setSample] = useState<Sample>(initial);

  useEffect(() => {
    const host = graphRef.current;
    if (!host) return;
    let disposed = false;
    let frameRequest = 0;
    let observer: PerformanceObserver | null = null;
    let graph: Stats | null = null;
    let previous: number | null = null;
    let windowStart = 0;
    let frames = 0;
    let intervals: number[] = [];
    let longFrames = 0;
    let nativeActivity: WindowActivityView | null = null;
    let activityRevision = 0;
    const supportsLongFrames = typeof PerformanceObserver !== 'undefined'
      && PerformanceObserver.supportedEntryTypes.includes('long-animation-frame');
    // Hemi 的 backgroundThrottling=false 会让隐藏窗口仍报告 visible，
    // Electron 用原生只读可见性；浏览器 fixture 用 DOM。切到 DevTools／其他
    // 应用时继续监控可见主窗，仅隐藏／最小化才暂停，避免焦点切换重置数据。
    const active = () => !document.hidden && (nativeActivity?.visible ?? true);

    const stop = () => {
      cancelAnimationFrame(frameRequest);
      frameRequest = 0;
      observer?.disconnect();
      observer = null;
      previous = null;
      intervals = [];
    };
    const tick = (now: number) => {
      if (disposed || !active()) return;
      graph?.update();
      if (previous === null) {
        windowStart = now;
        frames = 0;
      } else {
        frames += 1;
        // 有限缓存；不在采样路径读取布局或扫描消息 DOM。
        if (intervals.length < 1000) intervals.push(now - previous);
      }
      previous = now;
      const elapsed = now - windowStart;
      if (elapsed >= 1000 && intervals.length) {
        intervals.sort((a, b) => a - b);
        const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
        const heapBytes = memory?.usedJSHeapSize;
        setSample({
          fps: Math.round(frames * 1000 / elapsed),
          p95Ms: intervals[Math.ceil(intervals.length * 0.95) - 1],
          maxMs: intervals[intervals.length - 1],
          longFrames: supportsLongFrames ? longFrames : null,
          heapMb: typeof heapBytes === 'number' && Number.isFinite(heapBytes) ? heapBytes / 1048576 : null,
          paused: false,
          failed: false,
        });
        frames = 0;
        intervals = [];
        windowStart = now;
      }
      frameRequest = requestAnimationFrame(tick);
    };
    const start = () => {
      stop();
      if (disposed) return;
      if (!active()) {
        setSample(value => ({ ...value, fps: null, p95Ms: null, maxMs: null, paused: true }));
        return;
      }
      try {
        // 重建库内部 FPS 时间基线，后台节流时间不计入恢复后的数据。
        graph = new Stats();
        graph.showPanel(0);
        graph.dom.style.cssText = '';
        host.replaceChildren(graph.dom);
        if (supportsLongFrames) {
          observer = new PerformanceObserver(list => {
            if (!disposed && active()) longFrames += list.getEntries().length;
          });
          observer.observe({ type: 'long-animation-frame' });
        }
        setSample(value => ({ ...initial, longFrames: supportsLongFrames ? longFrames : null, heapMb: value.heapMb }));
        frameRequest = requestAnimationFrame(tick);
      } catch (error) {
        stop();
        host.replaceChildren();
        console.warn('[perf] 开发性能监控初始化失败', error);
        setSample({ ...initial, failed: true });
      }
    };
    start();
    document.addEventListener('visibilitychange', start);
    const unsubscribeActivity = window.hemiVoice?.onDevWindowActivity?.(activity => {
      activityRevision += 1;
      nativeActivity = activity;
      start();
    });
    const initialRevision = activityRevision;
    void window.hemiVoice?.getDevWindowActivity?.().then(activity => {
      // 不让晚到的初始查询覆盖新收到的窗口事件，也不唤醒已卸载的 effect。
      if (disposed || activityRevision !== initialRevision) return;
      nativeActivity = activity;
      start();
    }).catch(error => console.warn('[perf] 开发窗口状态读取失败', error));
    return () => {
      disposed = true;
      stop();
      document.removeEventListener('visibilitychange', start);
      unsubscribeActivity?.();
      host.replaceChildren();
      graph = null;
    };
  }, []);

  return createPortal(
    <div
      className="h65-perf"
      data-dev-performance
      data-fps={sample.fps ?? ''}
      data-frame-max={sample.maxMs ?? ''}
      data-long-frames={sample.longFrames ?? ''}
      data-paused={sample.paused}
      aria-label="开发性能监控"
      title="开发模式 · FPS 为 rAF 回调频率估算，非 GPU 实际呈现帧率；P95／MAX 为最近一秒帧间隔；长帧为本次面板挂载期间超过 50ms 的原生长动画帧累计数；JS 为近似堆内存。隐藏或最小化时暂停采样；— 表示尚无数据或 API 不支持。"
    >
      <div className="h65-perf-graph" role="img" aria-label={sample.failed ? '监控不可用' : sample.paused ? '已暂停' : `${sample.fps ?? '—'} FPS`}>
        <div ref={graphRef} />
        {sample.failed || sample.paused ? <span className="h65-perf-status">{sample.failed ? '监控不可用' : '已暂停'}</span> : null}
      </div>
      <div className="h65-perf-timings">
        <span>P95 <b>{formatMs(sample.p95Ms)}</b> ms</span>
        <span>MAX <b>{formatMs(sample.maxMs)}</b> ms</span>
      </div>
      <div className="h65-perf-counts">
        <span>长帧 <b>{sample.longFrames ?? '—'}</b></span>
        <span className="h65-perf-heap">JS <b>{sample.heapMb === null ? '—' : Math.round(sample.heapMb)}</b> MB</span>
      </div>
    </div>,
    document.body,
  );
}
