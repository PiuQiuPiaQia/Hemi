import {useEffect,useRef,useState} from 'react';
import {ChevronRight,MessageCircle,Search,Settings,SquarePen,X} from 'lucide-react';
import {IconButton} from './panels';

export function ConversationDrawer({items,activeId,connection,offline,onSelect,onNew,onSettings,onClose}) {
  const node=useRef(null),search=useRef(null),touch=useRef(null);
  const [searching,setSearching]=useState(false),[query,setQuery]=useState('');
  useEffect(()=>{
    const previous=document.activeElement;node.current?.focus();
    return()=>{requestAnimationFrame(()=>{if(previous?.isConnected&&!previous.closest('[inert]')&&!previous.closest('.device-screen')?.querySelector('[aria-modal="true"]'))previous.focus();});};
  },[]);
  useEffect(()=>{if(searching)search.current?.focus();},[searching]);
  const keyboard=event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();return;}
    if(event.key!=='Tab')return;
    const targets=[...node.current.querySelectorAll('button:not(:disabled),input')],first=targets[0],last=targets.at(-1);
    if(event.shiftKey&&(document.activeElement===first||document.activeElement===node.current)){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===node.current)){event.preventDefault();first?.focus();}
  };
  const filtered=items.filter(item=>item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="drawer-layer" onTouchStart={event=>{const point=event.touches[0];touch.current={x:point.clientX,y:point.clientY};}} onTouchEnd={event=>{const point=event.changedTouches[0],start=touch.current;touch.current=null;if(start&&start.x-point.clientX>60&&Math.abs(point.clientY-start.y)<Math.abs(point.clientX-start.x)*.65)onClose();}} onTouchCancel={()=>{touch.current=null;}}>
    <button className="drawer-backdrop" aria-label="收起对话列表" tabIndex={-1} onClick={onClose}/>
    <section ref={node} className="conversation-drawer" role="dialog" aria-modal="true" aria-label="对话列表" tabIndex={-1} onKeyDown={keyboard}>
      <header className="drawer-heading"><span className="wordmark">Hemi</span><IconButton label={searching?'关闭搜索':'搜索对话'} onClick={()=>{setSearching(value=>!value);setQuery('');}}>{searching?<X size={21}/>:<Search size={21}/>}</IconButton></header>
      {searching&&<label className="drawer-search"><Search size={17}/><input ref={search} aria-label="搜索对话标题" placeholder="搜索对话" value={query} onChange={event=>setQuery(event.target.value)}/></label>}
      <button className="drawer-new" onClick={onNew}><SquarePen size={22}/><span>新对话</span></button>
      <nav className="drawer-list" aria-label="历史对话">
        {[{name:'置顶',pinned:true},{name:'最近',pinned:false}].map(group=>{
          const rows=filtered.filter(item=>Boolean(item.pinned)===group.pinned);
          return rows.length>0&&<section className="drawer-group" key={group.name}><h2>{group.name}</h2>{rows.map(item=><button key={item.id} className="drawer-row" aria-current={item.id===activeId?'page':undefined} onClick={()=>onSelect(item.id)}><span className={`conversation-avatar ${item.pinned?'is-pinned':''}`} aria-hidden="true">{item.pinned?'h':<MessageCircle size={17}/>}</span><span className="drawer-row-title">{item.title}</span>{item.running&&<span className="run-dot" role="img" aria-label="任务执行中"/>}</button>)}</section>;
        })}
        {!filtered.length&&<p className="drawer-empty">没有找到相关对话</p>}
      </nav>
      <footer className="drawer-footer"><button className="drawer-bot" onClick={onSettings}><span className="drawer-bot-avatar" aria-hidden="true">h</span><span><strong>Hemi Bot</strong><small><i className={`connection-dot ${offline?'offline':''}`}/>{offline?'连接已断开':connection.host}</small></span><ChevronRight size={15}/></button><IconButton label="Bot 连接设置" onClick={onSettings}><Settings size={21}/></IconButton></footer>
    </section>
  </div>;
}
