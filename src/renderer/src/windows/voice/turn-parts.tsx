import { TranscriptPartState } from './transcript-row-state';
import type { ReactNode } from 'react';
import { FileText, ImageIcon } from 'lucide-react';

import type { TurnPart, TurnToolCall } from '@/shared/types';
import { Markdown } from '@/shared/markdown';
import { ThinkingBlock } from '@/windows/voice/thinking-block';
import { ToolActivity } from '@/windows/voice/tool-activity';
import { WorkflowCard } from '@/windows/voice/workflow-card';

/**
 * 056 · 回合内容按到达顺序从上往下展示（2026-10-14 用户反馈：对话流应照接口返回的
 * 先后排，而不是思考、工具、正文各自堆一处）。思考段＝折叠头，正文段＝Markdown，
 * 工具组＝两段文字之间连续的调用。流式与档案回看共用；`live` 时最后一段思考按
 * 进行中显示。正文的证据脚注等后处理由调用方经 renderText 接管。
 */
export function TurnParts({
  parts,
  live = false,
  renderText,
  renderTask,
  onOpenDeliverable,
}: {
  parts: Array<TurnPart & { partId?: string }>;
  live?: boolean;
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
      {parts.map((part, index) => {
        const key = part.partId ?? `${part.type}-${index}`;
        if (part.type === 'thinking') {
          const streaming = live && part.endedAt == null && index === parts.length - 1;
          return (
            <TranscriptPartState key={key} id={key}><ThinkingBlock
              state={streaming ? 'streaming' : part.interrupted ? 'interrupted' : 'done'}
              text={part.text}
              startedAt={part.startedAt}
              durationMs={Math.max(0, (part.endedAt ?? Date.now()) - part.startedAt)}
            /></TranscriptPartState>
          );
        }
        if (part.type === 'file-delivery') {
          // 062：紧凑文件入口（R-01）——文件名＋图标一行，大图和完整内容只在右侧。
          return (
            <div key={key} className="h62-deliverable-entry">
              <button
                type="button"
                className="h62-deliverable-chip"
                title={part.host ? `${part.host}:${part.name}` : part.name}
                onClick={onOpenDeliverable ? () => onOpenDeliverable(part.artifactId, part.name) : undefined}
              >
                {/\.(png|jpe?g|gif|webp|svg)$/i.test(part.name) ? (
                  <ImageIcon className="size-3.5" aria-hidden="true" />
                ) : (
                  <FileText className="size-3.5" aria-hidden="true" />
                )}
                <span>{part.name}</span>
                <small>查看</small>
              </button>
            </div>
          );
        }
        if (part.type === 'tools') {
          // 056：同一组里的 task 调用原地换成子 agent 的一行（按到达顺序，前后的普通工具照常折叠）。
          const nodes: ReactNode[] = [];
          let run: TurnToolCall[] = [];
          const flush = () => {
            if (run.length) nodes.push(<TranscriptPartState key={run[0].id} id={run[0].id}><ToolActivity calls={run} /></TranscriptPartState>);
            run = [];
          };
          for (const call of part.calls) {
            if (call.tool !== 'task') { run.push(call); continue; }
            flush();
            const node = renderTask?.(call);
            if (node) nodes.push(<div key={`${key}-a${call.id}`}>{node}</div>);
          }
          flush();
          return nodes.length ? <div key={key}>{nodes}</div> : null;
        }
        if (part.type === 'workflow-card') {
          return <TranscriptPartState key={key} id={key}><WorkflowCard card={part.card} /></TranscriptPartState>;
        }
        return (
          <div key={key} className={`chat-copy assistant-copy${live ? ' streaming-copy' : ''}`}>
            {renderText ? renderText(part.text, index) : <Markdown text={part.text} />}
          </div>
        );
      })}
    </>
  );
}
