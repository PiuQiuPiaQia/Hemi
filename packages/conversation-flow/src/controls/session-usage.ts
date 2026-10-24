/**
 * 048 D7：会话用量聚合（纯函数，面板与入口共用；口径见候选稿 DESIGN.md）。
 *
 * 输入＝Σ(input＋cacheRead＋cacheWrite)；输出＝Σoutput（含思考）；
 * TPS＝Σoutput ÷ Σ(genMs/1000)；缓存命中＝ΣcacheRead ÷ 输入。
 * 来源两桶：对话（chat/fallback/summary/title）与任务执行（task）。
 * 「全部」视图按模型合并两桶（同名同键合并、来源标注两侧）；筛选视图各算各的。
 */
import type { UsageRecord } from './usage-types.js';
export type UsageSourceFilter = 'all' | 'chat' | 'task';
export type UsageModelRow = {
    modelKey: string;
    modelName: string;
    /** 纯展示名：有供应商名用「供应商 · 型号」，否则型号。 */
    label: string;
    calls: number;
    missing: number;
    input: number;
    output: number;
    tps: number;
    cacheHit: number | null;
    totalTokens: number;
    sources: Array<'chat' | 'task'>;
};
export type UsageAggregate = {
    records: UsageRecord[];
    filter: UsageSourceFilter;
    totals: {
        input: number;
        output: number;
        tps: number;
        cacheHit: number | null;
        modelCount: number;
        calls: number;
        missing: number;
    };
    rows: UsageModelRow[];
    /** 全会话口径（不随筛选变化）：表头「N 个模型 · M 次调用」。 */
    overall: {
        modelCount: number;
        calls: number;
        missing: number;
    };
};
const isTaskSource = (source: string) => source === 'task';
function recordInput(record: UsageRecord): number {
    return record.input + record.cacheRead + record.cacheWrite;
}
/**
 * 紧凑格式：<1000 原样（250）；<100k 保留一位小数去掉「.0」（58.1k、2k）；
 * <1M 取整（123k）；≥1M 用 M（1.2M）。
 */
export function formatCompactTokens(value: number): string {
    const n = Math.max(0, Math.round(value));
    if (n < 1000)
        return String(n);
    if (n < 100000) {
        const k = n / 1000;
        const text = k >= 100 || Number.isInteger(k) ? String(Math.round(k)) : k.toFixed(1);
        return `${text}k`;
    }
    if (n < 1000000)
        return `${Math.round(n / 1000)}k`;
    const m = n / 1000000;
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`;
}
export function formatPercent(ratio: number | null): string {
    return ratio == null ? '—' : `${Math.round(ratio * 100)}%`;
}
function bucketOf(record: UsageRecord): 'chat' | 'task' {
    return isTaskSource(record.source) ? 'task' : 'chat';
}
export function aggregateUsage(records: UsageRecord[], filter: UsageSourceFilter = 'all'): UsageAggregate {
    const inFilter = (record: UsageRecord) => filter === 'all' ? true : bucketOf(record) === filter;
    let input = 0;
    let output = 0;
    let genMs = 0;
    let cacheRead = 0;
    let calls = 0;
    let missing = 0;
    let overallCalls = 0;
    let overallMissing = 0;
    const byModel = new Map<string, UsageModelRow & {
        genMs: number;
        cacheRead: number;
    }>();
    for (const record of Array.isArray(records) ? records : []) {
        const recordCalls = record.calls ?? 1;
        overallCalls += recordCalls;
        overallMissing += record.missing ?? 0;
        if (!inFilter(record))
            continue;
        calls += recordCalls;
        missing += record.missing ?? 0;
        input += recordInput(record);
        output += record.output;
        genMs += record.genMs;
        cacheRead += record.cacheRead;
        const key = record.modelKey || record.modelName || '未知模型';
        const bucket = bucketOf(record);
        const row = byModel.get(key) ?? {
            modelKey: record.modelKey,
            modelName: record.modelName,
            label: record.modelName && record.modelName !== (record.requestedModel || record.modelKey)
                ? `${record.modelName} · ${record.requestedModel || (key.includes('/') ? key.slice(key.indexOf('/') + 1) : key)}`
                : record.requestedModel || key,
            calls: 0,
            missing: 0,
            input: 0,
            output: 0,
            tps: 0,
            cacheHit: null,
            totalTokens: 0,
            sources: [] as Array<'chat' | 'task'>,
            genMs: 0,
            cacheRead: 0,
        };
        row.calls += record.calls ?? 1;
        row.missing += record.missing ?? 0;
        row.input += recordInput(record);
        row.output += record.output;
        row.genMs += record.genMs;
        row.cacheRead += record.cacheRead;
        if (!row.sources.includes(bucket))
            row.sources.push(bucket);
        byModel.set(key, row);
    }
    const rows = [...byModel.values()]
        .map((row) => ({
        ...row,
        tps: row.genMs > 0 ? row.output / (row.genMs / 1000) : 0,
        cacheHit: row.input > 0 ? row.cacheRead / row.input : null,
        totalTokens: row.input + row.output,
    }))
        .sort((a, b) => b.totalTokens - a.totalTokens);
    return {
        records: Array.isArray(records) ? records : [],
        filter,
        totals: {
            input,
            output,
            tps: genMs > 0 ? output / (genMs / 1000) : 0,
            cacheHit: input > 0 ? cacheRead / input : null,
            modelCount: rows.length,
            calls,
            missing,
        },
        rows,
        overall: {
            modelCount: new Set((Array.isArray(records) ? records : []).map((r) => r.modelKey || r.modelName)).size,
            calls: overallCalls,
            missing: overallMissing,
        },
    };
}
/** 入口文案的总量：输入＋输出（紧凑格式由调用侧处理）。 */
export function usageEntryTotals(records: UsageRecord[]): {
    totalTokens: number;
    cacheHit: number | null;
} | null {
    if (!Array.isArray(records) || !records.length)
        return null;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    for (const record of records) {
        input += recordInput(record);
        output += record.output;
        cacheRead += record.cacheRead;
    }
    return { totalTokens: input + output, cacheHit: input > 0 ? cacheRead / input : null };
}
/** 角色按职责合并；同一模型被多个角色使用时仍分行。旧账本放入「未分类」。 */
export function aggregateRoleUsage(records: UsageRecord[]) {
    const labels = { main: '主助手', explorer: '侦察', oracle: '顾问', fixer: '执行', designer: '设计', auxiliary: '辅助', unknown: '未分类' };
    type Role = keyof typeof labels;
    const groups = new Map<Role, UsageRecord[]>();
    for (const record of records) {
        const role: Role = record.role && Object.hasOwn(labels, record.role) ? record.role : 'unknown';
        const group = groups.get(role) ?? [];
        group.push(record);
        groups.set(role, group);
    }
    return {
        totals: aggregateUsage(records).totals,
        rows: (Object.keys(labels) as Role[]).filter(role => groups.has(role)).map(role => ({
            role, label: labels[role], ...aggregateUsage(groups.get(role)!).totals,
        })),
    };
}
