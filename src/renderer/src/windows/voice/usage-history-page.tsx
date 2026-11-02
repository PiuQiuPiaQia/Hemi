import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Calendar,
  ChevronDown,
  Clock,
  Database,
  HardDrive,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import type {
  UsageHistoryRecord,
  UsageHistoryResponse,
  UsageHistoryStatus,
} from '@/shared/types';
import { NavRail } from './nav-rail';
import { AppTopBar } from '@/components/app-top-bar';
import { Tooltip } from '@/components/ui/tooltip';
import { formatNumber, formatDuration, formatTPS } from '@/utils/format-usage';
import {
  localDateKey, nextLocalMidnight, parseLocalDate, resolveUsageDateRange,
  usageHeatmapRange, validateUsageDates,
  type UsageDateFilter, type UsageDatePreset,
} from '@/utils/usage-history-dates';

/**
 * 使用记录独立应用页：跨会话总览消耗，GitHub 贡献图式热力图，可筛选分页的请求历史。
 * 遵循 037 视觉系统：图标栏 + 内容列（h37-column），深浅色、响应式、键盘可访问。
 */

const PAGE_SIZE = 50;

type HeatmapMetric = 'requests' | 'tokens';
const DATE_PRESETS: Array<{ value: UsageDatePreset; label: string }> = [
  { value: 'today', label: '今天' }, { value: 'yesterday', label: '昨天' },
  { value: 'last7', label: '近 7 天' }, { value: 'all', label: '全部' },
];
type UsageFilters = {
  date: UsageDateFilter;
  model: string;
  status: 'all' | UsageHistoryStatus;
  search: string;
  offset: number;
};

export function UsageHistoryPage({ onClose }: { onClose: () => void }) {
  const [filters, setFilters] = useState<UsageFilters>({
    date: { preset: 'today' }, model: '', status: 'all', search: '', offset: 0,
  });
  const [localDay, setLocalDay] = useState(() => localDateKey(new Date()));
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState(localDay);
  const [customEnd, setCustomEnd] = useState(localDay);
  const [dateError, setDateError] = useState('');
  const [result, setResult] = useState<{ key: string; response: UsageHistoryResponse } | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorState, setError] = useState<{ key: string; message: string } | null>(null);
  const [heatmapMetric, setHeatmapMetric] = useState<HeatmapMetric>('tokens');
  const requestSeqRef = useRef(0);
  const { model, status: statusFilter, search: searchQuery, offset } = filters;
  const dateRange = useMemo(() => resolveUsageDateRange(filters.date, parseLocalDate(localDay)!), [filters.date, localDay]);
  const query = useMemo(() => ({
    ...dateRange, model: model || undefined, query: searchQuery || undefined,
    status: statusFilter, limit: PAGE_SIZE, offset,
  }), [dateRange, model, searchQuery, statusFilter, offset]);
  const queryKey = JSON.stringify(query);
  // 查询一变就隐藏上一筛选的结果，不等 effect 执行；刷新也不会残留旧统计或热力图。
  const error = errorState?.key === queryKey ? errorState.message : '';
  const pending = loading || (!error && result?.key !== queryKey);
  const data = !pending && !error ? result?.response : null;
  const totalTokens = data ? data.totals.input + data.totals.output + data.totals.cacheRead + data.totals.cacheWrite : null;
  const cachedTokens = data ? data.totals.cacheRead + data.totals.cacheWrite : null;
  // 模型选项来自完整历史的 response.models；加载、空结果、分页都不清空选择器。
  const models = result?.response.models ?? [];
  const modelOptions = model && !models.includes(model) ? [model, ...models] : models;

  const updateFilters = useCallback((patch: Partial<UsageFilters>) => {
    setFilters(previous => ({ ...previous, ...patch, offset: 0 }));
  }, []);

  const syncLocalDay = useCallback(() => {
    const next = localDateKey(new Date());
    if (next !== localDay) {
      setLocalDay(next);
      setFilters(previous => previous.date.preset === 'all' || previous.date.preset === 'custom'
        ? previous : { ...previous, offset: 0 });
      return true;
    }
    return false;
  }, [localDay]);

  useEffect(() => {
    // 精确到下一个本地午夜；从睡眠恢复或切回窗口时也重新核对日期。
    const timer = window.setTimeout(syncLocalDay, nextLocalMidnight(new Date()).getTime() - Date.now() + 20);
    const onVisible = () => { if (document.visibilityState === 'visible') syncLocalDay(); };
    window.addEventListener('focus', syncLocalDay);
    document.addEventListener('visibilitychange', onVisible);
    syncLocalDay();
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', syncLocalDay);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [syncLocalDay]);

  const loadData = useCallback(() => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    void window.hemiVoice.getUsageHistory(query).then(response => {
      if (seq === requestSeqRef.current) setResult({ key: queryKey, response });
    }).catch(err => {
      if (seq === requestSeqRef.current) setError({ key: queryKey, message: err instanceof Error ? err.message : '加载失败，请重试。' });
    }).finally(() => {
      if (seq === requestSeqRef.current) setLoading(false);
    });
  }, [query, queryKey]);

  useEffect(() => {
    loadData();
    return () => { requestSeqRef.current += 1; };
  }, [loadData]);

  const handleRefresh = () => {
    const changedDay = syncLocalDay();
    if (!changedDay || filters.date.preset === 'all' || filters.date.preset === 'custom') loadData();
  };
  const choosePreset = (preset: UsageDatePreset) => {
    syncLocalDay();
    setCustomOpen(false);
    setDateError('');
    if (filters.date.preset !== preset) updateFilters({ date: { preset } });
  };
  const dateLabel = filters.date.preset === 'all' ? '全部日期'
    : `${localDateKey(new Date(dateRange.from!))}${localDateKey(new Date(dateRange.from!)) === localDateKey(new Date(dateRange.to!)) ? '' : ` 至 ${localDateKey(new Date(dateRange.to!))}`}`;
  const heatmapRange = useMemo(() => usageHeatmapRange(dateRange, parseLocalDate(localDay)!), [dateRange, localDay]);

  const heatmapWeeks = useMemo(() => {
    if (!heatmapRange) return [];
    const days = new Map(data?.daily.map(day => [day.date, day]));
    const weeks: Array<Array<{ date: string; value: number; label: string } | null>> = [];
    let currentWeek: Array<{ date: string; value: number; label: string } | null> = Array(heatmapRange.first.getDay()).fill(null);
    for (const date = new Date(heatmapRange.first); date <= heatmapRange.last; date.setDate(date.getDate() + 1)) {
      const key = localDateKey(date);
      const day = days.get(key);
      const value = !day ? 0 : heatmapMetric === 'requests' ? day.requests
        : day.input + day.output + day.cacheRead + day.cacheWrite;
      currentWeek.push({ date: key, value, label: `${key}\n${formatNumber(value)} ${heatmapMetric === 'requests' ? '请求' : 'tokens'}` });
      if (date.getDay() === 6) { weeks.push(currentWeek); currentWeek = []; }
    }
    if (currentWeek.length) weeks.push(currentWeek);
    return weeks;
  }, [data?.daily, heatmapMetric, heatmapRange]);

  const maxHeatmapValue = useMemo(() => Math.max(...heatmapWeeks.flat().map(day => day?.value ?? 0), 1), [heatmapWeeks]);

  return (
    <div className="compact-shell h24-shell h37-usage-shell" data-page="usage">
      <AppTopBar showBrand={false} title="使用记录" back={{ label: '返回对话', onClick: onClose }} />

      <div className="h24-frame">
        <NavRail page="usage" onShowHome={onClose} />

        <main className="h37-usage-main">
          <div className="h37-column">
            <section className="h37-section" aria-label="请求筛选">
              <div className="h37-section-head">
                <h2>请求历史</h2>
                <button type="button" className="icon-btn" aria-label="刷新数据" onClick={handleRefresh} disabled={pending}>
                  <RefreshCw className={pending ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
                </button>
              </div>
              <div className="h37-usage-date-presets" role="group" aria-label="日期范围">
                <span className="h37-usage-filter-label">日期</span>
                {DATE_PRESETS.map(preset => (
                  <button key={preset.value} type="button" className="h37-usage-toggle-btn"
                    data-active={filters.date.preset === preset.value ? 'true' : undefined}
                    aria-pressed={filters.date.preset === preset.value} onClick={() => choosePreset(preset.value)}>
                    {preset.label}
                  </button>
                ))}
                <button type="button" className="h37-usage-toggle-btn"
                  data-active={filters.date.preset === 'custom' ? 'true' : undefined}
                  aria-pressed={filters.date.preset === 'custom'} aria-expanded={customOpen}
                  aria-controls="usage-custom-dates" onClick={() => { setCustomOpen(!customOpen); setDateError(''); }}>
                  自定义
                </button>
              </div>
              {customOpen && (
                <form id="usage-custom-dates" className="h37-usage-custom-dates" noValidate onSubmit={event => {
                  event.preventDefault();
                  const validation = validateUsageDates(customStart, customEnd);
                  setDateError(validation);
                  if (!validation) updateFilters({ date: { preset: 'custom', start: customStart, end: customEnd } });
                }}>
                  <div className="h37-usage-date-field">
                    <label htmlFor="usage-date-start" className="h37-usage-filter-label">开始日期</label>
                    <input id="usage-date-start" type="date" className="h37-input" value={customStart}
                      aria-invalid={!!dateError} aria-describedby={dateError ? 'usage-date-error' : undefined}
                      onChange={event => { setCustomStart(event.target.value); setDateError(''); }} />
                  </div>
                  <div className="h37-usage-date-field">
                    <label htmlFor="usage-date-end" className="h37-usage-filter-label">结束日期</label>
                    <input id="usage-date-end" type="date" className="h37-input" value={customEnd}
                      aria-invalid={!!dateError} aria-describedby={dateError ? 'usage-date-error' : undefined}
                      onChange={event => { setCustomEnd(event.target.value); setDateError(''); }} />
                  </div>
                  <button type="submit" className="h37-btn h37-btn-secondary">应用日期</button>
                  {dateError && <p id="usage-date-error" className="h37-usage-date-error" role="alert">{dateError}</p>}
                </form>
              )}
              <div className="h37-usage-filters">
                <div className="h37-usage-search">
                  <Search className="size-3.5" aria-hidden="true" />
                  <input type="text" placeholder="搜索 URL、模型、协议..." value={searchQuery}
                    onChange={event => updateFilters({ search: event.target.value })} aria-label="搜索请求记录" />
                  {searchQuery && (
                    <button type="button" className="h37-usage-search-clear" onClick={() => updateFilters({ search: '' })} aria-label="清除搜索">
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
                <div className="h37-usage-filter-group h37-usage-model-filter">
                  <label htmlFor="usage-model-filter" className="h37-usage-filter-label">模型</label>
                  <div className="h37-settings-select">
                    <select id="usage-model-filter" className="h37-select" value={model}
                      onChange={event => updateFilters({ model: event.target.value })}>
                      <option value="">全部模型</option>
                      {modelOptions.map(option => <option key={option} value={option}>{option}</option>)}
                    </select>
                    <ChevronDown aria-hidden="true" />
                  </div>
                </div>
                <div className="h37-usage-filter-group h37-usage-status-filter">
                  <label htmlFor="status-filter" className="h37-usage-filter-label">状态</label>
                  <div className="h37-settings-select">
                    <select id="status-filter" className="h37-select" value={statusFilter}
                      onChange={event => updateFilters({ status: event.target.value as 'all' | UsageHistoryStatus })}>
                      <option value="all">全部</option><option value="success">成功</option>
                      <option value="error">失败</option><option value="running">进行中</option>
                    </select>
                    <ChevronDown aria-hidden="true" />
                  </div>
                </div>
              </div>
              <p className="h37-usage-scope">{dateLabel} · 本地时间 · 统计与列表均按当前筛选</p>
            </section>

            {/* 总览卡片：更新期间不展示旧筛选的统计。 */}
            {(
              <section className="h37-usage-overview">
                <div className="h37-usage-stat">
                  <div className="h37-usage-stat-icon" data-tone="blue">
                    <Activity className="size-4" aria-hidden="true" />
                  </div>
                  <div className="h37-usage-stat-text">
                    <div className="h37-usage-stat-value" title={data?.totals.requests.toLocaleString()}>
                      {data?.totals.requests.toLocaleString() ?? '—'}
                    </div>
                    <div className="h37-usage-stat-label">总请求数</div>
                  </div>
                </div>

                <div className="h37-usage-stat">
                  <div className="h37-usage-stat-icon" data-tone="green">
                    <Database className="size-4" aria-hidden="true" />
                  </div>
                  <div className="h37-usage-stat-text">
                    <div className="h37-usage-stat-value" title={totalTokens?.toLocaleString()}>
                      {formatNumber(totalTokens)}
                    </div>
                    <div className="h37-usage-stat-label">已记录用量</div>
                  </div>
                </div>

                <div className="h37-usage-stat">
                  <div className="h37-usage-stat-icon" data-tone="purple">
                    <HardDrive className="size-4" aria-hidden="true" />
                  </div>
                  <div className="h37-usage-stat-text">
                    <div className="h37-usage-stat-value" title={cachedTokens?.toLocaleString()}>
                      {formatNumber(cachedTokens)}
                    </div>
                    <div className="h37-usage-stat-label">缓存用量</div>
                  </div>
                </div>
              </section>
            )}

            {/* 热力图 */}
            {data && heatmapRange && data.daily.length > 0 ? (
              <section className="h37-section">
                <div className="h37-section-head h37-usage-heatmap-head">
                  <h2>活动热力图</h2>
                  <div className="h37-usage-heatmap-controls">
                    <div className="h37-usage-heatmap-toggle" role="group" aria-label="热力图指标">
                    <button
                      type="button"
                      className="h37-usage-toggle-btn"
                      data-active={heatmapMetric === 'requests' ? 'true' : undefined}
                      aria-pressed={heatmapMetric === 'requests'}
                      onClick={() => setHeatmapMetric('requests')}
                    >
                      请求数
                    </button>
                    <button
                      type="button"
                      className="h37-usage-toggle-btn"
                      data-active={heatmapMetric === 'tokens' ? 'true' : undefined}
                      aria-pressed={heatmapMetric === 'tokens'}
                      onClick={() => setHeatmapMetric('tokens')}
                    >
                      Tokens
                    </button>
                  </div>
                  <div className="h37-usage-heatmap-legend">
                    <span className="h37-usage-legend-label">少</span>
                    {[0, 1, 2, 3, 4].map(level => (
                      <div key={level} className="h37-usage-heatmap-cell" data-level={level} />
                    ))}
                    <span className="h37-usage-legend-label">多</span>
                  </div>
                </div>
              </div>
                <p className="h37-usage-scope">{localDateKey(heatmapRange.first)} 至 {localDateKey(heatmapRange.last)} · 当前筛选，最多显示近 12 周</p>
                <div className="h37-usage-heatmap">
                  {heatmapWeeks.map((week, weekIndex) => (
                    <div key={weekIndex} className="h37-usage-heatmap-week">
                      {week.map((day, dayIndex) => {
                        if (!day) return <div key={`pad-${dayIndex}`} className="h37-usage-heatmap-spacer" aria-hidden="true" />;
                        const intensity = day.value / maxHeatmapValue;
                        const level = intensity === 0 ? 0 : Math.max(1, Math.ceil(intensity * 4));
                        return (
                          <Tooltip
                            key={day.date}
                            content={day.label}
                            delay={200}
                          >
                            <div
                              className="h37-usage-heatmap-cell"
                              data-level={level}
                              tabIndex={0}
                              role="img"
                              aria-label={day.label}
                            />
                          </Tooltip>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {/* 记录列表 */}
            {pending ? (
              <div className="h37-usage-state" role="status">
                <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                <p>加载中...</p>
              </div>
            ) : error ? (
              <div className="h37-usage-state h37-usage-error">
                <AlertCircle className="size-5" aria-hidden="true" />
                <p role="alert">{error}</p>
                <button type="button" className="h37-btn h37-btn-secondary" onClick={handleRefresh}>重试</button>
              </div>
            ) : !data?.records.length ? (
              <div className="h37-usage-state" role="status">
                <Calendar className="size-5" aria-hidden="true" />
                <p>当前筛选下暂无记录</p>
                <span className="h37-usage-empty-hint">试试其他日期、模型或清除搜索。</span>
              </div>
            ) : (
              <>
                <div className="h37-usage-table-wrap">
                  <table className="h37-usage-table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>模型</th>
                        <th>协议</th>
                        <th>状态</th>
                        <th className="h37-usage-th-right">输入</th>
                        <th className="h37-usage-th-right">输出</th>
                        <th className="h37-usage-th-right">缓存读</th>
                        <th className="h37-usage-th-right">TTFT</th>
                        <th className="h37-usage-th-right">耗时</th>
                        <th className="h37-usage-th-right">TPS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.records.map((record) => (
                        <UsageRecordRow key={record.id} record={record} />
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* 分页 */}
                {data.total > PAGE_SIZE && (
                  <div className="h37-usage-pagination">
                    <span className="h37-usage-pagination-info">
                      显示 {offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} / 共 {data.total} 条
                    </span>
                    <div className="h37-usage-pagination-actions">
                      <button
                        type="button"
                        className="h37-btn h37-btn-secondary"
                        disabled={offset === 0}
                        onClick={() => setFilters(previous => ({ ...previous, offset: Math.max(0, previous.offset - PAGE_SIZE) }))}
                      >
                        上一页
                      </button>
                      <button
                        type="button"
                        className="h37-btn h37-btn-secondary"
                        disabled={offset + PAGE_SIZE >= data.total}
                        onClick={() => setFilters(previous => ({ ...previous, offset: previous.offset + PAGE_SIZE }))}
                      >
                        下一页
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function UsageRecordRow({ record }: { record: UsageHistoryRecord }) {
  const [expanded, setExpanded] = useState(false);

  const formatTime = (ms: number) => {
    const date = new Date(ms);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
      return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' ' +
      date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <>
      <tr
        className="h37-usage-row"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
        aria-expanded={expanded}
      >
        <td className="h37-usage-td-time">
          <Clock className="size-3.5" aria-hidden="true" />
          {formatTime(record.at)}
        </td>
        <td className="h37-usage-td-model" title={record.model || '未记录'}>
          {record.model || '—'}
        </td>
        <td>{record.protocol || '—'}</td>
        <td>
          <span className="h37-usage-status" data-status={record.status}>
            {record.status === 'success' ? '成功' : record.status === 'error' ? '失败' : '进行中'}
          </span>
        </td>
        <td className="h37-usage-td-right" title={record.input !== null ? record.input.toLocaleString() : undefined}>
          {formatNumber(record.input)}
        </td>
        <td className="h37-usage-td-right" title={record.output !== null ? record.output.toLocaleString() : undefined}>
          {formatNumber(record.output)}
        </td>
        <td className="h37-usage-td-right" title={record.cacheRead !== null ? record.cacheRead.toLocaleString() : undefined}>
          {formatNumber(record.cacheRead)}
        </td>
        <td className="h37-usage-td-right" title={record.ttftMs !== null ? `${record.ttftMs}ms` : undefined}>
          {formatDuration(record.ttftMs)}
        </td>
        <td className="h37-usage-td-right" title={record.durationMs !== null ? `${record.durationMs}ms` : undefined}>
          {formatDuration(record.durationMs)}
        </td>
        <td className="h37-usage-td-right" title={record.tps !== null ? record.tps.toFixed(2) : undefined}>
          {formatTPS(record.tps)}
        </td>
      </tr>
      {expanded && (
        <tr className="h37-usage-detail-row">
          <td colSpan={10}>
            <div className="h37-usage-detail">
              <div className="h37-usage-detail-grid">
                <div className="h37-usage-detail-item">
                  <div className="h37-usage-detail-label">URL</div>
                  <div className="h37-usage-detail-value">{record.url || '未记录'}</div>
                </div>
                <div className="h37-usage-detail-item">
                  <div className="h37-usage-detail-label">思考强度（配置值）</div>
                  <div className="h37-usage-detail-value">{record.thinkingLevel || '未记录'}</div>
                </div>
                <div className="h37-usage-detail-item">
                  <div className="h37-usage-detail-label">缓存写</div>
                  <div className="h37-usage-detail-value">{record.cacheWrite !== null ? formatNumber(record.cacheWrite) : '未记录'}</div>
                </div>
                <div className="h37-usage-detail-item">
                  <div className="h37-usage-detail-label">推理 tokens</div>
                  <div className="h37-usage-detail-value">{record.reasoning !== null ? formatNumber(record.reasoning) : '未记录'}</div>
                </div>
                {record.role && (
                  <div className="h37-usage-detail-item">
                    <div className="h37-usage-detail-label">角色</div>
                    <div className="h37-usage-detail-value">{record.role}</div>
                  </div>
                )}
                {record.purpose && (
                  <div className="h37-usage-detail-item">
                    <div className="h37-usage-detail-label">用途</div>
                    <div className="h37-usage-detail-value">{record.purpose}</div>
                  </div>
                )}
                {record.conversationId && (
                  <div className="h37-usage-detail-item">
                    <div className="h37-usage-detail-label">会话</div>
                    <div className="h37-usage-detail-value h37-usage-mono">{record.conversationId}</div>
                  </div>
                )}
                {record.httpStatus !== null && (
                  <div className="h37-usage-detail-item">
                    <div className="h37-usage-detail-label">HTTP 状态</div>
                    <div className="h37-usage-detail-value">{record.httpStatus}</div>
                  </div>
                )}
                {record.error && (
                  <div className="h37-usage-detail-item h37-usage-detail-full">
                    <div className="h37-usage-detail-label">错误</div>
                    <div className="h37-usage-detail-value h37-usage-error-text">{record.error}</div>
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
