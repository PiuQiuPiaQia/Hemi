import { useDelayed } from '@/components/save-indicator';
import {
  formatClock,
  formatQuotaReset,
  formatQuotaValue,
  quotaTone,
  type QuotaEntry,
} from '@/windows/voice/lib/subscription-quota';

/** 展示用短标签：去掉括注（「本周（7 天）」→「本周」），完整名保留在悬停提示里。 */
function shortLabel(label: string): string {
  return label.replace(/（[^）]*）|\([^)]*\)/g, '').trim() || label;
}

/**
 * 订阅行右侧的紧凑额度：一个窗口一个小单元（短标签 · 定宽短进度条 · 剩余）。
 * 挂在供应商行按钮的行尾区，纯展示 span、不含任何交互元素——点它等于点整行；
 * 计数与重置时间进 title 悬停提示，不占行内空间；读屏由行按钮文本自然带出。
 */
export function SubscriptionQuota({ entry, name, now = Date.now() }: { entry: QuotaEntry | undefined; name: string; now?: number }) {
  const pending = !entry || (entry.loading && !entry.view && !entry.error);
  const slow = useDelayed(pending);
  if (pending) {
    // 300ms 内不闪占位；之后给一小段提示，不画假进度。
    return slow ? <span className="h37q" data-state="loading"><span className="h37q-note">读取中…</span></span> : null;
  }
  const { view, error } = entry;
  if (!view) {
    return <span className="h37q" data-state="error" title={error ?? undefined}><span className="h37q-note" data-tone="warn">额度未读取</span></span>;
  }
  // 未登录由行尾徽标说明，这里不重复。
  if (view.status === 'signed-out') return null;
  if (view.status === 'unsupported') {
    return <span className="h37q" data-state="unsupported" title={view.message ?? undefined}><span className="h37q-note">暂不支持查询</span></span>;
  }
  if (view.status === 'unavailable') {
    return <span className="h37q" data-state="unavailable" title={view.message ?? undefined}><span className="h37q-note" data-tone="warn">额度暂不可查</span></span>;
  }
  if (!view.windows.length) {
    return <span className="h37q" data-state="empty" title={view.message ?? undefined}><span className="h37q-note">无额度数据</span></span>;
  }
  const stale = Boolean(error);
  const staleNote = stale ? `没刷新上，显示的是 ${formatClock(view.fetchedAt)} 的数据` : '';
  return (
    <span className="h37q" data-state="ok" data-stale={stale || undefined}>
      {view.windows.map((window) => {
        const value = formatQuotaValue(window);
        const reset = formatQuotaReset(window.resetsAt, now);
        const tone = quotaTone(window.remainingPercent);
        const title = [`${name} · ${window.label}`, value.text, value.detail, reset, staleNote].filter(Boolean).join('，');
        return (
          <span key={window.id} className="h37q-item" data-tone={tone} title={title}>
            <span className="h37q-label">{shortLabel(window.label)}</span>
            {/* 进度条只是视觉，宽度=剩余百分比；数值都以文字给出。 */}
            <span className="h37q-bar" aria-hidden>
              {window.remainingPercent !== null ? <span className="h37q-fill" style={{ width: `${window.remainingPercent}%` }} /> : null}
            </span>
            <span className="h37q-value">{value.text}</span>
          </span>
        );
      })}
    </span>
  );
}

/** 订阅分组标题右侧：更新时间 + 刷新（独立按钮，不在行按钮内）。 */
export function SubscriptionQuotaRefresh({
  entries,
  loading,
  onRefresh,
}: {
  entries: QuotaEntry[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const fetched = entries.map((entry) => (entry.view?.status === 'ok' ? entry.view.fetchedAt : null)).filter((at): at is number => at !== null);
  const oldest = fetched.length ? Math.min(...fetched) : null;
  const slow = useDelayed(loading);
  return (
    <span className="h37-aside h37q-head">
      {oldest !== null ? <span className="h37q-updated">额度 {formatClock(oldest)} 更新</span> : null}
      <button type="button" className="h37-btn h37-btn-ghost h37-btn-sm" disabled={loading} onClick={onRefresh} aria-label="刷新订阅额度">
        {slow ? '刷新中…' : '刷新'}
      </button>
    </span>
  );
}
