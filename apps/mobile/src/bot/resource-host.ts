import {createResourceCache, IDLE_PROGRESS, type ResourceProgress} from './resource-cache';
import type {ConversationFlowHost,FlowResult,HostContext,ResourceRef,ResourceLease} from '@hemi/conversation-flow';
export interface MobileResourceFiles {
  begin(input:{name:string;size:number;sha256:string}):Promise<{id:string}>;
  append(input:{id:string;offset:number;base64:string}):Promise<void>;
  finish(id:string):Promise<void>;
  present(id:string,action:'open'|'save'|'share'):Promise<{presented:boolean}>;
  remove(id:string):Promise<void>;
}
type Request=<T>(method:string,params:Record<string,unknown>,signal?:AbortSignal)=>Promise<T>;
type Target={kind:'deliverable'|'attachment'|'link';artifactId?:string;attachmentId?:string;path?:string;conversationId?:string;environmentId?:string};
export type MobileResourceTransfers={subscribe(listener:()=>void):()=>void;getProgress(scope:HostContext['scope'],ref:ResourceRef|null):ResourceProgress;invalidate(scope:HostContext['scope'],ref:ResourceRef):void};
type Stat={ok:true;name:string;size:number;sha256:string;version:string;mimeType:string;chunkSize:number};
const failure=(error:unknown):FlowResult<never>=>({ok:false,error:{code:(error as Error)?.name==='AbortError'?'cancelled':(error as {code?:string})?.code==='missing'?'not-found':(error as {code?:string})?.code==='permission'?'denied':(error as {code?:string})?.code==='unsupported'?'unsupported':(error as {code?:string})?.code==='conflict'?'conflict':'failed',message:error instanceof Error?error.message:'文件操作失败，请重试'}});
const unsupported=(message:string)=>failure(Object.assign(new Error(message),{code:'unsupported'}));

export function createBotResources({environmentId,request,files,now}:{environmentId:string;request:Request;files?:MobileResourceFiles;now?:()=>number}):NonNullable<ConversationFlowHost['resources']>&MobileResourceTransfers&{dispose():void;clear():void} {
  function target(ref:ResourceRef,context:HostContext):Target {
    context.signal.throwIfAborted();
    if(context.scope.environmentId!==environmentId)throw new Error('Bot 身份不匹配');
    let value:Target;
    if(ref.id.startsWith('deliverable:'))value={kind:'deliverable',artifactId:ref.id.slice(12)};
    else if(ref.id.startsWith('attachment:'))value={kind:'attachment',attachmentId:ref.id.slice(11)};
    else value=JSON.parse(ref.id) as Target;
    if(!['deliverable','attachment','link'].includes(value.kind)||typeof(value.kind==='attachment'?value.attachmentId:value.artifactId)!=='string'||value.conversationId&&value.conversationId!==context.scope.conversationId||value.environmentId&&value.environmentId!==environmentId)throw new Error('文件不属于当前对话');
    return value;
  }
  const params=(value:Target,context:HostContext)=>({id:context.scope.conversationId,kind:value.kind,artifactId:value.artifactId,attachmentId:value.attachmentId});
  async function stat(value:Target,context:HostContext) {
    const info=await request<Stat>('resource.stat',params(value,context),context.signal);
    if(info.ok!==true||!Number.isSafeInteger(info.size)||info.size<0||info.size>20*1024*1024||!/^[a-f0-9]{64}$/.test(info.sha256)||typeof info.name!=='string'||!info.version||!Number.isInteger(info.chunkSize)||info.chunkSize<1)throw new Error('Bot 文件元数据无效');
    return info;
  }
  async function chunks(value:Target,info:Stat,context:HostContext,consume:(base64:string,offset:number)=>Promise<void>,report:(value:ResourceProgress)=>void) {
    report({phase:'downloading',received:0,total:info.size});
    for(let offset=0;offset<info.size;){
      context.signal.throwIfAborted();const length=Math.min(1024*1024,info.chunkSize,info.size-offset);
      const chunk=await request<{ok:boolean;base64:string;size:number;offset:number;version:string}>('resource.chunk',{...params(value,context),version:info.version,offset,length},context.signal);
      if(chunk.ok!==true||chunk.offset!==offset||chunk.size!==length||chunk.version!==info.version||typeof chunk.base64!=='string'||atob(chunk.base64).length!==length)throw new Error('文件分片不完整，请重试');
      await consume(chunk.base64,offset);offset+=chunk.size;report({phase:'downloading',received:offset,total:info.size});
    }
    context.signal.throwIfAborted();
  }
  type Cached={info?:Stat;blob?:Blob;content?:ResourceLease['content']};
  const cache=createResourceCache<Cached>({now,sizeOf:value=>(value.blob?.size??0)+(value.content?.kind==='text'?value.content.text.length*2:value.content?.kind==='url'?value.content.url.length*2:0)});
  const key=(scope:HostContext['scope'],ref:ResourceRef)=>{const value=target(ref,{scope,signal:new AbortController().signal,requestId:''});return JSON.stringify([scope.environmentId,scope.conversationId,scope.generation,value.kind,value.artifactId??value.attachmentId,value.kind==='link'?value.path:undefined,ref.version]);};
  const get=async(ref:ResourceRef,context:HostContext)=>{
    const value=target(ref,context),identity=key(context.scope,ref);
    return cache.get(identity,context.signal,async(signal,report)=>{
      const own={...context,signal};report({phase:'checking',received:0});
      if(value.kind==='link'){
        const content=await request<{ok:boolean;text?:string;dataUrl?:string;markdown?:boolean;message?:string}>('file.read',{...params(value,own),path:value.path,textOnly:true},signal);
        if(!content.ok)throw new Error(content.message??'文件读取失败');
        if(content.dataUrl)return{content:{kind:'url',url:content.dataUrl,mimeType:'image/*'}};
        if(content.text==null)throw Object.assign(new Error(content.message??'此格式请使用系统预览'),{code:'unsupported'});
        return{content:{kind:'text',text:content.text,mimeType:content.markdown?'text/markdown':'text/plain'}};
      }
      const info=await stat(value,own),parts:Uint8Array<ArrayBuffer>[]=[];
      await chunks(value,info,own,async base64=>{parts.push(Uint8Array.from(atob(base64),c=>c.charCodeAt(0)));},report);
      report({phase:'verifying',received:info.size,total:info.size});
      const blob=new Blob(parts,{type:info.mimeType}),hash=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
      if(Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')!==info.sha256)throw new Error('文件校验失败，请重试');
      return{info,blob};
    });
  };
  return {
    subscribe:cache.subscribe,
    getProgress(scope,ref){try{return ref?cache.getProgress(key(scope,ref)):IDLE_PROGRESS;}catch{return IDLE_PROGRESS;}},
    invalidate(scope,ref){try{cache.invalidate(key(scope,ref));}catch{/* The read boundary reports an invalid reference as a file error. */}},
    clear(){cache.clear();},dispose(){cache.dispose();},
    async resolve({href},context) {
      try {
        context.signal.throwIfAborted();if(context.scope.environmentId!==environmentId)throw new Error('Bot 身份不匹配');
        const value=await request<{ok:boolean;artifactId:string;path:string}>('file.resolve',{id:context.scope.conversationId,path:href},context.signal);
        context.signal.throwIfAborted();if(!value.ok||!value.artifactId||!value.path)throw new Error('文件解析失败');
        return{ok:true,value:{id:JSON.stringify({kind:value.artifactId.startsWith('link-')?'link':'deliverable',artifactId:value.artifactId,path:value.path,conversationId:context.scope.conversationId,environmentId}),version:'0'}};
      }catch(error){return failure(error);}
    },
    async read({ref,purpose},context) {
      try {
        const value=target(ref,context),entry=await get(ref,context),info=entry.info;
        let content=entry.content,release=()=>{};
        if(entry.blob&&info?.mimeType.startsWith('image/')){
          context.signal.throwIfAborted();const url=URL.createObjectURL(entry.blob);content={kind:'url',url,mimeType:info.mimeType};release=()=>URL.revokeObjectURL(url);
        }else if(purpose==='thumbnail')return unsupported('此文件没有图片缩略图');
        else if(!content&&entry.blob&&info){
          if(/\.(txt|md|markdown|mdx|json|csv|tsv|xml|html?|css|[cm]?jsx?|tsx?|py|sh|ya?ml|toml|ini|log|sql)$/i.test(info.name))content={kind:'text',text:await entry.blob.text(),mimeType:/\.(md|markdown)$/i.test(info.name)?'text/markdown':'text/plain'};
          else if(/\.(pdf|docx|xlsx|pptx)$/i.test(info.name)){
            const parsed=await request<{ok:boolean;kind:string;text?:string;message?:string}>(value.kind==='attachment'?'attachment.read':'file.read',{...params(value,context),textOnly:true},context.signal);
            if(parsed.ok&&parsed.text!=null)content={kind:'text',text:parsed.text,mimeType:'text/plain'};
          }
          if(content?.kind==='text'&&/\.(pdf|docx|xlsx|pptx)$/i.test(info.name)&&content.text.length*2<=4*1024*1024){entry.content=content;cache.reweigh(key(context.scope,ref));}
        }
        context.signal.throwIfAborted();
        if(!content)return unsupported('此文件暂不支持在线预览，可以使用系统预览、保存或分享');
        return{ok:true,value:{ref,metadata:{name:info?.name,size:info?.size},content,release}};
      }catch(error){return failure(error);}
    },
    async listActions({ref},context) {
      try{const value=target(ref,context);return{ok:true,value:files&&value.kind!=='link'?[{id:'open',kind:'open-with',label:'系统预览'},{id:'save',kind:'save',label:'保存到文件'},{id:'share',kind:'share',label:'分享'}]:[]};}catch(error){return failure(error);}
    },
    async perform({ref,actionId},context) {
      let localId:string|undefined,identity:string|undefined;
      try{
        if(!files||!['open','save','share'].includes(actionId))return unsupported('当前环境不支持此文件操作');
        const value=target(ref,context);if(value.kind==='link')return unsupported('此文件仅支持预览');
        identity=key(context.scope,ref);
        const entry=await get(ref,context),info=entry.info;
        if(!info||!entry.blob)return unsupported('此文件仅支持预览');
        cache.report(key(context.scope,ref),{...cache.getProgress(key(context.scope,ref)),phase:'preparing',received:info.size,total:info.size});
        localId=(await files.begin({name:info.name,size:info.size,sha256:info.sha256})).id;
        for(let offset=0;offset<info.size;offset+=256*1024){
          context.signal.throwIfAborted();const bytes=new Uint8Array(await entry.blob.slice(offset,offset+256*1024).arrayBuffer());
          let binary='';for(let index=0;index<bytes.length;index+=8192)binary+=String.fromCharCode(...bytes.subarray(index,index+8192));
          await files.append({id:localId,offset,base64:btoa(binary)});
        }
        await files.finish(localId);context.signal.throwIfAborted();
        const result=await files.present(localId,actionId as 'open'|'save'|'share');
        if(!result.presented)throw new Error('未能打开系统文件面板');
        // Acknowledges presentation. The system owns save/share completion and cancellation.
        return{ok:true,value:undefined};
      }catch(error){return failure(error);}finally{if(localId)await files?.remove(localId).catch(()=>{});const state=identity?cache.getProgress(identity):undefined;if(identity&&state?.phase==='preparing')cache.report(identity,{...state,phase:cache.getCached(identity)?'cached':'idle'});}
    },
  };
}
