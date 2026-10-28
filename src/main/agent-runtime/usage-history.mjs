/**
 * 使用记录页投影：把运行事实库（run-journal）里逐 HTTP attempt 的请求事实，
 * 投影为全局跨会话历史（preload 窗口 hemi.getUsageHistory；契约见 src/shared/usage-history.ts）。
 * 纯函数：不触网络、配置与会话档案；IPC 侧（conversation.ipc）与 core 只做装配。
 *
 * 口径：
 * - 每个 HTTP attempt 一行（重试/回退不合并）；token 用量只由末位 attempt 承担
 *   （usage-ledger 落盘即如此），token 统计因此不双计；失败与零 token 请求保留。
 * - status：无 endedAt 时，有 interruptionReason（进程重启残留）归 error 并带原因——不是在途，
 *   页面不得误判为进行中；否则 running（真在途，不猜测终态）。有 endedAt 时：
 *   有 error/failure 或 httpStatus>=400 = error；否则 success。
 * - url 落盘前已脱敏（sanitizedUrl：协议+主机+路径）；投影侧再过一遍（幂等，防旧记录）；
 *   旧记录无该字段 → null。
 * - error 落盘与投影均经 sanitizeErrorText：SDK/transport 错误文本可能内嵌完整请求 URL，
 *   其 userinfo/query 可能带凭据或会话标识，一律剥离。
 * - ttftMs = firstOutputAt − startedAt。firstOutputAt 是 SDK 归一化流中首个携带
 *   可见内容的模型输出事件（非空 delta 或 toolcall_end），不含响应头与空事件。
 * - tps = output / ((endedAt − firstOutputAt)/1000)，生成窗口口径（不含排队与 TTFT）；
 *   缺首输出时间或窗口非正 → null。
 * - reasoning 是 provider 明确报告的输出 token 子集；未报告（undefined）→ null，不当作 0；
 *   tokens 整体未知时各 token 字段为 null，不伪 0。
 * - 旧字段（url/protocol/thinkingLevel/httpStatus/firstOutputAt）缺记录一律 null。
 */

/** URL 落盘前脱敏：只保留协议+主机+路径；userinfo/query/hash 可能携带 Key 或会话标识，一律去除。解析失败（非绝对 URL）返回 null，不保存原文。 */
export function sanitizedUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  return `${parsed.origin}${parsed.pathname}`;
}

/** 错误文本脱敏：剥 URL 的 userinfo（user:pass@）与 query/hash；path 中的 @ 不受影响。非字符串返回 null。 */
export function sanitizeErrorText(text) {
  if (typeof text !== 'string' || !text) return null;
  return text
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//')
    .replace(/([a-z][a-z0-9+.-]*:\/\/\S*?)\?\S*/gi, '$1')
    .replace(/([a-z][a-z0-9+.-]*:\/\/\S*?)#\S*/gi, '$1');
}

/** journal 记录里缺失＝未知的 token 字段保持 null（不伪 0）；provider 报 0 是明确的 0。 */
const tokenOf = (row, key) => {
  const value = row.tokenUsage?.[key];
  return value === undefined || value === null ? null : Number(value) || 0;
};

/** journal 单条请求事实 → UsageHistoryRecord。 */
export function projectUsageRecord(row = {}) {
  const startedAt = typeof row.startedAt === 'number' ? row.startedAt : null;
  const endedAt = typeof row.endedAt === 'number' ? row.endedAt : null;
  const firstOutputAt = typeof row.firstOutputAt === 'number' ? row.firstOutputAt : null;
  const interrupted = typeof row.interruptionReason === 'string' && row.interruptionReason ? row.interruptionReason : null;
  const output = tokenOf(row, 'output');
  const generationMs = firstOutputAt !== null && endedAt !== null ? endedAt - firstOutputAt : null;
  return {
    id: row.requestId ?? null,
    conversationId: row.owner?.conversationId ?? null,
    at: startedAt,
    endedAt,
    url: sanitizedUrl(row.url), // 落盘前已脱敏，此处幂等复核（防旧记录/外部数据）。
    model: row.actualModel?.model ?? null,
    protocol: row.actualModel?.api ?? null,
    thinkingLevel: row.actualModel?.thinkingLevel ?? null,
    role: row.role ?? null,
    purpose: row.purpose ?? null,
    status: endedAt === null ? (interrupted ? 'error' : 'running')
      : row.error || row.failure || (typeof row.httpStatus === 'number' && row.httpStatus >= 400) ? 'error' : 'success',
    httpStatus: typeof row.httpStatus === 'number' ? row.httpStatus : null,
    ttftMs: firstOutputAt !== null && startedAt !== null ? Math.max(0, firstOutputAt - startedAt) : null,
    durationMs: startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null,
    tps: output !== null && generationMs !== null && generationMs > 0
      ? Math.round(output / (generationMs / 1000) * 100) / 100 : null,
    input: tokenOf(row, 'uncachedInput'),
    output,
    cacheRead: tokenOf(row, 'cacheRead'),
    cacheWrite: tokenOf(row, 'cacheWrite'),
    reasoning: tokenOf(row, 'reasoning'),
    error: sanitizeErrorText((typeof row.error === 'string' && row.error) || row.failure?.message || interrupted),
  };
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const STATUSES = new Set(['success', 'error', 'running']);
const emptyBucket = date => ({ date, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const addRecord = (bucket, record) => {
  bucket.requests += 1;
  bucket.input += record.input ?? 0;
  bucket.output += record.output ?? 0;
  bucket.cacheRead += record.cacheRead ?? 0;
  bucket.cacheWrite += record.cacheWrite ?? 0;
};

/** 本地时区 YYYY-MM-DD（按用户日历日分桶）。 */
const localDate = ms => {
  const at = new Date(ms);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
};

/** query 不区分大小写子串匹配：模型、URL、协议、用途、角色、错误与会话 ID。 */
const matchesQuery = (record, needle) => [record.model, record.url, record.protocol, record.purpose, record.role, record.error, record.conversationId]
  .some(value => typeof value === 'string' && value.toLowerCase().includes(needle));

/**
 * 全量 journal 快照 → 使用记录页。from/to（毫秒，含端点，按请求开始时间）、
 * query、status 参与筛选并同时影响 total/daily/totals/earliestAt；limit/offset 只切 records。
 */
export function projectUsageHistory(state, options = {}) {
  const { from, to, query, status = 'all', limit = DEFAULT_LIMIT, offset = 0 } = options ?? {};
  const fromMs = Number.isFinite(from) ? from : null;
  const toMs = Number.isFinite(to) ? to : null;
  const statusFilter = STATUSES.has(status) ? status : null;
  const needle = typeof query === 'string' && query.trim() ? query.trim().toLowerCase() : null;
  const filtered = [];
  for (const row of Object.values(state?.requests ?? {})) {
    const record = projectUsageRecord(row);
    if (record.at === null) continue; // requestStart 保证 startedAt；缺它是损坏行，跳过而不是崩面板。
    if (fromMs !== null && record.at < fromMs) continue;
    if (toMs !== null && record.at > toMs) continue;
    if (statusFilter && record.status !== statusFilter) continue;
    if (needle && !matchesQuery(record, needle)) continue;
    filtered.push(record);
  }
  filtered.sort((a, b) => (b.at - a.at) || String(a.id).localeCompare(String(b.id)));
  const totals = { requests: filtered.length, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const daily = new Map();
  let earliestAt = null;
  for (const record of filtered) {
    totals.input += record.input ?? 0;
    totals.output += record.output ?? 0;
    totals.cacheRead += record.cacheRead ?? 0;
    totals.cacheWrite += record.cacheWrite ?? 0;
    const date = localDate(record.at);
    const bucket = daily.get(date) ?? emptyBucket(date);
    addRecord(bucket, record);
    daily.set(date, bucket);
    if (earliestAt === null || record.at < earliestAt) earliestAt = record.at;
  }
  const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
  const size = Math.min(MAX_LIMIT, Number.isSafeInteger(limit) && limit >= 0 ? limit : DEFAULT_LIMIT);
  return {
    records: filtered.slice(start, start + size),
    total: filtered.length,
    daily: [...daily.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    totals,
    earliestAt,
  };
}
