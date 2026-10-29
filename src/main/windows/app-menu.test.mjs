import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWindowMenuTemplate, showWindowMenu } from './app-menu.mjs';

test('File enables only actions supplied by the visible page and preserves native close/quit', () => {
  const selected = [];
  const file = buildWindowMenuTemplate({ menu: 'file', enabledCommands: ['new-conversation', 'settings'], select: command => selected.push(command) });
  assert.equal(file.find(item => item.id === 'new-conversation').enabled, true);
  assert.equal(file.find(item => item.id === 'open-workspace').enabled, false);
  file.find(item => item.id === 'settings').click();
  assert.deepEqual(selected, ['settings']);
  assert.deepEqual(file.filter(item => item.role).map(item => item.role), ['close', 'quit']);
});

test('collapsed Windows menu exposes the same groups and native editing roles', () => {
  const groups = buildWindowMenuTemplate({ menu: 'all', enabledCommands: [], select() {} });
  assert.deepEqual(groups.map(group => group.label), ['文件(&F)', '编辑(&E)', '视图(&V)', '帮助(&H)']);
  assert.deepEqual(groups[1].submenu.filter(item => item.role).map(item => item.role), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  assert.throws(() => buildWindowMenuTemplate({ menu: 'unknown', enabledCommands: [], select() {} }), /INVALID_MENU/);
});

test('invalid native popup coordinates are rejected before constructing a menu', () => {
  for (const request of [null, { x: NaN, y: 10, enabledCommands: [] }, { x: 1, y: Infinity, enabledCommands: [] }]) {
    assert.throws(() => showWindowMenu({ request }), /INVALID_MENU_REQUEST/);
  }
});
