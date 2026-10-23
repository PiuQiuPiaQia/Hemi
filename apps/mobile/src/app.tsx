import { useEffect, useMemo, useState } from 'react';
import { ConversationFlow } from '@hemi/conversation-flow';
import { createConversationActionHandler, createConversationPresenter, projectConversationQueue, queueStoppedIdle } from '@hemi/conversation-flow/core';
import { useConversation } from '@hemi/conversation-flow/react';
import { ConversationFlowProvider, TurnQueueTray } from '@hemi/conversation-flow/parts';
import { Composer } from './composer';
import { createDemoSession } from './demo-session';
import { createMobileHost } from './host/capacitor-host';

export function App() {
  const host = useMemo(createMobileHost, []);
  const [session] = useState(createDemoSession);
  const client = session.client;
  const sessionState = useConversation(client);
  useEffect(() => session.retain(), [session]);
  const [page, setPage] = useState<'conversation' | 'connection' | 'notices'>('conversation');
  const [demoOffline, setDemoOffline] = useState(false);
  const present = useMemo(createConversationPresenter, []);
  const messages = useMemo(() => present(sessionState.snapshot), [present, sessionState.snapshot]);
  const scope = useMemo(() => ({...client.scope, generation: String(sessionState.snapshot?.generation ?? 1)}), [client, sessionState.snapshot?.generation]);
  const onAction = useMemo(() => createConversationActionHandler(client), [client]);
  const busy = Boolean(sessionState.snapshot && sessionState.snapshot.phase !== 'idle');
  const queue = useMemo(() => projectConversationQueue(sessionState.snapshot, sessionState.operations), [sessionState.snapshot, sessionState.operations]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => document.documentElement.style.setProperty('--app-height', `${viewport?.height ?? window.innerHeight}px`);
    resize(); viewport?.addEventListener('resize', resize); window.addEventListener('resize', resize);
    return () => { viewport?.removeEventListener('resize', resize); window.removeEventListener('resize', resize); document.documentElement.style.removeProperty('--app-height'); };
  }, []);

  return (
    <main className="mobile-shell">
      <header className="app-header">
        <div className="brand"><span className="brand-mark" aria-hidden="true">h</span><strong>Hemi</strong></div>
        <button className="plain-button" onClick={() => setPage(page === 'conversation' ? 'connection' : 'conversation')}>
          {page === 'conversation' ? 'Bot 连接' : '返回对话'}
        </button>
      </header>
      {page === 'conversation' ? <>
        <div className="conversation-heading"><h1>移动端预览</h1><span className="status-label">离线演示</span></div>
        <section className="flow-frame" aria-label="对话记录">
          <ConversationFlow scope={scope} messages={messages} host={host} onAction={onAction}
            state={{ busy, notice: sessionState.error || undefined }} />
        </section>
        <section className="queue-frame" aria-label="发送队列">
          <ConversationFlowProvider scope={scope} host={host} onAction={onAction} part>
            <TurnQueueTray state={queue} stoppedIdle={queueStoppedIdle(sessionState.snapshot)}
              onWithdraw={async id => {
                const operation = queue.items.find(item => item.queueItemId === id)?.operationId;
                if (operation) await client.cancelWaiting(operation);
                else await client.sendCommand({type: 'withdrawInput', inputId: id});
              }}
              onResume={() => { void client.sendCommand({type: 'resumeQueue'}); }}
              onContinue={() => { void client.sendCommand({type: 'send', input: {text: '继续', inputSource: 'text', attachmentIds: []}}); }} />
          </ConversationFlowProvider>
        </section>
        <Composer busy={busy} text={sessionState.draft.text} onText={client.draft.setText}
          onSend={() => { void client.sendDraft(); }} onStop={() => { void client.sendCommand({type: 'stop', targetRunId: sessionState.snapshot?.activeRunId}); }} />
      </> : page === 'connection' ? <section className="connection-page">
        <span className="eyebrow">HEMI MOBILE</span>
        <h1>随时回到你的 Bot。</h1>
        <p>连接已有的云端 Bot，查看对话，继续任务。计算和任务执行留在你的服务器上。</p>
        <div className="connection-status"><strong>Bot 尚未接入</strong><p>当前版本提供移动端工程与离线对话预览。真实连接功能将在下一步接入。</p></div>
        <button className="plain-button" onClick={() => {
          const next = !demoOffline;
          setDemoOffline(next); session.setOffline(next);
        }}>{demoOffline ? '恢复演示连接' : '模拟断线'}</button>
        <button className="primary text-button" onClick={() => setPage('conversation')}>体验对话流</button>
        <button className="plain-button notices-button" onClick={() => setPage('notices')}>开源许可</button>
      </section> : <section className="notices-page">
        <h1>开源许可</h1>
        <iframe title="第三方开源许可" src="./licenses/notices.txt" />
      </section>}
    </main>
  );
}
