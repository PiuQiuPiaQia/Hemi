/**
 * 037 Phase A：分域记忆存储（异步 IO、串行提交队列、跨文件提交日志与崩溃恢复）。
 *
 * 契约见 requirements/037…/technical-plan/storage-and-contracts.md：
 * - Markdown 权威正文 + control.json 簿记（版本/来源截止/代次），不引入 SQLite；
 * - 所有变更在串行队列内「重读→校验→写 transaction/current.json→依次 rename→删日志」；
 * - 启动恢复 pending 提交：磁盘 hash 等于 before 继续补、等于 after 跳过、
 *   出现第三种内容则封闭该范围并报告，不覆盖外部编辑；
 * - 未包裹内容（loose 段）按待整理处理，不进入投影视图（USER 的 loose
 *   按个人资料职责仍有效）。
 *
 * 本文件不 import Electron，可离线单测（临时目录 + 注入时钟/崩溃点）。
 * fsync 与断电级故障注入按契约留到 Phase E 在真实 exFAT/APFS 上验证；
 * 本阶段的崩溃模型是「任意提交步骤中止后重启恢复」。
 */

import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  COLLECTION_READ_MAX_BYTES,
  DAILY_READ_BUDGET,
  RECORD_TEXT_LIMIT,
  SCRATCHPAD_READ_BUDGET,
  applyRecordBudget,
  countCodePoints,
  parseManagedDocument,
  parseRecordDocument,
  renderManagedDocument,
  renderRecordDocument,
  validateEntryContent,
  diffExternalDocument,
} from './memory-format.mjs';
import { noteActivity } from '../lib/perf.mjs';

export const CONTROL_SCHEMA_VERSION = 2;
export const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GLOBAL_FILES = { 'global/user': 'USER.md', 'global/facts': 'MEMORY.md' };

const ok = (data, extra = {}) => ({ ok: true, data, ...extra });
const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** scope → 记忆目录内相对路径（POSIX 分隔）。只接受固定枚举与合法 workspaceId。 */
export function scopeFilePath(scope) {
  if (!scope || typeof scope !== 'object') return null;
  if (scope.kind === 'global') {
    if (scope.target !== 'user' && scope.target !== 'facts') return null;
    return GLOBAL_FILES[`global/${scope.target}`];
  }
  if (scope.kind === 'workspace') {
    if (typeof scope.workspaceId !== 'string' || !WORKSPACE_ID_PATTERN.test(scope.workspaceId)) return null;
    return path.posix.join('workspaces', scope.workspaceId, 'MEMORY.md');
  }
  return null;
}

export function scopeKeyOf(scope) {
  if (scope?.kind === 'global') return `global/${scope.target}`;
  if (scope?.kind === 'workspace') return `workspace/${scope.workspaceId}`;
  return null;
}

export function createMemoryStore({
  memoryDir,
  log = null,
  nowFn = Date.now,
  idFactory = () => `mem-${randomUUID()}`,
  crashHook = null,
} = {}) {
  if (!memoryDir) throw new Error('memoryDir is required');

  const dirOf = (relPath) => path.join(memoryDir, ...String(relPath).split('/'));
  let queue = Promise.resolve();
  let control = null;
  let readyPromise = null;
  let readyFailure = null;
  const known = new Map(); // scopeKey → { hash, parsed, revision, epoch, looseKind }
  const sealedScopes = new Map(); // scopeKey → reason

  const enqueue = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  class CrashAbort extends Error {
    constructor(step) {
      super(`crash-injected:${step}`);
      this.step = step;
    }
  }
  const maybeCrash = (step) => {
    if (typeof crashHook === 'function' && crashHook(step)) throw new CrashAbort(step);
  };

  // ---------------------------------------------------------------- 基础 IO
  async function lstatExists(target) {
    try {
      return await fsp.lstat(target);
    } catch {
      return null;
    }
  }

  async function assertRealChain(relPath) {
    // memoryDir 之下逐段 lstat：任何符号链接都拒绝（防逃逸），最终必须是普通文件或不存在。
    const parts = String(relPath).split('/');
    let current = memoryDir;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const stats = await lstatExists(current);
      if (!stats) return { ok: true, exists: false };
      const isLast = i === parts.length - 1;
      if (stats.isSymbolicLink()) return { ok: false, reason: 'symlink' };
      if (isLast) {
        if (!stats.isFile()) return { ok: false, reason: 'not_regular_file' };
      } else if (!stats.isDirectory()) {
        return { ok: false, reason: 'not_directory' };
      }
    }
    return { ok: true, exists: true };
  }

  async function readScopeText(scopeKey) {
    const relPath = scopeFilePath(scopeFromKey(scopeKey));
    const chain = await assertRealChain(relPath);
    if (!chain.ok) return { text: null, issue: chain.reason };
    if (!chain.exists) return { text: '', issue: null };
    let raw;
    try {
      raw = await fsp.readFile(dirOf(relPath));
    } catch {
      return { text: null, issue: 'read_error' };
    }
    if (raw.length > COLLECTION_READ_MAX_BYTES) return { text: null, issue: 'oversized' };
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(raw), issue: null };
    } catch {
      return { text: null, issue: 'invalid_utf8' };
    }
  }

  async function atomicWrite(relPath, text) {
    noteActivity('memory-write');
    const target = dirOf(relPath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${nowFn()}`;
    await fsp.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
    try {
      await fsp.rename(tmp, target);
    } catch (error) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  // ---------------------------------------------------------------- control
  function ensureScopeControl(scopeKey) {
    if (!control.scopes[scopeKey]) {
      control.scopes[scopeKey] = { contentRevision: 0, scopeEpoch: 0, forgetBeforeSeq: 0 };
      return { entry: control.scopes[scopeKey], created: true };
    }
    return { entry: control.scopes[scopeKey], created: false };
  }

  async function persistControl() {
    noteActivity('memory-control-save');
    await atomicWrite('control.json', `${JSON.stringify(control, null, 2)}\n`);
  }

  async function loadControl() {
    const stats = await lstatExists(dirOf('control.json'));
    if (!stats) return null;
    if (!stats.isFile()) throw new Error('control.json 不是普通文件');
    const raw = await fsp.readFile(dirOf('control.json'), 'utf8');
    const parsed = JSON.parse(raw); // 解析失败向上抛，由 ready 收敛为 storage_error
    if (parsed?.schemaVersion !== CONTROL_SCHEMA_VERSION) {
      throw new Error(`control.json schemaVersion 不支持：${parsed?.schemaVersion}`);
    }
    return parsed;
  }

  // ---------------------------------------------------------------- 恢复
  async function recoverPendingTransaction() {
    const conflicts = [];
    const txPath = dirOf('transaction/current.json');
    const stats = await lstatExists(txPath);
    if (!stats) return conflicts;
    let tx;
    try {
      tx = JSON.parse(await fsp.readFile(txPath, 'utf8'));
    } catch (error) {
      // 日志本身损坏：不动任何目标文件，封闭全部写入口，原样归档留检。
      for (const scopeKey of Object.keys(control.scopes)) sealedScopes.set(scopeKey, 'transaction_unreadable');
      log?.error?.(`[memory-store] 提交日志不可读，已封闭写入口：${error.message}`);
      conflicts.push({ file: 'transaction/current.json', reason: 'unreadable' });
      try {
        const raw = await fsp.readFile(txPath);
        await fsp.writeFile(dirOf(`transaction/conflicted-unreadable-${nowFn()}.json`), raw);
        await fsp.rm(txPath, { force: true });
      } catch (archiveError) {
        log?.warn?.(`[memory-store] 归档损坏日志失败：${archiveError.message}`);
      }
      return conflicts;
    }
    for (const file of tx.files ?? []) {
      const target = dirOf(file.path);
      let diskHash;
      try {
        const raw = await fsp.readFile(target).catch(() => null);
        diskHash = sha256(raw ? new TextDecoder('utf-8').decode(raw) : '');
      } catch {
        diskHash = null;
      }
      if (diskHash === file.afterHash) continue; // 已完成
      if (diskHash === file.beforeHash) {
        await atomicWrite(file.path, file.after); // 从 before 补齐
        continue;
      }
      // 第三种内容＝外部编辑或未预期状态：不覆盖，封闭受影响范围
      // （control 冲突封闭全部域），日志归档留检并释放 current.json 槽位。
      const scopeKey = file.scopeKey ?? scopeKeyOfPath(file.path);
      if (file.path === 'control.json') {
        for (const key of Object.keys(control.scopes)) sealedScopes.set(key, 'control_conflict');
      } else if (scopeKey) {
        sealedScopes.set(scopeKey, 'recovery_conflict');
      }
      conflicts.push({ file: file.path, reason: 'hash_mismatch' });
      await archiveConflictedTransaction(tx, 'content_conflict');
      return conflicts;
    }
    if (tx.undo && tx.operationId) {
      await fsp.mkdir(dirOf('undo'), { recursive: true });
      await fsp.writeFile(dirOf(`undo/${tx.operationId}.json`), JSON.stringify(tx.undo, null, 2), 'utf8');
    }
    await fsp.rm(txPath, { force: true });
    return conflicts;
  }

  /** 冲突恢复：封闭写入口之外，把日志归档留检并释放 current.json 槽位。 */
  async function archiveConflictedTransaction(tx, reason) {
    const name = `conflicted-${tx?.operationId ?? 'unknown'}-${reason}.json`;
    try {
      await fsp.mkdir(dirOf('transaction'), { recursive: true });
      await fsp.writeFile(dirOf(`transaction/${name}`), JSON.stringify(tx, null, 2), 'utf8');
      await fsp.rm(dirOf('transaction/current.json'), { force: true });
    } catch (error) {
      log?.warn?.(`[memory-store] 归档冲突提交日志失败：${error.message}`);
    }
  }

  function scopeKeyOfPath(relPath) {
    const normalized = String(relPath).replaceAll('\\', '/');
    if (normalized === 'USER.md') return 'global/user';
    if (normalized === 'MEMORY.md') return 'global/facts';
    const match = /^workspaces\/([^/]+)\/MEMORY\.md$/.exec(normalized);
    return match ? `workspace/${match[1]}` : null;
  }

  // ---------------------------------------------------------------- ready
  function ensureReady() {
    if (!readyPromise) readyPromise = init();
    return readyPromise;
  }

  async function init() {
    try {
      await fsp.mkdir(memoryDir, { recursive: true });
      const existing = await loadControl();
      if (existing) {
        control = existing;
      } else {
        control = await initializeFresh();
      }
      const recoveryConflicts = await recoverPendingTransaction();
      // 预热全局两个域；工作区域按需在读路径懒加载。
      for (const scopeKey of ['global/user', 'global/facts']) {
        const state = await syncKnownState(scopeKey);
        if (!state.ok) sealedScopes.set(scopeKey, state.issue);
      }
      return ok({ recoveryConflicts });
    } catch (error) {
      readyFailure = fail('storage_error', `记忆存储初始化失败：${error.message}`);
      log?.error?.(`[memory-store] ${readyFailure.message}`);
      return readyFailure;
    }
  }

  async function initializeFresh() {
    const fresh = {
      schemaVersion: CONTROL_SCHEMA_VERSION,
      commitSeq: 0,
      sourceSeq: 0,
      scopes: {},
    };
    control = fresh;
    ensureScopeControl('global/user');
    ensureScopeControl('global/facts');
    await atomicWrite('control.json', `${JSON.stringify(fresh, null, 2)}\n`);
    // 全新目录补空文件（与 016 行为一致：文件存在、内容为空＝空记忆）。
    for (const relPath of ['USER.md', 'MEMORY.md']) {
      if (!(await lstatExists(dirOf(relPath)))) await atomicWrite(relPath, '');
    }
    return fresh;
  }

  // ---------------------------------------------------------------- 读与外部编辑同步
  async function syncKnownState(scopeKey) {
    const { text, issue } = await readScopeText(scopeKey);
    if (issue) return { ok: false, issue };
    const hash = sha256(text);
    const cached = known.get(scopeKey);
    if (cached && cached.hash === hash) return { ok: true, state: cached };
    const parsed = parseManagedDocument(text);
    const { entry: scopeControl, created } = ensureScopeControl(scopeKey);
    // 首次登记新工作区域时先把 control 落盘，保证后续提交的 beforeHash 与磁盘一致。
    if (created) await persistControl();
    if (cached) {
      const diff = diffExternalDocument(cached.parsed, parsed);
      let changed = false;
      for (const change of diff.changedEntries) {
        if (change.change === 'modified') {
          const entry = parsed.entries.find((e) => e.id === change.id);
          if (entry) entry.version = change.prevVersion + 1; // id 保留则递增版本
          changed = true;
        }
      }
      if (diff.removedEntryIds.length > 0) {
        scopeControl.scopeEpoch += 1; // 直接删除＝与 UI 删除相同的代次推进
        changed = true;
      }
      if (diff.looseChanged || diff.changedEntries.length > 0) changed = true;
      scopeControl.contentRevision += 1;
      if (changed) await persistControl();
    }
    const state = {
      hash,
      text,
      parsed,
      revision: scopeControl.contentRevision,
      epoch: scopeControl.scopeEpoch,
      looseKind: scopeKey === 'global/user' ? 'profile' : 'unsorted',
    };
    known.set(scopeKey, state);
    return { ok: true, state };
  }

  function guardScope(scope) {
    const key = scopeKeyOf(scope);
    if (!key || !scopeFilePath(scope)) return { ok: false, result: fail('scope_denied', '未知或非法的记忆范围') };
    if (sealedScopes.has(key)) {
      return { ok: false, result: fail('storage_error', `该范围处于封闭状态（${sealedScopes.get(key)}），操作被拒绝`) };
    }
    return { ok: true, key };
  }

  async function readScope(scope) {
    const gate = await ensureReady();
    if (!gate.ok) return gate;
    const guard = guardScope(scope);
    if (!guard.ok) return guard.result;
    return enqueue(async () => {
      const sync = await syncKnownState(guard.key);
      if (!sync.ok) return fail('unreadable', `该范围当前不可读（${sync.issue}）`);
      const { state } = sync;
      return ok({
        scope,
        revision: state.revision,
        epoch: state.epoch,
        entries: state.parsed.entries,
        loose: { kind: state.looseKind, segments: state.parsed.looseSegments },
        issues: state.parsed.issues,
      });
    });
  }

  async function listScopes() {
    const gate = await ensureReady();
    if (!gate.ok) return gate;
    const scopes = new Set(Object.keys(control.scopes));
    const workspacesDir = dirOf('workspaces');
    const stats = await lstatExists(workspacesDir);
    if (stats?.isDirectory()) {
      for (const name of await fsp.readdir(workspacesDir)) {
        // exFAT 的 ._* AppleDouble 垃圾与隐藏文件一律忽略。
        if (name.startsWith('.') || name.startsWith('._') || !WORKSPACE_ID_PATTERN.test(name)) continue;
        scopes.add(`workspace/${name}`);
      }
    }
    return ok({ scopeKeys: [...scopes].sort() });
  }

  // ---------------------------------------------------------------- 提交核心
  /**
   * 队列内提交：files 为 [{ scopeKey, path, after }]（control.json 由这里补最后一位）。
   * controlAfter 是本次提交完成后的 control 目标（调用方基于当前 control 克隆修改）。
   * 返回 { ok, operationId } 或错误结果；崩溃钩子在关键步骤后注入。
   */
  async function commitTransaction({ kind, files, controlAfter, undo }) {
    const operationId = `op-${nowFn()}-${randomUUID().slice(0, 8)}`;
    const plan = [];
    for (const file of files) {
      const relPath = file.relPath ?? scopeFilePath(scopeFromKey(file.scopeKey));
      const current = file.relPath ? await readRecordFile(file.relPath) : await readScopeText(file.scopeKey);
      if (current.issue) return fail('unreadable', `范围 ${file.scopeKey} 当前不可读（${current.issue}），未提交`);
      const before = current.text ?? '';
      const after = file.after;
      plan.push({ scopeKey: file.scopeKey, path: relPath, beforeHash: sha256(before), afterHash: sha256(after), after });
    }
    const controlText = `${JSON.stringify(controlAfter, null, 2)}\n`;
    plan.push({ scopeKey: null, path: 'control.json', beforeHash: sha256(`${JSON.stringify(control, null, 2)}\n`), afterHash: sha256(controlText), after: controlText });

    const tx = { operationId, kind, files: plan, undo: undo ?? null };
    await fsp.mkdir(dirOf('transaction'), { recursive: true });
    await atomicWrite('transaction/current.json', JSON.stringify(tx, null, 2));
    maybeCrash('transaction-written');

    for (let i = 0; i < plan.length; i++) {
      await atomicWrite(plan[i].path, plan[i].after);
      maybeCrash(`file-committed:${i}`);
    }
    if (undo) {
      await fsp.mkdir(dirOf('undo'), { recursive: true });
      await fsp.writeFile(dirOf(`undo/${operationId}.json`), JSON.stringify(undo, null, 2), 'utf8');
      maybeCrash('undo-written');
    }
    await fsp.rm(dirOf('transaction/current.json'), { force: true });

    control = controlAfter;
    for (const file of files) {
      if (file.relPath) continue; // 工作记录文件不进条目缓存
      const text = file.after;
      known.set(file.scopeKey, {
        hash: sha256(text),
        text,
        parsed: parseManagedDocument(text),
        revision: controlAfter.scopes[file.scopeKey].contentRevision,
        epoch: controlAfter.scopes[file.scopeKey].scopeEpoch,
        looseKind: file.scopeKey === 'global/user' ? 'profile' : 'unsorted',
      });
    }
    return ok({ operationId }, { operationId });
  }

  function cloneControl() {
    return JSON.parse(JSON.stringify(control));
  }

  function bumpScope(controlCopy, scopeKey, { epoch = false } = {}) {
    const entry = controlCopy.scopes[scopeKey] ?? { contentRevision: 0, scopeEpoch: 0, forgetBeforeSeq: 0 };
    entry.contentRevision += 1;
    if (epoch) entry.scopeEpoch += 1;
    controlCopy.scopes[scopeKey] = entry;
    return entry;
  }

  // ---------------------------------------------------------------- 变更操作
  async function addEntry({ scope, title, body, kind = 'fact', sourceRefs = [], relatedEntryIds = [] }) {
    const gate = await ensureReady();
    if (!gate.ok) return gate;
    const contentError = validateEntryContent({ title, body, kind });
    if (contentError) return fail('capacity_exceeded', contentError);
    const guard = guardScope(scope);
    if (!guard.ok) return guard.result;
    return enqueue(async () => {
      const sync = await syncKnownState(guard.key);
      if (!sync.ok) return fail('unreadable', `范围当前不可读（${sync.issue}）`);
      const now = nowFn();
      const entry = {
        id: idFactory(), version: 1, kind,
        title: String(title), body: String(body ?? ''),
        sourceRefs: [...sourceRefs], relatedEntryIds: [...relatedEntryIds],
        createdAt: now, updatedAt: now,
      };
      const after = renderManagedDocument([...sync.state.parsed.segments, { type: 'entry', entry }]);
      const controlAfter = cloneControl();
      controlAfter.commitSeq += 1;
      bumpScope(controlAfter, guard.key);
      const result = await commitTransaction({
        kind: 'addEntry',
        files: [{ scopeKey: guard.key, after }],
        controlAfter,
        undo: {
          operationKind: 'addEntry', scopeKey: guard.key, entryId: entry.id, createdAt: now,
          files: [{ path: scopeFilePath(scope), before: sync.state.text, after }],
        },
      });
      if (result.ok) return ok({ entry: { ...entry, scope } }, { operationId: result.operationId });
      return result;
    });
  }

  async function replaceEntry({ scope, entryId, expectedVersion, title, body, kind, sourceRefs, relatedEntryIds }) {
    const gate = await ensureReady();
    if (!gate.ok) return gate;
    const guard = guardScope(scope);
    if (!guard.ok) return guard.result;
    return enqueue(async () => {
      const sync = await syncKnownState(guard.key);
      if (!sync.ok) return fail('unreadable', `范围当前不可读（${sync.issue}）`);
      const target = sync.state.parsed.entries.find((e) => e.id === entryId);
      if (!target) return fail('invalid_input', `条目不存在：${entryId}`);
      if (expectedVersion !== undefined && target.version !== expectedVersion) {
        return fail('conflict', '条目已被其他修改更新，未写入', { current: { ...target, scope } });
      }
      const nextTitle = title ?? target.title;
      const nextBody = body ?? target.body;
      const nextKind = kind ?? target.kind;
      const contentError = validateEntryContent({ title: nextTitle, body: nextBody, kind: nextKind });
      if (contentError) return fail('capacity_exceeded', contentError);
      const now = nowFn();
      const updated = {
        ...target,
        title: nextTitle, body: nextBody, kind: nextKind,
        sourceRefs: sourceRefs ?? target.sourceRefs,
        relatedEntryIds: relatedEntryIds ?? target.relatedEntryIds,
        version: target.version + 1, updatedAt: now,
      };
      const segments = sync.state.parsed.segments.map((s) => (s.type === 'entry' && s.entry.id === entryId ? { type: 'entry', entry: updated } : s));
      const after = renderManagedDocument(segments);
      const controlAfter = cloneControl();
      controlAfter.commitSeq += 1;
      bumpScope(controlAfter, guard.key);
      const result = await commitTransaction({
        kind: 'replaceEntry',
        files: [{ scopeKey: guard.key, after }],
        controlAfter,
        undo: {
          operationKind: 'replaceEntry', scopeKey: guard.key, entryId, createdAt: now,
          entry: { ...target },
          files: [{ path: scopeFilePath(scope), before: sync.state.text, after }],
        },
      });
      if (result.ok) return ok({ entry: { ...updated, scope } }, { operationId: result.operationId });
      return result;
    });
  }

  async function removeEntry({ scope, entryId, expectedVersion }) {
    const gate = await ensureReady();
    if (!gate.ok) return gate;
    const guard = guardScope(scope);
    if (!guard.ok) return guard.result;
    return enqueue(async () => {
      const sync = await syncKnownState(guard.key);
      if (!sync.ok) return fail('unreadable', `范围当前不可读（${sync.issue}）`);
      const target = sync.state.parsed.entries.find((e) => e.id === entryId);
      if (!target) return fail('invalid_input', `条目不存在：${entryId}`);
      if (expectedVersion !== undefined && target.version !== expectedVersion) {
        return fail('conflict', '条目已被其他修改更新，未删除', { current: { ...target, scope } });
      }
      const now = nowFn();
      const segments = sync.state.parsed.segments.filter((s) => !(s.type === 'entry' && s.entry.id === entryId));
      const after = renderManagedDocument(segments);
      const controlAfter = cloneControl();
      controlAfter.commitSeq += 1;
      bumpScope(controlAfter, guard.key, { epoch: true });
      advanceForgetCutoff(controlAfter, guard.key);
      // R-09 一致遗忘：同域工作记录里 derivedFromEntryIds 指向该条目的块，
      // 与条目删除同事务清理（记录块一物一块，可精确整块删除；手工混写的
      // 块没有可靠关联标记，不猜测批删——保留并在结果里不冒充已清）。
      const files = [{ scopeKey: guard.key, after }];
      const removedRecordIds = [];
      const recordPaths = recordFilePaths(guard.key);
      if (recordPaths) {
        const dates = [dateString(now), dateString(now - 24 * 3600 * 1000)];
        for (const relPath of [recordPaths.scratchpad, ...dates.map((d) => recordPaths.daily(d))]) {
          const current = await readRecordFile(relPath);
          if (current.issue) continue;
          const parsed = parseRecordDocument(current.text ?? '');
          const linked = parsed.records.filter((r) => (r.derivedFromEntryIds ?? []).includes(entryId));
          if (!linked.length) continue;
          const kept = parsed.records.filter((r) => !(r.derivedFromEntryIds ?? []).includes(entryId));
          files.push({ scopeKey: guard.key, relPath, after: renderRecordDocument(kept) });
          removedRecordIds.push(...linked.map((r) => r.recordId));
        }
      }
      const result = await commitTransaction({
        kind: 'removeEntry',
        files,
        controlAfter,
        undo: {
          operationKind: 'removeEntry', scopeKey: guard.key, entryId, createdAt: now,
          entry: { ...target }, removedRecordIds,
          files: [{ path: scopeFilePath(scope), before: sync.state.text, after }],
        },
      });
      if (result.ok) return ok({ removedEntryId: entryId, removedRecordIds }, { operationId: result.operationId });
      return result;
    });
  }

  /**
   * 037 R-08 条目级撤销：只恢复该次变更，保留之后对其他条目的修改。
   * CAS 对 expectedAfterVersion（该次操作完成后条目应处的版本）；撤销本身
   * 推进受影响域代次（防后台候选把撤销前的决定写回）。
   */
  async function undoMutation({ operationId, expectedAfterVersion } = {}) {
    const gate = await ensureReady();
    if (!gate.ok) return gate;
    const id = String(operationId ?? '').trim();
    if (!id.startsWith('op-') || id.includes('..') || id.includes('/')) return fail('invalid_input', 'operationId 非法');
    return enqueue(async () => {
      let payload;
      try {
        payload = JSON.parse(await fsp.readFile(dirOf(`undo/${id}.json`), 'utf8'));
      } catch {
        return fail('invalid_input', `没有可撤销的操作：${id}`);
      }
      const kind = payload.operationKind;
      const scopeKey = payload.scopeKey ?? payload.fromScopeKey ?? null;
      if (!scopeKey || !control.scopes[scopeKey]) return fail('invalid_input', '撤销载荷缺少有效范围');
      if (sealedScopes.has(scopeKey)) return fail('storage_error', `范围 ${scopeKey} 处于封闭状态`);
      const scope = scopeFromKey(scopeKey);
      const sync = await syncKnownState(scopeKey);
      if (!sync.ok) return fail('unreadable', `范围当前不可读（${sync.issue}）`);
      const now = nowFn();

      if (kind === 'addEntry') {
        const target = sync.state.parsed.entries.find((e) => e.id === payload.entryId);
        if (!target) return fail('invalid_input', '该条目已不存在（可能已撤销或删除）');
        if (expectedAfterVersion !== undefined && target.version !== expectedAfterVersion) {
          return fail('conflict', '条目在新增之后被修改过，撤销会丢新内容', { current: { ...target } });
        }
        const segments = sync.state.parsed.segments.filter((s) => !(s.type === 'entry' && s.entry.id === payload.entryId));
        const controlAfter = cloneControl();
        controlAfter.commitSeq += 1;
        bumpScope(controlAfter, scopeKey, { epoch: true });
        advanceForgetCutoff(controlAfter, scopeKey);
        const result = await commitTransaction({
          kind: 'undoAdd', files: [{ scopeKey, after: renderManagedDocument(segments) }], controlAfter, undo: null,
        });
        return result.ok ? ok({ undone: 'removed', entryId: payload.entryId }, { operationId: result.operationId }) : result;
      }

      if (kind === 'replaceEntry') {
        const target = sync.state.parsed.entries.find((e) => e.id === payload.entryId);
        if (!target) return fail('invalid_input', '该条目已不存在，无法撤销替换');
        if (expectedAfterVersion !== undefined && target.version !== expectedAfterVersion) {
          return fail('conflict', '条目在替换之后又被修改，撤销会丢新内容', { current: { ...target } });
        }
        const restored = { ...payload.entry, version: target.version + 1, updatedAt: now };
        const segments = sync.state.parsed.segments.map((s) => (s.type === 'entry' && s.entry.id === payload.entryId ? { type: 'entry', entry: restored } : s));
        const controlAfter = cloneControl();
        controlAfter.commitSeq += 1;
        bumpScope(controlAfter, scopeKey, { epoch: true });
        advanceForgetCutoff(controlAfter, scopeKey);
        const result = await commitTransaction({
          kind: 'undoReplace', files: [{ scopeKey, after: renderManagedDocument(segments) }], controlAfter, undo: null,
        });
        return result.ok ? ok({ undone: 'restored', entry: restored }, { operationId: result.operationId }) : result;
      }

      if (kind === 'removeEntry') {
        const exists = sync.state.parsed.entries.some((e) => e.id === payload.entryId);
        if (exists) return fail('conflict', '该条目又出现了（可能已恢复或重新保存），不再自动撤销');
        const restored = { ...payload.entry, version: (payload.entry?.version ?? 0) + 1, updatedAt: now };
        const segments = [...sync.state.parsed.segments, { type: 'entry', entry: restored }];
        const controlAfter = cloneControl();
        controlAfter.commitSeq += 1;
        bumpScope(controlAfter, scopeKey, { epoch: true });
        advanceForgetCutoff(controlAfter, scopeKey);
        const result = await commitTransaction({
          kind: 'undoRemove', files: [{ scopeKey, after: renderManagedDocument(segments) }], controlAfter, undo: null,
        });
        return result.ok ? ok({ undone: 'restored', entry: restored }, { operationId: result.operationId }) : result;
      }

      if (kind === 'moveEntry') {
        if (!payload.toScopeKey || !control.scopes[payload.toScopeKey]) return fail('invalid_input', '撤销载荷缺少有效目标范围');
        const toSync = await syncKnownState(payload.toScopeKey);
        if (!toSync.ok) return fail('unreadable', `目标范围当前不可读（${toSync.issue}）`);
        const target = toSync.state.parsed.entries.find((e) => e.id === payload.entryId);
        if (!target) return fail('invalid_input', '条目不在撤销载荷的目标范围（可能已移走或删除）');
        if (expectedAfterVersion !== undefined && target.version !== expectedAfterVersion) {
          return fail('conflict', '条目在移动之后被修改过，撤销会丢新内容', { current: { ...target } });
        }
        const moved = { ...target, updatedAt: now };
        const fromAfter = renderManagedDocument([...sync.state.parsed.segments, { type: 'entry', entry: moved }]);
        const toAfter = renderManagedDocument(toSync.state.parsed.segments.filter((s) => !(s.type === 'entry' && s.entry.id === payload.entryId)));
        const controlAfter = cloneControl();
        controlAfter.commitSeq += 1;
        bumpScope(controlAfter, scopeKey);
        bumpScope(controlAfter, payload.toScopeKey, { epoch: true });
        advanceForgetCutoff(controlAfter, payload.toScopeKey);
        const result = await commitTransaction({
          kind: 'undoMove',
          files: [{ scopeKey, after: fromAfter }, { scopeKey: payload.toScopeKey, after: toAfter }],
          controlAfter, undo: null,
        });
        return result.ok ? ok({ undone: 'moved-back', entry: moved }, { operationId: result.operationId }) : result;
      }

      return fail('invalid_input', `该操作类型不提供条目级撤销：${kind ?? '未知'}`);
    });
  }

  async function moveEntry({ fromScope, entryId, expectedVersion, toScope }) {
    const gate = await ensureReady();
    if (!gate.ok) return gate;
    const fromKey = scopeKeyOf(fromScope);
    const toKey = scopeKeyOf(toScope);
    if (!fromKey || !toKey || !scopeFilePath(fromScope) || !scopeFilePath(toScope)) {
      return fail('scope_denied', '未知或非法的记忆范围');
    }
    if (fromKey === toKey) return fail('invalid_input', 'moveEntry 的目标范围必须与来源不同');
    for (const key of [fromKey, toKey]) {
      if (sealedScopes.has(key)) return fail('storage_error', `范围 ${key} 处于封闭状态（${sealedScopes.get(key)}）`);
    }
    return enqueue(async () => {
      const fromSync = await syncKnownState(fromKey);
      if (!fromSync.ok) return fail('unreadable', `来源范围当前不可读（${fromSync.issue}）`);
      const toSync = await syncKnownState(toKey);
      if (!toSync.ok) return fail('unreadable', `目标范围当前不可读（${toSync.issue}）`);
      const target = fromSync.state.parsed.entries.find((e) => e.id === entryId);
      if (!target) return fail('invalid_input', `条目不存在：${entryId}`);
      if (expectedVersion !== undefined && target.version !== expectedVersion) {
        return fail('conflict', '条目已被其他修改更新，未移动', { current: { ...target, scope: fromScope } });
      }
      const now = nowFn();
      const moved = { ...target, updatedAt: now };
      const fromAfter = renderManagedDocument(fromSync.state.parsed.segments.filter((s) => !(s.type === 'entry' && s.entry.id === entryId)));
      const toAfter = renderManagedDocument([...toSync.state.parsed.segments, { type: 'entry', entry: moved }]);
      const controlAfter = cloneControl();
      controlAfter.commitSeq += 1;
      bumpScope(controlAfter, fromKey, { epoch: true }); // 原位置删除＝代次推进
      advanceForgetCutoff(controlAfter, fromKey);
      bumpScope(controlAfter, toKey);
      const result = await commitTransaction({
        kind: 'moveEntry',
        files: [
          { scopeKey: fromKey, after: fromAfter },
          { scopeKey: toKey, after: toAfter },
        ],
        controlAfter,
        undo: {
          operationKind: 'moveEntry', entryId, fromScopeKey: fromKey, toScopeKey: toKey, createdAt: now,
          files: [
            { path: scopeFilePath(fromScope), before: fromSync.state.text, after: fromAfter },
            { path: scopeFilePath(toScope), before: toSync.state.text, after: toAfter },
          ],
        },
      });
      if (result.ok) return ok({ entry: { ...moved, scope: toScope } }, { operationId: result.operationId });
      return result;
    });
  }

  async function clearScope({ scope, expectedRevision }) {
    const gate = await ensureReady();
    if (!gate.ok) return gate;
    const guard = guardScope(scope);
    if (!guard.ok) return guard.result;
    return enqueue(async () => {
      const sync = await syncKnownState(guard.key);
      if (!sync.ok) return fail('unreadable', `范围当前不可读（${sync.issue}）`);
      if (expectedRevision !== undefined && sync.state.revision !== expectedRevision) {
        return fail('conflict', '范围内容已被更新，未清空', { current: { revision: sync.state.revision } });
      }
      const now = nowFn();
      const controlAfter = cloneControl();
      controlAfter.commitSeq += 1;
      bumpScope(controlAfter, guard.key, { epoch: true });
      advanceForgetCutoff(controlAfter, guard.key);
      const result = await commitTransaction({
        kind: 'clearScope',
        files: [{ scopeKey: guard.key, after: '' }],
        controlAfter,
        undo: null, // 清空是显式确认的破坏性操作，不提供单操作撤销载荷
      });
      if (result.ok) return ok({ clearedScopeKey: guard.key }, { operationId: result.operationId });
      return result;
    });
  }

  // ---------------------------------------------------------------- 工作记录（037 Phase B）
  // daily/SCRATCHPAD 只存在于工作区域（默认空间与具名项目）；
  // 全局两域没有任务工作记录。全部走同一提交机制。

  function recordFilePaths(scopeKey) {
    if (!scopeKey?.startsWith('workspace/')) return null;
    const dir = path.posix.join('workspaces', scopeKey.slice('workspace/'.length));
    return { daily: (date) => path.posix.join(dir, 'daily', `${date}.md`), scratchpad: path.posix.join(dir, 'SCRATCHPAD.md') };
  }

  async function readRecordFile(relPath) {
    const chain = await assertRealChain(relPath);
    if (!chain.ok) return { text: null, issue: chain.reason };
    if (!chain.exists) return { text: '', issue: null };
    let raw;
    try {
      raw = await fsp.readFile(dirOf(relPath));
    } catch {
      return { text: null, issue: 'read_error' };
    }
    if (raw.length > COLLECTION_READ_MAX_BYTES) return { text: null, issue: 'oversized' };
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(raw), issue: null };
    } catch {
      return { text: null, issue: 'invalid_utf8' };
    }
  }

  async function commitRecordFile({ scopeKey, relPath, after }) {
    const current = await readRecordFile(relPath);
    if (current.issue) return fail('unreadable', `工作记录文件不可读（${current.issue}）`);
    const before = current.text ?? '';
    const controlAfter = cloneControl();
    controlAfter.commitSeq += 1;
    bumpScope(controlAfter, scopeKey);
    return commitTransaction({
      kind: 'workingRecord',
      files: [{ scopeKey, relPath, after }],
      controlAfter,
      undo: null, // 工作记录块不提供单操作撤销（Phase C 的遗忘关联才消费它们）
    });
  }

  async function appendWorkingRecord({ scope, text, type = 'note', sourceRefs = [], derivedFromEntryIds = [] }) {
    const gate = await ensureReady();
    if (!gate.ok) return gate;
    const key = scopeKeyOf(scope);
    const paths = key ? recordFilePaths(key) : null;
    const textValue = String(text ?? '').trim();
    if (!paths) return fail('scope_denied', '工作记录只存在于工作区域（默认空间/项目/未绑定域）');
    if (!textValue) return fail('invalid_input', 'text 不能为空');
    if (countCodePoints(textValue) > RECORD_TEXT_LIMIT) {
      return fail('capacity_exceeded', `单条工作记录超过 ${RECORD_TEXT_LIMIT} 码点上限`);
    }
    if (type !== 'note' && type !== 'todo') return fail('invalid_input', 'type 只能是 note 或 todo');
    return enqueue(async () => {
      ensureScopeControl(key);
      const relPath = type === 'todo' ? paths.scratchpad : paths.daily(dateString(nowFn()));
      const current = await readRecordFile(relPath);
      if (current.issue) return fail('unreadable', `工作记录文件不可读（${current.issue}）`);
      const parsed = parseRecordDocument(current.text ?? '');
      const record = {
        recordId: idFactory(), type, done: false, text: textValue,
        sourceRefs: [...sourceRefs], derivedFromEntryIds: [...derivedFromEntryIds],
        createdAt: nowFn(),
      };
      const after = renderRecordDocument([...parsed.records, record]);
      return commitRecordFile({ scopeKey: key, relPath, after });
    });
  }

  async function readWorkingRecords({ scope } = {}) {
    const gate = await ensureReady();
    if (!gate.ok) return gate;
    const key = scopeKeyOf(scope);
    const paths = key ? recordFilePaths(key) : null;
    if (!paths) return fail('scope_denied', '工作记录只存在于工作区域');
    return enqueue(async () => {
      const today = dateString(nowFn());
      const yesterday = dateString(nowFn() - 24 * 3600 * 1000);
      const daily = [];
      for (const date of [today, yesterday]) {
        const current = await readRecordFile(paths.daily(date));
        if (current.issue) continue; // 单日异常不挡其他记录
        const parsed = parseRecordDocument(current.text ?? '');
        const { kept, omitted } = applyRecordBudget(parsed.records, DAILY_READ_BUDGET);
        if (kept.length || omitted) daily.push({ date, records: kept, omitted });
      }
      const pad = await readRecordFile(paths.scratchpad);
      let scratchpad = { records: [], omitted: 0 };
      if (!pad.issue) {
        const parsed = parseRecordDocument(pad.text ?? '');
        const { kept, omitted } = applyRecordBudget(parsed.records, SCRATCHPAD_READ_BUDGET);
        scratchpad = { records: kept, omitted };
      }
      return ok({ daily, scratchpad });
    });
  }

  async function updateScratchpad({ scope, action, text, recordId }) {
    const gate = await ensureReady();
    if (!gate.ok) return gate;
    const key = scopeKeyOf(scope);
    const paths = key ? recordFilePaths(key) : null;
    if (!paths) return fail('scope_denied', '便签只存在于工作区域');
    if (!['check', 'uncheck', 'clear_done'].includes(action)) {
      return fail('invalid_input', 'action 只能是 check、uncheck 或 clear_done（新增走 appendWorkingRecord type=todo）');
    }
    return enqueue(async () => {
      ensureScopeControl(key);
      const current = await readRecordFile(paths.scratchpad);
      if (current.issue) return fail('unreadable', `便签文件不可读（${current.issue}）`);
      const parsed = parseRecordDocument(current.text ?? '');
      const records = parsed.records;
      if (action === 'clear_done') {
        const kept = records.filter((r) => r.type !== 'todo' || !r.done);
        if (kept.length === records.length) return ok({ removed: 0 }, { unchanged: true });
        const after = renderRecordDocument(kept);
        const result = await commitRecordFile({ scopeKey: key, relPath: paths.scratchpad, after });
        return result.ok ? ok({ removed: records.length - kept.length }, { operationId: result.operationId }) : result;
      }
      const needle = String(recordId ?? text ?? '').trim();
      if (!needle) return fail('invalid_input', '需要 recordId 或 text 定位便签项');
      const matches = records.filter((r) => r.type === 'todo' && (r.recordId === needle || r.text.includes(needle)));
      if (matches.length === 0) return fail('invalid_input', '没有匹配的便签项');
      if (matches.length > 1) {
        return fail('conflict', `匹配到 ${matches.length} 项，请用 recordId 精确指定`, { current: matches.map((r) => ({ recordId: r.recordId, text: r.text.slice(0, 60) })) });
      }
      const target = matches[0];
      const done = action === 'check';
      if (target.done === done) return ok({ recordId: target.recordId }, { unchanged: true });
      const after = renderRecordDocument(records.map((r) => (r.recordId === target.recordId ? { ...r, done } : r)));
      const result = await commitRecordFile({ scopeKey: key, relPath: paths.scratchpad, after });
      return result.ok ? ok({ recordId: target.recordId, done }, { operationId: result.operationId }) : result;
    });
  }

  function dateString(ms) {
    const d = new Date(ms);
    const pad2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // ---------------------------------------------------------------- 撤销载荷（memory_restore 消费）
  // Phase B 语义：恢复只把「自那次操作以来未再变化」的文件写回 before；
  // 当前内容既不等于 after 也不等于 before＝已被后续修改，返回冲突不覆盖。

  async function listUndoOperations({ scopeKey } = {}) {
    const gate = await ensureReady();
    if (!gate.ok) return gate;
    const undoDir = dirOf('undo');
    const stats = await lstatExists(undoDir);
    if (!stats?.isDirectory()) return ok({ operations: [] });
    const operations = [];
    for (const name of (await fsp.readdir(undoDir).catch(() => []))) {
      if (!name.endsWith('.json') || name.startsWith('._')) continue;
      try {
        const payload = JSON.parse(await fsp.readFile(path.join(undoDir, name), 'utf8'));
        if (scopeKey && payload.scopeKey !== scopeKey) continue;
        operations.push({
          operationId: name.slice(0, -'.json'.length),
          operationKind: payload.operationKind ?? null,
          scopeKey: payload.scopeKey ?? null,
          entryId: payload.entryId ?? null,
          createdAt: payload.createdAt ?? null,
        });
      } catch {
        // 单个损坏载荷跳过，不影响清单。
      }
    }
    operations.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return ok({ operations });
  }

  async function restoreFromUndo({ operationId } = {}) {
    const gate = await ensureReady();
    if (!gate.ok) return gate;
    const id = String(operationId ?? '').trim();
    if (!id.startsWith('op-') || id.includes('..') || id.includes('/')) return fail('invalid_input', 'operationId 非法');
    return enqueue(async () => {
      const file = dirOf(`undo/${id}.json`);
      let payload;
      try {
        payload = JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch {
        return fail('invalid_input', `没有可恢复的操作：${id}`);
      }
      const files = payload.files ?? [];
      if (!files.length) return fail('invalid_input', '该操作没有可恢复的文件载荷');
      for (const entry of files) {
        const target = dirOf(entry.path);
        const raw = await fsp.readFile(target).catch(() => null);
        const diskText = raw ? new TextDecoder('utf-8').decode(raw) : '';
        if (diskText !== entry.after) {
          return fail('conflict', '该范围内容在操作之后已被修改，恢复会覆盖新内容，已拒绝', {
            current: { file: entry.path },
          });
        }
      }
      const scopeKey = payload.scopeKey ?? null;
      const controlAfter = cloneControl();
      controlAfter.commitSeq += 1;
      if (scopeKey) bumpScope(controlAfter, scopeKey, { epoch: true }); // 恢复正文＝新的有效内容变化
      const result = await commitTransaction({
        kind: 'restoreUndo',
        files: files.map((entry) => ({ scopeKey, relPath: entry.path, after: entry.before })),
        controlAfter,
        undo: null,
      });
      return result.ok ? ok({ operationId: id, restoredFiles: files.map((f) => f.path) }, { operationId: result.operationId }) : result;
    });
  }

  /** 零 IO 读取已知域状态摘要（广播/诊断用；未加载的域返回 null）。 */
  function scopeInfo(scopeKey) {
    const state = known.get(scopeKey);
    if (!state) return null;
    return { revision: state.revision, epoch: state.epoch };
  }

  // ---------------------------------------------------------------- 来源截止与提炼提交（037 Phase D）
  // sourceSeq：有效用户来源的单调序号（对话写入/任务受理各分配一次）；
  // forgetBeforeSeq：删除/清空/撤销时推进到当前 sourceSeq——其后提交的、
  // 基于更旧来源的提炼候选一律 source_revoked，迟到摘要不能写回已遗忘内容。

  /** 分配新来源序号（串行队列内持久化；返回分配后的序号）。 */
  function allocateSourceSeq() {
    return enqueue(async () => {
      control.sourceSeq += 1;
      await persistControl();
      return ok({ sourceSeq: control.sourceSeq });
    });
  }

  function advanceForgetCutoff(controlCopy, scopeKey) {
    const entry = controlCopy.scopes[scopeKey];
    if (entry) entry.forgetBeforeSeq = controlCopy.sourceSeq;
  }

  /**
   * 提炼作业起点快照：域 epoch/sourceSeq/forgetBeforeSeq＋本域条目版本表。
   * 作业结束提交时按此校验（epoch 变化或 forget 推进＝来源失效）。
   */
  async function captureExtractionLease(scopeKey) {
    const gate = await ensureReady();
    if (!gate.ok) return gate;
    return enqueue(async () => {
      const sync = await syncKnownState(scopeKey);
      if (!sync.ok) return fail('unreadable', `范围当前不可读（${sync.issue}）`);
      const scopeControl = control.scopes[scopeKey];
      return ok({
        scopeKey,
        epoch: scopeControl.scopeEpoch,
        sourceSeq: control.sourceSeq,
        forgetBeforeSeq: scopeControl.forgetBeforeSeq,
        domainScope: scopeFromKey(scopeKey),
        entries: sync.state.parsed.entries.map((e) => ({ id: e.id, version: e.version, title: e.title })),
        looseText: (sync.state.parsed.looseSegments ?? []).map((s) => s.text).join('\n'),
      });
    });
  }

  /**
   * 提炼结果单事务提交（R-13/R-09/D）：notes 落今日 daily、candidates 落本域
   * MEMORY；epoch/forgetBeforeSeq 校验不过＝source_revoked 不落盘。任何候选
   * 非法（超预算/引用不存在/版本冲突）则整批拒绝，不形成半个提炼结果。
   */
  async function commitExtraction({ scopeKey, lease, notes = [], candidates = [] }) {
    const gate = await ensureReady();
    if (!gate.ok) return gate;
    if (!scopeKey?.startsWith('workspace/')) return fail('scope_denied', '提炼只落工作区域');
    return enqueue(async () => {
      const scopeControl = control.scopes[scopeKey];
      if (!scopeControl) return fail('scope_denied', '未知的工作区域');
      if (sealedScopes.has(scopeKey)) return fail('storage_error', `范围 ${scopeKey} 处于封闭状态`);
      if (!lease || lease.scopeKey !== scopeKey) return fail('source_revoked', '提炼快照与范围不匹配');
      if (scopeControl.scopeEpoch !== lease.epoch) {
        return fail('source_revoked', '作业期间该范围发生过遗忘或撤销，候选按旧来源拒绝');
      }
      if (scopeControl.forgetBeforeSeq > lease.forgetBeforeSeq) {
        return fail('source_revoked', '作业期间发生过遗忘，旧来源候选不落盘');
      }
      const sync = await syncKnownState(scopeKey);
      if (!sync.ok) return fail('unreadable', `范围当前不可读（${sync.issue}）`);

      // candidates 校验（整批原子：一个非法全批拒绝）。
      const entryIds = new Set(sync.state.parsed.entries.map((e) => e.id));
      const preparedCandidates = [];
      for (const candidate of candidates) {
        const title = String(candidate?.title ?? '').trim();
        const body = String(candidate?.body ?? '').trim();
        if (!title) return fail('invalid_input', '候选缺少标题');
        if (countCodePoints(body) > 2000) return fail('invalid_input', `候选正文超过 2000 码点：${title}`);
        if (!['fact', 'feedback', 'experience', 'reference'].includes(candidate?.kind)) {
          return fail('invalid_input', `候选 kind 非法：${candidate?.kind ?? '（空）'}`);
        }
        if (candidate?.action === 'replace') {
          const existingId = String(candidate?.existingEntryId ?? '');
          if (!entryIds.has(existingId)) return fail('invalid_input', `replace 引用的条目不存在：${existingId || '（空）'}`);
          const expected = lease.entries.find((e) => e.id === existingId)?.version;
          const current = sync.state.parsed.entries.find((e) => e.id === existingId);
          if (expected === undefined || current.version !== expected) {
            return fail('conflict', `条目在作业期间被修改：${title}`);
          }
          preparedCandidates.push({ action: 'replace', existingId, expectedVersion: expected, title, body, kind: candidate.kind });
        } else if (candidate?.action === 'add') {
          preparedCandidates.push({ action: 'add', title, body, kind: candidate.kind });
        } else {
          return fail('invalid_input', `候选 action 非法：${candidate?.action ?? '（空）'}`);
        }
      }

      // notes 校验：derivedFromEntryIds 必须指向本域现存条目（关联遗忘的锚点）。
      const preparedNotes = [];
      for (const note of notes) {
        const text = String(note?.text ?? '').trim();
        if (!text) return fail('invalid_input', 'note 缺少正文');
        if (countCodePoints(text) > 2000) return fail('invalid_input', 'note 超过 2000 码点');
        const derived = Array.isArray(note?.derivedFromEntryIds) ? note.derivedFromEntryIds : [];
        if (derived.some((id) => !entryIds.has(id))) {
          return fail('invalid_input', 'note 关联了本域不存在的条目');
        }
        preparedNotes.push({ type: 'note', text, sourceRefs: [], derivedFromEntryIds: derived, createdAt: nowFn() });
      }

      // 组装 after：MEMORY 条目变更 + 今日 daily 追加，一次跨文件提交。
      let memoryAfter = sync.state.text;
      {
        let segments = sync.state.parsed.segments;
        for (const candidate of preparedCandidates) {
          if (candidate.action === 'add') {
            const now = nowFn();
            const entry = {
              id: idFactory(), version: 1, kind: candidate.kind, title: candidate.title, body: candidate.body,
              sourceRefs: [], relatedEntryIds: [], createdAt: now, updatedAt: now,
            };
            segments = [...segments, { type: 'entry', entry }];
          } else {
            const now = nowFn();
            segments = segments.map((s) => (s.type === 'entry' && s.entry.id === candidate.existingId
              ? { type: 'entry', entry: { ...s.entry, title: candidate.title, body: candidate.body, kind: candidate.kind, version: s.entry.version + 1, updatedAt: now } }
              : s));
          }
        }
        memoryAfter = renderManagedDocument(segments);
      }
      const paths = recordFilePaths(scopeKey);
      const files = [{ scopeKey, after: memoryAfter }];
      if (preparedNotes.length) {
        const today = dateString(nowFn());
        const dailyCurrent = await readRecordFile(paths.daily(today));
        if (dailyCurrent.issue) return fail('unreadable', `今日工作记录不可读（${dailyCurrent.issue}）`);
        const parsedDaily = parseRecordDocument(dailyCurrent.text ?? '');
        const newRecords = preparedNotes.map((note) => ({ ...note, recordId: idFactory() }));
        files.push({ scopeKey, relPath: paths.daily(today), after: renderRecordDocument([...parsedDaily.records, ...newRecords]) });
      }
      const controlAfter = cloneControl();
      controlAfter.commitSeq += 1;
      bumpScope(controlAfter, scopeKey);
      const result = await commitTransaction({
        kind: 'extraction',
        files,
        controlAfter,
        undo: null,
      });
      if (result.ok) {
        return ok({
          appliedNotes: preparedNotes.length,
          appliedCandidates: preparedCandidates.length,
        }, { operationId: result.operationId });
      }
      return result;
    });
  }

  return {
    ensureReady,
    listScopes,
    readScope,
    addEntry,
    replaceEntry,
    removeEntry,
    moveEntry,
    clearScope,
    appendWorkingRecord,
    readWorkingRecords,
    updateScratchpad,
    listUndoOperations,
    restoreFromUndo,
    undoMutation,
    scopeInfo,
    allocateSourceSeq,
    captureExtractionLease,
    commitExtraction,
    isCrashAbort: (error) => error instanceof CrashAbort,
  };
}

function scopeFromKey(scopeKey) {
  if (scopeKey === 'global/user') return { kind: 'global', target: 'user' };
  if (scopeKey === 'global/facts') return { kind: 'global', target: 'facts' };
  if (scopeKey?.startsWith('workspace/')) {
    return { kind: 'workspace', workspaceId: scopeKey.slice('workspace/'.length) };
  }
  return null;
}
