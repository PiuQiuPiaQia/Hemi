// 037 C-3 单测：对话侧分域写入 chatMemoryWrite（R-01/02/03/08）。
// 覆盖范围映射（user/global/workspace，未绑定落默认空间）、条目化 add、replace/remove 唯一匹配、
// 歧义拒绝、来源校验、广播带 origin/conversationId。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryService } from './memory.mjs';

function makeService() {
  const root = mkdtempSync(path.join(tmpdir(), 'hemi-chatw-'));
  const service = createMemoryService({ memoryDir: path.join(root, 'memory') });
  const events = [];
  service.subscribeChanges((info) => events.push(info));
  return { root, service, events };
}

test('add：target 映射三域＋未绑定落默认空间；广播带 origin/conversationId', async () => {
  const { root, service, events } = makeService();
  try {
    const a = await service.chatMemoryWrite({ workspaceId: 'ws-a', conversationId: 'conv-1', action: 'add', target: 'workspace', text: '周报使用英文\n交付文档统一英文。', reason: 'explicit' });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.scopeLabel, '项目 ws-a');
    assert.match(a.operationId, /^op-/);

    const b = await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'add', target: 'user', text: '喜欢简短回答', reason: 'stable_fact' });
    assert.equal(b.scopeLabel, '关于你');
    const c = await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'add', target: 'global', text: '周报都用中文', reason: 'explicit' });
    assert.equal(c.scopeLabel, '全局约定');
    const d = await service.chatMemoryWrite({ workspaceId: null, action: 'add', target: 'workspace', text: '未绑定会话的约定', reason: 'explicit' });
    assert.equal(d.scopeLabel, '默认空间');

    const wsView = await service.buildView({ workspaceId: 'ws-a' });
    assert.match(wsView.data.text, /周报使用英文/);
    assert.doesNotMatch(wsView.data.text, /未绑定会话的约定/, '默认空间不串入具名工作区');
    const defaultView = await service.buildView({ workspaceId: null });
    assert.match(defaultView.data.text, /未绑定会话的约定/);

    const chatEvents = events.filter((e) => e.origin === 'chat');
    assert.ok(chatEvents.length >= 4);
    assert.equal(chatEvents[0].conversationId, 'conv-1');
    assert.equal(chatEvents[0].action, 'add');
    assert.equal(chatEvents[0].title, '周报使用英文');
    assert.equal(chatEvents[0].scopeKey, 'workspace/ws-a');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('replace/remove：目标范围内唯一匹配才动；多匹配拒绝附候选；不跨域误伤', async () => {
  const { root, service } = makeService();
  try {
    await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'add', target: 'workspace', text: '周报使用英文', reason: 'explicit' });
    await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'add', target: 'workspace', text: '周报抄送名单', reason: 'explicit' });
    await service.chatMemoryWrite({ workspaceId: 'ws-b', action: 'add', target: 'workspace', text: '周报使用英文', reason: 'explicit' });

    const multi = await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'remove', target: 'workspace', oldText: '周报', reason: 'explicit' });
    assert.equal(multi.ok, false);
    assert.equal(multi.code, 'conflict');
    assert.equal(multi.candidates.length, 2, '候选只来自目标范围');

    const removed = await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'remove', target: 'workspace', oldText: '周报使用英文', reason: 'explicit' });
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, '周报使用英文');
    const bView = await service.buildView({ workspaceId: 'ws-b' });
    assert.match(bView.data.text, /周报使用英文/, 'ws-b 同名条目不受影响（AC-09）');

    const replaced = await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'replace', target: 'workspace', oldText: '周报抄送名单', text: '周报抄送运维组', reason: 'explicit' });
    assert.equal(replaced.ok, true);
    const aView = await service.buildView({ workspaceId: 'ws-a' });
    assert.match(aView.data.text, /周报抄送运维组/);
    assert.doesNotMatch(aView.data.text, /周报抄送名单/);

    const missing = await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'remove', target: 'workspace', oldText: '不存在的条目', reason: 'explicit' });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /没有找到匹配的条目/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('来源与参数校验：reason 非法/target 非法/空文本拒绝；signal 取消不写', async () => {
  const { root, service } = makeService();
  try {
    const badReason = await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'add', target: 'workspace', text: 'x', reason: 'because' });
    assert.equal(badReason.ok, false);
    const badTarget = await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'add', target: 'memory', text: 'x', reason: 'explicit' });
    assert.equal(badTarget.ok, false);
    assert.match(badTarget.error, /user（关于你）/);
    const empty = await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'add', target: 'workspace', text: '  ', reason: 'explicit' });
    assert.equal(empty.ok, false);

    const controller = new AbortController();
    controller.abort();
    const canceled = await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'add', target: 'workspace', text: 'x', reason: 'explicit', signal: controller.signal });
    assert.equal(canceled.ok, false);
    assert.equal(canceled.canceled, true);

    const view = await service.buildView({ workspaceId: 'ws-a' });
    assert.doesNotMatch(view.data.text, /未命名/, '全部拒绝后无写入');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
