/** Bounded, expiring in-memory resources. Completed data only; no raw bytes in localStorage. */
import {IDLE_PROGRESS, type ResourceProgress} from '@hemi/conversation-flow/core';
export {IDLE_PROGRESS, type ResourceProgress};
export type ResourceTransfers={subscribe(listener:()=>void):()=>void;getProgress(key:string):ResourceProgress;invalidate(key:string):void};
const aborted=()=>new DOMException('文件读取已取消','AbortError');
export function createResourceCache<T>({now=Date.now,ttlMs=10*60*1000,maxBytes=48*1024*1024,maxEntries=8,sizeOf,onEvict}:{now?:()=>number;ttlMs?:number;maxBytes?:number;maxEntries?:number;sizeOf(value:T):number;onEvict?(value:T):void}) {
  type Entry={value:T;bytes:number;expiresAt:number};
  type Job={controller:AbortController;promise:Promise<T>;users:number;last:ResourceProgress};
  const cache=new Map<string,Entry>(),jobs=new Map<string,Job>(),progress=new Map<string,ResourceProgress>(),listeners=new Set<()=>void>();
  let closed=false,active=0;
  const slots:Array<{signal:AbortSignal;grant():void;cancel():void}>=[];
  const emit=(key:string,value:ResourceProgress)=>{if(closed)return;progress.set(key,value);if(progress.size>64)for(const old of progress.keys()){if(progress.size<=64)break;if(!jobs.has(old)&&!cache.has(old))progress.delete(old);}for(const listener of listeners)listener();};
  const remove=(key:string)=>{const entry=cache.get(key);if(entry){cache.delete(key);if(!jobs.has(key))progress.delete(key);onEvict?.(entry.value);}};
  function prune(){for(const[key,entry]of cache)if(entry.expiresAt<=now())remove(key);while(cache.size>maxEntries||[...cache.values()].reduce((total,item)=>total+item.bytes,0)>maxBytes)remove(cache.keys().next().value!);}
  function slot(signal:AbortSignal):Promise<()=>void>{
    signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const waiter={signal,grant(){signal.removeEventListener('abort',waiter.cancel);active++;let released=false;resolve(()=>{if(released)return;released=true;active--;while(slots.length){const next=slots.shift()!;if(!next.signal.aborted){next.grant();break;}}});},cancel(){const index=slots.indexOf(waiter);if(index>=0)slots.splice(index,1);reject(aborted());}};
      if(active<2)waiter.grant();else{slots.push(waiter);signal.addEventListener('abort',waiter.cancel,{once:true});}
    });
  }
  function wait(job:Job,signal:AbortSignal):Promise<T>{
    job.users++;
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(callback:()=>void)=>{if(done)return;done=true;signal.removeEventListener('abort',cancel);job.controller.signal.removeEventListener('abort',cancel);job.users--;callback();if(!job.users)job.controller.abort();};
      const cancel=()=>finish(()=>reject(aborted()));
      signal.addEventListener('abort',cancel,{once:true});
      job.controller.signal.addEventListener('abort',cancel,{once:true});
      void job.promise.then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)));
      if(signal.aborted||job.controller.signal.aborted)cancel();
    });
  }
  const timer=setInterval(()=>{const before=cache.size;prune();if(cache.size!==before)for(const listener of listeners)listener();},60000);timer.unref?.();
  return {
    reweigh(key:string){const entry=cache.get(key);if(entry){entry.bytes=sizeOf(entry.value);prune();}},
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    getProgress:(key:string)=>progress.get(key)??IDLE_PROGRESS,
    report:emit,
    getCached(key:string):T|undefined {prune();return cache.get(key)?.value;},
    async get(key:string,signal:AbortSignal,load:(signal:AbortSignal,report:(value:ResourceProgress)=>void)=>Promise<T>):Promise<T>{
      signal.throwIfAborted();if(closed)throw aborted();prune();
      const cached=cache.get(key);
      if(cached){cache.delete(key);cache.set(key,cached);emit(key,{phase:'cached',received:cached.bytes,expiresAt:cached.expiresAt});return cached.value;}
      let job=jobs.get(key);
      if(job?.controller.signal.aborted){jobs.delete(key);job=undefined;}
      if(!job){
        const controller=new AbortController();const created:Job={controller,users:0,last:{phase:'queued',received:0},promise:Promise.resolve(undefined as T)};job=created;jobs.set(key,created);
        created.promise=(async()=>{
          let release:(()=>void)|undefined;
          try{
            release=await slot(controller.signal);controller.signal.throwIfAborted();
            const value=await load(controller.signal,value=>{if(!controller.signal.aborted&&jobs.get(key)===created){created.last=value;emit(key,value);}});controller.signal.throwIfAborted();
            if(closed||jobs.get(key)!==created)throw aborted();
            const expiresAt=now()+ttlMs,bytes=sizeOf(value);cache.set(key,{value,bytes,expiresAt});prune();emit(key,{phase:'ready',received:created.last.total??created.last.received,total:created.last.total,expiresAt});return value;
          }catch(error){if(!controller.signal.aborted&&jobs.get(key)===created)emit(key,{...created.last,phase:'failed'});throw error;}
          finally{release?.();if(jobs.get(key)===created)jobs.delete(key);}
        })();emit(key,created.last);
      }
      return wait(job,signal);
    },
    invalidate(key:string){remove(key);jobs.get(key)?.controller.abort();jobs.delete(key);emit(key,IDLE_PROGRESS);},
    clear(){for(const job of jobs.values())job.controller.abort();jobs.clear();for(const key of cache.keys())remove(key);progress.clear();for(const listener of listeners)listener();},
    dispose(){clearInterval(timer);this.clear();closed=true;listeners.clear();},
  };
}
