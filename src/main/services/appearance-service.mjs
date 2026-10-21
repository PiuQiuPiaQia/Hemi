import {randomUUID} from 'node:crypto';
import {DEFAULT_APPEARANCE,validAppearanceRequest} from '../../shared/appearance/schema.mjs';

export function createAppearanceService({store,onCommit=()=>{},log={warn(){}}}){
  const sessionId=randomUUID();let current={sessionId,revision:0,preference:{...DEFAULT_APPEARANCE},resolvedMode:'light',recovery:null};
  let initialization,queue=Promise.resolve();const requests=new Map();
  const snapshot=()=>structuredClone(current);
  const initialize=()=>initialization??=(async()=>{const loaded=await store.load();current={...current,...loaded};return snapshot();})();
  const result=(ok,requestId,extra={})=>({ok,requestId,...extra,snapshot:snapshot()});
  function set(request,scope='main'){
    if(!validAppearanceRequest(request))return Promise.resolve(result(false,typeof request?.requestId==='string'?request.requestId.slice(0,128):'',{code:'INVALID_INPUT'}));
    const key=`${scope}:${request.requestId}`,signature=`${request.skinId}:${request.mode}`,existing=requests.get(key);
    if(existing)return existing.signature===signature?existing.promise:Promise.resolve(result(false,request.requestId,{code:'REQUEST_CONFLICT'}));
    const promise=queue.then(async()=>{
      await initialize();
      if(!current.recovery&&current.preference.skinId===request.skinId)return result(true,request.requestId,{changed:false});
      const preference={schemaVersion:1,skinId:request.skinId,mode:request.mode};
      try{await store.save(preference,current.recovery);}catch(error){log.warn(`外观保存失败：${error.code==='BACKUP_FAILED'?'BACKUP_FAILED':'SAVE_FAILED'}`);return result(false,request.requestId,{code:error.code==='BACKUP_FAILED'?'BACKUP_FAILED':'SAVE_FAILED'});}
      current={...current,preference,recovery:null,revision:current.revision+1};
      try{onCommit(snapshot());}catch{log.warn('外观已提交，部分窗口通知失败');}
      return result(true,request.requestId,{changed:true});
    });
    const entry={signature,promise,done:false};requests.set(key,entry);queue=promise.then(()=>{},()=>{});
    void promise.finally(()=>{entry.done=true;for(const [id,item]of requests){if(requests.size<=256)break;if(item.done)requests.delete(id);}}).catch(()=>{});
    return promise;
  }
  return {initialize,getSnapshot:snapshot,set};
}
