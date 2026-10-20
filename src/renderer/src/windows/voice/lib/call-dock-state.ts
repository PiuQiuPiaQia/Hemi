import type { SessionState, TurnPhase } from '@/shared/types';

/**
 * Call Dock（024 重构）的状态映射纯函数：连接/聆听/思考/播报/静音五态，
 * 文案与旧 voice-pane 状态标题同口径，供组件与单测共用。
 *
 * 优先级：静音是硬覆盖（用户明确关了麦，别的状态都不该假装在听）>
 * 接通中 > 回合相位（thinking/speaking/replying）> 聆听（含临时稿提示）。
 */

export type CallDockPhase = 'muted' | 'connecting' | 'thinking' | 'speaking' | 'replying' | 'listening' | 'idle';

export type CallDockStatus = {
  phase: CallDockPhase;
  /** 主行文案（加粗）。 */
  label: string;
  /** 副行文案（转写占位或状态说明）。 */
  detail: string;
};

export function resolveCallDockStatus(input: {
  callActive: boolean;
  sessionState: SessionState;
  turnPhase: TurnPhase;
  /** 流式增量非空＝首字已到、正文还在流入。 */
  streamingReply: string;
  interimText: string;
  muted: boolean;
  /** 048：思考起点（毫秒时间戳；null＝不在思考）——思考计时的依据。 */
  thinkingSince?: number | null;
}): CallDockStatus {
  const { callActive, sessionState, turnPhase, streamingReply, interimText, muted } = input;

  if (muted) {
    return { phase: 'muted', label: '已静音', detail: '点「解除静音」继续对话' };
  }
  if (sessionState === 'requesting') {
    return { phase: 'connecting', label: '正在接通', detail: '马上好' };
  }
  if (turnPhase === 'thinking') {
    if (streamingReply) {
      return { phase: 'speaking', label: '回应中', detail: '正在说给你听' };
    }
    // 048：思考计时（thinkingSince 非空）——与字幕窗同口径，只计时不显文字。
    if (input.thinkingSince) {
      const seconds = Math.max(0, Math.round((Date.now() - input.thinkingSince) / 1000));
      return { phase: 'thinking', label: `思考中 · ${seconds}s`, detail: '想好了立刻回你' };
    }
    return { phase: 'thinking', label: '正在想', detail: '想好了立刻回你' };
  }
  if (turnPhase === 'speaking') {
    return { phase: 'speaking', label: '正在说', detail: '直接开口就能打断我' };
  }
  if (turnPhase === 'replying') {
    return { phase: 'replying', label: '说完了', detail: '继续说，我听着' };
  }
  if (sessionState === 'listening') {
    return interimText.trim()
      ? { phase: 'listening', label: '正在识别', detail: interimText }
      : { phase: 'listening', label: '我在听', detail: '直接说话，不需要长按' };
  }
  return {
    phase: 'idle',
    label: callActive ? '通话中' : '待机',
    detail: callActive ? '说句话就能叫醒我' : '',
  };
}

/** 计时文案：秒 → mm:ss（超一小时 yyyy:mm:ss 不做，通话没有这么长的口径）。 */
export function formatCallElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
