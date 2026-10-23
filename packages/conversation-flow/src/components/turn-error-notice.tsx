import {useId} from 'react';
import {CircleAlert, ChevronDown} from 'lucide-react';
import {turnErrorCopy} from '../presentation/turn-error.js';
import {useTranscriptRowState} from './transcript-row-state.js';

export function TurnErrorNotice({message, onRetry, busy = false, blocked, speech = false}: {
  message: string;
  onRetry?: () => void;
  busy?: boolean;
  blocked?: string;
  speech?: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = useTranscriptRowState('error-details-open', false);
  const detailId = useId();
  const copy = speech ? {title: '语音连接中断', description: '可以重新开始通话。', detail: message} : turnErrorCopy(message);
  return <div className="turn-error-notice model-recovery-notice" data-phase="failed" aria-label={copy.title}>
    <div className="model-recovery-row">
      <CircleAlert className="model-recovery-icon" size={14} strokeWidth={1.75} aria-hidden="true"/>
      <span className="model-recovery-title" role="status">{copy.title}</span>
      {onRetry ? <button type="button" className="turn-error-retry model-recovery-action primary" onClick={onRetry}
        disabled={busy || Boolean(blocked)} aria-busy={busy} aria-description={blocked}>
        {busy ? '正在重试…' : '重试'}
      </button> : null}
      <button type="button" className="model-recovery-toggle" aria-label="错误详情" aria-expanded={detailsOpen} aria-controls={detailId} onClick={() => setDetailsOpen(value => !value)}><ChevronDown size={13} aria-hidden="true"/></button>
    </div>
    <details id={detailId} className="turn-error-details model-recovery-details" open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}>
      <summary hidden>错误详情</summary>
      <p>{copy.description}</p>
      {blocked ? <p>{blocked}</p> : null}
      {copy.detail ? <pre>{copy.detail}</pre> : null}
    </details>
  </div>;
}
