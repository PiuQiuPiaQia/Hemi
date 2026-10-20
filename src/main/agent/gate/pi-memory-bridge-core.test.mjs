// 037 Phase B 单测：记忆桥核心（工具面、每请求投影、过期视图改写、降级拒绝）。
// 直接驱动 createMemoryBridgeCore，不建 Pi 会话（SDK 层行为由探针与 pi-session 测试覆盖）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryService } from '../../services/memory.mjs';
import { createMemoryBridgeCore, projectMessages, VIEW_TAG_RE } from './pi-memory-bridge-core.mjs';

function textOf(result) {
  return (result?.content ?? []).map((c) => c.text ?? '').join('\n');
}

function makeSetup({ workspaceId = null, mode = 'run' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'hemi-bridgecore-'));
  const service = createMemoryService({ memoryDir: path.join(root, 'memory') });
  const client = service.bindTaskClient({ workspaceId, mode });
  const core = createMemoryBridgeCore({ client, log: null });
  return { root, service, client, core };
}

test('memory_read：对话侧写入后主动读取本域最新内容与代次', async () => {
  const { root, service, core } = makeSetup({ workspaceId: 'ws-a' });
  try {
    const write = await service.chatMemoryWrite({ workspaceId: 'ws-a', target: 'workspace', action: 'add', reason: 'explicit', text: '周报使用英文\n交付文档统一英文。' });
    assert.equal(write.ok, true);
    const read = await core.tools.memory_read.execute('t2', {});
    const text = textOf(read);
    assert.match(text, VIEW_TAG_RE);
    assert.match(text, /周报使用英文/);
    assert.match(text, /工作区记忆（项目 ws-a）/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('旧桥清理后只暴露 read/search；只读客户端仍拒绝底层写入', async () => {
  const { root, client, core } = makeSetup({ workspaceId: 'ws-a', mode: 'verify' });
  try {
    assert.deepEqual(Object.keys(core.tools).sort(), ['memory_read', 'memory_search']);
    const write = await client.addEntry({ title: 'x', body: '', kind: 'fact' });
    assert.equal(write.ok, false);
    assert.match(write.message, /只读/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('memory_read：宿主工作记录与便签仍可主动读取，底层管理保留', async () => {
  const { root, client, core } = makeSetup({ workspaceId: 'default' });
  try {
    await client.appendWorkingRecord({ type: 'note', text: '发现构建脚本需要先装依赖。' });
    await client.appendWorkingRecord({ type: 'todo', text: '回头核对版本号' });
    const list = await core.tools.memory_read.execute('t3', {});
    assert.match(textOf(list), /回头核对版本号/);
    const view = await client.buildView();
    assert.match(view.data.text, /工作区便签/);
    assert.match(view.data.text, /回头核对版本号/);
    const checked = await client.updateScratchpad({ action: 'check', text: '回头核对' });
    assert.equal(checked.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('memory_read：遗忘后显式重读推进代次，新结果不会再次被误判过期', async () => {
  const { root, client, core } = makeSetup({ workspaceId: 'ws-a' });
  try {
    const added = await client.addEntry({ title: '周报使用英文', body: 'a', kind: 'fact' });
    await core.projectRequest([]);
    const before = client.viewEpoch;
    await client.removeEntry({ entryId: added.data.entry.id, expectedVersion: 1 });
    const read = await core.tools.memory_read.execute('t1', {});
    assert.ok(client.viewEpoch > before);
    assert.doesNotMatch(textOf(read), /周报使用英文/);
    const projected = await core.projectRequest([{ role: 'toolResult', content: read.content }]);
    assert.equal(textOf(projected.messages[0]), textOf(read));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('memory_read：投影瞬时失败后可主动重读；持续失败明确返回工具错误', async () => {
  const { root, client, core } = makeSetup({ workspaceId: 'ws-a' });
  try {
    await client.addEntry({ title: '恢复后有效的记忆', body: 'x', kind: 'fact' });
    const build = client.buildView;
    client.buildView = async () => ({ ok: false, message: '注入读取故障' });
    const degraded = await core.projectRequest([]);
    assert.match(degraded.messages.at(-1).sections.hemi_memory, /当前不可用/);
    const failed = await core.tools.memory_read.execute('f', {});
    assert.equal(failed.isError, true);
    client.buildView = build;
    const recovered = await core.tools.memory_read.execute('r', {});
    assert.match(textOf(recovered), /恢复后有效的记忆/);
    assert.equal(client.degraded, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('memory_search：keyword 命中跨允许范围并带范围标签；semantic 未装 qmd 如实拒绝', async () => {
  const { root, client, core } = makeSetup({ workspaceId: 'ws-a' });
  try {
    await client.addEntry({ title: '构建并发数', body: '本机 4 并发。', kind: 'experience' });
    const hit = await core.tools.memory_search.execute('t1', { query: '并发' });
    assert.match(textOf(hit), /构建并发数/);
    const semantic = await core.tools.memory_search.execute('t2', { query: 'x', mode: 'semantic' });
    assert.match(textOf(semantic), /qmd/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('projectRequest：返回 { messages } 契约形状；末尾注入视图段（SDK 裸数组会被丢弃）', async () => {
  const { root, client, core } = makeSetup({ workspaceId: 'ws-a' });
  try {
    await client.addEntry({ title: '偏好A', body: 'x', kind: 'fact' });
    const result = await core.projectRequest([{ role: 'system', content: 'p', timestamp: 1 }, { role: 'user', content: 'hi', timestamp: 2 }]);
    assert.ok(Array.isArray(result.messages), '必须是 { messages } 对象形状');
    const last = result.messages.at(-1);
    assert.equal(last.role, 'system');
    assert.ok(last.sections?.hemi_memory?.includes('偏好A'));
    assert.equal(result.messages[0].content, 'p', '原 system 不动');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('projectRequest：遗忘后旧 memory_read 结果被改写为重读提示（工具边界失效）', async () => {
  const { root, client, core } = makeSetup({ workspaceId: 'ws-a' });
  try {
    const added = await client.addEntry({ title: '将要被忘记的事', body: 'x', kind: 'fact' });
    const first = await core.projectRequest([{ role: 'system', content: 'p', timestamp: 1 }]);
    const epochAfterFirst = client.viewEpoch;
    const readResult = await core.tools.memory_read.execute('t1', {});
    const tagged = textOf(readResult);
    assert.match(tagged, VIEW_TAG_RE);

    // 遗忘 → 代次推进 → 下一次投影改写过期读取结果。
    await client.removeEntry({ entryId: added.data.entry.id, expectedVersion: 1 });
    const messages = [
      { role: 'system', content: 'p', timestamp: 1 },
      { role: 'assistant', content: '', toolCalls: [], timestamp: 2 },
      { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: tagged }], timestamp: 3 },
    ];
    const second = await core.projectRequest(messages);
    assert.ok(client.viewEpoch > epochAfterFirst, '代次推进');
    const rewritten = second.messages.find((m) => m.role === 'toolResult');
    assert.match(rewritten.content[0].text, /已更新/);
    assert.doesNotMatch(rewritten.content[0].text, /将要被忘记的事/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('projectMessages（纯函数）：无标记/新代次结果不动，只改过期标记', () => {
  const messages = [
    { role: 'system', content: 'p', timestamp: 1 },
    { role: 'toolResult', toolCallId: 'a', content: [{ type: 'text', text: '［记忆视图 #1］\n旧内容' }], timestamp: 2 },
    { role: 'toolResult', toolCallId: 'b', content: [{ type: 'text', text: '［记忆视图 #3］\n新内容' }], timestamp: 3 },
    { role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: '普通工具结果' }], timestamp: 4 },
  ];
  const out = projectMessages(messages, '视图文本', 3);
  assert.match(out[1].content[0].text, /已更新/);
  assert.equal(out[2].content[0].text, '［记忆视图 #3］\n新内容');
  assert.equal(out[3].content[0].text, '普通工具结果');
  assert.equal(out.at(-1).sections.hemi_memory, '视图文本');
});
