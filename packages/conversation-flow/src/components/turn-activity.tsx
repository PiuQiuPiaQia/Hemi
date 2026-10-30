import { Markdown } from "../shared/markdown.js";
import { useId } from "react";
import {
  BookOpen,
  ChevronRight,
  FilePenLine,
  Folder,
  Globe,
  MessageSquareText,
  Search,
  Square,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { TurnToolCall } from "../types/presentation.js";
import type { ActivityEntry } from "../presentation/turn-display-blocks.js";
import {
  formatThinkingDuration,
  latestLineOf,
} from "../presentation/thinking-format.js";
import { useThinkingElapsed } from "../presentation/use-thinking-elapsed.js";
import { describeToolCall } from "./tool-activity.js";
import { ThinkingBlock } from "./thinking-block.js";
import {
  TranscriptPartState,
  useTranscriptRowState,
} from "./transcript-row-state.js";

function ToolIcon({ tool }: { tool: string }) {
  const Icon =
    tool === "read"
      ? BookOpen
      : tool === "write" || tool === "edit"
        ? FilePenLine
        : tool === "bash"
          ? Terminal
          : tool === "ls"
            ? Folder
            : tool === "grep" || tool === "glob"
              ? Search
              : tool.startsWith("web_") || tool.startsWith("browser_")
                ? Globe
                : Wrench;
  return <Icon aria-hidden="true" />;
}

function describeActivityCall(call: TurnToolCall) {
  const path = call.args.path;
  return describeToolCall(
    typeof path === "string"
      ? {
          ...call,
          args: {
            ...call.args,
            path:
              path
                .replace(/[\\/]+$/, "")
                .split(/[\\/]/)
                .at(-1) || path,
          },
        }
      : call,
  );
}

function ThinkingProgress({
  text,
  startedAt,
}: {
  text: string;
  startedAt: number;
}) {
  const elapsedMs = useThinkingElapsed(startedAt);
  const latest = latestLineOf(text);
  return (
    <>
      <span className="turn-activity-timer" aria-hidden="true">
        · {formatThinkingDuration(elapsedMs ?? 0)}
      </span>
      {latest ? (
        <span
          className="turn-activity-preview"
          title={latest}
          aria-hidden="true"
        >
          {latest}
        </span>
      ) : null}
    </>
  );
}

/** A single disclosure for the ordered thinking/tools between two text segments.
 * 065：variant="turn" 用于完成态的整轮过程组——头部显示「用时 X」＋计数，
 * 过程文本以「说明」行折入组内（见 buildTurnDisplayBlocks 的 complete 模式）。 */
export function TurnActivity({
  entries,
  live,
  variant = "stage",
  durationMs,
}: {
  entries: ActivityEntry[];
  live: boolean;
  /** stage＝执行态的段间过程组；turn＝完成态的整轮过程组。 */
  variant?: "stage" | "turn";
  /** turn 头部的整轮生成时长（item.usage.genMs）。 */
  durationMs?: number;
}) {
  const [open, setOpen] = useTranscriptRowState<boolean>(
    "activity-expanded",
    false,
  );
  const bodyId = useId();
  const calls = entries.flatMap((entry) =>
    entry.kind === "tool" ? [entry.call] : [],
  );
  const running = calls.find((call) => call.state === "running");
  const tail = entries.at(-1);
  const activeThinking =
    live && tail?.kind === "thinking" && tail.part.endedAt == null
      ? tail
      : null;
  const thinking = Boolean(activeThinking);
  const failed = calls.filter((call) => call.state === "error").length;
  const stopped = calls.filter((call) => call.state === "stopped").length;
  const interrupted = entries.some(
    (entry) => entry.kind === "thinking" && entry.part.interrupted,
  );
  const says = entries.filter((entry) => entry.kind === "say").length;
  const thinks = entries.filter((entry) => entry.kind === "thinking").length;
  const labels = [
    ...new Set(
      calls.map((call) => describeToolCall({ tool: call.tool, args: {} })),
    ),
  ];
  const turnLabel =
    durationMs && durationMs > 0
      ? `用时 ${formatThinkingDuration(durationMs)}`
      : "已完成";
  const headline = running
    ? `正在${describeActivityCall(running)}`
    : thinking
      ? open
        ? "执行过程"
        : "思考中"
      : variant === "turn"
        ? turnLabel
        : calls.length === 1
          ? describeActivityCall(calls[0])
          : calls.length
            ? `${labels.slice(0, 3).join("、")}${labels.length > 3 ? "等" : ""}`
            : interrupted
              ? "思考已中断"
              : "思考过程";

  return (
    <div
      className="turn-activity"
      data-open={open ? "true" : undefined}
      data-running={running || thinking ? "true" : undefined}
      data-thinking={thinking && !running ? "true" : undefined}
      data-tool-states={JSON.stringify(
        calls.map((call) => ({ id: call.id, state: call.state })),
      )}
    >
      <button
        type="button"
        className="turn-activity-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        {running || thinking ? (
          <i className="h37-spinner" aria-hidden="true" />
        ) : (
          <Wrench aria-hidden="true" />
        )}
        <span className="turn-activity-label" title={headline}>
          {headline}
        </span>
        {!open && !running && activeThinking ? (
          <ThinkingProgress
            key={activeThinking.id}
            text={activeThinking.part.text}
            startedAt={activeThinking.part.startedAt}
          />
        ) : null}
        {calls.length > 0 && (calls.length > 1 || variant === "turn") ? (
          <span className="turn-activity-count">{calls.length} 项操作</span>
        ) : null}
        {variant === "turn" && says > 0 ? (
          <span className="turn-activity-count">{says} 条说明</span>
        ) : null}
        {variant === "turn" && thinks > 0 ? (
          <span className="turn-activity-count">{thinks} 段思考</span>
        ) : null}
        {failed ? (
          <span className="turn-activity-failed">{failed} 项失败</span>
        ) : null}
        {stopped ? (
          <span className="turn-activity-count">{stopped} 项停止</span>
        ) : null}
        <ChevronRight className="turn-activity-chevron" aria-hidden="true" />
      </button>
      {open ? (
        <ol
          id={bodyId}
          className="turn-activity-list"
          aria-label="阶段过程详情"
        >
          {entries.map((entry) => (
            <li key={entry.id} data-activity-kind={entry.kind}>
              {entry.kind === "thinking" ? (
                <TranscriptPartState id={entry.id}>
                  <ThinkingBlock
                    state={
                      live && entry === tail && entry.part.endedAt == null
                        ? "streaming"
                        : entry.part.interrupted
                          ? "interrupted"
                          : "done"
                    }
                    text={entry.part.text}
                    startedAt={entry.part.startedAt}
                    durationMs={Math.max(
                      0,
                      (entry.part.endedAt ?? Date.now()) - entry.part.startedAt,
                    )}
                  />
                </TranscriptPartState>
              ) : entry.kind === "say" ? (
                <div className="turn-activity-say">
                  <MessageSquareText aria-hidden="true" />
                  <div className="selectable"><Markdown text={entry.part.text} /></div>
                </div>
              ) : (
                <ToolStep call={entry.call} />
              )}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function ToolStep({ call }: { call: TurnToolCall }) {
  const state = call.state;
  return (
    <div className="turn-activity-step" data-state={state}>
      {state === "running" ? (
        <i className="h37-spinner" aria-label="正在执行" />
      ) : state === "error" ? (
        <X aria-label="失败" />
      ) : state === "stopped" ? (
        <Square aria-label="已停止" />
      ) : (
        <ToolIcon tool={call.tool} />
      )}
      <div className="turn-activity-step-copy">
        <span className="selectable" title={describeToolCall(call)}>
          {describeActivityCall(call)}
        </span>
        {["bash", "powershell"].includes(call.tool) &&
        typeof call.args.command === "string" ? (
          <pre className="selectable">{call.args.command}</pre>
        ) : null}
        {call.output ? (
          <details className="turn-activity-output">
            <summary>工具结果{call.outputTruncated ? '（节选）' : ''}</summary>
            <pre className="selectable">{call.output}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
