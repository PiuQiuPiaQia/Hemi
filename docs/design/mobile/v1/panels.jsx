import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,Check,ChevronRight,File,Folder,KeyRound,Plus,ScanLine,Server,ShieldCheck,ShieldAlert,Upload,X} from 'lucide-react';

export function IconButton({label,children,...props}) {
  return <button type="button" className="icon-control" aria-label={label} title={label} {...props}>{children}</button>;
}
export function Sheet({title,children,onClose,footer,className=''}) {
  const node=useRef(null);
  useEffect(()=>{
    const previous=document.activeElement;node.current?.focus();
    return()=>{if(previous?.isConnected)previous.focus();};
  },[]);
  const keyboard=event=>{
    if(event.key==='Escape'){event.stopPropagation();onClose();}
    if(event.key!=='Tab')return;
    const focusable=[...node.current.querySelectorAll('button:not(:disabled),input,textarea,[tabindex="0"]')];
    const first=focusable[0], last=focusable.at(-1);
    if(!first)return;
    if(event.shiftKey&&(document.activeElement===first||document.activeElement===node.current)){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===node.current)){event.preventDefault();first.focus();}
  };
  return <div className="modal-layer"><button className="sheet-backdrop" aria-label="关闭面板" onClick={onClose}/>
    <section ref={node} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={keyboard} className={`bottom-sheet ${className}`}>
      <div className="sheet-grabber" aria-hidden="true"/><header className="sheet-heading"><h2>{title}</h2><IconButton label="关闭" onClick={onClose}><X size={20}/></IconButton></header>
      <div className="sheet-content">{children}</div>{footer&&<footer className="sheet-footer">{footer}</footer>}
    </section></div>;
}
export function Connection({trusted,onContinue,onBack,connection,onScan}) {
  const [imported,setImported]=useState(false);
  return <section className="connection-screen">
    <header className="simple-header">{onBack?<IconButton label="返回对话" onClick={onBack}><ArrowLeft size={21}/></IconButton>:<span className="wordmark">Hemi</span>}<span className="quiet">连接</span></header>
    <div className="connect-scroll"><div className="connect-mark"><span>h</span><span className="connection-link"/><Server size={27}/></div>
      <h1>把你的 Bot<br/>带在身边。</h1><p className="lead">连接已有的云端 Bot，<br/>随时查看进展，继续对话。</p>
      <button className="scan-connect" onClick={onScan}><ScanLine size={20}/><span><strong>扫码连接已有 Bot</strong><small>在已连接设备上生成配对码</small></span><ChevronRight size={17}/></button><p className="manual-label">或手动填写连接信息</p>
      <form onSubmit={event=>{event.preventDefault();const fields=new FormData(event.currentTarget);onContinue({host:String(fields.get('host')).trim(),user:String(fields.get('user')).trim(),port:String(fields.get('port'))});}}>
        <label className="form-label">服务器地址<input required name="host" defaultValue={connection.host} autoCapitalize="none" spellCheck={false} autoComplete="off"/></label>
        <div className="form-columns"><label className="form-label">用户名<input required name="user" defaultValue={connection.user} autoCapitalize="none" autoComplete="off"/></label><label className="form-label narrow">端口<input required name="port" inputMode="numeric" pattern="[0-9]+" defaultValue={connection.port} autoComplete="off"/></label></div>
        <button type="button" className="credential-row" data-imported={imported} onClick={()=>setImported(true)}><KeyRound size={19}/><span>{imported?'演示私钥已导入':'导入 SSH 私钥'}</span>{imported?<Check size={17}/>:<Upload size={17}/>}</button>
        <p className="field-note">认证信息仅保存在这台手机的安全存储中。</p>
        <button className="primary-button full-width" type="submit" disabled={!imported}>{trusted?'重新连接':'继续'}</button>
      </form>
      <p className="connect-foot">先在桌面端完成 Bot 初始化。<br/>手机连接已有 Bot，无需额外服务。</p>
    </div>
  </section>;
}
export function TrustPanel({onClose,onConfirm,connection}) {
  return <Sheet title="核对服务器身份" onClose={onClose} footer={<><button className="primary-button full-width" onClick={onConfirm}>信任并连接</button><button className="text-button full-width" onClick={onClose}>返回修改</button></>}>
    <span className="status-symbol"><ShieldCheck size={28}/></span><h3 className="sheet-title">首次连接这台服务器</h3>
    <p className="body-copy">请先与服务器上的 SSH 指纹核对，确认是你要连接的设备。</p>
    <dl className="identity-detail"><div><dt>服务器</dt><dd>{connection.host}:{connection.port}</dd></div><div><dt>账号</dt><dd>{connection.user}</dd></div></dl>
    <p className="form-label">ED25519 指纹</p><code className="fingerprint">SHA256:Qe7n4vD3m8bR9uL2s5wP0cF6hJ1kT8xY4zA3eV9gN2M</code>
  </Sheet>;
}
export function IdentityPanel({onClose,onSettings}) {
  return <Sheet title="无法确认服务器身份" onClose={onClose} footer={<button className="primary-button full-width" onClick={onSettings}>查看连接设置</button>}>
    <span className="status-symbol danger"><ShieldAlert size={28}/></span><h3 className="sheet-title">服务器指纹发生了变化</h3><p className="body-copy">可能是服务器重装或地址变更。请先核对身份，确认之前不会继续连接。</p>
    <dl className="identity-detail"><div><dt>服务器</dt><dd>cloud.example.com</dd></div></dl><p className="field-note">你的历史缓存和草稿仍保留在手机上。</p>
  </Sheet>;
}
export function ModelPanel({value,onSelect,onClose}) {
  return <Sheet title="选择模型" onClose={onClose}><p className="body-copy">使用 Bot 上已经配置好的模型。</p>
    {['工作模型','轻量模型'].map((name,index)=><button className="selection-row" key={name} onClick={()=>onSelect(name)}><span className="model-mark">{index?'L':'H'}</span><span><strong>{name}</strong><small>{index?'用于简短回复和日常整理':'用于项目分析和复杂任务'}</small></span>{value===name&&<Check size={19} className="selected-check"/>}</button>)}
    <p className="field-note separated">添加或同步模型，请前往桌面端的 Bot 设置。</p>
  </Sheet>;
}
export function FolderPanel({path,onPath,onSelect,onClose}) {
  return <Sheet title="选择云端文件夹" onClose={onClose} footer={<button className="primary-button full-width" onClick={()=>onSelect(path)}>使用此文件夹</button>}>
    <p className="body-copy">这条会话的文件和命令将在这里运行。</p><div className="folder-path"><Folder size={17}/><span>{path}</span></div>
    <button className="selection-row" onClick={()=>onPath(path.slice(0,path.lastIndexOf('/'))||'/')}><ArrowLeft size={18}/><span>上一级</span></button>
    {['projects','reports','notes'].map(name=><button className="selection-row" key={name} onClick={()=>onPath(path.replace(/\/$/,'')+'/'+name)}><Folder size={20}/><span>{name}</span><ChevronRight size={17}/></button>)}
  </Sheet>;
}
export function AttachmentPanel({onClose,onChoose}) {
  return <Sheet title="添加内容" onClose={onClose}>
    <button className="selection-row" onClick={()=>onChoose('需求说明.pdf')}><File size={21}/><span><strong>选择文件</strong><small>上传后随消息发送给 Bot</small></span><Plus size={18}/></button>
    <button className="selection-row" onClick={()=>onChoose('界面截图.png')}><Upload size={21}/><span><strong>照片或图片</strong><small>从系统照片与文件中选择</small></span><Plus size={18}/></button>
  </Sheet>;
}
export function PermissionPanel({offline,onClose,onDecision}) {
  return <Sheet title="需要你的确认" onClose={onClose} footer={<div className="split-actions"><button className="secondary-button" disabled={offline} onClick={()=>onDecision(false)}>拒绝</button><button className="primary-button" disabled={offline} onClick={()=>onDecision(true)}>允许这次</button></div>}>
    <span className="status-symbol warning"><ShieldAlert size={27}/></span><p className="form-label">发布前检查</p><h3 className="sheet-title">允许清理旧的构建文件吗？</h3>
    <p className="body-copy">这会删除当前项目的 dist 文件夹。Bot 正在等待你的选择。</p><pre className="command-preview">rm -rf ./dist</pre>
    <details className="command-detail"><summary>查看完整路径</summary><code>/home/ubuntu/hemi-workspace/dist</code></details>
    <p className="field-note">仅允许本次操作；下次遇到同样的操作仍会询问。</p>{offline&&<p className="inline-warning">恢复连接后才能提交决定。</p>}
  </Sheet>;
}
export function SettingsPanel({offline,onClose,onReconnect,onDisconnect,onChange,connection,onPair,onDevices}) {
  return <Sheet title="Bot 连接" onClose={onClose}>
    <div className="bot-identity"><span className="bot-avatar">h</span><div><h3>Hemi Bot</h3><span className={offline?'warning-text':'online-text'}>{offline?'连接已断开':'已连接'}</span></div></div>
    <dl className="identity-detail"><div><dt>服务器</dt><dd>{connection.host}</dd></div><div><dt>账号</dt><dd>{connection.user}</dd></div><div><dt>连接方式</dt><dd>SSH · {connection.port}</dd></div></dl>
    <button className="selection-row" disabled={offline} onClick={onPair}><span>连接新设备<small>生成短时配对码，需要本机确认</small></span><ChevronRight size={17}/></button>
    <button className="selection-row" onClick={onDevices}><span>已连接设备</span><ChevronRight size={17}/></button>
    <button className="selection-row" onClick={onReconnect}><span>重新连接</span><ChevronRight size={17}/></button>
    <button className="selection-row" onClick={onChange}><span>修改连接信息</span><ChevronRight size={17}/></button>
    <button className="selection-row danger-text" onClick={onDisconnect}><span>断开手机连接</span></button>
    <p className="field-note separated">断开手机连接不会停止云端已受理的任务。重新连接后再核对最新进展。</p>
  </Sheet>;
}
