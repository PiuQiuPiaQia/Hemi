import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCaptionLines,
  captionContentKey,
  isCaptionContentFresh,
  resolveCaptionFallback,
} from './floating-caption-lines.ts';

/** 造一份 UiState：定稿句 + 正在识别的临时结果 + 回合阶段。 */
function uiState({
  finals = [],
  interim = '',
  turnPhase = 'idle',
  sessionState = 'listening',
  callActive = false,
  errorText = '',
  isSpeaking = false,
  ttsActive = false,
} = {}) {
  return {
    sessionState,
    isSpeaking,
    interimText: interim,
    recentLines: finals,
    errorText,
    turnPhase,
    elapsedSeconds: 0,
    callActive,
    ttsActive,
  };
}

test('用户说话中：只显示正在识别的这句（字幕跟读）', () => {
  const lines = buildCaptionLines(
    uiState({ finals: ['第一句', '第二句'], interim: '第三句正在说' }),
  );

  assert.deepEqual(
    lines.map((line) => [line.text, line.kind, line.author]),
    [['第三句正在说', 'interim', 'user']],
  );
});

test('思考中：用户句 + 「正在想」指示行，状态可见', () => {
  const lines = buildCaptionLines(
    uiState({
      finals: [{ text: '帮我看看天气', author: 'user' }],
      interim: '',
      turnPhase: 'thinking',
    }),
  );

  assert.deepEqual(
    lines.map((line) => [line.text, line.kind, line.author]),
    [
      ['帮我看看天气', 'final', 'user'],
      ['正在想', 'thinking', 'hemi'],
    ],
  );
});

test('回应中（流式未完）：继续保持思考指示，不闪空', () => {
  const lines = buildCaptionLines(
    uiState({
      finals: [{ text: '帮我看看天气', author: 'user' }],
      interim: '',
      turnPhase: 'replying',
    }),
  );

  assert.deepEqual(
    lines.map((line) => line.kind),
    ['final', 'thinking'],
  );
});

test('Hemi 回应落地：只显示回应，用户的话让位', () => {
  const lines = buildCaptionLines(
    uiState({
      finals: [
        { text: '帮我看看天气', author: 'user' },
        { text: '今天杭州晴，26 度。', author: 'hemi' },
      ],
      interim: '',
      turnPhase: 'replying',
    }),
  );

  assert.deepEqual(
    lines.map((line) => [line.text, line.kind, line.author]),
    [['今天杭州晴，26 度。', 'final', 'hemi']],
  );
});

test('回应结束后回到静默：只显示 Hemi 的回应，不挂思考行', () => {
  const lines = buildCaptionLines(
    uiState({
      finals: [{ text: '今天杭州晴，26 度。', author: 'hemi' }],
      interim: '',
      turnPhase: 'idle',
    }),
  );

  assert.deepEqual(lines.map((line) => line.text), ['今天杭州晴，26 度。']);
});

test('临时结果暂时为空时整行不出现，不留空白占位', () => {
  const lines = buildCaptionLines(uiState({ finals: ['第一句'], interim: '   ' }));

  assert.deepEqual(lines.map((line) => line.text), ['第一句']);
});

test('临时结果与末句定稿重复时不显示两遍', () => {
  const lines = buildCaptionLines(uiState({ finals: ['第一句'], interim: '第一句' }));

  assert.deepEqual(lines.map((line) => line.text), ['第一句']);
  assert.equal(lines[0].kind, 'final');
});

test('没有任何字幕时返回空数组，交给提示文案', () => {
  assert.deepEqual(buildCaptionLines(uiState()), []);
});

test('已读末条回复不再展示，也不回退到更早的未读句子', () => {
  for (const turnPhase of ['idle', 'replying', 'speaking', 'thinking']) {
    assert.deepEqual(buildCaptionLines(uiState({
      finals: [
        { id: 'c:1', text: '旧问题', author: 'user' },
        { id: 'c:2', text: '已经看过的回复', author: 'hemi', captionRead: true },
      ],
      turnPhase,
      ttsActive: true,
    })), []);
  }
});

test('已读问题让位后仍显示当前思考、识别和错误', () => {
  const finals = [{ text: '已经看过的问题', author: 'user', captionRead: true }];
  assert.deepEqual(buildCaptionLines(uiState({ finals, turnPhase: 'thinking' })).map(l => l.kind), ['thinking']);
  assert.deepEqual(buildCaptionLines(uiState({ finals, interim: '新语音' })).map(l => l.text), ['新语音']);
  assert.deepEqual(buildCaptionLines(uiState({ finals, errorText: '新错误' })).map(l => l.text), ['新错误']);
});

test('相同文案的新消息身份改变字幕指纹，能够再次提示', () => {
  const lines = id => buildCaptionLines(uiState({ finals: [{ id, text: '完成', author: 'hemi' }] }));
  assert.notEqual(captionContentKey(lines('c:1'), ''), captionContentKey(lines('c:2'), ''));
});

test('内容指纹只看字幕内容，不受会话状态与耗时影响', () => {
  const lines = buildCaptionLines(uiState({ finals: ['第一句'], interim: '第二句' }));
  const sameLines = buildCaptionLines(uiState({ finals: ['第一句'], interim: '第二句' }));
  const otherLines = buildCaptionLines(uiState({ finals: ['第一句'], interim: '第三句' }));

  assert.equal(captionContentKey(lines, '提示'), captionContentKey(sameLines, '提示'));
  assert.notEqual(captionContentKey(lines, '提示'), captionContentKey(otherLines, '提示'));
  // 没有字幕时用提示文案当指纹：说话模式不同，提示不同。
  assert.equal(captionContentKey([], '长按或点击，开始对话'), '长按或点击，开始对话');
});

test('提示文案按会话状态区分', () => {
  assert.equal(resolveCaptionFallback(uiState({ sessionState: 'idle' })), '长按或点击，开始对话');
  assert.equal(resolveCaptionFallback(uiState({ sessionState: 'requesting' })), '正在连接…');
  assert.equal(
    resolveCaptionFallback(uiState({ sessionState: 'requesting', callActive: true })),
    '正在接通通话…',
  );
  assert.equal(resolveCaptionFallback(uiState({ sessionState: 'listening' })), '我在听，松开回应');
  assert.equal(
    resolveCaptionFallback(uiState({ sessionState: 'listening', callActive: true })),
    '通话中，直接说话',
  );
  assert.equal(resolveCaptionFallback(uiState({ sessionState: 'error' })), '语音识别暂时不可用');
});

test('纯字符串定稿按用户算，Hemi 行带 hemi 标记', () => {
  const legacy = buildCaptionLines(uiState({ finals: ['老格式的句子'], interim: '' }));
  assert.equal(legacy[0].author, 'user');

  const hemi = buildCaptionLines(
    uiState({ finals: [{ text: '回应。', author: 'hemi' }], interim: '' }),
  );
  assert.equal(hemi[0].author, 'hemi');
});

test('模型错误走 errorText 独立一行：保留焦点句，临时行让位', () => {
  const lines = buildCaptionLines(
    uiState({
      finals: [{ text: '帮我看看天气', author: 'user' }],
      interim: '应该被让位的临时行',
      errorText: '这次没能回应，请重试。',
    }),
  );

  assert.deepEqual(
    lines.map((line) => [line.kind, line.text]),
    [
      ['final', '帮我看看天气'],
      ['error', '这次没能回应，请重试。'],
    ],
  );
});

test('没有定稿时错误行独立出现', () => {
  const lines = buildCaptionLines(uiState({ errorText: '连不上文本模型服务。' }));

  assert.deepEqual(
    lines.map((line) => [line.kind, line.text]),
    [['error', '连不上文本模型服务。']],
  );
});

// ---- isCaptionContentFresh：字幕卡点亮的内容新鲜面（2026-09-24 定稿模型）----

test('判新鲜：轮次已落定的空闲内容不新鲜（切浮球模式的挂载回放场景）', () => {
  assert.equal(
    isCaptionContentFresh(
      uiState({
        finals: [{ text: '今天杭州晴，26 度。', author: 'hemi' }],
        interim: '',
        turnPhase: 'idle',
        sessionState: 'idle',
      }),
    ),
    false,
  );
});

test('判新鲜：在途轮次（思考/播报/收尾/错误相位）算新鲜', () => {
  for (const turnPhase of ['thinking', 'speaking', 'replying', 'error']) {
    assert.equal(
      isCaptionContentFresh(uiState({ turnPhase, sessionState: 'idle' })),
      true,
      `turnPhase=${turnPhase} 应判新鲜`,
    );
  }
});

test('判新鲜：会话状态本身不算内容新鲜（连接中/聆听中只驱动药丸和球）', () => {
  for (const sessionState of ['requesting', 'listening', 'error']) {
    assert.equal(
      isCaptionContentFresh(uiState({ turnPhase: 'idle', sessionState })),
      false,
      `sessionState=${sessionState} 不应点亮旧内容`,
    );
  }
  assert.equal(
    isCaptionContentFresh(uiState({ turnPhase: 'listening', sessionState: 'listening' })),
    false,
    '聆听相位、还没开口：recentLines 是上一轮残留，不新鲜',
  );
});

test('判新鲜：按 Option 转聆听但未开口——旧答案不点亮的回归用例', () => {
  // 用户反馈 2026-09-24：悬浮球状态按 Option，先把上次的结果展示了。
  assert.equal(
    isCaptionContentFresh(
      uiState({
        finals: [
          { text: '帮我查下明天的天气', author: 'user' },
          { text: '明天杭州晴，26 度。报告已生成。', author: 'hemi' },
        ],
        interim: '',
        turnPhase: 'listening',
        sessionState: 'listening',
      }),
    ),
    false,
  );
});

test('判新鲜：TTS 在播／临时结果／错误文本在场算新鲜', () => {
  assert.equal(
    isCaptionContentFresh(uiState({ ttsActive: true, turnPhase: 'idle', sessionState: 'idle' })),
    true,
  );
  assert.equal(
    isCaptionContentFresh(uiState({ interim: '正在说', turnPhase: 'idle', sessionState: 'idle' })),
    true,
  );
  assert.equal(
    isCaptionContentFresh(uiState({ errorText: '出错了', turnPhase: 'idle', sessionState: 'idle' })),
    true,
  );
});

// ---- 聆听相位不回退旧答案（2026-09-24：Option 发送完成后闪旧信息）----

test('聆听相位无临时结果：末句是 Hemi 的（上一轮答案）→ 不显示，收敛为空', () => {
  // 发送空窗：临时结果已清、新定稿还没进 recentLines 的任何一拍。
  assert.deepEqual(
    buildCaptionLines(
      uiState({
        finals: [
          { text: '帮我查下明天的天气', author: 'user' },
          { text: '明天杭州晴，26 度。报告已生成。', author: 'hemi' },
        ],
        interim: '',
        turnPhase: 'listening',
        sessionState: 'idle',
      }),
    ),
    [],
  );
});

test('聆听相位无临时结果：末句是用户的（本会话刚定稿）→ 照常显示', () => {
  // 连续通话里「我刚说了什么」的当前反馈，不能被上面规则误伤。
  assert.deepEqual(
    buildCaptionLines(
      uiState({
        finals: [{ text: '帮我把会议改到下午三点', author: 'user' }],
        interim: '',
        turnPhase: 'listening',
        sessionState: 'listening',
      }),
    ).map((line) => [line.text, line.kind]),
    [['帮我把会议改到下午三点', 'final']],
  );
});

test('阅读停留不受影响：replying/idle 相位照常显示末句答案', () => {
  for (const turnPhase of ['speaking', 'replying', 'idle']) {
    assert.equal(
      buildCaptionLines(
        uiState({
          finals: [{ text: '明天杭州晴，26 度。', author: 'hemi' }],
          interim: '',
          turnPhase,
          sessionState: 'idle',
        }),
      ).length,
      1,
      `turnPhase=${turnPhase} 应保持末句显示`,
    );
  }
});
