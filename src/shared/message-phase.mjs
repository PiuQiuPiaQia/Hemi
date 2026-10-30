/** Display semantics only: these labels never settle a run or authorize tools. */
export function normalizeMessagePhase(value) {
  return ['commentary', 'partial_answer', 'final_answer', 'unclassified'].includes(value) ? value : undefined;
}

export function mergeMessagePhase(previous, next) {
  next = normalizeMessagePhase(next);
  if (!next) return previous;
  if (next === 'unclassified' && previous) return previous;
  if (previous === 'final_answer') return previous;
  if (previous === 'partial_answer' && next === 'commentary') return previous;
  return next;
}

/** Read SDK metadata, never tags or JSON found in the model's prose. */
export function nativeMessagePhase(block) {
  if (typeof block?.textSignature !== 'string' || block.textSignature.length > 4096) return undefined;
  try {
    const signature = JSON.parse(block.textSignature);
    const phase = signature.v === 1 && typeof signature.id === 'string' ? normalizeMessagePhase(signature.phase) : undefined;
    return phase === 'unclassified' ? undefined : phase;
  } catch { return undefined; }
}

/** Pi 1.3 replays two phases natively. Preserve a provider-issued third phase
 * only when the outgoing item has the same native id and exact text. Never add
 * contract phases to provider history or infer them from message position. */
export function restoreNativeMessagePhases(payload, messages) {
  if (!Array.isArray(payload?.input)) return;
  const phases = new Map();
  for (const message of messages ?? []) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content ?? []) {
      const phase = nativeMessagePhase(block);
      if (!phase) continue;
      const signature = JSON.parse(block.textSignature);
      phases.set(signature.id, { phase, text: block.text });
    }
  }
  for (const item of payload.input) {
    const original = phases.get(item.id);
    if (item.type === 'message' && item.role === 'assistant' && item.phase == null && original
      && item.content?.length === 1 && item.content[0].type === 'output_text' && item.content[0].text === original.text) {
      item.phase = original.phase;
    }
  }
}

/** Shared by desktop, Bot, background work and task conversations. */
export function textFactOf(event) {
  if (!['text_start', 'text_delta', 'hemi_text_phase'].includes(event?.type)) return null;
  const phase = normalizeMessagePhase(event.phase);
  const metadata = {
    ...(typeof event.textId === 'string' ? { textId: event.textId } : {}),
    ...(phase ? { phase, phaseSource: event.phaseSource === 'provider' ? 'provider' : 'contract' } : {}),
  };
  if (event.type === 'text_start') return { kind: 'text-start', ...metadata };
  if (event.type === 'text_delta') return { kind: 'text', text: event.delta, ...metadata };
  return typeof event.textId === 'string' && phase ? { kind: 'text-phase', ...metadata } : null;
}

/** SDK contentIndex is request-local; display identities remain unique across requests. */
export function createMessagePhaseStream(emit) {
  let sequence = 0;
  const slots = new Map();
  const slotFor = index => {
    if (!slots.has(index)) slots.set(index, { textId: `message-text-${++sequence}`, phase: 'unclassified', phaseSource: 'contract' });
    return slots.get(index);
  };
  const tag = (slot, phase, source) => {
    const merged = mergeMessagePhase(slot.phase, phase);
    if (!merged || merged === slot.phase) return;
    slot.phase = merged;
    slot.phaseSource = source;
    emit({ type: 'hemi_text_phase', textId: slot.textId, phase: merged, phaseSource: source });
  };
  return {
    reset() { slots.clear(); },
    update(event) {
      if (!['text_start', 'text_delta', 'text_end'].includes(event.type)) { emit(event); return; }
      const slot = slotFor(event.contentIndex);
      const phase = nativeMessagePhase(event.partial?.content?.[event.contentIndex]);
      // A provider can supply phase only at output_item.done / text_end.
      if (phase) tag(slot, phase, 'provider');
      emit({ ...event, textId: slot.textId, phase: slot.phase, phaseSource: slot.phaseSource });
    },
    finish(message) {
      for (const [index, slot] of slots) {
        const phase = nativeMessagePhase(message.content?.[index]);
        if (phase) tag(slot, phase, 'provider');
      }
      slots.clear();
    },
  };
}
