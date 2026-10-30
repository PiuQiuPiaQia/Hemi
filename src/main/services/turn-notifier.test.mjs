import test from 'node:test';
import assert from 'node:assert/strict';

import {
  completionBody,
  completionTitle,
  createTurnNotifier,
  shouldNotifyForCompletion,
} from './turn-notifier.mjs';

function fakeWindow({ visible = true, minimized = false, focused = true } = {}) {
  return {
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => minimized,
    isFocused: () => focused,
  };
}

test('前台聚焦不打扰；隐藏、最小化、在别的应用上都算后台', () => {
  assert.equal(shouldNotifyForCompletion({ visible: true, focused: true }), false);
  assert.equal(shouldNotifyForCompletion({ visible: true, minimized: true, focused: true }), true);
  assert.equal(shouldNotifyForCompletion({ visible: false, focused: false }), true);
  assert.equal(shouldNotifyForCompletion({ visible: true, focused: false }), true);
  assert.equal(shouldNotifyForCompletion({ enabled: false, visible: false }), false);
});

test('等待用户的提醒明确需要回复',()=>{assert.match(completionBody({outcome:'awaiting-user'}),/等待你的回复/);});

test('文案：会话标题优先，正文带结果口径与输入摘要；多条只报条数', () => {
  assert.equal(completionTitle({ conversationTitle: '  整理下载文件夹 ' }), '整理下载文件夹');
  assert.equal(completionTitle({ conversationTitle: '' }), 'Hemi');
  assert.equal(completionBody({ outcome: 'completed', preview: '整理下载文件夹' }), '任务已完成：整理下载文件夹');
  assert.equal(completionBody({ outcome: 'failed', preview: '' }), '任务未完成');
  assert.equal(completionBody({ outcome: 'partial', preview: '先归档\n再统计' }), '任务部分完成：先归档 再统计');
  assert.equal(completionBody({ outcome: 'blocked', preview: '外部资源不可用' }), '任务受阻：外部资源不可用');
  assert.equal(completionBody({ outcome: 'completed', preview: 'x'.repeat(200) }).length, '任务已完成：'.length + 80);
  assert.equal(completionBody({ outcome: 'completed', preview: 'a', count: 3 }), '3 个任务已结束');
});

test('主窗口在前台时不发通知；在后台时发一条带点击回焦的横幅', () => {
  const shown = [];
  let focused = false;
  let win = fakeWindow({ visible: true, focused: true });
  const notifier = createTurnNotifier({
    getWindow: () => win,
    showWindow: () => { focused = true; },
    showNotification: payload => shown.push(payload),
    mergeMs: 1,
  });
  notifier.notifyCompletion({ conversationTitle: '任务 A', outcome: 'completed', preview: '整理下载文件夹' });
  notifier.flush();
  assert.equal(shown.length, 0);

  win = fakeWindow({ visible: false });
  notifier.notifyCompletion({ conversationTitle: '任务 A', outcome: 'completed', preview: '整理下载文件夹' });
  notifier.flush();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, '任务 A');
  assert.equal(shown[0].body, '任务已完成：整理下载文件夹');
  shown[0].onClick();
  assert.equal(focused, true);
  notifier.dispose();
});

test('合并窗口内多个收口只弹一条；enabled=false 一律不发', () => {
  const shown = [];
  const notifier = createTurnNotifier({
    getWindow: () => fakeWindow({ visible: false }),
    showNotification: payload => shown.push(payload),
    mergeMs: 5,
  });
  notifier.notifyCompletion({ conversationTitle: 'A', outcome: 'completed', preview: '一' });
  notifier.notifyCompletion({ conversationTitle: 'B', outcome: 'failed', preview: '二' });
  notifier.notifyCompletion({ conversationTitle: 'C', outcome: 'partial', preview: '三' });
  notifier.flush();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].body, '3 个任务已结束');

  const disabled = [];
  const quiet = createTurnNotifier({
    getWindow: () => fakeWindow({ visible: false }),
    showNotification: payload => disabled.push(payload),
    enabled: false,
    mergeMs: 1,
  });
  assert.equal(quiet.notifyCompletion({ outcome: 'completed' }), false);
  quiet.flush();
  assert.equal(disabled.length, 0);
  notifier.dispose();
  quiet.dispose();
});

test('通知落定时用户已切回前台就不再弹；发送异常只落日志', () => {
  const shown = [];
  let win = fakeWindow({ visible: false });
  const warnings = [];
  const notifier = createTurnNotifier({
    getWindow: () => win,
    showNotification: () => { throw new Error('not allowed'); },
    log: { warn: message => warnings.push(message) },
    mergeMs: 1,
  });
  notifier.notifyCompletion({ outcome: 'completed', preview: '跑完了' });
  win = fakeWindow({ visible: true, focused: true });
  notifier.flush();
  assert.equal(shown.length, 0);
  assert.equal(warnings.length, 0);

  win = fakeWindow({ visible: false });
  notifier.notifyCompletion({ outcome: 'completed', preview: '跑完了' });
  notifier.flush();
  assert.equal(warnings.length, 1);
  notifier.dispose();
});

test('后台交接提醒不宣称目标已经完成',()=>{
 assert.equal(completionBody({outcome:'awaiting-background'}),'任务已转入后台');
});
