import { useFlowClock, useFlowAction } from "../host/context.js";
import { ChevronRight, Clock3, Terminal } from "lucide-react";
import type { RunActivityView } from "../types/presentation.js";
import { normalizeCommandDescription } from "../presentation/command-display.js";

const PHASE_TITLES: Partial<Record<RunActivityView["phase"], string>> = {
  compacting: "正在压缩上下文",
  verifying: "正在检查完成情况",
  continuing: "继续处理剩余工作",
  "waiting-subagents": "等待子任务完成",
  finishing: "正在收尾",
};

export function RunActivity({
  activity,
  readOnly = false,
}: {
  activity?: RunActivityView | null;
  readOnly?: boolean;
}) {
  const now = useFlowClock();
  const { perform, busy, error, actionable } = useFlowAction();
  if (!activity) return null;
  const phaseTitle = PHASE_TITLES[activity.phase];
  if (!phaseTitle && !activity.jobs.length && !activity.resources.length && activity.phase !== "waiting-background") return null;

  const waiting = activity.phase !== "running";
  const resource = activity.resources[0];
  const interactive = resource?.resource.scope === "desktop"
    || resource?.resource.scope.startsWith("browser:");
  const singleJob = !phaseTitle && activity.phase !== "waiting-resource" && activity.jobs.length === 1
    ? activity.jobs[0] : null;
  const quiet = activity.jobs.length > 0 && activity.jobs.every(job => job.endedAt == null
    && now - (job.lastOutputAt ?? job.startedAt) >= 30_000);
  const title = phaseTitle ?? (activity.phase === "waiting-resource"
    ? interactive ? "等待桌面或浏览器" : "等待工作区资源"
    : singleJob ? normalizeCommandDescription(singleJob.description) || "后台任务"
      : activity.jobs.length ? `${activity.jobs.length} 个后台任务` : "等待后台任务完成");
  const status = phaseTitle || activity.phase === "waiting-resource" ? null
    : quiet ? "暂无新输出" : waiting ? "等待结果" : "执行中";
  const header = <>
    {waiting ? <Clock3 aria-hidden="true" /> : <Terminal aria-hidden="true" />}
    <span className="h56-run-activity-title" role="status" aria-atomic="true">{title}</span>
    {status ? <span className="h56-run-activity-status">{status}</span> : null}
  </>;

  return (
    <section className="h56-run-activity" data-phase={activity.phase} aria-label="当前任务状态">
      {activity.jobs.length ? (
        <details className="h56-run-activity-disclosure">
          <summary className="h56-run-activity-head" aria-label={`查看最近输出：${title}`}>
            {header}
            <ChevronRight className="h56-run-activity-chevron" aria-hidden="true" />
          </summary>
          <div className="h56-run-activity-body" aria-label="最近输出与任务控制">
            {error ? <p role="alert">{error}</p> : null}
            {activity.jobs.map(job => {
              const description = normalizeCommandDescription(job.description) || "后台任务";
              return (
                <div className="h56-background-job" key={job.id}>
                  <div className="h56-background-job-head">
                    <span className="h56-background-job-description">{singleJob ? "最近输出" : description}</span>
                    {activity.runId && actionable && !readOnly ? (
                      <button type="button" className="h56-command-action"
                        aria-label={`停止此命令：${description}`} disabled={busy || job.endedAt != null}
                        onClick={() => void perform({type:"background.command",targetId:activity.runId!,action:"stop",jobId:job.id})}>
                        停止
                      </button>
                    ) : null}
                  </div>
                  <pre className="selectable" aria-label="后台命令最近输出">{job.output || "暂无输出。"}</pre>
                </div>
              );
            })}
          </div>
        </details>
      ) : <div className="h56-run-activity-head">{header}</div>}
    </section>
  );
}
