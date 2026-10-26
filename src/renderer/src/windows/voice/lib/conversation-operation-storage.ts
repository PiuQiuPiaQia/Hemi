import type {ConversationIdentity, ConversationOperationStorage} from '@hemi/conversation-flow/core';

const key = (scope: ConversationIdentity) => `hemi.conversation-operations.v1:${JSON.stringify(scope)}`;
/** The shared journal survives navigation/restart; only its own receipt can clear a submission. */
export const conversationOperationStorage: ConversationOperationStorage = {
  async load(scope) {const value = localStorage.getItem(key(scope)); return value ? JSON.parse(value) : [];},
  async save(scope, operations) {localStorage.setItem(key(scope), JSON.stringify(operations));},
};
export function removeConversationOperations(scope: ConversationIdentity) {
  localStorage.removeItem(key(scope));
}
