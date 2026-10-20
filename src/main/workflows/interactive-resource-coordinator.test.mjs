import assert from 'node:assert/strict';
import test from 'node:test';

import { createInteractiveResourceCoordinator } from './interactive-resource-coordinator.mjs';

test('互斥：第二个请求排队，释放后 FIFO 获得', async () => {
  const coordinator = createInteractiveResourceCoordinator();
  const first = await coordinator.acquire('interactive:local', 'wrun-1');
  assert.equal(first.owner, 'wrun-1');

  let secondResolved = false;
  const secondPromise = coordinator.acquire('interactive:local', 'wrun-2').then((lease) => {
    secondResolved = true;
    return lease;
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(secondResolved, false, '被占时第二个等待，不并发');
  assert.equal(coordinator.snapshot('interactive:local').queueLength, 1);

  first.release();
  const second = await secondPromise;
  assert.equal(secondResolved, true);
  assert.equal(second.owner, 'wrun-2', 'FIFO 交给队首');
  second.release();
  assert.equal(coordinator.snapshot('interactive:local').holder, null, '全释放后空闲');
});

test('不同 host 互不阻塞', async () => {
  const coordinator = createInteractiveResourceCoordinator();
  const a = await coordinator.acquire('interactive:host-a', 'wrun-1');
  const b = await coordinator.acquire('interactive:host-b', 'wrun-2');
  assert.equal(a.host, 'interactive:host-a');
  assert.equal(b.host, 'interactive:host-b');
  a.release();
  b.release();
});

test('迟到释放不接管：旧代次的 release 不影响新持有者', async () => {
  const coordinator = createInteractiveResourceCoordinator();
  const first = await coordinator.acquire('interactive:local', 'wrun-1');
  const secondPromise = coordinator.acquire('interactive:local', 'wrun-2');
  first.release();
  const second = await secondPromise;
  first.release(); // 迟到（重复）释放
  assert.equal(coordinator.snapshot('interactive:local').holder?.owner, 'wrun-2', '新持有者不受影响');
  second.release();
});

test('cancelWait：等待被取消且 reject wait-cancelled；超时等待报 resource-busy', async () => {
  const coordinator = createInteractiveResourceCoordinator();
  await coordinator.acquire('interactive:local', 'wrun-1');
  const waiting = coordinator.acquire('interactive:local', 'wrun-2');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(coordinator.cancelWait('interactive:local', 'wrun-2'), true);
  await assert.rejects(() => waiting, (e) => e.code === 'wait-cancelled');
  assert.equal(coordinator.cancelWait('interactive:local', 'wrun-2'), false, '重复取消 false');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const timedOut = coordinator.acquire('interactive:local', 'wrun-3', { timeoutMs: 80 });
  await assert.rejects(() => timedOut, (e) => e.code === 'resource-busy');
  await sleep(100); // 超时 timer unref：并行 sleep 保住事件循环直到收尾
  assert.equal(coordinator.snapshot('interactive:local').queueLength, 0, '超时后出队');
});
