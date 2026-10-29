import type {ConversationTransport} from './conversation.js';
import type {FlowChangeView,FlowCommandResult,FlowSnapshotView,FlowHistoryPage} from './protocol.js';

/** IPC is a port: both local PC and PC Bot use this same baseline/receipt contract. */
export interface ConversationBridgePort {
  flowGetSnapshot(id:string):Promise<FlowSnapshotView|null>;
  flowGetHistory?(id:string,cursor:{before:number;generation:number}):Promise<FlowHistoryPage>;
  flowCommand(id:string,command:Record<string,unknown>,operation?:{requestId:string;generation:number|null}):Promise<FlowCommandResult>;
  flowLookupOperation?(id:string,requestId:string):Promise<FlowCommandResult|null>;
  onFlowChanged(receive:(event:{conversationId:string;change:FlowChangeView})=>void):()=>void;
  onFlowDisconnected?(receive:()=>void):()=>void;
}
export function createBridgeConversationTransport(bridge:ConversationBridgePort,id:string,prepareCommand?:ConversationTransport['prepareCommand']):ConversationTransport {
  return {
    prepareCommand,
    ...(bridge.flowGetHistory?{fetchHistory:(_scope,cursor)=>bridge.flowGetHistory!(id,cursor)}:{}),
    fetchSnapshot:()=>bridge.flowGetSnapshot(id),
    subscribe:(_scope,receive,offline,online)=>{
      let closed=false,baseline=false;
      const release=bridge.onFlowChanged(event=>{
        if(closed||event.conversationId!==id)return;
        if(event.change.kind==='snapshot')baseline=true;
        receive(event.change);
      });
      const disconnect=offline?bridge.onFlowDisconnected?.(offline):undefined;
      void bridge.flowGetSnapshot(id).then(snapshot=>{
        if(closed)return;
        if(!baseline&&snapshot)receive({kind:'snapshot',snapshot});
        online?.();
      }).catch(()=>{if(!closed)offline?.();});
      return()=>{closed=true;release();disconnect?.();};
    },
    lookupOperation:(_scope,requestId)=>bridge.flowLookupOperation?.(id,requestId)??Promise.resolve(null),
    command:({command,requestId,generation})=>bridge.flowCommand(id,command,{requestId,generation}),
  };
}
