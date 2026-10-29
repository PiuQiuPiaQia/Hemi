import {ErrorState, LoadingState, StateView, StatusNotice, Toast, UiProvider, useTransientMessage} from '@hemi/ui';
import {DirectoryControlButton, ModelSelectorControl, SessionUsage, ThinkingLevelStrip} from '@hemi/conversation-flow/controls';
import {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type TouchEvent} from 'react';
import {ChevronDown, Clock3, Menu, Image, Paperclip, WifiOff} from 'lucide-react';
import {ConversationFlow, type FlowActionHandler} from '@hemi/conversation-flow';
import {createConversationActionHandler, createConversationPresenter, projectConversationQueue, queueStoppedIdle} from '@hemi/conversation-flow/core';
import {useConnectionWarning, useConversation} from '@hemi/conversation-flow/react';
import {ConversationFlowProvider, PermissionRequestCard, TurnQueueTray} from '@hemi/conversation-flow/parts';
import {Composer} from './composer';
import {PreviewDrawer} from './components/preview-drawer';
import {previewTarget, taskArtifactReference, type MobilePreviewTarget} from './preview';
import {ComposerAttachments} from './components/composer-attachments';
import brandMark from './assets/hemi-mark.svg';
import type {MobileConversation, MobileSessionPatch, MobileWorkspace, MobileWorkspaceSnapshot} from './workspace';
import {createMobileHost} from './host/capacitor-host';
import {useAppViewport} from './host/app-viewport';
import {IconButton, Sheet} from './components/dialog';
import {ConversationDrawer} from './components/conversation-drawer';
import {ConnectionScreen} from './components/connection-screen';
import {AppBoundary} from './components/app-boundary';
import {SettingsPanel} from './components/chat-panels';
import {RuntimeFilesPanel} from './components/runtime-files-panel';
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
    <div className="mobile-content" inert={notices ? true : undefined}><AppBoundary key={workspace?.environmentId ?? 'connection'} onReturn={disconnect}>{workspace ? <MobileChat workspace={workspace} onExit={disconnect} onLicenses={openNotices}/> : restoring||restoreError ? <section className="connection-screen" aria-busy={restoring}><header className="simple-header"><strong>Hemi</strong></header>{restoring?<LoadingState className="connection-restore-status" description="正在恢复 Bot 连接…"/>:<ErrorState className="connection-restore-status" description={restoreError} actions={[{label:'重试恢复连接',className:'text-button',onAction:()=>setRestoreAttempt(value=>value+1)}]}/>}</section> : <ConnectionScreen initialPending={pendingTarget} onLicenses={openNotices} onConnected={connect}/>}</AppBoundary>{connectionError?<StatusNotice layout="touch" variant="inline" role="alert">{connectionError}</StatusNotice>:null}</div>
    {notices ? <Sheet returnFocus={noticeReturnFocus.current} title="开源许可" onClose={() => setNotices(false)}><iframe className="licenses-frame" title="第三方开源许可" src="./licenses/notices.txt"/></Sheet> : null}
  </main>;
}

type Panel = 'model' | 'thinking' | 'folder' | 'settings' | 'memory' | 'attachment' | 'exit' | null;
function MobileChat({workspace, onExit, onLicenses}: {workspace: MobileWorkspace; onExit(): void; onLicenses(): void}) {
  const catalog = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot);
  useEffect(() => workspace.retain(), [workspace]);
  const item = catalog.items.find(item => item.id === catalog.activeId);
  return item ? <ConnectedConversation key={item.id} workspace={workspace} catalog={catalog} item={item} onExit={onExit} onLicenses={onLicenses}/> : <EmptyWorkspace workspace={workspace} onExit={onExit}/>;
}

function EmptyWorkspace({workspace, onExit}: {workspace: MobileWorkspace; onExit(): void}) {
  const [creating, setCreating] = useState(false), [error, setError] = useState(''), [exiting,setExiting]=useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const exitTrigger=useRef<HTMLButtonElement>(null);
  const catalog=workspace.getSnapshot();
  const showConnectionWarning=useConnectionWarning(catalog.offline,workspace.environmentId);
  const create = async () => {setCreating(true); try {workspace.select(await workspace.create());} catch {setError('未能新建对话，请重试。');} finally {setCreating(false);}};
  const reconnect = async () => {
    if(reconnecting)return;
    setReconnecting(true);setError('');
    try {await workspace.reconnect?.();if(workspace.getSnapshot().offline)setError('未能恢复连接，请检查网络后重试。');}
    catch {setError('未能恢复连接，请检查网络后重试。');}
    finally {setReconnecting(false);}
  };
  return <><section className="connection-screen" inert={exiting?true:undefined}><header className="simple-header"><strong>Hemi</strong><button ref={exitTrigger} type="button" className="text-button" onClick={()=>setExiting(true)}>断开连接</button></header><StateView kind={catalog.offline?'loading':'empty'} className="connect-scroll" titleAs="h1" title={catalog.offline?'正在连接 Bot':'还没有对话'}>{showConnectionWarning&&catalog.error?<p className="body-copy" role="status">{catalog.error}</p>:null}<button type="button" className="primary-button full-width" disabled={creating || catalog.offline} onClick={() => void create()}>{creating ? '正在新建…' : '新建对话'}</button>{showConnectionWarning?<button type="button" className="text-button" disabled={reconnecting} onClick={()=>void reconnect()}>{reconnecting?'正在连接…':'重新连接'}</button>:null}{error ? <ErrorState role="status" description={error}/> : null}</StateView></section>{exiting?<Sheet returnFocus={exitTrigger.current} title="断开 Bot 连接？" onClose={()=>setExiting(false)} footer={<div className="split-actions"><button type="button" className="secondary-button" onClick={()=>setExiting(false)}>取消</button><button type="button" className="primary-button" onClick={onExit}>断开连接</button></div>}><p className="body-copy">将移除本机连接身份，再次连接需要扫码。云端已受理的任务继续执行，设备授权可在 PC 撤销。</p></Sheet>:null}</>;
}

function ConnectedConversation({workspace, catalog, item, onExit, onLicenses}: {workspace: MobileWorkspace; catalog: MobileWorkspaceSnapshot; item: MobileConversation; onExit(): void; onLicenses(): void}) {
  const client = workspace.getClient(item.id), state = useConversation(client), snapshot = state.snapshot;
  const [reconnecting, setReconnecting] = useState(false);
  const [drawer, setDrawer] = useState(false), [panel, setPanel] = useState<Panel>(null);
  const [selectionPortal, setSelectionPortal] = useState<HTMLDivElement|null>(null);
  const [preview,setPreview]=useState<MobilePreviewTarget|null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const queueTakingRef = useRef(false);
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  const [toast, setToast] = useTransientMessage<string>();
  const [cacheNotice, setCacheNotice] = useTransientMessage<string>(6000);
  useEffect(() => setCacheNotice(state.cacheNotice || null), [state.cacheNotice, setCacheNotice]);
  const [submittingRevision, setSubmittingRevision] = useState<number | null>(null);
  const [settingsError,setSettingsError]=useState('');
  const [selection, setSelection] = useState<MobileSessionPatch | null>(null);
  const selectionVersion = useRef(0), settingsWrites = useRef<Promise<void>>(Promise.resolve());
  const selectedModel = selection?.model ?? item.model;
  const selectedThinking = selection?.thinking ?? item.thinking ?? 'default';
  const currentModel = catalog.models.find(model => model.id === selectedModel);
  const modelName = currentModel?.name ?? '模型已移除';
  const modelOptions = currentModel ? catalog.models : [...catalog.models, {id: selectedModel, name: modelName, description: '当前模型已不在 Bot 目录，请重新选择', disabledReason: '请重新选择可用模型'}];
  const edge = useRef<{x: number; y: number} | null>(null), returnFocus = useRef<HTMLElement | null>(null);
  const queued = item.status === 'queued';
  const occupied = Boolean(item.control && item.control.ownerId !== catalog.clientId);
  const present = useMemo(createConversationPresenter, []), messages = useMemo(() => present(snapshot, [], state).filter(message => !(queued && message.author === 'assistant' && message.runId === snapshot?.activeRunId && !message.text && !message.parts?.length)), [present, snapshot, state.operations, state.connection, queued]);
  const scope = useMemo(() => ({...client.scope, generation: String(snapshot?.generation ?? 1)}), [client, snapshot?.generation]);
  const host = useMemo(() => workspace.host ?? createMobileHost(workspace.resources), [workspace]);
  const queue = useMemo(() => projectConversationQueue(snapshot, state.operations, state.connection), [snapshot, state.operations, state.connection]);
  const busy = Boolean(snapshot && snapshot.phase !== 'idle'), offline = catalog.offline || state.connection === 'offline';
  const activeTask = catalog.items.find(entry => item.waitingResource ? item.blockedBy?.includes(entry.id) : entry.status === 'running' || entry.status === 'waiting');
  const showConnectionWarning=useConnectionWarning(offline,workspace.environmentId);
  const submitting = submittingRevision === state.draft.revision;
  const unknown = state.operations.some(operation => operation.state === 'unknown');
  const recovering = Object.values(snapshot?.runs ?? {}).some(run => ['waiting', 'offline', 'connecting'].includes(run.recovery?.phase ?? ''));
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const openPreview = useCallback((next: MobilePreviewTarget) => {
    if (!previewRef.current) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previewRef.current = next;
    setPreview(next);
  }, []);
  const onAction = useMemo<FlowActionHandler>(() => {
    const ordinary = createConversationActionHandler(client, workspace.onAction ?? (async () => ({ok: false, error: {code: 'unsupported', message: '这项操作暂时无法在手机完成，请在电脑端操作。'}})));
    return async (action, context) => {
      if (action.type === 'preview.open') {
        if (context.signal.aborted) return {ok: false, error: {code: 'cancelled', message: '对话已切换'}};
        const next = previewTarget(action)!;
        if (next.kind === 'resource') {
          const location = taskArtifactReference(next.request.ref);
          if (location) {
            const flow = client.getSnapshot().snapshot;
            const artifact = (flow?.tasks[location.taskId]?.artifacts as Array<{id?:string;artifactId?:string;path?:string;name?:string}> | undefined)?.find(artifact => (artifact.id ?? artifact.artifactId) === location.artifactId);
            if (flow?.artifacts[location.artifactId]) next.request = {ref: {id: `deliverable:${location.artifactId}`, version: '0'}, name: artifact?.name};
            else if (artifact?.path) next.request = {href: artifact.path, name: artifact.name};
            else return {ok: false, error: {code: 'not-found', message: '这份子任务产物暂时无法读取，请核对最新状态。'}};
          }
        }
        openPreview(next);
        return {ok: true, value: {receipt: 'completed'}};
      }
      if (occupied && !(action.type === 'message.edit-state' && action.state === 'cancel'))
        return {ok: false, error: {code: 'conflict', message: '会话已被占用，请先抢占会话。'}};
      if (action.type === 'task.stop') {
        openPreview(previewTarget(action)!);
        return {ok: true, value: {receipt: 'completed'}};
      }
      if (action.type === 'message.edit-state' && action.state === 'begin') {
        try {await workspace.acquireControl?.(item.id);} catch(error) {return {ok: false, error: {code: 'conflict', message: error instanceof Error ? error.message : '会话已被占用'}};}
      }
      const result = await ordinary(action, context);
      if (action.type === 'message.edit-state' && result.ok) setEditing(action.state === 'begin' ? action.targetId : null);
      if (action.type === 'message.edit' && result.ok) setEditing(null);
      return result;
    };
  }, [client, workspace, item.id, occupied, openPreview]);
  const command = async (value: Record<string, unknown>) => {
    const result = await client.sendCommand(value);
    if (!result.ok && result.code !== 'unknown') setToast(result.message ?? '操作未完成，请核对当前状态');
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
    if(uploads.length||picking||submitting)return;
    const revision = state.draft.revision;
    setToast(null);
    setSubmittingRevision(revision);
    try {
      const result = await client.sendDraft();
      if (!result.ok && result.code !== 'unknown') setToast(result.message ?? '发送未完成，草稿已保留');
      else if (result.ok && offline) setToast('已保存在手机，连接恢复后发送');
    } finally { setSubmittingRevision(current => current === revision ? null : current); }
  };
  const openQueueEdit = async (id: string) => {
    if (queueTakingRef.current || saving || offline || uploads.length || picking || submitting) return;
    const source = snapshot?.pending.find(input => input.inputId === id);
    if (!source) return;
    queueTakingRef.current = true;
    setSaving(true);
    try {
      const result = await command({type: 'withdrawInput', inputId: id, expectedEditRevision: source.editRevision, restoreToDraft: true});
      if (!result.ok && result.code !== 'unknown') return;
      const removed = result.input ?? source;
      const input = removed.editDraft ?? removed;
      const restored = client.restoreQueuedInput({text: input.text, attachments: input.attachmentViews ?? [], references: input.references ?? [], skills: input.skills ?? []});
      setComposerFocusToken(value => value + 1);
      await restored;
    } finally {queueTakingRef.current = false; setSaving(false);}
  };
  const closePanel = () => {if(saving&&!selection)return;setSettingsError('');setPanel(null);};
  const select = (id: string) => {workspace.select(id); setDrawer(false); setEditing(null);};
  const create = async () => {try {workspace.select(await workspace.create()); setDrawer(false); setEditing(null);} catch {setToast('未能新建对话，请重试。');}};
  const updateSettings = async (patch: MobileSessionPatch) => {
    if((saving&&!selection)||offline)return false;
    const immediate = patch.directory === undefined;
    const version = ++selectionVersion.current;
    if (immediate) {setSelection(current=>({...current,...patch}));setPanel(null);}
    setSaving(true);setSettingsError('');
    const write = settingsWrites.current.catch(()=>{}).then(()=>workspace.update(item.id,patch));
    settingsWrites.current = write;
    try {await write;if(!immediate&&version===selectionVersion.current)setPanel(null);}
    catch(error){if(version===selectionVersion.current){const message=error instanceof Error?error.message:'未能切换设置，请重试。';if(immediate)setToast(message);else setSettingsError(message);}return false;}
    finally {if(version===selectionVersion.current){setSelection(null);setSaving(false);}}
  };
  const reconnect = async () => {
    if(reconnecting)return;
    setReconnecting(true);setToast(null);
    try {await workspace.reconnect?.();if(workspace.getSnapshot().offline || client.getSnapshot().connection!=='online')setToast('未能恢复连接，请检查网络后重试。');}
    catch {setToast('未能恢复连接，请检查网络后重试。');}
    finally {setReconnecting(false);}
  };
  const edgeStart = (event: TouchEvent<HTMLElement>) => {const point = event.touches[0]; edge.current = point.clientX - event.currentTarget.getBoundingClientRect().left <= 24 ? {x: point.clientX, y: point.clientY} : null;};
  const edgeEnd = (event: TouchEvent<HTMLElement>) => {const start = edge.current, point = event.changedTouches[0]; edge.current = null; if (!panel && start && point.clientX - start.x > 60 && Math.abs(point.clientY - start.y) < (point.clientX - start.x) * .65) setDrawer(true);};
  const withdraw = async (id: string) => {
    const entry = queue.items.find(item => item.queueItemId === id);
    if (entry?.operationId) {if (!await client.cancelWaiting(entry.operationId)) setToast('消息已经发出，正在确认发送状态');}
    else await command({type: 'withdrawInput', inputId: id});
  };
  const awaitingDelivery = state.operations.some(operation => operation.command.type === 'send' && ['waiting', 'sending', 'unknown'].includes(operation.state));
  const queueTray = <section className={`queue-region${queue.items.length ? '' : ' queue-region-outside'}`} aria-label="发送队列"><ConversationFlowProvider part scope={scope} host={host} onAction={onAction}><TurnQueueTray state={queue} stoppedIdle={!submitting && !awaitingDelivery && queueStoppedIdle(snapshot)} onWithdraw={withdraw} onEdit={offline || saving || picking || uploads.length ? undefined : openQueueEdit} onPromote={(id) => {void command({type: 'promoteInput', inputId: id});}} onReorder={(inputId, overInputId, expectedInputIds) => {void command({type: 'reorderInput', inputId, overInputId, expectedInputIds});}} onResume={() => {void command({type: 'resumeQueue'});}} onContinue={() => {void command({type: 'send', input: {text: '继续', inputSource: 'text', attachmentIds: []}});}}/></ConversationFlowProvider></section>;

  return <UiProvider portal={selectionPortal}><div className="navigation-stage">
    <div className={`app-surface ${drawer ? 'drawer-is-open' : ''}`} inert={drawer || panel || preview ? true : undefined} onClickCapture={event => {const trigger = (event.target as HTMLElement).closest('button'); if (trigger) returnFocus.current = trigger;}} onTouchStart={edgeStart} onTouchEnd={edgeEnd} onTouchCancel={() => {edge.current = null;}}>
        <header className="app-topbar chat-topbar"><IconButton label="打开对话列表" aria-haspopup="dialog" aria-expanded={drawer} onClick={() => setDrawer(true)}><Menu size={18}/></IconButton><button type="button" className="topbar-title title-button" aria-label="选择模型" aria-haspopup="dialog" aria-expanded={panel==='model'} disabled={offline||(saving&&!selection)} onClick={() => setPanel('model')}><strong>{item.title}</strong><small><span>{modelName}</span><ChevronDown size={12}/></small></button><DirectoryControlButton layout="touch" label={`工作目录：${item.directory}`} title={item.directory} disabled={offline||saving} aria-haspopup="dialog" aria-expanded={panel==='folder'} onClick={()=>setPanel('folder')}/></header>
        {cacheNotice ? <StatusNotice layout="touch" variant="note" actions={<button type="button" onClick={() => setCacheNotice(null)}>关闭提示</button>}>{cacheNotice}</StatusNotice> : null}
        {showConnectionWarning ? <StatusNotice layout="touch" icon={<WifiOff size={18} aria-hidden="true"/>} actions={workspace.reconnect ? <button type="button" disabled={reconnecting} onClick={() => void reconnect()}>{reconnecting?'正在连接…':'恢复连接'}</button> : null}>Bot 连接已断开</StatusNotice> : null}
        {queued && !offline ? <StatusNotice layout="touch" icon={<Clock3 size={18} aria-hidden="true"/>} title={item.waitingResource ? '等待资源' : '排队中'} detail={item.waitingResource ? activeTask ? `「${activeTask.title}」正在使用同一资源，相关操作结束后会自动继续。` : '同一资源正在使用中，相关操作结束后会自动继续。' : activeTask ? `「${activeTask.title}」${activeTask.status === 'waiting' ? '正在等待确认' : '正在执行'}，结束后会自动开始。` : '消息已受理，轮到后会自动开始。'} actions={activeTask ? <button type="button" onClick={() => select(activeTask.id)}>查看当前任务</button> : null}/> : null}
        {unknown ? <StatusNotice layout="touch" title="正在确认消息是否已发送" detail="网络中断过，正在自动确认。原文已保留，请勿重复发送。"/> : null}
        {occupied ? <StatusNotice layout="touch" title="会话已被占用" detail="另一台设备正在使用。抢占后可以继续编辑和发送。" actions={<button type="button" disabled={offline || saving} onClick={() => {setSaving(true);void workspace.acquireControl?.(item.id,true).catch(error=>setToast(error instanceof Error?error.message:'未能抢占会话')).finally(()=>setSaving(false));}}>抢占会话</button>}/> : null}
        {(!offline || showConnectionWarning) && (catalog.error || state.error) ? <StatusNotice layout="touch" variant="inline">{catalog.error || state.error}</StatusNotice> : null}
        {catalog.permissions?.filter(permission=>permission.conversationId===item.id).map(permission=><PermissionRequestCard key={permission.id} layout="touch" request={permission} disabled={offline||saving||!workspace.decidePermission} onChooseOption={value=>{setSaving(true);void workspace.decidePermission?.(permission.id,value).catch(()=>setToast('确认结果待核对，请恢复连接后刷新。')).finally(()=>setSaving(false));}}/>)}
        <section className="conversation-frame" aria-label="消息记录" style={{display: messages.length || state.history?.hasMore ? undefined : 'none'}}><ConversationFlow scope={scope} messages={messages} host={host} onAction={onAction} active={!drawer && !panel && !preview} state={{history:state.history?{...state.history,gap:state.history.gap?{...state.history.gap,load:()=>void client.loadHistory('gap')}:undefined,load:()=>void client.loadHistory()}:undefined,busy, readOnly: occupied, transientActionErrors: true, editingMessageId: editing, retryBlocked: offline ? '恢复连接后重试' : undefined, runActivity: snapshot?.runs[snapshot.activeRunId ?? '']?.activity ?? undefined}}/></section>
        {!messages.length ? <StateView as="section" className="empty-chat" kind={state.connection==='connecting'?'loading':'empty'} illustration={<img className="welcome-mark" src={brandMark} alt=""/>} titleAs="h1" title={state.connection==='connecting'?'正在读取对话…':'今天想做什么？'}/> : null}
        {!queue.items.length ? queueTray : null}
        <Composer readOnly={occupied} busy={busy} offline={offline} blocked={occupied || unknown || recovering || saving || picking || submitting || uploads.length>0} hasAttachments={state.draft.attachments.length>0} addBlocked={occupied || offline || picking || submitting || !workspace.attachmentsAvailable || state.draft.attachments.length+uploads.length>=3} stopBlocked={occupied || unknown} text={state.draft.text} onText={text => {if(occupied)return;if(!item.control)void workspace.acquireControl?.(item.id).catch(error=>setToast(error instanceof Error?error.message:'会话已被占用'));client.draft.setText(text);}} onSend={() => void send()} onStop={() => {void command({type: 'stop', targetRunId: snapshot?.activeRunId});}} onAdd={() => setPanel('attachment')} focusToken={composerFocusToken} controls={<>
          <ThinkingLevelStrip layout="touch" level={selectedThinking} onChange={thinking=>{void updateSettings({thinking});}} saving={saving&&!selection} offline={offline} error={settingsError} open={panel==='thinking'} onOpenChange={open=>open?setPanel('thinking'):closePanel()} returnFocus={returnFocus.current}/>
        </>}>
          <ComposerAttachments attachments={state.draft.attachments} uploads={uploads} disabled={saving} onRemove={id=>client.draft.setAttachments(previous=>previous.filter(file=>file.attachmentId!==id))} onCancel={id=>{void workspace.cancelUpload?.(id);}} onRetry={id=>workspace.retryUpload?.(id)}/>
          {picking?<StatusNotice layout="touch" variant="note">正在读取所选文件…</StatusNotice>:null}
          {queue.items.length ? queueTray : null}
          {offline && queue.items.some(item => item.operationId) ? <StatusNotice layout="touch" variant="note">尚未发送到 Bot</StatusNotice> : null}
        </Composer>
    </div>
    {preview ? <PreviewDrawer onSelect={openPreview} target={preview} messages={messages} scope={scope} host={host} transfers={workspace.resourceTransfers} onAction={onAction} readOnly={occupied} offline={offline} returnFocus={returnFocus.current} onClose={() => setPreview(null)} onStop={async runId => {if (!runId || runId !== snapshot?.activeRunId) {setToast('这条子任务已不属于当前执行，请核对最新状态。'); return false;} const result = await command({type: 'stop', targetRunId: runId}); return result.ok;}}/> : null}
    {drawer ? <ConversationDrawer onRename={workspace.rename?((id,title)=>workspace.rename!(id,title)):undefined} onRemove={workspace.remove?((id)=>workspace.remove!(id)):undefined} returnFocus={returnFocus.current} items={catalog.items} activeId={item.id} botName={catalog.botName} offline={offline} onSelect={select} onNew={() => void create()} onSettings={() => {setDrawer(false); setPanel('settings');}} onClose={() => setDrawer(false)}/> : null}
    <ModelSelectorControl layout="touch" showTrigger={false} models={modelOptions} selected={selectedModel} onSelect={model=>{void updateSettings({model});}} saving={saving&&!selection} offline={offline} error={settingsError} open={panel==='model'} onOpenChange={open=>open?setPanel('model'):closePanel()} returnFocus={returnFocus.current}/>
    {panel === 'folder' ? <DirectoryPanel returnFocus={returnFocus.current} workspace={workspace} path={item.directory} defaultPath={catalog.defaultDirectory} recent={catalog.recentDirectories??[]} saving={saving} offline={offline} error={settingsError} onClose={closePanel} onSelect={directory=>void updateSettings({directory})}/> : null}
    {panel === 'settings' ? <SettingsPanel onMemory={workspace.inspectAgentEnvironment ? () => setPanel('memory') : undefined} returnFocus={returnFocus.current} botName={catalog.botName} offline={offline} onClose={closePanel} onExit={() => setPanel('exit')} onLicenses={onLicenses}/> : null}
    {panel === 'attachment' ? <Sheet returnFocus={returnFocus.current} title="添加内容" onClose={closePanel}><button type="button" className="selection-row" onClick={()=>void pickAttachments('photos')}><Image size={20}/><span>照片</span></button><button type="button" className="selection-row" onClick={()=>void pickAttachments('files')}><Paperclip size={20}/><span>文件</span></button><p className="field-note">最多 3 个附件 · 图片 10MB · 文档 20MB</p></Sheet> : null}
    {panel === 'memory' ? <RuntimeFilesPanel workspace={workspace} returnFocus={returnFocus.current} onClose={() => setPanel('settings')} /> : null}
    {panel === 'exit' ? <Sheet returnFocus={returnFocus.current} title="断开 Bot 连接？" onClose={() => setPanel('settings')} footer={<div className="split-actions"><button type="button" className="secondary-button" onClick={() => setPanel('settings')}>取消</button><button type="button" className="primary-button" onClick={onExit}>断开连接</button></div>}><p className="body-copy">将移除本机连接身份，再次连接需要扫码。云端已受理的任务继续执行，设备授权可在 PC 撤销。</p></Sheet> : null}
    {toast ? <Toast layout="touch">{toast}</Toast> : null}
    <div ref={setSelectionPortal}/>
  </div><div className="mobile-usage-slot" inert={drawer || panel || preview ? true : undefined}><ConversationFlowProvider part scope={scope} host={host} onAction={onAction} active={!drawer && !panel && !preview}><SessionUsage layout="touch" records={item.usage ?? []} running={busy}/></ConversationFlowProvider></div></UiProvider>;
}
