import { X } from 'lucide-react';
import type { MessageAttachmentView } from '@/shared/types';
import { AttachmentFileIcon, attachmentTypeLabel } from './attachment-file-icon';

/** The same attachment thumbnail card is used before and after sending. */
export function AttachmentCard({ attachment, sent = false, onOpen, onRemove }: {
  attachment: MessageAttachmentView;
  sent?: boolean;
  onOpen?: () => void;
  onRemove?: () => void;
}) {
  const image = attachment.kind === 'image';
  const thumb = image && attachment.status !== 'failed' ? attachment.thumbnailUrl : null;
  return <div
    className={`h24-attach-card h-attachment-card${image ? ' h24-attach-card-image' : ''}`}
    data-kind={attachment.kind}
    data-state={sent ? 'sent' : 'draft'}
  >
    <button
      type="button"
      className={`h24-attach-open${sent ? ' h24-msg-attachment' : ''}`}
      title={attachment.message || attachment.originPath || attachment.name}
      aria-label={`预览${image ? '图片' : '文件'}附件 ${attachment.name}`}
      onClick={onOpen}
    >
      {thumb ? <img className="h24-attach-thumb" src={thumb} alt={attachment.name} draggable={false} />
        : image ? <AttachmentFileIcon name={attachment.name} kind="image" />
          : <>
            <span className="h-attachment-icon-box"><AttachmentFileIcon name={attachment.name} /></span>
            <span className="h-attachment-info">
              <span className="h24-attach-name">{attachment.name}</span>
              {attachment.status !== 'ready'
                ? <small className="h24-attach-status" role="status">{attachment.message || '原文件不可用'}</small>
                : <small className="h24-attach-meta">{attachmentTypeLabel(attachment.name)}</small>}
            </span>
          </>}
    </button>
    {onRemove ? <button type="button" className="h24-attach-remove" aria-label={`移除附件 ${attachment.name}`} title="移除附件" onClick={onRemove}>
      <X className="size-3" aria-hidden="true" />
    </button> : null}
  </div>;
}
