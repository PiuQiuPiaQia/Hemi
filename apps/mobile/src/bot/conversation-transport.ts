import type {ConversationTransport, FlowCommandResult, FlowSnapshotView} from '@hemi/conversation-flow/core';

/** Authenticated RPC injected by the host; this module does not choose the connection or open a server. */
export interface BotRpc {
  request<T>(method: string, params: Record<string, unknown>, context: {signal: AbortSignal}): Promise<T>;
}

/** Only a definitive response from the Bot may reject an operation. A lost connection stays unknown. */
export class BotCommandRejected extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function createBotConversationTransport(rpc: BotRpc, instanceId: string, conversationId: string): ConversationTransport {
  const environmentId = `bot:${instanceId}`;
  function guard(scope: {environmentId: string; conversationId: string}, signal: AbortSignal) {
    signal.throwIfAborted();
    if (scope.environmentId !== environmentId || scope.conversationId !== conversationId) throw new Error('Bot 或会话身份不匹配');
  }
  return {
    async fetchSnapshot(scope, context) {
      guard(scope, context.signal);
      const snapshot = await rpc.request<FlowSnapshotView>('flow.snapshot', {instanceId, id: conversationId}, context);
      if (snapshot?.schemaVersion !== 1 || snapshot.conversationId !== conversationId || !Array.isArray(snapshot.timeline) || !Array.isArray(snapshot.pending)) throw new Error('Bot 会话快照无效');
      return snapshot;
    },
    async command({scope, requestId, command}, context) {
      guard(scope, context.signal);
      try {
        const result = await rpc.request<FlowCommandResult>('flow.command', {instanceId, id: conversationId, requestId, command}, context);
        if (typeof result?.ok !== 'boolean') throw new Error('Bot 未返回可核对的操作回执');
        return result;
      } catch (error) {
        if (error instanceof BotCommandRejected) return {ok: false, code: error.code, message: error.message};
        throw error;
      }
    },
    async lookupOperation(scope, requestId, context) {
      guard(scope, context.signal);
      const receipt = await rpc.request<{status: string; result?: FlowCommandResult}>('operation.get', {instanceId, operationId: requestId}, context);
      return receipt.status === 'done' && typeof receipt.result?.ok === 'boolean' ? receipt.result : null;
    },
  };
}
