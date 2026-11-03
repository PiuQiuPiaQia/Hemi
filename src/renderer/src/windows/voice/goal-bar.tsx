import type { GoalSummaryView } from '@hemi/conversation-flow';

/**
 * 目标横幅（goal-resume）：对话区与输入区之间的一行——停下来的目标 objective
 * 截断展示＋「已停止 · 可恢复」＋唯一的「恢复」按钮，发 goal-resume 命令。
 *
 * 只在可恢复时渲染（2026-11-03 用户裁决）：目标正在跑时时间线上已有原话与进展，
 * 再挂一行「进行中」重复无信息量，只会让用户不知道这条是什么。恢复入口只在该
 * 出现时出现——停了、能接着干的时候。完成/无目标同样不渲染，不做倒计时/进度条。
 */
export function GoalBar({ goal, onResume }: {
  goal?: GoalSummaryView | null;
  onResume?: () => void;
}) {
  if (!goal?.resumable) return null;
  return (
    <div className="h24-goal-bar" role="status" data-resumable="true" data-goal-id={goal.goalId}>
      <span className="h24-goal-objective" title={goal.objective}>{goal.objective}</span>
      <span className="h24-goal-status">
        已停止 · 可恢复
        {goal.round > 1 ? ` · 第 ${goal.round} 轮` : ''}
      </span>
      {onResume ? (
        <button type="button" className="h24-goal-resume" onClick={onResume} title="从停止处恢复这个任务">
          恢复
        </button>
      ) : null}
    </div>
  );
}
