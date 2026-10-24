import {useEffect, useRef, useState, type FormEvent} from 'react';
import {ArrowUp, ChevronRight, Folder, House, RotateCw} from 'lucide-react';
import type {MobileDirectory, MobileWorkspace} from '../workspace';
import {IconButton, Sheet} from './dialog';

export function DirectoryPanel({workspace, path, defaultPath, recent, saving, offline, error:saveError, onSelect, onClose, returnFocus}: {
  workspace: MobileWorkspace; path: string; defaultPath?: string; recent: string[]; saving: boolean; offline: boolean; error?: string;
  onSelect(path: string): void; onClose(): void; returnFocus?: HTMLElement | null;
}) {
  const [target,setTarget]=useState(path), [input,setInput]=useState(path);
  const [directory,setDirectory]=useState<MobileDirectory|null>(null);
  const [loading,setLoading]=useState(true), [error,setError]=useState(''), [attempt,setAttempt]=useState(0);
  const epoch=useRef(0), inputRevision=useRef(0), pathInput=useRef<HTMLInputElement>(null);
  useEffect(()=>{
    const controller=new AbortController(), current=++epoch.current, revision=inputRevision.current;
    setDirectory(null);setLoading(true);setError('');
    void workspace.listDirectories(target,controller.signal).then(value=>{
      if(controller.signal.aborted||current!==epoch.current)return;
      setDirectory(value);if(inputRevision.current===revision)setInput(value.path);
    }).catch(reason=>{
      if(!controller.signal.aborted&&current===epoch.current)setError(reason instanceof Error?reason.message:'无法读取目录，请重试。');
    }).finally(()=>{if(!controller.signal.aborted&&current===epoch.current)setLoading(false);});
    return()=>{controller.abort();};
  },[workspace,target,attempt]);
  const go=(value:string)=>{
    if(saving||offline)return;
    pathInput.current?.blur();
    ++epoch.current;++inputRevision.current;setDirectory(null);setLoading(true);setError('');setInput(value);setTarget(value);setAttempt(value=>value+1);
  };
  const submit=(event:FormEvent)=>{event.preventDefault();if(input.trim())go(input.trim());};
  const shortcuts=[...new Set([defaultPath,...recent].filter((value):value is string=>!!value))];
  return <Sheet returnFocus={returnFocus} title="选择工作目录" onClose={onClose} footer={<button type="button" className="primary-button full-width" disabled={saving||offline||loading||!directory||input.trim()!==directory.path} onClick={()=>{if(directory)onSelect(directory.path);}}>{saving?'正在保存…':'使用此目录'}</button>}>
    <p className="field-note directory-note">Bot 服务器目录</p>
    {saveError?<p className="workspace-error" role="alert">{saveError}</p>:null}
    <form className="directory-input" onSubmit={submit}>
      <label className="sr-only" htmlFor="directory-path">服务器目录路径</label>
      <input ref={pathInput} id="directory-path" value={input} disabled={saving||offline} onChange={event=>{++inputRevision.current;setInput(event.target.value);}} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="/home/ubuntu/project" enterKeyHint="go"/>
      <button type="submit" className="text-button" disabled={saving||offline||!input.trim()}>前往</button>
    </form>
    <div className="directory-navigation">
      <IconButton label="上一级目录" disabled={saving||offline||loading||!directory||directory.parent===directory.path} onClick={()=>{if(directory)go(directory.parent);}}><ArrowUp size={17}/></IconButton>
      <IconButton label="用户主目录" disabled={saving||offline} onClick={()=>go(directory?.home??'~')}><House size={17}/></IconButton>
      <span>{directory?.path??target}</span>
      <IconButton label="刷新目录" disabled={saving||offline||loading} onClick={()=>go(target)}><RotateCw size={16}/></IconButton>
    </div>
    {shortcuts.length?<div className="directory-shortcuts" aria-label="常用目录">{shortcuts.map(value=><button type="button" disabled={saving||offline} key={value} title={value} onClick={()=>go(value)}>{value===defaultPath?'默认目录':value.split('/').filter(Boolean).at(-1)||'/'}</button>)}</div>:null}
    <div aria-busy={loading} className="directory-results">
      {offline?<p className="field-note" role="status">恢复 Bot 连接后可选择目录。</p>:loading?<p className="field-note" role="status">正在读取目录…</p>:error?<div role="alert"><p className="field-note">{error}</p><button type="button" className="text-button" onClick={()=>go(target)}>重试</button></div>:directory?<>
        {!directory.folders.length?<p className="field-note">没有子文件夹</p>:null}
        {directory.folders.map(folder=><button type="button" className="selection-row directory-row" key={folder.path} disabled={saving} onClick={()=>go(folder.path)}><Folder size={18}/><span>{folder.name}</span><ChevronRight size={16}/></button>)}
        {directory.truncated?<p className="field-note">仅显示部分文件夹，可输入完整路径。</p>:null}
      </>:null}
    </div>
  </Sheet>;
}
