import {type ReactNode} from 'react';
import {Plus} from 'lucide-react';
import {IconButton} from '@hemi/ui';
import {ConversationComposer} from '@hemi/conversation-flow/composer';

export function Composer({busy, offline, blocked, stopBlocked, text, onText, onSend, onStop, onAdd, hasAttachments = false, addBlocked = false, editingQueue, onCancelQueueEdit, children, toolbar, controls}: {
  hasAttachments?: boolean; addBlocked?: boolean;
  busy: boolean; offline: boolean; blocked: boolean; stopBlocked: boolean; text: string; editingQueue?: boolean; children?: ReactNode; toolbar?: ReactNode; controls?: ReactNode;
  onText(text: string): void; onSend(): void; onStop(): void; onAdd(): void; onCancelQueueEdit?(): void;
}) {
  return <ConversationComposer layout="touch" busy={busy} offline={offline} stopBlocked={stopBlocked} value={text} onChange={onText} onSend={onSend} onStopTurn={onStop} sendBlocked={blocked} hasAttachments={hasAttachments} queueEditing={editingQueue} onCancelQueueEdit={onCancelQueueEdit} toolbar={<><IconButton label="添加内容" disabled={addBlocked} onClick={onAdd}><Plus size={20}/></IconButton>{toolbar}</>} trailing={controls}>{children}</ConversationComposer>;
}
