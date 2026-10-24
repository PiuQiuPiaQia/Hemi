/**
 * 上下文容量：输入框工具行里的环形占用指示器，悬浮展开容量面板（InfoPopover
 * openOnHover：200ms 进／140ms 出，键盘聚焦可开，Esc 关，点击不钉住）。
 * 数据：主进程轮末广播 context-usage:changed → page 重取快照（总量 usage 锚点、
 * 分类为请求字符估算；口径见 src/main/agent/context-usage.mjs）。
 */
import { useState } from 'react';
import { InfoPopover } from '@hemi/ui';

export type ContextUsageCategory = {
    key: 'tools' | 'conversation' | 'toolResults' | 'system';
    label: string;
    tokens: number;
    percent: number;
};

export type ContextUsageSnapshot = {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
    categories: ContextUsageCategory[];
    /** 压缩后未确认：等待下一轮模型回复恢复读数。 */
    unknownReason?: 'compaction';
};

/** 万位展示（5.1万／100万），尾零抹掉。 */
export function formatContextTokens(value: number): string {
    if (value >= 10000) {
        const wan = Math.round(value / 1000) / 10;
        return `${wan.toString().replace(/\.0$/, '')}万`;
    }
    return String(Math.round(value));
}

function formatPercent(value: number): string {
    return `${(Math.round(value * 10) / 10).toString().replace(/\.0$/, '')}%`;
}

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ringLevel(percent: number | null): 'ok' | 'warn' | 'full' | 'unknown' {
    if (percent == null || !Number.isFinite(percent)) return 'unknown';
    if (percent >= 90) return 'full';
    if (percent >= 70) return 'warn';
    return 'ok';
}

export function ContextCapacityChip({ snapshot, fixtureOpen = false }: {
    snapshot: ContextUsageSnapshot | null;
    /** fixtures 用：初始即展开面板（静态截图取证）。 */
    fixtureOpen?: boolean;
}) {
    const [open, setOpen] = useState(Boolean(fixtureOpen));
    // 空态（快照都没有＝新建会话还没聊过）也常驻显示：环形只留轨道，面板说明待计量。
    // 压缩后的未知态（有快照但 tokens null）走「待下轮确认」，两者不混。
    const empty = !snapshot;
    const known = !empty && snapshot.tokens != null && snapshot.percent != null;
    const percent = known ? Math.min(100, Math.max(0, snapshot.percent as number)) : 0;
    const level = ringLevel(known ? (snapshot.percent as number) : null);
    // 无数据（空态/压缩后未确认）弧线不画（dashoffset 拉满），只留轨道——不假装有数。
    const dashoffset = known ? RING_CIRCUMFERENCE * (1 - percent / 100) : RING_CIRCUMFERENCE;
    // 只展示已用量：上限（自动压缩兜底＋中转模型窗口数不可靠）和它派生的百分比都不进文案；
    // 环形填充仍按窗口比例作相对刻度，但面板数字全部真实可对账。
    const totalText = empty ? '待计量' : known ? formatContextTokens(snapshot.tokens as number) : '待下轮确认';
    return (
        <InfoPopover
            openOnHover
            open={open}
            onOpenChange={setOpen}
            title="上下文容量"
            headerActions={<span className="ctx-cap-total">{totalText}</span>}
            className="ctx-cap-pop"
            trigger={(
                <button
                    type="button"
                    className="h37-tool ctx-cap-trigger"
                    aria-label={known ? `上下文容量 ${formatContextTokens(snapshot.tokens as number)}，悬浮查看明细` : '上下文容量还没有用量数据，悬浮查看说明'}
                >
                    <svg className="ctx-cap-ring" data-level={level} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                        <circle className="ctx-cap-track" cx="8" cy="8" r={RING_RADIUS} fill="none" strokeWidth="2" />
                        <circle
                            className="ctx-cap-arc"
                            cx="8"
                            cy="8"
                            r={RING_RADIUS}
                            fill="none"
                            strokeWidth="2"
                            strokeDasharray={RING_CIRCUMFERENCE}
                            strokeDashoffset={dashoffset}
                            strokeLinecap="round"
                        />
                    </svg>
                </button>
            )}
        >
            <div className="ctx-cap-list">
                {snapshot?.categories?.length ? (
                    <ul className="ctx-cap-cats">
                        {snapshot.categories.map((category) => (
                            <li key={category.key} className="ctx-cap-cat">
                                <i className={`ctx-cap-dot ctx-cap-dot-${category.key}`} aria-hidden="true" />
                                <span className="ctx-cap-cat-label">{category.label}</span>
                                <span className="ctx-cap-cat-pct">{formatPercent(category.percent)}</span>
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>
        </InfoPopover>
    );
}
