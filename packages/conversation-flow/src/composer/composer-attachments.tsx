import { FileText, Image, RotateCw, X } from 'lucide-react';
import type { MessageAttachmentView } from '../types/presentation.js';
export type AttachmentUploadView = {
    id: string;
    file: {
        name: string;
        kind: string;
        size: number;
    };
    status: 'queued' | 'uploading' | 'failed';
    received: number;
    error: string;
};
import { IconButton } from '@hemi/ui';
const sizeLabel = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(size / 1024))} KB`;
export function ComposerAttachments({ attachments, uploads, disabled, onRemove, onCancel, onRetry }: {
    attachments: MessageAttachmentView[];
    uploads: AttachmentUploadView[];
    disabled: boolean;
    onRemove(id: string): void;
    onCancel(id: string): void;
    onRetry(id: string): void;
}) {
    if (!attachments.length && !uploads.length)
        return null;
    return <section className="composer-attachments" aria-label="待发送附件">
    {attachments.map(file => <div className="composer-attachment" key={file.attachmentId}>
      {file.kind === 'image' ? <Image size={18}/> : <FileText size={18}/>}<div className="attachment-description"><strong>{file.name}</strong><small>{sizeLabel(file.sizeBytes)} · 已上传</small></div>
      <IconButton label={`移除 ${file.name}`} disabled={disabled} onClick={() => onRemove(file.attachmentId)}><X size={16}/></IconButton>
    </div>)}
    {uploads.map(job => <div className={`composer-attachment ${job.status === 'failed' ? 'attachment-failed' : ''}`} key={job.id}>
      {job.file.kind === 'image' ? <Image size={18}/> : <FileText size={18}/>}<div className="attachment-description"><strong>{job.file.name}</strong><small role={job.status === 'failed' ? 'alert' : undefined}>{job.status === 'failed' ? job.error : job.status === 'queued' ? '等待上传' : job.received === job.file.size ? '正在校验…' : `上传中 ${Math.floor(job.received / job.file.size * 100)}%`}</small>
      {job.status === 'uploading' ? <progress aria-label={`${job.file.name} 上传进度`} value={job.received} max={job.file.size}/> : null}</div>
      {job.status === 'failed' ? <IconButton label={`重试上传 ${job.file.name}`} disabled={disabled} onClick={() => onRetry(job.id)}><RotateCw size={16}/></IconButton> : null}
      <IconButton label={`取消上传 ${job.file.name}`} disabled={disabled} onClick={() => onCancel(job.id)}><X size={16}/></IconButton>
    </div>)}
  </section>;
}
