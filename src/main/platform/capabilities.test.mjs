import assert from 'node:assert/strict';
import test from 'node:test';

import { CAPABILITY_IDS, createCapabilityService } from './capabilities.mjs';

function makeService({ probes, enabledIntents, notify, probeTimeoutMs } = {}) {
  return createCapabilityService({
    platform: 'win32',
    sessionId: 'ps-test',
    probes: probes ?? {},
    enabledIntents,
    notify,
    ...(probeTimeoutMs ? { probeTimeoutMs } : {}),
  });
}

/** 探测函数经 Promise.resolve().then 微任务调用：等一个宏任务让它跑起来。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('初始快照：全部 checking、supported=false、revision=0，字段齐全', () => {
  const service = makeService();
  const snap = service.snapshot();
  assert.equal(snap.platform, 'win32');
  assert.equal(snap.sessionId, 'ps-test');
  assert.equal(snap.revision, 0);
  assert.deepEqual(Object.keys(snap.capabilities).sort(), [...CAPABILITY_IDS].sort());
  for (const cap of Object.values(snap.capabilities)) {
    assert.equal(cap.state, 'checking');
    assert.equal(cap.supported, false);
    assert.equal(cap.enabled, false);
  }
});

test('probeAll：探测回执落状态；ready 才算可用，失败收紧为 error', async () => {
  const service = makeService({
    probes: {
      microphone: () => ({ state: 'ready', supported: true, actions: ['recheck'] }),
      desktop: () => {
        throw new Error('boom');
      },
    },
    enabledIntents: { desktop: true },
  });
  const snap = await service.probeAll();
  assert.equal(snap.capabilities.microphone.state, 'ready');
  assert.equal(snap.capabilities.microphone.supported, true);
  assert.deepEqual(snap.capabilities.microphone.actions, ['recheck']);
  assert.equal(snap.capabilities.desktop.state, 'error');
  assert.equal(snap.capabilities.desktop.reason, 'probe-failed');
  assert.equal(snap.capabilities.desktop.enabled, true, 'enabled 是用户意图，与探测无关');
  assert.ok(snap.revision > 0);
});

test('probeAll：未提供探测函数的能力收紧为 unavailable（构建不含此实现）', async () => {
  const service = makeService({ probes: { command: () => ({ state: 'ready', supported: true }) } });
  const snap = await service.probeAll();
  assert.equal(snap.capabilities.command.state, 'ready');
  assert.equal(snap.capabilities.pushToTalk.state, 'unavailable');
  assert.equal(snap.capabilities.pushToTalk.supported, false);
});

test('recheck：先转 checking 再落回执；revision 单调推进', async () => {
  const resolvers = [];
  const service = makeService({
    probes: {
      microphone: () => new Promise((resolve) => resolvers.push(resolve)),
    },
  });
  const probing = service.probeAll();
  await flush();
  resolvers.shift()({ state: 'ready', supported: true });
  await probing;
  assert.equal(service.snapshot().capabilities.microphone.state, 'ready');

  const rechecking = service.recheck('microphone');
  await flush();
  assert.equal(service.snapshot().capabilities.microphone.state, 'checking', '回执前先进 checking');
  resolvers.shift()({ state: 'blocked', reason: 'privacy-disabled' });
  await rechecking;
  const after = service.snapshot().capabilities.microphone;
  assert.equal(after.state, 'blocked');
  assert.equal(after.reason, 'privacy-disabled');

  const revisionBefore = service.revision;
  const second = service.recheck('microphone');
  await flush();
  resolvers.shift()({ state: 'ready' });
  await second;
  assert.equal(service.snapshot().capabilities.microphone.state, 'ready');
  assert.ok(service.revision > revisionBefore);
});

test('recheck：未知能力抛错', async () => {
  const service = makeService();
  await assert.rejects(() => service.recheck('nope'));
});

test('探测超时转 error（probe-failed），不悬在 checking', async () => {
  const service = makeService({
    probes: { microphone: () => new Promise(() => {}) },
    probeTimeoutMs: 20,
  });
  // 探测超时定时器 unref（生产不拖住进程退出）；测试里用一个 ref 定时器
  // 把事件循环留活到超时触发，再等 probeAll 落定。
  const keepAlive = new Promise((resolve) => setTimeout(resolve, 60));
  const snap = await service.probeAll();
  await keepAlive;
  assert.equal(snap.capabilities.microphone.state, 'error');
  assert.equal(snap.capabilities.microphone.reason, 'probe-failed');
});

test('apply：运行态事件落状态并广播；enabled 可单独更新', () => {
  const seen = [];
  const service = makeService({ notify: (snap) => seen.push(snap.revision) });
  service.apply('pushToTalk', { state: 'blocked', reason: 'shortcut-conflict', supported: true, enabled: true });
  const cap = service.snapshot().capabilities.pushToTalk;
  assert.equal(cap.state, 'blocked');
  assert.equal(cap.reason, 'shortcut-conflict');
  assert.equal(cap.enabled, true);
  assert.equal(seen.length, 1);
  service.apply('pushToTalk', { state: 'ready' });
  assert.equal(service.snapshot().capabilities.pushToTalk.reason, undefined);
  assert.equal(seen.length, 2);
});

test('apply：未知 state 收紧回当前值，不透传垃圾', () => {
  const service = makeService();
  service.apply('browser', { state: 'totally-fine' });
  assert.equal(service.snapshot().capabilities.browser.state, 'checking');
});

test('setEnabled：意图变化发布；不变不发布', async () => {
  const seen = [];
  const service = makeService({ notify: (snap) => seen.push(snap.revision) });
  await service.probeAll();
  const base = seen.length;
  service.setEnabled('microphone', true);
  assert.equal(service.snapshot().capabilities.microphone.enabled, true);
  service.setEnabled('microphone', true);
  assert.equal(seen.length - base, 1, '相同意图不重复发布');
});

test('setShortcut：null/缺 label 时清空，快照 shortcuts.pushToTalk 为 null', () => {
  const service = makeService();
  service.setShortcut('option', 'Option');
  assert.deepEqual(service.snapshot().shortcuts.pushToTalk, { key: 'option', label: 'Option' });
  service.setShortcut(null);
  assert.equal(service.snapshot().shortcuts.pushToTalk, null);
});

test('快照是深拷贝：改快照不污染服务内部状态', async () => {
  const service = makeService({
    probes: { microphone: () => ({ state: 'ready', supported: true }) },
  });
  const snap = await service.probeAll();
  snap.capabilities.microphone.state = 'ready-x';
  snap.capabilities.pushToTalk.actions.push('hack');
  assert.equal(service.snapshot().capabilities.microphone.state, 'ready');
  assert.deepEqual(service.snapshot().capabilities.pushToTalk.actions, []);
});
