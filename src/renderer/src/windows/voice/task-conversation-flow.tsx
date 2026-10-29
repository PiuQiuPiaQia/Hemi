import { useCallback, useMemo } from 'react';
import { ConversationFlow, type FlowActionHandler, type MessageView } from '@hemi/conversation-flow';
import type { TaskStateSnapshot } from '@/shared/types';
import { useAppearance } from '@/appearance/use-appearance';
import { useDesktopFlowAppearance } from './conversation-flow';
import { createDesktopFlowHost } from './lib/conversation-flow-host';
import { useConversationBridge, useConversationEnvironment, useConversationOnline } from './lib/conversation-bridge';

/** The task owns this read-only conversation; parent messages keep only its delegation row. */
export function TaskConversationFlow({ snap }: { snap: TaskStateSnapshot }) {
  const bridge = useConversationBridge();
  const environment = useConversationEnvironment();
  const online = useConversationOnline();
  const appearance = useAppearance();
  const { tokens, container } = useDesktopFlowAppearance();
  const id = snap.taskId ?? snap.key ?? 'task';
  const scope = useMemo(() => ({ environmentId: `${environment}:subagent`, conversationId: id, generation: '1' }), [environment, id]);
  const host = useMemo(() => createDesktopFlowHost(bridge, snap.conversationId ?? '', { remote: environment === 'bot', online }), [bridge, snap.conversationId, environment, online]);
  const onAction = useCallback<FlowActionHandler>(async action => {
    if (action.type === 'preview.open' && action.href) {
      const result = await bridge.openLink(action.href);
      return result ? { ok: true, value: { receipt: 'completed' } } : { ok: false, error: { code: 'failed', message: '链接未能打开' } };
    }
    return { ok: false, error: { code: 'unsupported', message: '请通过任务入口操作此子任务。' } };
  }, [bridge]);
  const messages = useMemo<MessageView[]>(() => (snap.conversation?.messages ?? []).map((message, index, list) => ({
    ...message,
    author: message.author === 'hemi' ? 'assistant' : 'user',
    parts: snap.phase !== 'terminal' ? message.parts : message.parts?.map(part => part.type === 'tools'
      ? { ...part, calls: part.calls.map(call => call.state === 'running' ? { ...call, state: 'stopped' as const } : call) }
      : part.type === 'thinking' && part.endedAt == null ? { ...part, endedAt: snap.endedAt ?? message.createdAt, interrupted: true } : part),
    live: snap.phase === 'running' && message.author === 'hemi' && index === list.length - 1,
    streaming: snap.phase === 'running' && message.author === 'hemi' && index === list.length - 1 && !snap.activity?.phase.startsWith('waiting-'),
  })), [snap.conversation, snap.phase, snap.activity, snap.endedAt]);
  return (
    <section
      ref={container}
      className="h25-process-conversation desktop-conversation-flow"
      aria-label="子 agent 对话流"
      data-task-conversation={id}
    >
      <ConversationFlow
        scope={scope} messages={messages} host={host}
        active={appearance.activity.visible}
        appearance={{ tokens }}
        state={{ readOnly: true, busy: snap.phase !== 'terminal', runActivity: snap.activity ?? undefined,
          notice: [snap.conversation?.truncated ? '执行内容过长，部分内容已省略。' : '', snap.phase === 'terminal' ? snap.outcomeReason : ''].filter(Boolean).join('\n') || undefined }}
        onAction={onAction}
      />
    </section>
  );
}
