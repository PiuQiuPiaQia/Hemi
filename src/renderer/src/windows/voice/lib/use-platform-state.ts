import { useEffect, useRef, useState } from 'react';

import type { Capability, CapabilityId, PlatformSnapshot } from '@/shared/types';

/**
 * 043 B2a · 平台能力快照订阅（renderer 唯一入口；页面不读原生库/注册表）。
 * 订阅纪律（contracts）：
 * - 先装监听再取初始快照，中间不漏事件；
 * - 按 {sessionId, revision} 去重：同一次宿主运行里旧 revision 丢弃，
 *   sessionId 变化（宿主重启）时重新初始化；
 * - getState 的迟到回执带请求代次，新请求/新事件后丢弃旧回执；
 * - 读取失败如实呈现（null），不默认 ready。
 */
export function usePlatformState(): PlatformSnapshot | null {
  const [snapshot, setSnapshot] = useState<PlatformSnapshot | null>(null);
  /** 已消费的快照指纹，用于同 session 去 revision、跨 session 重建。 */
  const seenRef = useRef<{ sessionId: string; revision: number } | null>(null);
  /** 初始读取代次：迟到的旧 getState 回执不覆盖新状态。 */
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const bridge = window.hemiVoice;
    if (!bridge?.onPlatformStateChanged || !bridge.platformGetState) return;

    const consume = (next: PlatformSnapshot | null | undefined) => {
      if (!mountedRef.current || !next) return;
      const seen = seenRef.current;
      if (seen && seen.sessionId === next.sessionId && next.revision <= seen.revision) return;
      seenRef.current = { sessionId: next.sessionId, revision: next.revision };
      setSnapshot(next);
    };

    // 先监听后读取：安装监听期间到达的广播不丢。
    const off = bridge.onPlatformStateChanged(consume);
    const request = ++requestRef.current;
    bridge
      .platformGetState()
      .then((initial) => {
        // 只有自己的请求代次是最新的才消费（否则必有更新的广播/请求已经写过状态）。
        if (request === requestRef.current) consume(initial);
      })
      .catch(() => {
        /* 读取失败保持 null：调用方展示「检测中/不可用」，不默认 ready */
      });

    return () => {
      mountedRef.current = false;
      requestRef.current += 1; // 卸载后在途回执全部失效
      off?.();
    };
  }, []);

  return snapshot;
}

/** 单能力视图：未就绪服务返回 null，由调用方决定「检测中」还是降级。 */
export function useCapability(id: CapabilityId): Capability | null {
  const snapshot = usePlatformState();
  return snapshot ? (snapshot.capabilities[id] ?? null) : null;
}
