import {useState} from 'react';
import type {ConversationFlowHost, FlowActionHandler, FlowScope, MessageView, WorkflowCardView} from '@hemi/conversation-flow';
import {ConversationFlowProvider, Markdown} from '@hemi/conversation-flow/parts';
import {ErrorState, ErrorBoundary} from '@hemi/ui';
import type {MobilePreviewTarget} from '../preview';
import {ResourcePreview} from './resource-preview';
import {TaskDetailsPanel} from './task-details-panel';
import {Sheet} from './dialog';

const statuses: Record<string, string> = {preparing:'准备参数',queued:'排队中',running:'执行中',waiting:'等待操作',completed:'已完成',succeeded:'已完成',skipped:'已跳过',failed:'失败',stopped:'已停止',interrupted:'执行中断'};
const valueText = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

function WorkflowPreview({card, returnFocus, onClose}: {card?: WorkflowCardView;returnFocus: HTMLElement | null;onClose(): void}) {
  const [selected, setSelected] = useState<string | null>(null);
  const nodes = Object.entries(card?.nodes ?? {}), current = selected ?? card?.currentNodeId ?? nodes[0]?.[0];
  const fact = current ? card?.nodes?.[current] : null;
  return <Sheet title={card?.status === 'preparing' ? '工作流预览' : '工作流过程'} returnFocus={returnFocus} onClose={onClose}>
    {!card ? <ErrorState description="当前会话没有这份工作流记录，请刷新会话后重试。"/> : <div className="workflow-drawer-content">
      <h3>{card.title}</h3><p className="body-copy" role="status">{statuses[card.status] ?? card.status}{card.presentation?.revision != null ? ` · v${card.presentation.revision}` : ''}{card.totalCount != null ? ` · ${card.completedCount ?? 0}/${card.totalCount} 个步骤完成` : ''}</p>
      {card.modelLabel ? <p className="body-copy">执行模型：{card.modelLabel}</p> : null}
      {card.presentation?.outline ? <p className="body-copy">{card.presentation.outline}</p> : null}
      {card.waitingReason || card.error ? <p className="body-copy">{card.waitingReason || card.error}</p> : null}
      {card.issues?.map((issue, index) => <p className="body-copy" key={index}>{issue.message}</p>)}
      {card.values ? <details open><summary>本次输入</summary><dl>{Object.entries(card.values).map(([key,value]) => <div key={key}><dt>{card.presentation?.labels[key] ?? key}</dt><dd>{valueText(value)}</dd></div>)}</dl></details> : null}
      {nodes.length ? <><div className="workflow-drawer-steps" aria-label="工作流步骤">{nodes.map(([id,node]) => <button key={id} type="button" className="selection-row" aria-pressed={current === id} onClick={() => setSelected(id)}><span>{id}<small>{statuses[node.status ?? ''] ?? node.status ?? '尚未开始'}</small></span></button>)}</div>{fact ? <section aria-label="步骤详情"><h4>{current}</h4>{fact.error ? <p className="body-copy">{fact.error}</p> : null}<dl>{Object.entries(fact.outputs ?? {}).filter(([key]) => !key.startsWith('__')).map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{valueText(value)}</dd></div>)}</dl>{fact.log?.map((entry,index) => <p className="body-copy" key={index}>{new Date(entry.at).toLocaleTimeString()} · {entry.tool} · {entry.kind === 'tool-start' ? '开始' : entry.isError ? '失败' : '结束'}</p>)}</section> : null}</> : <p className="body-copy">当前 Bot 只提供这份流程摘要，完整步骤定义尚未同步。</p>}
      {card.outputs ? <details open><summary>交付结果</summary><dl>{Object.entries(card.outputs).map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{valueText(value)}</dd></div>)}</dl></details> : null}
    </div>}
  </Sheet>;
}

export function PreviewDrawer({target, messages, scope, host, transfers, onAction, onStop, onSelect, readOnly, offline, returnFocus, onClose}: {
  target: MobilePreviewTarget;messages: readonly MessageView[];scope: FlowScope;host: ConversationFlowHost;
  transfers?: React.ComponentProps<typeof ResourcePreview>['transfers'];onAction: FlowActionHandler;
  onStop(runId?: string): Promise<boolean>;readOnly: boolean;offline: boolean;returnFocus: HTMLElement | null;onClose(): void;
  onSelect(target: MobilePreviewTarget): void;
}) {
  const taskId = target.kind === 'task' || target.kind === 'report' ? target.taskId : null;
  const message = [...messages].reverse().find(message => (message.task?.taskId ?? message.task?.key) === taskId);
  const task = message?.task;
  const key = JSON.stringify(target);
  const card = target.kind === 'workflow' ? messages.flatMap(message => message.parts ?? []).find(part => part.type === 'workflow-card' && part.card.invocationId === target.invocationId) : null;
  const report = task?.resultText || [...task?.conversation?.messages ?? []].reverse().find(message => message.author === 'hemi' && message.text.trim())?.text;
  const openLink = (href: string) => onSelect({kind:'resource',request:{href}});
  return <ConversationFlowProvider part scope={scope} host={host} onAction={onAction}><ErrorBoundary resetKey={key} fallback={<Sheet title="预览暂时无法显示" returnFocus={returnFocus} onClose={onClose}><ErrorState description="请关闭后重新打开，或选择其他内容。"/></Sheet>}>
    {target.kind === 'resource' ? <ResourcePreview key={key} host={host} transfers={transfers} scope={scope} request={target.request} returnFocus={returnFocus} onClose={onClose} onLocalLink={openLink}/>
      : target.kind === 'task' ? <TaskDetailsPanel key={key} task={task} scope={scope} host={host} onAction={onAction} onStop={() => onStop(message?.runId)} onReport={report ? () => onSelect({kind:'report',taskId:target.taskId}) : undefined} onArtifact={artifact => onSelect({kind:'resource',request:{href:artifact.path,name:artifact.name}})} onLocalLink={openLink} readOnly={readOnly} offline={offline} confirmStop={target.confirmStop} returnFocus={returnFocus} onClose={onClose}/>
      : target.kind === 'workflow' ? <WorkflowPreview key={key} card={card?.type === 'workflow-card' ? card.card : undefined} returnFocus={returnFocus} onClose={onClose}/>
      : <Sheet title="子任务报告" returnFocus={returnFocus} onClose={onClose}>{task?.taskText ? <h3>{task.taskText}</h3> : null}{report ? <article className="resource-preview-markdown"><Markdown text={report} onLocalLink={openLink}/></article> : <ErrorState description="这条子任务尚无可查看的报告。"/>}{task?.outcomeReason ? <p className="body-copy">{task.outcomeReason}</p> : null}</Sheet>}
  </ErrorBoundary></ConversationFlowProvider>;
}
