/**
 * 「继续」受限转换白名单（goal-resume）：仅当最终定稿文本 trim 后与白名单
 * 精确全等，且目标投影 resumable、flow 停在 idle 时，才把这条输入改发
 * goal-resume 命令；其余任何文本（含「继续，但是换个思路」这类包含式近似）
 * 一律走普通文本回合。匹配必须是全等，不做包含/前缀判断。
 */
export const GOAL_RESUME_PHRASES = ['继续', '继续任务', '继续上次任务', '接着做', '接着干'] as const;

/** 精确匹配（trim 后全等）；空白差异可容忍，语义差异不可。 */
export function isGoalResumePhrase(text: string): boolean {
  return (GOAL_RESUME_PHRASES as readonly string[]).includes(text.trim());
}
