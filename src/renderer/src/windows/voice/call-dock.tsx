import type { CSSProperties } from 'react';
import { ChevronDown, Mic, MicOff, PhoneOff } from 'lucide-react';

import {
  formatCallElapsed,
  resolveCallDockStatus,
} from '@/windows/voice/lib/call-dock-state';

/**
 * Call Dock——通话中的状态条。037 起嵌在输入框顶部（TextComposer 的 header
 * 槽）：Orb、当前状态与计时、律动短线、静音、挂断，一行说完；不再有收起。
 * 设置页等离开对话的场景由 CallDockChip 承担压缩信息。
 */

export type CallDockProps = {
  sessionState: 'idle' | 'requesting' | 'listening' | 'error';
  turnPhase: 'idle' | 'listening' | 'thinking' | 'speaking' | 'replying' | 'error';
  streamingReply: string;
  interimText: string;
  elapsedSeconds: number;
  muted: boolean;
  /** 048：思考起点（毫秒时间戳；null＝不在思考）。 */
  thinkingSince?: number | null;
  onToggleMute: () => void;
  /** 037 起通话条嵌在输入框顶部、不再收起；保留可选以兼容旧调用。 */
  onCollapse?: () => void;
  onEndCall: () => void;
};

/** 通话活动标记：共用三条短线；表示通话状态，不表示实时音量。 */
export function CallActivityIndicator({ active }: { active: boolean }) {
  return <span className="h37-call-activity" data-active={active ? 'true' : 'false'} aria-hidden="true">
    <i /><i /><i />
  </span>;
}

export function CallDock({
  sessionState,
  turnPhase,
  streamingReply,
  interimText,
  elapsedSeconds,
  muted,
  thinkingSince = null,
  onToggleMute,
  onEndCall,
}: CallDockProps) {
  const status = resolveCallDockStatus({
    callActive: true,
    sessionState,
    turnPhase,
    streamingReply,
    interimText,
    muted,
    thinkingSince,
  });
  return (
    <section className="h24-call-dock h37-call-strip" data-phase={status.phase} aria-label="实时通话">
      <span
        className="h37-orb"
        data-size="sm"
        data-live={muted ? undefined : 'true'}
        style={{ '--orb': '28px' } as CSSProperties}
        aria-hidden="true"
      />
      <div className="h37-call-who">
        <b key={status.label}>{status.label}</b>
        <span>
          通话中 · {formatCallElapsed(elapsedSeconds)}
          {status.detail ? <em> · {status.detail}</em> : null}
        </span>
      </div>
      <CallActivityIndicator active={!muted} />
      <button
        type="button"
        className="h24-call-dock-mute h37-btn h37-btn-ghost h37-btn-sm"
        data-muted={muted ? 'true' : 'false'}
        onClick={onToggleMute}
        aria-pressed={muted}
        aria-label={muted ? '解除静音' : '静音麦克风'}
      >
        {muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
        <span>{muted ? '解除静音' : '静音'}</span>
      </button>
      <button
        type="button"
        className="h37-call-hangup"
        onClick={onEndCall}
        aria-label="结束通话"
        title="结束通话"
      >
        <PhoneOff aria-hidden="true" />
      </button>
    </section>
  );
}

/** 顶栏/设置页的压缩通话条：Dock 收起或进入设置页时的持续通话状态。 */
export function CallDockChip({
  elapsedSeconds,
  muted,
  onExpand,
  onEndCall,
}: {
  elapsedSeconds: number;
  muted: boolean;
  onExpand: () => void;
  onEndCall: () => void;
}) {
  return (
    <div className="h24-call-chip" role="group" aria-label="通话进行中">
      <CallActivityIndicator active={!muted} />
      <span className="h24-call-chip-label">{muted ? '已静音' : '通话中'}</span>
      <span className="h24-call-dock-time">{formatCallElapsed(elapsedSeconds)}</span>
      <button type="button" className="h24-call-chip-btn" onClick={onExpand} aria-label="展开通话面板" title="展开通话面板">
        <ChevronDown className="size-3.5" />
      </button>
      <button type="button" className="h24-call-chip-btn" onClick={onEndCall} aria-label="结束通话" title="结束通话">
        <PhoneOff className="size-3.5" />
      </button>
    </div>
  );
}
