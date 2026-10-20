// 037 Phase C 单测：条目级撤销（add/replace/remove/move）、遗忘关联工作记录清理、
// 管理面委派与变更订阅（listEntries/mutateEntry/forgetEntry/clearScope/undoMutation）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryService } from './memory.mjs';

const USER = { kind: 'global', target: 'user' };
const FACTS = { kind: 'global', target: 'facts' };
const WS_A = { kind: 'workspace', workspaceId: 'ws-a' };
const WS_B = { kind: 'workspace', workspaceId: 'ws-b' };

function makeService() {
  const root = mkdtempSync(path.join(tmpdir(), 'hemi-mgmt-'));
  return { root, service: createMemoryService({ memoryDir: path.join(root, 'memory') }) };
}

test('undoMutation(add)：只删该次新增，保留之后对其他条目的修改；CAS 拒旧版本', async () => {
  const { root, service } = makeService();
  try {
    const first = await service.mutateEntry({ scope: WS_A, action: 'add', title: '第一条', body: 'a', kind: 'fact' });
    await service.mutateEntry({ scope: WS_A, action: 'add', title: '第二条', body: 'b', kind: 'fact' });
    const opId = first.operationId;

    const stale = await service.undoMutation({ operationId: opId, expectedAfterVersion: 99 });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'conflict');

    const undone = await service.undoMutation({ operationId: opId, expectedAfterVersion: 1 });
    assert.equal(undone.ok, true, JSON.stringify(undone));
    const list = await service.listEntries({ scope: WS_A });
    assert.deepEqual(list.data.entries.map((e) => e.title), ['第二条'], '只撤销该次新增，第二条保留');

    const again = await service.undoMutation({ operationId: opId, expectedAfterVersion: 1 });
    assert.equal(again.code, 'invalid_input', '重复撤销如实失败');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('undoMutation(replace)：恢复旧正文且版本单调递增；之后无关修改不拦撤销', async () => {
  const { root, service } = makeService();
  try {
    const added = await service.mutateEntry({ scope: FACTS, action: 'add', title: '周报中文', body: '旧约定', kind: 'fact' });
    const replaced = await service.mutateEntry({ scope: FACTS, action: 'replace', entryId: added.data.entry.id, expectedVersion: 1, body: '新约定' });
    // 无关修改：另一条新增。
    await service.mutateEntry({ scope: FACTS, action: 'add', title: '无关条目', body: 'x', kind: 'fact' });

    const undone = await service.undoMutation({ operationId: replaced.operationId, expectedAfterVersion: 2 });
    assert.equal(undone.ok, true, JSON.stringify(undone));
    const list = await service.listEntries({ scope: FACTS, query: '周报中文' });
    const entry = list.data.entries[0];
    assert.equal(entry.body, '旧约定');
    assert.equal(entry.version, 3, '撤销产生新版本，不回退版本号');
    assert.equal((await service.listEntries({ scope: FACTS, query: '无关条目' })).data.total, 1, '无关修改保留');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('undoMutation(remove)：恢复被删条目（新版本）；条目被重存则拒绝自动撤销', async () => {
  const { root, service } = makeService();
  try {
    const added = await service.mutateEntry({ scope: USER, action: 'add', title: '偏好', body: '简短', kind: 'profile' });
    const forgotten = await service.forgetEntry({ scope: USER, entryId: added.data.entry.id, expectedVersion: 1 });
    assert.equal(forgotten.ok, true);

    const undone = await service.undoMutation({ operationId: forgotten.operationId, expectedAfterVersion: undefined });
    assert.equal(undone.ok, true, JSON.stringify(undone));
    const list = await service.listEntries({ scope: USER });
    assert.equal(list.data.entries[0].body, '简短');
    assert.equal(list.data.entries[0].version, 2, '恢复＝新版本');

    // 同一撤销操作再来一次：条目已恢复在场，拒绝重复自动恢复。
    const conflict = await service.undoMutation({ operationId: forgotten.operationId });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'conflict', '重复撤销不再自动恢复');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('undoMutation(move)：把条目移回原范围，双方代次/版本正确', async () => {
  const { root, service } = makeService();
  try {
    const added = await service.mutateEntry({ scope: WS_A, action: 'add', title: '要移动的', body: 'x', kind: 'fact' });
    const moved = await service.moveEntry({ fromScope: WS_A, entryId: added.data.entry.id, expectedVersion: 1, toScope: WS_B });
    assert.equal(moved.ok, true);

    const undone = await service.undoMutation({ operationId: moved.operationId, expectedAfterVersion: 1 });
    assert.equal(undone.ok, true, JSON.stringify(undone));
    const a = await service.listEntries({ scope: WS_A });
    const b = await service.listEntries({ scope: WS_B });
    assert.equal(a.data.total, 1, '回到原范围');
    assert.equal(b.data.total, 0, '目标范围清空');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('forgetEntry 关联清理：derivedFromEntryIds 指向该条的工作记录块同事务删除，未关联的保留（R-09）', async () => {
  const { root, service } = makeService();
  try {
    const client = service.bindTaskClient({ workspaceId: 'ws-a', mode: 'run' });
    const entry = await client.addEntry({ title: '构建并发经验', body: '4 并发', kind: 'experience' });
    await client.appendWorkingRecord({ type: 'note', text: '构建并发经验的补充观察', derivedFromEntryIds: [entry.data.entry.id] });
    await client.appendWorkingRecord({ type: 'todo', text: '无关待办' });

    const forgotten = await service.forgetEntry({ scope: WS_A, entryId: entry.data.entry.id, expectedVersion: 1 });
    assert.equal(forgotten.ok, true);
    assert.deepEqual(forgotten.data.removedRecordIds.length, 1, '关联记录块被清理');
    const records = await client.readWorkingRecords();
    const padTexts = (records.data.scratchpad.records ?? []).map((r) => r.text);
    const dailyTexts = (records.data.daily ?? []).flatMap((d) => d.records.map((r) => r.text));
    assert.ok(dailyTexts.every((t) => !t.includes('构建并发经验')), '关联 daily 块已删');
    assert.ok(padTexts.includes('无关待办'), '无关待办保留');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listEntries：分页/搜索/范围校验；查看其他域不改变绑定（管理面只读列表）', async () => {
  const { root, service } = makeService();
  try {
    for (let i = 0; i < 5; i += 1) {
      await service.mutateEntry({ scope: WS_A, action: 'add', title: `条目 ${i}`, body: `内容 ${i}`, kind: 'fact' });
    }
    const page1 = await service.listEntries({ scope: WS_A, limit: 3 });
    assert.equal(page1.data.entries.length, 3);
    assert.equal(page1.data.total, 5);
    assert.equal(page1.data.nextCursor, 3);
    const page2 = await service.listEntries({ scope: WS_A, cursor: 3, limit: 3 });
    assert.equal(page2.data.entries.length, 2);
    assert.equal(page2.data.nextCursor, null);

    const search = await service.listEntries({ scope: WS_A, query: '内容 3' });
    assert.deepEqual(search.data.entries.map((e) => e.title), ['条目 3']);

    const denied = await service.listEntries({ scope: { kind: 'workspace', workspaceId: '../escape' } });
    assert.equal(denied.code, 'scope_denied');
    const deniedGlobal = await service.listEntries({ scope: { kind: 'global', target: 'other' } });
    assert.equal(deniedGlobal.code, 'scope_denied');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('subscribeChanges：持久提交成功才广播（含范围与 operationId），失败不广播', async () => {
  const { root, service } = makeService();
  try {
    const events = [];
    const unsubscribe = service.subscribeChanges((info) => events.push(info));
    const ok1 = await service.mutateEntry({ scope: WS_A, action: 'add', title: '广播这条', body: 'x', kind: 'fact' });
    const failed = await service.mutateEntry({ scope: WS_A, action: 'replace', entryId: 'mem-missing', expectedVersion: 1, body: 'y' });
    assert.equal(failed.ok, false);
    assert.equal(events.length, 1, '只有成功提交广播');
    assert.equal(events[0].scopeKey, 'workspace/ws-a');
    assert.equal(events[0].operationId, ok1.operationId);
    assert.equal(events[0].entrySummary, '广播这条');
    assert.ok(typeof events[0].revision === 'number');
    unsubscribe();
    await service.mutateEntry({ scope: WS_A, action: 'add', title: '退订后', body: 'x', kind: 'fact' });
    assert.equal(events.length, 1, '退订后不再收到');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clearScope 管理面：必须带 expectedRevision，其他范围不受影响', async () => {
  const { root, service } = makeService();
  try {
    await service.mutateEntry({ scope: WS_A, action: 'add', title: 'A 的条目', body: 'x', kind: 'fact' });
    await service.mutateEntry({ scope: WS_B, action: 'add', title: 'B 的条目', body: 'y', kind: 'fact' });
    const missing = await service.clearScope({ scope: WS_A });
    assert.equal(missing.code, 'invalid_input', '缺 expectedRevision 拒绝');
    const list = await service.listEntries({ scope: WS_A });
    const cleared = await service.clearScope({ scope: WS_A, expectedRevision: list.data.revision });
    assert.equal(cleared.ok, true);
    const after = await service.listEntries({ scope: WS_A });
    assert.equal(after.data.total, 0);
    assert.equal((await service.listEntries({ scope: WS_B })).data.total, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
