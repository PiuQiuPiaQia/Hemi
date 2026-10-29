import type {MobileResourceFiles} from './resource-host';
import type {MobileFileSource, PickedFile} from './attachment-uploads';
import type {BotEvent} from './realtime';
import {Capacitor, registerPlugin} from '@capacitor/core';
import {BotCommandRejected, type BotRpc} from './conversation-transport';

export type BotTarget = {endpoint: string; botInstanceId: string; name: string; expiresAt?: number};
export type PairResult = {status: 'preview' | 'not-received' | 'pending' | 'approved' | 'expired' | 'cancelled' | 'rejected' | 'revoked'; code?: string; expiresAt?: number; target?: BotTarget};
export interface NativeBotApi {
  openEvents?(input: {streamId:string;options:Record<string,unknown>}):Promise<void>;
  closeEvents?(input:{streamId:string}):Promise<void>;
  addListener?(event:string,receive:(value:{streamId:string;frame?:BotEvent;disconnected?:boolean})=>void):Promise<{remove():Promise<void>}>;
  beginResource(input: {name: string; size: number; sha256: string}): Promise<{id: string}>;
  appendResource(input: {id: string; offset: number; base64: string}): Promise<void>;
  finishResource(input: {id: string}): Promise<void>;
  removeResource(input: {id: string}): Promise<void>;
  presentResource(input: {id: string; action: 'open'|'save'|'share'}): Promise<{presented: boolean}>;
  pickFiles(input: {kind: 'photos'|'files'; limit: number}): Promise<{files: PickedFile[]}>;
  readPickedFile(input: {id: string; offset: number; length: number}): Promise<{base64: string; size: number}>;
  removePickedFile(input: {id: string}): Promise<void>;
  scan(): Promise<{qr: string}>;
  prepare(input: {qr: string}): Promise<BotTarget>;
  pairRequest(): Promise<PairResult>;
  pairStatus(): Promise<PairResult>;
  cancelPairing(): Promise<PairResult>;
  forgetPairing(): Promise<void>;
  restore(): Promise<{active?: BotTarget; pending?: BotTarget}>;
  request(input: {method: string; params: Record<string, unknown>; requestId?: string}): Promise<{ok: true; result: unknown}>;
  cancelRequest?(input: {requestId:string}): Promise<void>;
  forget(): Promise<void>;
}
export const NativeBot = registerPlugin<NativeBotApi>('HemiBot');
export const nativeBotAvailable = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('HemiBot');
export function createNativeBotRpc(api: Pick<NativeBotApi, 'request'|'cancelRequest'|'openEvents'|'closeEvents'|'addListener'> = NativeBot): BotRpc {
  return {
    ...(api.openEvents&&api.closeEvents&&api.addListener ? {watch(options:Record<string,unknown>,receive:(frame:BotEvent)=>void,disconnected:()=>void){
      const streamId=crypto.randomUUID();let closed=false,listener:{remove():Promise<void>}|undefined;
      void api.addListener!('botEvent',value=>{if(closed||value.streamId!==streamId)return;if(value.disconnected)disconnected();else if(value.frame)receive(value.frame);}).then(async value=>{
        listener=value;if(closed){await value.remove();return;}
        await api.openEvents!({streamId,options});if(closed)await api.closeEvents!({streamId});
      }).catch(()=>{if(!closed)disconnected();});
      return()=>{closed=true;void listener?.remove();void api.closeEvents!({streamId}).catch(()=>{});};
    }} : {}),
    async request<T>(method: string, params: Record<string, unknown>, {signal}: {signal: AbortSignal}) {
    signal.throwIfAborted();
    try {
      const requestId=crypto.randomUUID();
      let abort:(()=>void)|undefined;
      const envelope = await new Promise<{ok:true;result:unknown}>((resolve,reject)=>{
        let started=false;
        abort=()=>{
          if(started)void api.cancelRequest?.({requestId}).catch(()=>{});
          reject(new DOMException('已取消本次请求；已提交操作的结果仍需核对。','AbortError'));
        };
        signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted){abort();return;}
        started=true;void api.request({method,params,requestId}).then(resolve,reject);
      }).finally(()=>{if(abort)signal.removeEventListener('abort',abort);});
      signal.throwIfAborted();
      if (envelope.ok !== true || !Object.hasOwn(envelope, 'result')) throw new Error('Bot 未返回有效回执');
      return envelope.result as T;
    } catch (error) {
      const code = (error as {code?: string})?.code;
      if (code && ['invalid','missing','permission','conflict','unsupported','busy','failed'].includes(code)) throw new BotCommandRejected(code, error instanceof Error ? error.message : 'Bot 拒绝了操作');
      throw error;
    }
  }};
}

export function createNativeFileSource(api: Pick<NativeBotApi,'pickFiles'|'readPickedFile'|'removePickedFile'> = NativeBot): MobileFileSource {
  return {async pick(kind,limit){return (await api.pickFiles({kind,limit})).files;},read(id,offset,length){return api.readPickedFile({id,offset,length});},remove(id){return api.removePickedFile({id});}};
}

export function createNativeResourceFiles(api: Pick<NativeBotApi,'beginResource'|'appendResource'|'finishResource'|'removeResource'|'presentResource'> = NativeBot): MobileResourceFiles {
  return {begin:input=>api.beginResource(input),append:input=>api.appendResource(input),finish:id=>api.finishResource({id}),remove:id=>api.removeResource({id}),present:(id,action)=>api.presentResource({id,action})};
}
