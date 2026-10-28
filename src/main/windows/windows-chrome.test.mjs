import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WINDOWS_OVERLAY_TRANSPARENT,
  WINDOWS_SYMBOL_COLOR_FALLBACK,
  WINDOWS_TITLE_BAR_HEIGHT_PX,
  attachWindowsWindowRepaint,
  buildWindowsTitleBarOverlay,
} from './windows-chrome.mjs';

// Windows titleBarOverlay 集成：透明底 + 皮肤符号色 + 52px 顶栏高度（参考 ZCode 做法）。

test('overlay 背景全透明，符号色取皮肤正文色，高度对齐 52px 顶栏', () => {
  const overlay = buildWindowsTitleBarOverlay({ colors: { '--body': '#111111' } });
  assert.equal(overlay.color, WINDOWS_OVERLAY_TRANSPARENT);
  assert.equal(overlay.symbolColor, '#111111');
  assert.equal(overlay.height, WINDOWS_TITLE_BAR_HEIGHT_PX);
  assert.equal(overlay.height, 52);
});

test('皮肤缺失或字段不全时用兜底符号色，不抛错', () => {
  assert.equal(buildWindowsTitleBarOverlay(null).symbolColor, WINDOWS_SYMBOL_COLOR_FALLBACK);
  assert.equal(buildWindowsTitleBarOverlay({}).symbolColor, WINDOWS_SYMBOL_COLOR_FALLBACK);
  assert.equal(buildWindowsTitleBarOverlay({ colors: {} }).color, WINDOWS_OVERLAY_TRANSPARENT);
});

function createFakeWindow() {
  const listeners = new Map();
  const once = new Map();
  return {
    webContents: { isDestroyed: () => false, invalidateCallCount: 0, invalidate() { this.invalidateCallCount += 1; } },
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    on(event, handler) { listeners.set(event, handler); },
    once(event, handler) { once.set(event, handler); },
    removeListener(event, handler) {
      assert.equal(listeners.get(event), handler);
      listeners.delete(event);
    },
    emit(event) {
      listeners.get(event)?.();
    },
    emitClosed() {
      this.destroyed = true;
      once.get('closed')?.();
    },
    listenerCount() { return listeners.size; },
  };
}

test('resized 与 show 都触发立即重绘 + 32ms 后的第二帧', async () => {
  const fake = createFakeWindow();
  const dispose = attachWindowsWindowRepaint(fake);
  fake.emit('resized');
  assert.equal(fake.webContents.invalidateCallCount, 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fake.webContents.invalidateCallCount, 2);

  fake.emit('show');
  assert.equal(fake.webContents.invalidateCallCount, 3);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fake.webContents.invalidateCallCount, 4);
  dispose();
});

test('closed 自动解绑：销毁后事件不再触发重绘，提前 dispose 同样安全', async () => {
  const fake = createFakeWindow();
  const dispose = attachWindowsWindowRepaint(fake);
  fake.emit('resized');
  fake.emitClosed();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const afterClosed = fake.webContents.invalidateCallCount;
  fake.emit('resized');
  fake.emit('show');
  assert.equal(fake.webContents.invalidateCallCount, afterClosed);
  assert.equal(fake.listenerCount(), 0);

  const other = createFakeWindow();
  const early = attachWindowsWindowRepaint(other);
  other.emit('resized');
  early();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const stopped = other.webContents.invalidateCallCount;
  other.emit('show');
  assert.equal(other.webContents.invalidateCallCount, stopped);
});
