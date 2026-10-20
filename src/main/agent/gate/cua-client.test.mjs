// 036 · cua-client 单测——全部经假 SDK 模块/假驱动注入，不触发原生库加载
// （这是把 SDK 引用全部惰性化的直接动机，见 cua-client.mjs 头注释）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPTURE_LONG_EDGE,
  createCuaBridge,
  deltaYToScroll,
  describeAction,
  describeToolResult,
  driverErrorInfo,
  firstImage,
  parseCombo,
  translateDriverError,
} from './cua-client.mjs';

/** 假 SDK 模块：只提供本文件用到的构造器/枚举（形状对齐 0.32.0 契约）。 */
function fakeSdk() {
  const mkInput = (name) => ({ [`__input_${name}`]: true });
  return {
    ActionTarget: { Window: class { constructor(inner) { this.inner = inner; } } },
    ClickPosition: {
      Coordinates: class { constructor(inner) { this.inner = inner; } },
      Element: class { constructor(inner) { this.inner = inner; } },
    },
    ClickInput: { create: (partial) => ({ kind: 'click', ...partial }) },
    GetDesktopStateInput: { create: (partial) => ({ kind: 'desktop', ...partial }) },
    GetWindowStateInput: { create: (partial) => ({ kind: 'window-state', ...partial }) },
    HotkeyInput: { create: (partial) => ({ kind: 'hotkey', ...partial }) },
    PressKeyInput: { create: (partial) => ({ kind: 'press-key', ...partial }) },
    ListAppsInput: { create: (partial) => ({ kind: 'list-apps', ...partial }) },
    ListWindowsInput: { create: (partial) => ({ kind: 'list-windows', ...partial }) },
    ScrollInput: { create: (partial) => ({ kind: 'scroll', ...partial }) },
    TypeTextInput: { create: (partial) => ({ kind: 'type', ...partial }) },
    InputDeliveryMode: { Background: 0, Foreground: 1 },
    ScrollDirection: { Up: 0, Down: 1 },
    ScrollBy: { Line: 0, Page: 1 },
    CuaDriver: { create: () => { throw new Error('假模块不应走到 CuaDriver.create'); } },
  };
}

function refusedError(errorCode, message = '') {
  return Object.assign(new Error('DriverError.Tool'), {
    tag: 'Tool',
    inner: { tool: 'click', message, errorCode },
  });
}

test('parseCombo：组合键拆分与 esc 归一', () => {
  assert.deepEqual(parseCombo('cmd+a'), ['cmd', 'a']);
  assert.deepEqual(parseCombo('shift+tab'), ['shift', 'tab']);
  assert.deepEqual(parseCombo('esc'), ['escape']);
  assert.deepEqual(parseCombo('Enter'), ['enter']);
});

test('deltaYToScroll：正向上负向下，行数夹在 1–50', () => {
  assert.deepEqual(deltaYToScroll(3), { direction: 'up', amount: 3 });
  assert.deepEqual(deltaYToScroll(-10), { direction: 'down', amount: 10 });
  assert.deepEqual(deltaYToScroll(0), { direction: 'up', amount: 3 }); // 缺省 3 行
  assert.equal(deltaYToScroll(9999).amount, 50);
  assert.equal(deltaYToScroll(-0.4).amount, 1);
});

test('describeAction：effect 数值映射 actionState（0.32.0 契约）', () => {
  assert.equal(describeAction({ effect: 0 }).actionState, 'executed');
  assert.equal(describeAction({ effect: 1 }).actionState, 'executed');
  assert.match(describeAction({ effect: 1 }).note, /部分生效/);
  assert.equal(describeAction({ effect: 2 }).actionState, 'executed');
  assert.match(describeAction({ effect: 2 }).note, /未核验/);
  assert.equal(describeAction({ effect: 3 }).actionState, 'not-executed');
  assert.equal(describeAction({ effect: 4 }).actionState, 'not-executed');
  assert.equal(describeAction({ effect: 0, error: { code: 'x' } }).actionState, 'not-executed');
  assert.equal(describeAction(null).actionState, 'executed');
  // 前台投递要明说（升级透明原则）
  assert.match(describeAction({ effect: 0, delivery: { mode: 1 } }).note, /前台/);
});

test('describeToolResult：isError 优先，其次 action，缺省 executed', () => {
  assert.equal(describeToolResult({ isError: true, errorCode: 'e', text: 'boom' }).actionState, 'not-executed');
  assert.match(describeToolResult({ isError: true, errorCode: 'e', text: 'boom' }).note, /boom/);
  assert.equal(describeToolResult({ action: { effect: 3 } }).actionState, 'not-executed');
  assert.equal(describeToolResult({ text: '✅' }).actionState, 'executed');
});

test('firstImage：取出 base64 图', () => {
  assert.deepEqual(
    firstImage({ images: [{ dataBase64: 'QUJD', mimeType: 'image/png' }] }),
    { data: 'QUJD', mimeType: 'image/png' },
  );
  assert.equal(firstImage({ images: [] }), null);
  assert.equal(firstImage(null), null);
});

test('driverErrorInfo / translateDriverError：errorCode 路由到中文指引', () => {
  assert.equal(driverErrorInfo(new Error('普通错误')), null);
  const stale = translateDriverError(refusedError('stale_element_token', 'token expired'));
  assert.match(stale.message, /重新 screen_view/);
  const perm = translateDriverError(refusedError('accessibility_permission_missing', 'not authorized'));
  assert.match(perm.message, /隐私与安全性/);
  const gone = translateDriverError(refusedError('window_not_found', 'pid gone'));
  assert.match(gone.message, /目标窗口已不存在/);
  const other = translateDriverError(refusedError('weird_code', 'nope'));
  assert.match(other.message, /驱动拒绝执行/);
  // 非 DriverError 原样透传
  const plain = new Error('plain');
  assert.equal(translateDriverError(plain), plain);
});

/** 记账型假驱动：把每次调用的输入记下来，可脚本化返回。 */
function fakeDriver() {
  const calls = [];
  const d = {
    __calls: calls,
    listApps: async (input) => { calls.push(['listApps', input]); return { apps: [{ pid: 11, name: 'TextEdit', running: true, active: true, bundleId: 'com.apple.TextEdit' }] }; },
    listWindows: async (input) => {
      calls.push(['listWindows', input]);
      return { windows: [{ windowId: 99n, pid: 11, appName: 'TextEdit', title: 'untitled', bounds: { x: 1, y: 2, width: 30, height: 40 }, isOnScreen: true }] };
    },
    getWindowState: async (input) => { calls.push(['getWindowState', input]); return { elements: [], images: [{ dataBase64: 'QUJD', mimeType: 'image/png' }], screenshotWidth: 960 }; },
    getDesktopState: async (input) => { calls.push(['getDesktopState', input]); return { images: [{ dataBase64: 'REVG', mimeType: 'image/png' }] }; },
    click: async (input) => { calls.push(['click', input]); return { effect: 0, route: 0, delivery: { mode: 0 } }; },
    typeText: async (input) => { calls.push(['typeText', input]); return { text: '✅ Inserted', isError: false }; },
    hotkey: async (input) => { calls.push(['hotkey', input]); return { text: '✅', isError: false }; },
    pressKey: async (input) => { calls.push(['pressKey', input]); return { text: '✅', isError: false }; },
    scroll: async (input) => {
      calls.push(['scroll', input]);
      if (d.__scrollRefuses === 'result') {
        return { text: 'Background scroll is unavailable for Electron/Chromium windows on macOS.', isError: true, errorCode: 'background_unavailable' };
      }
      if (d.__scrollRefuses) throw refusedError('background_unavailable', 'no background route');
      return { text: '✅ scrolled', isError: false, action: { effect: 2, route: 1, delivery: { mode: 0 } } };
    },
    callTool: async (name, argsJson) => { calls.push(['callTool', name, JSON.parse(argsJson)]); return { text: '✅ fg', isError: false }; },
    shutdown: async () => { calls.push(['shutdown']); },
    uniffiDestroy: () => { calls.push(['uniffiDestroy']); },
  };
  return d;
}

function bridgeWith(driver) {
  return createCuaBridge({ loadSdk: () => fakeSdk(), createDriver: () => driver });
}

test('listAppWindows：按 pid 聚合成旧输出形状（ui_list/对话侧兼容）', async () => {
  const b = bridgeWith(fakeDriver());
  const apps = await b.listAppWindows();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].name, 'TextEdit');
  assert.equal(apps[0].frontmost, true);
  assert.deepEqual(
    apps[0].windows[0],
    { windowId: '99', title: 'untitled', x: 1, y: 2, w: 30, h: 40 },
  );
});

test('windowState：pid/windowId 传参 + 960 长边预算', async () => {
  const d = fakeDriver();
  const b = bridgeWith(d);
  await b.windowState({ pid: 11, windowId: '99', includeTree: true });
  const input = d.__calls.find(([n]) => n === 'getWindowState')[1];
  assert.equal(input.pid, 11);
  assert.equal(input.windowId, 99n);
  assert.equal(input.includeAccessibilityTree, true);
  assert.equal(input.maxImageDimension, CAPTURE_LONG_EDGE);
});

test('click：坐标/元素双寻址 + delivery 映射', async () => {
  const d = fakeDriver();
  const b = bridgeWith(d);
  await b.click({ pid: 11, windowId: '99', x: 12.6, y: 30 });
  await b.click({ pid: 11, windowId: '99', elementToken: 'tok', delivery: 'foreground' });
  const [coord, elem] = d.__calls.filter(([n]) => n === 'click').map(([, i]) => i);
  assert.deepEqual(coord.position.inner, { x: 13, y: 30 });
  assert.equal(coord.deliveryMode, 0);
  assert.deepEqual(elem.position.inner, { elementToken: 'tok' });
  assert.equal(elem.deliveryMode, 1);
});

test('key：多键 hotkey / 单键 pressKey，target 带窗口锚', async () => {
  const d = fakeDriver();
  const b = bridgeWith(d);
  await b.key({ combo: 'cmd+a', pid: 11, windowId: '99' });
  await b.key({ combo: 'enter' });
  const names = d.__calls.map(([n]) => n);
  assert.deepEqual(names, ['hotkey', 'pressKey']);
  assert.deepEqual(d.__calls[0][1].keys, ['cmd', 'a']);
  assert.ok(d.__calls[0][1].target instanceof Object);
  assert.equal(d.__calls[1][1].target, undefined);
});

test('scroll：结果通道的 background 拒绝（Electron 真机实录形状）也触发前台升级', async () => {
  const d = fakeDriver();
  d.__scrollRefuses = 'result';
  const b = bridgeWith(d);
  const out = await b.scroll({ deltaY: -5, pid: 11, windowId: '99' });
  const kinds = d.__calls.map(([n]) => n);
  assert.deepEqual(kinds, ['scroll', 'callTool']);
  assert.equal(out.hemiEscalatedForeground, true);
});

test('setValue：wire 形状＝顶层 pid/window_id + element_token（真机核实）', async () => {
  const d = fakeDriver();
  const b = bridgeWith(d);
  await b.setValue({ elementToken: 'tok-1', value: '新值', pid: 11, windowId: '99' });
  const call = d.__calls.find(([n]) => n === 'callTool');
  assert.equal(call[1], 'set_value');
  assert.deepEqual(call[2], { element_token: 'tok-1', value: '新值', pid: 11, window_id: '99' });
});

test('scroll：后台不可用 → callTool 前台升级一次并打标', async () => {
  const d = fakeDriver();
  d.__scrollRefuses = true;
  const b = bridgeWith(d);
  const out = await b.scroll({ deltaY: -7, x: 5, y: 6, pid: 11, windowId: '99' });
  const kinds = d.__calls.map(([n]) => n);
  assert.deepEqual(kinds, ['scroll', 'callTool']);
  const fg = d.__calls[1];
  assert.equal(fg[1], 'scroll');
  assert.equal(fg[2].delivery_mode, 'foreground');
  assert.equal(fg[2].direction, 'down');
  assert.equal(fg[2].amount, 7);
  assert.equal(out.hemiEscalatedForeground, true);
});

test('scroll：非后台类失败直接抛（不升级）', async () => {
  const d = fakeDriver();
  d.scroll = async () => throwObjectAssign();
  function throwObjectAssign() { const e = refusedError('window_not_found', 'gone'); throw e; }
  const b = bridgeWith(d);
  await assert.rejects(() => b.scroll({ deltaY: 3 }), /目标窗口已不存在/);
});

test('call：取消信号抛旧口径「操作已被中断」', async () => {
  const d = fakeDriver();
  const c = new AbortController();
  const b = bridgeWith(d);
  c.abort();
  await assert.rejects(() => b.desktopState({ signal: c.signal }), /操作已被中断/);
});

test('perf 埋点：成功/失败各报一条 {command, ms, ok}', async () => {
  const events = [];
  const { setDriverTimingSink } = await import('./cua-client.mjs');
  setDriverTimingSink((e) => events.push(e));
  const d = fakeDriver();
  const b = bridgeWith(d);
  await b.desktopState();
  d.getDesktopState = async () => { throw new Error('boom'); };
  await b.desktopState().catch(() => {});
  setDriverTimingSink(null);
  assert.equal(events.length, 2);
  assert.deepEqual([events[0].command, events[0].ok], ['get_desktop_state', true]);
  assert.deepEqual([events[1].command, events[1].ok], ['get_desktop_state', false]);
});

test('dispose：shutdown + uniffiDestroy 收尾', async () => {
  const d = fakeDriver();
  const b = bridgeWith(d);
  await b.desktopState();
  await b.dispose();
  const kinds = d.__calls.map(([n]) => n);
  assert.ok(kinds.includes('shutdown'));
  assert.ok(kinds.includes('uniffiDestroy'));
});
