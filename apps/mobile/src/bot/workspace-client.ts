import {createBotRealtime} from './realtime';
import {createMobileSnapshotStorage} from './snapshot-storage';
import {createBotResources, type MobileResourceFiles} from './resource-host';
import {createMobileUploads, type MobileFileSource, type MobileUpload} from './attachment-uploads';
import {applyConversationControl, createConversation, reconcileConversationList, sortConversationsByUpdatedAt, type ConversationControlReceipt, type ConversationClient, type ConversationIdentity, type ConversationOperation, type FlowSnapshotView, type StoredConversationDraft} from '@hemi/conversation-flow/core';
import type {MobileDirectory, MobileThinking, MobileWorkspace, MobileWorkspaceSnapshot} from '../workspace';
import {BotCommandRejected, createBotConversationTransport, type BotRpc} from './conversation-transport';
import type {BotTarget} from './native';
import type {UsageRecord} from '@hemi/conversation-flow/controls';

type Detail = {id: string; permissions: Record<string,{id: string;title: string;options: string[];status: string}>; usage?: Array<Pick<UsageRecord, 'modelKey'|'modelName'|'providerName'|'at'|'role'> & {usageDetail: Pick<UsageRecord, 'input'|'output'|'cacheRead'|'cacheWrite'|'genMs'> | null}>};
type Snapshot = {revision?:number;bootId?:string;notModified?:boolean;capabilities?: {nativeMemory?: number}; clientId?: string; instanceId: string; defaultDir: string; recentDirs: string[]; roleModels?: Record<string, string | null>; models: Array<{key: string; name: string; model: string; source?: 'local' | 'cloud'}>; sessions: Array<{id: string; title: string; updatedAt?: number; pinned?: boolean; modelKey: string; thinking: MobileThinking; dir: string; status: 'queued' | 'running' | 'waiting' | null; waitingPermission?: boolean; waitingResource?: boolean; blockedBy?: string[]; control?: {ownerId: string; epoch: string; expiresAt: number} | null}>; detail?: Detail};
export function createBotWorkspace({rpc, target, files, resourceFiles, storage = localStorage}: {rpc: BotRpc; target: BotTarget; files?: MobileFileSource; resourceFiles?: MobileResourceFiles; storage?: Storage}): MobileWorkspace {
  const environmentId = `bot:${target.botInstanceId}`, prefix = `hemi-mobile:${environmentId}:`;
  const clients = new Map<string, ConversationClient>(), listeners = new Set<() => void>(), removedIds = new Set<string>();
  const managing = new Set<string>();
  const acquiring = new Map<string, Promise<boolean>>();
  const snapshotStorage = createMobileSnapshotStorage(prefix, storage);
  let catalogRevision: number | undefined, catalogBootId: string | undefined;
  const read = <T>(key: string): T | null => {const raw = storage.getItem(prefix+key); return raw ? JSON.parse(raw) as T : null;};
  const write = (key:string,value:unknown) => {
    try{storage.setItem(prefix+key,JSON.stringify(value));}
    catch(error){if((error as {name?:string}).name==='QuotaExceededError')throw new Error('本机存储空间不足，内容已保留在当前页面，请释放空间后重试。');throw error;}
  };
  const cacheCatalog=()=>{try{write('catalog',{...snapshot,items:snapshot.items.map(({usage:_usage,...item})=>item)});}catch{/* Optional metadata caching cannot reject an acknowledged action or disconnect a live channel. */}};
  let snapshot: MobileWorkspaceSnapshot = {items: [], activeId: null, models: [], botName: new URL(target.endpoint).host, offline: true, error: ''};
  let catalogReady = false, connectionEpoch = 0;
  try {const cached = read<MobileWorkspaceSnapshot>('catalog'); if (cached && Array.isArray(cached.items) && Array.isArray(cached.models)) {snapshot = {...cached, offline: true, error: ''};catalogReady=true;}} catch { /* Metadata can be refreshed without discarding drafts or the operation journal. */ }
  let latestUpdatedAt = new Map(snapshot.items.map(item => [item.id, item.updatedAt]));
  let retains = 0, timer: ReturnType<typeof setInterval> | null = null, stop: ReturnType<typeof setTimeout> | null = null, closed = false, loading: Promise<void> | null = null;
  let catalogRequest: AbortController | null = null;
  const pending = new Set<AbortController>();
  const publish = (patch: Partial<MobileWorkspaceSnapshot>) => {if (closed) return; snapshot = {...snapshot,...patch}; for (const listener of listeners) listener();};
  async function request<T>(method: string, params: Record<string,unknown> = {}, signal?: AbortSignal): Promise<T> {
    if(closed)throw new DOMException('Bot 连接已关闭','AbortError');
    const controller = new AbortController(); pending.add(controller);
    const abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)controller.abort();
    try {
      const owner = snapshot.items.find(item => item.id === params.id)?.control;
      const epoch = owner?.ownerId === snapshot.clientId ? owner?.epoch : undefined;
      const result=await rpc.request<T>(method,{...params, ...(epoch && params.controlEpoch === undefined && ['flow.command','session.update','session.draft','permission.decide'].includes(method) ? {controlEpoch: epoch} : {}), instanceId: target.botInstanceId},{signal:controller.signal});
      controller.signal.throwIfAborted();if(closed)throw new DOMException('Bot 连接已关闭','AbortError');return result;
    }
    catch(error){if((error as {code?:string}).code==='permission')resources?.clear();throw error;}
    finally {signal?.removeEventListener('abort',abort);pending.delete(controller);}
  }
  async function nativeFiles<T>(method: string, params: Record<string,unknown> = {}): Promise<T> {
    const info = await request<Snapshot>('snapshot');
    if (info.capabilities?.nativeMemory !== 1) throw new Error('请在桌面更新 Bot 运行组件后使用共享记忆。');
    return request<T>(method, params);
  }
  function applyCatalog(value: Snapshot) {
    if (value.instanceId !== target.botInstanceId) throw new Error('Bot 会话列表身份无效');
    if (value.notModified) return;
    if (!Array.isArray(value.sessions) || !Array.isArray(value.models)) throw new Error('Bot 会话列表格式无效');
    const cachedUsage = new Map(snapshot.items.map(item=>[item.id,item.usage]));
    const incoming = value.sessions.filter(item=>!removedIds.has(item.id)).map(item=>({id:item.id,title:item.title,updatedAt:item.updatedAt,pinned:item.pinned===true,model:item.modelKey,thinking:item.thinking??'default',directory:item.dir,running:!!item.status,waitingResource:item.waitingResource,blockedBy:item.blockedBy,control:item.control,status:item.status==='queued'?'queued' as const:item.waitingPermission?'waiting' as const:item.status,usage:cachedUsage.get(item.id)}));
    latestUpdatedAt = new Map(incoming.map(item => [item.id, item.updatedAt]));
    const items = reconcileConversationList(snapshot.items, incoming);
    const activeId = items.some(item=>item.id===snapshot.activeId) ? snapshot.activeId : items[0]?.id ?? null;
    const detail = value.detail?.id===activeId ? value.detail : null;
    const detailedItem = items.find(item=>item.id===detail?.id);
    if (detailedItem && detail) detailedItem.usage = (detail.usage ?? []).map(call=>({
      source:'chat',role:call.role,modelKey:call.modelKey,modelName:call.modelName,providerName:call.providerName || value.models.find(model=>model.key===call.modelKey)?.name,requestedModel:call.modelName,at:call.at,
      input:call.usageDetail?.input??0,output:call.usageDetail?.output??0,cacheRead:call.usageDetail?.cacheRead??0,cacheWrite:call.usageDetail?.cacheWrite??0,genMs:call.usageDetail?.genMs??0,missing:call.usageDetail?0:1,
    }));
    const permissions = detail ? Object.values(detail.permissions??{}).filter(p=>p.status==='pending').map(p=>({...p,conversationId:activeId!})) : snapshot.permissions?.filter(p=>p.conversationId===activeId)??[];
    catalogReady = true; catalogRevision=value.revision;catalogBootId=value.bootId;
    const mainModel=value.models.find(model=>model.key===value.roleModels?.main),autoHint=mainModel?`主 agent ${mainModel.model}`:'角色模型已失效';
    publish({clientId:value.clientId??snapshot.clientId,items,activeId,permissions,defaultDirectory:value.defaultDir,recentDirectories:value.recentDirs??[],models:[...(value.roleModels?.main?[{id:'auto',name:'自动路由',description:autoHint,source:'local' as const}]:[]),...value.models.map(model=>({id:model.key,name:model.model||model.key,description:model.name&&model.name!==model.model?model.name:undefined,source:model.source}))],error:''});
    cacheCatalog();
  }
  async function refresh(restart = false) {
    if (closed) return;
    if (loading && !restart) return loading;
    if (restart) catalogRequest?.abort();
    const controller=new AbortController();catalogRequest=controller;
    const work=(async()=>{
      try {
        const value=await request<Snapshot>('snapshot',{...(snapshot.activeId?{id:snapshot.activeId}:{}),detail:'metadata',...(catalogRevision!==undefined?{revision:catalogRevision,bootId:catalogBootId}:{})},controller.signal);
        if(!realtime.available && !value.notModified && !value.detail) {
          const active=value.sessions?.find(item=>item.id===snapshot.activeId)?.id??value.sessions?.[0]?.id;
          if(active)value.detail=await request<Detail>('session.open',{id:active,activate:false,detail:'metadata'},controller.signal);
        }
        controller.signal.throwIfAborted();applyCatalog(value);
        if(!realtime.available)publish({offline:false,error:''});
      } catch(error) {
        if(!controller.signal.aborted)publish({error:error instanceof Error?error.message:'未能更新 Bot 会话列表。',...(!realtime.available?{offline:true}:{})});
      }
    })().finally(()=>{if(loading===work){loading=null;catalogRequest=null;}});
    loading=work;return work;
  }
  let realtimeRefresh:ReturnType<typeof setTimeout>|undefined;
  const realtime=createBotRealtime(rpc,target.botInstanceId,value=>{
    if(value){try{applyCatalog(value as Snapshot);}catch(error){publish({error:error instanceof Error?error.message:'Bot 会话列表无效'});}return;}
    if(!realtimeRefresh)realtimeRefresh=setTimeout(()=>{realtimeRefresh=undefined;void refresh();},60);
  },state=>{
    connectionEpoch++;
    if(state==='offline')publish({offline:true});
    else if(state==='online'&&catalogReady)publish({offline:false,error:''});
  });
  async function refreshAfterMutation() {await refresh();}
  function applyControl(id:string,receipt:ConversationControlReceipt) {
    const items=applyConversationControl(snapshot.items,id,receipt);
    if(items!==snapshot.items){publish({items});cacheCatalog();}
  }
  async function releaseControl(id:string,epoch?:string) {
    const result=await request<ConversationControlReceipt>('session.control',{id,action:'release',controlEpoch:epoch});
    applyControl(id,result);
  }
  type ManagementOperation = {method:'session.rename'|'session.remove';params:{id:string;requestId:string;title?:string}};
  async function manage(method: ManagementOperation['method'], id: string, title?: string) {
    if(managing.has(id))throw new Error('会话操作正在进行，请稍候。');
    if(snapshot.offline)throw new Error('恢复连接后可管理会话。');
    managing.add(id);
    const journalKey='manage:'+id;
    const finish=async(operation:ManagementOperation,result:{ok?:boolean;session?:{title:string}})=>{
      if(result?.ok!==true)throw new Error('Bot 未返回有效的会话操作回执。');
      storage.removeItem(prefix+journalKey);
      if(operation.method==='session.remove'){
        removedIds.add(id);clients.get(id)?.dispose();clients.delete(id);
        for(const kind of ['draft','operations','snapshot'])storage.removeItem(prefix+id+':'+kind);void snapshotStorage.remove(id);
        const items=snapshot.items.filter(item=>item.id!==id);
        publish({items,activeId:snapshot.activeId===id?items[0]?.id??null:snapshot.activeId,permissions:snapshot.permissions?.filter(item=>item.conversationId!==id)});
      }else publish({items:snapshot.items.map(item=>item.id===id?{...item,title:result.session?.title??operation.params.title!}:item)});
      cacheCatalog();await refreshAfterMutation();
    };
    try{
      let operation=read<ManagementOperation>(journalKey);
      if(operation){
        const receipt=await request<{status:string;result?:{ok:boolean;session?:{title:string}}}>('operation.get',{operationId:operation.params.requestId});
        if(receipt.status==='done'&&receipt.result){
          const same=operation.method===method&&operation.params.title===title;
          await finish(operation,receipt.result);if(same)return;operation=null;
        }else if(receipt.status!=='missing'||operation.method!==method||operation.params.title!==title)throw new Error('上次会话操作结果待核对，请恢复连接后重试。');
        // A deliberate retry reuses the original request and idempotency key.
      }
      if(!operation){
        if(!snapshot.items.some(item=>item.id===id))throw new Error('会话已不存在，请刷新列表。');
        operation={method,params:{id,requestId:crypto.randomUUID(),...(title!==undefined?{title}:{})}};
        write(journalKey,operation);
      }
      let result:{ok:boolean;session?:{title:string}};
      try{result=await request(operation.method,operation.params);}
      catch(error){
        if(error instanceof BotCommandRejected){storage.removeItem(prefix+journalKey);throw error;}
        const receipt=await request<{status:string;result?:{ok:boolean;session?:{title:string}}}>('operation.get',{operationId:operation.params.requestId}).catch(()=>null);
        if(receipt?.status!=='done'||!receipt.result){await refreshAfterMutation();throw new Error('会话操作结果待核对，请恢复连接后重试。');}
        result=receipt.result;
      }
      await finish(operation,result);
    }finally{managing.delete(id);}
  }
  const lifecycle = {subscribe(receive: (event: 'resume'|'suspend'|'online'|'offline')=>void) {
    if(typeof document==='undefined')return()=>{};
    const visibility=()=>{if(document.hidden && snapshot.activeId)void releaseControl(snapshot.activeId,snapshot.items.find(item=>item.id===snapshot.activeId)?.control?.epoch).catch(()=>{});receive(document.hidden ? 'suspend':'resume');}, online=()=>receive('online'), offline=()=>receive('offline');
    document.addEventListener('visibilitychange',visibility);window.addEventListener('online',online);window.addEventListener('offline',offline);
    return()=>{document.removeEventListener('visibilitychange',visibility);window.removeEventListener('online',online);window.removeEventListener('offline',offline);};
  }};
  const workspace: MobileWorkspace = {
    environmentId,
    getSnapshot:()=>snapshot,
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    retain(){
      retains++; if(stop)clearTimeout(stop);
      if(!timer&&!realtime.available){void refresh();timer=setInterval(()=>{if(typeof document==='undefined'||!document.hidden)void refresh();},4000);}
      const releaseRealtime=realtime.retain();
      const unsubscribe=lifecycle.subscribe(event=>{if(event==='resume'||event==='online'){void realtime.resume().catch(()=>{});if(!realtime.available)void refresh(true);}else {realtime.suspend();if(event==='offline')publish({offline:true});}});
      let released=false;
      return()=>{if(released)return;released=true;unsubscribe();releaseRealtime();if(--retains===0)stop=setTimeout(()=>{if(!retains&&timer){clearInterval(timer);timer=null;}},0);};
    },
    getClient(id){
      if(removedIds.has(id))throw new Error('会话已删除。');
      if(!clients.has(id)) {
        const key=(scope: ConversationIdentity,kind: string)=>`${scope.conversationId}:${kind}`;
        const client=createConversation({scope:{environmentId,conversationId:id},transport:createBotConversationTransport({...rpc,request:(method,params,context)=>request(method,params,context.signal)},target.botInstanceId,id,realtime.available?(_scope,receive,offline,online)=>realtime.subscribe(id,receive,offline??(()=>{}),online):undefined,realtime.available?()=>realtime.resume():undefined,command=>{const control=snapshot.items.find(item=>item.id===id)?.control;return {...command,...(control&&control.ownerId===snapshot.clientId?{controlEpoch:control.epoch}:{})};}),lifecycle,requestTimeoutMs:35000,pollIntervalMs:realtime.available?0:2000,storage:{
          drafts:{async load(scope){return read<StoredConversationDraft>(key(scope,'draft'));},async save(scope,value){if(!removedIds.has(id))write(key(scope,'draft'),value);return {ok:true};}},
          operations:{async load(scope){return read<ConversationOperation[]>(key(scope,'operations'));},async save(scope,value){if(!removedIds.has(id))write(key(scope,'operations'),value);}},
          snapshots:snapshotStorage,
        }});
        let leases=0, initialization: Promise<void> | null=null;
        const owned: ConversationClient={...client,start(){return initialization??=client.start();},retain(){void owned.start();leases++;const release=client.retain();let released=false;return()=>{if(released)return;released=true;leases--;release();queueMicrotask(()=>{if(!leases&&clients.get(id)===owned)clients.delete(id);});};}};
        clients.set(id,owned);
      }
      return clients.get(id)!;
    },
    select(id){if(!snapshot.items.some(item=>item.id===id))return;const previous=snapshot.items.find(item=>item.id===snapshot.activeId);if(previous&&previous.id!==id)void releaseControl(previous.id,previous.control?.epoch).catch(()=>{});const items=sortConversationsByUpdatedAt(snapshot.items.map(item=>({...item,updatedAt:latestUpdatedAt.get(item.id)??item.updatedAt})));publish({activeId:id,items,permissions:[]});cacheCatalog();void refresh();},
    async acquireControl(id,takeover=false){
      if(acquiring.has(id))return acquiring.get(id)!;
      const work=(async()=>{const result=await request<ConversationControlReceipt & {message?:string}>('session.control',{id,action:takeover?'takeover':'acquire'});
        applyControl(id,result);if(!result.ok)throw new Error(result.message??'会话已被占用，请先抢占会话。');return true;
      })().finally(()=>acquiring.delete(id));acquiring.set(id,work);return work;
    },
    async create(){
      let requestId=read<string>('create-operation');
      if(requestId){
        const receipt=await request<{status:string;result?:{id:string}}>('operation.get',{operationId:requestId});
        if(receipt.status==='done'&&receipt.result?.id){storage.removeItem(prefix+'create-operation');await refresh();return receipt.result.id;}
        throw new Error('上次新建对话的结果待核对，请稍后重试。');
      }
      requestId=crypto.randomUUID();write('create-operation',requestId);
      try {const value=await request<{id:string}>('session.create',{requestId});storage.removeItem(prefix+'create-operation');await refresh();return value.id;}
      catch(error){if(error instanceof BotCommandRejected)storage.removeItem(prefix+'create-operation');throw error;}
    },
    inspectAgentEnvironment: () => nativeFiles('agent-environment.inspect'),
    readAgentRuntimeFile: path => nativeFiles('agent-environment.read-file', {path}),
    async rename(id,title){
      const next=title.trim();if(!next)throw new Error('请输入会话名称。');
      await manage('session.rename',id,next.slice(0,100));
    },
    async remove(id){
      if(snapshot.offline)throw new Error('恢复连接后可管理会话。');
      for(const job of snapshot.uploads?.filter(item=>item.conversationId===id)??[])await uploads.cancel(job.id);
      await manage('session.remove',id);
    },
    async update(id,patch){
      const params:Record<string,unknown>={id,requestId:crypto.randomUUID()};
      if(patch.model!==undefined)params.modelKey=patch.model;
      if(patch.thinking!==undefined)params.thinking=patch.thinking;
      if(patch.directory!==undefined)params.dir=patch.directory;
      try {const result=await request<{ok:boolean;snapshot?:Snapshot}>('session.update',{...params,includeSnapshot:true});if(result.snapshot)applyCatalog(result.snapshot);}
      catch(error){
        if(error instanceof BotCommandRejected)throw error;
        // Read the original receipt after a lost reply; never replay a settings mutation.
        const receipt=await request<{status:string;result?:{ok:boolean}}>('operation.get',{operationId:params.requestId}).catch(()=>null);
        await refreshAfterMutation();
        if(receipt?.status==='done'&&receipt.result?.ok)return;
        throw new Error('设置结果待核对，请恢复连接后查看当前选项。');
      }
      void refresh();
    },
    async listDirectories(path,signal){return request<MobileDirectory>('directory.list',{path},signal);},
    async reconnect(){if(!realtime.available){await refresh(true);await Promise.all(Array.from(clients.values(),client=>client.refresh()));return;}await Promise.all([realtime.resume(),...Array.from(clients.values(),client=>client.refresh())]);},
    async decidePermission(permissionId,value){
      const permission=snapshot.permissions?.find(p=>p.id===permissionId&&p.conversationId===snapshot.activeId);
      if(!permission||!permission.options.includes(value))throw new Error('确认已变化，请刷新后核对。');
      await request('permission.decide',{id:permission.conversationId,permissionId,value,requestId:crypto.randomUUID()});publish({permissions:snapshot.permissions?.filter(p=>p.id!==permissionId)});void refresh();
    },
    dispose(){resources.dispose();uploads.dispose();closed=true;realtime.close();if(realtimeRefresh)clearTimeout(realtimeRefresh);if(timer)clearInterval(timer);if(stop)clearTimeout(stop);for(const controller of pending)controller.abort();for(const client of clients.values())client.dispose();clients.clear();listeners.clear();},
  };
  const resources=createBotResources({environmentId,request,files:resourceFiles});
  workspace.resources=resources;workspace.resourceTransfers=resources;
  const uploads=createMobileUploads({files,request,getClient:workspace.getClient,load:()=>read<MobileUpload[]>('uploads')??[],save:jobs=>write('uploads',jobs),publish:uploads=>publish({uploads})});
  workspace.attachmentsAvailable=uploads.available;workspace.pickAttachments=uploads.pick;workspace.retryUpload=uploads.retry;workspace.cancelUpload=uploads.cancel;
  return workspace;
}
