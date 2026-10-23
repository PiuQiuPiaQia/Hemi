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
      subscribe: (_scope, receive) => conversationId ? bridge.onFlowChanged(({conversationId: source, change}) => {
        if (source === conversationId) receive(change);
      }) : () => {},
      command: ({command}) => conversationId ? bridge.flowCommand(conversationId, command)
        : Promise.resolve({ok: false, code: 'invalid', message: '无会话'}),
    },
  }), [bridge, environmentId, conversationId]);
  const state = useConversation(client, {enabled: Boolean(conversationId)});
  return {snapshot: conversationId ? state.snapshot : null, sendCommand: client.sendCommand};
}
