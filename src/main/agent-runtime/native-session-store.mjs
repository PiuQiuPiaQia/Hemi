import { mkdir, readFile, writeFile, rename, readdir, lstat, rm, chmod, open as openFile, appendFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { isNativeSessionReference, nativeSessionReference } from './session-reference.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const referencePattern = /^(session|main)-[A-Za-z0-9_-]{1,100}$/;
const queues = new Map();
function serialize(dir, operation) {
  const current = (queues.get(dir) ?? Promise.resolve()).then(operation);
  const settled = current.then(() => {}, () => {});
  queues.set(dir, settled);
  void settled.then(() => { if (queues.get(dir) === settled) queues.delete(dir); });
  return current;
}
const exists = file => lstat(file).then(info => info, error => { if (error.code === 'ENOENT') return null; throw error; });
async function privateDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await lstat(dir)).isDirectory()) throw new Error('会话目录不可用或含符号链接');
}
async function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(tmp, file); }
  finally { await rm(tmp, { force: true }).catch(() => {}); }
}
function validateRef(ref) {
  if (typeof ref !== 'string' || !referencePattern.test(ref)) throw new Error('会话引用无效');
  return ref;
}
function businessRecord(record) {
  if (!record?.owner?.conversationId) throw new Error('会话缺少对话归属');
  const result = {};
  for (const key of ['owner', 'role', 'workspace', 'sessionRef', 'worklineId', 'roleRevision', 'runCount', 'contextRefs', 'modelPlan']) if (record[key] !== undefined) result[key] = record[key];
  return JSON.parse(JSON.stringify(result, (key, value) => key === 'apiKey' ? undefined : value));
}
function checkOwner(record, conversationId) {
  if (record.owner?.conversationId !== conversationId) throw new Error('会话引用不属于当前对话');
}
function validateEntries(payload) {
  const { header, entries } = payload ?? {};
  if (header?.type !== 'session' || typeof header.id !== 'string' || !header.id || typeof header.cwd !== 'string'
    || typeof header.timestamp !== 'string' || !Array.isArray(entries)) throw new Error('旧会话条目损坏');
  if ((header.version ?? 1) < 2) return;
  const ids = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)
      || (entry.parentId !== null && !ids.has(entry.parentId))) throw new Error('旧会话条目链损坏');
    ids.add(entry.id);
  }
}

/** Pi owns mutable transcript JSONL files. Hemi only owns identity/policy metadata.
 * Legacy sources stay intact; imports activate after verification by the real SDK.
 */
export function createSessionStore({ dir, log }) {
  dir = path.resolve(dir);
  const nativeDir = path.join(dir, 'pi'), metadataDir = path.join(dir, 'metadata'), issued = new Map();
  const metadataPath = ref => path.join(metadataDir, `${validateRef(ref)}.json`);
  const nativePath = native => {
    if (!native || typeof native.file !== 'string' || !/^[A-Za-z0-9_.-]+\.jsonl$/.test(native.file)
      || path.basename(native.file) !== native.file || typeof native.sessionId !== 'string' || !native.sessionId) throw new Error('原生会话引用损坏');
    return path.join(nativeDir, native.file);
  };
  async function readMetadata(ref) {
    const file = metadataPath(ref), info = await exists(file);
    if (!info) return null;
    if (!info.isFile()) throw new Error('会话业务索引不可用');
    const record = JSON.parse(await readFile(file, 'utf8'));
    if (record.version !== 3 || record.ref !== ref) throw new Error('会话业务索引损坏');
    nativePath(record.native); businessRecord(record);
    return record;
  }
  async function openNative(native, cwd) {
    const file = nativePath(native), info = await lstat(file);
    if (!info.isFile() || !info.size) throw new Error('原生会话文件不可用');
    // Pi skips malformed JSONL records. Never silently lose history or replace
    // a damaged/missing transcript with an empty session during host recovery.
    const stream = createReadStream(file), lines = createInterface({ input: stream, crlfDelay: Infinity });
    let header = null, count = 0;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (!header) {
          if (entry.type !== 'session' || entry.id !== native.sessionId) throw new Error('原生会话身份不匹配');
          header = entry;
        } else count++;
      }
    } finally { lines.close(); stream.destroy(); }
    if (!header) throw new Error('原生会话头缺失');
    // A complete last record may have lost only its final newline at shutdown.
    // Preserve that record and restore the separator before Pi appends again.
    const tail = Buffer.alloc(1), handle = await openFile(file, 'r');
    try { await handle.read(tail, 0, 1, info.size - 1); } finally { await handle.close(); }
    if (tail[0] !== 10) await appendFile(file, '\n');
    const manager = SessionManager.open(file, nativeDir, cwd);
    if (manager.getSessionId() !== native.sessionId || manager.getEntryCount() !== count) throw new Error('原生会话恢复校验失败');
    issued.set(native.file, native.sessionId);
    return manager;
  }
  function descriptor(ref, manager, replaces = null) {
    const native = { file: path.basename(manager.getSessionFile()), sessionId: manager.getSessionId() };
    nativePath(native); issued.set(native.file, native.sessionId);
    return { ...nativeSessionReference(ref), native, replaces };
  }
  async function publish(ref, checkpoint, record, migration) {
    const clean = businessRecord(record), current = await readMetadata(ref);
    clean.sessionRef = ref;
    if (checkpoint.ref !== ref) throw new Error('会话保存引用不匹配');
    const file = nativePath(checkpoint.native);
    if (issued.get(checkpoint.native.file) !== checkpoint.native.sessionId) throw new Error('会话保存身份未核验');
    if (current) {
      checkOwner(current, clean.owner.conversationId);
      if ((current.owner.generation ?? 0) > (clean.owner.generation ?? 0)) throw new Error('对话已回卷，旧会话不能写回');
      if (current.native.file !== checkpoint.native.file && current.native.file !== checkpoint.replaces) throw new Error('会话已被新版本替换');
    }
    const info = await lstat(file);
    if (!info.isFile() || !info.size) throw new Error('原生会话文件不可用');
    await chmod(file, 0o600);
    const next = { version: 3, ref, ...clean, native: checkpoint.native,
      ...(migration ?? current?.migration ? { migration: migration ?? current.migration } : {}) };
    await atomicJson(metadataPath(ref), next);
    return next;
  }
  async function importPayload(ref, payload) {
    validateEntries(payload);
    const sourceDigest = hash(payload), fileName = `import-${hash(ref).slice(0, 16)}-${sourceDigest}.jsonl`;
    const target = path.join(nativeDir, fileName), copy = structuredClone(payload);
    // Memory mode is only Pi's legacy normalizer during this one-time import.
    const normalized = SessionManager.inMemory(copy.header.cwd, undefined, [copy.header, ...copy.entries]);
    const expected = { header: normalized.getHeader(), entries: normalized.getEntries() };
    const native = { file: fileName, sessionId: normalized.getSessionId() };
    if (!await exists(target)) {
      const stage = path.join(nativeDir, `.import-${randomUUID()}`);
      await privateDirectory(stage);
      try {
        const stagedFile = path.join(stage, fileName);
        // One-time format conversion; all subsequent appends belong to Pi.
        await writeFile(stagedFile, [expected.header, ...expected.entries].map(entry => JSON.stringify(entry) + '\n').join(''), { mode: 0o600, flag: 'wx' });
        const verified = SessionManager.open(stagedFile, stage, expected.header.cwd);
        if (hash({ header: verified.getHeader(), entries: verified.getEntries() }) !== hash(expected)) throw new Error('旧会话迁移校验失败');
        await rename(stagedFile, target);
      } finally { await rm(stage, { recursive: true, force: true }); }
    }
    const manager = await openNative(native, expected.header.cwd);
    if (hash(manager.getEntries().slice(0, expected.entries.length)) !== hash(expected.entries)) throw new Error('旧会话迁移目标内容冲突');
    return { manager, sourceDigest };
  }
  async function migrateLegacy(ref) {
    if (await readMetadata(ref)) return;
    const pointer = path.join(dir, `${validateRef(ref)}.json`), info = await exists(pointer);
    if (!info) return;
    if (!info.isFile()) throw new Error('旧会话索引不可用');
    const { revision } = JSON.parse(await readFile(pointer, 'utf8'));
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('旧会话版本损坏');
    const source = path.join(dir, `entries-${revision}.json`);
    if (!(await lstat(source)).isFile()) throw new Error('旧会话快照不可用');
    const record = JSON.parse(await readFile(source, 'utf8'));
    if (hash(record) !== revision) throw new Error('旧会话条目损坏');
    const { manager, sourceDigest } = await importPayload(ref, record.payload);
    await publish(ref, descriptor(ref, manager), record, { source: 'snapshot', revision, sourceDigest });
  }
  const ready = serialize(dir, async () => {
    await privateDirectory(dir); await privateDirectory(nativeDir); await privateDirectory(metadataDir);
    // No committed reference can point into a staging directory. Reclaim an
    // interrupted import before retrying, under the host's single-writer lock.
    for (const file of await readdir(nativeDir, { withFileTypes: true })) {
      if (file.isDirectory() && /^\.import-[a-f0-9-]{36}$/.test(file.name)) await rm(path.join(nativeDir, file.name), { recursive: true, force: true });
    }
    for (const file of await readdir(dir)) if (/^(session|main)-[A-Za-z0-9_-]{1,100}\.json$/.test(file)) await migrateLegacy(file.slice(0, -5));
  });
  void ready.catch(error => log?.warn?.(`旧会话迁移暂停，原存档已保留：${error.message}`));
  return {
    ready: () => ready,
    flush: () => serialize(dir, () => {}),
    async load(ref, conversationId) {
      validateRef(ref); await ready;
      return serialize(dir, async () => {
        const record = await readMetadata(ref);
        if (!record) throw new Error('会话业务索引不存在');
        checkOwner(record, conversationId); await openNative(record.native, record.workspace?.dir);
        return record;
      });
    },
    async open(ref, { cwd, record, source, entries = null, reset = false }) {
      validateRef(ref); await ready;
      return serialize(dir, async () => {
        const clean = businessRecord(record), current = await readMetadata(ref);
        if (current) checkOwner(current, clean.owner.conversationId);
        if (isNativeSessionReference(source) && source.ref !== ref) throw new Error('恢复会话引用不匹配');
        let manager, migration;
        const payload = Array.isArray(source?.entries) ? source : entries?.length ? { header: entries[0], entries: entries.slice(1) } : null;
        if (isNativeSessionReference(source)) {
          if (!current) throw new Error('原生会话业务索引缺失');
          if (!source.rewindBeforeInputId && (current.owner.generation ?? 0) !== (clean.owner.generation ?? 0)) throw new Error('对话已回卷，旧会话不能恢复执行');
          manager = await openNative(current.native, cwd);
          if (source.rewindBeforeInputId) {
            const anchor = manager.getEntries().find(entry => entry.type === 'custom' && entry.customType === 'hemi.input' && entry.data?.inputId === source.rewindBeforeInputId);
            if (anchor) {
              if (anchor.parentId) manager.branch(anchor.parentId); else manager.resetLeaf();
              manager.appendCustomEntry('hemi.rewind', { inputId: source.rewindBeforeInputId, generation: clean.owner.generation ?? 0 });
            } else if (payload) ({ manager } = await importPayload(ref, payload));
            else manager = SessionManager.create(cwd, nativeDir);
          }
        } else if (payload) {
          if (current && !reset && (current.owner.generation ?? 0) === (clean.owner.generation ?? 0)) {
            const existing = await openNative(current.native, cwd);
            if (hash(existing.getEntries().slice(0, payload.entries.length)) === hash(payload.entries)) manager = existing;
          }
          if (!manager) {
            const imported = await importPayload(ref, payload); manager = imported.manager;
            const backupDir = path.join(dir, 'legacy-archives'); await privateDirectory(backupDir);
            const backup = path.join(backupDir, `${ref}-${imported.sourceDigest}.json`);
            const backupInfo = await exists(backup);
            if (backupInfo && !backupInfo.isFile()) throw new Error('旧会话备份不可用');
            if (!backupInfo) await atomicJson(backup, payload);
            migration = { source: 'archive', sourceDigest: imported.sourceDigest };
          }
        } else if (current && !reset) {
          if ((current.owner.generation ?? 0) !== (clean.owner.generation ?? 0)) throw new Error('对话已回卷，旧会话不能恢复执行');
          manager = await openNative(current.native, cwd);
        } else manager = SessionManager.create(cwd, nativeDir);
        const checkpoint = descriptor(ref, manager, current?.native.file ?? null);
        if (await exists(nativePath(checkpoint.native))) await publish(ref, checkpoint, clean, migration);
        return { manager, checkpoint };
      });
    },
    async checkpoint(checkpoint, record) {
      if (!isNativeSessionReference(checkpoint)) throw new Error('需要 Pi 原生会话引用');
      await ready;
      return serialize(dir, () => publish(checkpoint.ref, checkpoint, record));
    },
  };
}
