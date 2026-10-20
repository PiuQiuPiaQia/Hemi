/**
 * 013 首位说话人过滤状态机（D-3～D-6）：纯逻辑，无 React/Electron 依赖。
 *
 * - waiting：首条「definite final + 非空文本 + 有效编号」锁定该编号并采纳这一句
 *   （编号不要求 1，0 也是有效编号）；partial 可临时预览，不锁定、不受理。
 * - locked：仅采纳 primary 编号的 partial/final——旁人 partial 不进字幕、不推迟
 *   回合计时；旁人 final 不进历史、不触发回复/任务/转向/取消；无编号 final 不采纳
 *   且不继承上一句身份。utteranceId 记账：重复定稿幂等放行，编号改变＝归属冲突丢弃。
 * - unavailable：连续 N 条无编号 definitive final（默认 2）后降级——后续转写放行
 *   但提示持续可见（非静默放行，R-09）。
 *
 * 连接世代由调用方管理：开始通话/重连/结束通话/重新锁定都 reset()（D-4/D-6），
 * 锁定键不得跨连接复用。
 */

export type SpeakerLockPhase = 'waiting' | 'locked' | 'unavailable';

export type SpeakerTranscriptEvent = {
  type: 'transcript.partial' | 'transcript.final';
  text: string;
  utteranceId?: string;
  /** ASR 分句的说话人编号；无编号为 null（0 是有效编号）。 */
  speaker?: number | null;
};

export type SpeakerDecision = {
  admit: boolean;
  /** 未带编号的临时识别可预览；不进入回合计时、历史或执行。 */
  preview: boolean;
  phase: SpeakerLockPhase;
  primary: number | null;
  /** 需要界面提示的文案（一次性通知）；无提示为 null。 */
  notice: string | null;
};

export const SPEAKER_UNAVAILABLE_THRESHOLD = 2;

export function createPrimarySpeakerFilter({
  unavailableAfter = SPEAKER_UNAVAILABLE_THRESHOLD,
} = {}) {
  let phase: SpeakerLockPhase = 'waiting';
  let primary: number | null = null;
  let missingFinals = 0;
  /** utteranceId → 定稿时的编号（-1 表示无编号）；跨 reset 清空。 */
  const seenFinals = new Map<string, number>();

  function normalizeSpeaker(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function reset() {
    phase = 'waiting';
    primary = null;
    missingFinals = 0;
    seenFinals.clear();
  }

  function admitEvent(event: SpeakerTranscriptEvent): SpeakerDecision {
    const speaker = normalizeSpeaker(event.speaker);
    const text = String(event.text ?? '').trim();
    const decision = (admit: boolean, notice: string | null = null): SpeakerDecision => ({
      admit,
      preview: event.type === 'transcript.partial' && (phase !== 'locked' || speaker === null || speaker === primary),
      phase,
      primary,
      notice,
    });

    if (event.type === 'transcript.partial') {
      if (phase === 'locked') return decision(speaker === primary);
      // waiting：partial 仅临时预览、不锁定；unavailable：放行保持既有体验。
      return decision(phase === 'unavailable');
    }

    // —— final ——
    const isRepeat = event.utteranceId != null && seenFinals.has(event.utteranceId);

    if (phase === 'waiting') {
      if (!text) return decision(false);
      if (speaker === null) {
        if (!isRepeat) missingFinals += 1;
        if (event.utteranceId) seenFinals.set(event.utteranceId, -1);
        if (missingFinals >= unavailableAfter) {
          phase = 'unavailable';
          return decision(true, '没有收到说话人区分信息，暂时无法过滤旁人');
        }
        return decision(false);
      }
      phase = 'locked';
      primary = speaker;
      if (event.utteranceId) seenFinals.set(event.utteranceId, speaker);
      return decision(true);
    }

    if (phase === 'unavailable') {
      if (event.utteranceId) seenFinals.set(event.utteranceId, speaker ?? -1);
      return decision(true);
    }

    // —— locked ——
    // 归属冲突先于编号匹配：同一分句先前已带有效编号（-1＝当时无编号，不算冲突），
    // 现在编号变了 → 丢弃并提示，不偷偷改绑（R-08）。
    if (event.utteranceId != null) {
      const previous = seenFinals.get(event.utteranceId);
      if (
        previous !== undefined &&
        previous >= 0 &&
        speaker !== null &&
        previous !== speaker
      ) {
        return decision(false, '这句的说话人归属有冲突，已忽略');
      }
    }
    if (primary !== null && speaker === primary) {
      if (event.utteranceId) seenFinals.set(event.utteranceId, speaker);
      return decision(true);
    }
    if (speaker === null) return decision(false); // 无编号：不采纳不继承（R-04）
    return decision(false); // 其他编号：旁人（R-02/R-05）
  }

  /** R-07 重新锁定：清理锁定与候选，回到 waiting。 */
  function relock(): string {
    reset();
    return '已清除锁定，请主要说话人单独说一句';
  }

  return {
    admitEvent,
    reset,
    relock,
    get phase() {
      return phase;
    },
    get primary() {
      return primary;
    },
  };
}
