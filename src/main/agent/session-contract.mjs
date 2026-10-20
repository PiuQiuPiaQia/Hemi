/**
 * Agent 会话错误类型（023 起；056 起由 hemi-session 抛出）。
 *
 * code ∈
 *   'start-failed'   会话/扩展初始化失败（宿主归「没能启动」）
 *   'exited'         会话已结束或不可用
 *   'command-failed' 指令未被接受
 */
export class AgentSessionError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AgentSessionError';
    this.code = code;
  }
}
