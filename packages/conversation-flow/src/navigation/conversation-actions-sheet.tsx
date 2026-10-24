import {useEffect, useId, useRef, useState} from 'react';
import {PencilLine, Trash2} from 'lucide-react';
import {Sheet} from '@hemi/ui';
import type {ConversationRowView} from './conversation-row.js';

/** Touch management surface; the host owns identity, persistence and operation receipts. */
export function ConversationActionsSheet({item, offline = false, onRename, onRemove, onClose, returnFocus}: {
  item: Pick<ConversationRowView, 'id' | 'title' | 'running'>;
  offline?: boolean;
  onRename?(title: string): Promise<void>;
  onRemove?(): Promise<void>;
  onClose(): void;
  returnFocus?: HTMLElement | null;
}) {
  const [mode, setMode] = useState<'actions' | 'rename' | 'delete'>('actions');
  const [title, setTitle] = useState(item.title), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), alive = useRef(true), formId = useId();
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  const close = () => {if (!locked.current) onClose();};
  const perform = async (action: () => Promise<void>) => {
    if (locked.current || offline) return;
    locked.current = true; setBusy(true); setError('');
    try {await action(); if (alive.current) onClose();}
    catch (reason) {if (alive.current) setError(reason instanceof Error ? reason.message : '操作未完成，请核对后重试。');}
    finally {locked.current = false; if (alive.current) setBusy(false);}
  };
  const heading = mode === 'rename' ? '重命名会话' : mode === 'delete' ? '删除会话？' : '会话操作';
  return <Sheet title={heading} onClose={close} returnFocus={returnFocus} footer={mode !== 'actions' ? <div className="split-actions">
    <button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button>
    {mode === 'rename' ? <button type="submit" form={formId} className="primary-button" disabled={busy || offline || !title.trim()}>{busy ? '正在保存…' : '保存'}</button> : <button type="button" className="primary-button conversation-delete" disabled={busy || offline || !onRemove} onClick={() => {if (onRemove) void perform(onRemove);}}>{busy ? '正在删除…' : '确认删除'}</button>}
  </div> : undefined}>
    {mode === 'actions' ? <>
      <p className="body-copy conversation-action-title">{item.title}</p>
      {onRename ? <button type="button" className="selection-row" disabled={offline} onClick={() => setMode('rename')}><PencilLine size={18} aria-hidden="true"/><span>重命名</span></button> : null}
      {onRemove ? <button type="button" className="selection-row conversation-delete" disabled={offline} onClick={() => setMode('delete')}><Trash2 size={18} aria-hidden="true"/><span>删除会话</span></button> : null}
    </> : mode === 'rename' ? <form id={formId} onSubmit={event => {event.preventDefault(); if (onRename && title.trim()) void perform(() => onRename(title.trim()));}}>
      <label className="conversation-name-field">会话名称<input aria-label="会话名称" value={title} maxLength={100} autoFocus disabled={busy || offline} onChange={event => setTitle(event.target.value)} autoComplete="off" enterKeyHint="done"/></label>
    </form> : <p className="body-copy conversation-action-title">将删除「{item.title}」及其 Bot 附件。{item.running ? '正在执行的任务也会停止。' : ''}此操作无法撤销。</p>}
    {offline ? <p className="field-note" role="status">恢复连接后可管理会话。</p> : null}
    {error ? <p className="field-note" role="alert">{error}</p> : null}
  </Sheet>;
}
