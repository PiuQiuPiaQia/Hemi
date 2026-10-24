import {useMemo} from 'react';
import {ConversationComposer, type ConversationComposerProps} from '@hemi/conversation-flow/composer';
import {useConversationBridge, useConversationEnvironment} from './lib/conversation-bridge';
export function TextComposer(props: Omit<ConversationComposerProps, 'adapter' | 'layout'>) {
  const bridge = useConversationBridge(), environment = useConversationEnvironment();
  const adapter = useMemo(() => ({
    listSlashCandidates: bridge?.listSlashCandidates ? (id: string) => bridge.listSlashCandidates!(id) : undefined,
    listReferences: bridge?.listReferences ? (id: string, query: string, workspaceId?: string) => bridge.listReferences(id, query, workspaceId) : undefined,
    pathForFile: bridge?.pathForFile ? (file: File) => bridge.pathForFile!(file) : undefined,
    automaticRouting: environment !== 'bot',
    hint: environment === 'bot' ? 'Enter 发送，Shift+Enter 换行' : undefined,
  }), [bridge, environment]);
  return <ConversationComposer {...props} adapter={adapter}/>;
}
