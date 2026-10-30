import type { TurnPart, TurnToolCall } from "../types/presentation.js";

type DisplayPart = TurnPart & { partId?: string };
type ThinkingPart = Extract<TurnPart, { type: "thinking" }>;
type TextPart = Extract<TurnPart, { type: "text" }>;
export type ActivityEntry =
  | { kind: "thinking"; id: string; part: ThinkingPart; index: number }
  | { kind: "tool"; id: string; call: TurnToolCall; index: number }
  /** Explicit commentary can fold after successful completion. */
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

/** Fold only explicitly labelled commentary; answers and legacy text remain boundaries.
 * Running/abnormal turns and turns without a visible answer retain commentary in place.
 * Source parts, task entries and deliverables never move.
 */
export function buildTurnDisplayBlocks(
  parts: DisplayPart[],
  options: { complete?: boolean } = {},
): TurnDisplayBlock[] {
  const summarize = Boolean(options.complete && parts.some(part =>
    part.type === "text" && part.phase !== "commentary" && part.text.trim()));
  const blocks: TurnDisplayBlock[] = [];
  let activity: Extract<TurnDisplayBlock, { kind: "activity" }> | null = null;
  let summarySeen = false;
  const append = (entry: ActivityEntry) => {
    if (!activity) {
      activity = {
        kind: "activity", id: entry.id, entries: [], lastIndex: entry.index,
        ...(summarize && !summarySeen ? { turnSummary: true } : {}),
      };
      summarySeen = true;
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
        if (call.tool === "report_progress") continue; // Already represented by its typed message.
        if (call.tool === "task") {
          activity = null;
          blocks.push({ kind: "task", id: `${id}:${call.id}`, call });
        } else {
          append({ kind: "tool", id: `${id}:${call.id}`, call, index });
        }
      }
    } else if (part.type === "text" && summarize && part.phase === "commentary") {
      append({ kind: "say", id, part, index });
    } else {
      activity = null;
      blocks.push({ kind: "content", id, part, index });
    }
  });
  return blocks;
}
