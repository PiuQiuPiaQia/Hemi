/** 会话时间的人类化文案（侧栏最近列表与历史弹窗共用同一口径）。 */
export function formatRelative(timestamp: number): string {
    if (!timestamp)
        return '—';
    const diff = Date.now() - timestamp;
    if (diff < 60000)
        return '刚刚';
    if (diff < 3600000)
        return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000)
        return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 172800000)
        return '昨天';
    return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(timestamp);
}
/**
 * 会话标题来源清理：语音定稿常带开头的语气词/填充词（「呃，今天天气…」），
 * 直接做标题很难看——摘掉开头的填充词与随后的顿号逗号再交给截断。
 */
export function cleanTitleSource(text: string): string {
    return text.replace(/^\s*(?:(?:呃|嗯|啊|哎|那个|就是说|然后|所以)[，,、.。\s]+)+/u, '');
}
/**
 * 026 侧栏可读性：已存档标题的展示层清理（不动存储）。存档标题派生自首条
 * 用户消息，常带 URL 或旧格式语气词——「下载 https://github.com/…」直接进
 * 侧栏既难看又挤占行宽。URL 收成「链接」，开头语气词摘掉，空白折叠；
 * 清理后为空回退原文，保证行不空。
 */
export function displayTitle(title: string): string {
    const cleaned = cleanTitleSource(String(title ?? ''))
        .replace(/https?:\/\/\S+/giu, '链接')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || String(title ?? '');
}
/** 侧栏按更新时间分组，组内保持传入顺序。更新时间的显示快照由列表管理。 */
export type RecencyGroupKey = 'today' | 'yesterday' | 'week' | 'earlier';
const RECENCY_LABEL: Record<RecencyGroupKey, string> = {
    today: '今天',
    yesterday: '昨天',
    week: '7 天内',
    earlier: '更早',
};
const GROUP_LABEL = { pinned: '置顶', ...RECENCY_LABEL };
type ConversationGroupKey = keyof typeof GROUP_LABEL;
export function recencyKey(timestamp: number, now = Date.now()): RecencyGroupKey {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const today = startOfToday.getTime();
    const day = 86400000;
    if (!timestamp)
        return 'earlier';
    if (timestamp >= today)
        return 'today';
    if (timestamp >= today - day)
        return 'yesterday';
    if (timestamp >= today - 6 * day)
        return 'week';
    return 'earlier';
}
export function groupByRecency<T extends {
    updatedAt: number;
    pinned?: boolean;
}>(sessions: T[], now = Date.now()): Array<{
    key: ConversationGroupKey;
    label: string;
    sessions: T[];
}> {
    const buckets = new Map<ConversationGroupKey, T[]>();
    for (const session of sessions) {
        const key = session.pinned === true ? 'pinned' : recencyKey(session.updatedAt, now);
        const bucket = buckets.get(key) ?? [];
        bucket.push(session);
        buckets.set(key, bucket);
    }
    return (Object.keys(GROUP_LABEL) as ConversationGroupKey[])
        .filter((key) => buckets.has(key))
        .map((key) => ({ key, label: GROUP_LABEL[key], sessions: buckets.get(key)! }));
}
/** 侧栏放全部置顶及最近更新的 limit 条普通会话，显示顺序沿用手动序。 */
export function pickRecent<T extends {
    id: string;
    updatedAt: number;
    pinned?: boolean;
}>(sessions: T[], limit: number): T[] {
    const keep = new Set([...sessions]
        .filter((session) => session.pinned !== true)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, limit)
        .map((session) => session.id));
    return sessions.filter((session) => session.pinned === true || keep.has(session.id));
}
/**
 * 组内拖拽 → 全量手动序：只在同组内挪动（跨组返回 null），挪完把组员按新顺序
 * 填回它们在全量序里原来占的位置——组外会话一个都不动。
 */
export function reorderWithinGroup(allIds: string[], groupIds: string[], activeId: string, overId: string): string[] | null {
    const from = groupIds.indexOf(activeId);
    const to = groupIds.indexOf(overId);
    if (from < 0 || to < 0 || from === to)
        return null;
    const moved = [...groupIds];
    moved.splice(to, 0, ...moved.splice(from, 1));
    const members = new Set(groupIds);
    let cursor = 0;
    return allIds.map((id) => (members.has(id) ? moved[cursor++] : id));
}
