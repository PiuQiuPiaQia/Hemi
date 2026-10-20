import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlatformService } from './index.mjs';
import { CAPABILITY_IDS } from './capabilities.mjs';

/** darwin 桩依赖：钩子在跑、麦克风已授权。 */
function macDeps(overrides = {}) {
  return {
    getMediaAccessStatus: () => 'granted',
    pushToTalkRunning: () => true,
    pushToTalkListening: () => true,
    pushToTalkStartError: () => '',
    ...overrides,
  };
}

test('darwin 快照：麦克风真实状态、PTT 运行态、其余能力 ready', async () => {
  const service = createPlatformService({ platform: 'darwin', deps: macDeps() });
  const snap = await service.probeAll();
  assert.equal(snap.platform, 'darwin');
  assert.deepEqual(snap.shortcuts.pushToTalk, { key: 'option', label: 'Option' });
  assert.equal(snap.capabilities.microphone.state, 'ready');
  assert.equal(snap.capabilities.pushToTalk.state, 'ready');
  for (const id of ['audioDuplex', 'desktop', 'browser', 'command', 'systemProxy', 'capture', 'currentPage', 'appCatalog']) {
    assert.equal(snap.capabilities[id].state, 'ready', `${id} 在 mac 是已实现能力`);
  }
});

test('darwin 快照：麦克风隐私拒绝 → blocked(privacy-disabled)；钩子没在跑 → blocked', async () => {
  const service = createPlatformService({
    platform: 'darwin',
    deps: macDeps({
      getMediaAccessStatus: () => 'denied',
      pushToTalkRunning: () => false,
    }),
  });
  const snap = await service.probeAll();
  assert.equal(snap.capabilities.microphone.state, 'blocked');
  assert.equal(snap.capabilities.microphone.reason, 'privacy-disabled');
  assert.ok(snap.capabilities.microphone.actions.includes('open-microphone-settings'));
  assert.equal(snap.capabilities.pushToTalk.state, 'blocked');
});

test('darwin 快照：钩子启动失败 → error（用真实 startError，不误报授权）', async () => {
  const service = createPlatformService({
    platform: 'darwin',
    deps: macDeps({ pushToTalkStartError: () => '加载失败' }),
  });
  const snap = await service.probeAll();
  assert.equal(snap.capabilities.pushToTalk.state, 'error');
});

test('darwin 麦克风投影：granted 直过；notdetermined 走 askForMediaAccess；denied 拒绝', async () => {
  const asked = [];
  const base = {
    askForMediaAccess: async (media) => {
      asked.push(media);
      return true;
    },
  };
  const granted = createPlatformService({ platform: 'darwin', deps: macDeps(base) });
  assert.equal(await granted.requestMicrophoneAccess(), true);
  assert.equal(asked.length, 0, '已授权不再触发弹窗');

  const undetermined = createPlatformService({
    platform: 'darwin',
    deps: macDeps({ ...base, getMediaAccessStatus: () => 'notdetermined' }),
  });
  assert.equal(await undetermined.requestMicrophoneAccess(), true);
  assert.deepEqual(asked, ['microphone']);

  const denied = createPlatformService({
    platform: 'darwin',
    deps: macDeps({ ...base, getMediaAccessStatus: () => 'denied' }),
  });
  assert.equal(await denied.requestMicrophoneAccess(), false);
});

test('win32 快照：麦克风读真实隐私状态；探测门控能力全部不可用', async () => {
  const service = createPlatformService({
    platform: 'win32',
    deps: { getMediaAccessStatus: () => 'granted' },
  });
  const snap = await service.probeAll();
  assert.equal(snap.platform, 'win32');
  assert.equal(snap.shortcuts.pushToTalk, null, '默认键未定案（Q2）不给快照');
  assert.equal(snap.capabilities.microphone.state, 'ready');
  for (const id of ['audioDuplex', 'pushToTalk', 'desktop', 'browser', 'command', 'capture', 'currentPage', 'appCatalog']) {
    const cap = snap.capabilities[id];
    assert.equal(cap.state, 'unavailable', `${id} 未过 WP 探针，必须如实不可用`);
    assert.equal(cap.reason, 'backend-not-verified');
    assert.equal(cap.supported, false);
  }
  assert.equal(snap.capabilities.systemProxy.reason, 'unsupported-proxy');
});

test('win32 快照：隐私拒绝/未知都不显示已授权（AC-03 反例）', async () => {
  for (const [status, expectedReason] of [['denied', 'privacy-disabled'], ['unknown', undefined], ['not_available', undefined]]) {
    const service = createPlatformService({
      platform: 'win32',
      deps: { getMediaAccessStatus: () => status },
    });
    const snap = await service.probeAll();
    assert.equal(snap.capabilities.microphone.state, 'blocked', `${status} 不得报已授权`);
    assert.equal(snap.capabilities.microphone.reason, expectedReason);
    assert.ok(snap.capabilities.microphone.actions.includes('open-microphone-settings'));
  }
});

test('win32 麦克风投影：不调用 mac 授权弹窗（系统设置走 ms-settings 动作）', async () => {
  const service = createPlatformService({
    platform: 'win32',
    deps: { getMediaAccessStatus: () => 'granted' },
  });
  assert.equal(await service.requestMicrophoneAccess(), true);
  const denied = createPlatformService({
    platform: 'win32',
    deps: { getMediaAccessStatus: () => 'denied' },
  });
  assert.equal(await denied.requestMicrophoneAccess(), false);
  assert.equal(denied.microphoneStatus(), 'denied');
});

test('全部能力都在快照里（CAPABILITY_IDS 与快照字段一致）', async () => {
  const service = createPlatformService({ platform: 'darwin', deps: macDeps() });
  const snap = await service.probeAll();
  assert.deepEqual(Object.keys(snap.capabilities).sort(), [...CAPABILITY_IDS].sort());
});
