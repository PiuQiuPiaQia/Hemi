export type MessagePhase = 'commentary' | 'partial_answer' | 'final_answer' | 'unclassified';
export type MessagePhaseSource = 'provider' | 'contract';
export function normalizeMessagePhase(value: unknown): MessagePhase | undefined;
export function mergeMessagePhase(previous: MessagePhase | undefined, next: unknown): MessagePhase | undefined;
export function nativeMessagePhase(block: unknown): MessagePhase | undefined;
export function restoreNativeMessagePhases(payload: unknown, messages: any[]): void;
export function textFactOf(event: Record<string, unknown>): ({kind: string; [key: string]: unknown}) | null;
export function createMessagePhaseStream(emit: (event: Record<string, unknown>) => void): {
  reset(): void;
  update(event: any): void;
  finish(message: any): void;
};
