// 037 Phase B 单测：分域请求视图与绑定客户端（buildView/bindTaskClient）。
// 覆盖阶段门：A/B 并行互不串扰、default、未绑定落默认空间、预算省略、模式只读。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryService } from './memory.mjs';

function makeService() {
  const root = mkdtempSync(path.join(tmpdir(), 'hemi-view-'));
  return { root, service: createMemoryService({ memoryDir: path.join(root, 'memory') }) };
}

test('buildView 分域：A/B 并行各读各的＋全局；default 独立；互不串扰（阶段门）', async () => {
  const { root, service } = makeService();
  try {
    await service.buildView({ workspaceId: 'default' }); // 触发 store 初始化
    const a = service.bindTaskClient({ workspaceId: 'ws-a', mode: 'run' });
    const b = service.bindTaskClient({ workspaceId: 'ws-b', mode: 'run' });
    await a.addEntry({ title: 'A 项目英文周报', body: 'x', kind: 'feedback' });
    await b.addEntry({ title: 'B 项目中文周报', body: 'y', kind: 'feedback' });
    const viewA = await a.buildView();
    const viewB = await b.buildView();
    assert.match(viewA.data.text, /A 项目英文周报/);
    assert.doesNotMatch(viewA.data.text, /B 项目中文周报/);
    assert.match(viewB.data.text, /B 项目中文周报/);
    assert.doesNotMatch(viewB.data.text, /A 项目英文周报/);
    // lease 只含全局与本域，不含其他工作区。
    assert.deepEqual(Object.keys(viewA.data.lease.scopes).sort(), ['global/facts', 'global/user', 'workspace/ws-a']);

    const d = service.bindTaskClient({ workspaceId: 'default', mode: 'run' });
    const viewD = await d.buildView();
    assert.doesNotMatch(viewD.data.text, /A 项目英文周报/, 'default 不是共享记忆池');
    void root;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildView：未绑定落默认空间域；MEMORY 待整理内容不进任何视图（R-12）', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hemi-view-loose-'));
  try {
    const memoryDir = path.join(root, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(path.join(memoryDir, 'USER.md'), '称呼：小张', 'utf8');
    writeFileSync(path.join(memoryDir, 'MEMORY.md'), '旧全局约定：周报都用中文', 'utf8');
    const service = createMemoryService({ memoryDir });

    const unbound = service.bindTaskClient({ workspaceId: null, mode: 'run' });
    const unboundView = await unbound.buildView();
    assert.match(unboundView.data.text, /称呼：小张/, '个人资料全局生效');
    assert.doesNotMatch(unboundView.data.text, /旧全局约定/, '待整理内容不进任何视图');
    assert.equal(unboundView.data.lease.domain, 'workspace/default', '未绑定落默认空间域');
    assert.equal('legacy' in unboundView.data.lease, false);

    const bound = service.bindTaskClient({ workspaceId: 'ws-new', mode: 'run' });
    const boundView = await bound.buildView();
    assert.match(boundView.data.text, /称呼：小张/, '个人资料全局生效');
    assert.doesNotMatch(boundView.data.text, /旧全局约定/, '待整理内容不无条件送入所有项目');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildView 预算：超预算整条省略并计数，不静默截断', async () => {
  const { root, service } = makeService();
  try {
    await service.buildView({ workspaceId: 'default' });
    const client = service.bindTaskClient({ workspaceId: 'default', mode: 'run' });
    for (let i = 0; i < 30; i += 1) {
      await client.addEntry({ title: `条目 ${i}`, body: '内容'.repeat(400), kind: 'fact' });
    }
    const view = await client.buildView();
    assert.ok(view.data.omittedCount > 0, '应省略超预算条目');
    assert.match(view.data.text, /条目 0/);
    assert.ok(!view.data.text.includes(`条目 ${29}`) || view.data.omittedCount > 0);
    assert.ok(view.data.codepoints <= 17000, '总投影不超预算');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bindTaskClient 模式：run 可写本域；verify 只读（写全部拒绝）', async () => {
  const { root, service } = makeService();
  try {
    await service.buildView({ workspaceId: 'ws-a' });
    const run = service.bindTaskClient({ workspaceId: 'ws-a', mode: 'run' });
    const verify = service.bindTaskClient({ workspaceId: 'ws-a', mode: 'verify' });
    const okWrite = await run.addEntry({ title: 't', body: 'b', kind: 'fact' });
    assert.equal(okWrite.ok, true);
    const denied = await verify.addEntry({ title: 't', body: 'b', kind: 'fact' });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'scope_denied');
    const deniedRecord = await verify.appendWorkingRecord({ text: 'x' });
    assert.equal(deniedRecord.code, 'scope_denied');
    const deniedRemove = await verify.removeEntry({ entryId: okWrite.data.entry.id, expectedVersion: 1 });
    assert.equal(deniedRemove.code, 'scope_denied');
    const readOk = await verify.buildView();
    assert.equal(readOk.ok, true, '只读客户端可读');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bindTaskClient 写域冻结：模型侧无法借工具参数改写到别的域', async () => {
  const { root, service } = makeService();
  try {
    await service.buildView({ workspaceId: 'ws-a' });
    const client = service.bindTaskClient({ workspaceId: 'ws-a', mode: 'run' });
    // 尝试用 scope 覆盖写到 ws-b：addEntry 不接受 scope 覆盖（只认绑定域）。
    const sneaky = await client.addEntry({ title: '越界', body: 'x', kind: 'fact', scope: { kind: 'workspace', workspaceId: 'ws-b' } });
    assert.equal(sneaky.ok, true);
    const bView = await service.buildView({ workspaceId: 'ws-b' });
    assert.doesNotMatch(bView.data.text, /越界/, '写入只能落绑定域');
    const aView = await service.buildView({ workspaceId: 'ws-a' });
    assert.match(aView.data.text, /越界/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
