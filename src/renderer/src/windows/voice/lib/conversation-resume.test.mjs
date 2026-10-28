import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationResume, DRAFT_NEW_KEY } from './conversation-resume.ts';

function fixture() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const old = { id: 'conv-old', turns: ['已发送任务'] };
  const selected = { id: 'conv-selected', turns: ['另一会话'] };
  const calls = [];
  const bridge = {
    async getLastConversation() { calls.push('last'); return old; },
    async openConversation(id) { calls.push(id); if (id === selected.id) return selected; throw Error('已删除'); },
  };
  return { storage, bridge, calls, old, selected };
}

test('旧版本无视图标记时仍继续最近会话', async () => {
  const f = fixture();
  assert.equal(await createConversationResume(f.storage).restore(f.bridge), f.old);
});

test('新建后重启恢复 draft-new，而不是最近已发送会话及其草稿', async () => {
  const f = fixture();
  const resume = createConversationResume(f.storage);
  resume.remember(f.old.id);
  resume.remember(DRAFT_NEW_KEY);
  // 重建实例模拟窗口重启，草稿内容不参与身份选择。
  assert.equal(await createConversationResume(f.storage).restore(f.bridge), null);
  assert.deepEqual(f.calls, [], '新建态不得加载旧会话');
});

test('打开历史会话或新建后首次发送，重启按所选身份恢复，不按后台更新时间抢占', async () => {
  const f = fixture();
  const resume = createConversationResume(f.storage);
  resume.remember(DRAFT_NEW_KEY);
  resume.remember(f.selected.id);
  assert.equal(await createConversationResume(f.storage).restore(f.bridge), f.selected);
  assert.deepEqual(f.calls, [f.selected.id]);
});

test('删除当前会话回到新建态；过期或损坏标记回落旧版行为', async () => {
  const f = fixture();
  const resume = createConversationResume(f.storage);
  resume.remember('conv-deleted');
  assert.equal(await resume.restore(f.bridge), f.old);
  resume.remember('invalid');
  assert.equal(await resume.restore(f.bridge), f.old);
  resume.remember(DRAFT_NEW_KEY);
  assert.equal(await createConversationResume(f.storage).restore(f.bridge), null);
});
