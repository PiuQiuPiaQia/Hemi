import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  buildAppMenuTemplate,
  guardNavigation,
  installNativeShell,
  readFullKeyboardAccess,
} from './native-shell.mjs';

function roles(template) {
  return template.flatMap((menu) => menu.submenu.map((item) => item.role).filter(Boolean));
}

const WEB_ROLES = ['reload', 'forceReload', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut'];

/** 子菜单项的骨架（role 优先，其次 separator 等 type），用于整组精确比对。 */
function itemKeys({ submenu }) {
  return submenu.map(({ role, type }) => role ?? type);
}

test('安装包 mac 菜单：无重载/DevTools/缩放，保留编辑与退出', () => {
  const template = buildAppMenuTemplate({ platform: 'darwin', appName: 'Hemi', devTools: false });
  const all = roles(template);
  for (const role of WEB_ROLES) assert.ok(!all.includes(role), `不应出现 ${role}`);
  for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'quit', 'hide']) {
    assert.ok(all.includes(role), `缺少 ${role}`);
  }
  assert.equal(template[0].label, 'Hemi');
});

test('开发实例：额外挂「开发」组（重载、DevTools、缩放）', () => {
  const all = roles(buildAppMenuTemplate({ platform: 'darwin', appName: 'Hemi', devTools: true }));
  for (const role of WEB_ROLES) assert.ok(all.includes(role), `缺少 ${role}`);
});

test('非 mac 安装包不挂菜单（不出窗口菜单栏）；开发实例照挂且无应用组', () => {
  assert.equal(buildAppMenuTemplate({ platform: 'win32', appName: 'Hemi', devTools: false }), null);
  const dev = buildAppMenuTemplate({ platform: 'win32', appName: 'Hemi', devTools: true });
  assert.ok(!dev.some((menu) => menu.label === 'Hemi'), '不应有应用组');
  assert.ok(!roles(dev).includes('front'));
  assert.ok(roles(dev).includes('toggleDevTools'));
});

test('非 mac 开发实例：窗口菜单补分隔符＋退出（close 拦截 hide 外的真实退出入口）', () => {
  const dev = buildAppMenuTemplate({ platform: 'win32', appName: 'Hemi', devTools: true });
  const windowMenu = dev.at(-1);
  assert.equal(windowMenu.label, '窗口');
  assert.deepEqual(itemKeys(windowMenu), ['minimize', 'zoom', 'separator', 'close', 'separator', 'quit']);
  assert.equal(windowMenu.submenu.at(-1).label, '退出 Hemi');
  assert.equal(roles(dev).filter((role) => role === 'quit').length, 1);
});

test('mac：退出只挂在应用菜单，窗口菜单不重复添加 quit', () => {
  const template = buildAppMenuTemplate({ platform: 'darwin', appName: 'Hemi', devTools: false });
  const quits = template.flatMap((menu) => menu.submenu.filter((item) => item.role === 'quit'));
  assert.equal(quits.length, 1);
  assert.equal(quits[0].label, '退出 Hemi');
  assert.ok(template[0].submenu.includes(quits[0]), 'quit 应在应用菜单');
  assert.deepEqual(itemKeys(template.at(-1)), ['minimize', 'zoom', 'separator', 'close', 'separator', 'front']);
});

test('页内导航一律拦下；https 交外链白名单，其余协议直接丢弃', () => {
  const contents = new EventEmitter();
  const opened = [];
  guardNavigation(contents, { openExternal: async (url) => opened.push(url) });

  for (const url of ['file:///Users/me/a.pdf', 'https://platform.openai.com/keys', 'http://x.test/']) {
    let prevented = false;
    contents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, url);
    assert.ok(prevented, `${url} 应被拦下`);
  }
  assert.deepEqual(opened, ['https://platform.openai.com/keys']);
});

test('installNativeShell：设菜单（null 也显式设，盖掉默认菜单）并给所有 webContents 挂守卫', () => {
  const app = new EventEmitter();
  const set = [];
  const Menu = {
    buildFromTemplate: (template) => ({ template }),
    setApplicationMenu: (menu) => set.push(menu),
  };
  installNativeShell({
    app, Menu, platform: 'win32', appName: 'Hemi', devTools: false, openExternal: async () => {},
  });
  assert.deepEqual(set, [null]);

  const contents = new EventEmitter();
  app.emit('web-contents-created', {}, contents);
  assert.equal(contents.listenerCount('will-navigate'), 1);
});

test('键盘导航开关：mac 读 AppleKeyboardUIMode 第 2 位，未设置＝关；Windows 恒开', () => {
  const prefs = (value) => ({
    getUserDefault: (key, type) => {
      assert.equal(key, 'AppleKeyboardUIMode');
      assert.equal(type, 'integer');
      return value;
    },
  });
  assert.equal(readFullKeyboardAccess({ platform: 'darwin', systemPreferences: prefs(0) }), false);
  assert.equal(readFullKeyboardAccess({ platform: 'darwin', systemPreferences: prefs(undefined) }), false);
  assert.equal(readFullKeyboardAccess({ platform: 'darwin', systemPreferences: prefs(2) }), true);
  assert.equal(readFullKeyboardAccess({ platform: 'darwin', systemPreferences: prefs(3) }), true);
  const throwing = { getUserDefault: () => { throw new Error('boom'); } };
  assert.equal(readFullKeyboardAccess({ platform: 'darwin', systemPreferences: throwing }), false);
  assert.equal(readFullKeyboardAccess({ platform: 'win32', systemPreferences: prefs(0) }), true);
});
