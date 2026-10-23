import { CircleAlert, RotateCcw } from "lucide-react";
import { turnErrorCopy } from "../presentation/turn-error.js";
import { useTranscriptRowState } from "./transcript-row-state.js";

export function TurnErrorNotice({
  message,
  onRetry,
  busy = false,
  blocked,
  speech = false,
}: {
  message: string;
  onRetry?: () => void;
  busy?: boolean;
  blocked?: string;
  speech?: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = useTranscriptRowState(
    "error-details-open",
    false,
  );
  const copy = speech
    ? {
        title: "语音连接中断",
        description: "可以重新开始通话。",
        detail: message,
      }
    : turnErrorCopy(message);
  return (
    <div className="turn-error-notice" role="status" aria-label={copy.title}>
      <CircleAlert className="turn-error-icon" aria-hidden="true" />
      <div className="turn-error-content">
        <div className="turn-error-heading">
          <p className="turn-error-title">{copy.title}</p>
          {onRetry ? (
            <button
              type="button"
              className="turn-error-retry"
              onClick={onRetry}
              disabled={busy || Boolean(blocked)}
              aria-busy={busy}
            >
              <RotateCcw aria-hidden="true" />
              {busy ? "正在重试…" : "重试"}
            </button>
          ) : null}
        </div>
        <p className="turn-error-description">{copy.description}</p>
        {blocked ? <p className="turn-error-blocked">{blocked}</p> : null}
        {copy.detail ? (
          <details
            className="turn-error-details"
            open={detailsOpen}
            onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
          >
            <summary>错误详情</summary>
            <pre>{copy.detail}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
