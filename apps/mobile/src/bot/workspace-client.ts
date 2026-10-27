import {createBotRealtime} from './realtime';
import {createBotResources, type MobileResourceFiles} from './resource-host';
import {createMobileUploads, type MobileFileSource, type MobileUpload} from './attachment-uploads';
import {createConversation, type ConversationClient, type ConversationIdentity, type ConversationOperation, type FlowSnapshotView, type StoredConversationDraft} from '@hemi/conversation-flow/core';
import type {MobileDirectory, MobileThinking, MobileWorkspace, MobileWorkspaceSnapshot} from '../workspace';
import {BotCommandRejected, createBotConversationTransport, type BotRpc} from './conversation-transport';
import type {BotTarget} from './native';
import type {UsageRecord} from '@hemi/conversation-flow/controls';

type Detail = {id: string; permissions: Record<string,{id: string;title: string;options: string[];status: string}>; usage?: Array<Pick<UsageRecord, 'modelKey'|'modelName'|'providerName'|'at'|'role'> & {usageDetail: Pick<UsageRecord, 'input'|'output'|'cacheRead'|'cacheWrite'|'genMs'> | null}>};
type Snapshot = {capabilities?: {nativeMemory?: number}; clientId?: string; instanceId: string; defaultDir: string; recentDirs: string[]; roleModels?: Record<string, string | null>; models: Array<{key: string; name: string; model: string; source?: 'local' | 'cloud'}>; sessions: Array<{id: string; title: string; modelKey: string; thinking: MobileThinking; dir: string; status: 'queued' | 'running' | null; waitingPermission?: boolean; waitingResource?: boolean; blockedBy?: string[]; control?: {ownerId: string; epoch: string; expiresAt: number} | null}>; detail?: Detail};
export function createBotWorkspace({rpc, target, files, resourceFiles, storage = localStorage}: {rpc: BotRpc; target: BotTarget; files?: MobileFileSource; resourceFiles?: MobileResourceFiles; storage?: Storage}): MobileWorkspace {
  const environmentId = `bot:${target.botInstanceId}`, prefix = `hemi-mobile:${environmentId}:`;
  const clients = new Map<string, ConversationClient>(), listeners = new Set<() => void>(), removedIds = new Set<string>();
  const managing = new Set<string>();
  const acquiring = new Map<string, Promise<boolean>>();
  const read = <T>(key: string): T | null => {const raw = storage.getItem(prefix+key); return raw ? JSON.parse(raw) as T : null;};
  const write = (key: string, value: unknown) => storage.setItem(prefix+key, JSON.stringify(value));
  let snapshot: MobileWorkspaceSnapshot = {items: [], activeId: null, models: [], botName: new URL(target.endpoint).host, offline: true, error: ''};
  let catalogReady = false, connectionEpoch = 0;
  try {const cached = read<MobileWorkspaceSnapshot>('catalog'); if (cached && Array.isArray(cached.items) && Array.isArray(cached.models)) {snapshot = {...cached, offline: true, error: ''};catalogReady=true;}} catch { /* Metadata can be refreshed without discarding drafts or the operation journal. */ }
  let retains = 0, timer: ReturnType<typeof setInterval> | null = null, stop: ReturnType<typeof setTimeout> | null = null, closed = false, loading: Promise<void> | null = null;
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
      return await rpc.request<T>(method,{...params, ...(epoch && params.controlEpoch === undefined && ['flow.command','session.update','session.draft','permission.decide'].includes(method) ? {controlEpoch: epoch} : {}), instanceId: target.botInstanceId},{signal:controller.signal});
    }
    catch(error){if((error as {code?:string}).code==='permission')resources?.clear();throw error;}
    finally {signal?.removeEventListener('abort',abort);pending.delete(controller);}
  }
  async function nativeFiles<T>(method: string, params: Record<string,unknown> = {}): Promise<T> {
    const info = await request<Snapshot>('snapshot');
    if (info.capabilities?.nativeMemory !== 1) throw new Error('请在桌面更新 Bot 运行组件后使用共享记忆。');
    return request<T>(method, params);
  }
  async function refresh() {
    if (closed) return;
    if (loading) return loading;
    const epoch = connectionEpoch;
    loading = (async()=>{
      try {
        const requestedId=snapshot.activeId;
        const value = await request<Snapshot>('snapshot',requestedId ? {id:requestedId} : {});
        if (value.instanceId !== target.botInstanceId || !Array.isArray(value.sessions) || !Array.isArray(value.models)) throw new Error('Bot 会话列表身份或格式无效');
        const cachedUsage = new Map(snapshot.items.map(item=>[item.id,item.usage]));
        const items = value.sessions.filter(item=>!removedIds.has(item.id)).map(item=>({id:item.id,title:item.title,pinned:false,model:item.modelKey,thinking:item.thinking??'default',directory:item.dir,running:!!item.status,waitingResource:item.waitingResource,blockedBy:item.blockedBy,control:item.control,status:item.status==='queued'?'queued' as const:item.waitingPermission?'waiting' as const:item.status,usage:cachedUsage.get(item.id)}));
        const activeId = items.some(item=>item.id===snapshot.activeId) ? snapshot.activeId : items[0]?.id ?? null;
        const detail=value.detail?.id===activeId ? value.detail : (activeId ? await request<Detail>('session.open',{id:activeId,activate:false}) : null);
        const detailedItem = items.find(item=>item.id===detail?.id);
        if (detailedItem && detail) detailedItem.usage = (detail.usage ?? []).map(call=>({
          source:'chat',role:call.role,modelKey:call.modelKey,modelName:call.modelName,providerName:call.providerName || value.models.find(model=>model.key===call.modelKey)?.name,requestedModel:call.modelName,at:call.at,
          input:call.usageDetail?.input??0,output:call.usageDetail?.output??0,
          cacheRead:call.usageDetail?.cacheRead??0,cacheWrite:call.usageDetail?.cacheWrite??0,genMs:call.usageDetail?.genMs??0,
          missing:call.usageDetail ? 0 : 1,
        }));
        const permissions=detail?.id===activeId ? Object.values(detail.permissions ?? {}).filter(p=>p.status==='pending').map(p=>({...p,conversationId:activeId!})) : [];
        catalogReady = true;
        const mainModel = value.models.find(model=>model.key===value.roleModels?.main);
        const autoHint = mainModel ? `主 agent ${mainModel.model}` : '角色模型已失效';
        // 服务器 publicModel 的 name 是供应商名（PC 端用作分组目录），行标题须用 model（型号）。
        publish({clientId: value.clientId,items,activeId,permissions,defaultDirectory:value.defaultDir,recentDirectories:value.recentDirs??[],models:[...(value.roleModels?.main ? [{id:'auto',name:'自动路由',description:autoHint,source:'local' as const}] : []),...value.models.map(model=>({id:model.key,name:model.model||model.key,description:model.name&&model.name!==model.model?model.name:undefined,source:model.source}))],offline:false,error:''});
        write('catalog',snapshot);
      } catch (error) {
        // Authenticated events received after this request began are newer connection evidence.
        if (epoch === connectionEpoch || !catalogReady) publish({offline:true,error:error instanceof Error ? error.message : '未能读取 Bot，请检查网络后重试。'});
      }
    })().finally(()=>{loading=null;});
    return loading;
  }
  let realtimeRefresh:ReturnType<typeof setTimeout>|undefined;
  const realtime=createBotRealtime(rpc,target.botInstanceId,()=>{if(!realtimeRefresh)realtimeRefresh=setTimeout(()=>{realtimeRefresh=undefined;void refreshAfterMutation();},60);},()=>{
    connectionEpoch++;
    if(catalogReady && (snapshot.offline || snapshot.error))publish({offline:false,error:''});
  });
  async function refreshAfterMutation() {
    // A poll begun before the mutation may still hold the previous settings.
    if(loading)await loading;
    await refresh();
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
        for(const kind of ['draft','operations','snapshot'])storage.removeItem(prefix+id+':'+kind);
        const items=snapshot.items.filter(item=>item.id!==id);
        publish({items,activeId:snapshot.activeId===id?items[0]?.id??null:snapshot.activeId,permissions:snapshot.permissions?.filter(item=>item.conversationId!==id)});
      }else publish({items:snapshot.items.map(item=>item.id===id?{...item,title:result.session?.title??operation.params.title!}:item)});
      write('catalog',snapshot);await refreshAfterMutation();
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
    const visibility=()=>{if(document.hidden && snapshot.activeId)void request('session.control',{id:snapshot.activeId,action:'release',controlEpoch:snapshot.items.find(item=>item.id===snapshot.activeId)?.control?.epoch}).catch(()=>{});receive(document.hidden ? 'suspend':'resume');}, online=()=>receive('online'), offline=()=>receive('offline');
    document.addEventListener('visibilitychange',visibility);window.addEventListener('online',online);window.addEventListener('offline',offline);
    return()=>{document.removeEventListener('visibilitychange',visibility);window.removeEventListener('online',online);window.removeEventListener('offline',offline);};
  }};
  const workspace: MobileWorkspace = {
    environmentId,
    getSnapshot:()=>snapshot,
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    retain(){
      retains++; if(stop)clearTimeout(stop);
      if(!timer){void refresh();timer=setInterval(()=>{if(typeof document==='undefined'||!document.hidden)void refresh();},realtime.available?30000:4000);}
      const releaseRealtime=realtime.retain();
      const unsubscribe=lifecycle.subscribe(event=>{if(event==='resume'||event==='online'){realtime.resume();void refresh();for(const client of clients.values())void client.refresh();}else realtime.suspend();});
      let released=false;
      return()=>{if(released)return;released=true;unsubscribe();releaseRealtime();if(--retains===0)stop=setTimeout(()=>{if(!retains&&timer){clearInterval(timer);timer=null;}},0);};
    },
    getClient(id){
      if(removedIds.has(id))throw new Error('会话已删除。');
      if(!clients.has(id)) {
        const key=(scope: ConversationIdentity,kind: string)=>`${scope.conversationId}:${kind}`;
        const client=createConversation({scope:{environmentId,conversationId:id},transport:createBotConversationTransport({...rpc,request:(method,params,context)=>request(method,params,context.signal)},target.botInstanceId,id,realtime.available?(_scope,receive,offline,online)=>realtime.subscribe(id,receive,offline??(()=>{}),online):undefined),lifecycle,requestTimeoutMs:35000,pollIntervalMs:realtime.available?30000:2000,storage:{
          drafts:{async load(scope){return read<StoredConversationDraft>(key(scope,'draft'));},async save(scope,value){if(!removedIds.has(id))write(key(scope,'draft'),value);return {ok:true};}},
          operations:{async load(scope){return read<ConversationOperation[]>(key(scope,'operations'));},async save(scope,value){if(!removedIds.has(id))write(key(scope,'operations'),value);}},
          snapshots:{async load(scope){return read<FlowSnapshotView>(key(scope,'snapshot'));},async save(scope,value){if(!removedIds.has(id))write(key(scope,'snapshot'),value);}},
        }});
        let leases=0, initialization: Promise<void> | null=null;
        const owned: ConversationClient={...client,start(){return initialization??=client.start();},retain(){void owned.start();leases++;const release=client.retain();let released=false;return()=>{if(released)return;released=true;leases--;release();queueMicrotask(()=>{if(!leases&&clients.get(id)===owned)clients.delete(id);});};}};
        clients.set(id,owned);
      }
      return clients.get(id)!;
    },
    select(id){if(!snapshot.items.some(item=>item.id===id))return;const previous=snapshot.items.find(item=>item.id===snapshot.activeId);if(previous&&previous.id!==id)void request('session.control',{id:previous.id,action:'release',controlEpoch:previous.control?.epoch}).catch(()=>{});publish({activeId:id,permissions:[]});write('catalog',snapshot);void refresh();},
    async acquireControl(id,takeover=false){
      if(acquiring.has(id))return acquiring.get(id)!;
      const work=(async()=>{const result=await request<{ok:boolean;message?:string}>('session.control',{id,action:takeover?'takeover':'acquire'});
        await refreshAfterMutation();if(!result.ok)throw new Error(result.message??'会话已被占用，请先抢占会话。');return true;
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
      try {await request('session.update',params);}
      catch(error){
        if(error instanceof BotCommandRejected)throw error;
        // Read the original receipt after a lost reply; never replay a settings mutation.
        const receipt=await request<{status:string;result?:{ok:boolean}}>('operation.get',{operationId:params.requestId}).catch(()=>null);
        await refreshAfterMutation();
        if(receipt?.status==='done'&&receipt.result?.ok)return;
        throw new Error('设置结果待核对，请恢复连接后查看当前选项。');
      }
      await refreshAfterMutation();
    },
    async listDirectories(path,signal){return request<MobileDirectory>('directory.list',{path},signal);},
    async reconnect(){realtime.resume();await refresh();for(const client of clients.values())await client.refresh();},
    async decidePermission(permissionId,value){
      const permission=snapshot.permissions?.find(p=>p.id===permissionId&&p.conversationId===snapshot.activeId);
      if(!permission||!permission.options.includes(value))throw new Error('确认已变化，请刷新后核对。');
      await request('permission.decide',{id:permission.conversationId,permissionId,value,requestId:crypto.randomUUID()});await refresh();
    },
    dispose(){resources.dispose();uploads.dispose();closed=true;realtime.close();if(realtimeRefresh)clearTimeout(realtimeRefresh);if(timer)clearInterval(timer);if(stop)clearTimeout(stop);for(const controller of pending)controller.abort();for(const client of clients.values())client.dispose();clients.clear();listeners.clear();},
  };
  const resources=createBotResources({environmentId,request,files:resourceFiles});
  workspace.resources=resources;workspace.resourceTransfers=resources;
  const uploads=createMobileUploads({files,request,getClient:workspace.getClient,load:()=>read<MobileUpload[]>('uploads')??[],save:jobs=>write('uploads',jobs),publish:uploads=>publish({uploads})});
  workspace.attachmentsAvailable=uploads.available;workspace.pickAttachments=uploads.pick;workspace.retryUpload=uploads.retry;workspace.cancelUpload=uploads.cancel;
  return workspace;
}
