import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../../../extensions/chrome-extension/service_worker.js', import.meta.url), 'utf8');
const marker = 'chrome-extension://hemi/hemi-task.html';

async function fixture({ agents = {}, pool = [], tabs = [] } = {}) {
  const records = new Map(tabs.map(tab => [tab.id, { groupId: -1, ...tab }]));
  const windows = new Set(tabs.map(tab => tab.windowId));
  const listeners = {};
  const storage = { hemiAgents: agents, hemiFreeWindows: pool };
  const failedWindows = new Set();
  const event = name => ({ addListener: listener => { listeners[name] = listener; } });
  const missing = () => { throw new Error('No such target'); };
  let group = 10;
  const grouping = [];
  const groupTitles = [];
  const sockets = [];
  const chrome = {
    runtime: { getManifest: () => ({ version: 'test' }), getURL: name => `chrome-extension://hemi/${name}` },
    storage: { session: { get: async key => structuredClone({ [key]: storage[key] }), set: async values => Object.assign(storage, structuredClone(values)) } },
    alarms: { create() {}, onAlarm: event('alarm') },
    debugger: { onEvent: event('debug'), onDetach: event('detach'), detach: async () => {} },
    windows: {
      create: async () => { windows.add(99); return { id: 99 }; },
      get: async id => windows.has(id) ? { id } : missing(),
      remove: async id => {
        if (failedWindows.has(id)) throw new Error('Injected close failure');
        windows.delete(id);
        for (const [tabId, tab] of records) if (tab.windowId === id) records.delete(tabId);
      },
      onRemoved: event('windowRemoved'),
    },
    tabs: {
      get: async id => records.get(id) ?? missing(),
      remove: async id => records.delete(id),
      query: async filter => [...records.values()].filter(tab => (filter.windowId == null || tab.windowId === filter.windowId) && (!filter.url || tab.url === filter.url)),
      group: async options => {
        grouping.push(options);
        const id = options.groupId ?? ++group;
        for (const tabId of options.tabIds) records.get(tabId).groupId = id;
        return id;
      },
      onCreated: event('created'), onRemoved: event('removed'), onUpdated: event('updated'),
    },
    tabGroups: { update: async (id, properties) => { groupTitles.push(properties.title); } },
  };
  const context = createContext({
    chrome, URL, importScripts() {}, HEMI_CREATE_PAGE_OPERATIONS: () => ({}),
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1,
    WebSocket: class {
      static OPEN = 1; static CONNECTING = 0;
      readyState = 0; listeners = {}; sent = [];
      constructor(url) { this.url = url; sockets.push(this); }
      addEventListener(name, fn) { this.listeners[name] = fn; }
      send(raw) { this.sent.push(JSON.parse(raw)); }
      emit(name, message) {
        if (name === 'open') this.readyState = 1;
        if (name === 'close') this.readyState = 3;
        this.listeners[name]?.({ data: JSON.stringify(message) });
      }
    },
  });
  runInContext(source, context);
  // Let the production startup load persisted state before invoking lifecycle paths.
  await runInContext('loadAgents()', context);
  return { run: code => runInContext(code, context), records, windows, storage, failedWindows, grouping, groupTitles, listeners, sockets };
}

test('扩展清理整窗未登记标签和跨窗弹出页，保留普通窗口及并行任务', async () => {
  const f = await fixture({ agents: {
    a: { windowId: 1, tabId: 2, taskTabIds: [2, 4] }, b: { windowId: 2, tabId: 5, taskTabIds: [5] },
  }, tabs: [
    { id: 1, windowId: 1, url: marker }, { id: 2, windowId: 1, url: 'https://task/' },
    { id: 3, windowId: 1, url: 'https://unrecorded/' }, { id: 4, windowId: 3, url: 'https://popup/' },
    { id: 5, windowId: 2, url: 'https://other-task/' }, { id: 6, windowId: 3, url: 'https://user/' },
  ] });
  await f.run("opSessionEnd({}, getTask('a'))");
  assert.deepEqual([...f.records.keys()], [5, 6]);
  assert.equal(f.windows.has(1), false);
  assert.deepEqual(Object.keys(f.storage.hemiAgents), ['b']);
});

test('窗口关闭失败保留页面归属；下一次收尾可以重试，重复收尾幂等', async () => {
  const f = await fixture({ agents: { a: { windowId: 1, tabId: 2, taskTabIds: [2] } }, tabs: [
    { id: 1, windowId: 1, url: marker }, { id: 2, windowId: 1, url: 'https://task/' },
  ] });
  f.failedWindows.add(1);
  await assert.rejects(f.run("opSessionEnd({}, getTask('a'))"), /Injected close failure/);
  assert.equal(f.storage.hemiAgents.a.windowId, 1);
  assert.equal(f.records.has(2), true);
  f.failedWindows.clear();
  await f.run("opSessionEnd({}, getTask('a'))");
  await f.run("opSessionEnd({}, getTask('a'))");
  assert.deepEqual([...f.records.keys()], []);
});

test('重连清理旧空闲池和纯占位窗口，不认领带用户页面的未知窗口', async () => {
  const f = await fixture({ pool: [1], tabs: [
    { id: 1, windowId: 1, url: marker }, { id: 2, windowId: 1, url: 'https://legacy-leak/' },
    { id: 3, windowId: 2, url: marker },
    { id: 4, windowId: 3, url: marker }, { id: 5, windowId: 3, url: 'https://user/' },
  ] });
  await f.run('queueOrphanCleanup()');
  assert.deepEqual([...f.records.keys()], [4, 5]);
  assert.deepEqual(f.storage.hemiFreeWindows, []);
});

test('新分组指定任务窗口，追加标签复用分组，排除占位页', async () => {
  const f = await fixture({ agents: { a: { windowId: 1, tabId: 2, taskTabIds: [2] } }, tabs: [
    { id: 1, windowId: 1, url: marker }, { id: 2, windowId: 1, url: 'https://task/' },
  ] });
  await f.run("groupTaskTabs(getTask('a'))");
  assert.equal(f.grouping[0].createProperties.windowId, 1);
  assert.deepEqual([...f.grouping[0].tabIds], [2]);
  f.records.set(3, { id: 3, windowId: 1, url: 'https://popup/', groupId: -1 });
  await f.run("groupTaskTabs(getTask('a'))");
  assert.equal(f.grouping[1].groupId, f.records.get(2).groupId);
  assert.deepEqual([...f.grouping[1].tabIds], [2, 3]);
});

test('分组沿用任务摘要；缺少摘要时用页面标题，不显示角色名和随机编号', async () => {
  const f = await fixture({ agents: { 'random-123': { windowId: 1, tabId: 2, taskTabIds: [2], label: 'Hemi' } }, tabs: [
    { id: 1, windowId: 1, url: marker }, { id: 2, windowId: 1, url: 'https://weather.example/', title: '杭州天气预报' },
  ] });
  await f.run("groupTaskTabs(getTask('random-123'))");
  assert.equal(f.groupTitles.at(-1), 'Hemi · 杭州天气预报');
  f.run("getTask('random-123').title = shortTaskTitle('  查询周末杭州天气  ')");
  await f.run("groupTaskTabs(getTask('random-123'))");
  assert.equal(f.groupTitles.at(-1), 'Hemi · 查询周末杭州天气');
  f.records.get(2).title = '另一个页面';
  await f.run("groupTaskTabs(getTask('random-123'))");
  assert.equal(f.groupTitles.at(-1), 'Hemi · 查询周末杭州天气');
});

test('主窗口被手动关闭后重开任务，旧跨窗弹出页仍在回收范围', async () => {
  const f = await fixture({ agents: { a: { windowId: 1, tabId: 2, taskTabIds: [2, 3] } }, tabs: [
    { id: 2, windowId: 1, url: 'https://task/' }, { id: 3, windowId: 2, url: 'https://popup/' },
  ] });
  f.records.delete(2); f.windows.delete(1);
  f.listeners.removed(2); f.listeners.windowRemoved(1);
  await f.run("ensureWindow(getTask('a'))");
  assert.deepEqual([...f.storage.hemiAgents.a.taskTabIds], [3]);
  await f.run("opSessionEnd({}, getTask('a'))");
  assert.equal(f.records.has(3), false);
  assert.equal(f.windows.has(99), false);
});

test('安装版与 Dev 同时连接：同名任务隔离，回执定向，断连只清自己的页面', async () => {
  const f = await fixture();
  const [installed, dev] = f.sockets;
  installed.emit('open'); installed.emit('message', { type: 'hello-ok' });
  await f.run('orphanCleanup');
  f.windows.add(1); f.windows.add(2);
  f.records.set(11, { id: 11, windowId: 1, url: 'https://installed/' });
  f.records.set(22, { id: 22, windowId: 2, url: 'https://dev/' });
  f.run("Object.assign(getTask('same', bridges.get(9467)), {windowId:1,tabId:11,taskTabIds:[11]})");
  dev.emit('open'); dev.emit('message', { type: 'hello-ok' });
  await f.run('startupCleanup');
  assert.equal(f.records.has(11), true, '新实例握手不能回收另一个实例的活动页');
  f.run("Object.assign(getTask('same', bridges.get(9468)), {windowId:2,tabId:22,taskTabIds:[22]})");
  await f.run("handleCommand({id:'dev-command',op:'ext.version',taskId:'same'},bridges.get(9468))");
  assert.equal(dev.sent.filter(message => message.id === 'dev-command').length, 1);
  assert.equal(installed.sent.filter(message => message.id === 'dev-command').length, 0);
  installed.emit('close');
  await f.run('bridges.get(9467).cleanup');
  assert.equal(f.records.has(11), false);
  assert.equal(f.records.has(22), true);
  assert.deepEqual(Object.keys(f.storage.hemiAgents), ['9468/same']);
});
