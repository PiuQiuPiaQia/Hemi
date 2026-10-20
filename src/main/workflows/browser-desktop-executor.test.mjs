import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveBrowserTarget,
  resolveDesktopApp,
  acquireBrowserLease,
  acquireDesktopLease,
} from './browser-desktop-executor.mjs';

test('resolveBrowserTarget：字面 URL／绑定值／非法 URL／缺失四路', () => {
  const literal = resolveBrowserTarget({ nodeData: { targetUrl: 'https://example.com' }, inputs: {} });
  assert.equal(literal.ok, true);
  assert.equal(literal.url, 'https://example.com');

  const bound = resolveBrowserTarget({
    nodeData: { targetBinding: { kind: 'parameter', key: 'url' } },
    inputs: { url: 'https://bound.example/' },
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.url, 'https://bound.example/');

  const bad = resolveBrowserTarget({ nodeData: { targetUrl: 'ftp://x' }, inputs: {} });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'dependency-unavailable');

  const boundBad = resolveBrowserTarget({ nodeData: { targetBinding: { kind: 'parameter', key: 'url' } }, inputs: { url: '不是地址' } });
  assert.equal(boundBad.ok, false);

  const missing = resolveBrowserTarget({ nodeData: {}, inputs: {} });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /没有目标 URL/);
});

test('resolveDesktopApp：身份在/缺两路', () => {
  assert.deepEqual(resolveDesktopApp({ nodeData: { applicationRef: 'com.apple_findermock' } }), { ok: true, applicationRef: 'com.apple_findermock' });
  const miss = resolveDesktopApp({ nodeData: { applicationRef: '  ' } });
  assert.equal(miss.ok, false);
  assert.equal(miss.code, 'dependency-unavailable');
});

test('acquireBrowserLease：桥工厂缺失/客户端空/正常三路，release 幂等', () => {
  assert.throws(
    () => acquireBrowserLease({ nodeData: { targetUrl: 'https://a.example' }, inputs: {}, browserBridgeFactory: null, accessId: 'wf-1' }),
    (e) => e.code === 'dependency-unavailable' && /扩展桥未连接/.test(e.message),
  );
  assert.throws(
    () => acquireBrowserLease({
      nodeData: { targetUrl: 'https://a.example' }, inputs: {},
      browserBridgeFactory: () => null, accessId: 'wf-1',
    }),
    (e) => e.code === 'dependency-unavailable' && /客户端创建失败/.test(e.message),
  );
  let released = 0;
  const lease = acquireBrowserLease({
    nodeData: { targetUrl: 'https://a.example' }, inputs: {},
    browserBridgeFactory: ({ taskId, taskLabel }) => {
      assert.equal(taskId, 'wf-1');
      assert.match(taskLabel, /浏览器节点/);
      return { taskId, release: () => { released += 1; } };
    },
    accessId: 'wf-1',
  });
  assert.equal(lease.url, 'https://a.example');
  lease.release();
  lease.release();
  assert.equal(released, 1, 'release 幂等');
});

test('acquireDesktopLease：身份透传＋空 release', () => {
  const lease = acquireDesktopLease({ nodeData: { applicationRef: 'com.apple.Keynote' } });
  assert.equal(lease.applicationRef, 'com.apple.Keynote');
  assert.doesNotThrow(() => lease.release());
  assert.throws(() => acquireDesktopLease({ nodeData: {} }), (e) => e.code === 'dependency-unavailable');
});
