import {useConversationBridge} from './conversation-bridge';
/** 060：一份只读快照，一套版本追平协议；导航只换订阅。 */
import { useCallback, useEffect, useState } from 'react';
import type { FlowCommandResult, FlowSnapshotView } from '@shared/protocol';
import { createFlowReplica } from './flow-replica';

export type ConversationFlowState = {
  snapshot: FlowSnapshotView | null;
  sendCommand: (command: Record<string, unknown>) => Promise<FlowCommandResult>;
};

export function useConversationFlow(conversationId: string | null): ConversationFlowState {
  const bridge = useConversationBridge();
  const [snapshot, setSnapshot] = useState<FlowSnapshotView | null>(null);
  useEffect(() => {
    setSnapshot(null);
    if (!conversationId) return;
    const replica = createFlowReplica({
      fetchSnapshot: () => bridge.flowGetSnapshot(conversationId), publish: setSnapshot,
    });
    const unsubscribe = bridge.onFlowChanged(({ conversationId: source, change }) => {
      if (source === conversationId) replica.receive(change);
    });
    void replica.refresh();
    return () => { replica.dispose(); unsubscribe(); };
  }, [conversationId]);
  const sendCommand = useCallback((command: Record<string, unknown>) => conversationId
    ? bridge.flowCommand(conversationId, command)
    : Promise.resolve({ ok: false, code: 'invalid', message: '无会话' } as FlowCommandResult), [conversationId]);
  return { snapshot: snapshot?.conversationId === conversationId ? snapshot : null, sendCommand };
}
