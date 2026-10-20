import { randomUUID } from 'node:crypto';

import { reduceTurnParts } from '../../shared/turn-parts.mjs';

const cancelled = () => new Error('回合已取消。');
const scopeOf = (id) => id || '';

/** 宿主拥有请求生命周期；导航只订阅状态，同会话才互相让位。 */
export function createConversationTurns({ onState = () => {}, now = Date.now } = {}) {
  const slots = new Map();
  const states = new Map();
  const waiters = new Map();
  let closed = false;
  const current = (token) => slots.get(scopeOf(token.conversationId)) === token && !token.controller.signal.aborted;
  const publish = (snapshot) => onState(structuredClone(snapshot));
  function release(token) {
    const key = scopeOf(token.conversationId);
    if (slots.get(key) !== token) return;
    slots.delete(key);
    for (const resolve of waiters.get(key) ?? []) resolve();
    waiters.delete(key);
  }
  function reserve(token) {
    if (closed) throw cancelled();
    const key = scopeOf(token.conversationId);
    slots.get(key)?.controller.abort();
    slots.set(key, token);
    return token;
  }
  function begin({ conversationId = null, turnId, requestId = randomUUID() }) {
    const token = reserve({ conversationId, turnId, requestId, controller: new AbortController(), dialogue: true });
    const snapshot = { conversationId, turnId, requestId, startedAt: now(), status: 'running', text: '', thinking: null, parts: [] };
    states.delete(scopeOf(conversationId));
    states.set(scopeOf(conversationId), { token, snapshot });
    // 最多保留 100 个会话的最后一轮；在途状态不裁剪。
    for (const [key, entry] of states) {
      if (states.size <= 100) break;
      if (entry.snapshot.status !== 'running') states.delete(key);
    }
    publish(snapshot);
    return token;
  }
  function update(token, event) {
    if (!current(token)) return false;
    const snapshot = states.get(scopeOf(token.conversationId))?.snapshot;
    if (!snapshot || snapshot.requestId !== token.requestId) return false;
    // 056：按到达顺序成段（导航后接回时渲染层照段还原对话流）。
    snapshot.parts = reduceTurnParts(snapshot.parts, event, now());
    if (event.kind === 'restart') { snapshot.text = ''; snapshot.thinking = null; }
    if (event.kind === 'thinking_start') {
      if (snapshot.thinking) snapshot.thinking.text += '\n\n';
      else snapshot.thinking = { text: '', startedAt: now(), endedAt: null };
    }
    if (event.kind === 'thinking') {
      snapshot.thinking ??= { text: '', startedAt: now(), endedAt: null };
      snapshot.thinking.text = (snapshot.thinking.text + event.text).slice(-100_000);
    }
    if (event.kind === 'text') snapshot.text = (snapshot.text + event.text).slice(-100_000);
    if ((event.kind === 'thinking_end' || event.kind === 'text') && snapshot.thinking?.endedAt == null && snapshot.thinking) {
      snapshot.thinking.endedAt = now();
    }
    return true;
  }
  function settle(token, { result, error } = {}) {
    const entry = states.get(scopeOf(token.conversationId));
    if (entry?.token === token) {
      const snapshot = {
        ...entry.snapshot, endedAt: now(),
        status: token.controller.signal.aborted ? 'cancelled' : error ? 'error' : 'complete',
        ...(result ? { result } : {}), ...(error ? { error: error.message ?? String(error) } : {}),
      };
      states.set(scopeOf(token.conversationId), { token, snapshot });
      release(token);
      publish(snapshot);
    } else release(token);
  }
  async function run(fn, { preempt = true, conversationId = null, token = null, turnIdLabel } = {}) {
    if (token) {
      if (!current(token)) throw cancelled();
      return fn({ controller: token.controller, turnId: token.turnId });
    }
    const key = scopeOf(conversationId);
    while (!preempt && slots.has(key)) {
      if (closed) throw cancelled();
      await new Promise((resolve) => {
        const pending = waiters.get(key) ?? new Set();
        pending.add(resolve);
        waiters.set(key, pending);
      });
    }
    const owned = reserve({ conversationId, turnId: turnIdLabel ?? randomUUID(), controller: new AbortController() });
    try { return await fn({ controller: owned.controller, turnId: owned.turnId }); }
    finally { release(owned); }
  }
  function cancel({ conversationId = null, turnId, requestId } = {}) {
    const token = slots.get(scopeOf(conversationId));
    if (!token?.dialogue || token.turnId !== turnId || (requestId && token.requestId !== requestId)) return false;
    token.controller.abort();
    settle(token);
    return true;
  }
  function abortAll() {
    closed = true;
    for (const token of [...slots.values()]) {
      token.controller.abort();
      if (token.dialogue) settle(token); else release(token);
    }
  }
  return {
    begin, update, settle, run, cancel, abortAll, current,
    isActive: (conversationId) => slots.has(scopeOf(conversationId)),
    getState: (conversationId) => structuredClone(states.get(scopeOf(conversationId))?.snapshot ?? null),
  };
}
