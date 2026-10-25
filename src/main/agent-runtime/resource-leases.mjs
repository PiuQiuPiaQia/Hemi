import { withExecutionScope } from './execution-scope.mjs';
import { createHash } from 'node:crypto';
const overlap = (a, b) => a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`) || b.startsWith(a.endsWith('/') ? a : `${a}/`);
const conflicts = (a, b) => a.host === b.host && (a.scope === '*' || b.scope === '*' || overlap(a.scope, b.scope)) && (a.mode === 'write' || b.mode === 'write');

/** Hemi 执行者之间的调度；没有 OS 隔离承诺。等待在真实 execute 内，避免整批 prepare 死锁。 */
export function createResourceLeases() {
  const holders = new Map(), queue = []; let fence = 0;
  const drain = () => {
    for (let i = 0; i < queue.length;) {
      const item = queue[i];
      const blockers = [...holders.values(), ...queue.slice(0, i)].filter(h => conflicts(h.spec, item.spec));
      if (blockers.length) {
        const signature = JSON.stringify(blockers.map(h => h.spec));
        if (signature !== item.waitSignature) {
          item.waitSignature = signature;
          item.onWait?.(blockers.map(h => h.spec));
        }
        i++; continue;
      }
      queue.splice(i, 1); item.signal?.removeEventListener('abort', item.abort);
      const token = ++fence; holders.set(token, item);
      let released = false;
      item.resolve({ fence: token, release() { if (released) return; released = true; holders.delete(token); drain(); } });
    }
  };
  return {
    acquire(spec, signal, { onWait } = {}) {
      if (signal?.aborted) return Promise.reject(new DOMException('资源等待已取消','AbortError'));
      return new Promise((resolve, reject) => {
        const item = { spec, resolve, reject, signal, onWait };
        item.abort = () => { const index = queue.indexOf(item); if (index < 0) return; queue.splice(index, 1); signal?.removeEventListener('abort', item.abort); reject(new DOMException('资源等待已取消','AbortError')); drain(); };
        signal?.addEventListener('abort', item.abort, { once: true }); queue.push(item); drain();
      });
    },
    snapshot: () => ({ holders: [...holders.values()].map(item => item.spec), waiting: queue.map(item => item.spec) }),
  };
}
export const sharedResourceLeases = createResourceLeases();

/** 装饰注册工具，不在 tool_call 预处理时等待。两条独立路径仍可并发。 */
export function resourceGateway({ factories, resolvePath, fileHost = 'local', browserOwner, getExecution, callAnchor, sourceFor, beforeExecute, onActivity, leases = sharedResourceLeases }) {
  const resourceOf = async (tool, args) => {
    // Coordinate explicit file targets. A shell's cwd does not identify its writes,
    // so ordinary commands do not reserve the entire directory across conversations.
    if (['read','write','edit','ls','grep','glob'].includes(tool)) {
      const target = await resolvePath(args.path ?? args.cwd ?? '.');
      let scope = String(target.real ?? target.abs).replaceAll('\\','/').replace(/\/$/,'');
      if (process.platform === 'win32' && fileHost === 'local') scope = scope.toLowerCase();
      return { host: fileHost, scope: `file:${scope}`, mode: ['write','edit'].includes(tool) ? 'write' : 'read' };
    }
    if (/^(ui_|screen_view|app_open)/.test(tool)) return { host: 'local', scope: 'desktop', mode: 'write' };
    if (tool.startsWith('browser_')) return { host: 'local', scope: `browser:${browserOwner}`, mode: 'write' };
    return null;
  };
  return factories.map(item => ({ ...item, factory: pi => item.factory(new Proxy(pi, { get(target, name) {
    if (name !== 'registerTool') return Reflect.get(target, name);
    return definition => pi.registerTool({ ...definition, async execute(id, args, signal, ...rest) {
      const execution = getExecution();
      if (execution?.fatalError) throw new Error(execution.fatalError);
      if (execution?.cancelled?.()) throw new DOMException('根目标已停止','AbortError');
      const resource = await resourceOf(definition.name, args ?? {});
      const startedAt = Date.now();
      const lease = resource ? await leases.acquire({ ...resource, owner: execution?.owner ?? browserOwner,
        tool: definition.name, description: String(args?.path ?? '').slice(0, 120),
      }, signal, { onWait: blockers => onActivity?.({ toolCallId: id, tool: definition.name, since: startedAt, resource, blockers }) })
        .finally(() => onActivity?.({ toolCallId: id, finished: true })) : null;
      let observationId;
      const resources = { toolCallId: id };
      try {
        if (execution?.fatalError) throw new Error(execution.fatalError);
        if (signal?.aborted || execution?.cancelled?.()) throw new DOMException('根目标已停止','AbortError');
        if (!execution?.journal) return await withExecutionScope(execution, signal, () => definition.execute(id, args, signal, ...rest), resources);
        await beforeExecute?.();
        if (signal?.aborted || execution.cancelled?.()) throw new DOMException('根目标已停止','AbortError');
        const anchor = callAnchor?.(id);
        if (!anchor) throw new Error('工具缺少持久调用锚点，未开始执行');
        observationId = createHash('sha256').update(JSON.stringify([execution.owner, anchor, id])).digest('hex');
        const observation = await execution.journal.observationStart({ id: observationId, owner: execution.owner, tool: definition.name, toolCallId: id, callAnchorId: anchor, resource: resource ?? null });
        if (observation.existing) { observationId = null; throw new Error('该工具调用已有执行事实，不会重复执行；请先核对原结果'); }
        const result = await withExecutionScope(execution, signal, () => definition.execute(id, args, signal, ...rest), resources);
        let outputRef;
        if (Array.isArray(result.content) && !['context_read','task_read','conversation_read'].includes(definition.name)) {
          try {
            outputRef = await execution.contextStore.put({ owner: execution.owner, content: result.content, source: await sourceFor?.(definition.name, args, result) });
            if (execution.allowedRefs && !execution.allowedRefs.includes(outputRef)) execution.allowedRefs.push(outputRef);
          } catch (error) { execution.fatalError = `工具已执行，但原始结果保存失败：${error.message}`; throw new Error(execution.fatalError); }
        }
        await execution.journal.observationEnd(observationId, { outcome: result.isError ? 'error' : 'ok', outputRef, exitCode: result.details?.exitCode ?? result.details?.code ?? null });
        const details = { ...(result.details ?? {}) };
        // stdout/stderr 在不可变结果中有完整版本，不能又经 details 塞回 Pi entries。
        for (const key of ['stdout','stderr']) if (typeof details[key] === 'string') {
          details[`${key}Chars`] = details[key].length; delete details[key];
        }
        return { ...result, details: { ...details, hemiObservationRef: outputRef, hemiObservationId: observationId } };
      } catch (error) {
        if (observationId) {
          try { await execution.journal.observationEnd(observationId, { outcome: 'unknown', error: error.message }); }
          catch (failure) { execution.fatalError = `工具执行事实保存失败：${failure.message}`; }
        }
        throw error;
      } finally {
        if (!execution?.cleanupUnconfirmed) lease?.release();
      }
    } });
  } })) }));
}
