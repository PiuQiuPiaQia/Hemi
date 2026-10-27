import {useEffect, useState} from 'react';
import {ErrorState, LoadingState} from '@hemi/ui';
import {Sheet} from './dialog';
import type {MobileWorkspace} from '../workspace';
import type {AgentEnvironmentSnapshot} from '../../../../src/shared/protocol';

/** Read the Bot's original files; never store their body in the client's persistent cache. */
export function RuntimeFilesPanel({workspace, returnFocus, onClose}: {workspace: MobileWorkspace; returnFocus?: HTMLElement|null; onClose(): void}) {
  const [snapshot,setSnapshot]=useState<AgentEnvironmentSnapshot|null>(null);
  const [path,setPath]=useState('MEMORY.md');
  const [text,setText]=useState<string|null>(null);
  const [error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    let active=true;setSnapshot(null);setText(null);setError('');
    void workspace.inspectAgentEnvironment?.().then(value=>{if(active)setSnapshot(value);}).catch(e=>{if(active)setError(e instanceof Error?e.message:'无法读取 Bot 记忆');});
    return()=>{active=false;};
  },[workspace,revision]);
  const selected=snapshot?.files.some(file=>file.path===path)?path:snapshot?.files[0]?.path??'';
  useEffect(()=>{
    let active=true;setText(null);
    if(selected)void workspace.readAgentRuntimeFile?.(selected).then(file=>{if(active)setText(file.text);}).catch(e=>{if(active)setError(e instanceof Error?e.message:'文件读取失败');});
    return()=>{active=false;};
  },[workspace,selected,snapshot]);
  return <Sheet title="Bot 共享记忆" returnFocus={returnFocus} onClose={onClose}>
    <div className="runtime-files-header"><p className="body-copy">这个 Bot 的所有会话和项目共享。</p><button type="button" className="text-button" onClick={()=>setRevision(value=>value+1)}>刷新</button></div>
    {error?<ErrorState description={error}/>:!snapshot?<LoadingState description="正在读取服务器记忆…"/>:<>
      {snapshot.files.length?<>
        <label className="runtime-files-picker">文件<select value={selected} onChange={event=>setPath(event.target.value)}>{snapshot.files.map(file=><option key={file.path} value={file.path}>{file.path==='MEMORY.md'?'长期记忆':file.path==='SCRATCHPAD.md'?'待办':file.path.startsWith('daily/')?`日志 · ${file.path.slice(6,-3)}`:`恢复 · ${file.path.slice(9,-5)}`}</option>)}</select></label>
        {text===null?<LoadingState description="正在读取文件…"/>:<pre className="runtime-files-content">{text||'这个文件还是空的。'}</pre>}
      </>:<p className="body-copy">还没有记忆。可以在对话中告诉 Hemi「记住……」。</p>}
      <p className="body-copy runtime-files-help">修改、遗忘和恢复都在 Bot 对话中完成。恢复已删除内容时，提供恢复记录中的 ID。</p>
    </>}
  </Sheet>;
}
