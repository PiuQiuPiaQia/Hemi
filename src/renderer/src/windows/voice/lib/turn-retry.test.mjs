import assert from 'node:assert/strict';
import test from 'node:test';
import { retryInput } from './turn-retry.ts';

const user = (id, text, runId = 'failed', extra = {}) => ({ id, text, author: 'user', createdAt: 1, inputSource: 'text', flow: { runId }, ...extra });
const failure = (runId = 'failed') => ({ id: 'error', text: 'Connection error.', author: 'hemi', kind: 'error', createdAt: 2, flow: { runId } });

test('navigation/restart: retry is reconstructed from persisted conversation inputs alone', () => {
  const input = user('original', '继续发版');
  const result = retryInput([input, failure()], null);
  assert.equal(result.text, '继续发版');
  assert.equal(result.inputSource, 'text');
  assert.deepEqual(result.attachmentIds, []);
});

test('attachment-only failures retain original attachment IDs, references, skills and voice source', () => {
  const attachment = { attachmentId: 'image', conversationId: 'this-conversation' };
  const reference = { key: 'file:/source', kind: 'file', name: '资料', refPath: '/source' };
  const skill = { token: '/检查', skillId: 'check', name: '检查' };
  const input = user('original', '', 'failed', { inputSource: 'voice', attachments: [attachment], references: [reference], skills: [skill] });
  const result = retryInput([input, failure()], { timeline: [{ kind: 'user', id: 'original', attachmentIds: ['image', 'document-without-view'] }] });
  assert.equal(result.inputSource, 'voice');
  assert.deepEqual(result.attachmentIds, ['image', 'document-without-view']);
  assert.deepEqual(result.attachmentViews, [attachment]);
  assert.deepEqual(result.references, [reference]);
  assert.deepEqual(result.skills, [skill]);
});

test('merged inputs are recovered together; previous successful runs cannot leak attachments', () => {
  const result = retryInput([
    user('old', '旧任务', 'completed', { attachments: [{ attachmentId: 'other-image' }] }),
    user('first', '检查这个文件', 'failed', { attachments: [{ attachmentId: 'file' }] }),
    user('merged', '先不要提交', 'failed'), failure(),
  ], null);
  assert.equal(result.text, '检查这个文件\n\n先不要提交');
  assert.deepEqual(result.attachmentIds, ['file']);
});

test('orphaned failures cannot retry a different run; new messages supersede old retry actions', () => {
  assert.equal(retryInput([user('other', '其他任务', 'other'), failure()], null), null);
  assert.equal(retryInput([user('original', '任务'), failure(), user('new', '新问题', 'new')], null), null);
  assert.equal(retryInput([], null), null);
});

test('legacy error archives without flow identity can still retry the nearest original message', () => {
  const result = retryInput([user('original', '历史问题'), { ...failure(), flow: undefined }], null);
  assert.equal(result.text, '历史问题');
});
