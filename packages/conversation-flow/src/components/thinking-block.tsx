import { useEffect, useId, useRef, useState } from "react";
import { useTranscriptRowState } from "./transcript-row-state.js";
import { ChevronRight } from "lucide-react";
import {
  formatThinkingDuration,
  latestLineOf,
} from "../presentation/thinking-format.js";
import { useThinkingElapsed } from "../presentation/use-thinking-elapsed.js";

/**
 * 048：回复上方的思考折叠头（候选稿 v3）。
 *
 * 三态：streaming（思考中 · Ns ＋最新一行实时滚动）、done（已思考 Ns）、
 * interrupted（思考已中断 · Ns）。整行是一个按钮（aria-expanded/aria-controls），
 * 开合只由用户点击改变；展开区最多五行，超出内部滚动，思考中跟随
 * 最新内容，用户上翻即停跟。层级只靠字号与灰度：头 13 号 muted 中字重、
 * 最新一行 13 号 muted 常规字重，不与正文抢层级。
 */

export function ThinkingBlock({
  text,
  durationMs = 0,
  startedAt = null,
  state,
  initialExpanded = false,
}: {
  /** 思考全文（streaming 时随分片增长）。 */
  text: string;
  /** 结束态的定格时长（done/interrupted）。 */
  durationMs?: number;
  /** streaming 态的起点（毫秒时间戳）。 */
  startedAt?: number | null;
  state: "streaming" | "done" | "interrupted";
  /** fixtures 验收用：初始展开（真实开合仍只由用户点击驱动）。 */
  initialExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useTranscriptRowState<boolean>(
    "thinking-expanded",
    initialExpanded,
  );
  const [userScrolled, setUserScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tickingMs = useThinkingElapsed(
    state === "streaming" ? startedAt : null,
  );

  // 展开区跟随最新内容：流式中未上翻就贴底（新内容到来即滚到底）。
  useEffect(() => {
    if (!expanded || state !== "streaming" || userScrolled) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [expanded, state, userScrolled, text]);

  // 滚轮接管：本仓对话流外层是 base-ui ScrollArea，内层滚动容器拿不到滚轮
  // 默认分发（真机实测 2026-10-09：滚轮落在展开区，滚的是外层对话列）——
  // 手动挂非 passive 监听（React onWheel 是 passive，preventDefault 无效），
  // 区内可滚即消费；到边界放行，外层对话流继续接手（file-preview 同款解法）。
  useEffect(() => {
    if (!expanded) return;
    const node = scrollRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (
        event.defaultPrevented ||
        Math.abs(event.deltaY) <= Math.abs(event.deltaX)
      )
        return;
      const maxScroll = node.scrollHeight - node.clientHeight;
      if (maxScroll <= 0) return; // 没溢出：放行外层
      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaY;
      const atEdge =
        (delta < 0 && node.scrollTop <= 0) ||
        (delta > 0 && node.scrollTop >= maxScroll - 1);
      if (atEdge) return; // 边界：放行（链给外层）
      event.preventDefault();
      node.scrollTop += delta; // 触发 scroll 事件 → onScroll 的跟随判定照常跑
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [expanded]);

  const label =
    state === "streaming"
      ? "思考中"
      : state === "interrupted"
        ? "思考已中断"
        : "已思考";
  const ms = state === "streaming" ? (tickingMs ?? 0) : durationMs;

  const headerId = useId();
  const bodyId = `${headerId}-body`;

  return (
    <div className="h48-thinking" data-state={state}>
      <button
        type="button"
        className="h48-thinking-head"
        id={headerId}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="h48-thinking-label" role="status">
          {label}
        </span>
        <span className="h48-thinking-timer" aria-hidden="true">
          {state === "streaming"
            ? `· ${formatThinkingDuration(ms)}`
            : `· ${formatThinkingDuration(ms)}`}
        </span>
        <ChevronRight
          className="h48-thinking-chevron size-3"
          aria-hidden="true"
          data-open={expanded ? "true" : undefined}
        />
        {state === "streaming" && !expanded && latestLineOf(text) ? (
          <span className="h48-thinking-latest" aria-hidden="true">
            {latestLineOf(text)}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div
          ref={scrollRef}
          id={bodyId}
          className={`h48-thinking-body selectable${state === "streaming" ? " is-streaming" : ""}`}
          onScroll={(event) => {
            const node = event.currentTarget;
            const atBottom =
              node.scrollHeight - node.scrollTop - node.clientHeight < 8;
            setUserScrolled(!atBottom);
          }}
          role="region"
          aria-label="思考全文"
        >
          {text ? (
            text
              .split(/\n{2,}/)
              .map((paragraph, index) => (
                <p key={index}>{renderParagraph(paragraph)}</p>
              ))
          ) : (
            <p className="h48-thinking-empty">这段思考没有回传文字。</p>
          )}
          {state === "streaming" ? (
            <span className="h48-thinking-cursor" aria-hidden="true" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Claude 摘要里的 **小标题** 显示为加粗；其余纯文本。 */
function renderParagraph(paragraph: string) {
  const parts = paragraph.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  if (parts.length === 1 && !parts[0].startsWith("**")) return parts[0];
  return parts.map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={index}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}
