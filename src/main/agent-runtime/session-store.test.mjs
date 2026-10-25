import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createSessionStore } from './session-store.mjs';
import { nativeSessionReference } from './session-reference.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const metadata = (generation = 1, conversationId = 'c') => ({ owner: { conversationId, rootRunId: 'root', generation },
  role: 'oracle', workspace: null, sessionRef: 'session-test', roleRevision: 'role-v1', worklineId: 'workline-one',
  runCount: 2, contextRefs: ['ctx-one'], modelPlan: { primary: { modelKey: 'model', apiKey: 'never store me' }, allowedFallbacks: [] } });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hemi-native-store-')), dir = path.join(root, 'sessions');
  await mkdir(dir);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, dir };
}
function payload(cwd, text = 'original private context') {
  const manager = SessionManager.inMemory(cwd);
  manager.appendCustomEntry('hemi.input', { inputId: 'first' });
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 });
  return { header: manager.getHeader(), entries: manager.getEntries() };
}
async function legacy(dir, ref, value, record = metadata()) {
  const data = { version: 2, ...record, payload: value }, revision = hash(data);
  const file = path.join(dir, `entries-${revision}.json`), pointer = path.join(dir, `${ref}.json`);
  await writeFile(file, JSON.stringify(data)); await writeFile(pointer, JSON.stringify({ revision }));
  return { file, pointer, data, revision };
}
const fileOf = (dir, opened) => path.join(dir, 'pi', opened.checkpoint.native.file);

test('旧快照无损迁移为 Pi 原生会话，原件保留且 Hemi 只存业务字段和恢复校验', async t => {
  const { dir, root } = await fixture(t), value = payload(root), source = await legacy(dir, 'session-test', value);
  const original = await readFile(source.file), pointer = await readFile(source.pointer);
  const store = createSessionStore({ dir }); await store.ready();
  const record = await store.load('session-test', 'c');
  assert.equal(record.version, 3); assert.equal(record.payload, undefined);
  assert.equal(record.roleRevision, 'role-v1'); assert.deepEqual(record.contextRefs, ['ctx-one']);
  assert.equal(JSON.stringify(record).includes('never store me'), false);
  const opened = await store.open('session-test', { cwd: root, record: metadata(), source: nativeSessionReference('session-test') });
  assert.equal(opened.manager.isPersisted(), true);
  assert.deepEqual(opened.manager.getEntries(), value.entries);
  assert.deepEqual(await readFile(source.file), original); assert.deepEqual(await readFile(source.pointer), pointer);
  await assert.rejects(store.load('session-test', 'another'), /当前对话/);
  await assert.rejects(store.load('../../escape', 'c'), /引用无效/);
});

test('原生追加和多次检查点不会复制整份条目，独立进程仍能恢复当前上下文', async t => {
  const { dir, root } = await fixture(t), store = createSessionStore({ dir });
  const opened = await store.open('session-test', { cwd: root, record: metadata() });
  opened.manager.appendMessage({ role: 'user', content: 'persist this context', timestamp: 1 });
  await store.checkpoint(opened.checkpoint, metadata());
  const file = fileOf(dir, opened), first = await readFile(file), before = await stat(file);
  for (let i = 0; i < 30; i++) await store.checkpoint(opened.checkpoint, { ...metadata(), runCount: i });
  assert.deepEqual(await readFile(file), first); assert.equal((await stat(file)).ino, before.ino);
  opened.manager.appendMessage({ role: 'user', content: 'later message', timestamp: 2 });
  await store.checkpoint(opened.checkpoint, metadata());
  assert.ok((await readFile(file)).subarray(0, first.length).equals(first));
  assert.equal((await readdir(path.join(dir, 'pi'))).filter(n => n.endsWith('.jsonl')).length, 1);
  assert.equal((await readdir(dir)).some(n => n.startsWith('entries-')), false);
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import {createSessionStore} from ${JSON.stringify(new URL('./session-store.mjs', import.meta.url).href)};
    const store=createSessionStore({dir:${JSON.stringify(dir)}});
    const opened=await store.open('session-test',{cwd:${JSON.stringify(root)},record:${JSON.stringify(metadata())}});
    console.log(JSON.stringify(opened.manager.buildSessionContext().messages));
  `]);
  assert.match(stdout, /persist this context/); assert.match(stdout, /later message/);
});

test('内嵌聊天条目只导入一次，滞后的旧档不会覆盖同代次中较新的原生上下文', async t => {
  const { dir, root } = await fixture(t), store = createSessionStore({ dir }), value = payload(root);
  const opened = await store.open('main-current', { cwd: root, record: metadata(), source: value });
  opened.manager.appendMessage({ role: 'user', content: 'newer than archive', timestamp: 3 });
  await store.checkpoint(opened.checkpoint, metadata());
  const restarted = createSessionStore({ dir });
  const resumed = await restarted.open('main-current', { cwd: root, record: metadata(), source: value });
  assert.match(JSON.stringify(resumed.manager.buildSessionContext()), /newer than archive/);
  assert.equal(resumed.checkpoint.native.file, opened.checkpoint.native.file);
  assert.equal((await readdir(path.join(dir, 'legacy-archives'))).length, 1);
  const stored = JSON.parse(await readFile(path.join(dir, 'metadata/main-current.json')));
  assert.equal(stored.payload, undefined); assert.equal(stored.entries, undefined);
});

test('迁移激活前中断可以重试，不重复建文件、不丢后续条目、不修改旧快照', async t => {
  const { dir, root } = await fixture(t), value = payload(root), source = await legacy(dir, 'session-test', value);
  const store = createSessionStore({ dir }); await store.ready();
  const opened = await store.open('session-test', { cwd: root, record: metadata() });
  opened.manager.appendMessage({ role: 'user', content: 'completed append before crash', timestamp: 2 });
  await rm(path.join(dir, 'metadata/session-test.json'));
  const interrupted = path.join(dir, 'pi', `.import-${randomUUID()}`);
  await mkdir(interrupted); await writeFile(path.join(interrupted, 'partial.jsonl'), 'partial import');
  const retried = createSessionStore({ dir }); await retried.ready();
  const restored = await retried.open('session-test', { cwd: root, record: metadata() });
  assert.match(JSON.stringify(restored.manager.getEntries()), /completed append before crash/);
  assert.equal((await readdir(path.join(dir, 'pi'))).filter(n => n.endsWith('.jsonl')).length, 1);
  assert.equal(hash(JSON.parse(await readFile(source.file, 'utf8'))), source.revision);
  await assert.rejects(stat(interrupted), { code: 'ENOENT' });
});

test('共享旧快照导入为相互隔离的可写 Pi 文件', async t => {
  const { dir, root } = await fixture(t), value = payload(root);
  await legacy(dir, 'session-one', value); await legacy(dir, 'session-two', value);
  const store = createSessionStore({ dir }); await store.ready();
  const first = await store.open('session-one', { cwd: root, record: metadata() });
  const second = await store.open('session-two', { cwd: root, record: metadata() });
  assert.notEqual(first.checkpoint.native.file, second.checkpoint.native.file);
  first.manager.appendMessage({ role: 'user', content: 'only first session', timestamp: 3 });
  assert.doesNotMatch(await readFile(fileOf(dir, second), 'utf8'), /only first session/);
});

test('回卷由 Pi 分支处理，重启后不会复活被撤回的输入，也拒绝旧代次写回', async t => {
  const { dir, root } = await fixture(t), store = createSessionStore({ dir });
  const opened = await store.open('main-current', { cwd: root, record: metadata(), source: payload(root, 'keep first') });
  opened.manager.appendCustomEntry('hemi.input', { inputId: 'second' });
  opened.manager.appendMessage({ role: 'user', content: 'remove this input', timestamp: 2 });
  await store.checkpoint(opened.checkpoint, metadata());
  const rewritten = await store.open('main-current', { cwd: root, record: metadata(2), source: { ...nativeSessionReference('main-current'), rewindBeforeInputId: 'second' } });
  rewritten.manager.appendMessage({ role: 'user', content: 'replacement input', timestamp: 3 });
  await store.checkpoint(rewritten.checkpoint, metadata(2));
  await assert.rejects(store.checkpoint(opened.checkpoint, metadata()), /回卷/);
  const restored = await createSessionStore({ dir }).open('main-current', { cwd: root, record: metadata(2), source: nativeSessionReference('main-current') });
  const messages = JSON.stringify(restored.manager.buildSessionContext().messages);
  assert.match(messages, /keep first/); assert.match(messages, /replacement input/); assert.doesNotMatch(messages, /remove this input/);
});

test('无锚点回卷按保留的历史重建，旧摘要不能进入新代次', async t => {
  const { dir, root } = await fixture(t), store = createSessionStore({ dir });
  const opened = await store.open('main-current', { cwd: root, record: metadata(), source: payload(root, 'obsolete summary') });
  await store.checkpoint(opened.checkpoint, metadata());
  const retained = payload(root, 'retained visible history');
  const reset = await store.open('main-current', { cwd: root, record: metadata(2), source: { ...nativeSessionReference('main-current'), rewindBeforeInputId: 'missing' }, entries: [retained.header, ...retained.entries] });
  assert.match(JSON.stringify(reset.manager.buildSessionContext()), /retained visible history/);
  assert.doesNotMatch(JSON.stringify(reset.manager.buildSessionContext()), /obsolete summary/);
  await assert.rejects(store.checkpoint(opened.checkpoint, metadata()), /回卷/);
});

test('损坏旧索引、校验失败或断裂条目链不会激活空会话或改写原件', async t => {
  for (const kind of ['index', 'checksum', 'chain']) await t.test(kind, async t => {
    const { dir, root } = await fixture(t), value = payload(root);
    if (kind === 'chain') value.entries[1].parentId = 'missing-parent';
    const source = await legacy(dir, 'session-test', value);
    if (kind === 'index') await writeFile(source.pointer, '{');
    if (kind === 'checksum') await writeFile(source.file, JSON.stringify({ ...source.data, role: 'changed' }));
    const original = await readFile(source.file), pointer = await readFile(source.pointer);
    const store = createSessionStore({ dir }); await assert.rejects(store.ready());
    assert.deepEqual(await readFile(source.file), original); assert.deepEqual(await readFile(source.pointer), pointer);
    assert.deepEqual(await readdir(path.join(dir, 'metadata')), []);
  });
});

test('损坏、缺失或越界的原生文件必须报错，不能静默创建新会话', async t => {
  for (const kind of ['missing', 'corrupt-line', 'wrong-id', 'escape']) await t.test(kind, async t => {
    const { dir, root } = await fixture(t), store = createSessionStore({ dir });
    const opened = await store.open('main-current', { cwd: root, record: metadata(), source: payload(root) });
    const file = fileOf(dir, opened), metaFile = path.join(dir, 'metadata/main-current.json');
    if (kind === 'missing') await rm(file);
    if (kind === 'corrupt-line') await writeFile(file, (await readFile(file, 'utf8')) + '{invalid\n');
    if (kind === 'wrong-id' || kind === 'escape') {
      const record = JSON.parse(await readFile(metaFile, 'utf8'));
      if (kind === 'wrong-id') record.native.sessionId = 'wrong'; else record.native.file = '../outside.jsonl';
      await writeFile(metaFile, JSON.stringify(record));
    }
    const before = await readFile(metaFile);
    await assert.rejects(createSessionStore({ dir }).open('main-current', { cwd: root, record: metadata(), source: nativeSessionReference('main-current') }));
    assert.deepEqual(await readFile(metaFile), before);
  });
});

test('不同所有者、代次与非法引用不能复用会话，失败后合法操作仍可继续', async t => {
  const { dir, root } = await fixture(t), store = createSessionStore({ dir });
  const opened = await store.open('main-current', { cwd: root, record: metadata(), source: payload(root) });
  await assert.rejects(store.open('main-current', { cwd: root, record: metadata(1, 'another'), source: nativeSessionReference('main-current') }), /当前对话/);
  await assert.rejects(store.open('main-current', { cwd: root, record: metadata(2), source: nativeSessionReference('main-current') }), /回卷/);
  await assert.rejects(store.open('../../escape', { cwd: root, record: metadata() }), /引用无效/);
  await store.checkpoint(opened.checkpoint, metadata());
  assert.equal((await store.load('main-current', 'c')).roleRevision, 'role-v1');
});

test('最后一条完整 JSON 缺换行时保留内容并恢复分隔符，后续 SDK 追加仍能再次恢复', async t => {
  const { dir, root } = await fixture(t), store = createSessionStore({ dir });
  const opened = await store.open('main-current', { cwd: root, record: metadata(), source: payload(root) });
  const file = fileOf(dir, opened), original = await readFile(file, 'utf8');
  await writeFile(file, original.trimEnd());
  const resumed = await createSessionStore({ dir }).open('main-current', { cwd: root, record: metadata(), source: nativeSessionReference('main-current') });
  resumed.manager.appendMessage({ role: 'user', content: 'after missing separator', timestamp: 4 });
  const next = await createSessionStore({ dir }).open('main-current', { cwd: root, record: metadata(), source: nativeSessionReference('main-current') });
  assert.match(JSON.stringify(next.manager.buildSessionContext()), /original private context/);
  assert.match(JSON.stringify(next.manager.buildSessionContext()), /after missing separator/);
});
