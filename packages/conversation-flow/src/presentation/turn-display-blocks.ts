import type { TurnPart, TurnToolCall } from "../types/presentation.js";

type DisplayPart = TurnPart & { partId?: string };
type ThinkingPart = Extract<TurnPart, { type: "thinking" }>;
export type ActivityEntry =
  | { kind: "thinking"; id: string; part: ThinkingPart; index: number }
  | { kind: "tool"; id: string; call: TurnToolCall; index: number };

export type TurnDisplayBlock =
  | {
      kind: "activity";
      id: string;
      entries: ActivityEntry[];
      lastIndex: number;
    }
  | { kind: "task"; id: string; call: TurnToolCall }
  | {
      kind: "content";
      id: string;
      part: Exclude<DisplayPart, { type: "thinking" | "tools" }>;
      index: number;
    };

/** UI-only grouping. Text and interactive content are boundaries; source parts never move. */
export function buildTurnDisplayBlocks(
  parts: DisplayPart[],
): TurnDisplayBlock[] {
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
