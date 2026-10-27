import { reduceTurnParts } from '../../shared/turn-parts.mjs';

const MAX_MESSAGES = 160;
const MAX_CHARS = 200_000;
const MAX_OUTPUT = 8_000;

/** Display projection of one dispatch, independent of the retained Pi session/context. */
export function createTaskConversation({ taskId, prompt, now = Date.now }) {
  let seq = 0, requestMessageId = null, closed = false;
  let value = { revision: 0, truncated: String(prompt).length > 32_000, messages: [
    { id: `${taskId}:input`, author: 'user', text: String(prompt).slice(0, 32_000), createdAt: now() },
  ] };
  const sizes = new WeakMap();
  const size = message => {
    if (!sizes.has(message)) sizes.set(message, message.text.length + JSON.stringify(message.parts ?? []).length);
    return sizes.get(message);
  };
  function update(messages) {
    let truncated = value.truncated;
    messages = messages.map(message => {
      if (!message.parts || size(message) <= 64_000) return message;
      truncated = true;
      let budget = 24_000;
      const clip = text => { const kept = budget > 0 ? String(text ?? '').slice(-budget) : ''; budget -= kept.length; return kept; };
      const trimCall = call => {
        const output = clip(call.output);
        return { ...call, output, outputTruncated: Boolean(call.outputTruncated || output.length < (call.output?.length ?? 0)),
          args: Object.fromEntries(Object.entries(call.args).map(([key, item]) => [key, typeof item === 'string' ? clip(item) : item])) };
      };
      const parts = message.parts.toReversed().map(part => part.type === 'tools'
        ? { ...part, calls: part.calls.toReversed().map(trimCall).reverse() } : { ...part, text: clip(part.text) }).reverse();
      return { ...message, parts, text: parts.filter(part => part.type === 'text').map(part => part.text).join('\n\n') };
    });
    let total = messages.reduce((sum, message) => sum + size(message), 0);
    while (messages.length > 2 && (messages.length > MAX_MESSAGES || total > MAX_CHARS)) {
      total -= size(messages[1]);
      messages = [messages[0], ...messages.slice(2)];
      truncated = true;
    }
    value = { ...value, revision: value.revision + 1, truncated, messages };
  }
  function assistant() {
    const last = value.messages.at(-1);
    if (last?.id === requestMessageId) return last;
    requestMessageId = `${taskId}:reply-${++seq}`;
    const message = { id: requestMessageId, author: 'hemi', text: '', parts: [], createdAt: now() };
    update([...value.messages, message]);
    return message;
  }
  function replace(message) {
    update(value.messages.map(item => item.id === message.id ? message : item));
  }
  function finishParts(parts, stopped = false) {
    return parts.map(part => part.type === 'thinking' && part.endedAt == null
      ? { ...part, endedAt: now(), ...(stopped ? { interrupted: true } : {}) }
      : part.type === 'tools' ? { ...part, calls: part.calls.map(call => call.state === 'running' && (!call.background || stopped)
        ? { ...call, state: stopped ? 'stopped' : 'error' } : call) } : part);
  }
  function reduce(event) {
    const message = assistant();
    const parts = reduceTurnParts(message.parts, event, now());
    if (parts === message.parts) return false;
    replace({ ...message, parts, text: parts.filter(part => part.type === 'text').map(part => part.text).join('\n\n') });
    return true;
  }
  return {
    snapshot: () => value,
    stream(event) {
      if (closed) return false;
      switch (event?.type) {
        case 'hemi_request_start': {
          const last = value.messages.at(-1);
          if (last?.parts) replace({ ...last, parts: finishParts(last.parts) });
          requestMessageId = null;
          return true;
        }
        case 'hemi_request_reset':
          if (requestMessageId) update(value.messages.filter(message => message.id !== requestMessageId));
          requestMessageId = null;
          return true;
        case 'text_delta': return reduce({ kind: 'text', text: event.delta });
        case 'thinking_start': return reduce({ kind: 'thinking_start' });
        case 'thinking_delta': return reduce({ kind: 'thinking', text: event.delta });
        case 'thinking_end': return reduce({ kind: 'thinking_end' });
        default: return false;
      }
    },
    progress(event) {
      if (closed) return;
      if (event.kind === 'tool-start') {
        // File contents and image/tool payloads do not belong in IPC display snapshots.
        const args = Object.fromEntries(Object.entries(event.args ?? {}).slice(0, 10).flatMap(([key, item]) =>
          ['content', 'image', 'data', 'base64', 'apiKey', 'token', 'password'].includes(key) ? []
            : typeof item === 'string' ? [[key, item.slice(0, 2_000)]]
              : ['number', 'boolean'].includes(typeof item) ? [[key, item]] : []));
        reduce({ kind: 'tool_start', tool: event.tool, toolCallId: event.toolCallId, args });
      } else if (event.kind === 'tool-end') {
        const matches = call => !event.background && event.commandId ? call.commandId === event.commandId : call.id === event.toolCallId
          && (!event.background || !event.commandId || !call.commandId || call.commandId === event.commandId);
        const message = value.messages.findLast(message => message.parts?.some(part => part.type === 'tools'
          && part.calls.some(call => matches(call) && call.state === 'running')));
        if (!message) return;
        const parts = reduceTurnParts(message.parts,{...event,kind:'tool_end'},now());
        replace({ ...message, parts: parts.map(part => part.type === 'tools'
          ? { ...part, calls: part.calls.map(call => matches(call)
            ? { ...call, output: String(event.text ?? '').slice(0, MAX_OUTPUT), outputTruncated: String(event.text ?? '').length > MAX_OUTPUT } : call) } : part) });
      }
    },
    finish({ report, stopped = false } = {}) {
      if (closed) return;
      if (report && !value.messages.some(message => message.author === 'hemi' && message.text.trim())) reduce({ kind: 'text', text: report });
      update(value.messages.map(message => message.parts ? { ...message, parts: finishParts(message.parts, stopped) } : message));
      closed = true;
    },
  };
}
