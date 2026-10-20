import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposerDraft } from './composer-draft.ts';

test('060 受理清提交版本，整轮结果与新草稿无关；重复／迟到受理不丢新内容', () => {
  const draft = createComposerDraft();
  draft.setText('任务 A');
  const sent = draft.getSnapshot();
  assert.equal(draft.accept(sent.revision), true);
  assert.equal(draft.getSnapshot().text, '');
  draft.setText('未发送的新草稿');
  assert.equal(draft.accept(sent.revision), false);
  assert.equal(draft.getSnapshot().text, '未发送的新草稿');
  const next = draft.getSnapshot();
  draft.setText('修改后');
  draft.setText(next.text);
  assert.equal(draft.accept(next.revision), false, '改回同文仍是新版本');
});

test('060 拒绝不清内容；编辑附件或引用也使旧提交回执失效', () => {
  const draft = createComposerDraft();
  draft.setText('A');
  const sent = draft.getSnapshot();
  draft.setAttachments([{ attachmentId: 'new', name: '新附件' }]);
  draft.setReferences([{ key: 'new-ref', kind: 'context', contextId: 'ctx' }]);
  assert.equal(draft.accept(sent.revision), false);
  assert.equal(draft.getSnapshot().text, 'A');
  assert.equal(draft.getSnapshot().attachments.length, 1);
  assert.equal(draft.getSnapshot().references.length, 1);
});

test('060 队列编辑复用输入框但保留原草稿、附件和引用；退出恢复原稿且版本递增', () => {
  const draft = createComposerDraft();
  draft.setText('未发送的原稿');
  draft.setAttachments([{ attachmentId: 'original' }]);
  draft.setReferences([{ key: 'original-ref' }]);
  const old = draft.getSnapshot();
  assert.equal(draft.beginQueueEdit({ text: '队列消息', attachments: [], references: [] }), true);
  draft.setText('队列消息已修改');
  assert.equal(draft.getPersistentSnapshot().text, '未发送的原稿');
  assert.equal(draft.beginQueueEdit({ text: '另一条', attachments: [], references: [] }), false);
  draft.endQueueEdit();
  assert.equal(draft.getSnapshot().text, old.text);
  assert.deepEqual(draft.getSnapshot().attachments, old.attachments);
  assert.deepEqual(draft.getSnapshot().references, old.references);
  assert.ok(draft.getSnapshot().revision > old.revision);
  assert.equal(draft.accept(old.revision), false);
});

test('060 文字恢复版本不受附件清理影响；真实打字、编辑层切换和受理仍使旧文字恢复失效', () => {
  const draft = createComposerDraft();
  const loadingVersion = draft.getTextRevision();
  draft.setAttachments([]);
  draft.setReferences([]);
  assert.equal(draft.getTextRevision(), loadingVersion);
  draft.setText('用户刚输入');
  assert.notEqual(draft.getTextRevision(), loadingVersion);
  const beforeEdit = draft.getTextRevision();
  draft.beginQueueEdit({ text: '队列消息', attachments: [], references: [] });
  draft.endQueueEdit();
  assert.ok(draft.getTextRevision() > beforeEdit);
});
