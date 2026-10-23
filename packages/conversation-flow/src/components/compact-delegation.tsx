import { useRunningClock } from "../shared/use-running-clock.js";
import { Check, Square, X } from "lucide-react";

import type {
  TaskActionName,
  TaskOutcome,
  TaskStateSnapshot,
} from "../types/presentation.js";

/**
 * 056 · 子 agent 在对话流里的形态（2026-10-15 用户裁决改版）：一行「角色 · 派单说明」，
 * 点击整行直接在右侧第三栏打开该子 agent 的执行过程（预览 Tab 队列里的一页，与文件
 * 预览同宿主，多个角色可各开一页切换）；不再在行内展开步骤。运行中带状态（已运行
 * 12s／✓ 用时 7s／失败原因）与一个轻量「停止」。授权等待不在这里出现——确认卡照旧
 * 在输入区上方统一排队。
 * 057 AC-28：主动停止是用户动作不是执行失败——已停止不再共用失败红叉（Square＋
 * data-state=stopped），文案与过程页 stateLabelOf 同一份词汇表。
 */
export const DELEGATION_OUTCOME_TEXT: Partial<Record<TaskOutcome, string>> = {
  stopped: "已停止",
  denied: "未获授权",
  blocked: "已阻止",
  partial: "部分完成",
  unknown: "结果待核实",
  startfailed: "未能启动",
  reportfailed: "总结失败",
};

function formatSeconds(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function CompactDelegation({
  snap,
  onOpenProcess,
  onAction,
  nowTick,
}: {
  snap: TaskStateSnapshot;
  /** 点击整行：打开该任务/子 agent 的执行过程（右侧预览 Tab）。 */
  onOpenProcess?: () => void;
  onAction?: (
    action: TaskActionName,
    payload?: { taskId?: string; taskKey?: string },
  ) => void;
  /** 056 审查：共享的 1s 节拍（多个运行中任务共用一个定时器）。 */
  nowTick?: number;
}) {
  const running = snap.phase !== "terminal";
  const clock = useRunningClock(running && nowTick == null);
  const now = nowTick ?? clock;
  const role = [snap.agentTitle, snap.agent].filter(Boolean).join(" ");
  const title = snap.taskText || "（没有说明）";
  // 合法旧档/最小快照可缺 log（AC-39：缺可选字段不使整页崩溃）。
  const startedAt = snap.startedAt ?? snap.log?.[0]?.at ?? null;
  const endedAt = snap.endedAt ?? snap.log?.[snap.log.length - 1]?.at ?? null;
  const stopped = !running && snap.outcome === "stopped";
  const failed =
    !running && snap.outcome && snap.outcome !== "complete" && !stopped;
  const meta = running
    ? snap.phase === "waiting"
      ? snap.permission
        ? "等你确认"
        : snap.progressText || "等待执行"
      : snap.phase === "stopping"
        ? "停止中"
        : startedAt
          ? `已运行 ${formatSeconds(now - startedAt)}`
          : ""
    : failed || stopped
      ? snap.outcomeReason ||
        DELEGATION_OUTCOME_TEXT[snap.outcome as TaskOutcome] ||
        "没有完成"
      : startedAt && endedAt && endedAt > startedAt
        ? `用时 ${formatSeconds(endedAt - startedAt)}`
        : "";
  return (
    <div
      className="h56-tools h56-delegation"
      data-agent={snap.agent}
      data-state={
        running ? "running" : stopped ? "stopped" : failed ? "failed" : "done"
      }
    >
      <div className="h56-delegation-line">
        <button
          type="button"
          className="h56-tools-head"
          disabled={!onOpenProcess}
          // AC-29：同角色并发时可访问名必须可辨对象——带派单说明，不用共享的「查看执行过程」。
          aria-label={`查看执行过程：${role ? role + " · " : ""}${title}`}
          title={onOpenProcess ? `查看执行过程：${title}` : undefined}
          onClick={() => onOpenProcess?.()}
        >
          {running ? <i className="h37-spinner" aria-hidden="true" /> : null}
          <span className="h56-tools-label">
            {role ? <b className="h56-delegation-role">{role}</b> : null}
            {role ? " · " : ""}
            {title}
            {snap.background ? (
              <span className="h56-delegation-tag"> · 后台</span>
            ) : null}
          </span>
          {meta ? (
            <span className="h56-tools-count h56-delegation-meta">{meta}</span>
          ) : null}
          {!running ? (
            stopped ? (
              <Square
                className="h56-delegation-stop-mark"
                aria-label="已停止"
              />
            ) : failed ? (
              <X className="h56-delegation-fail" aria-label="没有完成" />
            ) : (
              <Check className="h56-delegation-done" aria-label="已完成" />
            )
          ) : null}
        </button>
        {running && snap.phase !== "stopping" && onAction ? (
          <button
            type="button"
            className="h56-delegation-stop"
            aria-label={`停止 ${role || "子 agent"}：${title}`}
            title={`停止（${title}）`}
            onClick={() =>
              onAction("stop", { taskId: snap.taskId ?? snap.key ?? undefined })
            }
          >
            <Square aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
