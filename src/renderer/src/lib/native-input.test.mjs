import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyKeydown, nextIndex, tabScope } from './native-input.ts';

const key = (k, mods = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  ...mods,
});
const pointer = { textEditing: false, kbNav: false };
const keyboard = { textEditing: false, kbNav: true };
const typing = { textEditing: true, kbNav: false };

test('方向键进入键盘巡航；文本输入里的方向键是移动光标，不切模态', () => {
  for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    assert.equal(classifyKeydown(key(k), pointer), 'nav', k);
  }
  assert.equal(classifyKeydown(key('ArrowLeft'), typing), null);
  assert.equal(classifyKeydown(key('Tab'), pointer), null, 'Tab 归冒泡阶段 tabScope');
});

test('Tab 跟随系统键盘导航：关着只在文本输入间切换，Option+Tab 走全部；开着交浏览器', () => {
  const tab = (mods = {}) => ({ ...key('Tab', mods), defaultPrevented: false });
  assert.equal(tabScope(tab(), false), 'text');
  assert.equal(tabScope(tab({ shiftKey: true }), false), 'text');
  assert.equal(tabScope(tab({ altKey: true }), false), 'all');
  assert.equal(tabScope(tab(), true), 'browser');
  assert.equal(tabScope(tab({ altKey: true }), true), 'browser');
});

test('Tab 不管：组件已处理（作曲家 @ 提及选中）、⌘/Ctrl+Tab、组字中、非 Tab', () => {
  assert.equal(tabScope({ ...key('Tab'), defaultPrevented: true }, false), null);
  assert.equal(tabScope({ ...key('Tab', { ctrlKey: true }), defaultPrevented: false }, false), null);
  assert.equal(tabScope({ ...key('Tab', { metaKey: true }), defaultPrevented: false }, false), null);
  assert.equal(tabScope({ ...key('Tab', { isComposing: true }), defaultPrevented: false }, false), null);
  assert.equal(tabScope({ ...key('Enter'), defaultPrevented: false }, false), null);
});

test('巡航序列循环；焦点不在序列里时正向进第一个、反向进最后一个；空序列不动', () => {
  assert.equal(nextIndex(3, 0, 1), 1);
  assert.equal(nextIndex(3, 2, 1), 0);
  assert.equal(nextIndex(3, 0, -1), 2);
  assert.equal(nextIndex(3, -1, 1), 0);
  assert.equal(nextIndex(3, -1, -1), 2);
  assert.equal(nextIndex(1, 0, 1), 0);
  assert.equal(nextIndex(0, -1, 1), -1);
});

test('鼠标点过的控件：Enter/空格不再激活（含 Shift），键盘巡航时照常激活', () => {
  for (const k of ['Enter', ' ']) {
    assert.equal(classifyKeydown(key(k), pointer), 'suppress', k);
    assert.equal(classifyKeydown(key(k, { shiftKey: true }), pointer), 'suppress', k);
    assert.equal(classifyKeydown(key(k), keyboard), null, k);
  }
});

test('文本输入与输入法组字中一律放行（作曲家 Enter 发送、空格打字）', () => {
  assert.equal(classifyKeydown(key('Enter'), typing), null);
  assert.equal(classifyKeydown(key(' '), typing), null);
  assert.equal(classifyKeydown(key('a', { metaKey: true }), typing), null);
  assert.equal(classifyKeydown(key('Enter', { isComposing: true }), pointer), null);
});

test('⌘A / Ctrl+A 在文本输入之外不全选界面（无论巡航模态）', () => {
  assert.equal(classifyKeydown(key('a', { metaKey: true }), pointer), 'suppress');
  assert.equal(classifyKeydown(key('A', { metaKey: true }), keyboard), 'suppress');
  assert.equal(classifyKeydown(key('a', { ctrlKey: true }), pointer), 'suppress');
  assert.equal(classifyKeydown(key('a', { metaKey: true, altKey: true }), pointer), null);
});

test('带 ⌘/Ctrl/Alt 的 Enter/空格是快捷键，不截；Esc 等其余键放行', () => {
  assert.equal(classifyKeydown(key('Enter', { metaKey: true }), pointer), null);
  assert.equal(classifyKeydown(key(' ', { altKey: true }), pointer), null);
  assert.equal(classifyKeydown(key('Escape'), pointer), null);
  assert.equal(classifyKeydown(key('n', { metaKey: true }), pointer), null);
});
