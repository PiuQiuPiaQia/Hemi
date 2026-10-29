import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowsDesktopProbes } from './windows-desktop-probe.mjs';
import { createPlatformService } from './index.mjs';
const ready = { available: true, sessionConnected: true, inputDesktopAccessible: true };
function probes(status = ready, fail = false) {
  return createWindowsDesktopProbes({ apps: { status: async () => status, list: async () => [] }, cua: { listAppWindows: async () => { if (fail) throw new Error('driver failure'); return []; } } });
}
test('本地 Windows 能力由实际桌面/驱动探针决定，其余能力不解锁', async () => {
  const p = probes();
  const service = createPlatformService({ platform: 'win32', deps: { getMediaAccessStatus: () => 'unknown', probeDesktop: p.desktop, probeAppCatalog: p.appCatalog } });
  const snap = await service.probeAll();
  assert.equal(snap.capabilities.desktop.state, 'ready');
  assert.equal(snap.capabilities.appCatalog.state, 'ready');
  assert.equal(snap.capabilities.pushToTalk.state, 'unavailable');
});
test('服务会话/断开/锁定不误报 ready', async () => {
  for (const status of [{...ready, available: false}, {...ready, sessionConnected: false}, {...ready, inputDesktopAccessible: false}]) {
    assert.equal((await probes(status).desktop()).state, 'blocked');
  }
});
test('原生库加载或枚举失败显示驱动错误', async () => {
  assert.equal((await probes(ready, true).desktop()).reason, 'driver-load-failed');
});
test('应用目录异常不报告可用', async () => {
  const p = createWindowsDesktopProbes({ apps: { list: async () => { throw Error('failed'); } }, cua: {} });
  assert.equal((await p.appCatalog()).state, 'error');
});
