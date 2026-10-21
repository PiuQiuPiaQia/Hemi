import { useId } from 'react';
import { BookOpen, ChevronRight, FilePenLine, Folder, Globe, Search, Square, Terminal, Wrench, X } from 'lucide-react';
import type { TurnToolCall } from '@/shared/types';
import type { ActivityEntry } from './lib/turn-display-blocks';
import { describeToolCall } from './tool-activity';
import { ThinkingBlock } from './thinking-block';
import { TranscriptPartState, useTranscriptRowState } from './transcript-row-state';
import '@/styles/turn-activity.css';

function ToolIcon({ tool }: { tool: string }) {
  const Icon = tool === 'read' ? BookOpen : tool === 'write' || tool === 'edit' ? FilePenLine
    : tool === 'bash' ? Terminal : tool === 'ls' ? Folder : tool === 'grep' || tool === 'glob' ? Search
    : tool.startsWith('web_') || tool.startsWith('browser_') ? Globe : Wrench;
  return <Icon aria-hidden="true" />;
}

function describeActivityCall(call: TurnToolCall) {
  const path = call.args.path;
  return describeToolCall(typeof path === 'string'
    ? { ...call, args: { ...call.args, path: path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path } }
    : call);
}

/** A single disclosure for the ordered thinking/tools between two text segments. */
export function TurnActivity({ entries, live }: { entries: ActivityEntry[]; live: boolean }) {
  const [open, setOpen] = useTranscriptRowState<boolean>('activity-expanded', false);
  const bodyId = useId();
  const calls = entries.flatMap(entry => entry.kind === 'tool' ? [entry.call] : []);
  const running = calls.find(call => call.state === 'running');
  const tail = entries.at(-1);
  const thinking = live && tail?.kind === 'thinking' && tail.part.endedAt == null;
  const failed = calls.filter(call => call.state === 'error').length;
  const stopped = calls.filter(call => call.state === 'stopped').length;
  const interrupted = entries.some(entry => entry.kind === 'thinking' && entry.part.interrupted);
  const labels = [...new Set(calls.map(call => describeToolCall({ tool: call.tool, args: {} })))];
  const headline = running ? `正在${describeActivityCall(running)}` : thinking ? '思考中'
    : calls.length === 1 ? describeActivityCall(calls[0])
    : calls.length ? `${labels.slice(0, 3).join('、')}${labels.length > 3 ? '等' : ''}`
    : interrupted ? '思考已中断' : '思考过程';

  return <div className="turn-activity" data-open={open ? 'true' : undefined}
    data-running={running || thinking ? 'true' : undefined}
    data-tool-states={JSON.stringify(calls.map(call => ({ id: call.id, state: call.state })))}>
    <button type="button" className="turn-activity-head" aria-expanded={open} aria-controls={bodyId}
      onClick={() => setOpen(value => !value)}>
      {running || thinking ? <i className="h37-spinner" aria-hidden="true" /> : <Wrench aria-hidden="true" />}
      <span className="turn-activity-label" title={headline}>{headline}</span>
      {calls.length > 1 ? <span className="turn-activity-count">{calls.length} 项操作</span> : null}
      {failed ? <span className="turn-activity-failed">{failed} 项失败</span> : null}
      {stopped ? <span className="turn-activity-count">{stopped} 项停止</span> : null}
      <ChevronRight className="turn-activity-chevron" aria-hidden="true" />
    </button>
    {open ? <ol id={bodyId} className="turn-activity-list" aria-label="阶段过程详情">
      {entries.map(entry => <li key={entry.id} data-activity-kind={entry.kind}>
        {entry.kind === 'thinking' ? <TranscriptPartState id={entry.id}><ThinkingBlock
          state={live && entry === tail && entry.part.endedAt == null ? 'streaming' : entry.part.interrupted ? 'interrupted' : 'done'}
          text={entry.part.text} startedAt={entry.part.startedAt}
          durationMs={Math.max(0, (entry.part.endedAt ?? Date.now()) - entry.part.startedAt)}
        /></TranscriptPartState> : <ToolStep call={entry.call} />}
      </li>)}
    </ol> : null}
  </div>;
}

function ToolStep({ call }: { call: TurnToolCall }) {
  const state = call.state;
  return <div className="turn-activity-step" data-state={state}>
    {state === 'running' ? <i className="h37-spinner" aria-label="正在执行" />
      : state === 'error' ? <X aria-label="失败" /> : state === 'stopped' ? <Square aria-label="已停止" />
      : <ToolIcon tool={call.tool} />}
    <span className="selectable" title={describeToolCall(call)}>{describeActivityCall(call)}</span>
  </div>;
}
