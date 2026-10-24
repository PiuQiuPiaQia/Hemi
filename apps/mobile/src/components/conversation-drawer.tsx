import {EmptyState} from '@hemi/ui';
import {ConversationActionsSheet, ConversationList, ConversationRow, groupPinnedConversations} from '@hemi/conversation-flow/navigation';
import {useEffect, useRef, useState} from 'react';
import {ChevronRight, MoreHorizontal, Search, Settings, SquarePen, X} from 'lucide-react';
import type {MobileConversation} from '../workspace';
import {IconButton, useDialogFocus} from './dialog';
import brandMark from '../assets/hemi-mark.svg';

export function ConversationDrawer({items, activeId, botName, offline, onSelect, onNew, onSettings, onClose, onRename, onRemove, returnFocus}: {
  items: MobileConversation[]; activeId: string; botName: string; offline: boolean; returnFocus?: HTMLElement | null;
  onSelect(id: string): void; onNew(): void; onSettings(): void; onClose(): void;
  onRename?(id: string, title: string): Promise<void>; onRemove?(id: string): Promise<void>;
}) {
  const dialog = useDialogFocus(onClose, returnFocus), search = useRef<HTMLInputElement>(null), touch = useRef<{x: number; y: number} | null>(null);
  const [searching, setSearching] = useState(false), [query, setQuery] = useState('');
  const [actionItem, setActionItem] = useState<MobileConversation|null>(null);
  const actionTrigger = useRef<HTMLElement|null>(null);
  useEffect(() => {
    if (actionItem || !actionTrigger.current) return;
    const frame = requestAnimationFrame(() => {
      const surface = dialog.ref.current;
      if (surface && !surface.contains(document.activeElement)) {
        const trigger = actionTrigger.current;
        (trigger?.isConnected ? trigger : surface).focus({preventScroll:true});
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [actionItem]);
  useEffect(() => { if (searching) search.current?.focus({preventScroll:true}); }, [searching]);
  const groups = groupPinnedConversations(items,query);
  return <div className="drawer-layer" onTouchStart={event => {if(actionItem)return;const point = event.touches[0]; touch.current = {x: point.clientX, y: point.clientY};}} onTouchEnd={event => {
    if(actionItem)return;
    const point = event.changedTouches[0], start = touch.current; touch.current = null;
    if (start && start.x - point.clientX > 60 && Math.abs(point.clientY - start.y) < (start.x - point.clientX) * .65) onClose();
  }} onTouchCancel={() => {touch.current = null;}}>
    <button type="button" className="drawer-backdrop" aria-label="收起对话列表" tabIndex={-1} onClick={onClose}/>
    <section {...dialog} className="conversation-drawer" role="dialog" aria-modal="true" aria-label="对话列表" tabIndex={-1} inert={actionItem?true:undefined}>
      <header className="drawer-heading"><strong>Hemi</strong><IconButton label={searching ? '关闭搜索' : '搜索对话'} onClick={() => {setSearching(value => !value); setQuery('');}}>{searching ? <X size={18}/> : <Search size={18}/>}</IconButton></header>
      {searching ? <label className="drawer-search"><Search size={16}/><input ref={search} aria-label="搜索对话标题" placeholder="搜索对话" value={query} onChange={event => setQuery(event.target.value)}/></label> : null}
      <button type="button" className="drawer-new" onClick={onNew}><SquarePen size={18}/><span>新对话</span></button>
      <ConversationList as="nav" className="drawer-list" label="历史对话" groupClassName="drawer-group" groups={groups.map(group=>({key:group.name,label:group.name,items:group.items}))} empty={<EmptyState className="drawer-empty" description="没有找到相关对话"/>} renderItem={item=><ConversationRow item={item} current={item.id===activeId} onOpen={()=>onSelect(item.id)} presentation="drawer" actions={onRename||onRemove?<IconButton label={`会话操作：${item.title}`} aria-haspopup="dialog" onClick={event=>{actionTrigger.current=event.currentTarget;setActionItem(item);}}><MoreHorizontal size={18}/></IconButton>:undefined}/>}/>
      <footer className="drawer-footer"><button type="button" className="drawer-bot" onClick={onSettings}><span className="drawer-bot-avatar" aria-hidden="true"><img src={brandMark} alt=""/></span><span><strong>{botName}</strong><small>{offline ? '连接已断开' : '已连接'}</small></span><ChevronRight size={16}/></button><IconButton label="Bot 连接设置" onClick={onSettings}><Settings size={18}/></IconButton></footer>
    </section>
    {actionItem?<ConversationActionsSheet key={actionItem.id} item={items.find(item=>item.id===actionItem.id)??actionItem} offline={offline} returnFocus={actionTrigger.current} onClose={()=>setActionItem(null)} onRename={onRename?title=>onRename(actionItem.id,title):undefined} onRemove={onRemove?()=>onRemove(actionItem.id):undefined}/>:null}
  </div>;
}
