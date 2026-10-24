import {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type TouchEvent} from 'react';
import {Brain, ChevronDown, Folder, Menu, Image, Paperclip, WifiOff} from 'lucide-react';
import {ConversationFlow, type FlowActionHandler} from '@hemi/conversation-flow';
import {createConversationActionHandler, createConversationPresenter, projectConversationQueue, queueStoppedIdle, type FlowInputView} from '@hemi/conversation-flow/core';
import {useConversation} from '@hemi/conversation-flow/react';
import {ConversationFlowProvider, TurnQueueTray} from '@hemi/conversation-flow/parts';
import {Composer} from './composer';
import {ResourcePreview, type MobilePreview} from './components/resource-preview';
import {ComposerAttachments} from './components/composer-attachments';
import brandMark from './assets/hemi-mark.svg';
import type {MobileConversation, MobileSessionPatch, MobileWorkspace, MobileWorkspaceSnapshot} from './workspace';
import {createMobileHost} from './host/capacitor-host';
import {useAppViewport} from './host/app-viewport';
import {IconButton, Sheet} from './components/dialog';
import {ConversationDrawer} from './components/conversation-drawer';
import {ConnectionScreen} from './components/connection-screen';
import {AppBoundary} from './components/app-boundary';
import {ModelPanel, SettingsPanel, ThinkingPanel, thinkingOptions} from './components/chat-panels';
import {DirectoryPanel} from './components/directory-panel';
import {NativeBot, nativeBotAvailable, createNativeBotRpc, createNativeFileSource, createNativeResourceFiles, type BotTarget} from './bot/native';
import {createBotWorkspace} from './bot/workspace-client';

export function App({workspace: connectedWorkspace = null, onDisconnect}: {workspace?: MobileWorkspace | null; onDisconnect?(): void} = {}) {
  useAppViewport();
  const [nativeWorkspace, setNativeWorkspace] = useState<MobileWorkspace | null>(null);
  const [connectionError,setConnectionError] = useState('');
  const [restoring,setRestoring] = useState(()=>!connectedWorkspace&&nativeBotAvailable());
  const [restoreError,setRestoreError] = useState(''), [restoreAttempt,setRestoreAttempt] = useState(0);
  const [pendingTarget,setPendingTarget] = useState<BotTarget|null>(null);
  const connected = connectedWorkspace ?? nativeWorkspace;
  const [closedWorkspace, setClosedWorkspace] = useState<MobileWorkspace | null>(null);
  const workspace = connected === closedWorkspace ? null : connected;
  const connect = useCallback((target: BotTarget) => {setConnectionError('');setPendingTarget(null);setNativeWorkspace(createBotWorkspace({rpc:createNativeBotRpc(),target,files:createNativeFileSource(),resourceFiles:createNativeResourceFiles()}));},[]);
  useEffect(()=>{
    if(connectedWorkspace || !nativeBotAvailable()){setRestoring(false);return;}
    let alive=true;
    setRestoring(true);setRestoreError('');
    void NativeBot.restore().then(saved=>{if(alive){if(saved.active)connect(saved.active);else setPendingTarget(saved.pending??null);}}).catch(()=>{if(alive)setRestoreError('无法读取本机连接身份，请解锁手机后重试。');}).finally(()=>{if(alive)setRestoring(false);});
    return()=>{alive=false;};
  },[connectedWorkspace,restoreAttempt,connect]);
  const [notices, setNotices] = useState(false);
  const noticeReturnFocus = useRef<HTMLElement | null>(null);
  const openNotices = () => {noticeReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setNotices(true);};
  const disconnect = () => {
    const close=()=>{connected?.dispose?.();setClosedWorkspace(connected);setNativeWorkspace(null);setPendingTarget(null);onDisconnect?.();};
    if(nativeWorkspace)void NativeBot.forget().then(close).catch(()=>setConnectionError('无法清除本机连接身份，请解锁后重试。'));
    else close();
  };
  return <main className="mobile-shell">
    <div className="mobile-content" inert={notices ? true : undefined}><AppBoundary key={workspace?.environmentId ?? 'connection'} onReturn={disconnect}>{workspace ? <MobileChat workspace={workspace} onExit={disconnect} onLicenses={openNotices}/> : restoring||restoreError ? <section className="connection-screen" aria-busy={restoring}><header className="simple-header"><strong>Hemi</strong></header><div className="connection-restore-status">{restoring?<p role="status">正在恢复 Bot 连接…</p>:<><p role="alert">{restoreError}</p><button type="button" className="text-button" onClick={()=>setRestoreAttempt(value=>value+1)}>重试恢复连接</button></>}</div></section> : <ConnectionScreen initialPending={pendingTarget} onLicenses={openNotices} onConnected={connect}/>}</AppBoundary>{connectionError?<p role="alert" className="workspace-error">{connectionError}</p>:null}</div>
    {notices ? <Sheet returnFocus={noticeReturnFocus.current} title="开源许可" onClose={() => setNotices(false)}><iframe className="licenses-frame" title="第三方开源许可" src="./licenses/notices.txt"/></Sheet> : null}
  </main>;
}

type Panel = 'model' | 'thinking' | 'folder' | 'settings' | 'attachment' | 'exit' | null;
function MobileChat({workspace, onExit, onLicenses}: {workspace: MobileWorkspace; onExit(): void; onLicenses(): void}) {
  const catalog = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot);
  useEffect(() => workspace.retain(), [workspace]);
  const item = catalog.items.find(item => item.id === catalog.activeId);
  return item ? <ConnectedConversation key={item.id} workspace={workspace} catalog={catalog} item={item} onExit={onExit} onLicenses={onLicenses}/> : <EmptyWorkspace workspace={workspace} onExit={onExit}/>;
}

function EmptyWorkspace({workspace, onExit}: {workspace: MobileWorkspace; onExit(): void}) {
  const [creating, setCreating] = useState(false), [error, setError] = useState(''), [exiting,setExiting]=useState(false);
  const exitTrigger=useRef<HTMLButtonElement>(null);
  const catalog=workspace.getSnapshot();
  const create = async () => {setCreating(true); try {workspace.select(await workspace.create());} catch {setError('未能新建对话，请重试。');} finally {setCreating(false);}};
  return <><section className="connection-screen" inert={exiting?true:undefined}><header className="simple-header"><strong>Hemi</strong><button ref={exitTrigger} type="button" className="text-button" onClick={()=>setExiting(true)}>断开连接</button></header><div className="connect-scroll"><h1>{catalog.offline?'正在连接 Bot':'还没有对话'}</h1>{catalog.error?<p className="body-copy" role="status">{catalog.error}</p>:null}<button type="button" className="primary-button full-width" disabled={creating || catalog.offline} onClick={() => void create()}>{creating ? '正在新建…' : '新建对话'}</button>{catalog.offline?<button type="button" className="text-button" onClick={()=>void workspace.reconnect?.()}>重新连接</button>:null}{error ? <p role="status">{error}</p> : null}</div></section>{exiting?<Sheet returnFocus={exitTrigger.current} title="断开 Bot 连接？" onClose={()=>setExiting(false)} footer={<div className="split-actions"><button type="button" className="secondary-button" onClick={()=>setExiting(false)}>取消</button><button type="button" className="primary-button" onClick={onExit}>断开连接</button></div>}><p className="body-copy">将移除本机连接身份，再次连接需要扫码。云端已受理的任务继续执行，设备授权可在 PC 撤销。</p></Sheet>:null}</>;
}

function ConnectedConversation({workspace, catalog, item, onExit, onLicenses}: {workspace: MobileWorkspace; catalog: MobileWorkspaceSnapshot; item: MobileConversation; onExit(): void; onLicenses(): void}) {
  const client = workspace.getClient(item.id), state = useConversation(client), snapshot = state.snapshot;
  const [drawer, setDrawer] = useState(false), [panel, setPanel] = useState<Panel>(null);
  const [preview,setPreview]=useState<MobilePreview|null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [queueEdit, setQueueEdit] = useState<{inputId: string; revision: number; previousText: string} | null>(null), [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [settingsError,setSettingsError]=useState('');
  const edge = useRef<{x: number; y: number} | null>(null), returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {if (!toast) return; const timer = window.setTimeout(() => setToast(''), 2600); return () => clearTimeout(timer);}, [toast]);
  const present = useMemo(createConversationPresenter, []), messages = useMemo(() => present(snapshot), [present, snapshot]);
  const scope = useMemo(() => ({...client.scope, generation: String(snapshot?.generation ?? 1)}), [client, snapshot?.generation]);
  const host = useMemo(() => workspace.host ?? createMobileHost(workspace.resources), [workspace]);
  const queue = useMemo(() => projectConversationQueue(snapshot, state.operations), [snapshot, state.operations]);
  const busy = Boolean(snapshot && snapshot.phase !== 'idle'), offline = catalog.offline || state.connection === 'offline';
  const unknown = state.operations.some(operation => operation.state === 'unknown') || Boolean(snapshot?.pending.some(input => input.state === 'needs-review'));
  const recovering = Object.values(snapshot?.runs ?? {}).some(run => ['waiting', 'offline', 'connecting'].includes(run.recovery?.phase ?? ''));
  const onAction = useMemo<FlowActionHandler>(() => {
    const ordinary = createConversationActionHandler(client, workspace.onAction ?? (async () => ({ok: false, error: {code: 'unsupported', message: '移动端尚未接入此操作'}})));
    return async (action, context) => {
      if(action.type==='preview.open'&&action.target==='resource') {
        if(context.signal.aborted)return{ok:false,error:{code:'cancelled',message:'对话已切换'}};
        returnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
        setPreview({ref:action.resource,href:action.href,name:action.name});
        return{ok:true,value:{receipt:'completed'}};
      }
      const result = await ordinary(action, context);
      if (action.type === 'message.edit-state' && result.ok) setEditing(action.state === 'begin' ? action.targetId : null);
      if (action.type === 'message.edit' && result.ok) setEditing(null);
      return result;
    };
  }, [client, workspace.onAction]);
  const command = async (value: Record<string, unknown>) => {
    const result = await client.sendCommand(value);
    if (!result.ok) setToast(result.message ?? '操作未完成，请核对当前状态');
    return result;
  };
  const uploads=catalog.uploads?.filter(job=>job.conversationId===item.id)??[];
  const [picking,setPicking]=useState(false);
  const pickAttachments=async(kind: 'photos'|'files')=>{
    if(picking||!workspace.pickAttachments)return;
    setPanel(null);setPicking(true);
    try{await workspace.pickAttachments(item.id,kind);}
    catch(error){setToast(error instanceof Error?error.message:'未能选择文件，请重试');}
    finally{setPicking(false);}
  };
  const send = async () => {
    if(uploads.length||picking)return;
    if (queueEdit) {if (state.draft.text.trim()) await finishQueueEdit(); else setToast('请输入内容，或取消修改'); return;}
    const result = await client.sendDraft();
    if (!result.ok) setToast(result.message ?? '发送未完成，草稿已保留');
    else if (offline) setToast('已保存在手机，连接恢复后发送');
  };
  const openQueueEdit = async (id: string) => {
    if (saving || offline || queueEdit || uploads.length || picking) return;
    const source = snapshot?.pending.find(input => input.inputId === id);
    if (!source) return;
    setSaving(true);
    try {
      const result = await command({type: 'beginEditInput', inputId: id, expectedEditRevision: source.editRevision});
      if (!result.ok) return;
      const input = result.input as FlowInputView;
      setQueueEdit({inputId: input.inputId, revision: input.editRevision, previousText: state.draft.text});
      client.draft.setText(input.text);
    } finally {setSaving(false);}
  };
  const finishQueueEdit = async (cancel = false) => {
    if (!queueEdit || saving) return;
    setSaving(true);
    try {
      const result = await command({type: 'finishEditInput', inputId: queueEdit.inputId, expectedEditRevision: queueEdit.revision, cancel, ...(cancel ? {} : {patch: {text: state.draft.text}})});
      if (result.ok) {client.draft.setText(queueEdit.previousText); setQueueEdit(null);}
    } finally {setSaving(false);}
  };
  const closePanel = () => {if(saving)return;setSettingsError('');setPanel(null);};
  const select = (id: string) => {workspace.select(id); setDrawer(false); setEditing(null);};
  const create = async () => {try {workspace.select(await workspace.create()); setDrawer(false); setEditing(null);} catch {setToast('未能新建对话，请重试。');}};
  const updateSettings = async (patch: MobileSessionPatch) => {
    if(saving||offline)return;
    setSaving(true);setSettingsError('');
    try {await workspace.update(item.id,patch);setPanel(null);}
    catch(error){setSettingsError(error instanceof Error?error.message:'未能保存设置，请重试。');}
    finally {setSaving(false);}
  };
  const reconnect = async () => {try {await workspace.reconnect?.();} catch {setToast('未能恢复连接，请重试。');}};
  const edgeStart = (event: TouchEvent<HTMLElement>) => {const point = event.touches[0]; edge.current = point.clientX - event.currentTarget.getBoundingClientRect().left <= 24 ? {x: point.clientX, y: point.clientY} : null;};
  const edgeEnd = (event: TouchEvent<HTMLElement>) => {const start = edge.current, point = event.changedTouches[0]; edge.current = null; if (!panel && start && point.clientX - start.x > 60 && Math.abs(point.clientY - start.y) < (point.clientX - start.x) * .65) setDrawer(true);};
  const withdraw = async (id: string) => {
    const entry = queue.items.find(item => item.queueItemId === id);
    if (entry?.operationId) {if (!await client.cancelWaiting(entry.operationId)) setToast('这条操作已经提交，请先核对结果');}
    else await command({type: 'withdrawInput', inputId: id});
  };

  return <div className="navigation-stage">
    <div className={`app-surface ${drawer ? 'drawer-is-open' : ''}`} inert={drawer || panel || preview ? true : undefined} onClickCapture={event => {const trigger = (event.target as HTMLElement).closest('button'); if (trigger) returnFocus.current = trigger;}} onTouchStart={edgeStart} onTouchEnd={edgeEnd} onTouchCancel={() => {edge.current = null;}}>
        <header className="app-topbar chat-topbar"><IconButton label="打开对话列表" aria-haspopup="dialog" aria-expanded={drawer} onClick={() => setDrawer(true)}><Menu size={18}/></IconButton><button type="button" className="topbar-title title-button" aria-label="选择模型" disabled={offline} onClick={() => setPanel('model')}><strong>{item.title}</strong><small>{catalog.models.find(model => model.id === item.model)?.name ?? item.model}<ChevronDown size={12}/></small></button><IconButton label="选择工作目录" disabled={offline} onClick={() => setPanel('folder')}><Folder size={18}/></IconButton></header>
        {offline ? <section className="connection-banner" role="status"><WifiOff size={18}/><span>Bot 连接已断开</span>{workspace.reconnect ? <button type="button" onClick={() => void reconnect()}>恢复连接</button> : null}</section> : null}
        {unknown ? <section className="connection-banner" role="status"><span>操作结果待核对<small>请先核对，避免重复发送。</small></span><button type="button" onClick={() => {void client.refresh();}}>核对结果</button></section> : null}
        {catalog.error || state.error ? <p className="workspace-error" role="status">{catalog.error || state.error}</p> : null}
        {catalog.permissions?.filter(permission=>permission.conversationId===item.id).map(permission=><section className="connection-permission" role="group" aria-label="Bot 操作确认" key={permission.id}><p>{permission.title}</p><div>{permission.options.map(value=><button type="button" className="secondary-button" key={value} disabled={offline||saving||!workspace.decidePermission} onClick={()=>{setSaving(true);void workspace.decidePermission?.(permission.id,value).catch(()=>setToast('确认结果待核对，请恢复连接后刷新。')).finally(()=>setSaving(false));}}>{value}</button>)}</div></section>)}
        <section className="conversation-frame" aria-label="消息记录" style={{display: messages.length ? undefined : 'none'}}><ConversationFlow scope={scope} messages={messages} host={host} onAction={onAction} active={!drawer && !panel && !preview} state={{busy, editingMessageId: editing, retryBlocked: offline ? '恢复连接后重试' : undefined}}/></section>
        {!messages.length ? <section className="empty-chat"><img className="welcome-mark" src={brandMark} alt=""/><h1>{state.connection === 'connecting' ? '正在读取对话…' : '今天想做什么？'}</h1></section> : null}
        <Composer busy={busy} offline={offline} blocked={unknown || recovering || saving || picking || uploads.length>0} hasAttachments={!queueEdit && state.draft.attachments.length>0} addBlocked={offline || picking || !!queueEdit || !workspace.attachmentsAvailable || state.draft.attachments.length+uploads.length>=3} stopBlocked={unknown} text={state.draft.text} onText={client.draft.setText} onSend={() => void send()} onStop={() => {void command({type: 'stop', targetRunId: snapshot?.activeRunId});}} onAdd={() => setPanel('attachment')} editingQueue={!!queueEdit} onCancelQueueEdit={() => void finishQueueEdit(true)} controls={<>
          <button type="button" className="composer-option composer-model" disabled={offline||saving} aria-label={`切换模型：${catalog.models.find(model=>model.id===item.model)?.name??item.model}`} onClick={()=>setPanel('model')}><span>{catalog.models.find(model=>model.id===item.model)?.name??item.model}</span><ChevronDown size={12}/></button>
          <button type="button" className="composer-option" disabled={offline||saving} aria-label={`思考强度：${thinkingOptions.find(option=>option.value===(item.thinking??'default'))?.label}`} onClick={()=>setPanel('thinking')}><Brain size={16}/><span>{thinkingOptions.find(option=>option.value===(item.thinking??'default'))?.label}</span><ChevronDown size={12}/></button>
        </>}>
          <ComposerAttachments attachments={state.draft.attachments} uploads={uploads} disabled={saving||!!queueEdit} onRemove={id=>client.draft.setAttachments(previous=>previous.filter(file=>file.attachmentId!==id))} onCancel={id=>{void workspace.cancelUpload?.(id);}} onRetry={id=>workspace.retryUpload?.(id)}/>
          {picking?<p className="local-queue-note" role="status">正在读取所选文件…</p>:null}
          <section className="queue-region" aria-label="发送队列"><ConversationFlowProvider part scope={scope} host={host} onAction={onAction}><TurnQueueTray state={queue} stoppedIdle={queueStoppedIdle(snapshot)} onWithdraw={withdraw} onEdit={offline || saving || picking || uploads.length ? undefined : openQueueEdit} onPromote={(id) => {void command({type: 'promoteInput', inputId: id});}} onReorder={(inputId, overInputId, expectedInputIds) => {void command({type: 'reorderInput', inputId, overInputId, expectedInputIds});}} onResume={() => {void command({type: 'resumeQueue'});}} onContinue={() => {void command({type: 'send', input: {text: '继续', inputSource: 'text', attachmentIds: []}});}}/></ConversationFlowProvider></section>
          {offline && queue.items.some(item => item.operationId) ? <p className="local-queue-note">尚未发送到 Bot</p> : null}
        </Composer>
        <div className="composer-context"><button type="button" disabled={offline||saving} aria-label={`工作目录：${item.directory}`} title={item.directory} onClick={()=>setPanel('folder')}><Folder size={13}/><span>{item.directory.split('/').filter(Boolean).at(-1)||'/'}</span><ChevronDown size={11}/></button></div>
    </div>
    {preview ? <ConversationFlowProvider part scope={scope} host={host} onAction={onAction}><ResourcePreview host={host} transfers={workspace.resourceTransfers} scope={scope} request={preview} returnFocus={returnFocus.current} onClose={()=>setPreview(null)}/></ConversationFlowProvider> : null}
    {drawer ? <ConversationDrawer returnFocus={returnFocus.current} items={catalog.items} activeId={item.id} botName={catalog.botName} offline={offline} onSelect={select} onNew={() => void create()} onSettings={() => {setDrawer(false); setPanel('settings');}} onClose={() => setDrawer(false)}/> : null}
    {panel === 'model' ? <ModelPanel returnFocus={returnFocus.current} item={item} models={catalog.models} saving={saving} offline={offline} error={settingsError} onClose={closePanel} onSelect={model => void updateSettings({model})}/> : null}
    {panel === 'thinking' ? <ThinkingPanel returnFocus={returnFocus.current} value={item.thinking??'default'} saving={saving} offline={offline} error={settingsError} onClose={closePanel} onSelect={thinking=>void updateSettings({thinking})}/> : null}
    {panel === 'folder' ? <DirectoryPanel returnFocus={returnFocus.current} workspace={workspace} path={item.directory} defaultPath={catalog.defaultDirectory} recent={catalog.recentDirectories??[]} saving={saving} offline={offline} error={settingsError} onClose={closePanel} onSelect={directory=>void updateSettings({directory})}/> : null}
    {panel === 'settings' ? <SettingsPanel returnFocus={returnFocus.current} botName={catalog.botName} offline={offline} onClose={closePanel} onExit={() => setPanel('exit')} onLicenses={onLicenses}/> : null}
    {panel === 'attachment' ? <Sheet returnFocus={returnFocus.current} title="添加内容" onClose={closePanel}><button type="button" className="selection-row" onClick={()=>void pickAttachments('photos')}><Image size={20}/><span>照片</span></button><button type="button" className="selection-row" onClick={()=>void pickAttachments('files')}><Paperclip size={20}/><span>文件</span></button><p className="field-note">最多 3 个附件 · 图片 10MB · 文档 20MB</p></Sheet> : null}
    {panel === 'exit' ? <Sheet returnFocus={returnFocus.current} title="断开 Bot 连接？" onClose={() => setPanel('settings')} footer={<div className="split-actions"><button type="button" className="secondary-button" onClick={() => setPanel('settings')}>取消</button><button type="button" className="primary-button" onClick={onExit}>断开连接</button></div>}><p className="body-copy">将移除本机连接身份，再次连接需要扫码。云端已受理的任务继续执行，设备授权可在 PC 撤销。</p></Sheet> : null}
    {toast ? <div className="toast" role="status">{toast}</div> : null}
  </div>;
}
