import assert from 'node:assert/strict';
import test from 'node:test';
import { canSendText, hasPendingSpeech, recordFinal, shouldAutoSpeak, shouldWaitForSpeech } from './turn-input.ts';

test('late final revisions update their own history entry instead of adding a turn', () => {
  let history = recordFinal([], '你好啊', 's1:0').history;
  history = [...history, { author: 'hemi', text: '你好' }];
  history = recordFinal(history, '今天天气', 's1:2000').history;
  const revision = recordFinal(history, '你好啊，Hemi。', 's1:0');
  assert.equal(revision.index, 0);
  assert.equal(revision.history.length, 3);
  assert.equal(revision.history[2].text, '今天天气');
  assert.equal(recordFinal(revision.history, '你好啊，Hemi。', 's1:0').changed, false);
  assert.equal(recordFinal(revision.history, '你好', 's2:0').history.length, 4);
});

test('a final waits for real ongoing speech but cannot be held forever by background energy', () => {
  assert.equal(shouldWaitForSpeech(true, '', 1200), true);
  assert.equal(shouldWaitForSpeech(false, '还有半句', 1200), true);
  assert.equal(shouldWaitForSpeech(true, '', 6000), false);
  assert.equal(shouldWaitForSpeech(false, '未再更新的临时文本', 6000), false);
  assert.equal(shouldWaitForSpeech(false, '', 1200), false);
});

// ---- 024 文字输入：来源静音判定与发送守卫 ----

test('024 shouldAutoSpeak：文字来源静音，语音与旧数据（缺省）照常', () => {
  assert.equal(shouldAutoSpeak('text'), false);
  assert.equal(shouldAutoSpeak('voice'), true);
  assert.equal(shouldAutoSpeak(undefined), true);
  assert.equal(shouldAutoSpeak(null), true);
});

test('024 hasPendingSpeech：按住录音／临时稿／定稿未提交三态，连续通话不算', () => {
  const idle = { holdActive: false, interim: '', unsubmittedUserCount: 0 };
  assert.equal(hasPendingSpeech(idle), false, '空闲可发');
  assert.equal(hasPendingSpeech({ ...idle, holdActive: true }), true, '按住录音禁发');
  assert.equal(hasPendingSpeech({ ...idle, interim: '正在说的半句' }), true, 'ASR 临时稿禁发');
  assert.equal(hasPendingSpeech({ ...idle, interim: '   ' }), false, '空白临时稿不算');
  assert.equal(hasPendingSpeech({ ...idle, unsubmittedUserCount: 1 }), true, '定稿未提交禁发');
});

test('024 canSendText：模型在途禁发；播放与后台任务不在判定面（不传入即不锁）', () => {
  const ok = { modelReady: true, modelInFlight: false, pendingSpeech: false };
  assert.equal(canSendText(ok), true);
  assert.equal(canSendText({ ...ok, modelInFlight: true }), false, '模型请求在途禁发');
  assert.equal(canSendText({ ...ok, pendingSpeech: true }), false, '待提交语音禁发');
  assert.equal(canSendText({ ...ok, modelReady: false }), false, '模型未配置禁发');
});
