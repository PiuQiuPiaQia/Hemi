/** Shared SDK owns synchronization, recovery and operation state; IPC is the host port. */
import {useMemo} from 'react';
import {createConversation, createBridgeConversationTransport, type ConversationClientState, type ConversationClient} from '@hemi/conversation-flow/core';
import {useConversation} from '@hemi/conversation-flow/react';
import type {FlowCommandResult, FlowSnapshotView, HemiVoiceBridge} from '@shared/protocol';
import {useConversationBridge, useConversationEnvironmentId} from './conversation-bridge';
import {conversationOperationStorage} from './conversation-operation-storage';

const localClients=new Map<string,ConversationClient>();
export function getLocalConversationClient(conversationId:string) {
  const previous=localClients.get(conversationId);
  if(previous&&!previous.isDisposed())return previous;
  const client=createConversation({scope:{environmentId:'desktop-local',conversationId},storage:{operations:conversationOperationStorage},
    transport:createBridgeConversationTransport(window.hemiVoice,conversationId)});
  localClients.set(conversationId,client);return client;
}
export async function sendLocalConversationCommand(conversationId:string,command:Record<string,unknown>,submissionToken?:string) {
  const client=getLocalConversationClient(conversationId),release=client.retain();
  try{await client.ready();return await client.sendCommand(command,submissionToken);}finally{release();}
}

/**
 * 回卷后等本地副本追平宿主 generation 再提交：副本落后时 SDK 会按旧 generation
 * 冻结 send，宿主判冲突（2026-10-29 真机：编辑重发报「会话已回卷」/「没有受理」）。
 */
export async function waitLocalGeneration(conversationId:string,generation:number,timeoutMs=3000) {
  const client=getLocalConversationClient(conversationId),release=client.retain();
  const caughtUp=()=>(client.getSnapshot().snapshot?.generation??0)>=generation;
  try{
    await client.ready();
    if(caughtUp())return true;
    let unsubscribe=()=>{};let timer:ReturnType<typeof setTimeout>|undefined;
    const done=new Promise<boolean>(resolve=>{
      unsubscribe=client.subscribe(()=>{if(caughtUp())resolve(true);});
      timer=setTimeout(()=>resolve(caughtUp()),timeoutMs);
    });
    void Promise.resolve(client.refresh()).catch(()=>{});
    try{return await done;}finally{unsubscribe();clearTimeout(timer);}
  }finally{release();}
}

export type ConversationFlowState = ConversationClientState & {
  snapshot: FlowSnapshotView | null;
  client: ConversationClient;
  sendCommand(command: Record<string, unknown>): Promise<FlowCommandResult>;
};
export function useConversationFlow(conversationId: string | null, port?: {
  bridge: HemiVoiceBridge;
  environmentId: string;
  prepareCommand?: (command: Record<string, unknown>) => Record<string, unknown>;
}): ConversationFlowState {
  const defaultBridge = useConversationBridge();
  const defaultEnvironmentId = useConversationEnvironmentId();
  const bridge = port?.bridge ?? defaultBridge;
  const environmentId = port?.environmentId ?? defaultEnvironmentId;
  const prepareCommand = port?.prepareCommand;
  const client = useMemo(() => !port&&bridge===window.hemiVoice?getLocalConversationClient(conversationId??'new'):createConversation({
    scope: {environmentId, conversationId: conversationId ?? 'new'},
    storage: {operations: conversationOperationStorage},
    transport: createBridgeConversationTransport(bridge,conversationId??'new',prepareCommand),
  }), [bridge, environmentId, conversationId, prepareCommand]);
  const state = useConversation(client, {enabled: Boolean(conversationId)});
  return {...state, snapshot: conversationId ? state.snapshot : null, sendCommand: client.sendCommand};
}
