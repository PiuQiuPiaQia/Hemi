import type { InputSource } from '@/shared/types';

export type HistoryEntry = { author: 'user' | 'hemi'; text: string; utteranceId?: string };

/** ASR may revise a final after the next utterance has started. Keep one
 * history entry per utterance, just as the visible transcript does. */
export function recordFinal(history: HistoryEntry[], text: string, utteranceId?: string) {
  const index = utteranceId
    ? history.findIndex((entry) => entry.author === 'user' && entry.utteranceId === utteranceId)
    : -1;
  if (index >= 0) {
    return {
      history: history.map((entry, i) => i === index ? { ...entry, text } : entry),
      index,
      changed: history[index].text !== text,
    };
  }
  return { history: [...history, { author: 'user' as const, text, utteranceId }], index: history.length, changed: true };
}

/** Energy alone may remain high due to background noise. Once there is a
 * final and no unfinished text, don't wait forever for that energy to drop. */
export function shouldWaitForSpeech(gateOpen: boolean, interim: string, sinceProgressMs: number): boolean {
  return (interim.trim().length > 0 || gateOpen) && sinceProgressMs < 5000;
}

/** 024：来源是否允许自动播报——文字回合/任务的回复只显示，不合成。 */
export function shouldAutoSpeak(source: InputSource | null | undefined): boolean {
  return source !== 'text';
}

/**
 * 024：是否有未提交的语音（文字发送的同步守卫）。
 * 覆盖：按住录音中、ASR 临时文本、已定稿但尚未提交进模型回合的用户条目。
 * 连续通话本身不算——静音门常开不能永久锁住文字。
 */
export function hasPendingSpeech(input: {
  /** 按住说话进行中（含接通请求期）。 */
  holdActive: boolean;
  /** ASR 当前临时文本。 */
  interim: string;
  /** 已受理边界之后的用户条目（定稿未提交；含松手后的最终 flush 落点）。 */
  unsubmittedUserCount: number;
}): boolean {
  return input.holdActive || input.interim.trim().length > 0 || input.unsubmittedUserCount > 0;
}

/** 024：文字是否可发送——忙碌判定只看模型请求实际在途，不看播放与后台任务。 */
export function canSendText(input: {
  modelReady: boolean;
  modelInFlight: boolean;
  pendingSpeech: boolean;
}): boolean {
  return input.modelReady && !input.modelInFlight && !input.pendingSpeech;
}
