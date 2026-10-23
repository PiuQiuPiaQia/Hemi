import { useFlowClock } from "../host/context.js";
import { useEffect, useState } from "react";
import { ChevronRight, Clock3, Terminal } from "lucide-react";
import type { RunActivityView } from "../types/presentation.js";
import { normalizeCommandDescription } from "../presentation/command-display.js";

const elapsed = (since: number, now: number) => {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
};

export function RunActivity({
  activity,
}: {
  activity?: RunActivityView | null;
}) {
  const now = useFlowClock();
  const visible = Boolean(
    activity && (activity.jobs.length || activity.resources.length),
  );
  if (!activity || !visible) return null;
  const waiting = activity.phase !== "running";
  const resource = activity.resources[0];
  const interactive =
    resource?.resource.scope === "desktop" ||
    resource?.resource.scope.startsWith("browser:");
  const blocker = resource?.blockers[0];
  const singleJob =
    activity.phase !== "waiting-resource" && activity.jobs.length === 1
      ? activity.jobs[0]
      : null;
  const title = singleJob
    ? normalizeCommandDescription(singleJob.description) || "后台命令"
    : activity.phase === "waiting-background"
      ? "等待后台结果"
      : activity.phase === "waiting-resource"
        ? interactive
          ? "等待桌面或浏览器"
          : "等待工作区资源"
        : "后台执行中";
  const timeLabel =
    activity.phase === "waiting-resource" && activity.since != null
      ? `已等待 ${elapsed(activity.since, now)}`
      : singleJob
        ? `已运行 ${elapsed(singleJob.startedAt, singleJob.endedAt ?? now)}`
        : activity.jobs.length > 1
          ? `${activity.jobs.length} 条命令`
          : null;
  const hint =
    activity.phase === "waiting-resource"
      ? interactive
        ? "另一个任务正在使用桌面或浏览器，交接后自动继续。"
        : `另一个操作正在占用此工作区${blocker?.description ? `：${blocker.description}` : ""}。释放后自动继续。`
      : waiting
        ? "完成后自动继续。"
        : "正在处理其他步骤，后台结果就绪后继续。";
  return (
    <section
      className="h56-run-activity"
      data-phase={activity.phase}
      aria-label="当前任务状态"
    >
      <details className="h56-run-activity-disclosure">
        <summary
          className="h56-run-activity-head"
          title={`${title}\n${hint}`}
          aria-label={`查看运行详情：${title}${timeLabel ? `，${timeLabel}` : ""}`}
        >
          {waiting ? (
            <Clock3 aria-hidden="true" />
          ) : (
            <Terminal aria-hidden="true" />
          )}
          <span className="h56-run-activity-title" role="status">
            {title}
          </span>
          {timeLabel ? (
            <span className="h56-run-activity-time">{timeLabel}</span>
          ) : null}
          <ChevronRight
            className="h56-run-activity-chevron"
            aria-hidden="true"
          />
        </summary>
        <div className="h56-run-activity-body" aria-label="运行详情">
          <p className="h56-run-activity-hint">{hint}</p>
          {activity.jobs.map((job) => {
            const description =
              normalizeCommandDescription(job.description) || "后台命令";
            return (
              <div className="h56-background-job" key={job.id}>
                <div className="h56-background-job-head">
                  <span className="h56-background-job-description">
                    {description}
                  </span>
                  {!singleJob ? (
                    <span className="h56-run-activity-time">
                      已运行 {elapsed(job.startedAt, job.endedAt ?? now)}
                    </span>
                  ) : null}
                </div>
                {job.lastOutputAt != null ? (
                  <p className="h56-background-output-time">
                    最近输出于 {elapsed(job.lastOutputAt, now)}前
                  </p>
                ) : null}
                <p>最近输出</p>
                <pre className="selectable" aria-label="后台命令最近输出">
                  {job.output || "尚无输出，正在等待命令返回。"}
                </pre>
                <p>
                  {job.commandTruncated ? "命令（显示前 8000 字符）" : "命令"}
                </p>
                <pre className="selectable" aria-label="后台命令">
                  {job.command}
                </pre>
              </div>
            );
          })}
        </div>
      </details>
    </section>
  );
}
