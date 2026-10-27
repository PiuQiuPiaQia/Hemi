/**
 * 056 · 回合内容按到达顺序排成段（思考／正文／工具组），对话流从上往下照实展示
 * （2026-10-14 用户反馈：原先思考、工具、正文三个缓冲各自累积，渲染时工具总被
 * 挤成一坨夹在思考与正文之间，与接口返回的先后对不上）。
 *
 * 主进程（回合快照与落档）与渲染层（流式显示）共用同一个归约，事件即 llm:delta
 * 的 kind：thinking_start/thinking/thinking_end/text/tool_start/tool_end/restart。
 * 连续的工具调用并成一个工具组（中间没有正文或思考插入时）。纯函数、不改入参。
 */

const MAX_TEXT = 100_000;
const MAX_CALLS = 40;

function closeThinking(parts, now) {
  const last = parts[parts.length - 1];
  if (last?.type === 'thinking' && last.endedAt == null) {
    return [...parts.slice(0, -1), { ...last, endedAt: now }];
  }
  return parts;
}

export function reduceTurnParts(parts, event, now = Date.now()) {
  const list = Array.isArray(parts) ? parts : [];
  const last = list[list.length - 1];
  switch (event?.kind) {
    case 'restart':
      return [];
    case 'thinking_start':
      if (last?.type === 'thinking' && last.endedAt == null) return list;
      return [...list, { type: 'thinking', text: '', startedAt: now, endedAt: null }];
    case 'thinking': {
      const delta = String(event.text ?? '');
      if (!delta) return list;
      if (last?.type === 'thinking' && last.endedAt == null) {
        return [...list.slice(0, -1), { ...last, text: (last.text + delta).slice(-MAX_TEXT) }];
      }
      return [...list, { type: 'thinking', text: delta, startedAt: now, endedAt: null }];
    }
    case 'thinking_end':
      return closeThinking(list, now);
    case 'text': {
      const delta = String(event.text ?? '');
      if (!delta) return list;
      const closed = closeThinking(list, now);
      const tail = closed[closed.length - 1];
      if (tail?.type === 'text') {
        return [...closed.slice(0, -1), { ...tail, text: (tail.text + delta).slice(-MAX_TEXT) }];
      }
      return [...closed, { type: 'text', text: delta }];
    }
    case 'tool_start': {
      const closed = closeThinking(list, now);
      const tail = closed[closed.length - 1];
      const callCount = closed.reduce((sum, part) => sum + (part.type === 'tools' ? part.calls.length : 0), 0);
      if (callCount >= MAX_CALLS) return closed;
      const call = {
        id: event.toolCallId ?? `${event.tool}-${callCount}`,
        tool: String(event.tool ?? ''),
        args: event.args ?? {},
        state: 'running',
      };
      if (tail?.type === 'tools') return [...closed.slice(0, -1), { ...tail, calls: [...tail.calls, call] }];
      return [...closed, { type: 'tools', calls: [call] }];
    }
    case 'tool_end': {
      const state = event.background ? 'running' : event.stopped ? 'stopped' : event.isError ? 'error' : 'done';
      let hit = false;
      const next = list.map((part) => {
        if (hit || part.type !== 'tools') return part;
        const index = part.calls.findIndex((call) =>
          call.state === 'running' && call.tool === event.tool && (!event.background && event.commandId
            ? call.commandId === event.commandId : (event.toolCallId == null || call.id === event.toolCallId)
              && (!event.background || !event.commandId || !call.commandId || call.commandId === event.commandId)));
        if (index < 0) return part;
        hit = true;
        const calls = part.calls.slice();
        calls[index] = { ...calls[index], state, ...(event.background ? {background:true,commandId:event.commandId} : {}) };
        return { ...part, calls };
      });
      return hit ? next : list;
    }
    default:
      return list;
  }
}

/** 落档用：收掉仍在进行的思考/工具（中断回合），去掉空段。 */
export function finalizeTurnParts(parts, now = Date.now(), { interrupted = false } = {}) {
  return (Array.isArray(parts) ? parts : [])
    .map((part) => {
      if (part.type === 'thinking') return { ...part, endedAt: part.endedAt ?? now, ...(interrupted && part.endedAt == null ? { interrupted: true } : {}) };
      if (part.type === 'tools') {
        return { ...part, calls: part.calls.map((call) => (call.state === 'running' ? { ...call, state: interrupted ? 'error' : 'done' } : call)) };
      }
      return part;
    })
    .filter((part) => (part.type === 'tools' ? part.calls.length > 0 : part.text.trim().length > 0));
}

/** 段里是否有正文以外的东西（只有正文时渲染层沿用旧形态即可）。 */
export function hasNonTextParts(parts) {
  return Array.isArray(parts) && parts.some((part) => part.type !== 'text');
}
