import { Loader } from 'lucide-react';
import type { ConversationStatus } from '@shared/protocol';

export function ConversationStatusIcon({ status, unreadAt }: { status?: ConversationStatus | null; unreadAt?: number | null }) {
  // ZCode 分组会话行：状态在标题右侧，未读优先；空闲不占位。
  const indicator = unreadAt ? 'unread' : status;
  if (!indicator) return null;
  const label = indicator === 'unread' ? '未读' : '运行中';
  return <span className="conversation-status" data-status={indicator} role="img" aria-label={label} title={label}>
    {indicator === 'unread' ? <span className="conversation-unread-dot" aria-hidden="true" /> : (
      <span className="conversation-status-spinner" aria-hidden="true"><Loader /></span>
    )}
  </span>;
}
