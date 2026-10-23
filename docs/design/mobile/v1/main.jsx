import {useEffect,useLayoutEffect,useMemo,useReducer,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowDownToLine,ArrowLeft,ArrowUp,Check,ChevronDown,ChevronRight,Cloud,Folder,Menu,Paperclip,Plus,RefreshCw,Share2,Square,SquarePen,WifiOff,X} from 'lucide-react';
import {ConversationFlow} from '@hemi/conversation-flow';
import {ConversationFlowProvider,TurnQueueTray} from '@hemi/conversation-flow/parts';
import {createConversationActionHandler,createConversationPresenter,projectConversationQueue,queueStoppedIdle} from '@hemi/conversation-flow/core';
import {useConversation} from '@hemi/conversation-flow/react';
import {conversations,fileText,scenes} from './data';
import {createPrototypeSession} from './session';
import {ConversationDrawer} from './conversation-drawer';
import {DevicesPanel,PairingPanel,ScanPanel} from './pairing';
import {createPairingDemo,pairingDemoReducer} from './pairing-demo';
import {AttachmentPanel,Connection,FolderPanel,IconButton,IdentityPanel,ModelPanel,PermissionPanel,SettingsPanel,Sheet,TrustPanel} from './panels';
import '@hemi/conversation-flow/styles.css';
import './style.css';

const ok=()=>({ok:true,value:undefined});
const validScene=value=>scenes.some(scene=>scene.id===value)?value:'conversation';
const initialScene=validScene(new URL(location.href).searchParams.get('scene'));
const firstPage=scene=>['connect','trust','pair-scan'].includes(scene)?'connect':scene==='file'?'file':'chat';
const firstSheet=scene=>['pair-share','pair-confirm'].includes(scene)?'pairing':scene==='pair-scan'?'scan':scene==='devices'?'devices':['trust','permission','settings','identity'].includes(scene)?scene:null;

function App(){
  const registry=useRef(new Map()),edgeTouch=useRef(null),deviceStage=useRef(null);
  const [previewScale,setPreviewScale]=useState(1);
  const [pairing,pairAction]=useReducer(pairingDemoReducer,initialScene,createPairingDemo),[pairingNow,setPairingNow]=useState(Date.now);
  const [pairingRevision,setPairingRevision]=useState(0);
  const [drawerOpen,setDrawerOpen]=useState(initialScene==='history'),[conversationItems,setConversationItems]=useState(conversations);
  const [preferences,setPreferences]=useState({});
  const [scene,setScene]=useState(initialScene),[page,setPage]=useState(firstPage(initialScene)),[sheet,setSheet]=useState(firstSheet(initialScene));
  const [preset,setPreset]=useState({mode:initialScene,token:0}),[cid,setCid]=useState('release');
  const [offline,setOffline]=useState(initialScene==='offline'),[reconnecting,setReconnecting]=useState(false);
  const [trusted,setTrusted]=useState(!['connect','trust','pair-scan'].includes(initialScene)),[browsingFolder,setBrowsingFolder]=useState('/home/ubuntu/hemi-workspace');
  const [connection,setConnection]=useState({host:'cloud.example.com',user:'ubuntu',port:'22'});
  const [editing,setEditing]=useState(null),[queueEdit,setQueueEdit]=useState(null),[queueText,setQueueText]=useState(''),[toast,setToast]=useState(''),[attachment,setAttachment]=useState(null),[uploading,setUploading]=useState(false),[reviewOpen,setReviewOpen]=useState(false),[permissionRequests,setPermissionRequests]=useState({release:initialScene==='permission'});
  const timers=useRef(new Set()),unknownDraft=useRef(new Map()),connectionOffline=useRef(offline),appliedPresets=useRef(new Map());
  const later=(fn,delay)=>{const id=setTimeout(()=>{timers.current.delete(id);fn();},delay);timers.current.add(id);return id;};
  const notify=message=>{setToast(message);later(()=>setToast(''),2600);};
  const session=useMemo(()=>{if(!registry.current.has(cid))registry.current.set(cid,createPrototypeSession(cid));return registry.current.get(cid);},[cid]);
  const client=session.client,state=useConversation(client);
  const snapshot=state.snapshot,busy=Boolean(snapshot&&snapshot.phase!=='idle');
  const unknown=Boolean(snapshot?.pending.some(item=>item.state==='needs-review')),permissionPending=Boolean(permissionRequests[cid]);
  connectionOffline.current=offline;
  const present=useMemo(createConversationPresenter,[]),messages=useMemo(()=>present(snapshot),[present,snapshot]);
  const scope=useMemo(()=>({...client.scope,generation:String(snapshot?.generation??1)}),[client,snapshot?.generation]);
  const queue=useMemo(()=>projectConversationQueue(snapshot,state.operations),[snapshot,state.operations]);
  const selectedScene=scenes.find(item=>item.id===scene)??scenes[3];
  const activeTitle=conversationItems.find(item=>item.id===cid)?.title??'新对话';
  const model=preferences[cid]?.model??'工作模型',folder=preferences[cid]?.folder??'/home/ubuntu/hemi-workspace';
  const remember=(key,value)=>setPreferences(previous=>({...previous,[cid]:{...previous[cid],[key]:value}}));
  useEffect(()=>{
    if(appliedPresets.current.get(session)===preset)return;
    appliedPresets.current.set(session,preset);
    const mode=cid.startsWith('new-')?'conversation':cid==='audit'?'running':cid==='release'?preset.mode:'conversation';
    let active=true;void session.preset(mode).then(()=>{session.setOffline(connectionOffline.current);if(active&&mode==='unknown'){client.draft.setText('把发布说明发给我。');unknownDraft.current.set(cid,client.draft.getSnapshot());}});
    return()=>{active=false;};
  },[session,preset]);
  useEffect(()=>{for(const value of registry.current.values())value.setOffline(offline);},[offline,session]);
  useEffect(()=>()=>{for(const timer of timers.current)clearTimeout(timer);for(const value of registry.current.values())value.dispose();},[]);
  useEffect(()=>{
    if(!['pairing','scan'].includes(sheet))return;
    const tick=()=>{const now=Date.now();setPairingNow(now);if(sheet==='pairing'&&now>=pairing.invitation.expiresAt)pairAction({type:'expire'});if(sheet==='scan'&&pairing.scanExpiresAt&&now>=pairing.scanExpiresAt)pairAction({type:'scan-expire'});};
    tick();const timer=setInterval(tick,1000);return()=>clearInterval(timer);
  },[sheet,pairing.invitation.expiresAt,pairing.scanExpiresAt]);
  useEffect(()=>{if(offline)pairAction({type:'cancel'});},[offline]);
  useLayoutEffect(()=>{
    const viewport=visualViewport;
    const resize=()=>{
      const height=viewport?.height??innerHeight;
      document.documentElement.style.setProperty('--viewport-height',`${height}px`);
      // Keep the 390 × 844 logical canvas intact; fit its decorative frame as a unit.
      const padding=innerWidth<=1120?64:80;
      setPreviewScale(innerWidth<=680?1:Math.min(1,(height-padding-32)/860,(deviceStage.current?.clientWidth??406)/406));
    };
    const observer=new ResizeObserver(resize);observer.observe(deviceStage.current);resize();
    window.addEventListener('resize',resize);viewport?.addEventListener('resize',resize);
    return()=>{observer.disconnect();window.removeEventListener('resize',resize);viewport?.removeEventListener('resize',resize);};
  },[]);
  const chooseScene=id=>{
    pairAction({type:'reset',scene:id});setPairingNow(Date.now());setPairingRevision(value=>value+1);
    setScene(id);setPage(firstPage(id));setSheet(firstSheet(id));setDrawerOpen(id==='history');setCid('release');setEditing(null);setQueueEdit(null);setPermissionRequests({release:id==='permission'});setOffline(id==='offline');setAttachment(null);setUploading(false);setReconnecting(false);setReviewOpen(false);
    setPreset(previous=>({mode:id,token:previous.token+1}));
    history.replaceState(null,'',`?scene=${id}`);
  };
  const navigate=(next,nextScene)=>{setPage(next);setSheet(null);setDrawerOpen(false);if(nextScene){setScene(nextScene);history.replaceState(null,'',`?scene=${nextScene}`);}};
  const openPairing=()=>{if(offline)return;pairAction({type:'generate',now:Date.now()});setPairingNow(Date.now());setPairingRevision(value=>value+1);setSheet('pairing');};
  const applyPairAction=action=>{if(action.type==='generate')setPairingNow(action.now);pairAction(action);};
  const closePairing=()=>{pairAction({type:'cancel'});setSheet('settings');};
  const openScanner=()=>{pairAction({type:'scan-reset'});setSheet('scan');};
  const closeScanner=()=>{pairAction({type:'scan-reset'});setSheet(null);};
  const reconnect=()=>{
    if(reconnecting)return;setReconnecting(true);setSheet(null);
    later(()=>{session.setOffline(false);setOffline(false);setReconnecting(false);void client.refresh();notify('已恢复连接，正在核对最新进展');},1000);
  };
  const disconnect=()=>{session.setOffline(true);setOffline(true);setSheet(null);notify('手机连接已断开，草稿和历史仍保留');};
  const download=()=>{const url=URL.createObjectURL(new Blob([fileText],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='发布说明-交互稿示例.md';a.click();later(()=>URL.revokeObjectURL(url),1000);notify('已交给系统保存');};
  const share=async()=>{
    try{if(navigator.share)await navigator.share({title:'发布说明.md',text:fileText});else{await navigator.clipboard.writeText(fileText);notify('已复制文件内容，可以粘贴分享');}}catch(error){if(error.name!=='AbortError')notify('分享未完成，可以先保存文件');}
  };
  const host=useMemo(()=>({version:1,capabilities:{copyText:true,openLink:false,resolveResource:true,readResource:true,resourceActions:true},
    copyText:async({text})=>{await navigator.clipboard.writeText(text);return ok();},
    resources:{resolve:async()=>({ok:true,value:{id:'release-file',version:'1'}}),read:async({ref})=>({ok:true,value:{ref,content:{kind:'text',text:fileText,mimeType:'text/markdown'},metadata:{name:'发布说明.md'},release(){}}}),
      listActions:async()=>({ok:true,value:[{id:'save',kind:'save',label:'保存到文件'},{id:'share',kind:'share',label:'分享文件'}]}),
      perform:async({actionId})=>{if(actionId==='save')download();else await share();return ok();}}}),[]);
  const onAction=useMemo(()=>{
    const ordinary=createConversationActionHandler(client,async(action)=>{
      if(action.type==='preview.open'){setPage('file');setScene('file');return ok();}
      return{ok:false,error:{code:'unsupported',message:'此操作未包含在首版交互预览中'}};
    });
    return async(action,context)=>{
      if(action.type==='message.edit-state'){setEditing(action.state==='begin'?action.targetId:null);return ok();}
      const result=await ordinary(action,context);if(action.type==='message.edit'&&result.ok)setEditing(null);return result;
    };
  },[client]);
  const send=async()=>{if(uploading||unknown)return;const text=state.draft.text.trim();const result=await client.sendDraft();if(result.ok){if(cid.startsWith('new-'))setConversationItems(items=>items.map(item=>item.id===cid&&item.title==='新对话'?{...item,title:text.slice(0,28)}:item));setAttachment(null);if(offline)notify('已保存在手机，连接恢复后发送');}else notify(result.message||'发送未完成，草稿已保留');};
  const selectConversation=id=>{setCid(id);setEditing(null);setAttachment(null);navigate('chat','conversation');};
  const newConversation=()=>{const id=`new-${crypto.randomUUID()}`;setConversationItems(items=>[{id,title:'新对话',time:'刚刚'},...items]);setCid(id);setEditing(null);setAttachment(null);navigate('chat','conversation');};
  const closeDrawer=()=>{setDrawerOpen(false);if(scene==='history'){setScene('conversation');history.replaceState(null,'','?scene=conversation');}};
  const drawerSettings=()=>{closeDrawer();setSheet('settings');};
  const edgeStart=event=>{const point=event.touches[0],bounds=event.currentTarget.getBoundingClientRect();edgeTouch.current=point.clientX-bounds.left<=24?{x:point.clientX,y:point.clientY}:null;};
  const edgeEnd=event=>{const point=event.changedTouches[0],start=edgeTouch.current;edgeTouch.current=null;if(page==='chat'&&!sheet&&start&&point.clientX-start.x>60&&Math.abs(point.clientY-start.y)<Math.abs(point.clientX-start.x)*.65)setDrawerOpen(true);};
  const openFolder=()=>{if(offline){notify('恢复连接后才能切换工作目录');return;}setBrowsingFolder(folder);setSheet('folder');};
  const openQueueEdit=id=>{const item=queue.items.find(item=>item.queueItemId===id);if(!item||item.operationId)return;setQueueEdit(id);setQueueText(item.text);setSheet('queue-edit');};
  const withdraw=async id=>{const item=queue.items.find(item=>item.queueItemId===id);if(item?.operationId)await client.cancelWaiting(item.operationId);else await client.sendCommand({type:'withdrawInput',inputId:id});};
  const chooseAttachment=name=>{setSheet(null);if(offline){notify('恢复连接后才能上传附件');return;}setAttachment(name);setUploading(true);later(()=>setUploading(false),800);};
  const reconcile=()=>{
    session.reconcile();
    const submitted=unknownDraft.current.get(cid);if(submitted)client.draft.accept(submitted.revision,submitted.token);
    notify('已确认受理，这条消息没有重复发送');
  };
  const permissionDecision=allowed=>{setPermissionRequests(previous=>({...previous,[cid]:false}));setSheet(null);notify(allowed?'已允许这次操作，Bot 继续执行':'已拒绝这次操作');if(!allowed)void client.sendCommand({type:'stop'});};

  return <main className="review-layout">
    <header className="mobile-review-header"><strong>Hemi 移动端交互稿</strong><button onClick={()=>setReviewOpen(!reviewOpen)}>切换场景</button></header>
    <aside className={`review-sidebar ${reviewOpen?'is-open':''}`} aria-label="交互稿场景"><a className="review-brand" href="?scene=conversation"><span className="small-brand">h</span>Hemi<span>Mobile</span></a><h1>随身连接，<br/>继续手头的事。</h1><p className="review-intro">第一版视觉与交互<br/>iOS 优先 · 同时适配安卓</p>
      {['开始使用','对话与任务','恢复与文件','连接与异常'].map(group=><section className="scene-group" key={group}><h2>{group}</h2>{scenes.filter(item=>item.group===group).map(item=><button key={item.id} aria-current={scene===item.id?'page':undefined} onClick={()=>chooseScene(item.id)}><span>{item.title}</span>{scene===item.id&&<span className="selection-dot"/>}</button>)}</section>)}
      <a className="review-surface-link" href="./desktop.html?scene=settings">PC 设备配对交互<ChevronRight size={14}/></a><p className="review-disclosure">所有地址、身份和内容均为演示数据；不会连接服务器或调用模型。</p>
    </aside>
    <section ref={deviceStage} className="device-stage" style={{'--preview-scale':previewScale}} aria-label="手机交互预览"><div className="device-viewport"><div className="device"><div className="device-screen">
      <div className="system-status" aria-hidden="true"><span>9:41</span><span className="status-island"/><span className="system-icons"><i/><i/><b/></span></div>
      <div className="navigation-stage">
      <div className={`app-surface ${drawerOpen?'drawer-is-open':''}`} inert={sheet||drawerOpen?true:undefined} onTouchStart={edgeStart} onTouchEnd={edgeEnd} onTouchCancel={()=>{edgeTouch.current=null;}}>
        {page==='connect'?<Connection onScan={openScanner} connection={connection} trusted={trusted} onContinue={value=>{setConnection(value);setSheet('trust');}} onBack={trusted?()=>navigate('chat','conversation'):undefined}/>:page==='file'?<>
          <header className="app-topbar"><IconButton label="返回对话" onClick={()=>navigate('chat','conversation')}><ArrowLeft size={21}/></IconButton><div className="topbar-title"><strong>发布说明.md</strong><small>来自云端默认空间</small></div><IconButton label="分享文件" onClick={()=>void share()}><Share2 size={20}/></IconButton></header>
          <div className="file-document"><p className="file-kind">Markdown 文档</p><h1>移动端首版<br/>发布说明</h1><div className="document-rule"/><h2>这次完成</h2><ul><li>抽离多端共用的对话 SDK。</li><li>草稿、排队和断线恢复使用同一份前端逻辑。</li><li>初始化 iOS 与 Android 工程。</li></ul><h2>发布前还需要</h2><ul><li>接入原生 SSH 与安全存储。</li><li>验证后台恢复与真机文件分享。</li><li>完成签名与商店资料。</li></ul><p className="document-note">以上为交互稿内置示例。</p></div>
          <footer className="file-actions"><button className="primary-button full-width" onClick={download}><ArrowDownToLine size={18}/>保存到文件</button></footer>
        </>:<>
          <header className="app-topbar chat-topbar"><IconButton label="打开对话列表" aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={()=>setDrawerOpen(true)}><Menu size={22}/></IconButton><IconButton label="新建对话" onClick={newConversation}><SquarePen size={21}/></IconButton><button className="topbar-title title-button" aria-label={`选择模型，当前${model}`} disabled={offline} onClick={()=>setSheet('model')}><strong>{activeTitle}</strong><small>{model}<ChevronDown size={12}/></small></button><IconButton label="选择工作目录" disabled={offline} onClick={openFolder}><Folder size={20}/></IconButton><IconButton label="Bot 连接设置" className="icon-control connection-control" onClick={()=>setSheet('settings')}><Cloud size={22}/><span className={offline?'connection-dot offline':'connection-dot'}/></IconButton></header>
          {offline&&<section className="connection-banner" role="status"><WifiOff size={18}/><div><strong>连接已断开</strong><p>云端任务可能仍在继续。</p></div><button disabled={reconnecting} onClick={reconnect}>{reconnecting?'正在核对…':'重新连接'}</button></section>}
          {unknown&&<section className="connection-banner" role="status"><RefreshCw size={18}/><div><strong>有一条消息正在核对</strong><p>草稿已保留，暂不重复发送。</p></div><button onClick={reconcile}>核对结果</button></section>}
          {permissionPending&&<button className="permission-notice" onClick={()=>setSheet('permission')}><span className="warning-dot"/>Bot 正在等待你的确认<ChevronRight size={16}/></button>}
          {messages.length?<section className="conversation-frame" aria-label="消息记录"><ConversationFlow scope={scope} messages={messages} host={host} onAction={onAction} active={page==='chat'&&!sheet} state={{busy,editingMessageId:editing,retryBlocked:offline?'恢复连接后重试':undefined}}/></section>:<section className="empty-chat"><span className="welcome-mark">h</span><h1>今天想做什么？</h1><p>文件和命令在云端执行，<br/>你可以随时回来继续。</p><button onClick={()=>client.draft.setText('查看当前目录的项目结构')}>查看当前目录的项目结构</button></section>}
          <div className="input-dock"><div className="composer-surface"><section className="queue-region" aria-label="发送队列"><ConversationFlowProvider part scope={scope} host={host} onAction={onAction}><TurnQueueTray state={queue} stoppedIdle={queueStoppedIdle(snapshot)} onWithdraw={withdraw} onEdit={offline?undefined:openQueueEdit} onResume={()=>{void client.sendCommand({type:'resumeQueue'});}} onContinue={()=>{client.draft.setText('继续');void client.sendDraft();}}/></ConversationFlowProvider></section>
            {offline&&queue.items.some(item=>item.operationId)&&<p className="local-queue-note">保存在这台手机，尚未发送到 Bot。</p>}
            <section className="mobile-composer" aria-label="消息输入区">{attachment&&<div className="attachment-chip"><Paperclip size={14}/><span>{attachment}</span><small>{uploading?'上传中…':'已就绪'}</small><IconButton label="移除附件" onClick={()=>{setAttachment(null);setUploading(false);}}><X size={14}/></IconButton></div>}
              <textarea aria-label="消息" placeholder={offline?'先写下来，连接恢复后发送…':busy?'正在处理，可以先写下一条…':'发送消息给 Hemi…'} value={state.draft.text} onChange={event=>client.draft.setText(event.target.value)} onKeyDown={event=>{if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();void send();}}}/>
              <div className="composer-toolbar"><IconButton label="添加内容" onClick={()=>setSheet('attachment')}><Plus size={22}/></IconButton><span className="composer-hint">{offline?'离线草稿':busy?'继续输入，加入队列':'消息与附件'}</span><span className="toolbar-spacer"/>{busy&&<IconButton label="停止任务" className="stop-control icon-control" disabled={offline||unknown} onClick={()=>{void client.sendCommand({type:'stop'});}}><Square size={15}/></IconButton>}<button className="send-control" aria-label={busy?'加入待发送':'发送消息'} disabled={!state.draft.text.trim()||uploading||unknown} onClick={()=>void send()}><ArrowUp size={22}/></button></div>
            </section></div><div className="composer-context"><span>{folder=== '/home/ubuntu/hemi-workspace'?'默认空间':folder.split('/').at(-1)}</span><span>{offline?'草稿保留在手机':busy?'在云端执行':'文件与命令在云端运行'}</span></div>
          </div>
        </>}
      </div>
      {drawerOpen&&<ConversationDrawer items={conversationItems} activeId={cid} connection={connection} offline={offline} onSelect={selectConversation} onNew={newConversation} onSettings={drawerSettings} onClose={closeDrawer}/>}
      </div>
      {toast&&<div className="toast" role="status">{toast}</div>}
      {sheet==='trust'&&<TrustPanel connection={connection} onClose={()=>setSheet(null)} onConfirm={()=>{setTrusted(true);setOffline(false);session.setOffline(false);navigate('chat','conversation');notify('已连接 Hemi Bot');}}/>}
      {sheet==='identity'&&<IdentityPanel onClose={()=>setSheet(null)} onSettings={()=>setSheet('settings')}/>}
      {sheet==='model'&&<ModelPanel value={model} onClose={()=>setSheet(null)} onSelect={value=>{remember('model',value);setSheet(null);}}/>}
      {sheet==='folder'&&<FolderPanel path={browsingFolder} onPath={setBrowsingFolder} onClose={()=>setSheet(null)} onSelect={value=>{remember('folder',value);setSheet(null);}}/>}
      {sheet==='attachment'&&<AttachmentPanel onClose={()=>setSheet(null)} onChoose={chooseAttachment}/>}
      {sheet==='permission'&&<PermissionPanel offline={offline} onClose={()=>setSheet(null)} onDecision={permissionDecision}/>}
      {sheet==='pairing'&&<PairingPanel key={pairingRevision} state={pairing} now={pairingNow} offline={offline} onAction={applyPairAction} onClose={closePairing} onDevices={()=>setSheet('devices')}/>}
      {sheet==='scan'&&<ScanPanel stage={pairing.scan} onAction={action=>pairAction({...action,now:Date.now()})} onClose={closeScanner} onConnected={()=>{setTrusted(true);setOffline(false);session.setOffline(false);navigate('chat','conversation');}}/>}
      {sheet==='devices'&&<DevicesPanel devices={pairing.devices} offline={offline} onAction={pairAction} onClose={()=>setSheet('settings')}/>}
      {sheet==='settings'&&<SettingsPanel onPair={openPairing} onDevices={()=>setSheet('devices')} connection={connection} offline={offline} onClose={()=>setSheet(null)} onReconnect={reconnect} onDisconnect={()=>setSheet('disconnect')} onChange={()=>navigate('connect','connect')}/>}
      {sheet==='disconnect'&&<Sheet title="断开手机连接？" onClose={()=>setSheet('settings')} footer={<div className="split-actions"><button className="secondary-button" onClick={()=>setSheet('settings')}>取消</button><button className="primary-button" onClick={disconnect}>断开连接</button></div>}><p className="body-copy">云端已受理的任务可以继续运行。手机会保留已缓存的历史和草稿。</p></Sheet>}
      {sheet==='queue-edit'&&<Sheet title="编辑待发送消息" onClose={()=>setSheet(null)} footer={<button className="primary-button full-width" onClick={()=>{void client.sendCommand({type:'designEditInput',inputId:queueEdit,text:queueText}).then(()=>setSheet(null));}}>保存修改</button>}><textarea className="sheet-textarea" aria-label="待发送内容" value={queueText} onChange={event=>setQueueText(event.target.value)}/></Sheet>}

      <div className="home-region" aria-hidden="true"><span/></div>
    </div></div></div><p className="device-caption">390 × 844 逻辑画布 · 预览 {Math.round(previewScale*100)}% · 可点击体验</p></section>
    <aside className="review-notes"><span className="version-label">第一版 / 浅色</span><h2>{selectedScene.title}</h2><p>{selectedScene.description}</p><ol>{selectedScene.points.map(point=><li key={point}>{point}</li>)}</ol><div className="review-actions">{sheet==='pairing'&&<><button disabled={pairing.invitation.status!=='open'} onClick={()=>pairAction({type:'request',now:Date.now()})}>模拟新设备扫码</button><button disabled={!['open','pending'].includes(pairing.invitation.status)} onClick={()=>pairAction({type:'expire'})}>模拟配对码过期</button></>}{sheet==='scan'&&<><button disabled={!['review','waiting'].includes(pairing.scan)} onClick={()=>pairAction({type:'scan-expire'})}>模拟连接请求过期</button><button disabled={pairing.scan!=='ready'} onClick={()=>pairAction({type:'scan-read',now:Date.now()})}>演示识别配对码</button><button disabled={pairing.scan!=='ready'} onClick={()=>pairAction({type:'scan-invalid'})}>演示无效配对码</button><button disabled={pairing.scan!=='waiting'} onClick={()=>pairAction({type:'scan-confirm',now:Date.now()})}>模拟原设备允许连接</button><button disabled={pairing.scan!=='waiting'} onClick={()=>pairAction({type:'scan-deny'})}>模拟原设备拒绝连接</button></>}{busy&&<button onClick={()=>session.finish()}><Check size={16}/>完成当前演示任务</button>}<button onClick={()=>{if(offline)reconnect();else{session.setOffline(true);setOffline(true);}}}><WifiOff size={16}/>{offline?'恢复演示连接':'模拟手机断线'}</button><button onClick={()=>chooseScene('permission')}>查看授权请求<ChevronRight size={16}/></button></div><p className="boundary-note">消息、执行过程、编辑与队列使用真实对话 SDK。连接、原生文件能力和服务器状态由本机演示适配层模拟。</p></aside>
  </main>;
}

createRoot(document.getElementById('root')).render(<App/>);
