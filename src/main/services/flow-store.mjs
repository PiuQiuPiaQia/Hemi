/**
 * 057 flow 快照的串行写入器（S2，契约 §8）：每会话一条串行写链，落盘时**新鲜读
 * 当前档案 → 只叠加本次变更 → tmp＋rename 原子替换**。不缓存整档内存副本——
 * conversation-store 也在写同一文件（turns／agentSession），新鲜读合并保证
 * flow 写入不会用旧 turns 覆盖别人刚保存的字段（反向由 conversation-store
 * 保存时保留 flow 字段配合）。S3 统一写入链后此模块收敛进共用入口。
 *
 * 生产 IO 是同步实现且整个「读→写→改名」在一个同步临界段内完成——await 的
 * 微任务间隙会让 conversation-store 的同步保存插进来，随后 rename 用旧读覆盖
 * 掉它（真机实录：selfrun 档案 turns＋agentSession 丢失）。注入的异步 fsOps
 * （测试）走带 await 的同构路径，语义一致、时序由调用方保证。
 *
 * 写失败：变更留在待写队列，退避补存或随下一次 update／flush 重试；不回滚内存事实。
 * 崩溃只恢复最近原子提交快照；drop 先排空写链（迟到写入不复活）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { retryingRenameSync } from '../lib/rename-retry.mjs';
import { createPersistenceRetry } from '../lib/persistence-retry.mjs';

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * @param {object} options
 * @param {string} options.dir conversations 目录
 * @param {object} [options.fsOps] 测试注入（readFile/writeFile/rename/unlink/mkdir）
 * @param {{info: Function, warn: Function}} [options.log]
 */
export function createFlowStore({ dir, fsOps = null, log = null } = {}) {
  if (!dir) throw new Error('flow-store 缺少存储目录');
  const injected = fsOps != null;
  const io = fsOps ?? {
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, data) => fs.writeFileSync(p, data, 'utf8'),
    // Keep the merge/commit synchronous while retrying transient Windows locks.
    rename: retryingRenameSync((a, b) => fs.renameSync(a, b)),
    unlink: (p) => fs.unlinkSync(p),
  };

  /** 会话 → 待写变更队列（apply(record) → 新 record）。 */
  const pendingApplies = new Map();
  /** 每会话串行写链（promise 尾部）。 */
  const chains = new Map();
  const failures = new Map();
  const retries = new Map();
  function retryFor(id) {
    if (!retries.has(id)) retries.set(id, createPersistenceRetry(() => enqueueWrite(id)));
    return retries.get(id);
  }
  let tmpSeq = 0;

  function sessionPath(id) {
    if (!SESSION_ID_RE.test(String(id))) throw new Error(`非法会话 ID：${id}`);
    return path.join(dir, `${id}.json`);
  }

  /** 读当前档案（不存在/损坏 → 空记录起步；损坏不覆盖——只有本写入器成功写出的内容才落盘）。 */
  function readCurrentSync(conversationId) {
    let record = { id: conversationId };
    try {
      const parsed = JSON.parse(io.readFile(sessionPath(conversationId)));
      if (parsed && typeof parsed === 'object') record = parsed;
    } catch {
      // 不存在（首写）或读取失败：以空记录叠加。
    }
    return record;
  }

  /**
   * 字段级更新：apply(record) 在落盘的临界段对**最新档案**执行（返回新 record）。
   * 同会话多次 update 在同一写链上串行合并；写失败保留待重试。
   */
  function update(conversationId, apply) {
    if (typeof apply !== 'function') return Promise.reject(new Error('flow-store.update 需要应用函数'));
    const queue = pendingApplies.get(conversationId) ?? [];
    queue.push(apply);
    pendingApplies.set(conversationId, queue);
    return enqueueWrite(conversationId);
  }

  /** 写 flow 快照（控制器 store 效果的常用形态）。 */
  function saveFlow(conversationId, flowSnapshot) {
    return update(conversationId, (record) => ({ ...record, flow: flowSnapshot }));
  }

  function enqueueWrite(conversationId) {
    const tail = chains.get(conversationId) ?? Promise.resolve();
    const next = tail.catch(() => {}).then(() => (injected ? drainOnceAsync(conversationId) : drainOnceSync(conversationId)));
    chains.set(conversationId, next);
    return next;
  }

  /** 把已解析的最新档案依次套用变更（同步/异步两条 drain 各自先取好 record 再入队——
   * 异步路径必须 await 后传入，直接把 readCurrent 交给本函数会把 Promise 展开、
   * 静默丢掉 flow 以外的档案字段，2026-10-16 AC-38 注入探针钓出）。 */
  function applyQueue(conversationId, queue, record) {
    let next = record;
    for (const apply of queue) {
      try {
        next = apply(next) ?? next;
      } catch (error) {
        log?.warn?.(`flow-store 变更应用失败（${conversationId}）：${error?.message ?? error}`);
      }
    }
    return next;
  }

  /** 生产路径：同步临界段（读→写→改名），主线程上与 conversation-store 的同步保存互斥。 */
  function drainOnceSync(conversationId) {
    const queue = pendingApplies.get(conversationId);
    if (!queue || queue.length === 0) return undefined;
    const record = applyQueue(conversationId, queue, readCurrentSync(conversationId));
    const target = sessionPath(conversationId);
    tmpSeq += 1;
    const tmp = `${target}.flowtmp-${process.pid}-${tmpSeq}`;
    try {
      io.mkdir(dir);
      io.writeFile(tmp, JSON.stringify(record, null, 2));
      io.rename(tmp, target);
      pendingApplies.delete(conversationId);
      failures.delete(conversationId);
      retries.get(conversationId)?.reset();
      return undefined;
    } catch (error) {
      try { io.unlink(tmp); } catch { /* 已被 rename 或本就不在 */ }
      failures.set(conversationId, error);
      retryFor(conversationId).schedule();
      log?.warn?.(`flow-store 写入失败（${conversationId}）：${error?.message ?? error}`);
      return Promise.reject(error);
    }
  }

  /** 注入异步 IO 的同构路径（测试用；时序由串行写链保证）。 */
  async function drainOnceAsync(conversationId) {
    const queue = pendingApplies.get(conversationId);
    if (!queue || queue.length === 0) return;
    const readCurrent = async (id) => {
      try {
        const parsed = JSON.parse(await io.readFile(sessionPath(id)));
        return parsed && typeof parsed === 'object' ? parsed : { id };
      } catch {
        return { id };
      }
    };
    const record = applyQueue(conversationId, queue, await readCurrent(conversationId));
    const target = sessionPath(conversationId);
    tmpSeq += 1;
    const tmp = `${target}.flowtmp-${process.pid}-${tmpSeq}`;
    try {
      await io.mkdir(dir);
      await io.writeFile(tmp, JSON.stringify(record, null, 2));
      await io.rename(tmp, target);
      pendingApplies.delete(conversationId);
      failures.delete(conversationId);
      retries.get(conversationId)?.reset();
    } catch (error) {
      try { await io.unlink(tmp); } catch { /* 已被 rename 或本就不在 */ }
      failures.set(conversationId, error);
      retryFor(conversationId).schedule();
      log?.warn?.(`flow-store 写入失败（${conversationId}）：${error?.message ?? error}`);
      throw error;
    }
  }

  /** 等待该会话写链清空（退出／淘汰前调用）。 */
  async function flush(conversationId) {
    const chain = chains.get(conversationId);
    if (chain) await chain.catch(() => {});
    if (pendingApplies.get(conversationId)?.length) await enqueueWrite(conversationId);
  }

  async function flushAll() {
    const results = await Promise.allSettled([...chains.keys()].map(id => flush(id)));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  /** 读回最近已提交的 flow 快照（恢复用）；没有或结构不对返回 null。 */
  function loadFlow(conversationId) {
    const flow = readRecord(conversationId)?.flow;
    if (!flow || typeof flow !== 'object' || typeof flow.revision !== 'number') return null;
    if ((flow.schemaVersion ?? 0) > 1) return { unsupported: true, schemaVersion: flow.schemaVersion };
    return flow;
  }

  /** 原始档案直读（引导/迁移用——不经 conversation-store 的 sanitize，保留
   *  kind/taskSnap/usage 等迁移需要的字段）；不存在/损坏/结构不对返回 null。
   *  turns 与 flow 任一存在即视为有效档案（只写过 flow 的新档没有 turns）。 */
  function readRecord(conversationId) {
    try {
      const parsed = JSON.parse(io.readFile(sessionPath(conversationId)));
      const valid = parsed && typeof parsed === 'object'
        && (Array.isArray(parsed.turns) || (parsed.flow && typeof parsed.flow === 'object'));
      return valid ? parsed : null;
    } catch {
      return null;
    }
  }

  /** 删除/淘汰：先保证写链排空，调用方随后可安全删档（契约 §8：迟到写入不复活）。 */
  async function drop(conversationId) {
    await flush(conversationId).catch(() => {});
    pendingApplies.delete(conversationId);
    chains.delete(conversationId);
    failures.delete(conversationId);
    retries.get(conversationId)?.dispose();
    retries.delete(conversationId);
  }

  const hasFailure = (conversationId) => failures.has(conversationId);

  return { update, saveFlow, flush, flushAll, loadFlow, readRecord, drop, hasFailure, sessionPath };
}
