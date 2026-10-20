import assert from 'node:assert/strict';
import test from 'node:test';

import { InterimTranscript, shouldClearInterimOnFinal } from './interim-guard.ts';

test('没有识别文本在显示时，定稿照常清空', () => {
  assert.equal(shouldClearInterimOnFinal('今天天气怎么样', ''), true);
  assert.equal(shouldClearInterimOnFinal('今天天气怎么样', '   '), true);
});

test('当前这句的定稿：清空（同一句话落定）', () => {
  assert.equal(shouldClearInterimOnFinal('今天天气怎么样', '今天天气怎么样'), true);
});

test('标点与空白差异不影响归属判断', () => {
  assert.equal(
    shouldClearInterimOnFinal('今天天气怎么样。', '今天天气怎么 样'),
    true,
  );
});

test('定稿是识别文本的补全（修订版）：清空', () => {
  assert.equal(shouldClearInterimOnFinal('今天天气怎么样', '今天天气'), true);
  assert.equal(shouldClearInterimOnFinal('今天', '今天天气怎么样'), true);
});

test('上一句的迟到定稿不得打断当前识别（闪回旧信息的根因）', () => {
  assert.equal(shouldClearInterimOnFinal('今天天气怎么样', '明天呢'), false);
  assert.equal(
    shouldClearInterimOnFinal('帮我看看杭州的天气', '那后天呢'),
    false,
  );
});

test('空定稿不清空正在显示的识别文本', () => {
  assert.equal(shouldClearInterimOnFinal('   ', '明天呢'), false);
});

const partial = (text, utteranceId) => ({ type: 'transcript.partial', text, utteranceId });
const final = (text, utteranceId) => ({ type: 'transcript.final', text, utteranceId });

test('截图回归：句尾从「了」修订为「呢」，同一分句不残留识别中', () => {
  const interim = new InterimTranscript();
  interim.partial(partial('今天天气怎么样了', 's1:0'));
  assert.equal(interim.finalize(final('今天天气怎么样呢？', 's1:0')), '');
});

test('同一分句被完整改写时仍按身份清空', () => {
  const interim = new InterimTranscript();
  interim.partial(partial('北京', 's1:0'));
  assert.equal(interim.finalize(final('背景噪声。', 's1:0')), '');
});

test('上一句迟到定稿不得清掉文字相同的下一句', () => {
  const interim = new InterimTranscript();
  interim.partial(partial('你好', 's1:1000'));
  assert.equal(interim.finalize(final('你好。', 's1:0')), '你好');
});

test('聚合临时文本：定稿只移除对应分句，保留下一句', () => {
  const interim = new InterimTranscript();
  interim.partial({
    type: 'transcript.partial',
    text: '今天天气怎么样了明天呢',
    utterances: [
      { text: '今天天气怎么样了', utteranceId: 's1:0' },
      { text: '明天呢', utteranceId: 's1:1000' },
    ],
  });
  assert.equal(interim.finalize(final('今天天气怎么样呢？', 's1:0')), '明天呢');
  assert.equal(interim.finalize(final('今天天气如何？', 's1:0')), '明天呢');
  assert.equal(interim.finalize(final('明天怎么样？', 's1:1000')), '');
});

test('迟到的临时事件不能复活已经定稿的分句，也不能擦除下一句', () => {
  const interim = new InterimTranscript();
  interim.finalize(final('今天天气怎么样呢？', 's1:0'));
  assert.equal(interim.partial(partial('今天天气怎么样了', 's1:0')), '');
  interim.partial(partial('明天呢', 's1:1000'));
  assert.equal(interim.partial(partial('今天天气怎么样了', 's1:0')), '明天呢');
  assert.equal(interim.partial(partial('', undefined)), '明天呢');
});

test('聚合临时结果中已经定稿的部分不会再次显示', () => {
  const interim = new InterimTranscript();
  interim.finalize(final('你好。', 's1:0'));
  assert.equal(interim.partial({
    type: 'transcript.partial', text: '你好你好',
    utterances: [
      { text: '你好', utteranceId: 's1:0' },
      { text: '你好', utteranceId: 's1:1000' },
    ],
  }), '你好');
});

test('clear 清显示但保留定稿记录，重连 reset 才清除编号记录', () => {
  const interim = new InterimTranscript();
  interim.finalize(final('你好。', '0:0'));
  interim.partial(partial('下一句', '0:1000'));
  assert.equal(interim.clear(), '');
  assert.equal(interim.partial(partial('你好', '0:0')), '');
  assert.equal(interim.reset(), '');
  assert.equal(interim.partial(partial('你好', '0:0')), '你好');
});

test('缺少分句编号时兼容旧事件，不通过猜测清掉不相关文本', () => {
  const interim = new InterimTranscript();
  interim.partial(partial('明天呢', undefined));
  assert.equal(interim.finalize(final('今天呢？', 's1:0')), '明天呢');
  assert.equal(interim.finalize(final('明天呢？', 's1:1000')), '');
});
