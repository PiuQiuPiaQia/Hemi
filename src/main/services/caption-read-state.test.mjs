import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionReadTracker, markCurrentCaptionRead, projectCaptionReadState } from './caption-read-state.mjs';
import { state } from '../state.mjs';

test('已读跨空状态与会话切换保留；相同文案的新身份或新文字仍未读', () => {
  const tracker = createCaptionReadTracker();
  const line = { id: 'conversation-1:reply-1', author: 'hemi', text: '处理完成' };
  assert.equal(tracker.project([line])[0].captionRead, false);
  tracker.markRead([line]);
  tracker.project([]);
  assert.equal(tracker.project([line])[0].captionRead, true);
  assert.equal(tracker.project([{ ...line, id: 'conversation-2:reply-1' }])[0].captionRead, false);
  assert.equal(tracker.project([{ ...line, id: 'conversation-1:reply-2' }])[0].captionRead, false);
  assert.equal(tracker.project([{ ...line, text: '处理完成，另有新结果' }])[0].captionRead, false);
});

test('旧状态无消息 ID 时按作者与文本去重', () => {
  const tracker = createCaptionReadTracker();
  tracker.markRead([{ author: 'hemi', text: '旧状态' }]);
  assert.equal(tracker.project([{ author: 'hemi', text: '旧状态' }])[0].captionRead, true);
  assert.equal(tracker.project([{ author: 'user', text: '旧状态' }])[0].captionRead, false);
});

test('前台上报与焦点切回立即同步已读，失焦／最小化不消费新消息', () => {
  const saved = { mainWindow: state.mainWindow, floatingWindow: state.floatingWindow, floatingCaptionWindow: state.floatingCaptionWindow, lastUiState: state.lastUiState };
  let focused = false, minimized = false;
  const sent = [];
  state.mainWindow = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => minimized, isFocused: () => focused };
  state.floatingWindow = null;
  state.floatingCaptionWindow = { isDestroyed: () => false, webContents: { send: (channel, value) => sent.push({ channel, value }) } };
  const next = (id) => ({ ...saved.lastUiState, recentLines: [{ id, text: '新回复', author: 'hemi' }] });
  try {
    state.lastUiState = projectCaptionReadState(next('focus-test:1'));
    assert.equal(state.lastUiState.recentLines[0].captionRead, false);
    focused = true;
    markCurrentCaptionRead();
    assert.equal(sent.at(-1).value.recentLines[0].captionRead, true);
    focused = false;
    assert.equal(projectCaptionReadState(next('focus-test:1')).recentLines[0].captionRead, true);
    assert.equal(projectCaptionReadState(next('focus-test:2')).recentLines[0].captionRead, false);
    focused = true; minimized = true;
    assert.equal(projectCaptionReadState(next('focus-test:3')).recentLines[0].captionRead, false);
    minimized = false;
    assert.equal(projectCaptionReadState(next('focus-test:3')).recentLines[0].captionRead, true);
  } finally {
    Object.assign(state, saved);
  }
});
