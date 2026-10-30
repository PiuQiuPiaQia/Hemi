import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createQuotaPoller,
  quotaTargets,
  type FetchQuota,
  type QuotaEntry,
} from './subscription-quota';

type ProviderLike = Parameters<typeof quotaTargets>[0][number];

/** 会话级缓存：下钻供应商详情再返回不重复打接口（过期仍按 60s 节奏刷新）。 */
const quotaCache = new Map<string, QuotaEntry>();
const inflightByBridge = new WeakMap<object, Map<string, Promise<Awaited<ReturnType<FetchQuota>>>>>();

/** fixtures / 测试专用：清空会话缓存。 */
export function resetSubscriptionQuotaCache(): void {
  quotaCache.clear();
}

/** 桥方法由主进程新增；旧桥上缺失时整块不显示。 */
export function quotaFetcher(bridge: unknown): FetchQuota | null {
  const fn = (bridge as { getSubscriptionQuota?: FetchQuota } | null | undefined)?.getSubscriptionQuota;
  if (typeof fn !== 'function') return null;
  // 非强制请求按账号合并在途 Promise：StrictMode 双挂载、下钻返回重挂载都不重复打接口。
  let inflight = inflightByBridge.get(fn);
  if (!inflight) { inflight = new Map(); inflightByBridge.set(fn, inflight); }
  const pendingMap = inflight;
  return (provider, options) => {
    const inflight = pendingMap;
    if (options?.force) return fn.call(bridge, provider, options);
    const pending = inflight.get(provider);
    if (pending) return pending;
    const request = fn.call(bridge, provider, options).finally(() => inflight.delete(provider));
    inflight.set(provider, request);
    return request;
  };
}

/**
 * 订阅额度：挂载时读一次，之后 60s 有界轮询（仅页面可见），可见性恢复补查；
 * 卸载、账号身份变化时旧 poller 作废，迟到结果不会写进新界面。
 */
export function useSubscriptionQuota(
  providers: readonly ProviderLike[],
  context: { bridge: unknown; external?: boolean; environment?: 'local' | 'bot' },
) {
  const fetchQuota = useMemo(() => quotaFetcher(context.bridge), [context.bridge]);
  const targets = useMemo(
    () => quotaTargets(providers, { external: context.external, environment: context.environment, canQuery: Boolean(fetchQuota) }),
    [providers, context.external, context.environment, fetchQuota],
  );
  // 只在账号集合真的变化时重建 poller（目录对象每次保存都会换新引用）。
  const signature = targets.map((target) => target.identity).join('|');
  const [entries, setEntries] = useState<Record<string, QuotaEntry>>({});
  const pollerRef = useRef<ReturnType<typeof createQuotaPoller> | null>(null);

  useEffect(() => {
    if (!fetchQuota || !targets.length) {
      setEntries({});
      return;
    }
    const poller = createQuotaPoller({
      targets,
      fetchQuota,
      initial: Object.fromEntries(quotaCache),
      isVisible: () => document.visibilityState !== 'hidden',
      onChange: (next) => {
        for (const [identity, entry] of Object.entries(next)) quotaCache.set(identity, entry);
        setEntries(next);
      },
    });
    pollerRef.current = poller;
    const onVisible = () => poller.onVisible();
    document.addEventListener('visibilitychange', onVisible);
    poller.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      poller.dispose();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
    // signature 覆盖 targets 的语义变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchQuota, signature]);

  const refresh = useCallback(() => pollerRef.current?.refresh(), []);
  const byProviderId = useMemo(() => {
    const out: Record<string, QuotaEntry> = {};
    for (const target of targets) if (entries[target.identity]) out[target.providerId] = entries[target.identity];
    return out;
  }, [targets, entries]);
  const targetIds = useMemo(() => new Set(targets.map((target) => target.providerId)), [targets]);
  const loading = Object.values(byProviderId).some((entry) => entry.loading);
  return { enabled: targets.length > 0, targetIds, byProviderId, refresh, loading };
}
