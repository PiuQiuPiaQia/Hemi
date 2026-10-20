import type { AsrEvent } from '@/shared/types';

type PartialEvent = Extract<AsrEvent, { type: 'transcript.partial' }>;
type FinalEvent = Extract<AsrEvent, { type: 'transcript.final' }>;
type InterimUtterance = { text: string; utteranceId?: string };

const STRIP_PATTERN = /[\s，。！？、,.!?；;：:'"“”‘’（）()【】\[\]—-]/g;

function normalize(text: string): string {
  return text.replace(STRIP_PATTERN, '');
}

/**
 * 仅为缺少分句身份的旧事件提供文本回退。文字可能被二遍识别完全改写，
 * 不能用相似度代替 utteranceId 判断已知分句的归属。
 */
export function shouldClearInterimOnFinal(
  finalText: string,
  interimText: string,
): boolean {
  const final = normalize(finalText);
  const interim = normalize(interimText);
  if (!interim) return true;
  if (!final) return false;
  return (
    final === interim || final.startsWith(interim) || interim.startsWith(final)
  );
}

/** Track each partial's identity so a corrected final retires only its own row. */
export class InterimTranscript {
  private utterances: InterimUtterance[] = [];
  private finalized = new Set<string>();

  get text(): string {
    return this.utterances.map((utterance) => utterance.text).join('');
  }

  clear(): string {
    this.utterances = [];
    return this.text;
  }

  reset(): string {
    this.finalized.clear();
    return this.clear();
  }

  partial(event: PartialEvent): string {
    // Empty partials mean this provider message has no new interim result.
    // Stale partials must not resurrect a final or erase the next sentence.
    const next = (event.utterances ?? [{ text: event.text, utteranceId: event.utteranceId }])
      .filter(({ text, utteranceId }) => text.trim() && (!utteranceId || !this.finalized.has(utteranceId)));
    if (next.length) this.utterances = next;
    return this.text;
  }

  finalize(event: FinalEvent): string {
    if (!event.text.trim()) return this.text;
    if (event.utteranceId) this.finalized.add(event.utteranceId);
    this.utterances = this.utterances.filter((utterance) => {
      if (event.utteranceId && utterance.utteranceId) {
        return event.utteranceId !== utterance.utteranceId;
      }
      return !shouldClearInterimOnFinal(event.text, utterance.text);
    });
    return this.text;
  }
}
