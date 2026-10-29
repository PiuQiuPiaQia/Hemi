import {projectFlowWindow, type ConversationSnapshotStorage, type FlowSnapshotView} from '@hemi/conversation-flow/core';

/** Optional history checkpoints are asynchronous; legacy copies are removed only after a durable transaction. */
export function createMobileSnapshotStorage(prefix: string, legacy: Storage): ConversationSnapshotStorage & {remove(id: string): Promise<void>;ready():Promise<void>} {
  let database: Promise<IDBDatabase> | undefined;
  function open() {
    return database ??= new Promise<IDBDatabase>((resolve,reject)=>{
      if(typeof indexedDB==='undefined'){reject(new Error('异步聊天缓存不可用'));return;}
      const request=indexedDB.open('hemi-mobile-flow-cache',1);
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('snapshots'))request.result.createObjectStore('snapshots');};
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
  }
  const key=(id:string)=>prefix+id+':snapshot';
  async function transact<T>(mode:IDBTransactionMode,action:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T> {
    const db=await open();
    return new Promise<T>((resolve,reject)=>{
      const transaction=db.transaction('snapshots',mode),request=action(transaction.objectStore('snapshots'));
      let value:T;request.onsuccess=()=>{value=request.result;};
      transaction.oncomplete=()=>resolve(value);transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);
    });
  }
  async function migrateLegacy() {
    const keys=Array.from({length:legacy.length},(_,index)=>legacy.key(index)).filter((name):name is string=>Boolean(name?.startsWith('hemi-mobile:bot:')&&name.endsWith(':snapshot')));
    for(const name of keys) {
      const raw=legacy.getItem(name);if(!raw)continue;
      let value:FlowSnapshotView;try{value=JSON.parse(raw);if(value.schemaVersion!==1||!Array.isArray(value.timeline)||!value.conversationId)continue;}catch{continue;}
      const db=await open();
      await new Promise<void>((resolve,reject)=>{
        const tx=db.transaction('snapshots','readwrite'),store=tx.objectStore('snapshots'),read=store.get(name);
        // A newer checkpoint can win before migration. Never replace it with the old copy.
        read.onsuccess=()=>{if(!read.result)store.put(projectFlowWindow(value),name);};
        tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      });
      if(legacy.getItem(name)===raw)legacy.removeItem(name);
    }
  }
  // All Bots share WebView storage quota. Migrate only reconstructible history keys;
  // drafts, unknown/waiting operations and pairing identity are never removed.
  const migration=migrateLegacy().catch(()=>{});
  return {
    ready:()=>migration,
    async load(scope) {
      await migration;
      try {const value=await transact('readonly',store=>store.get(key(scope.conversationId)));if(value)return value as FlowSnapshotView;}
      catch { /* Preserve legacy offline history when asynchronous storage is unavailable. */ }
      const value=legacy.getItem(key(scope.conversationId));return value?JSON.parse(value):null;
    },
    async save(scope,value){await migration;await transact('readwrite',store=>store.put(value,key(scope.conversationId)));legacy.removeItem(key(scope.conversationId));},
    async remove(id){await migration;await transact('readwrite',store=>store.delete(key(id))).catch(()=>{});legacy.removeItem(key(id));},
  };
}
