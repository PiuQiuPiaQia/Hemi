import type { TurnPart, TurnToolCall } from "../types/presentation.js";

type DisplayPart = TurnPart & { partId?: string };
type ThinkingPart = Extract<TurnPart, { type: "thinking" }>;
type TextPart = Extract<TurnPart, { type: "text" }>;
export type ActivityEntry =
  | { kind: "thinking"; id: string; part: ThinkingPart; index: number }
  | { kind: "tool"; id: string; call: TurnToolCall; index: number }
  /** 065 完成态：正文之后仍有动作的 text 段——过程说明，折入活动组。 */
  | { kind: "say"; id: string; part: TextPart; index: number };

export type TurnDisplayBlock =
  | {
      kind: "activity";
      id: string;
      entries: ActivityEntry[];
      lastIndex: number;
      /** 065 完成态整轮过程组（「用时 X」头部）；只有完成态的首个活动组为 true。 */
      turnSummary?: boolean;
    }
  | { kind: "task"; id: string; call: TurnToolCall }
  | {
      kind: "content";
      id: string;
      part: Exclude<DisplayPart, { type: "thinking" | "tools" }>;
      index: number;
    };

const ACTIVITY_TYPES = new Set(["thinking", "tools", "task"]);

/** 065：这段 text 之后是否还有动作（完成态区分「过程说明」与「回答」的唯一依据）。 */
const hasFollowUpActivity = (parts: DisplayPart[], index: number) =>
  parts.slice(index + 1).some((part) => ACTIVITY_TYPES.has(part.type));

/**
 * 065：整轮过程时长估算——usage.genMs 缺失（旧档/宿主未记）时兜底。
 * 取全部思考段的最早 startedAt 到最晚 endedAt（text/tools 无时间戳，思考
 * 基本覆盖执行全程；无有效区间返回 0，头部显示「用时 0s」不致误导为缺席）。
 */
export function estimateTurnDurationMs(parts: DisplayPart[]): number {
  let start: number | null = null;
  let end: number | null = null;
  for (const part of parts) {
    if (part.type !== "thinking") continue;
    if (typeof part.startedAt === "number" && part.startedAt >= 0) {
      if (start === null || part.startedAt < start) start = part.startedAt;
    }
    if (typeof part.endedAt === "number" && part.endedAt >= 0) {
      if (end === null || part.endedAt > end) end = part.endedAt;
    }
  }
  return start !== null && end !== null ? Math.max(0, end - start) : 0;
}

/**
 * UI-only grouping. Text and interactive content are boundaries; source parts never move.
 *
 * 065 完成态（complete: true）：回合正常收尾后，回答之前的全部过程（思考、工具、
 * 过程文本）折进活动组，只外显最后无后续动作的 text（回答）。判定纯按位置——
 * 正文之后一旦再出现动作，它就是过程说明。整轮没有这样的尾段（以动作或交互块
 * 收尾、无回答）时退回执行态分组，过程保持可见（参照 DSH：无 answer 不折叠）。
 * task / 文件交付 / 工作流卡仍是边界：交互入口不折入过程组，被它们分隔出的
 * 后续活动组沿用执行态头部，只有首个活动组标记 turnSummary。
 */
export function buildTurnDisplayBlocks(
  parts: DisplayPart[],
  options: { complete?: boolean } = {},
): TurnDisplayBlock[] {
  if (
    options.complete &&
    parts.some(
      (part, index) => part.type === "text" && !hasFollowUpActivity(parts, index),
    )
  ) {
    return buildCompletedBlocks(parts);
  }
  const blocks: TurnDisplayBlock[] = [];
  let activity: Extract<TurnDisplayBlock, { kind: "activity" }> | null = null;
  const append = (entry: ActivityEntry) => {
    if (!activity) {
      activity = {
        kind: "activity",
        id: entry.id,
        entries: [],
        lastIndex: entry.index,
      };
      blocks.push(activity);
    }
    activity.entries.push(entry);
    activity.lastIndex = entry.index;
  };
  parts.forEach((part, index) => {
    const id = part.partId ?? `${part.type}-${index}`;
    if (part.type === "thinking") {
      append({ kind: "thinking", id, part, index });
    } else if (part.type === "tools") {
      for (const call of part.calls) {
        if (call.tool === "task") {
          activity = null;
          blocks.push({ kind: "task", id: `${id}:${call.id}`, call });
        } else {
          append({ kind: "tool", id: `${id}:${call.id}`, call, index });
        }
      }
    } else {
      activity = null;
      blocks.push({ kind: "content", id, part, index });
    }
  });
  return blocks;
}

function buildCompletedBlocks(parts: DisplayPart[]): TurnDisplayBlock[] {
  const blocks: TurnDisplayBlock[] = [];
  let activity: Extract<TurnDisplayBlock, { kind: "activity" }> | null = null;
  let turnSummarySeen = false;
  const append = (entry: ActivityEntry) => {
    if (!activity) {
      activity = {
        kind: "activity",
        id: entry.id,
        entries: [],
        lastIndex: entry.index,
        turnSummary: turnSummarySeen ? undefined : true,
      };
      turnSummarySeen = true;
      blocks.push(activity);
    }
    activity.entries.push(entry);
    activity.lastIndex = entry.index;
  };
  parts.forEach((part, index) => {
    const id = part.partId ?? `${part.type}-${index}`;
    if (part.type === "thinking") {
      append({ kind: "thinking", id, part, index });
    } else if (part.type === "tools") {
      for (const call of part.calls) {
        if (call.tool === "task") {
          activity = null;
          blocks.push({ kind: "task", id: `${id}:${call.id}`, call });
        } else {
          append({ kind: "tool", id: `${id}:${call.id}`, call, index });
        }
      }
    } else if (part.type === "text") {
      if (hasFollowUpActivity(parts, index)) {
        append({ kind: "say", id, part, index });
      } else {
        activity = null;
        blocks.push({ kind: "content", id, part, index });
      }
    } else {
      activity = null;
      blocks.push({ kind: "content", id, part, index });
    }
  });
  return blocks;
}
