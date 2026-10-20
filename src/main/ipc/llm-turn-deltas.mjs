/**
 * 048 S2：对话轮增量事件的转发策略（纯函数，llm.ipc 的工具循环消费）。
 *
 * - 思考类事件（thinking_start/thinking/thinking_end）恒转发：思考不随工具
 *   轮缓冲（AC-05）——最慢的恰是工具轮，思考不朗读、不作正文落盘，缓冲无
 *   收益，实时反馈是它唯一的价值。
 * - 正文（text）仅在禁用工具的轮转发：016「落盘前不上屏」语义不变（带工具
 *   轮的正文可能被 execute_task 决策取代）。
 * - 其余 kind（restart 与未来新增类型）原样透传，主进程管道不解释——AC-08
 *   扩展性：新增返回内容类型只加渲染层消费端，这里零改动。
 *
 * 思考全文与时长的权威累计不走这里（事件可能丢帧）：以每轮 chatTurn 结果
 * 的 thinking/usageDetail 为准，在 llm.ipc 按轮合并。
 */

export function createTurnDeltaSink({ send, onFirstText = null } = {}) {
  let textAllowed = false;
  let firstTextNotified = false;

  return {
    /** 每个工具轮开始前声明该轮是否允许正文转发（收尾轮才允许）。 */
    beginRound({ toolsAllowed } = {}) {
      textAllowed = !toolsAllowed;
    },
    /** pi-chat 的 onEvent 事件（无 turnId——由 llm.ipc 的 send 补齐）。 */
    onEvent(event) {
      if (!event || typeof event.kind !== 'string') return;
      if (event.kind === 'text') {
        if (!textAllowed) return;
        if (!firstTextNotified) {
          firstTextNotified = true;
          onFirstText?.();
        }
        send(event);
        return;
      }
      // thinking_* / restart / 未知 kind：原样透传（渲染层忽略不认识的）。
      send(event);
    },
  };
}

/**
 * 048 D3：把各轮 chatTurn 结果的 thinking 合并为回合级思考（主进程权威）。
 * 多轮思考续接为同一思考块（轮间空行分隔），时长累加。
 */
export function mergeRoundThinking(rounds) {
  const parts = [];
  let durationMs = 0;
  for (const thinking of Array.isArray(rounds) ? rounds : []) {
    if (!thinking) continue;
    if (typeof thinking.text === 'string' && thinking.text) parts.push(thinking.text);
    durationMs += Number(thinking.durationMs) || 0;
  }
  const text = parts.join('\n\n');
  return text || durationMs ? { text, durationMs } : undefined;
}

/**
 * 048 D3：把各轮 chatTurn 结果的 usageDetail 合并为回合级用量（跨工具轮
 * 累加）。identity＝实际作答模型的键与名（自动路由切备用后为备用）。任一轮
 * 缺 usageDetail 时该轮不计入（pi-ai abort 不回 usage）。
 */
export function mergeRoundUsage(rounds, { modelKey, modelName, name, model }) {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let genMs = 0;
  let any = false;
  for (const detail of Array.isArray(rounds) ? rounds : []) {
    if (!detail) continue;
    any = true;
    input += Number(detail.input) || 0;
    output += Number(detail.output) || 0;
    cacheRead += Number(detail.cacheRead) || 0;
    cacheWrite += Number(detail.cacheWrite) || 0;
    genMs += Number(detail.genMs) || 0;
  }
  if (!any) return undefined;
  return {
    modelKey: String(modelKey ?? ''),
    modelName: String(modelName ?? name ?? ''),
    ...(model ? { requestedModel: String(model) } : {}),
    input,
    output,
    cacheRead,
    cacheWrite,
    genMs,
  };
}
