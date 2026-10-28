import {useEffect, useMemo, useState} from 'react';
import {ConversationFlow, type ConversationFlowHost, type FlowActionHandler, type FlowScope, type MessageView, type TaskView} from '@hemi/conversation-flow';
import {Markdown} from '@hemi/conversation-flow/parts';
import {ErrorState} from '@hemi/ui';
import {Sheet} from './dialog';

const outcomes: Record<string, string> = {complete: '已完成', stopped: '已停止', denied: '未获授权', blocked: '已阻止', partial: '部分完成', unknown: '结果待核实', startfailed: '未能启动', reportfailed: '总结失败'};

export function TaskDetailsPanel({task, scope, host, onAction, onStop, onReport, onArtifact, onLocalLink, readOnly, offline, confirmStop = false, returnFocus, onClose}: {
  task?: TaskView;
  scope: FlowScope;
  host: ConversationFlowHost;
  onAction: FlowActionHandler;
  onStop(): Promise<boolean>;
  onReport?(): void;
  onArtifact?(artifact: NonNullable<TaskView['artifacts']>[number]): void;
  onLocalLink?(href: string): void;
  readOnly: boolean;
  offline: boolean;
  confirmStop?: boolean;
  returnFocus?: HTMLElement | null;
  onClose(): void;
}) {
  const [confirming, setConfirming] = useState(confirmStop), [stopping, setStopping] = useState(false);
  const [now, setNow] = useState(Date.now);
  const live = Boolean(task && task.phase !== 'terminal');
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const messages = useMemo<MessageView[]>(() => (task?.conversation?.messages ?? []).map((message, index, list) => ({
    ...message,
    author: message.author === 'hemi' ? 'assistant' : 'user',
    parts: task?.phase !== 'terminal' ? message.parts : message.parts?.map(part => part.type === 'tools'
      ? {...part, calls: part.calls.map(call => call.state === 'running' ? {...call, state: 'stopped' as const} : call)}
      : part.type === 'thinking' && part.endedAt == null ? {...part, endedAt: task.endedAt ?? message.createdAt, interrupted: true} : part),
    live: task?.phase === 'running' && message.author === 'hemi' && index === list.length - 1,
    streaming: task?.phase === 'running' && message.author === 'hemi' && index === list.length - 1 && !task.activity?.phase.startsWith('waiting-'),
  })), [task]);
  const status = task?.phase === 'terminal' ? outcomes[task.outcome ?? ''] ?? '已结束' : task?.phase === 'stopping' ? '正在停止' : task?.progressText || '正在执行';
  const elapsed = task?.startedAt ? Math.max(0, Math.floor(((task.endedAt ?? now) - task.startedAt) / 1000)) : null;
  const stop = async () => {
    if (stopping || offline || readOnly || !live) return;
    setStopping(true);
    try {if (await onStop()) setConfirming(false);} finally {setStopping(false);}
  };
  return <Sheet title="子任务详情" returnFocus={returnFocus} onClose={onClose} footer={live && !readOnly ? <>
    {confirming ? <><p className="body-copy">将停止本次执行及其所有子任务，已完成的内容会保留。</p><div className="split-actions"><button type="button" className="secondary-button" disabled={stopping} onClick={() => setConfirming(false)}>取消</button><button type="button" className="primary-button" disabled={offline || stopping} aria-busy={stopping} onClick={() => void stop()}>{stopping ? '正在停止…' : '确认停止当前任务'}</button></div></>
      : <button type="button" className="secondary-button full-width" disabled={offline || task?.phase === 'stopping'} onClick={() => setConfirming(true)}>停止当前任务…</button>}
  </> : !live && onReport ? <button type="button" className="secondary-button full-width" onClick={onReport}>查看报告</button> : undefined}>
    {!task ? <ErrorState description="这条子任务的记录暂时无法读取，请关闭后重新打开。"/> : <>
      <div className="task-detail-heading"><strong>{task.taskText || '子任务'}</strong><p role="status">{[task.agentTitle, task.agent, status].filter(Boolean).join(' · ')}{elapsed != null ? ` · ${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒` : ''}</p></div>
      {task.artifacts?.some(artifact => artifact.kind === 'file') && onArtifact ? <div className="task-detail-files" aria-label="子任务文件">{task.artifacts.filter(artifact => artifact.kind === 'file').map(artifact => <button type="button" className="secondary-button" key={artifact.id} disabled={artifact.available === false} onClick={() => onArtifact(artifact)}>{artifact.name}</button>)}</div> : null}
      {messages.length ? <div className="task-detail-conversation conversation-frame"><ConversationFlow scope={scope} host={host} messages={messages} onAction={onAction} state={{readOnly: true, busy: live, transientActionErrors: true, runActivity: task.activity ?? undefined,
        notice: [task.conversation?.truncated ? '部分较早的执行记录已省略。' : '', !live ? task.outcomeReason : ''].filter(Boolean).join('\n') || undefined}}/></div>
        : <>{(task.log ?? []).map((line, index) => <p className="body-copy" key={`${line.at}:${index}`}>{line.text}</p>)}{task.resultText ? <div className="md"><Markdown text={task.resultText} onLocalLink={onLocalLink}/></div> : null}{task.outcomeReason ? <p className="body-copy">{task.outcomeReason}</p> : null}{!task.log?.length && !task.resultText && !task.outcomeReason ? <p className="body-copy">{live ? '正在等待子任务的执行记录…' : '这条子任务没有留下详细执行记录。'}</p> : null}</>}
    </>}
  </Sheet>;
}
