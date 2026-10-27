/**
 * 使用记录 API 类型（渲染层与主进程共享）。
 * 主进程从运行事实库投影，渲染层通过 hemiVoice preload 查询。
 */

export type UsageHistoryStatus = 'success' | 'error' | 'running';

export type UsageHistoryRecord = {
  id: string;
  conversationId: string | null;
  at: number;
  endedAt: number | null;
  url: string | null;
  model: string | null;
  protocol: string | null;
  thinkingLevel: string | null;
  role: string | null;
  purpose: string | null;
  status: UsageHistoryStatus;
  httpStatus: number | null;
  ttftMs: number | null;
  durationMs: number | null;
  tps: number | null;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  error: string | null;
};

export type UsageHistoryDailyStat = {
  date: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type UsageHistoryTotals = {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type UsageHistoryQuery = {
  from?: number;
  to?: number;
  query?: string;
  status?: 'all' | UsageHistoryStatus;
  limit?: number;
  offset?: number;
};

export type UsageHistoryResponse = {
  records: UsageHistoryRecord[];
  total: number;
  daily: UsageHistoryDailyStat[];
  totals: UsageHistoryTotals;
  earliestAt: number | null;
};
