/** Shared SDK owns synchronization, recovery and operation state; IPC is the host port. */
import {useMemo} from 'react';
import {createConversation} from '@hemi/conversation-flow/core';
import {useConversation} from '@hemi/conversation-flow/react';
import type {FlowCommandResult, FlowSnapshotView} from '@shared/protocol';

export type ConversationFlowState = {
  snapshot: FlowSnapshotView | null;
  sendCommand(command: Record<string, unknown>): Promise<FlowCommandResult>;
};
export function useConversationFlow(conversationId: string | null): ConversationFlowState {
  const client = useMemo(() => createConversation({
    scope: {environmentId: 'desktop-local', conversationId: conversationId ?? 'new'},
    transport: {
      fetchSnapshot: () => conversationId ? window.hemiVoice.flowGetSnapshot(conversationId) : Promise.resolve(null),
      subscribe: (_scope, receive) => conversationId ? window.hemiVoice.onFlowChanged(({conversationId: source, change}) => {
        if (source === conversationId) receive(change);
      }) : () => {},
      command: ({command}) => conversationId ? window.hemiVoice.flowCommand(conversationId, command)
        : Promise.resolve({ok: false, code: 'invalid', message: '无会话'}),
    },
  }), [conversationId]);
  const state = useConversation(client, {enabled: Boolean(conversationId)});
  return {snapshot: conversationId ? state.snapshot : null, sendCommand: client.sendCommand};
}
