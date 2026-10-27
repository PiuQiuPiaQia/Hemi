import { useEffect, useState, type ReactNode } from 'react';
import type { TaskStateSnapshot, TurnPart } from '@/shared/types';

/** Controls deliberately live outside the product UI, for dev/built lifecycle verification. */
export function SubagentConversationFixture({ base, render }: { base: TaskStateSnapshot; render: (snap: TaskStateSnapshot) => ReactNode }) {
  const [stage, setStage] = useState('thinking');
  const [thinkingText, setThinkingText] = useState('我先核对工作区的实际文件，再读回结果确认。');
  useEffect(() => {
    if (stage !== 'thinking') return;
    let count = 0;
    const timer = setInterval(() => {
      count++;
      setThinkingText(text => `${text}\n正在核对第 ${count} 条记录。`);
      if (count >= 8) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [stage]);
  const [t] = useState(() => Date.now() - 15_000);
  const completed = stage === 'complete', stopped = stage === 'stopped', terminal = completed || stopped;
  const second = stage === 'second';
  const id = second ? 'task-conversation-b' : 'task-conversation-a';
  const parts: TurnPart[] = [
    { type: 'thinking', text: second ? '这是第二个子任务的独立思考。' : thinkingText, startedAt: t, endedAt: stage === 'thinking' || second ? null : t + 3000 },
    ...(['tools', 'complete', 'stopped'].includes(stage) ? [
      { type: 'text' as const, text: '已找到需要检查的文件，现在读回确认内容。' },
      { type: 'tools' as const, calls: [{ id: 'read-proof', tool: 'read', args: { path: 'proof.txt' },
        state: completed ? 'done' as const : stopped ? 'stopped' as const : 'running' as const,
        ...(completed ? { output: 'SUBAGENT_PROOF_OK' } : {}) }] },
    ] : []),
  ];
  const messages = [
    { id: `${id}:input`, author: 'user' as const, text: second ? '只检查第二个任务的资料。' : '检查 proof.txt 的内容并报告结果。', createdAt: t },
    { id: `${id}:reply-1`, author: 'hemi' as const, text: '', parts, createdAt: t + 1000 },
    ...(completed ? [{ id: `${id}:reply-2`, author: 'hemi' as const, text: '已读回核对，文件内容为 SUBAGENT_PROOF_OK。', parts: [{ type: 'text' as const, text: '已读回核对，文件内容为 SUBAGENT_PROOF_OK。' }], createdAt: t + 5000 }] : []),
  ];
  const snap: TaskStateSnapshot = { ...base, key: id, taskId: id, agent: 'fixer', agentTitle: '执行', taskText: second ? '第二个独立子任务' : '核对文件内容',
    phase: terminal ? 'terminal' : 'running', outcome: completed ? 'complete' : stopped ? 'stopped' : null,
    progressText: stage === 'tools' ? '正在读取文件' : '正在思考', startedAt: t, endedAt: terminal ? Date.now() : null,
    resultText: completed ? '已读回核对，文件内容为 SUBAGENT_PROOF_OK。' : null,
    conversation: { revision: 1, messages } };
  return <>
    <nav aria-label="子任务验证控制" style={{ position: 'fixed', left: '2vw', bottom: 'var(--sp-16)', zIndex: 9999, display: 'flex', flexWrap: 'wrap', maxWidth: '96vw', gap: 'var(--sp-4)' }}>
      {([['thinking', '思考场景'], ['tools', '工具场景'], ['complete', '完成场景'], ['stopped', '停止场景'], ['second', '切换子任务']] as const).map(([value, label]) =>
        <button key={value} type="button" className="h37-btn h37-btn-ghost h37-btn-sm" onClick={() => setStage(value)}>{label}</button>)}
    </nav>
    {render(snap)}
  </>;
}
