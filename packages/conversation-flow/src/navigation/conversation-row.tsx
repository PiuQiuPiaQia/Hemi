import {useRef, type ReactNode} from 'react';
import {MessageCircle} from 'lucide-react';
import {ConversationStatusIcon, type ConversationStatus} from './conversation-status-icon.js';
import {displayTitle, formatRelative} from './conversation-format.js';
export type ConversationRowView = {
  id: string;
  title: string;
  pinned?: boolean;
  running?: boolean;
  status?: ConversationStatus | null;
  unreadAt?: number | null;
  updatedAt?: number;
  turnCount?: number;
  corrupt?: boolean;
};
export function groupPinnedConversations<T extends ConversationRowView>(items: T[], query = '') {
  const filtered = items.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return [{name: '置顶', pinned: true}, {name: '最近', pinned: false}].map(group => ({...group, items: filtered.filter(item => !!item.pinned === group.pinned)})).filter(group => group.items.length);
}

type RenameProps = {
  title: string;
  draft: string;
  className: string;
  onDraftChange?(value: string): void;
  onCancelEdit?(): void;
  onCommitEdit?(value: string): void;
};
function ConversationRenameInput({title, draft, className, onDraftChange, onCancelEdit, onCommitEdit}: RenameProps) {
  const finished = useRef(false);
  const commit = () => {
    if (finished.current) return;
    finished.current = true;
    const next = draft.trim();
    if (!next || next === title) onCancelEdit?.();
    else onCommitEdit?.(next);
  };
  return <input className={className} value={draft} autoFocus spellCheck={false} aria-label="重命名会话" onChange={event => {finished.current = false; onDraftChange?.(event.target.value);}} onBlur={commit} onKeyDown={event => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {event.preventDefault(); commit();}
    else if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); finished.current = true; onCancelEdit?.();}
  }}/>;
}
export function ConversationRow({item, current = false, onOpen, presentation = 'sidebar', editing = false, draft = '', disabled = false, actions, onDraftChange, onCancelEdit, onCommitEdit, onStartEdit}: {
  item: ConversationRowView;
  current?: boolean;
  onOpen(): void;
  presentation?: 'sidebar' | 'drawer' | 'history';
  disabled?: boolean;
  /** Sibling controls, so touch action buttons never nest inside the open button. */
  actions?: ReactNode;
  editing?: boolean;
  draft?: string;
  onDraftChange?(value: string): void;
  onCancelEdit?(): void;
  onCommitEdit?(value: string): void;
  onStartEdit?(): void;
}) {
  const touch = presentation === 'drawer', history = presentation === 'history';
  if (editing) return <ConversationRenameInput key={item.id} title={item.title} draft={draft} className={history ? 'history-rename' : 'h24-sidebar-rename'} onDraftChange={onDraftChange} onCancelEdit={onCancelEdit} onCommitEdit={onCommitEdit}/>;
  const title = touch ? undefined : item.corrupt ? '这条会话档案损坏，无法打开' : history ? `${item.title}（右键可复制会话 ID 或重命名）` : `${item.title}（${formatRelative(item.updatedAt ?? 0)} · 双击或右键重命名）`;
  const content = <button type="button" className={touch ? 'drawer-row' : history ? 'history-item-main' : 'h24-sidebar-open'} onClick={onOpen} disabled={disabled || !!item.corrupt} aria-current={current ? 'page' : undefined} title={title} onDoubleClick={onStartEdit ? event => {event.preventDefault(); onStartEdit();} : undefined}>
    {touch ? <span className={`conversation-avatar ${item.pinned ? 'is-pinned' : ''}`} aria-hidden="true">{item.pinned ? 'h' : <MessageCircle size={16}/>}</span> : null}
    <span className={touch ? 'drawer-row-title' : history ? 'history-item-text' : 'h24-sidebar-item-text'}>{touch ? item.title : displayTitle(item.title)}</span>
    {!item.corrupt ? touch ? item.status === 'queued' || item.status === 'waiting' ? <ConversationStatusIcon status={item.status}/> : item.running ? <span className="run-dot" role="img" aria-label="任务执行中"/> : null : <ConversationStatusIcon status={item.status} unreadAt={item.unreadAt}/> : null}
    {history ? <span className="history-time">{formatRelative(item.updatedAt ?? 0)} · {item.turnCount ?? 0} 条</span> : null}
  </button>;
  return actions ? <div className={touch ? 'drawer-row-actions' : 'hcf-conversation-row-actions'}>{content}{actions}</div> : content;
}
