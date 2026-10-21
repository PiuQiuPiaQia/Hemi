import { TranscriptPartState } from './transcript-row-state';
import type { ReactNode } from 'react';
import { FileText, ImageIcon } from 'lucide-react';

import type { TurnPart, TurnToolCall } from '@/shared/types';
import { Markdown } from '@/shared/markdown';
import { TurnActivity } from '@/windows/voice/turn-activity';
import { buildTurnDisplayBlocks } from './lib/turn-display-blocks';
import { WorkflowCard } from '@/windows/voice/workflow-card';

/**
 * 056 · 回合内容按到达顺序从上往下展示（2026-10-14 用户反馈：对话流应照接口返回的
 * 先后排，而不是思考、工具、正文各自堆一处）。text 作为阶段正文，正文之间的
 * 思考和普通工具合成一个过程组；组内仍按原序展开，任务和交付等独立入口不折入。
 * 流式与档案回看共用；只有尾段显示流式状态。正文后处理由 renderText 接管。
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
      {buildTurnDisplayBlocks(parts).map(block => {
        const key = block.id;
        if (block.kind === 'activity') {
          return <TranscriptPartState key={key} id={key}><TurnActivity
            entries={block.entries} live={live && block.lastIndex === parts.length - 1}
          /></TranscriptPartState>;
        }
        if (block.kind === 'task') {
          const node = renderTask?.(block.call);
          return node ? <div key={key}>{node}</div> : null;
        }
        const { part, index } = block;
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
        if (part.type === 'workflow-card') {
          return <TranscriptPartState key={key} id={key}><WorkflowCard card={part.card} /></TranscriptPartState>;
        }
        return (
          <div key={key} className={`chat-copy assistant-copy${live && index === parts.length - 1 ? ' streaming-copy' : ''}`}>
            {renderText ? renderText(part.text, index) : <Markdown text={part.text} />}
          </div>
        );
      })}
    </>
  );
}
