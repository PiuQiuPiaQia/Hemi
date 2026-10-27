import {type ReactNode} from 'react';
import {Plus} from 'lucide-react';
import {IconButton} from '@hemi/ui';
import {ConversationComposer} from '@hemi/conversation-flow/composer';

export function Composer({busy, offline, blocked, stopBlocked, readOnly = false, text, onText, onSend, onStop, onAdd, hasAttachments = false, addBlocked = false, focusToken, children, toolbar, controls}: {
  hasAttachments?: boolean; addBlocked?: boolean;
  readOnly?: boolean;
  busy: boolean; offline: boolean; blocked: boolean; stopBlocked: boolean; text: string; focusToken?: number; children?: ReactNode; toolbar?: ReactNode; controls?: ReactNode;
  onText(text: string): void; onSend(): void; onStop(): void; onAdd(): void;
}) {
  return <ConversationComposer layout="touch" readOnly={readOnly} busy={busy} offline={offline} stopBlocked={stopBlocked} value={text} onChange={onText} onSend={onSend} onStopTurn={onStop} sendBlocked={blocked} hasAttachments={hasAttachments} focusToken={focusToken} toolbar={<><IconButton label="添加内容" disabled={addBlocked} onClick={onAdd}><Plus size={20}/></IconButton>{toolbar}</>} trailing={controls}>{children}</ConversationComposer>;
}
