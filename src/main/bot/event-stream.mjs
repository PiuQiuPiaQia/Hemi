import { randomUUID } from 'node:crypto';
import { validId, fail } from './storage.mjs';
import { coalesceFlowChanges } from '../../shared/conversation-flow.mjs';

/** A bounded, process-local replay log. A restart or expired cursor always yields a snapshot. */
export function createBotEventStream({ instanceId, snapshot, bootId = randomUUID(), maxEntries = 512, maxBytes = 8 * 1024 * 1024 }) {
  let sequence = 0, bytes = 0, closed = false, batchTimer = null;
  const log = [], listeners = new Set(), pending = new Map();
  const cursor = () => ({ bootId, sequence });
  function append(event) {
    if (closed) return;
    const frame = { version: 1, instanceId, ...cursor(), sequence: ++sequence, ...event };
    const size = Buffer.byteLength(JSON.stringify(frame));
    log.push({ frame, size }); bytes += size;
    while (log.length && (log.length > maxEntries || bytes > maxBytes)) bytes -= log.shift().size;
    for (const receive of [...listeners]) receive(frame);
  }
  function flush() {
    clearTimeout(batchTimer); batchTimer = null;
    for (const [id, change] of pending) append({type:'flow',id,change});
    pending.clear();
  }
  function publish(event) { flush(); append(event); }
  function flow(id, change) {
    if(closed)return;
    const old=pending.get(id);
    if(old && (old.generation!==change.generation || old.revision!==change.baseRevision))flush();
    pending.set(id,coalesceFlowChanges(pending.get(id),change));
    if(!batchTimer){batchTimer=setTimeout(flush,40);batchTimer.unref?.();}
  }
  function subscribe(options, send, disconnected = () => {}) {
    if (closed) fail('Bot 已关闭。', 'offline');
    if (options.instanceId !== instanceId) fail('Bot 身份不匹配。', 'conflict');
    if(options.ids!==undefined&&!Array.isArray(options.ids))fail('会话订阅无效。');
    const ids=[...new Set(options.ids ?? (options.id ? [options.id] : []))].sort();
    if(ids.length>16 || ids.some(id=>!validId(id)))fail('会话订阅无效。');
    const id=ids[0]??null, scope=ids.join(',');
    let disposed = false;
    const deliver = frame => {
      if (disposed) return;
      if (frame.type === 'flow' && !ids.includes(frame.id)) return;
      try { send(structuredClone(frame)); } catch { dispose(); disconnected(); }
    };
    function dispose() { disposed = true; listeners.delete(deliver); }
    // Snapshot capture, listener attachment and replay are synchronous: no subscription gap.
    flush();
    const previous = options.cursor;
    const resumable = previous?.bootId === bootId && (previous.scope === scope || (ids.length<=1 && previous.id === id))
      && Number.isSafeInteger(previous.sequence) && previous.sequence >= 0 && previous.sequence <= sequence
      && previous.sequence >= (log[0]?.frame.sequence ?? sequence + 1) - 1;
    if (resumable) {
      for (const item of log) if (item.frame.sequence > previous.sequence) deliver(item.frame);
    } else {
      deliver({ version: 1, instanceId, ...cursor(), type: 'reset', snapshot: { ...snapshot(id), details: ids.map(id=>snapshot(id).detail).filter(Boolean) } });
    }
    deliver({ version: 1, instanceId, ...cursor(), type: 'ready' });
    if (!disposed) listeners.add(deliver);
    return dispose;
  }
  return { publish, flow, subscribe, cursor, close() { closed = true; clearTimeout(batchTimer); pending.clear(); listeners.clear(); log.length = 0; bytes = 0; } };
}
