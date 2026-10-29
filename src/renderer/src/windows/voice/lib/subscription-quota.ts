/**
 * 订阅额度（设置 → 模型 → 订阅列表）：纯逻辑层——资格判断、格式化、有界轮询与迟到结果防护。
 * React 外壳在 use-subscription-quota.ts；本文件不依赖 DOM/React，供 node --test 直接测。
 *
 * 类型来自 src/shared/protocol.ts（window.hemiVoice.getSubscriptionQuota 的 DTO）。
 */

import type { OAuthProvider, SubscriptionQuotaView, SubscriptionQuotaWindow } from '@shared/protocol';

export type { SubscriptionQuotaView, SubscriptionQuotaWindow };
export type QuotaOAuthProvider = OAuthProvider;

export type FetchQuota = (provider: QuotaOAuthProvider, options?: { force?: boolean }) => Promise<SubscriptionQuotaView>;

/** 目前只有这两家能查额度；其余订阅不发请求、不显示额度块。 */
export const QUOTA_PROVIDERS: ReadonlySet<QuotaOAuthProvider> = new Set(['openai', 'bigmodel']);
export const QUOTA_POLL_MS = 60_000;

type ProviderLike = { id: string; oauthProvider?: string; source?: 'local' | 'cloud'; hasApiKey?: boolean; updatedAt?: number };

/** 只查本机订阅：Bot / 外部目录 / 云端来源一律不查，避免拿本地账号去回答远程目录。 */
export function quotaTargets(
  providers: readonly ProviderLike[],
  context: { external?: boolean; environment?: 'local' | 'bot'; canQuery: boolean },
): Array<{ providerId: string; oauthProvider: QuotaOAuthProvider; identity: string }> {
  if (!context.canQuery || context.external || context.environment === 'bot') return [];
  const seen = new Set<string>();
  const out: Array<{ providerId: string; oauthProvider: QuotaOAuthProvider; identity: string }> = [];
  for (const provider of providers) {
    const oauth = provider.oauthProvider as QuotaOAuthProvider | undefined;
    // 行尾已标「未登录」的账号（hasApiKey=false）不发请求。
    if (!oauth || !QUOTA_PROVIDERS.has(oauth) || provider.source === 'cloud' || provider.hasApiKey === false || seen.has(oauth)) continue;
    seen.add(oauth);
    // 账号切换/重新登录会改 updatedAt / hasApiKey：身份变了就丢掉旧结果重新查。
    out.push({ providerId: provider.id, oauthProvider: oauth, identity: `${oauth}:${provider.id}:${provider.updatedAt ?? 0}:${provider.hasApiKey ? 1 : 0}` });
  }
  return out;
}

export type QuotaEntry = {
  view: SubscriptionQuotaView | null;
  /** 请求本身失败（IPC 抛错）；与 view.status='unavailable' 区分。 */
  error: string | null;
  loading: boolean;
  /** 本地收到结果的时刻（轮询节流用；与 view.fetchedAt 无关）。 */
  receivedAt: number | null;
};

export const EMPTY_ENTRY: QuotaEntry = Object.freeze({ view: null, error: null, loading: false, receivedAt: null });

function cleanPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 防御后端偶发脏数据：非数字百分比当未知，不当 0。 */
export function normalizeQuotaView(raw: unknown, provider: QuotaOAuthProvider): SubscriptionQuotaView | null {
  if (!raw || typeof raw !== 'object') return null;
  const view = raw as Partial<SubscriptionQuotaView>;
  if (view.provider !== provider) return null;
  const status = view.status === 'ok' || view.status === 'unsupported' || view.status === 'unavailable' || view.status === 'signed-out' ? view.status : null;
  if (!status) return null;
  const windows = status === 'ok' && Array.isArray(view.windows)
    ? view.windows.filter((w): w is SubscriptionQuotaWindow => Boolean(w && typeof w.id === 'string' && typeof w.label === 'string')).map((w) => ({
      id: w.id,
      label: w.label,
      remainingPercent: cleanPercent(w.remainingPercent),
      used: cleanNumber(w.used),
      limit: cleanNumber(w.limit),
      remaining: cleanNumber(w.remaining),
      unit: typeof w.unit === 'string' ? w.unit : undefined,
      resetsAt: cleanNumber(w.resetsAt),
    }))
    : [];
  return {
    provider,
    status,
    windows,
    fetchedAt: cleanNumber(view.fetchedAt) ?? Date.now(),
    message: typeof view.message === 'string' && view.message.trim() ? view.message.trim() : undefined,
  };
}

export function quotaErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim() || '未知错误';
}

export type QuotaTone = 'ok' | 'warn' | 'danger' | 'unknown';

export function quotaTone(remainingPercent: number | null): QuotaTone {
  if (remainingPercent === null) return 'unknown';
  if (remainingPercent <= 10) return 'danger';
  if (remainingPercent <= 25) return 'warn';
  return 'ok';
}

function formatCount(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
}

/**
 * 主值：「剩 62%」；百分比未知时绝不写 0%，退到剩余量 / 用量或「剩余未知」。
 * detail（剩余 / 上限）只用于悬停与读屏；剩余优先取服务器 remaining，缺省才用 limit-used。
 */
export function formatQuotaValue(window: SubscriptionQuotaWindow): { text: string; detail: string | null } {
  const unit = window.unit ? ` ${window.unit}` : '';
  const left = window.remaining ?? (window.used !== undefined && window.limit !== undefined ? Math.max(0, window.limit - window.used) : undefined);
  const detail = left !== undefined && window.limit !== undefined && window.limit > 0 ? `${formatCount(left)} / ${formatCount(window.limit)}${unit}` : null;
  if (window.remainingPercent !== null) return { text: `剩 ${Math.round(window.remainingPercent)}%`, detail };
  if (left !== undefined) return { text: `剩 ${formatCount(left)}${unit}`, detail: window.limit !== undefined && window.limit > 0 ? `共 ${formatCount(window.limit)}${unit}` : null };
  if (window.used !== undefined) return { text: `已用 ${formatCount(window.used)}${unit}`, detail: null };
  return { text: '剩余未知', detail: null };
}

/** 行尾紧凑标签：「5 小时额度」→「5 小时」、「周额度」→「周」；全称留给悬停与读屏。 */
export function shortQuotaLabel(label: string): string {
  return label.replace(/\s*额度$/, '').trim() || label;
}

function formatCompactCount(value: number): string {
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}万`;
  return formatCount(value);
}

/**
 * 行尾紧凑主值（定宽列里放得下）：百分比照旧「剩 62%」；无百分比时计数缩成「剩 5.2万」、不带单位，
 * 「剩余未知」缩成「未知」。完整说法以 formatQuotaValue / quotaAriaLabel 为准。
 */
export function formatQuotaCompact(window: SubscriptionQuotaWindow): string {
  if (window.remainingPercent !== null) return `剩 ${Math.round(window.remainingPercent)}%`;
  const left = window.remaining ?? (window.used !== undefined && window.limit !== undefined ? Math.max(0, window.limit - window.used) : undefined);
  if (left !== undefined) return `剩 ${formatCompactCount(left)}`;
  if (window.used !== undefined) return `用 ${formatCompactCount(window.used)}`;
  return '未知';
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (value: number) => String(value).padStart(2, '0');

/** 重置时间：一天内用相对时间（扫读快），更远给星期/日期＋时刻。 */
export function formatQuotaReset(resetsAt: number | undefined, now: number): string | null {
  if (resetsAt === undefined) return null;
  const diff = resetsAt - now;
  if (diff <= 60_000) return diff > -5 * 60_000 ? '即将重置' : null;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟后重置`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h} 小时${m ? ` ${m} 分` : ''}后重置`;
  }
  const at = new Date(resetsAt);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (diff < 7 * 86_400_000) return `${WEEKDAYS[at.getDay()]} ${time} 重置`;
  return `${at.getMonth() + 1}月${at.getDate()}日 重置`;
}

export function formatClock(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 整句读屏文本：「5 小时额度，剩 62%，3 小时后重置」。 */
export function quotaAriaLabel(window: SubscriptionQuotaWindow, now: number): string {
  const value = formatQuotaValue(window);
  return [window.label, value.text, value.detail, formatQuotaReset(window.resetsAt, now)].filter(Boolean).join('，');
}

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

/**
 * 有界轮询：start 时只查过期项；之后每 intervalMs 一拍，页面不可见时这一拍跳过，
 * 回到可见（onVisible）补查过期项。每个账号单飞，refresh 强制并让在途结果作废；
 * dispose 后所有迟到结果丢弃。
 */
export function createQuotaPoller(options: {
  targets: ReadonlyArray<{ oauthProvider: QuotaOAuthProvider; identity: string }>;
  fetchQuota: FetchQuota;
  onChange: (entries: Record<string, QuotaEntry>) => void;
  initial?: Record<string, QuotaEntry>;
  isVisible?: () => boolean;
  now?: () => number;
  intervalMs?: number;
  timers?: Timers;
}) {
  const now = options.now ?? Date.now;
  const isVisible = options.isVisible ?? (() => true);
  const intervalMs = options.intervalMs ?? QUOTA_POLL_MS;
  const timers: Timers = options.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const entries: Record<string, QuotaEntry> = {};
  for (const target of options.targets) {
    const seeded = options.initial?.[target.identity];
    // 缓存里的在途标记属于已卸载的上一个 poller，不能继承。
    entries[target.identity] = seeded ? { ...seeded, loading: false } : EMPTY_ENTRY;
  }
  const tokens = new Map<string, number>();
  let disposed = false;
  let timer: unknown = null;

  const emit = () => { if (!disposed) options.onChange({ ...entries }); };

  const fetchOne = async (target: { oauthProvider: QuotaOAuthProvider; identity: string }, force: boolean) => {
    const token = (tokens.get(target.identity) ?? 0) + 1;
    tokens.set(target.identity, token);
    entries[target.identity] = { ...entries[target.identity], loading: true };
    emit();
    let next: QuotaEntry;
    try {
      const raw = await options.fetchQuota(target.oauthProvider, force ? { force: true } : undefined);
      const view = normalizeQuotaView(raw, target.oauthProvider);
      next = view
        ? { view, error: null, loading: false, receivedAt: now() }
        : { ...entries[target.identity], error: '额度数据格式不对', loading: false, receivedAt: now() };
    } catch (error) {
      // 失败保留上一份数据（标为过期），只补错误说明。
      next = { ...entries[target.identity], error: quotaErrorText(error), loading: false, receivedAt: now() };
    }
    if (disposed || tokens.get(target.identity) !== token) return;
    entries[target.identity] = next;
    emit();
  };

  const isStale = (identity: string) => {
    const at = entries[identity]?.receivedAt;
    return at === null || at === undefined || now() - at >= intervalMs - 1_000;
  };

  const tickStale = () => {
    for (const target of options.targets) {
      if (!entries[target.identity].loading && isStale(target.identity)) void fetchOne(target, false);
    }
  };

  const schedule = () => {
    if (disposed) return;
    timer = timers.setTimeout(() => {
      if (isVisible()) tickStale();
      schedule();
    }, intervalMs);
  };

  return {
    start() {
      if (disposed) return;
      if (isVisible()) tickStale();
      emit();
      schedule();
    },
    refresh() {
      if (disposed) return;
      for (const target of options.targets) void fetchOne(target, true);
    },
    onVisible() {
      if (!disposed && isVisible()) tickStale();
    },
    dispose() {
      disposed = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
    snapshot: () => ({ ...entries }),
  };
}
