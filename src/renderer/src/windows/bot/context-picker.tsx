import {useEffect, useState} from 'react';
import type {BotBridge} from '@shared/bot';
import type {MessageAttachmentView} from '@shared/protocol';
import {BotButton, BotDialog} from './dialogs';

type WindowApp = {pid: number; bundleId: string; name: string; windows: Array<{windowId: string; title: string}>};

export function BotContextPicker({api, instanceId, conversationId, onClose, onFile, onAttached}: {
  api: BotBridge; instanceId: string; conversationId: string; onClose: () => void; onFile: () => void;
  onAttached: (attachment: MessageAttachmentView) => Promise<void>;
}) {
  const [apps, setApps] = useState<WindowApp[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void api.command<{apps: WindowApp[]}>('context.windows', {expectedInstanceId: instanceId}).then(result => {
      if (active) setApps(result.apps);
    }).catch(cause => {if (active) setError(cause instanceof Error ? cause.message : '无法读取 Windows 窗口。');});
    return () => {active = false;};
  }, [api, instanceId]);
  const capture = async (app: WindowApp, windowId: string) => {
    if (busy) return;setBusy(true);setError('');
    try {
      const result = await api.command<{attachment: MessageAttachmentView}>('context.capture', {
        expectedInstanceId: instanceId, id: conversationId, target: {pid: app.pid, bundleId: app.bundleId, windowId},
      });
      await onAttached(result.attachment);onClose();
    } catch (cause) {setError(cause instanceof Error ? cause.message : '无法添加窗口截图。');}
    finally {setBusy(false);}
  };
  return <BotDialog title="添加资料" busy={busy} onClose={onClose} footer={<BotButton disabled={busy} onClick={onFile}>选择本机文件</BotButton>}>
    <p>选择 Bot 主机上的 Windows 窗口，将当前截图和界面文字加入这条消息。</p>
    {apps === null && !error ? <p role="status">正在读取远端窗口…</p> : null}
    {apps?.length === 0 ? <p role="status">没有可用窗口。</p> : null}
    <div className="h-bot-context-windows">{apps?.flatMap(app => app.windows.map(window => <button className="h37-btn h37-btn-secondary" type="button" key={`${app.pid}:${window.windowId}`} disabled={busy} onClick={() => void capture(app, window.windowId)}><strong>{app.name}</strong><span>{window.title || '无标题窗口'}</span></button>))}</div>
    {busy ? <p role="status">正在读取所选窗口…</p> : null}
    {error ? <p className="h-bot-error" role="alert">{error}</p> : null}
  </BotDialog>;
}
