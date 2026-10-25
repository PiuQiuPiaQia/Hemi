import type {FlowChangeView, FlowSnapshotView} from '@hemi/conversation-flow/core';
import type {BotRpc} from './conversation-transport';

export type BotEvent = {version: number; instanceId: string; bootId: string; sequence: number; type: string; id?: string; change?: FlowChangeView; snapshot?: {detail?: {id: string; flow: FlowSnapshotView}; details?: Array<{id: string; flow: FlowSnapshotView}>}; ok?: boolean};

/** One native connection multiplexes active conversation subscriptions and workspace invalidations. */
export function createBotRealtime(rpc: BotRpc, instanceId: string, catalog: () => void, connected: () => void = () => {}) {
  const subscribers=new Map<string,Set<{receive:(change:FlowChangeView)=>void; offline:()=>void; online:()=>void}>>();
  let release:(()=>void)|undefined, timer:ReturnType<typeof setTimeout>|undefined, cursor:Record<string,unknown>|undefined;
  let closed=false, suspended=false, retains=0, failures=0, epoch=0, scope='';
  const stop=()=>{epoch++;release?.();release=undefined;if(timer)clearTimeout(timer);timer=undefined;};
  function connect() {
    stop();if(closed||suspended||!rpc.watch||(!retains&&!subscribers.size))return;
    const ids=[...subscribers.keys()].sort(), nextScope=ids.join(',');
    if(nextScope!==scope){cursor=undefined;scope=nextScope;failures=0;}
    const own=epoch;
    const disconnected=()=>{
      if(own!==epoch||closed||suspended)return;
      stop();for(const group of subscribers.values())for(const sub of group)sub.offline();
      timer=setTimeout(connect,Math.min(30000,500*2**Math.min(failures++,6)));
    };
    release=rpc.watch({instanceId,ids,cursor},frame=>{
      if(own!==epoch||closed||suspended)return;
      if(frame.ok===false){disconnected();return;}
      if(frame.version!==1||frame.instanceId!==instanceId||!Number.isSafeInteger(frame.sequence)||frame.sequence<0){disconnected();return;}
      if(cursor?.bootId===frame.bootId && frame.sequence<(cursor.sequence as number))return;
      connected();
      if(frame.type==='reset'){
        const details=frame.snapshot?.details ?? (frame.snapshot?.detail?[frame.snapshot.detail]:[]);
        for(const detail of details)for(const sub of subscribers.get(detail.id)??[])sub.receive({kind:'snapshot',snapshot:detail.flow});
        catalog();
      } else if(frame.type==='flow'&&frame.id&&frame.change){for(const sub of subscribers.get(frame.id)??[])sub.receive(frame.change);}
      else if(frame.type==='catalog'||frame.type==='ready')catalog();
      if(frame.type==='ready')for(const group of subscribers.values())for(const sub of group)sub.online();
      cursor={bootId:frame.bootId,sequence:frame.sequence,scope};failures=0;
    },disconnected);
  }
  return {
    available:!!rpc.watch,
    retain(){retains++;connect();let done=false;return()=>{if(done)return;done=true;retains--;if(!retains&&!subscribers.size)stop();};},
    subscribe(id:string,receive:(change:FlowChangeView)=>void,offline:()=>void,online:()=>void=()=>{}){
      const sub={receive,offline,online}, group=subscribers.get(id)??new Set();group.add(sub);subscribers.set(id,group);connect();
      return()=>{group.delete(sub);if(!group.size)subscribers.delete(id);connect();};
    },
    suspend(){suspended=true;stop();},resume(){suspended=false;connect();},
    close(){closed=true;stop();subscribers.clear();},
  };
}
