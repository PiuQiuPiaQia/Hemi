// 037 Phase A 单测：分域存储的提交队列、跨文件提交日志、崩溃恢复、外部编辑保护、loose 解析。
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryStore } from './memory-store.mjs';

const USER = { kind: 'global', target: 'user' };
const FACTS = { kind: 'global', target: 'facts' };
const WS_A = { kind: 'workspace', workspaceId: 'ws-a' };
const WS_DEFAULT = { kind: 'workspace', workspaceId: 'default' };

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), 'hemi-memstore-'));
}

function makeStore(root, options = {}) {
  return createMemoryStore({ memoryDir: path.join(root, 'memory'), ...options });
}

test('全新目录初始化：空文件 + control（无迁移簿记）', async () => {
  const root = makeRoot();
  try {
    const store = makeStore(root);
    const gate = await store.ensureReady();
    assert.equal(gate.ok, true);
    assert.equal(readFileSync(path.join(root, 'memory', 'USER.md'), 'utf8'), '');
    assert.equal(readFileSync(path.join(root, 'memory', 'MEMORY.md'), 'utf8'), '');
    const control = JSON.parse(readFileSync(path.join(root, 'memory', 'control.json'), 'utf8'));
    assert.equal(control.schemaVersion, 2);
    assert.equal('migration' in control, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('目录里已有未包裹正文：原文保留、按 loose 分 profile/unsorted，不做备份迁移', async () => {
  const root = makeRoot();
  try {
    const memoryDir = path.join(root, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(path.join(memoryDir, 'USER.md'), '称呼：小张\n喜欢简短回答\n', 'utf8');
    writeFileSync(path.join(memoryDir, 'MEMORY.md'), '周报都用中文\n某项目用英文\n', 'utf8');
    const store = makeStore(root);
    const gate = await store.ensureReady();
    assert.equal(gate.ok, true);

    const user = await store.readScope(USER);
    assert.equal(user.data.entries.length, 0);
    assert.equal(user.data.loose.kind, 'profile');
    assert.ok(user.data.loose.segments[0].text.includes('喜欢简短回答'));
    const facts = await store.readScope(FACTS);
    assert.equal(facts.data.loose.kind, 'unsorted');
    assert.ok(facts.data.loose.segments[0].text.includes('周报都用中文'));

    // 原文逐字保留在原位；没有 legacy/ 备份目录。
    assert.equal(readFileSync(path.join(memoryDir, 'USER.md'), 'utf8'), '称呼：小张\n喜欢简短回答\n');
    assert.equal(existsSync(path.join(memoryDir, 'legacy')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('addEntry：管理块落盘、读取回放、撤销载荷写入、loose 保留', async () => {
  const root = makeRoot();
  try {
    const memoryDir = path.join(root, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(path.join(memoryDir, 'USER.md'), '称呼：小张\n', 'utf8');
    const store = makeStore(root);
    await store.ensureReady();

    const added = await store.addEntry({ scope: USER, title: '回答简短', body: '以后回答保持简短。', kind: 'profile' });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.match(added.operationId, /^op-/);
    assert.equal(added.data.entry.version, 1);

    const fileText = readFileSync(path.join(memoryDir, 'USER.md'), 'utf8');
    assert.ok(fileText.includes('称呼：小张'), '旧 loose 原文保留');
    assert.ok(fileText.includes('<!-- hemi-entry '));
    assert.ok(fileText.includes('## 回答简短'));

    const read = await store.readScope(USER);
    assert.equal(read.data.entries.length, 1);
    assert.equal(read.data.entries[0].title, '回答简短');
    assert.equal(read.data.entries[0].kind, 'profile');
    assert.equal(read.data.revision, 1);

    const undoFile = path.join(memoryDir, 'undo', `${added.operationId}.json`);
    assert.ok(existsSync(undoFile), '撤销载荷落盘');
    const undo = JSON.parse(readFileSync(undoFile, 'utf8'));
    assert.equal(undo.operationKind, 'addEntry');
    assert.ok(undo.files[0].before.includes('称呼：小张'));
    assert.equal(existsSync(path.join(memoryDir, 'transaction', 'current.json')), false, '提交日志已清理');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('replaceEntry/removeEntry：expectedVersion CAS、版本与代次推进', async () => {
  const root = makeRoot();
  try {
    const store = makeStore(root);
    await store.ensureReady();
    const added = await store.addEntry({ scope: FACTS, title: '全局周报中文', body: '所有周报用中文。', kind: 'fact' });
    const entryId = added.data.entry.id;

    const stale = await store.replaceEntry({ scope: FACTS, entryId, expectedVersion: 99, body: 'x' });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'conflict');
    assert.equal(stale.current.version, 1);

    const replaced = await store.replaceEntry({ scope: FACTS, entryId, expectedVersion: 1, body: '所有周报默认中文。' });
    assert.equal(replaced.ok, true);
    assert.equal(replaced.data.entry.version, 2);

    const before = await store.readScope(FACTS);
    const removed = await store.removeEntry({ scope: FACTS, entryId, expectedVersion: 2 });
    assert.equal(removed.ok, true);
    const after = await store.readScope(FACTS);
    assert.equal(after.data.entries.length, 0);
    assert.equal(after.data.epoch, before.data.epoch + 1, '删除推进遗忘代次');
    assert.equal(after.data.revision, before.data.revision + 1);

    const missing = await store.removeEntry({ scope: FACTS, entryId, expectedVersion: 2 });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'invalid_input');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('moveEntry：跨文件一次提交、原位置不留副本、双域 revision 推进（跨文件提交门）', async () => {
  const root = makeRoot();
  try {
    const store = makeStore(root);
    await store.ensureReady();
    const added = await store.addEntry({ scope: FACTS, title: 'Hemi 项目英文周报', body: '仅本项目。', kind: 'feedback' });
    const entryId = added.data.entry.id;
    const factsBefore = await store.readScope(FACTS);

    const moved = await store.moveEntry({ fromScope: FACTS, entryId, expectedVersion: 1, toScope: WS_A });
    assert.equal(moved.ok, true, JSON.stringify(moved));

    const facts = await store.readScope(FACTS);
    assert.equal(facts.data.entries.length, 0);
    assert.equal(facts.data.epoch, factsBefore.data.epoch + 1);
    const ws = await store.readScope(WS_A);
    assert.equal(ws.data.entries.length, 1);
    assert.equal(ws.data.entries[0].id, entryId);
    assert.equal(ws.data.entries[0].version, 1, '移动不改内容版本');

    const scopes = await store.listScopes();
    assert.ok(scopes.data.scopeKeys.includes('workspace/ws-a'));
    assert.equal(existsSync(path.join(root, 'memory', 'workspaces', 'ws-a', 'MEMORY.md')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clearScope：expectedRevision CAS、清空后文件为空、其他范围不受影响', async () => {
  const root = makeRoot();
  try {
    const store = makeStore(root);
    await store.ensureReady();
    await store.addEntry({ scope: WS_DEFAULT, title: '默认空间经验', body: '流程 XYZ。', kind: 'experience' });
    await store.addEntry({ scope: FACTS, title: '全局事实', body: '保留我。', kind: 'fact' });
    const target = await store.readScope(WS_DEFAULT);

    const stale = await store.clearScope({ scope: WS_DEFAULT, expectedRevision: 0 });
    assert.equal(stale.code, 'conflict');
    const cleared = await store.clearScope({ scope: WS_DEFAULT, expectedRevision: target.data.revision });
    assert.equal(cleared.ok, true);
    const after = await store.readScope(WS_DEFAULT);
    assert.equal(after.data.entries.length, 0);
    assert.equal(readFileSync(path.join(root, 'memory', 'workspaces', 'default', 'MEMORY.md'), 'utf8'), '');

    const facts = await store.readScope(FACTS);
    assert.equal(facts.data.entries.length, 1, '其他范围保留');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('外部编辑：改正文→版本递增；外部删除→代次推进；CAS 撞上外部编辑返回当前版本', async () => {
  const root = makeRoot();
  try {
    const memoryDir = path.join(root, 'memory');
    const store = makeStore(root);
    await store.ensureReady();
    const added = await store.addEntry({ scope: USER, title: '偏好A', body: '原文。', kind: 'profile' });
    const entryId = added.data.entry.id;

    // 模拟外部 Markdown 编辑：id 保留、正文修改。
    const text = readFileSync(path.join(memoryDir, 'USER.md'), 'utf8');
    writeFileSync(path.join(memoryDir, 'USER.md'), text.replace('原文。', '外部改过的正文。'), 'utf8');
    const edited = await store.readScope(USER);
    const entry = edited.data.entries.find((e) => e.id === entryId);
    assert.equal(entry.body, '外部改过的正文。');
    assert.equal(entry.version, 2, 'id 保留则递增版本');

    // 旧 expectedVersion（1）撞上外部编辑后的版本（2）：冲突并附当前内容。
    const clash = await store.replaceEntry({ scope: USER, entryId, expectedVersion: 1, body: '再改' });
    assert.equal(clash.ok, false);
    assert.equal(clash.code, 'conflict');
    assert.equal(clash.current.version, 2);

    // 外部直接删除条目块＝与 UI 删除相同的代次推进。
    const epochBefore = edited.data.epoch;
    writeFileSync(path.join(memoryDir, 'USER.md'), '', 'utf8');
    const emptied = await store.readScope(USER);
    assert.equal(emptied.data.entries.length, 0);
    assert.equal(emptied.data.epoch, epochBefore + 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('崩溃恢复：transaction 写入后中止 → 重开补齐提交并清理日志（撤销载荷一并落盘）', async () => {
  const root = makeRoot();
  try {
    const crashing = makeStore(root, { crashHook: (step) => step === 'transaction-written' });
    await crashing.ensureReady();
    let crashed = null;
    try {
      await crashing.addEntry({ scope: FACTS, title: '崩溃前条目', body: '内容。', kind: 'fact' });
    } catch (error) {
      crashed = error;
    }
    assert.ok(crashing.isCrashAbort(crashed), '在 transaction 写入后中止');

    const reopened = makeStore(root);
    const gate = await reopened.ensureReady();
    assert.equal(gate.ok, true);
    assert.deepEqual(gate.data.recoveryConflicts, []);
    const read = await reopened.readScope(FACTS);
    assert.equal(read.data.entries[0].title, '崩溃前条目');
    assert.equal(existsSync(path.join(root, 'memory', 'transaction', 'current.json')), false);
    const control = JSON.parse(readFileSync(path.join(root, 'memory', 'control.json'), 'utf8'));
    assert.equal(control.commitSeq, 1, '恢复后控制文件已推进');
    const undoFiles = readdirSync(path.join(root, 'memory', 'undo'));
    assert.equal(undoFiles.length, 1, '恢复时从提交日志补写撤销载荷');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('崩溃恢复：moveEntry 首个文件已 rename 后中止 → 重开完成剩余文件与 control', async () => {
  const root = makeRoot();
  try {
    // 同一实例先种入条目（钩子未武装），再武装崩溃点做移动——
    // 两个实例同目录操作会违反单所有者不变式，第二实例即外部写入者。
    let armed = false;
    const store = makeStore(root, { crashHook: (step) => armed && step === 'file-committed:0' });
    await store.ensureReady();
    const added = await store.addEntry({ scope: FACTS, title: '待移动', body: 'x', kind: 'fact' });
    armed = true;
    let crashed = null;
    try {
      await store.moveEntry({ fromScope: FACTS, entryId: added.data.entry.id, expectedVersion: 1, toScope: WS_A });
    } catch (error) {
      crashed = error;
    }
    assert.ok(store.isCrashAbort(crashed));

    const reopened = makeStore(root);
    const gate = await reopened.ensureReady();
    assert.equal(gate.ok, true);
    assert.deepEqual(gate.data.recoveryConflicts, []);
    const facts = await reopened.readScope(FACTS);
    const ws = await reopened.readScope(WS_A);
    assert.equal(facts.data.entries.length, 0, '原位置不留副本');
    assert.equal(ws.data.entries.length, 1, '目标位置补齐');
    assert.equal(existsSync(path.join(root, 'memory', 'transaction', 'current.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('崩溃恢复：control.json 落盘后、日志清理前中止 → 重开识别已完成并清日志（fsync 注入点 3）', async () => {
  const root = makeRoot();
  try {
    // 提炼型跨文件提交（MEMORY+daily 双文件）：中断在最后一个数据文件提交后
    // （control 在 commitTransaction 内最后写、current.json 最后删——
    // 此点之后 crash 意味着 control 已含本次提交、日志仍在）。
    let armed = false;
    const store = makeStore(root, { crashHook: (step) => armed && step === 'file-committed:1' });
    await store.ensureReady();
    const client = makeStore(root);
    void client;
    armed = true;
    let crashed = null;
    try {
      await store.appendWorkingRecord({ scope: WS_DEFAULT, text: '中断前的工作记录', type: 'note' });
    } catch (error) {
      crashed = error;
    }
    assert.ok(store.isCrashAbort(crashed));

    const reopened = makeStore(root);
    const gate = await reopened.ensureReady();
    assert.equal(gate.ok, true);
    assert.deepEqual(gate.data.recoveryConflicts, [], '磁盘已等于 after：跳过而非冲突');
    const records = await reopened.readWorkingRecords({ scope: WS_DEFAULT });
    const texts = (records.data.daily ?? []).flatMap((d) => d.records.map((r) => r.text));
    assert.ok(texts.includes('中断前的工作记录'), '数据文件已完成提交，内容保留');
    assert.equal(existsSync(path.join(root, 'memory', 'transaction', 'current.json')), false, '重开时日志已清理');
    const control = JSON.parse(readFileSync(path.join(root, 'memory', 'control.json'), 'utf8'));
    assert.equal(control.commitSeq, 1, 'control 已推进且只推进一次（恢复幂等）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('崩溃恢复不覆盖外部改动：第三种内容 → 封闭该范围、文件保持外部内容（Phase A 门）', async () => {
  const root = makeRoot();
  try {
    const memoryDir = path.join(root, 'memory');
    const crashing = makeStore(root, { crashHook: (step) => step === 'transaction-written' });
    await crashing.ensureReady();
    try {
      await crashing.addEntry({ scope: USER, title: '被中断的写入', body: 'x', kind: 'profile' });
    } catch { /* 预期中止 */ }
    // 崩溃后、恢复前：外部编辑把目标文件改成第三种内容。
    writeFileSync(path.join(memoryDir, 'USER.md'), '外部编辑的内容，不属于 before/after\n', 'utf8');

    const reopened = makeStore(root);
    const gate = await reopened.ensureReady();
    assert.equal(gate.ok, true);
    assert.equal(gate.data.recoveryConflicts.length, 1);
    assert.equal(gate.data.recoveryConflicts[0].file, 'USER.md');
    assert.equal(readFileSync(path.join(memoryDir, 'USER.md'), 'utf8'), '外部编辑的内容，不属于 before/after\n', '不得覆盖外部编辑');

    // 该范围封闭：读写都拒绝；其他范围照常。
    const denied = await reopened.addEntry({ scope: USER, title: 't', body: 'b' });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'storage_error');
    const factsOk = await reopened.addEntry({ scope: FACTS, title: '其他范围', body: 'ok' });
    assert.equal(factsOk.ok, true);
    // 冲突日志归档留检（current.json 槽位释放，不阻塞其他范围提交）。
    const txDir = path.join(memoryDir, 'transaction');
    assert.equal(existsSync(path.join(txDir, 'current.json')), false);
    assert.equal(readdirSync(txDir).some((f) => f.startsWith('conflicted-')), true, '冲突日志归档保留');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('容量与范围防护：超限拒绝写入、非法 scope/symlink 拒绝', async () => {
  const root = makeRoot();
  try {
    const memoryDir = path.join(root, 'memory');
    const store = makeStore(root);
    await store.ensureReady();
    const over = await store.addEntry({ scope: FACTS, title: '超限', body: '字'.repeat(2001), kind: 'fact' });
    assert.equal(over.ok, false);
    assert.equal(over.code, 'capacity_exceeded');
    assert.equal(readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8'), '', '原文不变');

    const badScope = await store.addEntry({ scope: { kind: 'workspace', workspaceId: '../escape' }, title: 't', body: 'b' });
    assert.equal(badScope.code, 'scope_denied');

    // 符号链接逃逸：workspaces/evil 指向外部目录。
    const outside = path.join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    mkdirSync(path.join(memoryDir, 'workspaces'), { recursive: true });
    symlinkSync(outside, path.join(memoryDir, 'workspaces', 'evil'));
    const evil = await store.readScope({ kind: 'workspace', workspaceId: 'evil' });
    assert.equal(evil.ok, false);
    assert.equal(evil.code, 'unreadable');
    const evilWrite = await store.addEntry({ scope: { kind: 'workspace', workspaceId: 'evil' }, title: 't', body: 'b' });
    assert.equal(evilWrite.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('control.json 损坏：ready 失败并如实报告 storage_error', async () => {
  const root = makeRoot();
  try {
    const store = makeStore(root);
    await store.ensureReady();
    writeFileSync(path.join(root, 'memory', 'control.json'), '{oops', 'utf8');
    const reopened = makeStore(root);
    const gate = await reopened.ensureReady();
    assert.equal(gate.ok, false);
    assert.equal(gate.code, 'storage_error');
    const denied = await reopened.addEntry({ scope: FACTS, title: 't', body: 'b' });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'storage_error');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
