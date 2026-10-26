/** Shared SDK owns synchronization, recovery and operation state; IPC is the host port. */
import {useMemo} from 'react';
import {createConversation, type ConversationClientState, type ConversationClient} from '@hemi/conversation-flow/core';
import {useConversation} from '@hemi/conversation-flow/react';
import type {FlowCommandResult, FlowSnapshotView, HemiVoiceBridge} from '@shared/protocol';
import {useConversationBridge, useConversationEnvironmentId} from './conversation-bridge';
import {conversationOperationStorage} from './conversation-operation-storage';

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
  const client = useMemo(() => createConversation({
    scope: {environmentId, conversationId: conversationId ?? 'new'},
    storage: {operations: conversationOperationStorage},
    transport: {
      prepareCommand,
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
  }), [bridge, environmentId, conversationId, prepareCommand]);
  const state = useConversation(client, {enabled: Boolean(conversationId)});
  return {...state, snapshot: conversationId ? state.snapshot : null, sendCommand: client.sendCommand};
}
