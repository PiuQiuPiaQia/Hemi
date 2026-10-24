import {useEffect, useRef, useState} from 'react';
import {ChevronRight, MessageCircle, Search, Settings, SquarePen, X} from 'lucide-react';
import type {MobileConversation} from '../workspace';
import {IconButton, useDialogFocus} from './dialog';
import brandMark from '../assets/hemi-mark.svg';

export function ConversationDrawer({items, activeId, botName, offline, onSelect, onNew, onSettings, onClose, returnFocus}: {
  items: MobileConversation[]; activeId: string; botName: string; offline: boolean; returnFocus?: HTMLElement | null;
  onSelect(id: string): void; onNew(): void; onSettings(): void; onClose(): void;
}) {
  const dialog = useDialogFocus(onClose, returnFocus), search = useRef<HTMLInputElement>(null), touch = useRef<{x: number; y: number} | null>(null);
  const [searching, setSearching] = useState(false), [query, setQuery] = useState('');
  useEffect(() => { if (searching) search.current?.focus({preventScroll:true}); }, [searching]);
  const filtered = items.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="drawer-layer" onTouchStart={event => {const point = event.touches[0]; touch.current = {x: point.clientX, y: point.clientY};}} onTouchEnd={event => {
    const point = event.changedTouches[0], start = touch.current; touch.current = null;
    if (start && start.x - point.clientX > 60 && Math.abs(point.clientY - start.y) < (start.x - point.clientX) * .65) onClose();
  }} onTouchCancel={() => {touch.current = null;}}>
    <button type="button" className="drawer-backdrop" aria-label="收起对话列表" tabIndex={-1} onClick={onClose}/>
    <section {...dialog} className="conversation-drawer" role="dialog" aria-modal="true" aria-label="对话列表" tabIndex={-1}>
      <header className="drawer-heading"><strong>Hemi</strong><IconButton label={searching ? '关闭搜索' : '搜索对话'} onClick={() => {setSearching(value => !value); setQuery('');}}>{searching ? <X size={18}/> : <Search size={18}/>}</IconButton></header>
      {searching ? <label className="drawer-search"><Search size={16}/><input ref={search} aria-label="搜索对话标题" placeholder="搜索对话" value={query} onChange={event => setQuery(event.target.value)}/></label> : null}
      <button type="button" className="drawer-new" onClick={onNew}><SquarePen size={18}/><span>新对话</span></button>
      <nav className="drawer-list" aria-label="历史对话">
        {[{name: '置顶', pinned: true}, {name: '最近', pinned: false}].map(group => {
          const rows = filtered.filter(item => Boolean(item.pinned) === group.pinned);
          return rows.length ? <section className="drawer-group" key={group.name}><h2>{group.name}</h2>{rows.map(item => <button type="button" key={item.id} className="drawer-row" aria-current={item.id === activeId ? 'page' : undefined} onClick={() => onSelect(item.id)}><span className={`conversation-avatar ${item.pinned ? 'is-pinned' : ''}`} aria-hidden="true">{item.pinned ? 'h' : <MessageCircle size={16}/>}</span><span className="drawer-row-title">{item.title}</span>{item.running ? <span className="run-dot" role="img" aria-label="任务执行中"/> : null}</button>)}</section> : null;
        })}
        {!filtered.length ? <p className="drawer-empty">没有找到相关对话</p> : null}
      </nav>
      <footer className="drawer-footer"><button type="button" className="drawer-bot" onClick={onSettings}><span className="drawer-bot-avatar" aria-hidden="true"><img src={brandMark} alt=""/></span><span><strong>{botName}</strong><small>{offline ? '连接已断开' : '已连接'}</small></span><ChevronRight size={16}/></button><IconButton label="Bot 连接设置" onClick={onSettings}><Settings size={18}/></IconButton></footer>
    </section>
  </div>;
}
