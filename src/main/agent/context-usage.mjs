/**
 * 上下文容量：主 agent 会话的当前占用快照（输入框旁环形指示器的数据源）。
 *
 * 总量与百分比来自 Pi 会话的 getContextUsage()（以最后一次模型回复的 usage 为
 * 锚点，锚点后按条目估算，压缩后未确认时 tokens/percent 为 null）；分类明细
 * 只有请求体级别的字符估算（系统提示词／系统工具／对话消息／工具结果），
 * 按已知总量等比缩放——所以分类只看比例，不承诺绝对值精确。
 * 快照纯函数可离线单测；接线在 main-agent（before_provider_request 暂存分类）。
 */

/** 与 Pi estimateTokens 同口径的字符折算（约 4 字符＝1 token）。 */
function charsOf(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  try { return JSON.stringify(value).length; } catch { return 0; }
}
const tokensOf = (value) => Math.ceil(charsOf(value) / 4);

/**
 * 按请求参数估算分类占用。payload 是 before_provider_request 事件里的线格式
 * 参数（两种方言都收）：system 可为数组或字符串、tools 为 schema 数组、
 * 工具结果在 anthropic 方言是 user 消息里的 tool_result 块，openai 方言是
 * role=tool 消息。估算为零（空参数）返回 null，不写零。
 */
export function breakdownOfRequestParams(payload) {
  const messages = payload?.messages;
  if (!Array.isArray(messages)) return null;
  let system = tokensOf(payload.system);
  let tools = tokensOf(payload.tools);
  let conversation = 0;
  let toolResults = 0;
  for (const message of messages) {
    if (!message) continue;
    if (message.role === 'system') { system += tokensOf(message.content); continue; }
    if (message.role === 'tool') { toolResults += tokensOf(message.content); continue; }
    const blocks = Array.isArray(message.content) ? message.content : null;
    const isToolResult = message.role === 'user' && blocks?.length > 0
      && blocks.every((block) => block?.type === 'tool_result');
    if (isToolResult) toolResults += tokensOf(message.content);
    else conversation += tokensOf(message.content);
  }
  const estimated = system + tools + conversation + toolResults;
  if (estimated <= 0) return null;
  return { system, tools, conversation, toolResults, estimated };
}

/** 面板类目（固定顺序展示；key 与 breakdown 字段同名）。 */
export const CONTEXT_CATEGORIES = [
  { key: 'tools', label: '系统工具' },
  { key: 'conversation', label: '对话消息' },
  { key: 'toolResults', label: '工具结果' },
  { key: 'system', label: '系统提示词' },
];

const round1 = (value) => Math.round(value * 10) / 10;

/**
 * 组快照：usage＝session.getContextUsage()，breakdown＝最近一次请求的估算。
 * - usage 缺失（无模型或窗口未知）→ null（不显示）。
 * - usage.tokens 为 null（压缩后未确认）→ unknownReason: 'compaction'，
 *   环形显示未知态，等待下一轮回复恢复。
 * - breakdown 缺失（本进程还没发过请求）→ 只给总量，类目留空。
 */
export function buildContextSnapshot({ usage, breakdown }) {
  if (!usage || !(Number(usage.contextWindow) > 0)) return null;
  const contextWindow = Math.round(Number(usage.contextWindow));
  // 注意 Number(null)===0：必须先判空，压缩后的 null 是「未知」不是「零占用」。
  if (usage.tokens == null || !Number.isFinite(Number(usage.tokens))) {
    return { tokens: null, contextWindow, percent: null, categories: [], unknownReason: 'compaction' };
  }
  const tokens = Math.max(0, Math.round(Number(usage.tokens)));
  const percent = round1((tokens / contextWindow) * 100);
  let categories = [];
  if (breakdown && breakdown.estimated > 0) {
    const scale = tokens / breakdown.estimated;
    categories = CONTEXT_CATEGORIES.map((category) => ({
      key: category.key,
      label: category.label,
      tokens: Math.round(breakdown[category.key] * scale),
      percent: round1((breakdown[category.key] / breakdown.estimated) * 100),
    }));
  }
  return { tokens, contextWindow, percent, categories };
}
