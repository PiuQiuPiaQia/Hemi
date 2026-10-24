import { useEffect, useRef, useState, useId, type FormEvent } from 'react';
import { ArrowUp, ChevronRight, Folder, House, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
export type DirectoryView = {
    path: string;
    parent: string;
    home: string;
    folders: Array<{
        name: string;
        path: string;
    }>;
    truncated?: boolean;
};
export type DirectorySurfaceProps = {
    title: string;
    children: ReactNode;
    footer: ReactNode;
};
import {EmptyState, ErrorState, LoadingState, IconButton, Sheet} from '@hemi/ui';
export function DirectoryPicker({ load, path, defaultPath, recent, saving, offline, error: saveError, onSelect, onClose, returnFocus, renderSurface, presentation = 'sheet', hostLabel }: {
    load(path: string, signal: AbortSignal): Promise<DirectoryView>;
    renderSurface?(props: DirectorySurfaceProps): ReactNode;
    presentation?: 'sheet' | 'dialog';
    hostLabel?: string;
    path: string;
    defaultPath?: string;
    recent: string[];
    saving: boolean;
    offline: boolean;
    error?: string;
    onSelect(path: string): void;
    onClose(): void;
    returnFocus?: HTMLElement | null;
}) {
    const [target, setTarget] = useState(path), [input, setInput] = useState(path);
    const [directory, setDirectory] = useState<DirectoryView | null>(null);
    const [loading, setLoading] = useState(true), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
    const pathId = useId();
    const loader = useRef(load);
    loader.current = load;
    const epoch = useRef(0), inputRevision = useRef(0), pathInput = useRef<HTMLInputElement>(null);
    useEffect(() => {
        const controller = new AbortController(), current = ++epoch.current, revision = inputRevision.current;
        if (offline) {
            setDirectory(null);
            setLoading(false);
            return () => controller.abort();
        }
        setDirectory(null);
        setLoading(true);
        setError('');
        void loader.current(target, controller.signal).then(value => {
            if (controller.signal.aborted || current !== epoch.current)
                return;
            setDirectory(value);
            if (inputRevision.current === revision)
                setInput(value.path);
        }).catch(reason => {
            if (!controller.signal.aborted && current === epoch.current)
                setError(reason instanceof Error ? reason.message : '无法读取目录，请重试。');
        }).finally(() => { if (!controller.signal.aborted && current === epoch.current)
            setLoading(false); });
        return () => { controller.abort(); };
    }, [target, attempt, offline]);
    const go = (value: string) => {
        if (saving || offline)
            return;
        pathInput.current?.blur();
        ++epoch.current;
        ++inputRevision.current;
        setDirectory(null);
        setLoading(true);
        setError('');
        setInput(value);
        setTarget(value);
        setAttempt(value => value + 1);
    };
    const submit = (event: FormEvent) => { event.preventDefault(); if (input.trim())
        go(input.trim()); };
    const shortcuts = [...new Set([defaultPath, ...recent].filter((value): value is string => !!value))];
    const footer = <button type="button" className="primary-button full-width" disabled={saving || offline || loading || !directory || input.trim() !== directory.path} onClick={() => { if (directory)
        onSelect(directory.path); }}>{saving ? '正在保存…' : '使用此目录'}</button>;
    const content = <>
    <p className="field-note directory-note">Bot 服务器目录</p>
    {saveError ? <ErrorState description={saveError} descriptionClassName="field-note"/> : null}
    <form className="directory-input" onSubmit={submit}>
      <label className="sr-only" htmlFor={pathId}>服务器目录路径</label>
      <input ref={pathInput} id={pathId} value={input} disabled={saving || offline} onChange={event => { ++inputRevision.current; setInput(event.target.value); }} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="/home/ubuntu/project" enterKeyHint="go"/>
      <button type="submit" className="text-button" disabled={saving || offline || !input.trim()}>前往</button>
    </form>
    <div className="directory-navigation">
      <IconButton label="上一级目录" disabled={saving || offline || loading || !directory || directory.parent === directory.path} onClick={() => { if (directory)
        go(directory.parent); }}><ArrowUp size={17}/></IconButton>
      <IconButton label="用户主目录" disabled={saving || offline} onClick={() => go(directory?.home ?? '~')}><House size={17}/></IconButton>
      <span>{directory?.path ?? target}</span>
      <IconButton label="刷新目录" disabled={saving || offline || loading} onClick={() => go(target)}><RotateCw size={16}/></IconButton>
    </div>
    {shortcuts.length ? <div className="directory-shortcuts" aria-label="常用目录">{shortcuts.map(value => <button type="button" className="h-bot-btn" disabled={saving || offline} key={value} title={value} onClick={() => go(value)}>{value === defaultPath ? '默认目录' : value.split('/').filter(Boolean).at(-1) || '/'}</button>)}</div> : null}
    <div aria-busy={loading} className="directory-results">
      {offline ? <p className="field-note" role="status">恢复 Bot 连接后可选择目录。</p> : loading ? <LoadingState description="正在读取目录…" descriptionClassName="field-note"/> : error ? <ErrorState description={error} descriptionClassName="field-note" actions={[{label:'重试',className:'text-button',onAction:()=>go(target)}]}/> : directory ? <>
        {!directory.folders.length ? <p className="field-note">没有子文件夹</p> : null}
        {directory.folders.map(folder => <button type="button" className="selection-row directory-row" key={folder.path} disabled={saving} onClick={() => go(folder.path)}><Folder size={18}/><span>{folder.name}</span><ChevronRight size={16}/></button>)}
        {directory.truncated ? <p className="field-note">仅显示部分文件夹，可输入完整路径。</p> : null}
      </> : null}
    </div>
  </>;
    if (presentation === 'dialog') {
        const parent = directory?.parent ?? '/';
        const dialogContent = <>
      <p className="h-bot-host">{hostLabel}</p>
      <form className="h-bot-address" onSubmit={submit}><button type="button" className="icon-btn" aria-label="上级目录" disabled={saving || loading || offline || directory?.path === '/'} onClick={() => go(parent)}><ArrowUp size={16}/></button><input ref={pathInput} aria-label="云端文件夹路径" value={input} disabled={saving} onChange={event => { ++inputRevision.current; setInput(event.target.value); }}/><button type="button" className="h-bot-btn" disabled={saving || offline} onClick={() => go(input)}>前往</button></form>
      <div className="h-bot-shortcuts">{defaultPath ? <button type="button" className="h-bot-btn" disabled={saving || offline} onClick={() => go(defaultPath)}>默认空间</button> : null}<button type="button" className="h-bot-btn" disabled={saving || offline} onClick={() => go(directory?.home ?? '~')}>主目录</button>{recent.slice(0, 3).map(dir => <button type="button" className="h-bot-btn" key={dir} disabled={saving || offline} title={dir} onClick={() => go(dir)}>{dir.split('/').at(-1)}</button>)}</div>
      {saveError ? <p role="alert">{saveError}</p> : null}
      <div className="h-bot-folders" aria-label="云端目录列表" aria-busy={loading}>{offline ? <p role="status">连接已断开，恢复连接后重新读取目录。</p> : loading ? <LoadingState description="正在读取服务器文件夹…"/> : error ? <ErrorState description={error} actions={[{label:'重试',disabled:offline,onAction:()=>go(target)}]}/> : directory?.folders.length ? directory.folders.map(folder => <button type="button" key={folder.path} disabled={saving} onClick={() => go(folder.path)}><Folder size={16}/><span>{folder.name}</span><ChevronRight size={14}/></button>) : <EmptyState description="此文件夹没有子文件夹"/>}</div>
    </>;
        return renderSurface?.({ title: '选择云端文件夹', children: dialogContent, footer: <><button type="button" className="h-bot-btn" disabled={saving} onClick={onClose}>取消</button><button type="button" className="h-bot-btn primary" disabled={saving || offline || loading || !directory || input !== directory.path} onClick={() => { if (directory)
                onSelect(directory.path); }}>{saving ? '正在设置…' : '使用此文件夹'}</button></> });
    }
    return <Sheet returnFocus={returnFocus} title="选择工作目录" onClose={onClose} footer={footer}>{content}</Sheet>;
}
