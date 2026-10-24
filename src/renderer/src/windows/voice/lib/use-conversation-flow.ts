/** Shared SDK owns synchronization, recovery and operation state; IPC is the host port. */
import {useMemo} from 'react';
import {createConversation} from '@hemi/conversation-flow/core';
import {useConversation} from '@hemi/conversation-flow/react';
import type {FlowCommandResult, FlowSnapshotView} from '@shared/protocol';
import {useConversationBridge, useConversationEnvironmentId} from './conversation-bridge';

export type ConversationFlowState = {
  snapshot: FlowSnapshotView | null;
  sendCommand(command: Record<string, unknown>): Promise<FlowCommandResult>;
};
export function useConversationFlow(conversationId: string | null): ConversationFlowState {
  const bridge = useConversationBridge();
  const environmentId = useConversationEnvironmentId();
  const client = useMemo(() => createConversation({
    scope: {environmentId, conversationId: conversationId ?? 'new'},
    transport: {
      fetchSnapshot: () => conversationId ? bridge.flowGetSnapshot(conversationId) : Promise.resolve(null),
      subscribe: (_scope, receive, disconnected) => {
        const release=conversationId ? bridge.onFlowChanged(({conversationId: source, change}) => {if(source===conversationId)receive(change);}) : () => {};
        const offline=disconnected ? bridge.onFlowDisconnected?.(disconnected) : undefined;
        return () => {release();offline?.();};
      },
      lookupOperation: (_scope,requestId) => conversationId ? bridge.flowLookupOperation?.(conversationId,requestId) ?? Promise.resolve(null) : Promise.resolve(null),
      command: ({command,requestId,generation}) => conversationId ? bridge.flowCommand(conversationId, command, {requestId,generation})
        : Promise.resolve({ok: false, code: 'invalid', message: '无会话'}),
    },
  }), [bridge, environmentId, conversationId]);
  const state = useConversation(client, {enabled: Boolean(conversationId)});
  return {snapshot: conversationId ? state.snapshot : null, sendCommand: client.sendCommand};
}
