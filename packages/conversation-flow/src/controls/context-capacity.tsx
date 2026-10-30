/**
 * 当前上下文：输入框下方信息行里、会话用量右侧的静态叠页入口，悬浮展开用量面板（InfoPopover
 * openOnHover：200ms 进／140ms 出，键盘聚焦可开，Esc 关，点击不钉住）。
 * 数据：主进程轮末广播 context-usage:changed → page 重取快照（总量 usage 锚点、
 * 分类为请求字符估算；口径见 src/main/agent/context-usage.mjs）。
 */
import { useState } from 'react';
import { Layers } from 'lucide-react';
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

export function ContextCapacityChip({ snapshot, fixtureOpen = false }: {
    snapshot: ContextUsageSnapshot | null;
    /** fixtures 用：初始即展开面板（静态截图取证）。 */
    fixtureOpen?: boolean;
}) {
    const [open, setOpen] = useState(Boolean(fixtureOpen));
    // 空态（快照都没有＝新建会话还没聊过）也常驻显示，面板说明待计量。
    // 压缩后的未知态（有快照但 tokens null）走「待下轮确认」，两者不混。
    const empty = !snapshot;
    const known = !empty && snapshot.tokens != null;
    // 自动整理支持持续对话；入口不表达容量进度或告警，只展示当前用量与内容组成。
    const totalText = empty ? '待计量' : known ? formatContextTokens(snapshot.tokens as number) : '待下轮确认';
    const label = empty ? '当前上下文尚未计量，悬浮查看说明'
        : known ? `当前上下文 ${totalText} token，悬浮查看明细`
        : '当前上下文整理后待下轮确认，悬浮查看说明';
    return (
        <InfoPopover
            openOnHover
            open={open}
            onOpenChange={setOpen}
            title="当前上下文"
            headerActions={<span className="ctx-cap-total">{totalText}</span>}
            className="ctx-cap-pop"
            trigger={(
                <button
                    type="button"
                    className="ctx-cap-trigger"
                    aria-label={label}
                >
                    <Layers className="ctx-cap-icon" size={12} aria-hidden="true" />
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
