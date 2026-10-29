import { TranscriptPartState } from "./transcript-row-state.js";
import type { ReactNode } from "react";

import type { TurnPart, TurnToolCall } from "../types/presentation.js";
import { Markdown } from "../shared/markdown.js";
import { TurnActivity } from "./turn-activity.js";
import { buildTurnDisplayBlocks } from "../presentation/turn-display-blocks.js";
import { WorkflowCard } from "./workflow-card.js";
import { DeliverableCards } from "./deliverable-card";

/**
 * 056 · 回合内容按到达顺序从上往下展示（2026-10-14 用户反馈：对话流应照接口返回的
 * 先后排，而不是思考、工具、正文各自堆一处）。text 作为阶段正文，正文之间的
 * 思考和普通工具合成一个过程组；组内仍按原序展开，任务和交付等独立入口不折入。
 * 流式与档案回看共用；只有尾段显示流式状态。正文后处理由 renderText 接管。
 *
 * 065 · 完成态（complete: true，回合正常收尾后）：回答之前的全部过程折进首个
 * 活动组（「用时 X」头部），过程文本以「说明」行入组，只外显最后无后续动作的
 * text。执行中、失败、停止、等待用户时不折叠（见 buildTurnDisplayBlocks）。
 */
export function TurnParts({
  parts,
  live = false,
  complete = false,
  durationMs,
  renderText,
  renderTask,
  onOpenDeliverable,
}: {
  parts: Array<TurnPart & { partId?: string }>;
  live?: boolean;
  /** 065：完成态——过程并入整轮折叠组，仅尾段文本外显。 */
  complete?: boolean;
  /** 065：整轮生成时长（完成态头部「用时 X」）。 */
  durationMs?: number;
  renderText?: (text: string, index: number) => ReactNode;
  /**
   * 056：task 调用原地渲染子 agent 的一行（按 toolCallId 找到对应子 agent）——它在接口里
   * 出现在哪，就显示在哪；找不到对应子 agent（快照还没到）时返回 null 跳过。
   */
  renderTask?: (call: TurnToolCall) => ReactNode;
  /** 062：交付文件入口点击 → 右侧预览（渲染层只带 artifactId，路径在主进程）。 */
  onOpenDeliverable?: (artifactId: string, name: string) => void;
}) {
  return (
    <>
      {buildTurnDisplayBlocks(parts, { complete }).map((block) => {
        const key = block.id;
        if (block.kind === "activity") {
          return (
            <TranscriptPartState key={key} id={key}>
              <TurnActivity
                entries={block.entries}
                live={live && block.lastIndex === parts.length - 1}
                variant={
                  complete && block.turnSummary ? "turn" : "stage"
                }
                durationMs={
                  complete && block.turnSummary ? durationMs : undefined
                }
              />
            </TranscriptPartState>
          );
        }
        if (block.kind === "task") {
          const node = renderTask?.(block.call);
          return node ? <div key={key}>{node}</div> : null;
        }
        const { part, index } = block;
        if (part.type === "file-delivery") {
          // Consecutive results share a responsive grid, while text/tool boundaries stay in order.
          if (parts[index - 1]?.type === "file-delivery") return null;
          const files: Array<Extract<TurnPart, { type: "file-delivery" }>> = [];
          for (
            let cursor = index;
            parts[cursor]?.type === "file-delivery";
            cursor++
          ) {
            files.push(
              parts[cursor] as Extract<TurnPart, { type: "file-delivery" }>,
            );
          }
          return (
            <DeliverableCards
              key={key}
              files={files}
              onOpen={onOpenDeliverable}
            />
          );
        }
        if (part.type === "workflow-card") {
          return (
            <TranscriptPartState key={key} id={key}>
              <WorkflowCard card={part.card} />
            </TranscriptPartState>
          );
        }
        return (
          <div
            key={key}
            className={`chat-copy assistant-copy${live && index === parts.length - 1 ? " streaming-copy" : ""}`}
          >
            {renderText ? (
              renderText(part.text, index)
            ) : (
              <Markdown text={part.text} />
            )}
          </div>
        );
      })}
    </>
  );
}
