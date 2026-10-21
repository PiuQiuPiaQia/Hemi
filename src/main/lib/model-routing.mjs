import { modelBaseUrl, piApiOf } from './pi-model.mjs';

// 038：产品候选身份与备用限制。可重试故障分类／重试由 SDK 原生循环负责。
// 唯一生产路由位于 agent/pi-factory.mjs，不再维护独立的轻量备用循环。
//
// specs 故障边界（2026-10-03 用户裁决）：
//   可切——连接失败、请求超时（非用户取消）、明确的临时限流、5xx/容量暂不可用；
//   不切——缺配置、鉴权/型号/参数错误、配额耗尽、用户取消、上下文超限、
//         工具失败、审批拒绝、输出已开始、完成状态 unknown；未知错误保守不切。

/** 会话选择的保留值（物理 modelKey 必含「/」，不会与之冲突）。 */
export const AUTO_SELECTION_ID = 'auto';

/**
 * 相同端点＋型号视为同一候选（Key 不同但端点相同也算同候选——切过去没有意义）；
 * 不同端点的同名模型是不同候选。重复候选不作为备用尝试（specs AC-04）。
 */
export function isSameCandidate(a, b) {
  if (!a || !b) return false;
  return piApiOf(a.api) === piApiOf(b.api)
    && modelBaseUrl(a.baseUrl, a.api) === modelBaseUrl(b.baseUrl, b.api)
    && String(a.model ?? '') === String(b.model ?? '');
}

/**
 * Pi route(retry) 闭包的终止原因判定（故障可重试性由
 * SDK retry 场景保证，只看状态位）。无备用≠备用预算耗尽——「budget-used」字样会
 * 进用户可见的 outcomeReason，没配备用时必须如实说 no-fallback（2026-10-08 会话
 * 审计：glm 无备用连接错误三次被记成 budget-used，语义完全失真）。
 * @returns {string|null} null＝允许切备用
 */
export function routeStopReason({
  hasFallback,
  fallbackUsed,
  outputStarted = false,
  requireVision = false,
  fallbackSupportsVision = false,
  fallbackDuplicate = false,
}) {
  if (!hasFallback) return 'no-fallback';
  if (fallbackUsed) return 'budget-used';
  if (outputStarted) return 'output-started';
  if (requireVision && !fallbackSupportsVision) return 'vision-missing';
  if (fallbackDuplicate) return 'duplicate-candidate';
  return null;
}

/** 路由拒绝恢复时的终止错误类型（适配器保留原失败原因后按既有失败路径收口）。 */
export class RoutingStoppedError extends Error {
  constructor(reason, originalMessage) {
    super(`HEMI_ROUTING_STOPPED: ${reason}${originalMessage ? `（${originalMessage}）` : ''}`);
    this.name = 'RoutingStoppedError';
    this.reason = reason;
  }
}

const ROUTE_STOP_TEXT = {
  'output-started': '模型在输出过程中中断。本轮未切换备用模型，已生成的内容已保留',
  'no-fallback': '当前模型请求失败，本轮未切换模型',
  'fallback-exhausted': '已尝试本轮可用的备用模型，仍未成功',
  'budget-used': '模型请求失败，本轮允许的备用尝试已用完',
  'vision-missing': '模型请求失败，下一备用模型不支持本轮图片，无法切换',
  'duplicate-candidate': '模型请求失败，下一备用模型与当前模型相同，无法切换',
  '身份／权限或运行上限错误，不切备用': '模型身份、权限或运行上限检查未通过，本轮未切换备用模型',
};

/**
 * 把会进对话气泡／任务卡的模型层错误翻成用户看得懂的话。只认 RoutingStoppedError 的
 * 内部码（10-19 实录：「回合未完成：HEMI_ROUTING_STOPPED: output-started（terminated）」原样
 * 上屏，用户看不懂、1h45m 后原样重发才得到回答）；原失败信息保留在括号里，日志与审计
 * 仍对得上。认不出的原样返回。
 */
export function describeModelError(raw) {
  const text = String(raw instanceof Error ? raw.message : raw ?? '').trim();
  const match = /^(?:Error:\s*)?HEMI_ROUTING_STOPPED:\s*(.+?)\s*(?:（(.*)）)?$/s.exec(text);
  if (!match) return text;
  const reason = match[1].trim();
  const original = (match[2] ?? '').trim();
  const human = Object.hasOwn(ROUTE_STOP_TEXT, reason) ? ROUTE_STOP_TEXT[reason] : null;
  if (!human) return text;
  return original ? `${human}（底层报错：${original}）` : human;
}
