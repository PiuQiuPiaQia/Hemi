/** 使用记录按本地日历筛选；不能用 UTC 日期或固定 24 小时推算日界。 */
export type UsageDatePreset = 'today' | 'yesterday' | 'last7' | 'all';
export type UsageDateFilter = { preset: UsageDatePreset }
  | { preset: 'custom'; start: string; end: string };
export type UsageDateRange = { from?: number; to?: number };

export function localDateKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function parseLocalDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return localDateKey(date) === value ? date : null;
}

export function nextLocalMidnight(now: Date): Date {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function validateUsageDates(start: string, end: string): string {
  if (!start || !end) return '请选择开始日期和结束日期。';
  const first = parseLocalDate(start);
  const last = parseLocalDate(end);
  if (!first || !last) return '请输入有效日期。';
  if (first > last) return '开始日期不能晚于结束日期。';
  return '';
}

export function resolveUsageDateRange(filter: UsageDateFilter, now: Date): UsageDateRange {
  if (filter.preset === 'all') return {};
  if (filter.preset === 'custom') {
    const error = validateUsageDates(filter.start, filter.end);
    if (error) throw new RangeError(error);
    return { from: parseLocalDate(filter.start)!.getTime(), to: nextLocalMidnight(parseLocalDate(filter.end)!).getTime() - 1 };
  }
  const first = new Date(now);
  first.setHours(0, 0, 0, 0);
  if (filter.preset === 'yesterday') first.setDate(first.getDate() - 1);
  if (filter.preset === 'last7') first.setDate(first.getDate() - 6);
  const last = filter.preset === 'yesterday' ? nextLocalMidnight(first) : nextLocalMidnight(now);
  return { from: first.getTime(), to: last.getTime() - 1 };
}

/** 短范围无需贡献图；长范围最多展示末尾 12 周，并明确可见的日历范围。 */
export function usageHeatmapRange(range: UsageDateRange, now: Date): { first: Date; last: Date } | null {
  const last = new Date(range.to ?? now.getTime());
  last.setHours(0, 0, 0, 0);
  const first = new Date(last);
  first.setDate(first.getDate() - 83);
  if (range.from !== undefined && range.from > first.getTime()) first.setTime(range.from);
  const afterWeek = new Date(first);
  afterWeek.setDate(afterWeek.getDate() + 6);
  return afterWeek >= last ? null : { first, last };
}
