import { useState, type CSSProperties } from 'react';
import { InfoPopover } from '@hemi/ui';
import type { UsageRecord } from './usage-types.js';
import { aggregateRoleUsage, aggregateUsage, formatCompactTokens, formatPercent } from './session-usage.js';
/** 输入框底部单行预览；弹窗直接展示整体与各角色数据。 */
export function SessionUsage({ records, running, loadError = '', initialOpen = false }: {
    records: UsageRecord[];
    running: boolean;
    loadError?: string;
    /** fixtures 验收用。 */
    initialOpen?: boolean;
}) {
    const [open, setOpen] = useState(initialOpen);
    const [dimension, setDimension] = useState<'role' | 'model'>('role');
    const byRole = dimension === 'role';
    const roleView = aggregateRoleUsage(records);
    const modelView = aggregateUsage(records);
    const view = byRole ? roleView : modelView;
    // 共用可见行容量，切换不移动悬浮面板的顶部控件；更多模型在表内滚动。
    const visibleRows = Math.max(roleView.rows.length, Math.min(modelView.rows.length, 5));
    const total = view.totals;
    const unknown = total.calls > 0 && total.missing >= total.calls;
    const speed = (tps: number) => tps > 0 ? `${Math.round(tps)} token/s` : '—';
    const missingLabel = (missing: number) => missing ? `${missing} 次调用未返回用量` : undefined;
    if (!records.length && !loadError)
        return null;
    return (<div className="h48-usage">
      <InfoPopover openOnHover open={open} onOpenChange={setOpen} title="本会话用量" description={`${total.calls.toLocaleString('zh-CN')} 次调用`} headerActions={records.length ? (<div className="h48-usage-switch" role="group" aria-label="用量统计维度">
            <button type="button" aria-pressed={byRole} onClick={() => setDimension('role')}>角色</button>
            <button type="button" aria-pressed={!byRole} onClick={() => setDimension('model')}>模型</button>
          </div>) : null} className="h48-usage-panel" trigger={(<button type="button" className="h48-usage-entry" aria-label={`查看本会话用量，缓存命中 ${formatPercent(total.cacheHit)}，生成速度 ${speed(total.tps)}${running ? '，调用完成后更新' : ''}`}>
            {running ? <span className="h48-usage-dot" aria-hidden="true"/> : null}
            {loadError && !records.length ? <span>用量暂不可用</span> : unknown ? <span>用量暂未返回</span> : (<>
                <span className="h48-usage-volume">{formatCompactTokens(total.input + total.output)} tokens<span className="h48-usage-sep">·</span></span>
                <span>缓存命中 {formatPercent(total.cacheHit)}</span>
                <span className="h48-usage-sep">·</span>
                <span>{speed(total.tps)}</span>
              </>)}
          </button>)}>
        {loadError ? <p className="h48-usage-error" role="status">用量加载失败，请稍后重新打开。</p> : null}
        {records.length ? (<>
            <div className="h48-usage-totals" aria-label="整体用量" title={missingLabel(total.missing)}>
              <div className="h48-usage-total"><span>输入</span><b>{unknown ? '—' : formatCompactTokens(total.input)}</b></div>
              <div className="h48-usage-total"><span>输出</span><b>{unknown ? '—' : formatCompactTokens(total.output)}</b></div>
              <div className="h48-usage-total"><span>速度</span><b>{unknown ? '—' : speed(total.tps)}</b></div>
              <div className="h48-usage-total h48-usage-cache"><span>缓存</span><b>{formatPercent(total.cacheHit)}</b></div>
            </div>
            <div className="h48-usage-detail" style={{ '--usage-visible-rows': visibleRows } as CSSProperties}>
              <table className="h48-usage-table" data-dimension={dimension} aria-label={byRole ? '各角色用量' : '各模型用量'}>
              <thead>
                <tr><th scope="col">{byRole ? '角色' : '模型'}</th><th scope="col">调用</th><th scope="col">输入</th><th scope="col">输出</th><th scope="col" title="token/s">速度</th><th scope="col">缓存</th></tr>
              </thead>
              <tbody>
                {view.rows.map(row => {
                const missing = row.missing >= row.calls;
                return (<tr key={'role' in row ? row.role : row.modelKey || row.modelName || '未知模型'} title={missingLabel(row.missing)}>
                      <th scope="row"><span className="h48-usage-name" title={row.label}>{row.label}</span></th>
                      <td>{row.calls.toLocaleString('zh-CN')}</td>
                      <td>{missing ? '—' : formatCompactTokens(row.input)}</td>
                      <td>{missing ? '—' : formatCompactTokens(row.output)}</td>
                      <td>{row.tps > 0 ? Math.round(row.tps) : '—'}</td>
                      <td data-high-hit={row.cacheHit != null && row.cacheHit >= .9 || undefined}>{formatPercent(row.cacheHit)}</td>
                    </tr>);
            })}
              </tbody>
              </table>
            </div>
          </>) : null}
      </InfoPopover>
    </div>);
}
