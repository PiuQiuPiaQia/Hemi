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

/**
 * 使用记录独立应用页：跨会话总览消耗，GitHub 贡献图式热力图，可筛选分页的请求历史。
 * 遵循 037 视觉系统：图标栏 + 内容列（h37-column），深浅色、响应式、键盘可访问。
 */

const PAGE_SIZE = 50;

type HeatmapMetric = 'requests' | 'tokens';

export function UsageHistoryPage({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<UsageHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | UsageHistoryStatus>('all');
  const [offset, setOffset] = useState(0);
  const [heatmapMetric, setHeatmapMetric] = useState<HeatmapMetric>('requests');
  const requestSeqRef = useRef(0);

  const loadData = useCallback(() => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError('');
    void window.hemiVoice.getUsageHistory({
      query: searchQuery || undefined, status: statusFilter, limit: PAGE_SIZE, offset,
    }).then(response => {
      if (seq === requestSeqRef.current) setData(response);
    }).catch(err => {
      if (seq === requestSeqRef.current) setError(err instanceof Error ? err.message : '加载失败');
    }).finally(() => {
      if (seq === requestSeqRef.current) setLoading(false);
    });
  }, [searchQuery, statusFilter, offset]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleStatusChange = useCallback((status: 'all' | UsageHistoryStatus) => {
    setStatusFilter(status);
    setOffset(0);
  }, []);

  const handlePrevPage = useCallback(() => {
    setOffset(Math.max(0, offset - PAGE_SIZE));
  }, [offset]);

  const handleNextPage = useCallback(() => {
    if (data && offset + PAGE_SIZE < data.total) {
      setOffset(offset + PAGE_SIZE);
    }
  }, [data, offset]);

  // 热力图数据处理：按周分组
  const heatmapWeeks = useMemo(() => {
    const days = new Map(data?.daily.map(day => [day.date, day]));
    const weeks: Array<Array<{ date: string; value: number; label: string }>> = [];
    let currentWeek: Array<{ date: string; value: number; label: string }> = [];
    const first = new Date();
    first.setHours(0, 0, 0, 0);
    first.setDate(first.getDate() - 83);
    first.setDate(first.getDate() - first.getDay());
    const today = new Date();
    for (const date = new Date(first); date <= today; date.setDate(date.getDate() + 1)) {
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const day = days.get(key);
      const value = !day ? 0 : heatmapMetric === 'requests' ? day.requests
        : day.input + day.output + day.cacheRead + day.cacheWrite;
      currentWeek.push({
        date: key,
        value,
        label: `${key}\n${value.toLocaleString()} ${heatmapMetric === 'requests' ? '请求' : 'tokens'}`,
      });
      if (date.getDay() === 6) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
    }
    if (currentWeek.length) weeks.push(currentWeek);
    return weeks;
  }, [data?.daily, heatmapMetric]);

  const maxHeatmapValue = useMemo(() => {
    return Math.max(...heatmapWeeks.flat().map(day => day.value), 1);
  }, [heatmapWeeks]);

  return (
    <div className="compact-shell h24-shell h37-usage-shell" data-page="usage">
      <AppTopBar showBrand={false} title="使用记录" back={{ label: '返回对话', onClick: onClose }} />

      <div className="h24-frame">
        <NavRail page="usage" onShowHome={onClose} />

        <main className="h37-usage-main">
          <div className="h37-column">
            {/* 总览卡片 */}
            {data && !error && (
              <section className="h37-usage-overview">
                <div className="h37-usage-stat">
                  <div className="h37-usage-stat-icon" data-tone="blue">
                    <Activity className="size-4" aria-hidden="true" />
                  </div>
                  <div className="h37-usage-stat-text">
                    <div className="h37-usage-stat-value" title={data.totals.requests.toLocaleString()}>
                      {data.totals.requests.toLocaleString()}
                    </div>
                    <div className="h37-usage-stat-label">总请求数</div>
                  </div>
                </div>

                <div className="h37-usage-stat">
                  <div className="h37-usage-stat-icon" data-tone="green">
                    <Database className="size-4" aria-hidden="true" />
                  </div>
                  <div className="h37-usage-stat-text">
                    <div className="h37-usage-stat-value" title={(data.totals.input + data.totals.output + data.totals.cacheRead + data.totals.cacheWrite).toLocaleString()}>
                      {formatNumber(data.totals.input + data.totals.output + data.totals.cacheRead + data.totals.cacheWrite)}
                    </div>
                    <div className="h37-usage-stat-label">已记录用量</div>
                  </div>
                </div>

                <div className="h37-usage-stat">
                  <div className="h37-usage-stat-icon" data-tone="purple">
                    <HardDrive className="size-4" aria-hidden="true" />
                  </div>
                  <div className="h37-usage-stat-text">
                    <div className="h37-usage-stat-value" title={(data.totals.cacheRead + data.totals.cacheWrite).toLocaleString()}>
                      {formatNumber(data.totals.cacheRead + data.totals.cacheWrite)}
                    </div>
                    <div className="h37-usage-stat-label">缓存用量</div>
                  </div>
                </div>
              </section>
            )}

            {/* 热力图 */}
            {data?.daily.length ? (
              <section className="h37-section">
                <div className="h37-section-head h37-usage-heatmap-head">
                  <h2>活动热力图（近 12 周）</h2>
                  <div className="h37-usage-heatmap-controls">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="刷新数据"
                      onClick={() => loadData()}
                      disabled={loading}
                    >
                      <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
                    </button>
                    <div className="h37-usage-heatmap-toggle">
                    <button
                      type="button"
                      className="h37-usage-toggle-btn"
                      data-active={heatmapMetric === 'requests' ? 'true' : undefined}
                      onClick={() => setHeatmapMetric('requests')}
                    >
                      请求数
                    </button>
                    <button
                      type="button"
                      className="h37-usage-toggle-btn"
                      data-active={heatmapMetric === 'tokens' ? 'true' : undefined}
                      onClick={() => setHeatmapMetric('tokens')}
                    >
                      Tokens
                    </button>
                    </div>
                  </div>
                </div>
                <div className="h37-usage-heatmap">
                  {heatmapWeeks.map((week, weekIndex) => (
                    <div key={weekIndex} className="h37-usage-heatmap-week">
                      {week.map((day) => {
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
                <div className="h37-usage-heatmap-legend">
                  <span className="h37-usage-legend-label">少</span>
                  {[0, 1, 2, 3, 4].map(level => (
                    <div key={level} className="h37-usage-heatmap-cell" data-level={level} />
                  ))}
                  <span className="h37-usage-legend-label">多</span>
                </div>
              </section>
            ) : null}

            {/* 筛选与搜索 */}
            <section className="h37-section">
              <div className="h37-section-head">
                <h2>请求历史</h2>
              </div>
              <div className="h37-usage-filters">
                <div className="h37-usage-search">
                  <Search className="size-3.5" aria-hidden="true" />
                  <input
                    type="text"
                    placeholder="搜索 URL、模型、协议..."
                    value={searchQuery}
                    onChange={(e) => { setSearchQuery(e.target.value); setOffset(0); }}
                    aria-label="搜索请求记录"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      className="h37-usage-search-clear"
                      onClick={() => {
                        setSearchQuery('');
                        setOffset(0);
                      }}
                      aria-label="清除搜索"
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>

                <div className="h37-usage-filter-group">
                  <label htmlFor="status-filter" className="h37-usage-filter-label">
                    状态
                  </label>
                  <div className="h37-settings-select">
                    <select
                      id="status-filter"
                      className="h37-select"
                      value={statusFilter}
                      onChange={(e) => handleStatusChange(e.target.value as 'all' | UsageHistoryStatus)}
                    >
                      <option value="all">全部</option>
                      <option value="success">成功</option>
                      <option value="error">失败</option>
                      <option value="running">进行中</option>
                    </select>
                    <ChevronDown aria-hidden="true" />
                  </div>
                </div>
              </div>
            </section>

            {/* 记录列表 */}
            {loading ? (
              <div className="h37-usage-state">
                <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                <p>加载中...</p>
              </div>
            ) : error ? (
              <div className="h37-usage-state h37-usage-error">
                <AlertCircle className="size-5" aria-hidden="true" />
                <p>{error}</p>
              </div>
            ) : !data?.records.length ? (
              <div className="h37-usage-state">
                <Calendar className="size-5" aria-hidden="true" />
                <p>暂无记录</p>
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
                        onClick={handlePrevPage}
                      >
                        上一页
                      </button>
                      <button
                        type="button"
                        className="h37-btn h37-btn-secondary"
                        disabled={offset + PAGE_SIZE >= data.total}
                        onClick={handleNextPage}
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
              <div className="h37-usage-detail-note">
                TPS 口径：输出 tokens / 首语义输出至结束的秒数。总览统计含所有筛选后记录，热力图仅显示近 12 周。
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
