import {useLayoutEffect, useRef, type FormEvent, type ReactNode} from 'react';
import {ArrowUp, Plus, Square} from 'lucide-react';
import {IconButton} from './components/dialog';

export function Composer({busy, offline, blocked, stopBlocked, text, onText, onSend, onStop, onAdd, hasAttachments = false, addBlocked = false, editingQueue, onCancelQueueEdit, children, controls}: {
  hasAttachments?: boolean; addBlocked?: boolean;
  busy: boolean; offline: boolean; blocked: boolean; stopBlocked: boolean; text: string; editingQueue?: boolean; children?: ReactNode; controls?: ReactNode;
  onText(text: string): void; onSend(): void; onStop(): void; onAdd(): void; onCancelQueueEdit?(): void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {const node = input.current!; node.style.height = 'auto'; node.style.height = `${Math.min(128, Math.max(40, node.scrollHeight))}px`;}, [text]);
  function submit(event: FormEvent) { event.preventDefault(); if ((text.trim() || hasAttachments) && !blocked) onSend(); }
  return <div className="input-dock"><div className="composer-surface">
    {editingQueue ? <div className="composer-editing" role="status"><span>正在修改待发送消息</span><button type="button" className="text-button" disabled={blocked} onClick={onCancelQueueEdit}>取消</button></div> : null}
    {children}
    <form className="mobile-composer" onSubmit={submit} aria-label="消息输入区">
      <label className="sr-only" htmlFor="message-input">消息</label>
      <textarea ref={input} id="message-input" rows={1} value={text} onChange={event => onText(event.target.value)} onKeyDown={event => {
        if (!event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {event.preventDefault(); if ((text.trim() || hasAttachments) && !blocked) onSend();}
      }} placeholder={editingQueue ? '修改待发送消息…' : offline ? '连接恢复后发送…' : '发送消息…'} enterKeyHint="enter"/>
      <div className="composer-toolbar"><IconButton label="添加内容" disabled={addBlocked} onClick={onAdd}><Plus size={20}/></IconButton>{controls?<div className="composer-options">{controls}</div>:<span className="toolbar-spacer"/>}
        {busy ? <IconButton label="停止任务" className="stop-control" disabled={offline || stopBlocked} onClick={onStop}><Square size={14}/></IconButton> : null}
        <button className="send-control" type="submit" disabled={(!text.trim() && !hasAttachments) || blocked} aria-label={editingQueue ? '保存修改' : busy ? '加入待发送' : '发送消息'}><ArrowUp size={20}/></button>
      </div>
    </form>
  </div></div>;
}
