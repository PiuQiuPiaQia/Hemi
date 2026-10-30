import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';

// Control-plane requests may be repeated even after their HTTP body was sent:
// they have not submitted a model generation. This marker never goes on wire.
export const MODEL_PREFLIGHT = Symbol('hemi-model-preflight');
const activeFetch = new AsyncLocalStorage();
const requests = new WeakMap();

// One process-wide subscription per event; WeakMap keys do not retain requests,
// headers, bodies or account material. AsyncLocalStorage separates concurrent
// fetches, including requests queued on an already-connected Undici pool.
channel('undici:request:create').subscribe(({ request }) => {
  const state = activeFetch.getStore();
  if (!state || request.method === 'CONNECT') return;
  requests.set(request, state);
  if (state.delivery === 'unknown') state.delivery = 'not-sent';
});
channel('undici:client:sendHeaders').subscribe(({ request }) => {
  const state = requests.get(request);
  // Published before socket.write: conservatively treat even a partial write
  // as possibly submitted. No response/output is not proof of non-delivery.
  if (state) state.delivery = 'sending';
});
channel('undici:request:bodySent').subscribe(({ request }) => {
  const state = requests.get(request);
  if (state) state.delivery = 'sent';
});

export function transportCodeOf(error) {
  const pending = [error], seen = new Set();
  while (pending.length && seen.size < 16) {
    const item = pending.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (typeof item.code === 'string' && /^(?:E[A-Z0-9_]{2,40}|UND_ERR_[A-Z_]{1,40})$/.test(item.code)) return item.code;
    pending.push(item.cause, ...(Array.isArray(item.errors) ? item.errors : []));
  }
  return null;
}

/** Observe the existing dispatcher; do not bypass proxy policy or retry here. */
export function observeModelFetch(fetchImpl, input, init, state) {
  state.delivery = 'unknown';
  return activeFetch.run(state, () => fetchImpl(input, init));
}

/** Provider errors can include credentials; expose only a controlled message/code. */
export function modelConnectionError(error, message) {
  const code = transportCodeOf(error);
  return Object.assign(new Error(`${message}${code ? `（${code}）` : ''}`), code ? { code } : {});
}
